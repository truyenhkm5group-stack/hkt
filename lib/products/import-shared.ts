/**
 * ═══════════ NHẬP SẢN PHẨM HÀNG LOẠT TỪ TỆP (CSV / XLSX) — PHẦN THUẦN, CLIENT-SAFE ═══════════
 *
 * Tổ chức không đồng bộ sản phẩm (không bật Pancake) trước đây chỉ tạo được TỪNG mã ở `/products/new`. Luồng này là
 * Tải tệp → Xem trước → Ghép cột → Kiểm → Nhập → Kết quả. Tệp này chỉ khai phần THUẦN (không đọc / ghi CSDL): ô đích,
 * đoán ghép cột theo tên cột, đọc số tiền / số lượng, sinh SKU từ tên, tệp mẫu. Phần máy chủ ở `lib/products/import.ts`.
 *
 * LUẬT KHÔNG ĐOÁN (AGENTS mục 42, 8.5):
 *  · Giá chỉ nhận dạng RÕ RÀNG — "120000", "120.000", "120,000", "120 000", "120k", có hoặc không "đ" / "₫" / "VND".
 *    "120,5", "1.2tr", "một trăm" ⇒ LỖI DÒNG, không đoán. Ô trống = CHƯA KHAI (`null`), không phải 0 đ.
 *  · SKU trống ⇒ TỰ SINH từ tên (bỏ dấu, IN HOA, gạch nối) và màn hình ghi rõ "tự sinh". Sinh là HÀM TẤT ĐỊNH của tên +
 *    thứ tự dòng, nên nhập lại cùng tệp ra đúng các mã cũ ⇒ dòng đó là "đã có", không đẻ bản thứ hai.
 */
import { SKU_MAX, SKU_PATTERN } from "@/lib/constants/manual-products";
import { FIELD_KEY_PATTERN, type FieldError, type FieldType } from "@/lib/metadata/types";

export const PRODUCT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const PRODUCT_IMPORT_MAX_ROWS = 2000;
export const PRODUCT_IMPORT_MAX_COLUMNS = 100;
export const PRODUCT_IMPORT_PREVIEW_ROWS = 20;
/** Trần tiền — trùng trần của form tạo tay (`lib/validation/products.ts`). */
export const PRODUCT_IMPORT_MONEY_MAX = 2_000_000_000;
export const PRODUCT_IMPORT_QTY_MAX = 1_000_000;
/** Phần gốc của SKU tự sinh — chừa chỗ cho hậu tố "-2", "-3"… mà vẫn dưới `SKU_MAX`. */
export const AUTO_SKU_BASE_MAX = 40;
export const PRODUCT_NAME_MAX = 200;
export const PRODUCT_UNIT_MAX = 30;

/**
 * Ô đích LÕI. `package_size` / `category` không có cột lõi: chúng ghi vào FIELD TUỲ BIẾN cùng khoá của đối tượng
 * `product` NẾU tổ chức đã khai field đó; chưa khai ⇒ cảnh báo, giá trị không được lưu. `selling_unit` ghi vào ô đơn vị
 * tính của sản phẩm VÀ vào field tuỳ biến `selling_unit` nếu có.
 */
export const IMPORT_CORE_TARGETS = ["name", "sku", "price", "cost", "selling_unit", "initial_stock", "package_size", "category"] as const;
export type ImportCoreTarget = (typeof IMPORT_CORE_TARGETS)[number];
export type ImportTarget = ImportCoreTarget | `custom:${string}`;
/** Ô đích lõi đồng thời là khoá field tuỳ biến cùng tên (nếu tổ chức đã khai). */
export const IMPORT_SEMANTIC_CUSTOM_KEYS: readonly ImportCoreTarget[] = ["package_size", "selling_unit", "category"];

