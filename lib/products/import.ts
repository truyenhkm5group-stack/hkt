/**
 * ═══════════ NHẬP SẢN PHẨM HÀNG LOẠT TỪ TỆP (CSV / XLSX) — CHỈ MÁY CHỦ ═══════════
 *
 * Ba lượt, cùng MỘT bộ đọc + MỘT bộ kiểm (`analyze`) để "xem trước" và "nhập" không bao giờ nói hai điều khác nhau:
 *  1. `describeProductImport` — đọc tệp, trả tiêu đề + 20 dòng đầu + ghép cột gợi ý + danh sách field tuỳ biến.
 *  2. `checkProductImport`    — CHẠY THỬ: kiểm từng dòng theo ghép cột, KHÔNG ghi một dòng nào (kể cả nhật ký).
 *  3. `runProductImport`      — người bấm "Nhập": máy chủ đọc lại tệp, KIỂM LẠI toàn bộ (không tin kết quả client giữ),
 *     tệp phải đúng checksum của lần kiểm; chỉ dòng hợp lệ được tạo.
 *
 * HÀNG RÀO: `productCreateGate` (module Sản phẩm bật · tổ chức KHÔNG có nguồn đồng bộ sản phẩm · `products:write`) — tổ
 * chức nhà bật Pancake bị từ chối như `/products/new`. Tồn đầu > 0 cần thêm `inventory:write` (đúng quyền của
 * `createStockReceipt`). Ghi field tuỳ biến đi qua `saveCustomValues` — quyền của từng field do dịch vụ metadata ép.
 * Mọi truy vấn đi qua `getDb()` của tổ chức NGỮ CẢNH — không có đường nhập xuyên tổ chức.
 *
 * MỖI SẢN PHẨM tạo qua ĐÚNG `createProductCore` (một sản phẩm + một mẫu mã, SKU = mã sản phẩm = SKU mẫu mã) — cùng
 * kiểm trùng, cùng giao dịch, cùng nhật ký với form tạo tay. Không có đường ghi `products` thứ hai.
 *
 * TỒN ĐẦU (luật 10): tồn chỉ đổi qua phiếu kho — MỘT phiếu NHẬP HÀNG (`RECEIPT`) cho cả lượt qua `writeStockReceiptCore`.
 * Đơn giá theo đúng luật định giá của tổ chức (`receiptPricingModeFor`): giá báo MKT ⇒ máy chủ tự đọc (mã mới chưa có giá
 * báo ⇒ 0 = CHƯA BIẾT, nói ra bằng SKU); khai tay ⇒ cột Giá vốn của dòng, trống ⇒ 0 = CHƯA BIẾT. Không bịa giá.
 *
 * BẤM HAI LẦN: SKU đã có trong tổ chức (cùng tên) ⇒ dòng đó là "đã có", không tạo bản thứ hai và KHÔNG cộng tồn đầu lần
 * nữa. SKU đã có nhưng thuộc sản phẩm TÊN KHÁC ⇒ lỗi dòng (có thể là hai món khác nhau đụng mã, người phải quyết).
 */
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { isHomeOrg } from "@/lib/branding/copy";
import type { Actor } from "@/lib/constants/actor";
import { skuKey } from "@/lib/constants/manual-products";
import { objectDef } from "@/lib/constants/object-registry";
import { todayVN, vnStartOfDay } from "@/lib/format";
import { expandSheetRange } from "@/lib/integrations/viettelpost/statement";
import { writeStockReceiptCore } from "@/lib/inventory/receipt-create";
import { priceReceiptLines, receiptPricingModeFor } from "@/lib/inventory/receipt-pricing";
import { loadCustomDefs } from "@/lib/metadata/common";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { CustomFieldDef, FieldError } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";
import { canEditField, canViewField, saveCustomValues } from "@/lib/metadata/values";
import {
  autoSkuBase,
  autoSkuCandidate,
  guessImportMapping,
  IMPORT_TARGET_LABEL,
  importDestination,
  isImportableFieldType,
  isImportTarget,
  parseMoneyVnd,
  parseQuantity,
  PRODUCT_IMPORT_MAX_BYTES,
  PRODUCT_IMPORT_MAX_COLUMNS,
  PRODUCT_IMPORT_MAX_ROWS,
  PRODUCT_IMPORT_PREVIEW_ROWS,
  PRODUCT_NAME_MAX,
  PRODUCT_UNIT_MAX,
  productNameKey,
  skuShapeError,
  type ImportCheckResult,
  type ImportCoreTarget,
  type ImportCustomFieldOption,
  type ImportFileKind,
  type ImportFileSummary,
  type ImportRowCheck,
  type ImportRunResult,
  type ImportRunRow,
  type ImportTarget,
} from "@/lib/products/import-shared";
import { createProductCore, productCreateGate } from "@/lib/records/product-create";

