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
  /**
   * Biết tỉnh, xã có vài khả năng — người chọn một. `legacy` = tên xã / huyện CŨ (đúng chữ trong danh mục trước 01/07/2025) mà
   * dòng địa chỉ khớp, khi nhiều đáp án sinh ra từ MỘT xã cũ bị chia — để câu hỏi khách nói được «phường Cổ Nhuế 2 cũ nay thuộc…».
   */
  | { status: "AMBIGUOUS"; province: AdminProvince; candidates: AdminWard[]; reason: string; kind: AmbiguityKind; legacy?: { ward: string; district: string } }
  /** Biết tỉnh, không đọc được xã. */
  | { status: "PROVINCE_ONLY"; province: AdminProvince; reason: string }
  /** Chưa biết tỉnh. `hint` = cách đọc CHƯA XÁC NHẬN khi tỉnh chỉ suy được nhờ bung viết tắt — cho câu hỏi khách, không bao giờ để ghi. */
  | { status: "UNKNOWN"; reason: string; hint?: ProvinceHint };

/**
 * VÌ SAO nhiều đáp án — khoá máy đọc được, để nơi phân loại (`integrity-audit.ts::classifyAddress`) không phải dò câu chữ của `reason`
 * (câu chữ đổi một lần là nhãn rơi về nhóm sai — ca «P13 GV»: lý do mới «danh mục cũ không có phường 13» từng bị đọc thành «trùng tên»).
 *  · `LEGACY_WARD_SPLIT` — xã CŨ khách ghi đã bị chia cho nhiều xã mới.
 *  · `LEGACY_DISTRICT_ONLY` — chỉ dùng được quận / huyện CŨ (khách không ghi xã, hoặc xã khách ghi không có trong danh mục cũ).
 *  · `SAME_NAME` — nhiều xã MỚI cùng tên trong tỉnh.
 */
export type AmbiguityKind = "LEGACY_WARD_SPLIT" | "LEGACY_DISTRICT_ONLY" | "SAME_NAME";

/**
 * TỈNH CHỈ ĐỨNG ĐƯỢC NHỜ VIẾT TẮT («1094/3 Lê Đức Thọ P13 GV», ca KimThu Le; «12 Lê Lợi q1»; «Số 5 tp Vinh»; «f1q5»): khách
 * KHÔNG ghi tỉnh và KHÔNG gõ nguyên chữ tên quận / huyện — chỉ có viết tắt. Bung viết tắt rồi suy tỉnh là đoán chồng lên đoán, nên
 * kết quả vẫn là CHƯA BIẾT TỈNH (lõi đơn không ghi tỉnh, cổng «thiếu tỉnh» đứng nguyên, không tự chốt); cách đọc ấy chỉ đi kèm để
 * câu hỏi khách nói được ĐÚNG phần thiếu: «"GV" là quận Gò Vấp, TP Hồ Chí Minh phải không ạ?». `abbreviation` = đúng chữ viết tắt
 * khi biết («GV», «f1q5»), `null` khi chỉ biết tên quận đọc ra từ viết tắt loại («q1», «tp Vinh»). `candidates` = xã mới NẾU khách
 * xác nhận (MATCHED ⇒ một, AMBIGUOUS ⇒ vài).
 */
export type ProvinceHint = { province: AdminProvince; abbreviation: string | null; district: string; candidates: AdminWard[] };

/** Một lần bung viết tắt RA TÊN quận / huyện: chữ khách gõ («gv», «f1q5») ⇒ tên huyện cũ đã gập («quan go vap», «quan 5»). */
type DistrictAbbreviation = { token: string; district: string };

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
 * Viết tắt thường gặp trong địa chỉ khách gõ ⇒ dạng đầy đủ: «p5», «p.5», «f5» ⇒ «phuong 5»; «P An Hội Tây», «F An Hội Tây» ⇒
 * «phuong an hoi tay»; «q3» ⇒ «quan 3»; «tp» ⇒ «thanh pho»; «tx» ⇒ «thi xa»; «tt» ⇒ «thi tran»; «h.» ⇒ «huyen»; «x.» ⇒ «xa».
 * Chạy trên chữ ĐÃ GẬP.
 */