export const IMPORT_TARGET_LABEL: Readonly<Record<ImportCoreTarget, string>> = {
  name: "Tên sản phẩm *",
  sku: "Mã SKU (trống ⇒ tự sinh)",
  price: "Giá bán (đ)",
  cost: "Giá vốn (đ)",
  selling_unit: "Đơn vị tính",
  initial_stock: "Tồn đầu (số lượng)",
  package_size: "Quy cách (field package_size)",
  category: "Danh mục (field category)",
};

/** Kiểu field tuỳ biến nhận được giá trị từ một ô chữ của tệp. Tham chiếu (người, quan hệ, tệp) cần id có thật ⇒ không nhận. */
export const IMPORTABLE_FIELD_TYPES: readonly FieldType[] = ["text", "textarea", "number", "currency", "boolean", "date", "datetime", "select", "multi_select", "status", "email", "phone", "url"];

export function isImportableFieldType(t: FieldType): boolean {
  return IMPORTABLE_FIELD_TYPES.includes(t);
}

export function isImportTarget(v: unknown): v is ImportTarget {
  if (typeof v !== "string") return false;
  if ((IMPORT_CORE_TARGETS as readonly string[]).includes(v)) return true;
  return v.startsWith("custom:") && FIELD_KEY_PATTERN.test(v.slice("custom:".length));
}

/**
 * Nơi lưu THẬT của một ô đích — để bắt hai cột cùng đổ vào một chỗ. `package_size` và `custom:package_size` là CÙNG
 * một nơi. `selling_unit` lõi luôn là ô đơn vị (`core:unit`), field tuỳ biến cùng khoá đi theo nó.
 */
export function importDestination(t: ImportTarget): string {
  if (t.startsWith("custom:")) return t;
  if (t === "package_size" || t === "category") return `custom:${t}`;
  return `core:${t}`;
}

export type ImportCustomFieldOption = { key: string; label: string; type: FieldType; required: boolean };

// ─────────────────────────── Chữ ───────────────────────────