export type ProductImportFile = { fileName: string; data: Uint8Array };

// ─────────────────────────── Đọc tệp ───────────────────────────

type SheetRow = { line: number; cells: string[] };
type ParsedFile = { kind: ImportFileKind; delimiter: "," | ";" | "\t" | null; headers: string[]; rows: SheetRow[]; checksum: string };

const DELIMITERS = [",", ";", "\t"] as const;

/** Dấu phân cách CSV: đếm trên dòng ĐẦU (ngoài nháy kép). Hoà ⇒ dấu phẩy. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const count: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (count[","] + count[";"] + count["\t"] > 0) break;
    } else if (!quoted && ch in count) count[ch] += 1;
  }
  let best: "," | ";" | "\t" = ",";
  for (const d of DELIMITERS) if (count[d] > count[best]) best = d;
  return best;
}

/** CSV theo RFC 4180 với dấu phân cách cho trước: ô có nháy kép, "" trong nháy, xuống dòng trong ô. Giữ số dòng bắt đầu của mỗi bản ghi. */
export function parseDelimited(text: string, delimiter: string): SheetRow[] {
  const rows: SheetRow[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const push = () => {
    row.push(cell);
    cell = "";
    rows.push({ line: start, cells: row });
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push();
      line += 1;
      start = line;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) push();
  return rows;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v);
}

function isZip(b: Uint8Array) {
  return b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function isOle(b: Uint8Array) {
  return b.length > 7 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

/** Đọc tệp thành dòng tiêu đề + dòng dữ liệu (bỏ dòng trống, giữ SỐ DÒNG thật để báo lỗi). Lỗi ⇒ câu tiếng Việt. */
export function readProductImportFile(file: ProductImportFile): ParsedFile | { error: string } {
  const data = file.data;
  if (!data.length) return { error: "Tệp trống." };
  if (data.length > PRODUCT_IMPORT_MAX_BYTES) return { error: `Tệp ${(data.length / 1024 / 1024).toFixed(1)} MB — tối đa 2 MB mỗi lượt. Chia tệp rồi nhập từng phần.` };
  const checksum = createHash("sha256").update(data).digest("hex");
  let kind: ImportFileKind;
  let delimiter: ParsedFile["delimiter"] = null;
  let all: SheetRow[];
  if (isZip(data) || isOle(data)) {
    kind = "XLSX";
    try {
      const wb = XLSX.read(Buffer.from(data), { type: "buffer", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) return { error: "Tệp Excel không có sheet nào." };
      // Tệp khai sai vùng dữ liệu thì thư viện chỉ đọc phần khai — luôn tính lại từ ô có thật (AGENTS mục 3.8).
      expandSheetRange(ws);
      const ref = typeof ws["!ref"] === "string" ? ws["!ref"] : null;
      if (!ref) return { error: "Sheet đầu tiên của tệp Excel trống." };
      const first = XLSX.utils.decode_range(ref).s.r;
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "", blankrows: true });
      all = matrix.map((r, i) => ({ line: first + i + 1, cells: (Array.isArray(r) ? r : []).map(cellText) }));
    } catch {
      return { error: "Không đọc được tệp Excel — lưu lại dạng .xlsx hoặc xuất CSV UTF-8 rồi thử lại." };
    }
  } else {
    kind = "CSV";
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return { error: "Tệp CSV không phải mã UTF-8 (dấu tiếng Việt sẽ hỏng). Trong Excel chọn Lưu thành → «CSV UTF-8», rồi tải lại." };
    }
    text = text.replace(/^\uFEFF/, "");
    delimiter = detectDelimiter(text);
    all = parseDelimited(text, delimiter);
  }
  const nonEmpty = all.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { error: "Tệp không có dòng nào." };
  const [head, ...rest] = nonEmpty;
  if (head.cells.length > PRODUCT_IMPORT_MAX_COLUMNS) return { error: `Tệp có ${head.cells.length} cột — tối đa ${PRODUCT_IMPORT_MAX_COLUMNS}.` };
  let width = head.cells.length;
  while (width > 0 && head.cells[width - 1].trim() === "") width -= 1;
  if (!width) return { error: "Dòng tiêu đề trống." };
  const headers = head.cells.slice(0, width).map((h, i) => h.trim() || `Cột ${i + 1}`);
  if (!rest.length) return { error: "Tệp chỉ có dòng tiêu đề, chưa có dòng sản phẩm nào." };
  if (rest.length > PRODUCT_IMPORT_MAX_ROWS) return { error: `Tệp có ${rest.length.toLocaleString("vi-VN")} dòng — tối đa ${PRODUCT_IMPORT_MAX_ROWS.toLocaleString("vi-VN")} dòng mỗi lượt. Chia tệp rồi nhập từng phần.` };
  const rows = rest.map((r) => ({ line: r.line, cells: Array.from({ length: width }, (_, i) => (r.cells[i] ?? "").trim()) }));
  return { kind, delimiter, headers, rows, checksum };
}