export function expandAbbreviations(folded: string): string {
  return expandTypeAbbreviations(splitJoinedWardDistrict(folded).text);
}

/** Dính liền phường + quận kiểu Sài Gòn: «f1q5», «p13q3» (một từ, không dấu cách) ⇒ «phuong 1 quan 5» — kèm danh sách đã bung. */
function splitJoinedWardDistrict(folded: string): { text: string; used: DistrictAbbreviation[] } {
  const used: DistrictAbbreviation[] = [];
  const text = ` ${folded} `.replace(/ (?:p|f|ph)(\d{1,2})q(\d{1,2})(?= )/g, (m: string, w: string, d: string) => {
    used.push({ token: m.trim(), district: `quan ${d}` });
    return ` phuong ${w} quan ${d}`;
  });
  return { text: text.trim(), used };
}

/** Phần bung viết tắt LOẠI đơn vị («p5», «q3», «tp», «tx», «h.»…) — không đoán tên. */
function expandTypeAbbreviations(folded: string): string {
  return ` ${folded} `
    .replace(/ (?:p|f|ph) ?(\d{1,2}) /g, " phuong $1 ")
    .replace(/ q ?(\d{1,2}) /g, " quan $1 ")
    .replace(/ tp(?= )/g, " thanh pho")
    .replace(/ tx(?= )/g, " thi xa")
    .replace(/ tt(?= )/g, " thi tran")
    // «Lô F / Tòa P / Lầu F / Block F An Phú» là tên toà / lô, không phải «phường An Phú» (review PR #848 lần 2) ⇒ không bung sau từ chỉ công trình.
    .replace(/(?<! (?:lo|toa|block|blok|khu|day|tang|lau|can|ho|nha|so|kiot|ki ot)) (?:p|f)(?= [a-z])/g, " phuong")
    .replace(/ q(?= [a-z])/g, " quan")
    .replace(/ h(?= [a-z])/g, " huyen")
    .replace(/ x(?= [a-z])/g, " xa")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Viết tắt quận / thành phố CŨ của TP HCM khách hay gõ («P13 GV», «Q.PN»). Bảng ĐÓNG, khai tay — đích là TÊN HUYỆN CŨ (đã gập)
 * và bài kiểm (`tests/address-normalize.test.ts`) khẳng định mỗi đích có thật trong danh mục cũ của TP HCM: viết tắt chỉ là lối
 * tới một tên có nguồn, không phải một ánh xạ địa giới mới. CỐ Ý không có: «BT» (Bình Thạnh hay Bình Tân?), «TP» (thành phố),
 * «CC» (chung cư / Củ Chi), «BC» (bưu cục / Bình Chánh) — mơ hồ thì không đoán.
 */
export const HCM_DISTRICT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  gv: "quan go vap",
  pn: "quan phu nhuan",
  tb: "quan tan binh",
  btan: "quan binh tan",
  bthanh: "quan binh thanh",
  td: "thanh pho thu duc",
};
const HCM_PROVINCE_CODE = 79;

/**
 * Bung viết tắt quận HCM — CHỈ khi có căn cứ đó là một quận: đứng sau «quận» («q gv»), ngay sau một phường số («phuong 13 gv»),
 * hoặc dòng địa chỉ đã nói TP HCM. «TB» trơ trọi trong một dòng không nói tỉnh nào thì giữ nguyên chữ.
 */
function expandHcmDistricts(t: string, hcmNamed: boolean): { text: string; used: DistrictAbbreviation[] } {
  const keys = Object.keys(HCM_DISTRICT_ABBREVIATIONS).join("|");
  const used: DistrictAbbreviation[] = [];
  const full = (k: string) => {
    used.push({ token: k.toUpperCase(), district: HCM_DISTRICT_ABBREVIATIONS[k] });
    return HCM_DISTRICT_ABBREVIATIONS[k];
  };
  let out = ` ${t} `
    .replace(new RegExp(` quan (${keys})(?= )`, "g"), (_m, k: string) => ` ${full(k)}`)
    .replace(new RegExp(` (phuong [0-9]{1,2}) (${keys})(?= )`, "g"), (_m, w: string, k: string) => ` ${w} ${full(k)}`);
  if (hcmNamed) out = out.replace(new RegExp(` (${keys})(?= )`, "g"), (_m, k: string) => ` ${full(k)}`);
  return { text: out.replace(/\s+/g, " ").trim(), used };
}

