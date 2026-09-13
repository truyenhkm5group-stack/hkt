import * as XLSX from "xlsx";
import { expandSheetRange } from "@/lib/integrations/viettelpost/statement";
import {
  HMT_SHEETS,
  HMT_SHEET_BY_NAME,
  HMT_SHEET_ROLES,
  type HmtInheritance,
  type HmtSheetRole,
} from "@/lib/constants/hmt-returns";
import { foldTracking, parseProductText } from "@/lib/returns/product-text";

/**
 * ═══════════ ĐỌC BẢNG TÍNH HÀNG HOÀN — VÀ ĐẾM LẠI MỌI THỨ ĐÃ ĐỌC ═══════════
 *
 * Bảng tính viết tay không có lược đồ. Thứ duy nhất chống lại việc đọc nhầm cột là ĐẾM: đọc xong
 * phải in ra bao nhiêu dòng có dữ liệu, bao nhiêu mã vận đơn khác nhau, bao nhiêu ô trống, bao
 * nhiêu dòng trùng. Con số nào lệch với thứ người mở tệp nhìn thấy thì phép đọc sai, và phải sửa
 * TRƯỚC khi ghi một dòng nào vào ERP.
 *
 * ─── Ô MÃ VẬN ĐƠN TRỐNG: KHÔNG BAO GIỜ ĐIỀN XUỐNG MÙ ───
 *
 * Bảng tính có dòng sản phẩm mà ô mã vận đơn trống. Cách "hiển nhiên" — điền xuống từ dòng trên —
 * là cách hỏng tệ nhất: nếu người ghi sổ bỏ trống chỉ vì lười, mọi món phía dưới sẽ được gán cho
 * một kiện không chứa chúng, và kiện đó được ghi nhận "đã về" bằng bằng chứng của kiện khác.
 *
 * Nên chỉ kế thừa khi CHÍNH TỆP nói ra bằng cấu trúc: ô mã vận đơn được **GỘP DỌC** qua nhiều
 * dòng (`!merges` trong xlsx). Đó là người ghi sổ tuyên bố "những dòng này là một kiện". Mọi
 * trường hợp khác là `NONE`, và dòng đó ra khỏi phép ghi.
 *
 * ─── TỆP KHÔNG PHẢI XLSX ───
 *
 * CSV không mang thông tin ô gộp. Đọc CSV thì MỌI ô trống là `NONE` — không có ngoại lệ và không
 * có cờ để bật. Mất thông tin cấu trúc thì phải mất luôn quyền suy ra từ nó.
 */

export type HmtSourceRow = {
  role: HmtSheetRole;
  sheetName: string;
  /** Số dòng như Excel hiện (1-based) — người mở tệp phải nhảy được tới đúng dòng. */
  rowNumber: number;
  trackingRaw: string;
  /** Mã đã chuẩn hoá để so khớp. Rỗng = không xác định được kiện. */
  trackingKey: string;
  inheritance: HmtInheritance;
  productText: string;
  /** Cột "Thời gian trả" — giữ nguyên văn, KHÔNG ép về `Date`: ô có thể là chữ, và đoán múi giờ cho một ô chữ là bịa. */
  returnedAtText: string;
  /** Cột "Trạng thái" (chỉ sheet danh sách mã). */
  statusText: string;
  /** Cột "Ngày vào sl" (chỉ sheet danh sách mã). */
  enteredAtText: string;
};

export type HmtSheetAudit = {
  role: HmtSheetRole;
  sheetName: string;
  found: boolean;
  /** Vùng dữ liệu tệp khai báo — đối chiếu với số dòng thật đọc được. */
  declaredRange: string;
  headerRow: number;
  headers: string[];
  totalRows: number;
  /** Dòng có ít nhất một ô nghiệp vụ khác rỗng. */
  populatedRows: number;
  /** Dòng có mã vận đơn (kể cả kế thừa từ ô gộp). */
  rowsWithTracking: number;
  blankTracking: number;
  blankTrackingInherited: number;
  blankTrackingUnresolved: number;
  uniqueTracking: number;
  returnLegTracking: number;
  duplicateTracking: number;
  duplicateTrackingProductRows: number;
  productCodes: { code: string; rows: number }[];
  colors: { value: string; rows: number }[];
  sizes: { value: string; rows: number }[];
  rowsWithoutProductCode: number;
  mergedRanges: number;
  warnings: string[];
};