/** Bỏ dấu tiếng Việt: "Đồng" ⇒ "Dong". */
export function stripVietnamese(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** Khoá so tên cột: chữ thường, bỏ dấu, ký tự khác chữ/số ⇒ một khoảng trắng. */
export function normalizeHeader(h: string): string {
  return stripVietnamese(h)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Khoá so tên sản phẩm: bỏ khoảng trắng thừa, không phân biệt hoa thường (GIỮ dấu — "Chả" khác "Cha"). */
export function productNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const HEADER_SYNONYMS: Readonly<Record<ImportCoreTarget, readonly string[]>> = {
  name: ["ten san pham", "ten", "name", "ten hang", "ten mat hang", "san pham", "product", "product name"],
  sku: ["sku", "ma", "ma sp", "ma san pham", "ma hang", "code", "product code", "ma sku"],
  price: ["gia", "gia ban", "price", "don gia", "gia le", "gia ban le", "retail price"],
  cost: ["gia von", "gia nhap", "cost", "gia goc"],
  selling_unit: ["don vi", "don vi tinh", "dvt", "selling unit", "unit", "don vi ban"],
  initial_stock: ["ton dau", "ton dau ky", "initial stock", "so luong", "sl", "ton", "ton kho", "qty", "quantity"],
  package_size: ["quy cach", "dong goi", "quy cach dong goi", "package size", "khoi luong", "trong luong", "dung tich"],
  category: ["danh muc", "category", "loai", "loai hang", "nhom", "nhom hang"],
};

/** Đoán ô đích của MỘT tên cột: từ điển lõi trước, rồi khoá / nhãn field tuỳ biến. Không khớp ⇒ `null` (bỏ qua). */
export function guessImportTarget(header: string, customFields: readonly Pick<ImportCustomFieldOption, "key" | "label">[] = []): ImportTarget | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  for (const t of IMPORT_CORE_TARGETS) if (HEADER_SYNONYMS[t].includes(h)) return t;
  for (const f of customFields) {
    if (normalizeHeader(f.key) === h || normalizeHeader(f.label) === h) {
      return (IMPORT_SEMANTIC_CUSTOM_KEYS as readonly string[]).includes(f.key) ? (f.key as ImportCoreTarget) : `custom:${f.key}`;
    }
  }
  return null;
}

/** Ghép cột gợi ý cho cả dòng tiêu đề. Hai cột cùng đoán ra một nơi ⇒ chỉ cột ĐẦU giữ, cột sau bỏ trống cho người chọn. */
export function guessImportMapping(headers: readonly string[], customFields: readonly Pick<ImportCustomFieldOption, "key" | "label">[] = []): (ImportTarget | null)[] {
  const taken = new Set<string>();
  return headers.map((h) => {
    const t = guessImportTarget(h, customFields);
    if (!t) return null;
    const d = importDestination(t);
    if (taken.has(d)) return null;
    taken.add(d);
    return t;
  });
}

// ─────────────────────────── Số ───────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const GROUPED = [/^\d{1,3}(?:\.\d{3})+$/, /^\d{1,3}(?:,\d{3})+$/, /^\d{1,3}(?: \d{3})+$/];

function parseGroupedInt(t: string): number | null {
  if (/^\d+$/.test(t)) return Number(t);
  if (GROUPED.some((re) => re.test(t))) return Number(t.replace(/[., ]/g, ""));
  return null;
}

/**
 * Số tiền VND nguyên ≥ 0. Trống ⇒ `null` (chưa khai). Chỉ nhận dạng rõ ràng; mọi thứ khác ⇒ lỗi kèm câu nói cách ghi đúng.
 */
export function parseMoneyVnd(raw: string, label = "Giá"): Parsed<number | null> {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (s.startsWith("-")) return { ok: false, message: `${label} "${s}" âm — tiền không được âm.` };
  let t = s.replace(/\s*(?:đ|₫|vnđ|vnd|đồng|dong)$/i, "").trim();
  let mult = 1;
  if (/^\d+\s*k$/i.test(t)) {
    mult = 1000;
    t = t.replace(/\s*k$/i, "");
  }
  const n = parseGroupedInt(t);
  if (n === null) return { ok: false, message: `${label} "${s}" không đọc được — ghi số nguyên đồng, vd 120000 · 120.000 · 120,000 · 120k.` };
  const v = n * mult;
  if (!Number.isSafeInteger(v) || v > PRODUCT_IMPORT_MONEY_MAX) return { ok: false, message: `${label} "${s}" quá lớn.` };
  return { ok: true, value: v };
}

/** Số lượng nguyên ≥ 0. Trống ⇒ `null`. */
export function parseQuantity(raw: string, label = "Tồn đầu"): Parsed<number | null> {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (s.startsWith("-")) return { ok: false, message: `${label} "${s}" âm — tồn đầu chỉ ghi số dương (giảm tồn dùng phiếu Điều chỉnh kiểm kê).` };
  const n = parseGroupedInt(s);
  if (n === null) return { ok: false, message: `${label} "${s}" không phải số nguyên.` };
  if (n > PRODUCT_IMPORT_QTY_MAX) return { ok: false, message: `${label} "${s}" quá lớn (tối đa ${PRODUCT_IMPORT_QTY_MAX.toLocaleString("vi-VN")}).` };
  return { ok: true, value: n };
}

// ─────────────────────────── SKU ───────────────────────────

/** Phần gốc SKU tự sinh từ tên: bỏ dấu, IN HOA, mọi ký tự khác chữ/số ⇒ "-", cắt ≤ `AUTO_SKU_BASE_MAX`. Tên không còn chữ nào ⇒ "SP". */
export function autoSkuBase(name: string): string {
  const slug = stripVietnamese(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, AUTO_SKU_BASE_MAX).replace(/-+$/g, "");
  return cut || "SP";
}

/** Ứng viên thứ `n` (1 = gốc, 2 ⇒ "GOC-2"…). */
export function autoSkuCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

export function skuShapeError(sku: string): string | null {
  if (sku.length > SKU_MAX) return `Mã SKU "${sku}" dài quá ${SKU_MAX} ký tự.`;
  if (!SKU_PATTERN.test(sku)) return `Mã SKU "${sku}" chỉ gồm chữ/số Latin và . _ - / (không dấu cách, không dấu tiếng Việt).`;
  return null;
}

// ─────────────────────────── Kết quả ───────────────────────────

export type ImportFileKind = "CSV" | "XLSX";

export type ImportFileSummary = {
  fileName: string;
  checksum: string;
  kind: ImportFileKind;
  /** Dấu phân cách đã nhận ra (CSV); `null` với XLSX. */
  delimiter: "," | ";" | "\t" | null;
  headers: string[];
  preview: string[][];
  totalRows: number;
  suggested: (ImportTarget | null)[];
  customFields: ImportCustomFieldOption[];
};

export type ImportRowStatus = "READY" | "EXISTS" | "ERROR";

export type ImportRowCheck = {
  /** Số dòng trong tệp (dòng tiêu đề là dòng đầu). */
  line: number;
  status: ImportRowStatus;
  name: string;
  sku: string;
  skuGenerated: boolean;
  price: number | null;
  cost: number | null;
  unit: string;
  unitFromDefault: boolean;
  initialStock: number | null;
  /** Giá trị field tuỳ biến SẼ ghi (theo khoá field). */
  custom: Record<string, string>;
  /** Lỗi theo ô: `field` = ô đích (`name`, `sku`, `price`…, hoặc `custom:<khoá>`). */
  errors: FieldError[];
  warnings: string[];
  /** Dòng "đã có": sản phẩm đang mang SKU này trong tổ chức. */
  existingProductId: string | null;
};

export type ImportCheckResult = {
  ok: true;
  fileName: string;
  checksum: string;
  totalRows: number;
  counts: { ready: number; exists: number; error: number };
  rows: ImportRowCheck[];
  /** Lỗi ghép cột — có lỗi thì KHÔNG dòng nào nhập được. */
  mappingErrors: string[];
  warnings: string[];
  /** Tồn đầu của lượt này đi vào phiếu NHẬP HÀNG theo cách định giá nào. */
  receiptPricing: "MKT_QUOTE" | "MANUAL";
};

export type ImportRunStatus = "CREATED" | "EXISTS" | "ERROR";

export type ImportRunRow = {
  line: number;
  name: string;
  sku: string;
  skuGenerated: boolean;
  status: ImportRunStatus;
  productId: string | null;
  initialStock: number | null;
  errors: FieldError[];
  warnings: string[];
};

export type ImportRunResult = {
  ok: true;
  fileName: string;
  checksum: string;
  counts: { created: number; exists: number; error: number };
  rows: ImportRunRow[];
  receiptId: string | null;
  /** Phiếu tồn đầu không ghi được — sản phẩm VẪN đã tạo, tồn của chúng còn "Chưa có phiếu nhập". */
  receiptError: string | null;
  /** SKU trên phiếu tồn đầu chưa có đơn giá (lưu 0 = CHƯA BIẾT giá). */
  missingPrice: string[];
  mappingErrors: string[];
};

// ─────────────────────────── Tệp mẫu ───────────────────────────

/** Tệp mẫu CSV (UTF-8 có BOM để Excel mở đúng dấu). Dựng phía trình duyệt. */
export function productImportTemplateCsv(): string {
  const rows = [
    ["Tên sản phẩm", "SKU", "Giá bán", "Giá vốn", "Đơn vị tính", "Quy cách", "Danh mục", "Tồn đầu"],
    ["Nước mắm cốt cá cơm", "", "150000", "90000", "chai", "1 lít", "Gia vị", "24"],
    ["Chả cá thu", "CHA-CA-THU-1KG", "280.000", "", "gói", "1kg", "Chả", ""],
  ];
  const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return `\uFEFF${rows.map((r) => r.map(esc).join(",")).join("\r\n")}\r\n`;
}