/** Tên quận / huyện CŨ đúng chữ danh mục («Quận Gò Vấp») cho một tên đã gập («quan go vap»); không có ⇒ chính chữ gập. */
function legacyDistrictName(provinceCode: number, folded: string): string {
  for (const x of index().wards) {
    if (x.w.provinceCode !== provinceCode) continue;
    const l = x.legacy.find((y) => `${y.districtType} ${y.district}`.trim() === folded);
    if (l) return l.rawDistrict;
  }
  return folded;
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
  wards: { w: AdminWard; type: string; core: string; legacy: LegacyPair[] }[];
  wardCoreCount: Map<string, number>;
};

/** Một cặp (huyện cũ, xã cũ) đã gộp vào một xã mới: phần gập để khớp + chữ gốc để nói với khách. */
type LegacyPair = { district: string; districtType: string; ward: string; wardType: string; rawDistrict: string; rawWard: string };

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
          return { district: dd.core, districtType: dd.type, ward: ww.core, wardType: ww.type, rawDistrict: d, rawWard: w };
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

/** Quận / huyện CŨ (đã gập) của một tỉnh được nhắc trong dòng chữ (có loại «quận Gò Vấp» hoặc tên trơn đủ dài «Gò Vấp»). HÀM THUẦN. */
export function oldDistrictsIn(text: string, provinceCode: number): string[] {
  const t = expandAbbreviations(foldVnText(text));
  const out = new Set<string>();
  for (const x of index().wards) {
    if (x.w.provinceCode !== provinceCode) continue;
    for (const l of x.legacy) if ((l.districtType && lastWordHit(t, `${l.districtType} ${l.district}`) >= 0) || (!needsType(l.district) && lastWordHit(t, l.district) >= 0)) out.add(l.district);
  }
  return [...out];
}

/** Quận / huyện CŨ (đã gập) có phần đất trong một xã MỚI (tên chuẩn); không có xã đó ⇒ mảng rỗng. HÀM THUẦN. */
export function wardOldDistricts(wardName: string, provinceCode: number): string[] {
  const x = index().wards.find((w) => w.w.provinceCode === provinceCode && w.w.name === wardName);
  return x ? [...new Set(x.legacy.map((l) => l.district))] : [];
}

/** Danh mục xã / phường MỚI của một tỉnh — cho ô chọn xã. */
export function adminWardsOf(provinceCode: number): AdminWard[] {
  return index().wards.filter((x) => x.w.provinceCode === provinceCode).map((x) => x.w);
}

/**
 * Xã / phường MỚI của một tỉnh theo tên người / khách gõ («đông ngạc», «Phường Đông Ngạc», «P. Đông Ngạc»); không có ⇒ `null`.
 * Chỉ tra trong danh mục — tên lạ không bao giờ thành một xã.
 */
export function findWardIn(provinceCode: number, text: string): AdminWard | null {
  const f = expandAbbreviations(foldVnText(text));
  if (!f) return null;
  const { type, core } = splitType(f);
  const hits = index().wards.filter((x) => x.w.provinceCode === provinceCode && x.core === core && (!type || x.type === type));
  return hits.length === 1 ? hits[0].w : null;
}

/**
 * Chữ (đã gập) có phải đúng MỘT tên hành chính — tỉnh mới / cũ, xã mới, huyện cũ, xã cũ — không. Cho bộ tách phần số nhà / đường:
 * đoạn «…, Bắc Từ Liêm, …» không có tiền tố loại vẫn là đơn vị hành chính, không phải tên đường.
 */
export function isAdminName(folded: string): boolean {
  const f = expandAbbreviations(folded);
  const core = splitType(f).core;
  if (!core) return false;
  const idx = index();
  if (idx.provinces.some((x) => x.names.includes(core) || x.names.includes(f))) return true;
  if (needsType(core)) return false;
  return idx.wardCoreCount.has(core) || adminLegacyNames().has(core);
}