// ─────────────────────────── Field tuỳ biến ───────────────────────────

async function productCustomDefs(): Promise<CustomFieldDef[]> {
  return loadCustomDefs("product", true);
}

function customOptions(user: SessionUser, defs: CustomFieldDef[]): ImportCustomFieldOption[] {
  const obj = objectDef("product");
  if (!obj) return [];
  return defs.filter((d) => d.status === "ACTIVE" && isImportableFieldType(d.type) && canViewField(user, obj, d)).map((d) => ({ key: d.key, label: d.label, type: d.type, required: d.required }));
}

// ─────────────────────────── Lượt 1: đọc & gợi ý ───────────────────────────

export async function describeProductImport(user: SessionUser, file: ProductImportFile): Promise<({ ok: true } & ImportFileSummary) | MetaFailure> {
  const gate = await productCreateGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const parsed = readProductImportFile(file);
  if ("error" in parsed) return fail("INVALID", parsed.error, "file");
  const customFields = customOptions(user, await productCustomDefs());
  return {
    ok: true,
    fileName: file.fileName,
    checksum: parsed.checksum,
    kind: parsed.kind,
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    preview: parsed.rows.slice(0, PRODUCT_IMPORT_PREVIEW_ROWS).map((r) => r.cells),
    totalRows: parsed.rows.length,
    suggested: guessImportMapping(parsed.headers, customFields),
    customFields,
  };
}

// ─────────────────────────── Lượt 2 + 3: kiểm (dùng chung) ───────────────────────────

const optionsSchema = z.object({
  mapping: z.array(z.union([z.string().max(60), z.null()])).max(PRODUCT_IMPORT_MAX_COLUMNS, "Ghép cột quá nhiều cột"),
  defaultUnit: z.string().trim().max(PRODUCT_UNIT_MAX, `Đơn vị mặc định tối đa ${PRODUCT_UNIT_MAX} ký tự`).default(""),
});
export type ProductImportOptions = z.input<typeof optionsSchema>;

type Existing = { productId: string; name: string };

