/**
 * ═══════════ CHUẨN HOÁ ĐỊA CHỈ VIỆT NAM — ĐỊA GIỚI TỪ 01/07/2025 (34 TỈNH · XÃ / PHƯỜNG / ĐẶC KHU) ═══════════
 *
 * Vì sao (05/10/2026): đơn bot chốt / máy ghi từ hội thoại chỉ có MỘT dòng địa chỉ khách gõ — ô tỉnh trống, ô xã trống ⇒ mọi
 * đơn hiện «Địa chỉ chưa chuẩn hoá» và không đẩy được sang hãng vận chuyển (GHN / GHTK cần đúng tỉnh + xã theo danh mục).
 * Chủ shop HSLC: «tự động lên đơn chính xác thông tin». Tệp này là bộ đọc DUY NHẤT: dòng chữ ⇒ tỉnh + xã theo địa giới mới.
 *
 * Khách gõ cả hai thế hệ địa chỉ: mới («Phường Bàn Cờ, TP HCM») và CŨ («P5 Q3 Sài Gòn» — xã cũ + huyện cũ). Dữ liệu
 * (`vn-admin-2025.json`) mang, cho mỗi xã MỚI, danh sách (huyện cũ, xã cũ) đã gộp vào nó — nên địa chỉ cũ quy được về xã mới.
 *
 * KHÔNG ĐOÁN (AGENTS.md mục 42 / 8.5): một xã cũ bị CHIA cho nhiều xã mới, hoặc tên xã trùng nhau trong tỉnh ⇒ `AMBIGUOUS` kèm
 * danh sách để NGƯỜI chọn — không bao giờ chọn hộ cái đầu tiên. Không nhận ra tỉnh ⇒ chỉ nhận xã khi tên xã là DUY NHẤT cả
 * nước VÀ có tiền tố loại («phường …», «xã …»). HÀM THUẦN — dữ liệu nạp một lần, không đọc CSDL, không gọi mạng.
 */
import data from "@/lib/address/vn-admin-2025.json";

export type AdminWard = { code: number; name: string; provinceCode: number };
export type AdminProvince = { code: number; name: string };

export type AddressMatch =
  /** Đủ tỉnh + xã, một đáp án. `via` = đọc được bằng tên MỚI hay quy từ địa chỉ CŨ (xã cũ + huyện cũ). */
  | { status: "MATCHED"; province: AdminProvince; ward: AdminWard; via: "NEW_NAME" | "LEGACY" }
  /** Biết tỉnh, xã có vài khả năng — người chọn một. */
  | { status: "AMBIGUOUS"; province: AdminProvince; candidates: AdminWard[]; reason: string }
  /** Biết tỉnh, không đọc được xã. */
  | { status: "PROVINCE_ONLY"; province: AdminProvince; reason: string }
  | { status: "UNKNOWN"; reason: string };

/** Trần số xã gợi ý cho người chọn — nhiều hơn thì gợi ý không còn là gợi ý. */
export const MAX_WARD_CANDIDATES = 8;

type RawProvince = [number, string, string[], [number, string, [string, string][]][]];

// ─────────────────────────── CHỮ ───────────────────────────

/** Bỏ dấu, chữ thường, «đ» ⇒ «d», mọi thứ không phải chữ / số ⇒ dấu cách. */
export function foldVnText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const TYPE_WORDS = ["thanh pho", "tinh", "phuong", "xa", "thi tran", "dac khu", "quan", "huyen", "thi xa"] as const;

/** «Phường Bàn Cờ» ⇒ { type: "phuong", core: "ban co" }; «Quận 3» ⇒ { type: "quan", core: "3" }. */
function splitType(name: string): { type: string; core: string } {
  const f = foldVnText(name);
  for (const t of TYPE_WORDS) if (f.startsWith(`${t} `)) return { type: t, core: f.slice(t.length + 1) };
  return { type: "", core: f };
}