export type HmtWorkbook = {
  label: string;
  sheetNames: string[];
  rows: HmtSourceRow[];
  audit: Record<HmtSheetRole, HmtSheetAudit>;
};

/** Nhận diện cột theo tiêu đề đã bỏ dấu. Danh sách ĐÓNG — cột lạ thì báo, không đoán. */
const COT = {
  tracking: ["mvd", "ma van don", "ma vd", "ma buu gui", "van don"],
  product: ["san pham", "ten san pham", "hang", "mat hang"],
  returnedAt: ["thoi gian tra", "ngay tra", "thoi gian hoan", "ngay hoan"],
  status: ["trang thai", "trang thai don"],
  enteredAt: ["ngay vao sl", "ngay vao", "ngay nhap"],
};

function boDau(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).replace(/\s+/g, " ").trim();
}

/** Cột đầu tiên mà tiêu đề khớp TRỌN VẸN một trong các tên đã biết. Khớp trọn để "ma van don" không nuốt "ma van don hoan". */
function findCol(headers: string[], names: string[]): number {
  for (const name of names) {
    const i = headers.findIndex((h) => h === name);
    if (i >= 0) return i;
  }
  // Chưa khớp trọn thì mới cho khớp chứa — vẫn theo thứ tự ưu tiên của danh sách.
  for (const name of names) {
    const i = headers.findIndex((h) => h.includes(name));
    if (i >= 0) return i;
  }
  return -1;
}

/** Dòng tiêu đề = dòng đầu tiên trong 20 dòng đầu có cột mã vận đơn. */
function findHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < Math.min(matrix.length, 20); i++) {
    const headers = (matrix[i] ?? []).map(boDau);
    if (findCol(headers, COT.tracking) >= 0) return i;
  }
  return -1;
}

/** Vùng ô gộp DỌC của một cột: dòng con → dòng neo. Chỉ nhận gộp trong đúng cột đang xét. */
export function verticalMergeAnchors(merges: XLSX.Range[] | undefined, col: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of merges ?? []) {
    if (m.s.c > col || m.e.c < col) continue;
    if (m.e.r <= m.s.r) continue;
    for (let r = m.s.r + 1; r <= m.e.r; r++) out.set(r, m.s.r);
  }
  return out;
}

/** Vận đơn chiều về: mã gốc + `[số]P[số]`. Trong sổ hàng hoàn đây là bằng chứng, không phải rác. */
export function isReturnLegCode(code: string): boolean {
  return /^[A-Z0-9]{8,}?[0-9]?P[0-9]+$/i.test(code.trim());
}

/**
 * Đọc MỘT sheet thành các dòng nguồn + bản kiểm đếm.
 *
 * Tách khỏi phần mở tệp để bài kiểm thử dựng thẳng ma trận + danh sách ô gộp, không cần một tệp
 * xlsx thật — và nhờ vậy kiểm được đúng những trường hợp khó dựng bằng tay: ô gộp bắc qua bốn
 * dòng, ô trống không gộp, dòng trùng.
 */