/** Mọi SKU / mã sản phẩm đang có trong tổ chức (khoá không phân biệt hoa thường — cùng luật trùng của `product-create.ts`). */
async function existingSkus(): Promise<Map<string, Existing>> {
  const db = await getDb();
  const p = schema.products;
  const pv = schema.productVariants;
  const out = new Map<string, Existing>();
  const vars = await db
    .select({ key: sql<string>`lower(btrim(${pv.sku}))`, productId: pv.productId, name: p.name })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .where(sql`${pv.sku} is not null and btrim(${pv.sku}) <> ''`);
  for (const v of vars) out.set(v.key, { productId: v.productId, name: v.name ?? "" });
  const prods = await db
    .select({ key: sql<string>`lower(btrim(${p.customId}))`, productId: p.id, name: p.name })
    .from(p)
    .where(sql`${p.customId} is not null and btrim(${p.customId}) <> ''`);
  // Mã sản phẩm thắng SKU mẫu mã khi cùng khoá: "đã có" trỏ về đúng sản phẩm mang mã đó.
  for (const x of prods) out.set(x.key, { productId: x.productId, name: x.name ?? "" });
  return out;
}

type PlannedRow = ImportRowCheck;
type Analysis = { parsed: ParsedFile; check: ImportCheckResult; rows: PlannedRow[]; mapping: (ImportTarget | null)[]; defaultUnit: string };