/** Tên tỉnh viết tắt / tên gọi khác ⇒ tên gập của tỉnh (MỚI hoặc CŨ — tỉnh cũ quy về tỉnh mới ở bước sau). */
const PROVINCE_ALIASES: Record<string, string> = {
  hcm: "ho chi minh",
  tphcm: "ho chi minh",
  hcmc: "ho chi minh",
  sg: "ho chi minh",
  "sai gon": "ho chi minh",
  "tp hcm": "ho chi minh",
  hn: "ha noi",
  "ha noi": "ha noi",
  brvt: "ba ria vung tau",
  "vung tau": "ba ria vung tau",
  "ba ria": "ba ria vung tau",
  "thua thien hue": "hue",
  "dak lak": "dak lak",
  "daklak": "dak lak",
  "dac lac": "dak lak",
  "dak nong": "dak nong",
  "daknong": "dak nong",
};

/**
 * Viết tắt thường gặp trong địa chỉ khách gõ ⇒ dạng đầy đủ: «p5», «p.5», «f5» ⇒ «phuong 5»; «q3» ⇒ «quan 3»; «tp» ⇒
 * «thanh pho»; «tx» ⇒ «thi xa»; «tt» ⇒ «thi tran»; «h.» ⇒ «huyen»; «x.» ⇒ «xa». Chạy trên chữ ĐÃ GẬP.
 */
