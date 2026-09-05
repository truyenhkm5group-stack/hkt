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
export type LandingColumnKey = "time" | "name" | "phone" | "address" | "province" | "product" | "variant" | "size" | "color" | "quantity" | "price" | "total" | "note" | "source" | "status";
export const LANDING_COLUMN_LABEL: Record<LandingColumnKey, string> = {
  time: "Thời gian",
  name: "Tên khách",
  phone: "Số điện thoại",
  address: "Địa chỉ",
  province: "Tỉnh / thành",
  product: "Sản phẩm",
  variant: "Mẫu mã (size/màu gộp)",
  size: "Size",
  color: "Màu",
  quantity: "Số lượng",
  price: "Đơn giá",
  total: "Thành tiền",
  note: "Ghi chú",
  source: "Nguồn / chiến dịch",
  status: "Trạng thái trên sheet",
};

export type LandingConfig = {
  /** Link Google Sheet (chia sẻ "Bất kỳ ai có liên kết" – xem) hoặc link CSV */
  sheetUrl: string;
  /** gid của tab; rỗng = tab đầu */
  gid: string;
  /** Ghi đè tên cột (khoá → tiêu đề cột trong sheet) */
  columns: Partial<Record<LandingColumnKey, string>>;
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
export const DEFAULT_LANDING_CONFIG: LandingConfig = { sheetUrl: "", gid: "", columns: {}, dedupeDays: 7, autoPush: false, shippingFee: 25_000, posNote: "Đơn landing page", warehouseId: "" };

/** Bí danh tiêu đề (không dấu, thường) cho từng cột */
const HEADER_ALIASES: Record<LandingColumnKey, string[]> = {
  time: ["thoi gian", "timestamp", "ngay", "date", "time", "created", "submitted", "dau thoi gian"],
  name: ["ho ten", "ho va ten", "ten khach", "ten", "khach hang", "name", "full name", "fullname"],
  phone: ["so dien thoai", "sdt", "dien thoai", "phone", "so dt", "sđt", "mobile", "tel"],
  address: ["dia chi", "address", "dia chi nhan hang", "noi nhan"],
  province: ["tinh", "thanh pho", "tinh thanh", "province", "city"],
  product: ["san pham", "product", "mau", "ma hang", "ten san pham", "sp"],
  variant: ["phan loai", "mau ma", "variant", "loai", "chon", "option"],
  size: ["size", "kich co", "kich thuoc", "co"],
  color: ["mau sac", "color", "colour", "mau"],
  quantity: ["so luong", "sl", "quantity", "qty"],
  price: ["don gia", "gia", "price", "gia ban"],
  total: ["thanh tien", "tong tien", "total", "tong", "tong cong", "amount"],
  note: ["ghi chu", "note", "loi nhan", "yeu cau", "message"],
  source: ["nguon", "source", "utm", "utm_source", "utm_campaign", "chien dich", "campaign", "landing", "trang"],
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
    const idx = norm.indexOf(normalizeHeader(title));
    if (idx >= 0) {
      out[key] = idx;
      used.add(idx);
    }
  }
  // "mau" vừa là màu vừa là mẫu → xét color trước product khi tiêu đề là "mau sac"; thứ tự dưới đây tránh nhầm
  const order: LandingColumnKey[] = ["phone", "name", "time", "address", "province", "quantity", "total", "price", "size", "color", "variant", "product", "note", "source", "status"];
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
  sheetStatus: string;
  raw: Record<string, string>;
};

/** Một dòng sheet → bản ghi landing (rowIndex tính từ 1 cho dòng dữ liệu đầu tiên) */
export function rowToLanding(headers: string[], cells: string[], cols: Partial<Record<LandingColumnKey, number>>, rowIndex: number): LandingRowInput | null {
  const get = (k: LandingColumnKey) => (cols[k] !== undefined ? (cells[cols[k] as number] ?? "").trim() : "");
  const phone = normalizePhone(get("phone"));
  const name = get("name");
  if (!phone && !name) return null;
  const quantity = Math.max(1, Number(String(get("quantity")).replace(/\D/g, "")) || 1);
  const price = parseMoney(get("price"));
  const total = parseMoney(get("total")) || price * quantity;
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    if (h.trim()) raw[h.trim()] = (cells[i] ?? "").trim();
  });
  return { rowIndex, time: parseSheetTime(get("time")), name, phone, address: get("address"), province: get("province"), product: get("product"), variant: get("variant"), size: get("size"), color: get("color"), quantity, price, total, note: get("note"), source: get("source"), sheetStatus: get("status"), raw };
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