async function analyze(user: SessionUser, file: ProductImportFile, rawOptions: unknown): Promise<Analysis | MetaFailure> {
  const gate = await productCreateGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const opts = optionsSchema.safeParse(rawOptions);
  if (!opts.success) return fail("INVALID", opts.error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message })));
  const parsed = readProductImportFile(file);
  if ("error" in parsed) return fail("INVALID", parsed.error, "file");
  const obj = objectDef("product");
  if (!obj) return fail("NOT_SUPPORTED", "Sản phẩm không có trong sổ đối tượng.");

  const defs = await productCustomDefs();
  const activeDefs = new Map(defs.filter((d) => d.status === "ACTIVE").map((d) => [d.key, d]));
  const mappingErrors: string[] = [];
  const warnings: string[] = [];
  const header = (i: number) => parsed.headers[i] ?? `Cột ${i + 1}`;

  // Ghép cột: chuẩn hoá, bỏ ô lạ, bắt hai cột cùng một nơi.
  const mapping: (ImportTarget | null)[] = parsed.headers.map((_, i) => {
    const v = opts.data.mapping[i];
    if (v === null || v === undefined || v === "") return null;
    if (!isImportTarget(v)) {
      warnings.push(`Cột «${header(i)}»: ô đích "${v}" không hợp lệ — cột bị bỏ qua.`);
      return null;
    }
    return v;
  });
  const destOwner = new Map<string, number>();
  /** Cột → khoá field tuỳ biến sẽ nhận giá trị (đã kiểm tồn tại / kiểu / quyền). */
  const customOfCol = new Map<number, string>();
  mapping.forEach((t, i) => {
    if (!t) return;
    const dest = importDestination(t);
    const prev = destOwner.get(dest);
    if (prev !== undefined) {
      mappingErrors.push(`Hai cột «${header(prev)}» và «${header(i)}» cùng ghép vào «${t.startsWith("custom:") ? t.slice(7) : IMPORT_TARGET_LABEL[t as ImportCoreTarget]}» — mỗi ô đích chỉ một cột.`);
      return;
    }
    destOwner.set(dest, i);
    const customKey = t.startsWith("custom:") ? t.slice(7) : t === "package_size" || t === "category" || t === "selling_unit" ? t : null;
    if (!customKey) return;
    const def = activeDefs.get(customKey);
    if (!def) {
      // `selling_unit` luôn có nơi lưu (ô đơn vị tính); hai ô còn lại chỉ có nơi lưu khi tổ chức đã khai field.
      if (t !== "selling_unit") warnings.push(`Cột «${header(i)}» ghép vào «${customKey}» nhưng tổ chức chưa khai field tuỳ biến «${customKey}» cho Sản phẩm (hoặc field đã lưu trữ) — giá trị cột này KHÔNG được lưu. Khai field rồi kiểm lại nếu cần giữ.`);
      return;
    }
    if (!isImportableFieldType(def.type)) {
      warnings.push(`Cột «${header(i)}»: field «${def.label}» là kiểu tham chiếu, không nhập được từ tệp — cột bị bỏ qua.`);
      return;
    }
    if (!canEditField(user, obj, def)) {
      mappingErrors.push(`Bạn không có quyền ghi field «${def.label}» của Sản phẩm — bỏ ghép cột «${header(i)}» hoặc nhờ người có quyền nhập.`);
      return;
    }
    customOfCol.set(i, def.key);
  });
  if (!mapping.includes("name")) mappingErrors.push("Chưa ghép cột nào vào «Tên sản phẩm» — ô này bắt buộc.");
  const col = (t: ImportTarget) => {
    const i = mapping.indexOf(t);
    return i >= 0 && destOwner.get(importDestination(t)) === i ? i : -1;
  };
  const cName = col("name");
  const cSku = col("sku");
  const cPrice = col("price");
  const cCost = col("cost");
  const cUnit = col("selling_unit");
  const cStock = col("initial_stock");
  const canStock = can(user, "inventory:write");
  const defaultUnit = opts.data.defaultUnit;

  // Field bắt buộc mà không cột nào ghép tới: dòng CÓ field tuỳ biến sẽ bị dịch vụ metadata từ chối — nói trước.
  const editableRequired = [...activeDefs.values()].filter((d) => d.required && canEditField(user, obj, d));
  const mappedKeys = new Set(customOfCol.values());
  if (mappedKeys.size) {
    for (const d of editableRequired) if (!mappedKeys.has(d.key)) warnings.push(`Field «${d.label}» là bắt buộc mà chưa ghép cột nào — dòng có dữ liệu field tuỳ biến sẽ báo lỗi.`);
  }
  // Cùng luật "bắt buộc chỉ áp cho field người này sửa được" như `saveCustomValues`.
  const effectiveDefs = defs.map((d) => (d.required && d.status === "ACTIVE" && !canEditField(user, obj, d) ? { ...d, required: false } : d));

  const existing = await existingSkus();
  const cell = (r: SheetRow, i: number) => (i >= 0 ? (r.cells[i] ?? "").trim() : "");

  // Lượt 1: SKU khai tường minh giữ chỗ trước — SKU tự sinh không được giành mã của một dòng khai tay nằm dưới nó.
  const explicitOwner = new Map<string, number>();
  for (const r of parsed.rows) {
    const s = cell(r, cSku);
    if (s && !explicitOwner.has(skuKey(s))) explicitOwner.set(skuKey(s), r.line);
  }
  const usedInFile = new Map<string, number>();
  const nameSeen = new Map<string, number>();
  const rows: PlannedRow[] = [];

  for (const r of parsed.rows) {
    const errors: FieldError[] = [];
    const rowWarnings: string[] = [];
    const err = (t: ImportTarget, message: string) => errors.push({ field: t, message });

    const name = cell(r, cName).replace(/\s+/g, " ");
    if (!name) err("name", "Thiếu tên sản phẩm.");
    else if (name.length > PRODUCT_NAME_MAX) err("name", `Tên dài quá ${PRODUCT_NAME_MAX} ký tự.`);

    const price = parseMoneyVnd(cell(r, cPrice), "Giá bán");
    if (!price.ok) err("price", price.message);
    const cost = parseMoneyVnd(cell(r, cCost), "Giá vốn");
    if (!cost.ok) err("cost", cost.message);
    const stock = parseQuantity(cell(r, cStock));
    if (!stock.ok) err("initial_stock", stock.message);
    else if (stock.value && !canStock) err("initial_stock", "Tồn đầu cần quyền nhập kho (inventory:write) — bỏ ghép cột Tồn đầu hoặc nhờ người có quyền nhập.");

    const unitCell = cell(r, cUnit);
    const unit = unitCell || defaultUnit;
    if (!unit) err("selling_unit", "Thiếu đơn vị tính — ghép cột Đơn vị tính hoặc điền đơn vị mặc định.");
    else if (unit.length > PRODUCT_UNIT_MAX) err("selling_unit", `Đơn vị tính tối đa ${PRODUCT_UNIT_MAX} ký tự.`);

    // Field tuỳ biến: ép kiểu bằng CHÍNH bộ kiểm của dịch vụ metadata (không luật thứ hai).
    const customValues: Record<string, string> = {};
    for (const [i, key] of customOfCol) {
      const v = cell(r, i);
      if (v) customValues[key] = v;
    }
    if (Object.keys(customValues).length) {
      const { errors: cerr } = validateCustomValues(effectiveDefs, customValues, null);
      for (const e of cerr) errors.push({ field: `custom:${e.field}`, message: e.message });
    }

    // SKU.
    let sku = cell(r, cSku);
    let skuGenerated = false;
    let existingProductId: string | null = null;
    if (sku) {
      const shape = skuShapeError(sku);
      if (shape) err("sku", shape);
      const k = skuKey(sku);
      const owner = explicitOwner.get(k);
      const prior = usedInFile.get(k);
      if (owner !== undefined && owner !== r.line) err("sku", `SKU "${sku}" lặp lại trong tệp (đã có ở dòng ${owner}).`);
      else if (prior !== undefined) err("sku", `SKU "${sku}" trùng SKU của dòng ${prior} trong tệp.`);
      else {
        usedInFile.set(k, r.line);
        const hit = existing.get(k);
        if (hit) {
          if (name && productNameKey(hit.name) === productNameKey(name)) existingProductId = hit.productId;
          else err("sku", `SKU "${sku}" đã có trong tổ chức cho sản phẩm «${hit.name || hit.productId}» — SKU phải duy nhất.`);
        }
      }
    } else if (name) {
      // Tự sinh: gốc từ tên, rồi "-2", "-3"… Ứng viên đang là mã của CHÍNH món này (cùng tên) ⇒ "đã có".
      skuGenerated = true;
      const base = autoSkuBase(name);
      for (let n = 1; n < 10_000; n++) {
        const cand = autoSkuCandidate(base, n);
        const k = skuKey(cand);
        if (explicitOwner.has(k) || usedInFile.has(k)) continue;
        const hit = existing.get(k);
        if (hit && productNameKey(hit.name) !== productNameKey(name)) continue;
        sku = cand;
        usedInFile.set(k, r.line);
        if (hit) existingProductId = hit.productId;
        break;
      }
      if (!sku) err("sku", "Không sinh được SKU duy nhất — điền SKU cho dòng này.");
    }

    if (name) {
      const nk = productNameKey(name);
      const before = nameSeen.get(nk);
      if (before !== undefined) rowWarnings.push(`Tên trùng dòng ${before} — sẽ là hai sản phẩm khác mã.`);
      else nameSeen.set(nk, r.line);
    }

    const status = errors.length ? "ERROR" : existingProductId ? "EXISTS" : "READY";
    if (status === "EXISTS") rowWarnings.push("Sản phẩm đã có trong tổ chức (cùng SKU, cùng tên) — bỏ qua, không tạo bản thứ hai, không cộng tồn đầu.");
    rows.push({
      line: r.line,
      status,
      name,
      sku,
      skuGenerated,
      price: price.ok ? price.value : null,
      cost: cost.ok ? cost.value : null,
      unit,
      unitFromDefault: !unitCell && !!unit,
      initialStock: stock.ok ? stock.value : null,
      custom: customValues,
      errors,
      warnings: rowWarnings,
      existingProductId,
    });
  }

  if (mappingErrors.length) for (const row of rows) if (row.status !== "ERROR") row.status = "ERROR";
  const db = await getDb();
  const pricing = await receiptPricingModeFor(db, { isHome: isHomeOrg(user) });
  const check: ImportCheckResult = {
    ok: true,
    fileName: file.fileName,
    checksum: parsed.checksum,
    totalRows: parsed.rows.length,
    counts: { ready: rows.filter((x) => x.status === "READY").length, exists: rows.filter((x) => x.status === "EXISTS").length, error: rows.filter((x) => x.status === "ERROR").length },
    rows,
    mappingErrors,
    warnings,
    receiptPricing: pricing.mode,
  };
  return { parsed, check, rows, mapping, defaultUnit };
}