let legacyNames: Set<string> | null = null;
function adminLegacyNames(): Set<string> {
  if (legacyNames) return legacyNames;
  legacyNames = new Set(index().wards.flatMap((x) => x.legacy.flatMap((l) => [l.district, l.ward])));
  return legacyNames;
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
  const raw = foldVnText(text);
  if (!raw) return { status: "UNKNOWN", reason: "Địa chỉ trống." };
  // Từng đoạn giữa hai dấu phẩy (đã gập + bung viết tắt loại) — cho bước «xã cũ đứng một mình» (`legacyWardAlone`).
  const segments = text.split(/[,;\n]+/).map((x) => expandTypeAbbreviations(foldVnText(x))).filter(Boolean);
  const joined = splitJoinedWardDistrict(raw);
  const t0 = expandTypeAbbreviations(joined.text);
  const named = provinceIn(t0);
  const hcm = expandHcmDistricts(t0, named?.p.code === HCM_PROVINCE_CODE);
  const used = [...joined.used, ...hcm.used];
  const r = readFolded(hcm.text, raw, segments);
  // Viết tắt RA TÊN quận («GV», «f1q5») chỉ là LỐI TỚI một tên có nguồn — nó không được là căn cứ DUY NHẤT của tỉnh, cũng không
  // được đổi tỉnh. Khách đã ghi tỉnh ⇒ tỉnh đứng trên chữ khách gõ, viết tắt chỉ giúp tìm xã.
  if (!used.length || named) return r;
  if (r.status === "UNKNOWN") {
    // Bộ đọc đã trả gợi ý (tên quận không có NGUYÊN CHỮ) ⇒ gắn đúng chữ viết tắt sinh ra tên quận đó, để câu hỏi khách nói «"GV"…».
    const u = r.hint && !r.hint.abbreviation ? used.find((x) => legacyDistrictName(r.hint!.province.code, x.district) === r.hint!.district) : undefined;
    return u && r.hint ? { ...r, reason: hintReason(u.token, r.hint.district, r.hint.province.name), hint: { ...r.hint, abbreviation: u.token } } : r;
  }
  const plain = readFolded(expandTypeAbbreviations(raw), raw, segments);
  if (plain.status !== "UNKNOWN") return plain.province.code === r.province.code ? r : plain;
  return withProvinceHint(r, used[0].token, legacyDistrictName(r.province.code, used[0].district));
}

/** Kết quả đọc NẾU viết tắt đúng ⇒ CHƯA BIẾT TỈNH + gợi ý cho câu hỏi khách (không bao giờ là căn cứ ghi). */
function withProvinceHint(r: Exclude<AddressMatch, { status: "UNKNOWN" }>, abbreviation: string | null, district: string): AddressMatch {
  return {
    status: "UNKNOWN",
    reason: hintReason(abbreviation, district, r.province.name),
    hint: { province: r.province, abbreviation, district, candidates: r.status === "MATCHED" ? [r.ward] : r.status === "AMBIGUOUS" ? r.candidates : [] },
  };
}

function hintReason(abbreviation: string | null, district: string, province: string): string {
  const what = abbreviation ? `«${abbreviation}» có thể là ${district} cũ` : `${district} (gõ tắt) có thể thuộc`;
  return `Không thấy tên tỉnh / thành — ${what} (${province}) nhưng khách chưa ghi tỉnh: hỏi khách xác nhận, không tự điền.`;
}

/**
 * Phần đọc của `normalizeVnAddress` trên chữ ĐÃ gập + bung viết tắt (`t`). `raw` = chữ đã gập NHƯNG CHƯA bung viết tắt — để biết
 * tên quận / huyện có loại là chữ khách gõ NGUYÊN («quận 1», «thành phố Vinh») hay chỉ đọc ra từ viết tắt («q1», «tp Vinh»).
 */