export function expandAbbreviations(folded: string): string {
  return ` ${folded} `
    .replace(/ (?:p|f|ph) ?(\d{1,2}) /g, " phuong $1 ")
    .replace(/ q ?(\d{1,2}) /g, " quan $1 ")
    .replace(/ tp(?= )/g, " thanh pho")
    .replace(/ tx(?= )/g, " thi xa")
    .replace(/ tt(?= )/g, " thi tran")
    .replace(/ p(?= [a-z])/g, " phuong")
    .replace(/ q(?= [a-z])/g, " quan")
    .replace(/ h(?= [a-z])/g, " huyen")
    .replace(/ x(?= [a-z])/g, " xa")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vị trí KẾT THÚC của lần xuất hiện CUỐI CÙNG của `needle` (đủ từ) trong `hay`; không có ⇒ -1. */
function lastWordHit(hay: string, needle: string): number {
  if (!needle) return -1;
  const h = ` ${hay} `;
  const n = ` ${needle} `;
  const i = h.lastIndexOf(n);
  return i < 0 ? -1 : i + n.length - 1;
}

// ─────────────────────────── DỮ LIỆU ───────────────────────────

type Index = {
  provinces: { p: AdminProvince; names: string[] }[];
  wards: { w: AdminWard; type: string; core: string; legacy: { district: string; districtType: string; ward: string; wardType: string }[] }[];
  wardCoreCount: Map<string, number>;
};

let cache: Index | null = null;

function index(): Index {
  if (cache) return cache;
  const raw = (data as unknown as { provinces: RawProvince[] }).provinces;
  const provinces: Index["provinces"] = [];
  const wards: Index["wards"] = [];
  const wardCoreCount = new Map<string, number>();
  for (const [code, name, oldNames, ws] of raw) {
    const names = new Set<string>([splitType(name).core, ...oldNames.map((o) => splitType(o).core)]);
    for (const [alias, target] of Object.entries(PROVINCE_ALIASES)) if (names.has(target)) names.add(alias);
    // «Bà Rịa - Vũng Tàu» gập thành «ba ria vung tau» — đã có; tên cũ có gạch nối khác cũng gập về cùng dạng.
    provinces.push({ p: { code, name }, names: [...names].filter(Boolean) });
    for (const [wcode, wname, legacy] of ws) {
      const { type, core } = splitType(wname);
      wardCoreCount.set(core, (wardCoreCount.get(core) ?? 0) + 1);
      wards.push({
        w: { code: wcode, name: wname, provinceCode: code },
        type,
        core,
        legacy: legacy.map(([d, w]) => {
          const dd = splitType(d);
          const ww = splitType(w);
          return { district: dd.core, districtType: dd.type, ward: ww.core, wardType: ww.type };
        }),
      });
    }
  }
  cache = { provinces, wards, wardCoreCount };
  return cache;
}

/** Danh mục tỉnh MỚI (34) — cho ô chọn tỉnh. */
export function adminProvinces(): AdminProvince[] {
  return index().provinces.map((x) => x.p);
}

/** Danh mục xã / phường MỚI của một tỉnh — cho ô chọn xã. */
export function adminWardsOf(provinceCode: number): AdminWard[] {
  return index().wards.filter((x) => x.w.provinceCode === provinceCode).map((x) => x.w);
}

/** Tên tỉnh (mới / cũ / viết tắt, có hay không có dấu) ⇒ tỉnh MỚI; không nhận ra ⇒ `null`. */
export function findProvince(text: string): AdminProvince | null {
  const f = expandAbbreviations(foldVnText(text));
  const core = splitType(f).core;
  for (const x of index().provinces) if (x.names.includes(core) || x.names.includes(f)) return x.p;
  return null;
}

// ─────────────────────────── ĐỌC MỘT DÒNG ĐỊA CHỈ ───────────────────────────

/** Tỉnh nhắc tới MUỘN NHẤT trong dòng (địa chỉ Việt Nam đi từ nhỏ tới lớn — tỉnh ở cuối). */
function provinceIn(text: string): { p: AdminProvince; end: number; start: number } | null {
  let best: { p: AdminProvince; end: number; start: number; len: number } | null = null;
  for (const x of index().provinces) {
    for (const n of x.names) {
      const end = lastWordHit(text, n);
      if (end < 0) continue;
      if (!best || end > best.end || (end === best.end && n.length > best.len)) best = { p: x.p, end, start: end - n.length, len: n.length };
    }
  }
  return best ? { p: best.p, end: best.end, start: best.start } : null;
}

/** Tên chỉ là số («5») hoặc một từ ngắn thì KHÔNG đứng một mình được — phải kèm loại («phường 5»). */
const needsType = (core: string) => /^\d+$/.test(core) || core.length < 3;

/**
 * Một dòng địa chỉ ⇒ tỉnh + xã theo địa giới mới. Thứ tự căn cứ:
 *  1. Tên xã MỚI có kèm loại («phường bàn cờ») — mạnh nhất.
 *  2. Xã CŨ + huyện CŨ cùng có mặt («phường 5 quận 3») ⇒ xã mới đã gộp xã cũ đó. Xã cũ bị chia ⇒ nhiều đáp án.
 *  3. Tên xã MỚI không loại — phải đủ hai từ, không là số, không trùng tên một huyện cũ của tỉnh.
 *  4. Chỉ có huyện cũ ⇒ các xã mới có phần đất của huyện đó (≤ `MAX_WARD_CANDIDATES` thì đưa người chọn).
 */
export function normalizeVnAddress(text: string): AddressMatch {
  const t = expandAbbreviations(foldVnText(text));
  if (!t) return { status: "UNKNOWN", reason: "Địa chỉ trống." };
  const idx = index();
  const prov = provinceIn(t);
  // Phần chữ TRƯỚC tên tỉnh — xã / huyện nằm ở đó (tên tỉnh cũng có thể trùng tên một xã: «xã Thanh Hoá»).
  const head = prov ? t.slice(0, Math.max(0, prov.start)).trim() || t : t;
  const pool = prov ? idx.wards.filter((x) => x.w.provinceCode === prov.p.code) : idx.wards;

  // 1. Tên mới CÓ loại («phường bàn cờ») — khách gõ địa chỉ mới.
  const strong = pool.filter((x) => lastWordHit(head, `${x.type} ${x.core}`) >= 0);
  if (strong.length) {
    if (!prov) {
      if (strong.length === 1 && (idx.wardCoreCount.get(strong[0].core) ?? 0) === 1) return { status: "MATCHED", province: provinceOf(strong[0].w), ward: strong[0].w, via: "NEW_NAME" };
    } else {
      const r = pickNew(prov.p, strong);
      if (r) return r;
    }
  }

  // 2. Xã cũ + huyện cũ cùng có mặt — TRƯỚC tên mới không loại: «xã Ea Tu, TP Buôn Ma Thuột» là địa chỉ CŨ (Buôn Ma Thuột
  //    là huyện cũ), không phải «Phường Buôn Ma Thuột» mới.
  // Điểm = độ dài chữ khớp (xã + huyện); hai đoạn khớp không được CHỒNG nhau («xã tân thạnh đông» không cho «tân thạnh»
  // làm tên huyện). Chỉ giữ nhóm điểm cao nhất — «Thạnh» và «Thành» gập về cùng chữ, khớp ngắn hơn là khớp kém hơn.
  const scored = pool
    .map((x) => ({ x, score: Math.max(0, ...x.legacy.map((l) => legacyScore(head, l))) }))
    .filter((r) => r.score > 0);
  const best = Math.max(0, ...scored.map((r) => r.score));
  const legacyHits = scored.filter((r) => r.score === best).map((r) => r.x);
  if (legacyHits.length) {
    const provs = new Set(legacyHits.map((x) => x.w.provinceCode));
    const p = prov?.p ?? (provs.size === 1 ? provinceOf(legacyHits[0].w) : null);
    if (p && legacyHits.length === 1) return { status: "MATCHED", province: p, ward: legacyHits[0].w, via: "LEGACY" };
    if (p && provs.size === 1 && legacyHits.length <= MAX_WARD_CANDIDATES) return { status: "AMBIGUOUS", province: p, candidates: legacyHits.map((x) => x.w), reason: "Xã / phường cũ đã được chia cho nhiều xã / phường mới — chọn theo số nhà, đường." };
  }
  if (!prov) return { status: "UNKNOWN", reason: strong.length ? "Không thấy tên tỉnh / thành — tên xã trùng ở nhiều tỉnh." : "Không thấy tên tỉnh / thành trong địa chỉ." };

  // 3. Tên mới KHÔNG loại — đủ dài, không là số («…, Long Bình, Thủ Đức, HCM»).
  //    Tên trùng tên một HUYỆN CŨ của tỉnh («Việt Trì», «Ba Đình», «Nha Trang») không đứng một mình được: khách viết địa chỉ cũ
  //    thì đó là cả thành phố / quận cũ (nay chia nhiều phường) ⇒ xuống bước 4, người chọn.
  const oldDistricts = new Set(pool.flatMap((x) => x.legacy.map((l) => l.district)));
  const weak = pool.filter((x) => !needsType(x.core) && x.core.includes(" ") && !oldDistricts.has(x.core) && lastWordHit(head, x.core) >= 0);
  if (weak.length) {
    const r = pickNew(prov.p, weak);
    if (r) return r;
  }

  // 4. Chỉ huyện cũ.
  const byDistrict = pool.filter((x) => x.legacy.some((l) => (l.districtType && lastWordHit(head, `${l.districtType} ${l.district}`) >= 0) || (!needsType(l.district) && lastWordHit(head, l.district) >= 0)));
  // Xã mới mang ĐÚNG tên huyện cũ («Đặc khu Phú Quốc», «Phường Việt Trì») lên đầu danh sách — vẫn là gợi ý, người chọn.
  byDistrict.sort((a, b) => Number(lastWordHit(head, b.core) >= 0) - Number(lastWordHit(head, a.core) >= 0));
  if (byDistrict.length === 1) return { status: "MATCHED", province: prov.p, ward: byDistrict[0].w, via: "LEGACY" };
  if (byDistrict.length > 1 && byDistrict.length <= MAX_WARD_CANDIDATES) return { status: "AMBIGUOUS", province: prov.p, candidates: byDistrict.map((x) => x.w), reason: "Chỉ có quận / huyện cũ — chọn xã / phường mới." };
  return { status: "PROVINCE_ONLY", province: prov.p, reason: byDistrict.length ? `Chỉ có quận / huyện cũ (${byDistrict.length} xã / phường mới) — cần tên xã / phường.` : "Không đọc được xã / phường." };
}

/** Một đoạn (đủ từ) khớp ⇒ [đầu, cuối) của lần xuất hiện CUỐI; không có ⇒ null. */
function span(hay: string, needle: string): [number, number] | null {
  const end = lastWordHit(hay, needle);
  return end < 0 ? null : [end - needle.length, end];
}

/** Điểm khớp của một cặp (huyện cũ, xã cũ) với dòng địa chỉ: 0 = không khớp; ngược lại = tổng độ dài hai đoạn khớp. */
function legacyScore(head: string, l: { district: string; districtType: string; ward: string; wardType: string }): number {
  const w = span(head, l.wardType ? `${l.wardType} ${l.ward}` : l.ward) ?? (!needsType(l.ward) && l.ward.includes(" ") ? span(head, l.ward) : null);
  if (!w) return 0;
  const d = span(head, l.districtType ? `${l.districtType} ${l.district}` : l.district) ?? (!needsType(l.district) ? span(head, l.district) : null);
  if (!d || (d[0] < w[1] && w[0] < d[1])) return 0;
  return w[1] - w[0] + (d[1] - d[0]);
}

/** Nhiều tên mới khớp ⇒ tên DÀI nhất thắng («tân thạnh đông» hơn «tân thạnh»); vẫn hoà ⇒ người chọn. */
function pickNew(p: AdminProvince, hits: Index["wards"]): AddressMatch | null {
  const longest = maxBy(hits, (x) => x.core.length);
  const top = hits.filter((x) => x.core.length === longest);
  if (top.length === 1) return { status: "MATCHED", province: p, ward: top[0].w, via: "NEW_NAME" };
  return { status: "AMBIGUOUS", province: p, candidates: top.slice(0, MAX_WARD_CANDIDATES).map((x) => x.w), reason: "Nhiều xã / phường cùng tên trong tỉnh." };
}

function provinceOf(w: AdminWard): AdminProvince {
  return index().provinces.find((x) => x.p.code === w.provinceCode)!.p;
}

function maxBy<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((m, x) => Math.max(m, f(x)), -Infinity);
}