/** CHẠY THỬ — không ghi một dòng nào (kể cả nhật ký). */
export async function checkProductImport(user: SessionUser, file: ProductImportFile, options: unknown): Promise<ImportCheckResult | MetaFailure> {
  const a = await analyze(user, file, options);
  return "check" in a ? a.check : a;
}

// ─────────────────────────── Lượt 3: nhập ───────────────────────────

/** Lỗi của `createProductCore` (khoá form) ⇒ ô đích của tệp. */
function importFieldOf(field: string): string {
  if (field === "code" || field.endsWith(".sku")) return "sku";
  if (field === "unit") return "selling_unit";
  if (field === "retailPrice" || field.endsWith(".retailPrice")) return "price";
  if (field === "cost" || field.endsWith(".cost")) return "cost";
  return field;
}

export async function runProductImport(user: SessionUser, file: ProductImportFile, options: unknown, expectedChecksum: unknown): Promise<ImportRunResult | MetaFailure> {
  const a = await analyze(user, file, options);
  if (!("check" in a)) return a;
  if (typeof expectedChecksum !== "string" || expectedChecksum !== a.parsed.checksum) {
    return fail("CONFLICT", "Tệp gửi lên khác tệp đã kiểm (checksum không khớp) — bấm «Kiểm tra» lại rồi mới nhập.", "file");
  }
  if (a.check.mappingErrors.length) return fail("INVALID", a.check.mappingErrors.map((message) => ({ field: "mapping", message })));

  const out: ImportRunRow[] = [];
  const createdStock: { variantId: string; sku: string; quantity: number; cost: number | null }[] = [];
  const createdIds: string[] = [];
  const db = await getDb();
  const p = schema.products;

  for (const row of a.rows) {
    const base = { line: row.line, name: row.name, sku: row.sku, skuGenerated: row.skuGenerated, initialStock: row.initialStock };
    if (row.status === "ERROR") {
      out.push({ ...base, status: "ERROR", productId: null, errors: row.errors, warnings: row.warnings });
      continue;
    }
    if (row.status === "EXISTS") {
      out.push({ ...base, status: "EXISTS", productId: row.existingProductId, errors: [], warnings: row.warnings });
      continue;
    }
    const r = await createProductCore(user, {
      name: row.name,
      code: row.sku,
      unit: row.unit,
      retailPrice: row.price,
      cost: row.cost,
      variants: [{ sku: row.sku, retailPrice: null, cost: null, selling: true }],
    });
    if (!r.ok) {
      // Hai lượt bấm chen nhau: lượt kia vừa tạo đúng mã này ⇒ "đã có", không phải lỗi.
      const [hit] = await db.select({ id: p.id, name: p.name }).from(p).where(sql`lower(btrim(${p.customId})) = ${skuKey(row.sku)}`).limit(1);
      if (hit && productNameKey(hit.name ?? "") === productNameKey(row.name)) {
        out.push({ ...base, status: "EXISTS", productId: hit.id, errors: [], warnings: ["Sản phẩm vừa được tạo bởi một lượt nhập khác — bỏ qua, không tạo bản thứ hai."] });
      } else {
        out.push({ ...base, status: "ERROR", productId: null, errors: r.errors.map((e) => ({ field: importFieldOf(e.field), message: e.message })), warnings: row.warnings });
      }
      continue;
    }
    createdIds.push(r.id);
    const warnings = [...row.warnings];
    if (Object.keys(row.custom).length) {
      const saved = await saveCustomValues("product", r.id, row.custom, user);
      if (!saved.ok) warnings.push(`Sản phẩm đã tạo nhưng field tuỳ biến CHƯA ghi được: ${saved.errors.map((e) => e.message).join(" · ")} — sửa ở trang sản phẩm.`);
    }
    const variantId = r.variantIds?.[0] ?? null;
    if (row.initialStock && row.initialStock > 0) {
      if (variantId) createdStock.push({ variantId, sku: row.sku, quantity: row.initialStock, cost: row.cost });
      else warnings.push("Không tìm thấy mẫu mã vừa tạo — tồn đầu chưa ghi, lập phiếu Nhập hàng tay.");
    }
    out.push({ ...base, status: "CREATED", productId: r.id, errors: [], warnings });
  }

  // Tồn đầu: MỘT phiếu NHẬP HÀNG cho cả lượt, chỉ dòng VỪA TẠO (dòng "đã có" không cộng lần nữa).
  let receiptId: string | null = null;
  let receiptError: string | null = null;
  let missingPrice: string[] = [];
  if (createdStock.length) {
    try {
      if (!can(user, "inventory:write")) throw new Error("Thiếu quyền nhập kho (inventory:write).");
      const actor: Actor = { id: user.id, label: user.name || user.email };
      const receivedAt = vnStartOfDay(todayVN());
      const pricing = await receiptPricingModeFor(db, { isHome: isHomeOrg(user) });
      let unitCost: (x: (typeof createdStock)[number]) => number;
      if (pricing.mode === "MKT_QUOTE") {
        const priced = await priceReceiptLines(db, createdStock.map((x) => x.variantId), receivedAt);
        unitCost = (x) => priced.price.get(x.variantId) ?? 0;
        missingPrice = priced.missing;
      } else {
        unitCost = (x) => x.cost ?? 0;
        missingPrice = [...new Set(createdStock.filter((x) => !x.cost).map((x) => x.sku))].sort();
      }
      const lines = createdStock.map((x) => ({ variantId: x.variantId, quantity: x.quantity, unitCost: unitCost(x), shipmentId: null }));
      const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);
      const totalCost = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
      const note = `Tồn đầu nhập cùng lượt nhập sản phẩm từ tệp «${file.fileName}» (SHA-256 ${a.parsed.checksum.slice(0, 12)}…).`;
      const reference = `Tồn đầu · ${file.fileName}`.slice(0, 120);
      const ghi = await writeStockReceiptCore(db, {
        kind: "RECEIPT",
        receipt: { receivedAt, reference, supplier: "", note, totalQuantity, totalCost, createdBy: actor.label },
        lines,
        note,
        actor,
        approver: { id: user.id, email: user.email },
        gate: null,
      });
      if ("error" in ghi) receiptError = ghi.error;
      else {
        receiptId = ghi.receiptId;
        await audit({
          userId: user.id,
          userEmail: user.email,
          action: "STOCK_RECEIPT_CREATE",
          entity: "STOCK_RECEIPT",
          entityId: receiptId,
          detail: { kind: "RECEIPT", reference, note, items: lines, totalQuantity, totalCost, priceSource: pricing.mode === "MKT_QUOTE" ? "MARKETER_PRICE" : "MANUAL_ENTRY", priceModeSource: pricing.source, missingPrice, source: "PRODUCT_IMPORT", checksum: a.parsed.checksum },
        });
      }
    } catch (e) {
      receiptError = e instanceof Error ? e.message : String(e);
    }
  }

  const counts = { created: out.filter((x) => x.status === "CREATED").length, exists: out.filter((x) => x.status === "EXISTS").length, error: out.filter((x) => x.status === "ERROR").length };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PRODUCT_IMPORT",
    entity: "PRODUCT_IMPORT",
    entityId: a.parsed.checksum,
    before: null,
    after: { counts, receiptId },
    reason: "Nhập sản phẩm hàng loạt từ tệp",
    detail: {
      fileName: file.fileName,
      checksum: a.parsed.checksum,
      bytes: file.data.length,
      kind: a.parsed.kind,
      totalRows: a.parsed.rows.length,
      counts,
      mapping: a.mapping.map((t, i) => ({ column: a.parsed.headers[i], target: t })),
      defaultUnit: a.defaultUnit || null,
      createdProductIds: createdIds,
      receiptId,
      receiptError,
      missingPrice,
    },
  });

  return { ok: true, fileName: file.fileName, checksum: a.parsed.checksum, counts, rows: out, receiptId, receiptError, missingPrice, mappingErrors: [] };
}
