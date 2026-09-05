/**
 * Đơn landing page: dữ liệu khách điền form đổ về Google Sheet → ERP đọc sheet (CSV export), theo dõi trạng thái,
 * cảnh báo trùng / rủi ro, gửi lên Pancake POS làm đơn nháp. Các hàm ở đây thuần (không DB) để test được.
 */
export type LandingStatus = "NEW" | "CONFIRMED" | "PUSHED" | "CANCELLED";
export const LANDING_STATUSES: LandingStatus[] = ["NEW", "CONFIRMED", "PUSHED", "CANCELLED"];
export const LANDING_STATUS_LABEL: Record<LandingStatus, string> = {
  NEW: "Mới về",
  CONFIRMED: "Đã xác nhận",
  PUSHED: "Đã gửi POS",
  CANCELLED: "Huỷ",
};

/** Cột nhận diện trong sheet (khoá → tên cột thật, tự dò theo tiêu đề nếu để trống) */
export type LandingColumnKey = "time" | "name" | "phone" | "address" | "ward" | "district" | "province" | "product" | "variant" | "size" | "color" | "quantity" | "price" | "total" | "offer" | "note" | "source" | "campaign" | "adId" | "status";
export const LANDING_COLUMN_LABEL: Record<LandingColumnKey, string> = {
  time: "Thời gian",
  name: "Tên khách",
  phone: "Số điện thoại",
  address: "Địa chỉ",
  ward: "Phường / xã",
  district: "Quận / huyện",
  province: "Tỉnh / thành",
  product: "Sản phẩm",
  variant: "Mẫu mã (size/màu gộp)",
  size: "Size",
  color: "Màu",
  quantity: "Số lượng",
  price: "Đơn giá",
  total: "Thành tiền",
  offer: "Gói mua (vd “1 Sản phẩm 499k”)",
  note: "Ghi chú",
  source: "Link landing / utm",
  campaign: "Tên chiến dịch",
  adId: "ad_id Facebook",
  status: "Trạng thái trên sheet",
};

export type LandingConfig = {
  /** Link Google Sheet (chia sẻ "Bất kỳ ai có liên kết" – xem) hoặc link CSV */
  sheetUrl: string;
  /** gid của tab; rỗng = tab đầu */
  gid: string;
  /** Ghi đè cột: khoá → tiêu đề cột trong sheet, hoặc "#n" = cột thứ n (đếm từ 1) khi sheet không có tiêu đề */
  columns: Partial<Record<LandingColumnKey, string>>;
  /** Sheet có dòng tiêu đề không: auto (tự nhận), yes, no */
  hasHeader: "auto" | "yes" | "no";
  /** Số ngày coi là trùng khi cùng SĐT (landing khác hoặc đơn Pancake) */
  dedupeDays: number;
  /** Tự gửi đơn nháp lên POS ngay khi nhập (mặc định tắt: nhân viên xác nhận rồi bấm gửi) */
  autoPush: boolean;
  /** Phí ship mặc định khi tạo đơn nháp (đ) */
  shippingFee: number;
  /** Ghi chú thêm vào đơn POS */
  posNote: string;
  /** Kho Pancake mặc định (warehouse_id) khi tạo đơn nháp; rỗng = để Pancake tự chọn */
  warehouseId: string;
};
export const LANDING_CONFIG_KEY = "landing.config";
export const DEFAULT_LANDING_CONFIG: LandingConfig = { sheetUrl: "", gid: "", columns: {}, hasHeader: "auto", dedupeDays: 7, autoPush: false, shippingFee: 25_000, posNote: "Đơn landing page", warehouseId: "" };