// ─────────────────────────── NGƯỜI NHẬN CỦA ĐƠN ───────────────────────────

export type RecipientPlace = { province: string; ward: string; match: AddressMatch };

/**
 * Ô tỉnh + ô xã của MỘT đơn từ người nhận (dòng địa chỉ, tỉnh khách / người gõ, xã người đã CHỌN). Lõi ghi đơn gọi hàm này
 * mỗi lần ghi — đơn bot chốt, đơn máy ghi từ hội thoại, đơn nhân viên tạo đều ra cùng một dạng tên theo địa giới mới.
 *  · Xã người đã chọn mà thuộc đúng tỉnh ⇒ giữ (tên chuẩn) — người chọn thắng bộ đọc.
 *  · Không thì đọc dòng địa chỉ: chỉ điền xã khi MỘT đáp án (`MATCHED`); nhiều đáp án ⇒ để trống, người chọn.
 *  · Không nhận ra tỉnh ⇒ giữ NGUYÊN chữ tỉnh đã có (không xoá thứ người gõ), xã trống.
 */
export function resolveRecipientPlace(r: { address: string; province: string; ward?: string }): RecipientPlace {
  const match = normalizeVnAddress([r.address, r.province].filter((x) => x.trim()).join(", "));
  const typed = r.province.trim() ? findProvince(r.province) : null;
  const province = typed ?? ("province" in match ? match.province : null);
  const chosen = (r.ward ?? "").trim();
  if (province && chosen) {
    const want = splitType(chosen).core;
    const hit = index().wards.find((x) => x.w.provinceCode === province.code && (x.core === want || foldVnText(x.w.name) === foldVnText(chosen)));
    if (hit) return { province: province.name, ward: hit.w.name, match };
  }
  if (!province) return { province: r.province.trim(), ward: "", match };
  const ward = match.status === "MATCHED" && match.province.code === province.code ? match.ward.name : "";
  return { province: province.name, ward, match };
}

/** Dòng địa chỉ đầy đủ cho hãng vận chuyển: dòng khách gõ + xã + tỉnh (phần nào dòng đã có thì không lặp). */
export function fullAddressLine(address: string, ward: string, province: string): string {
  const have = ` ${foldVnText(address)} `;
  const extra = [ward, province].filter((x) => x.trim() && !have.includes(` ${splitType(x).core} `));
  return [address.trim(), ...extra].filter(Boolean).join(", ");
}