export function readHmtSheet(input: {
  role: HmtSheetRole;
  sheetName: string;
  matrix: unknown[][];
  merges?: XLSX.Range[];
  declaredRange?: string;
}): { rows: HmtSourceRow[]; audit: HmtSheetAudit } {
  const { role, sheetName, matrix, merges, declaredRange = "" } = input;
  const audit: HmtSheetAudit = {
    role,
    sheetName,
    found: true,
    declaredRange,
    headerRow: 0,
    headers: [],
    totalRows: 0,
    populatedRows: 0,
    rowsWithTracking: 0,
    blankTracking: 0,
    blankTrackingInherited: 0,
    blankTrackingUnresolved: 0,
    uniqueTracking: 0,
    returnLegTracking: 0,
    duplicateTracking: 0,
    duplicateTrackingProductRows: 0,
    productCodes: [],
    colors: [],
    sizes: [],
    rowsWithoutProductCode: 0,
    mergedRanges: (merges ?? []).length,
    warnings: [],
  };

  const hIdx = findHeaderRow(matrix);
  if (hIdx < 0) {
    audit.found = false;
    audit.warnings.push("Không tìm thấy dòng tiêu đề có cột mã vận đơn trong 20 dòng đầu");
    return { rows: [], audit };
  }
  const headers = (matrix[hIdx] ?? []).map(boDau);
  audit.headerRow = hIdx + 1;
  audit.headers = (matrix[hIdx] ?? []).map(cellText);

  const cTracking = findCol(headers, COT.tracking);
  const cProduct = findCol(headers, COT.product);
  const cReturned = findCol(headers, COT.returnedAt);
  const cStatus = findCol(headers, COT.status);
  const cEntered = findCol(headers, COT.enteredAt);
  if (HMT_SHEETS[role].grain === "ITEM" && cProduct < 0) audit.warnings.push('Sheet chi tiết mà không có cột "Sản phẩm" — không có bằng chứng tới mức món');

  const neo = verticalMergeAnchors(merges, cTracking);
  const rows: HmtSourceRow[] = [];
  const demTracking = new Map<string, number>();
  const demCapDoi = new Map<string, number>();
  const demMa = new Map<string, number>();
  const demMau = new Map<string, number>();
  const demSize = new Map<string, number>();

  for (let r = hIdx + 1; r < matrix.length; r++) {
    const line = matrix[r] ?? [];
    const trackingRaw = cellText(line[cTracking]);
    const productText = cProduct >= 0 ? cellText(line[cProduct]) : "";
    const returnedAtText = cReturned >= 0 ? cellText(line[cReturned]) : "";
    const statusText = cStatus >= 0 ? cellText(line[cStatus]) : "";
    const enteredAtText = cEntered >= 0 ? cellText(line[cEntered]) : "";
    const coDuLieu = Boolean(trackingRaw || productText || returnedAtText || statusText || enteredAtText);
    audit.totalRows += 1;
    if (!coDuLieu) continue;
    audit.populatedRows += 1;

    let ma = trackingRaw;
    let inheritance: HmtInheritance = trackingRaw ? "OWN_CELL" : "NONE";
    if (!trackingRaw) {
      audit.blankTracking += 1;
      const anchor = neo.get(r);
      const tuOGop = anchor === undefined ? "" : cellText((matrix[anchor] ?? [])[cTracking]);
      if (tuOGop) {
        ma = tuOGop;
        inheritance = "MERGED_CELL";
        audit.blankTrackingInherited += 1;
      } else {
        audit.blankTrackingUnresolved += 1;
      }
    }

    const trackingKey = foldTracking(ma);
    if (trackingKey) {
      audit.rowsWithTracking += 1;
      demTracking.set(trackingKey, (demTracking.get(trackingKey) ?? 0) + 1);
      const capDoi = `${trackingKey} ${boDau(productText)}`;
      demCapDoi.set(capDoi, (demCapDoi.get(capDoi) ?? 0) + 1);
    }

    if (HMT_SHEETS[role].grain === "ITEM") {
      const parsed = parseProductText(productText);
      if (parsed.productCode) demMa.set(parsed.productCode, (demMa.get(parsed.productCode) ?? 0) + 1);
      else audit.rowsWithoutProductCode += 1;
      if (parsed.color) demMau.set(parsed.color, (demMau.get(parsed.color) ?? 0) + 1);
      if (parsed.size) demSize.set(parsed.size, (demSize.get(parsed.size) ?? 0) + 1);
    }

    rows.push({ role, sheetName, rowNumber: r + 1, trackingRaw: ma, trackingKey, inheritance, productText, returnedAtText, statusText, enteredAtText });
  }

  audit.uniqueTracking = demTracking.size;
  audit.returnLegTracking = [...demTracking.keys()].filter(isReturnLegCode).length;
  audit.duplicateTracking = [...demTracking.values()].filter((n) => n > 1).length;
  audit.duplicateTrackingProductRows = [...demCapDoi.values()].reduce((a, n) => a + Math.max(0, n - 1), 0);
  const xepGiam = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "vi"));
  audit.productCodes = xepGiam(demMa).map(([code, rows_]) => ({ code, rows: rows_ }));
  audit.colors = xepGiam(demMau).map(([value, rows_]) => ({ value, rows: rows_ }));
  audit.sizes = xepGiam(demSize).map(([value, rows_]) => ({ value, rows: rows_ }));
  return { rows, audit };
}