function readFolded(t: string, raw: string, segments: readonly string[] = []): AddressMatch {
  const idx = index();
  const prov = provinceIn(t);
  // Phần chữ TRƯỚC tên tỉnh — xã / huyện nằm ở đó (tên tỉnh cũng có thể trùng tên một xã: «xã Thanh Hoá»).
  const head = prov ? t.slice(0, Math.max(0, prov.start)).trim() || t : t;
  const pool = prov ? idx.wards.filter((x) => x.w.provinceCode === prov.p.code) : idx.wards;

  // 1. Tên mới CÓ loại («phường bàn cờ») — khách gõ địa chỉ mới.
  const strong = pool.filter((x) => lastWordHit(head, `${x.type} ${x.core}`) >= 0);
  if (strong.length) {
    if (!prov) {
      // Tên NGẮN nằm trọn trong một tên DÀI hơn cùng khớp («phường an hội» trong «phường an hội tây») không phải một khả năng thứ hai —
      // đó là chính chữ của tên dài (P0 15/10/2026, ca «Tuyet Nguyen Thi»: «P An Hội Tây» không tỉnh từng bị đọc thành «trùng tên»).
      const outer = strong.filter((x) => {
        const sx = span(head, `${x.type} ${x.core}`)!;
        return !strong.some((y) => {
          if (y === x) return false;
          const sy = span(head, `${y.type} ${y.core}`)!;
          return sy[0] <= sx[0] && sx[1] <= sy[1] && sy[1] - sy[0] > sx[1] - sx[0];
        });
      });
      if (outer.length === 1 && (idx.wardCoreCount.get(outer[0].core) ?? 0) === 1) return { status: "MATCHED", province: provinceOf(outer[0].w), ward: outer[0].w, via: "NEW_NAME" };
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
    if (p && provs.size === 1 && legacyHits.length <= MAX_WARD_CANDIDATES) {
      // Tên xã cũ đã khớp — chỉ nêu khi MỌI đáp án cùng sinh ra từ đúng một cặp (huyện cũ, xã cũ) (một xã cũ bị chia).
      const pairs = new Set(legacyHits.map((x) => {
        const l = maxByItem(x.legacy, (y) => legacyScore(head, y));
        return l ? `${l.rawDistrict}|${l.rawWard}` : "";
      }));
      const [only] = pairs;
      const legacy = pairs.size === 1 && only ? { district: only.split("|")[0], ward: only.split("|")[1] } : undefined;
      return { status: "AMBIGUOUS", province: p, candidates: legacyHits.map((x) => x.w), reason: "Xã / phường cũ đã được chia cho nhiều xã / phường mới — chọn theo số nhà, đường.", kind: "LEGACY_WARD_SPLIT", ...(legacy ? { legacy } : {}) };
    }
  }
  // Không có tên tỉnh mà có quận / huyện CŨ KÈM LOẠI chỉ tồn tại ở MỘT tỉnh, khách gõ NGUYÊN CHỮ («quận Gò Vấp», «quận 3») ⇒
  // tỉnh đó. Chỉ có dạng gõ tắt («q3», «tp Vinh», «Q. Gò Vấp») ⇒ đọc tiếp cho gợi ý nhưng kết quả là CHƯA BIẾT TỈNH + hint.
  // Tên huyện có loại trùng ở hai tỉnh thì vẫn là chưa biết tỉnh.
  const literal = prov ? null : provinceFromTypedDistrict(head, raw);
  const loose = prov || literal ? null : provinceFromTypedDistrict(head, null);
  const inferred = literal ?? loose;
  if (!prov && !inferred) return { status: "UNKNOWN", reason: strong.length ? "Không thấy tên tỉnh / thành — tên xã trùng ở nhiều tỉnh." : "Không thấy tên tỉnh / thành trong địa chỉ." };
  const pv: AdminProvince = prov ? prov.p : inferred!.province;
  const res = readWithinProvince(head, pv, prov ? pool : idx.wards.filter((x) => x.w.provinceCode === pv.code), segments);
  return loose && res.status !== "UNKNOWN" ? withProvinceHint(res, null, loose.district) : res;
}

/** Bước 3–4 của `normalizeVnAddress` khi đã có tỉnh (`area` = xã của tỉnh đó). */
function readWithinProvince(head: string, pv: AdminProvince, area: Index["wards"], segments: readonly string[] = []): AddressMatch {

  // 3. Tên mới KHÔNG loại — đủ dài, không là số («…, Long Bình, Thủ Đức, HCM»).
  //    Tên trùng tên một HUYỆN CŨ của tỉnh («Việt Trì», «Ba Đình», «Nha Trang») không đứng một mình được: khách viết địa chỉ cũ
  //    thì đó là cả thành phố / quận cũ (nay chia nhiều phường) ⇒ xuống bước 4, người chọn.
  const oldDistricts = new Set(area.flatMap((x) => x.legacy.map((l) => l.district)));
  //    Tên đứng NGAY SAU một số nhà («12 Trần Phú», «ngõ 5 Lê Lợi») ở vị trí tên đường ⇒ là tên đường, không phải xã (review PR #848, X6:
  //    «12 Trần Phú, Hà Đông, Hà Nội» từng tự điền «Xã Trần Phú»). Muốn là xã thì phải có tiền tố loại (bước 1).
  const weak = area.filter((x) => !needsType(x.core) && x.core.includes(" ") && !oldDistricts.has(x.core) && lastWordHit(head, x.core) >= 0 && !afterHouseNumber(head, x.core));
  if (weak.length) {
    const r = pickNew(pv, weak);
    if (r) return r;
  }

  // 3b. Xã CŨ đứng một mình, không kèm huyện cũ («Khu đô thị Xa La, Phúc La cũ, Hà Nội» — ca «Lê Văn Dụ» 15/10/2026): danh mục cho
  //     biết xã cũ đó đã gộp vào xã mới nào. Gộp trọn vào ĐÚNG MỘT xã mới ⇒ dùng; bị chia ⇒ người chọn (không đoán).
  //     Dòng còn nhắc một quận / huyện cũ KHÁC mọi quận cũ của xã đó ⇒ hai chứng cứ mâu thuẫn ⇒ không dùng bước này.
  const named = (l: LegacyPair) => (l.districtType && lastWordHit(head, `${l.districtType} ${l.district}`) >= 0) || (!needsType(l.district) && lastWordHit(head, l.district) >= 0);
  const districtsInHead = new Set(area.flatMap((x) => x.legacy.filter(named).map((l) => l.district)));
  const found = legacyWardAlone(head, segments, area);
  const agrees = !districtsInHead.size || found.some((x) => x.legacy.some((l) => legacyWardNamed(head, segments, l) && districtsInHead.has(l.district)));
  const alone = agrees ? found : [];
  if (alone.length === 1) return { status: "MATCHED", province: pv, ward: alone[0].w, via: "LEGACY" };
  if (alone.length > 1 && alone.length <= MAX_WARD_CANDIDATES) {
    const pairs = new Set(alone.map((x) => x.legacy.filter((l) => legacyWardNamed(head, segments, l)).map((l) => `${l.rawDistrict}|${l.rawWard}`).join("§")));
    const [only] = pairs;
    if (pairs.size === 1 && only && !only.includes("§")) {
      const [district, ward] = only.split("|");
      return { status: "AMBIGUOUS", province: pv, candidates: alone.map((x) => x.w), reason: "Xã / phường cũ đã được chia cho nhiều xã / phường mới — chọn theo số nhà, đường.", kind: "LEGACY_WARD_SPLIT", legacy: { district, ward } };
    }
  }

  // 3c. THỊ TRẤN HUYỆN LỴ CŨ (P0 16/10/2026, #855 ca «Lieu Dau»: «thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An»). Thị trấn huyện lỵ từng đổi
  //     tên ngay trước 2025 (TT Anh Sơn → TT Kim Nhan) nên danh mục cũ không còn tên khách gõ, và bước 4 đưa cả 6 xã của huyện cho người
  //     chọn. Căn cứ ĐỌC TỪ DỮ LIỆU, không chỉ từ tên: «thị trấn X» khớp ĐÚNG MỘT xã / phường MỚI tên X của tỉnh, VÀ danh mục ghi xã mới đó
  //     có phần đất của chính HUYỆN CŨ TÊN X (thị trấn mang tên huyện = huyện lỵ của huyện X; xã mới giữ tên huyện là xã nhận huyện lỵ).
  //     Huyện khách ghi (bỏ phần chữ của chính tên thị trấn) phải là huyện X — ghi một huyện KHÁC («thị trấn Anh Sơn, huyện Đô Lương») là
  //     hai chứng cứ mâu thuẫn ⇒ KHÔNG ghép, để người kiểm, và không hỏi khách quy đổi (khách đã ghi xã cũ — `legacy` có mặt). Danh mục cũ
  //     CÓ thị trấn mang đúng tên đó (bước 2 / 3b đã xét) ⇒ không dùng bước này.
  const townHits = area.filter((x) => !needsType(x.core) && lastWordHit(head, `thi tran ${x.core}`) >= 0 && x.legacy.some((l) => l.district === x.core));
  const oldTownNamed = area.some((x) => x.legacy.some((l) => l.wardType === "thi tran" && lastWordHit(head, `thi tran ${l.ward}`) >= 0));
  if (townHits.length === 1 && !oldTownNamed) {
    const town = townHits[0];
    const rest = ` ${head} `.split(` thi tran ${town.core} `).join(" ").trim();
    const otherDistricts = new Set(area.flatMap((x) => x.legacy.filter((l) => (l.districtType && lastWordHit(rest, `${l.districtType} ${l.district}`) >= 0) || (!needsType(l.district) && lastWordHit(rest, l.district) >= 0)).map((l) => l.district)));
    if (!otherDistricts.size || (otherDistricts.size === 1 && otherDistricts.has(town.core))) return { status: "MATCHED", province: pv, ward: town.w, via: "LEGACY" };
    const named = [...otherDistricts].filter((d) => d !== town.core);
    const raw = area.flatMap((x) => x.legacy).find((l) => named.includes(l.district))?.rawDistrict ?? named[0];
    return { status: "AMBIGUOUS", province: pv, candidates: [town.w], reason: `Thị trấn ${town.w.name.replace(/^(?:Xã|Phường|Thị trấn|Đặc khu) /, "")} (huyện lỵ cũ) không thuộc ${raw} khách ghi — hai chứng cứ mâu thuẫn, nhân viên xác nhận.`, kind: "LEGACY_DISTRICT_ONLY", legacy: { ward: `Thị trấn ${town.w.name.replace(/^(?:Xã|Phường|Thị trấn|Đặc khu) /, "")}`, district: raw } };
  }

  // 4. Chỉ huyện cũ.
  const byDistrict = area.filter((x) => x.legacy.some((l) => (l.districtType && lastWordHit(head, `${l.districtType} ${l.district}`) >= 0) || (!needsType(l.district) && lastWordHit(head, l.district) >= 0)));
  // Xã mới mang ĐÚNG tên huyện cũ («Đặc khu Phú Quốc», «Phường Việt Trì») lên đầu danh sách — vẫn là gợi ý, người chọn.
  byDistrict.sort((a, b) => Number(lastWordHit(head, b.core) >= 0) - Number(lastWordHit(head, a.core) >= 0));
  if (byDistrict.length === 1) return { status: "MATCHED", province: pv, ward: byDistrict[0].w, via: "LEGACY" };
  if (byDistrict.length > 1 && byDistrict.length <= MAX_WARD_CANDIDATES) return { status: "AMBIGUOUS", province: pv, candidates: byDistrict.map((x) => x.w), reason: typedWardIn(head) ? `Danh mục cũ không có «${typedWardIn(head)}» trong quận / huyện này (có thể đã gộp trước 01/07/2025) — chọn xã / phường mới theo quận / huyện cũ.` : "Chỉ có quận / huyện cũ — chọn xã / phường mới.", kind: "LEGACY_DISTRICT_ONLY" };
  return { status: "PROVINCE_ONLY", province: pv, reason: byDistrict.length ? `Chỉ có quận / huyện cũ (${byDistrict.length} xã / phường mới) — cần tên xã / phường.` : "Không đọc được xã / phường." };
}

/**
 * Quận / huyện cũ CÓ LOẠI nhắc trong dòng mà chỉ một tỉnh có ⇒ tỉnh đó + tên huyện (chữ danh mục); không có / nhiều tỉnh ⇒ `null`.
 * `raw` khác `null` ⇒ chỉ tính tên có mặt NGUYÊN CHỮ trong chữ gốc trước khi bung viết tắt («quan 1» có, «q1» không).
 */
function provinceFromTypedDistrict(head: string, raw: string | null): { province: AdminProvince; district: string } | null {
  const codes = new Set<number>();
  let district = "";
  for (const x of index().wards) {
    for (const l of x.legacy) {
      const name = `${l.districtType} ${l.district}`;
      if (!l.districtType || lastWordHit(head, name) < 0 || (raw !== null && lastWordHit(raw, name) < 0)) continue;
      codes.add(x.w.provinceCode);
      district = l.rawDistrict;
    }
  }
  if (codes.size !== 1) return null;
  const [code] = codes;
  const province = index().provinces.find((x) => x.p.code === code)?.p;
  return province ? { province, district } : null;
}

/**
 * Xã CŨ khách ghi KHÔNG kèm huyện cũ: có tiền tố loại ở bất kỳ đâu («phường Phúc La», «P Phúc La»), hoặc đứng TRỌN một đoạn giữa hai
 * dấu phẩy («…, Phúc La cũ, …»). Tên đứng lẫn trong đoạn số nhà / đường («12 Lê Lợi») KHÔNG tính — đó thường là tên đường. Tên chỉ là
 * số («phường 12») không đứng một mình được: cả nước có hàng trăm phường 12, phải kèm quận cũ (bước 2).
 */
function legacyWardNamed(head: string, segments: readonly string[], l: LegacyPair): boolean {
  if (needsType(l.ward)) return false;
  if (l.wardType && lastWordHit(head, `${l.wardType} ${l.ward}`) >= 0) return true;
  if (!l.ward.includes(" ")) return false;
  return segments.some((s) => s === l.ward || s === `${l.ward} cu`);
}

/** Xã MỚI có phần đất của một xã CŨ khách ghi một mình (`legacyWardNamed`) — một ⇒ gộp trọn, nhiều ⇒ bị chia. */
function legacyWardAlone(head: string, segments: readonly string[], area: Index["wards"]): Index["wards"] {
  return area.filter((x) => x.legacy.some((l) => legacyWardNamed(head, segments, l)));
}

/** Chữ «phường / xã / thị trấn <tên>» khách ghi (đã gập) — để nói rõ khi danh mục không có nó. */
function typedWardIn(head: string): string | null {
  const m = ` ${head} `.match(/ (phuong|xa|thi tran) (\d{1,2}|[a-z]+(?: [a-z]+)?)(?= )/);
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * Lần xuất hiện CUỐI của `name` (đủ từ, KHÔNG có tiền tố loại) đứng ngay sau một từ là số («12», «230 20», «5a») ⇒ vị trí tên đường
 * («12 Trần Phú»), không phải tên xã / phường. HÀM THUẦN.
 */
function afterHouseNumber(head: string, name: string): boolean {
  const s = span(head, name);
  if (!s) return false;
  // `span` trả vị trí trên chuỗi có dấu cách đệm đầu (` ${head}`) — cắt trên đúng chuỗi đó.
  const prev = ` ${head}`.slice(0, s[0]).trim().split(" ").pop() ?? "";
  return /^\d/.test(prev);
}

/** Một đoạn (đủ từ) khớp ⇒ [đầu, cuối) của lần xuất hiện CUỐI; không có ⇒ null. */
function span(hay: string, needle: string): [number, number] | null {
  const end = lastWordHit(hay, needle);
  return end < 0 ? null : [end - needle.length, end];
}

/** Điểm khớp của một cặp (huyện cũ, xã cũ) với dòng địa chỉ: 0 = không khớp; ngược lại = tổng độ dài hai đoạn khớp. */
function legacyScore(head: string, l: LegacyPair): number {
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
  return { status: "AMBIGUOUS", province: p, candidates: top.slice(0, MAX_WARD_CANDIDATES).map((x) => x.w), reason: "Nhiều xã / phường cùng tên trong tỉnh.", kind: "SAME_NAME" };
}

function provinceOf(w: AdminWard): AdminProvince {
  return index().provinces.find((x) => x.p.code === w.provinceCode)!.p;
}

function maxBy<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((m, x) => Math.max(m, f(x)), -Infinity);
}

/** Phần tử điểm cao nhất (> 0); không có ⇒ `null`. */
function maxByItem<T>(xs: readonly T[], f: (x: T) => number): T | null {
  let best: T | null = null;
  let score = 0;
  for (const x of xs) {
    const v = f(x);
    if (v > score) {
      best = x;
      score = v;
    }
  }
  return best;
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