/** Bí danh tiêu đề (không dấu, thường) cho từng cột */
const HEADER_ALIASES: Record<LandingColumnKey, string[]> = {
  time: ["thoi gian", "timestamp", "ngay", "date", "time", "created", "submitted", "dau thoi gian"],
  name: ["ho ten", "ho va ten", "ten khach", "ten", "khach hang", "name", "full name", "fullname"],
  phone: ["so dien thoai", "sdt", "dien thoai", "phone", "so dt", "sđt", "mobile", "tel"],
  address: ["dia chi", "address", "dia chi nhan hang", "noi nhan"],
  ward: ["phuong xa", "phuong", "xa", "ward"],
  district: ["quan huyen", "quan", "huyen", "district"],
  province: ["tinh", "thanh pho", "tinh thanh", "province", "city"],
  product: ["san pham", "product", "mau", "ma hang", "ten san pham", "sp"],
  variant: ["phan loai", "mau ma", "variant", "loai", "chon", "option"],
  size: ["size", "kich co", "kich thuoc", "co"],
  color: ["mau sac", "color", "colour", "mau"],
  quantity: ["so luong", "sl", "quantity", "qty"],
  price: ["don gia", "gia", "price", "gia ban"],
  total: ["thanh tien", "tong tien", "total", "tong", "tong cong", "amount"],
  offer: ["goi", "combo", "goi mua", "offer", "lua chon", "so luong san pham"],
  note: ["ghi chu", "note", "loi nhan", "yeu cau", "message"],
  source: ["nguon", "source", "utm", "utm_source", "landing", "trang", "url", "link"],
  campaign: ["chien dich", "campaign", "campaign name", "ten chien dich", "utm_campaign"],
  adId: ["ad id", "ad_id", "adid", "ma quang cao"],
  status: ["trang thai", "status", "tinh trang", "xu ly"],
};

export function normalizeHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Dò cột: ưu tiên ghi đè trong cấu hình, rồi khớp bí danh (khớp cả tiêu đề > chứa bí danh) */
export function detectColumns(headers: string[], overrides: Partial<Record<LandingColumnKey, string>> = {}): Partial<Record<LandingColumnKey, number>> {
  const norm = headers.map(normalizeHeader);
  const out: Partial<Record<LandingColumnKey, number>> = {};
  const used = new Set<number>();
  for (const [key, title] of Object.entries(overrides) as [LandingColumnKey, string][]) {
    if (!title) continue;
    const byIndex = /^#(\d+)$/.exec(title.trim());
    const idx = byIndex ? Number(byIndex[1]) - 1 : norm.indexOf(normalizeHeader(title));
    if (idx >= 0 && idx < headers.length) {
      out[key] = idx;
      used.add(idx);
    }
  }
  // "mau" vừa là màu vừa là mẫu → xét color trước product khi tiêu đề là "mau sac"; thứ tự dưới đây tránh nhầm
  const order: LandingColumnKey[] = ["phone", "name", "time", "address", "ward", "district", "province", "quantity", "total", "price", "offer", "size", "color", "variant", "product", "adId", "campaign", "note", "source", "status"];
  for (const key of order) {
    if (out[key] !== undefined) continue;
    const aliases = HEADER_ALIASES[key];
    let found = norm.findIndex((h, i) => !used.has(i) && aliases.includes(h));
    if (found < 0) found = norm.findIndex((h, i) => !used.has(i) && aliases.some((a) => a.length >= 3 && (h.startsWith(`${a} `) || h.includes(` ${a} `) || h.endsWith(` ${a}`) || h === a)));
    if (found < 0 && key !== "color" && key !== "product") found = norm.findIndex((h, i) => !used.has(i) && aliases.some((a) => a.length >= 4 && h.includes(a)));
    if (found >= 0) {
      out[key] = found;
      used.add(found);
    }
  }
  return out;
}

/** CSV RFC4180 (dấu phẩy, ngoặc kép, xuống dòng trong ô) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** SĐT Việt Nam về dạng 0xxxxxxxxx (bỏ +84, khoảng trắng, chấm) */
export function normalizePhone(v: string | null | undefined): string {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("84") && d.length >= 11) d = `0${d.slice(2)}`;
  if (d.length === 9 && !d.startsWith("0")) d = `0${d}`;
  return d.length >= 10 && d.length <= 11 ? d : d;
}

export function parseMoney(v: string | null | undefined): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const m = s.replace(/[^\d.,kK]/g, "");
  if (/k$/i.test(m)) return Math.round(parseFloat(m.replace(/[.,]/g, ".")) * 1000) || 0;
  const digits = m.replace(/[.,]/g, "");
  return Number(digits) || 0;
}