function emptyAudit(role: HmtSheetRole): HmtSheetAudit {
  return {
    role,
    sheetName: HMT_SHEETS[role].name,
    found: false,
    declaredRange: "",
    headerRow: 0,
    headers: [],
    totalRows: 0,
    populatedRows: 0,
    rowsWithTracking: 0,
    blankTracking: 0,
    blankTrackingInherited: 0,
    blankTrackingUnresolved: 0,
    uniqueTracking: 0,
    returnLegTracking: 0,
    duplicateTracking: 0,
    duplicateTrackingProductRows: 0,
    productCodes: [],
    colors: [],
    sizes: [],
    rowsWithoutProductCode: 0,
    mergedRanges: 0,
    warnings: ["Không tìm thấy sheet này trong tệp"],
  };
}

/**
 * Mở tệp bảng tính và đọc cả ba sheet.
 *
 * `expandSheetRange` bắt buộc (AGENTS.md mục 8): tệp xuất từ Google Sheet / Viettel Post khai sai
 * vùng dữ liệu, và thư viện thì tin theo khai báo — bỏ nó là đọc được vài chục dòng đầu rồi tưởng
 * đã đọc hết.
 *
 * Tên sheet khớp CHÍNH XÁC theo `HMT_SHEETS`; không khớp thì thử theo tên đã bỏ dấu. Không đoán
 * theo thứ tự sheet: người ta chèn thêm một sheet nháp là mọi thứ lệch đi một.
 */
export function readHmtWorkbook(buffer: Buffer, label: string): HmtWorkbook {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const audit = Object.fromEntries(HMT_SHEET_ROLES.map((r) => [r, emptyAudit(r)])) as Record<HmtSheetRole, HmtSheetAudit>;
  const rows: HmtSourceRow[] = [];

  for (const role of HMT_SHEET_ROLES) {
    const want = HMT_SHEETS[role].name;
    const name = wb.SheetNames.find((n) => n === want) ?? wb.SheetNames.find((n) => boDau(n) === boDau(want));
    if (!name) continue;
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const declaredRange = typeof ws["!ref"] === "string" ? ws["!ref"] : "";
    const expanded = expandSheetRange(ws);
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(expanded, { header: 1, raw: false, defval: "" });
    const kq = readHmtSheet({ role, sheetName: name, matrix, merges: ws["!merges"], declaredRange });
    audit[role] = kq.audit;
    rows.push(...kq.rows);
  }

  const thieu = HMT_SHEET_ROLES.filter((r) => !audit[r].found).map((r) => HMT_SHEETS[r].name);
  if (thieu.length) audit[HMT_SHEET_ROLES[0]].warnings.push(`Thiếu sheet: ${thieu.join(", ")}`);
  return { label, sheetNames: wb.SheetNames, rows, audit };
}

/** Tên sheet lạ (không nằm trong ba vai trò đã khai) — hiện ra để không ai tưởng đã đọc hết tệp. */
export function unknownSheetNames(sheetNames: string[]): string[] {
  return sheetNames.filter((n) => !(n in HMT_SHEET_BY_NAME) && !HMT_SHEET_ROLES.some((r) => boDau(HMT_SHEETS[r].name) === boDau(n)));
}