/** Thời gian trên sheet: dd/mm/yyyy hh:mm, yyyy-mm-dd, mm/dd/yyyy (Google Forms tiếng Anh) → Date (giờ VN) */
export function parseSheetTime(v: string | null | undefined, fallback: Date | null = null): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return fallback;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return new Date(`${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${(m[4] ?? "0").padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}+07:00`);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}+07:00`);
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? fallback : t;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/;
const PHONE_RE = /^(\+?84|0)?\d{9,10}$/;
const VARIANT_RE = /(size|màu|mau|color)/i;
const OFFER_RE = /(\d+)\s*(sản phẩm|san pham|sp|cái|cai|chiếc|chiec)?[^\d]*?(\d{2,3})\s*k\b|(\d+)\s*(sản phẩm|san pham).*?(\d[\d.,]{4,})/i;
const AD_ID_RE = /^\d{15,20}$/;
/** 63 tỉnh thành (+ tên cũ / viết tắt phổ biến), dạng không dấu để đối chiếu */
const VN_PROVINCES = new Set(
  ["ha noi", "ho chi minh", "hcm", "sai gon", "da nang", "hai phong", "can tho", "an giang", "ba ria vung tau", "vung tau", "bac giang", "bac kan", "bac lieu", "bac ninh", "ben tre", "binh dinh", "binh duong", "binh phuoc", "binh thuan", "ca mau", "cao bang", "dak lak", "dak nong", "dien bien", "dong nai", "dong thap", "gia lai", "ha giang", "ha nam", "ha tinh", "hai duong", "hau giang", "hoa binh", "hung yen", "khanh hoa", "kien giang", "kon tum", "lai chau", "lam dong", "lang son", "lao cai", "long an", "nam dinh", "nghe an", "ninh binh", "ninh thuan", "phu tho", "phu yen", "quang binh", "quang nam", "quang ngai", "quang ninh", "quang tri", "soc trang", "son la", "tay ninh", "thai binh", "thai nguyen", "thanh hoa", "thua thien hue", "hue", "tien giang", "tra vinh", "tuyen quang", "vinh long", "vinh phuc", "yen bai"],
);
const isProvince = (v: string) => VN_PROVINCES.has(normalizeHeader(v).replace(/^(tp|thanh pho|tinh)\s+/, "").trim());
const DISTRICT_RE = /^(quận|huyện|thị xã|thành phố|tp\.?)\s+/i;
const WARD_RE = /^(phường|xã|thị trấn)\s+/i;

/** Dòng đầu là tiêu đề hay dữ liệu? Dữ liệu nếu có ô là ngày giờ / SĐT / ad_id */
export function looksLikeHeader(row: string[]): boolean {
  const cells = row.map((c) => c.trim());
  if (cells.some((c) => DATE_RE.test(c))) return false;
  if (cells.some((c) => PHONE_RE.test(c.replace(/[\s.]/g, "")) && /\d{9}/.test(c))) return false;
  if (cells.some((c) => AD_ID_RE.test(c))) return false;
  return true;
}

/** Dò cột theo NỘI DUNG (sheet không có tiêu đề, vd form landing đổ thẳng dữ liệu) — lấy đa số trong tối đa 50 dòng */
export function detectColumnsByContent(rows: string[][]): Partial<Record<LandingColumnKey, number>> {
  const sample = rows.slice(0, 50);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const score = (i: number, test: (v: string) => boolean) => {
    let hit = 0;
    let n = 0;
    for (const r of sample) {
      const v = (r[i] ?? "").trim();
      if (!v) continue;
      n += 1;
      if (test(v)) hit += 1;
    }
    return n ? hit / n : 0;
  };
  const out: Partial<Record<LandingColumnKey, number>> = {};
  const used = new Set<number>();
  const pick = (key: LandingColumnKey, test: (v: string) => boolean, min = 0.6) => {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < width; i++) {
      if (used.has(i)) continue;
      const sc = score(i, test);
      if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= min) {
      out[key] = best;
      used.add(best);
    }
  };
  pick("time", (v) => DATE_RE.test(v));
  pick("phone", (v) => PHONE_RE.test(v.replace(/[\s.]/g, "")));
  pick("adId", (v) => AD_ID_RE.test(v), 0.8); // cột id đầu tiên = ad_id (utm_term); cột id kế tiếp là adset
  pick("source", (v) => /^https?:\/\//i.test(v));
  pick("variant", (v) => VARIANT_RE.test(v));
  pick("offer", (v) => OFFER_RE.test(v));
  pick("campaign", (v) => /[A-Z]{1,4}\d{0,3}_.*(Q\d{3}|_V\d|_C[ĐD])/i.test(v) || /^[A-Z0-9]{2,6}_/.test(v), 0.5);
  pick("ward", (v) => WARD_RE.test(v), 0.5);
  pick("district", (v) => DISTRICT_RE.test(v), 0.5);
  pick("province", (v) => isProvince(v), 0.5);
  // tên khách: cột chữ ngắn (≤ 6 từ, không số) ngay sau thời gian / trước SĐT
  const timeIdx = out.time ?? -1;
  for (const i of [timeIdx + 1, (out.phone ?? 0) - 1]) if (i >= 0 && i < width && !used.has(i) && score(i, (v) => /^[^\d]{2,60}$/.test(v) && v.split(/\s+/).length <= 6 && !isProvince(v)) >= 0.6) { out.name = i; used.add(i); break; }
  // địa chỉ: cột chữ dài nhất còn lại (thường ngay sau SĐT)
  let addr = -1;
  let addrLen = 0;
  for (let i = 0; i < width; i++) {
    if (used.has(i)) continue;
    const avg = sample.reduce((t, r) => t + ((r[i] ?? "").trim().length || 0), 0) / Math.max(1, sample.filter((r) => (r[i] ?? "").trim()).length);
    if (score(i, (v) => /\d/.test(v) || v.split(" ").length >= 3) >= 0.5 && avg > addrLen && avg >= 12) { addrLen = avg; addr = i; }
  }
  if (addr >= 0) { out.address = addr; used.add(addr); }
  // ghi chú: cột chữ thưa (nhiều ô trống) không phải các cột trên, nằm giữa địa chỉ và mẫu mã
  for (let i = (out.address ?? 0) + 1; i < (out.variant ?? width); i++) {
    if (used.has(i)) continue;
    const filled = sample.filter((r) => (r[i] ?? "").trim()).length;
    if (filled > 0 && filled < sample.length && score(i, (v) => /[a-zà-ỹ]/i.test(v) && !/việt nam/i.test(v)) >= 0.8) { out.note = i; used.add(i); break; }
  }
  return out;
}

/** "Size XL,Màu  Đỏ Đô" → { size: "XL", color: "Đỏ Đô" } */
export function parseVariantText(v: string): { size: string; color: string } {
  const size = /size\s*[:：]?\s*([A-Za-z0-9]{1,4})/i.exec(v)?.[1] ?? "";
  const color = /(?:màu|mau|color)\s*[:：]?\s*([^,;|]+)/i.exec(v)?.[1]?.trim() ?? "";
  return { size: size.toUpperCase(), color };
}

/** "1 Sản phẩm 499k" → { quantity 1, total 499000 }; "2 sản phẩm 849k" → { 2, 849000 } (giá gói, không phải đơn giá) */
export function parseOfferText(v: string): { quantity: number; total: number } | null {
  const m = OFFER_RE.exec(v);
  if (!m) return null;
  if (m[3]) return { quantity: Number(m[1]) || 1, total: Number(m[3]) * 1000 };
  return { quantity: Number(m[4]) || 1, total: parseMoney(m[6]) };
}

/** Mã hàng trong tên chiến dịch / utm: "QA4_CĐ_05/08_Q002_V2" → "Q002" */
export function productCodeFromText(v: string): string {
  const m = /(?:^|[^A-Z0-9])([A-Z]{1,2}\d{3})(?![0-9])/i.exec(decodeURIComponent(v.replace(/%(?![0-9A-F]{2})/gi, "%25")));
  return m ? m[1].toUpperCase() : "";
}

export type LandingRowInput = {
  rowIndex: number;
  time: Date | null;
  name: string;
  phone: string;
  address: string;
  province: string;
  product: string;
  variant: string;
  size: string;
  color: string;
  quantity: number;
  price: number;
  total: number;
  note: string;
  source: string;
  campaign: string;
  adId: string;
  sheetStatus: string;
  raw: Record<string, string>;
};

/** Một dòng sheet → bản ghi landing (rowIndex tính từ 1 cho dòng dữ liệu đầu tiên) */
export function rowToLanding(headers: string[], cells: string[], cols: Partial<Record<LandingColumnKey, number>>, rowIndex: number): LandingRowInput | null {
  const get = (k: LandingColumnKey) => (cols[k] !== undefined ? (cells[cols[k] as number] ?? "").trim() : "");
  const phone = normalizePhone(get("phone"));
  const name = get("name");
  if (!phone && !name) return null;
  const offer = parseOfferText(get("offer") || get("product"));
  let quantity = Math.max(1, Number(String(get("quantity")).replace(/\D/g, "")) || offer?.quantity || 1);
  let price = parseMoney(get("price"));
  const total = parseMoney(get("total")) || (offer?.total ?? 0) || price * quantity;
  if (!price && total && quantity) price = Math.round(total / quantity);
  if (!quantity) quantity = 1;
  const variantText = get("variant");
  const parsedVariant = variantText ? parseVariantText(variantText) : { size: "", color: "" };
  const size = get("size") || parsedVariant.size;
  const color = get("color") || parsedVariant.color;
  const campaign = get("campaign") || (() => { try { return new URL(get("source")).searchParams.get("utm_source") ?? ""; } catch { return ""; } })();
  const adId = get("adId") || (() => { try { return new URL(get("source")).searchParams.get("utm_term") ?? ""; } catch { return ""; } })();
  let product = get("product");
  if (!product || parseOfferText(product)) product = productCodeFromText(campaign) || productCodeFromText(get("source")) || product;
  const address = [get("address"), get("ward"), get("district")].filter(Boolean).join(", ");
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    const key = h.trim() || `Cột ${i + 1}`;
    raw[key] = (cells[i] ?? "").trim();
  });
  return { rowIndex, time: parseSheetTime(get("time")), name, phone, address, province: get("province"), product, variant: variantText, size, color, quantity, price, total, note: get("note"), source: campaign || get("source"), campaign, adId, sheetStatus: get("status"), raw };
}

/** Link Google Sheet → link CSV export (giữ nguyên nếu đã là link CSV / link khác) */
export function sheetCsvUrl(url: string, gid = ""): string {
  const m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return url;
  const g = gid || (/[#&?]gid=(\d+)/.exec(url)?.[1] ?? "");
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${g ? `&gid=${g}` : ""}`;
}

export type VariantCandidate = { id: string; productId: string; productName: string; productCode: string; sku: string; size: string; color: string };

const norm = (v: string) => normalizeHeader(v).replace(/\s+/g, " ");

/**
 * Ghép text sản phẩm / size / màu trên sheet với mẫu mã Pancake: điểm theo mã hàng (Q004), tên sản phẩm, size, màu.
 * Trả null nếu không có ứng viên đủ tin (không khớp mã / tên sản phẩm).
 */
export function matchVariant(input: { product: string; variant: string; size: string; color: string }, candidates: VariantCandidate[]): { variant: VariantCandidate; score: number } | null {
  const text = norm(`${input.product} ${input.variant} ${input.size} ${input.color}`);
  const sizeText = norm(`${input.size} ${input.variant}`);
  const colorText = norm(`${input.color} ${input.variant} ${input.product}`);
  let best: { variant: VariantCandidate; score: number } | null = null;
  for (const c of candidates) {
    let score = 0;
    const code = norm(c.productCode);
    const name = norm(c.productName);
    if (code && new RegExp(`(^| )${code}( |$)`).test(text)) score += 5;
    else if (name && (text.includes(name) || name.split(" ").filter((w) => w.length >= 3).every((w) => text.includes(w)))) score += 3;
    else continue;
    const size = norm(c.size);
    if (size && new RegExp(`(^| )(size )?${size}( |$)`).test(sizeText || text)) score += 2;
    else if (size && !/(^| )(s|m|l|xl|xxl|xxxl|\d{2})( |$)/.test(sizeText || "")) score += 0;
    else if (size) continue;
    const color = norm(c.color);
    if (color && colorText.includes(color)) score += 2;
    else if (color && /(den|trang|do|nau|xanh|vang|hong|tim|be|kem|xam)/.test(colorText)) continue;
    if (!best || score > best.score) best = { variant: c, score };
  }
  return best;
}

export type DuplicateHit = { kind: "LANDING" | "PANCAKE"; id: string; label: string; at: Date | null };
