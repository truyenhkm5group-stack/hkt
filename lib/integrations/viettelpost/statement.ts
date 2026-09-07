/**
 * Bảng kê tiền COD Viettel Post ("Thống kê tiền hàng → Tiền hàng đã trả" trên viettelpost.vn).
 *  - Tổng hợp: dán bảng (mã bảng kê · ngày đối soát · tiền COD · cước/dư nợ · tiền thu về) → mỗi dòng một bảng kê.
 *  - Chi tiết: file Excel/CSV của một bảng kê (mỗi dòng một vận đơn) → ghép vận đơn, đánh dấu đã về ngân hàng.
 * Không đụng DB; các hàm ghi nằm ở lib/actions/cod-statements.ts.
 */
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/integrations/bank/ledger";
import { normalize } from "@/lib/text";

export type StatementSummary = { reference: string; receivedAt: string; codGross: number; feeTotal: number; netAmount: number };
export type StatementDetailRow = {
  trackingCode: string; cod: number; fee: number; net: number; raw: string;
  /** Ngày phát thành công (YYYY-MM-DD) — dùng để biết bảng kê phủ giai đoạn nào. */
  paidDate?: string;
  /**
   * Bảng kê này CÓ NÓI về tiền COD của vận đơn hay không.
   *
   * Khác nhau một trời một vực: "bảng kê ghi thu 0" là bằng chứng không thu được đồng nào, còn
   * "bảng kê không nhắc tới" chỉ nghĩa là kỳ này không chi trả COD cho vận đơn đó — tiền có thể
   * đã về ở kỳ trước. Bảng kê gửi qua email tách riêng phần COD và phần cước, nên một vận đơn
   * chỉ nằm ở phần cước sẽ có cod = 0 mà KHÔNG được phép hạ số tiền đã ghi nhận trước đó.
   * Mặc định coi là có nói (tệp tải tay luôn có cột tiền thu hộ).
   */
  codReported?: boolean;
};

const MONEY_RE = /-?\d{1,3}(?:[.,]\d{3})+|-?\d+/g;

function parseMoney(text: string) {
  const digits = text.replace(/[^\d-]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toDateKey(text: string) {
  let m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

/** Dán bảng "Tiền hàng đã trả": mỗi dòng có mã bảng kê, ngày đối soát và 3 số tiền (COD, cước/dư nợ, thu về) */
export function parseStatementSummaryText(text: string): StatementSummary[] {
  const out: StatementSummary[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const ref = line.match(/[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+){2,}/i)?.[0];
    if (!ref) continue;
    const date = toDateKey(line);
    // bỏ mã bảng kê và ngày giờ trước khi tách số tiền
    const rest = line.replace(ref, " ").replace(/\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, " ");
    const amounts = (rest.match(MONEY_RE) ?? []).map(parseMoney).filter((n) => n !== 0 || true);
    if (!date || amounts.length < 2) continue;
    const [codGross, feeTotal, net] = amounts.length >= 3 ? amounts : [amounts[0], 0, amounts[1]];
    out.push({ reference: ref.toUpperCase(), receivedAt: date, codGross, feeTotal, netAmount: net ?? codGross - feeTotal });
  }
  return out;
}

const COL = {
  tracking: ["ma van don", "ma buu gui", "ma don hang", "ma don", "ma phieu gui", "order number", "order_number", "tracking", "so hieu", "ma vd", "ma bill", "so van don", "ma phieu"],
  cod: ["tien cod", "tien thu ho", "cod", "money collection", "tien hang", "thu ho"],
  fee: ["cuoc", "phi", "du no", "fee", "tong cuoc"],
  // "tien ve" là tên cột thật trên chi tiết bảng kê Viettel Post; thiếu nó ERP phải tự suy cod - fee.
  net: ["tien ve", "thuc nhan", "thu ve", "thuc tra", "con lai", "thanh toan", "net"],
};

/**
 * Đọc sheet đầu tiên thành ma trận. File "Danh sách vận đơn" của viettelpost.vn khai báo sai vùng dữ liệu
 * (<dimension ref="A1:AU23"/> trong khi sheet có hàng nghìn dòng): Excel bỏ qua khai báo này còn thư viện thì tin theo
 * nên chỉ đọc được 23 dòng đầu. Vì vậy luôn tính lại vùng dữ liệu từ các ô có thật.
 */
export function expandSheetRange(ws: XLSX.WorkSheet): XLSX.WorkSheet {
  let maxRow = -1;
  let maxCol = -1;
  for (const key of Object.keys(ws)) {
    if (key.startsWith("!")) continue;
    const cell = XLSX.utils.decode_cell(key);
    if (cell.r > maxRow) maxRow = cell.r;
    if (cell.c > maxCol) maxCol = cell.c;
  }
  if (maxRow < 0) return ws;
  const declared = typeof ws["!ref"] === "string" ? XLSX.utils.decode_range(ws["!ref"] as string) : null;
  if (!declared || declared.e.r < maxRow || declared.e.c < maxCol) {
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: Math.max(maxCol, declared?.e.c ?? 0) } });
  }
  return ws;
}

function sheetMatrix(input: Buffer, cellDates: boolean, raw: boolean): unknown[][] {
  const wb = XLSX.read(input, { type: "buffer", cellDates });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(expandSheetRange(ws), { header: 1, raw, defval: "" });
}

function findCol(headers: string[], keys: string[], exclude: string[] = []) {
  for (const key of keys) {
    const i = headers.findIndex((h) => h.includes(` ${key} `) && !exclude.some((x) => h.includes(` ${x} `)));
    if (i >= 0) return i;
  }
  return -1;
}

/** Đọc file chi tiết bảng kê (xlsx/xls/csv). Tự tìm dòng tiêu đề chứa cột mã vận đơn. */
export function parseStatementDetail(input: Buffer | string, filename = ""): StatementDetailRow[] {
  let matrix: unknown[][];
  if (typeof input === "string") {
    // CSV: tự tách để giữ nguyên chuỗi "500.000" (SheetJS sẽ hiểu nhầm thành số 500)
    matrix = parseCsv(input.replace(/^\uFEFF/, ""));
  } else {
    matrix = sheetMatrix(input, false, true);
  }
  void filename;
  // tìm dòng tiêu đề trong 15 dòng đầu
  let headerIdx = -1;
  let headers: string[] = [];
  // Tệp Viettel Post gửi qua email (BangKeChiCOD_*.xlsx) có tiêu đề thư và phần ký nhận dài
  // trước dòng tiêu đề bảng, nên phải quét sâu hơn 15 dòng.
  for (let i = 0; i < Math.min(matrix.length, 40); i++) {
    const row = (matrix[i] ?? []).map((c) => normalize(String(c ?? "")));
    if (findCol(row, COL.tracking) >= 0) {
      headerIdx = i;
      headers = row;
      break;
    }
  }
  if (headerIdx < 0) throw new Error("Không tìm thấy cột mã vận đơn trong file");
  if (findCol(headers, ["trang thai doi soat cod"]) >= 0 && findCol(headers, ["ngay chuyen trang thai"]) >= 0) {
    throw new Error("Đây là Danh sách vận đơn, không phải chi tiết bảng kê tiền COD đã trả. Hãy nhập ở tab Danh sách vận đơn; không dùng file này để đánh dấu tiền về ngân hàng.");
  }
  const cTrack = findCol(headers, COL.tracking);
  const cCod = findCol(headers, COL.cod, ["cuoc", "phi"]);
  const cFee = findCol(headers, COL.fee, ["cod", "thu ho"]);
  const cNet = findCol(headers, COL.net);
  // Ngày trên chi tiết bảng kê cho biết đợt này phủ giai đoạn nào — cần để báo "thiếu bảng kê từ ngày nào".
  const cPaid = findCol(headers, ["ngay phat thanh cong", "ngay phat"]);
  const cCreated2 = findCol(headers, ["ngay tao buu pham", "ngay tao"]);
  const rows: StatementDetailRow[] = [];
  for (const row of matrix.slice(headerIdx + 1)) {
    const cell = (i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    const trackingCode = cell(cTrack).toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9][A-Z0-9_-]{4,}$/.test(trackingCode)) continue;
    const cod = parseMoney(cell(cCod));
    const fee = parseMoney(cell(cFee));
    const net = cNet >= 0 ? parseMoney(cell(cNet)) : cod - fee;
    const dateText = cell(cPaid) || cell(cCreated2);
    const dm = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dateText);
    const paidDate = dm ? `${dm[3]}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}` : undefined;
    rows.push({ trackingCode, cod, fee, net, paidDate, raw: row.map((c) => String(c ?? "")).join(" | ").slice(0, 200) });
  }
  if (!rows.length) throw new Error("File không có dòng vận đơn nào");
  return rows;
}

// ───────── Danh sách vận đơn xuất từ viettelpost.vn → Quản lý vận đơn ─────────

export type VtpOrderListRow = {
  trackingCode: string; orderCode: string; statusText: string;
  /** Số trên danh sách vận đơn là COD khai báo, không tự coi là tiền đã xác minh. */
  cod: number | null; fee: number | null; statusDate: string; raw: string;
  statusAt?: string | null; createdAt?: string | null;
  codReconciliationText?: string; paymentText?: string; returnFlag?: boolean; forwardFlag?: boolean;
  /** Người nhận trên file VTP — bằng chứng duy nhất để gắn vận đơn tạo thẳng trên web VTP vào đơn ERP. */
  receiverName?: string; receiverPhone?: string; receiverAddress?: string;
  sourceHash?: string; sourceRow?: number;
};

/** VND nguyên; ô trống khác số 0. Không sửa ngầm dữ liệu không hợp lệ. */
function listMoney(value: unknown, label: string): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error(`${label}: tiền phải là số nguyên VND không âm`);
  }
  const text = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:[., ]\d{3})+)$/.test(text)) throw new Error(`${label}: số tiền không hợp lệ`);
  const amount = Number(text.replace(/[., ]/g, ""));
  if (!Number.isSafeInteger(amount)) throw new Error(`${label}: số tiền vượt giới hạn`);
  return amount;
}

/** File VTP dùng giờ Việt Nam; giữ đủ giây, không thay bằng ngày tạo hay giờ nhập. */
export function parseVtpListTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = value instanceof Date
    ? `${value.getUTCDate()}/${value.getUTCMonth() + 1}/${value.getUTCFullYear()} ${value.getUTCHours()}:${value.getUTCMinutes()}:${value.getUTCSeconds()}`
    : String(value).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(text);
  if (!m) throw new Error(`Ngày trạng thái không đúng định dạng VTP: ${text}`);
  const [, d, mo, y, h = "0", mi = "0", sec = "0"] = m;
  const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));
  if (local.getUTCFullYear() !== +y || local.getUTCMonth() !== +mo - 1 || local.getUTCDate() !== +d || +h > 23 || +mi > 59 || +sec > 59) throw new Error(`Ngày VTP không hợp lệ: ${text}`);
  return new Date(local.getTime() - 7 * 3600_000).toISOString();
}

/** Cùng mã/cùng thời điểm nhưng nội dung khác: cần đối chiếu, không chọn theo thứ tự file. */
export function mergeVtpOrderLists(rows: VtpOrderListRow[]): VtpOrderListRow[] {
  const merged = new Map<string, VtpOrderListRow>();
  for (const row of rows) {
    const previous = merged.get(row.trackingCode);
    if (!previous) { merged.set(row.trackingCode, row); continue; }
    const before = previous.statusAt ?? previous.statusDate;
    const after = row.statusAt ?? row.statusDate;
    if (!before || !after || before === after) {
      const payload = (r: VtpOrderListRow) => JSON.stringify([r.orderCode, r.statusText, r.cod, r.fee, r.codReconciliationText ?? "", r.paymentText ?? "", r.returnFlag ?? false, r.forwardFlag ?? false]);
      if (payload(previous) !== payload(row)) throw new Error(`Vận đơn ${row.trackingCode}: các tệp có dữ liệu xung đột, chưa thể chọn bản mới nhất`);
    } else if (after > before) merged.set(row.trackingCode, row);
  }
  return [...merged.values()];
}

/**
 * Vận đơn chiều về / thu tiền ship do Viettel Post tạo từ vận đơn gốc: mã = mã gốc + [số] + P + số (vd PKE1506697767 → PKE15066977671P1).
 * File "Danh sách vận đơn" để mã này ở cột "Mã Vận Đơn", còn cột "Mã đơn hàng" mới là mã gốc ERP đang lưu.
 */
export function legBaseCode(code: string): string {
  const m = /^([A-Z0-9]{8,}?)[0-9]?P[0-9]+$/i.exec(code.trim()); // lười để "PKE15089090051P1" ra gốc PKE1508909005, không phải PKE15089090051
  return m ? m[1].toUpperCase() : "";
}

const LIST_COL = {
  status: ["trang thai don hang", "trang thai van don", "trang thai", "status"],
  /** Cột "Mã đơn hàng" của file VTP: với vận đơn chiều về thì đây chính là mã vận đơn gốc */
  order: ["ma don hang", "ma tham chieu", "ma don"],
  date: ["ngay chuyen trang thai", "ngay cap nhat", "ngay trang thai", "thoi gian cap nhat", "ngay tra", "ngay giao"],
  /** Loại trừ "khi" để không bắt nhầm cột "Tên người nhận KHI phát hàng" ở cuối file. */
  receiver: ["nguoi nhan"],
  receiverPhone: ["dt nhan", "dien thoai nhan", "sdt nhan"],
  receiverAddress: ["dia chi nhan"],
};

/** Đọc file danh sách vận đơn (xlsx/csv): mã vận đơn, trạng thái, tiền thu hộ, cước, ngày */
export function parseVtpOrderList(input: Buffer | string): VtpOrderListRow[] {
  let matrix: unknown[][];
  if (typeof input === "string") matrix = parseCsv(input.replace(/^﻿/, ""));
  else {
    matrix = sheetMatrix(input, true, true);
  }
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(matrix.length, 40); i++) {
    const row = (matrix[i] ?? []).map((c) => normalize(String(c ?? "")));
    if (findCol(row, COL.tracking) >= 0 && findCol(row, LIST_COL.status) >= 0) {
      headerIdx = i;
      headers = row;
      break;
    }
  }
  if (headerIdx < 0) {
    // Chi tiết bảng kê tiền COD có mã vận đơn + tiền nhưng KHÔNG có cột trạng thái.
    // Chỉ thẳng sang đúng tab thay vì bắt chủ shop tự suy từ danh sách cột.
    const looksLikeStatement = matrix.slice(0, 15).some((r) => {
      const row = (r ?? []).map((c) => normalize(String(c ?? "")));
      return findCol(row, COL.tracking) >= 0 && (findCol(row, COL.net) >= 0 || findCol(row, COL.cod, ["cuoc", "phi"]) >= 0);
    });
    if (looksLikeStatement) {
      throw new Error(
        'Đây là CHI TIẾT BẢNG KÊ tiền COD (có Tiền thu hộ / Tiền về nhưng không có cột Trạng thái). ' +
          'Hãy nhập ở tab "Chi tiết một bảng kê (file)" để gắn vận đơn vào đợt tiền về.',
      );
    }
    // Liệt kê nhiều dòng đầu để lần sau nhìn thông báo là biết bố cục tệp, không phải xin lại tệp.
    const sample = matrix.slice(0, 24).map((r, i) => {
      const cells = (r ?? []).map((c) => String(c ?? "").trim()).filter(Boolean).slice(0, 14);
      return cells.length ? `[${i}] ${cells.join(" | ")}` : "";
    }).filter(Boolean).slice(0, 12).join(" ‖ ");
    throw new Error(`Không tìm thấy cột Mã vận đơn và Trạng thái trong file. Các cột đọc được: ${sample || "(trống)"}`);
  }
  const cTrack = findCol(headers, COL.tracking);
  const cStatus = findCol(headers, LIST_COL.status);
  const cCod = findCol(headers, COL.cod, ["cuoc", "phi"]);
  const cFee = findCol(headers, ["tong phi", "cuoc van chuyen", ...COL.fee], ["cod", "thu ho"]);
  const cDate = findCol(headers, LIST_COL.date);
  const cCreated = findCol(headers, ["ngay tao"]);
  const cReconciliation = findCol(headers, ["trang thai doi soat cod"]);
  const cPayment = findCol(headers, ["trang thai thanh toan"]);
  const cReturn = findCol(headers, ["don chuyen hoan"]);
  const cForward = findCol(headers, ["don chuyen tiep"]);
  const cReceiver = findCol(headers, LIST_COL.receiver, ["khi", "gui"]);
  const cReceiverPhone = findCol(headers, LIST_COL.receiverPhone, ["khi", "gui"]);
  const cReceiverAddress = findCol(headers, LIST_COL.receiverAddress, ["gui"]);
  const cOrderRaw = findCol(headers, LIST_COL.order, ["van don"]);
  const cOrder = cOrderRaw === cTrack ? -1 : cOrderRaw;
  const rows: VtpOrderListRow[] = [];
  const sourceHash = createHash("sha256").update(input).digest("hex");
  for (const [offset, row] of matrix.slice(headerIdx + 1).entries()) {
    const cell = (i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    const trackingCode = cell(cTrack).toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9][A-Z0-9_-]{4,}$/.test(trackingCode)) continue;
    const orderCode = cell(cOrder).toUpperCase().replace(/\s+/g, "");
    const statusAt = parseVtpListTimestamp(cDate >= 0 ? row[cDate] : null);
    const parsed = { trackingCode, orderCode: /^[A-Z0-9][A-Z0-9_-]{4,}$/.test(orderCode) ? orderCode : "", statusText: cell(cStatus),
      cod: listMoney(cCod >= 0 ? row[cCod] : null, `${trackingCode} COD khai báo`), fee: listMoney(cFee >= 0 ? row[cFee] : null, `${trackingCode} Tổng phí`),
      statusDate: statusAt ? new Date(new Date(statusAt).getTime() + 7 * 3600_000).toISOString().slice(0, 10) : "", statusAt,
      createdAt: parseVtpListTimestamp(cCreated >= 0 ? row[cCreated] : null),
      codReconciliationText: cell(cReconciliation), paymentText: cell(cPayment), returnFlag: cell(cReturn).toLowerCase() === "x", forwardFlag: cell(cForward).toLowerCase() === "x",
      receiverName: cell(cReceiver), receiverPhone: cell(cReceiverPhone), receiverAddress: cell(cReceiverAddress),
      sourceHash, sourceRow: headerIdx + offset + 2 };
    rows.push({ ...parsed, raw: JSON.stringify(parsed) });
  }
  if (!rows.length) throw new Error("File không có dòng vận đơn nào");
  return rows;
}

/**
 * Trạng thái giao hàng KHÔNG kết luận gì về tiền: `cod: null` nghĩa là "trạng thái này không nói
 * gì về COD". Trước đây các trạng thái hoàn/huỷ trả về NOT_APPLICABLE ("không thu hộ") khiến ERP
 * hiện "Không thu hộ" cho vận đơn mà Viettel Post vẫn ghi số tiền cần thu.
 */
export type VtpStatusMap = { stage: "PENDING" | "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "DELIVERY_FAILED" | "RETURNING" | "RETURNED" | "CANCELLED" | "UNKNOWN"; cod: "PAID_TO_BANK" | "COLLECTED" | "PENDING" | "NOT_APPLICABLE" | null; final: boolean };

/** Trạng thái chữ trên viettelpost.vn → giai đoạn & trạng thái COD trong ERP */
export function mapVtpStatusText(text: string): VtpStatusMap {
  const n = normalize(text);
  const has = (...keys: string[]) => keys.some((k) => n.includes(` ${k} `) || n.includes(k));
  // Trên viettelpost.vn (Quản lý vận đơn) cột "Trạng thái" là trạng thái GIAO/HOÀN của vận đơn,
  // không phải trạng thái tiền COD. "Đã trả" = đã trả hàng về người gửi (đơn hoàn), không phải "đã trả tiền".
  // Vì vậy phải xét các trạng thái hoàn TRƯỚC khi xét giao thành công.
  if (has("da huy", "huy don", "huy van don", "huy bo", "don huy", "cancel", "shop huy lay", "huy lay"))
    return { stage: "CANCELLED", cod: null, final: true };
  // Hoàn đã hoàn tất (đã trả hàng về người gửi).
  // "Thành công - Chuyển trả người gửi" là mã 504 = HOÀN XONG. Phải xét TRƯỚC nhánh "chuyển trả"
  // bên dưới, nếu không nó bị đọc thành ĐANG hoàn và kéo lùi vận đơn đã kết thúc — đúng lỗi đo
  // được khi chạy thử dựng lại trạng thái (31 vận đơn bị hạ RETURNED về RETURNING).
  if (has("chuyen tra nguoi gui", "tra nguoi gui", "hoan thanh cong nguoi gui"))
    return { stage: "RETURNED", cod: null, final: true };
  if (has("da tra hang", "tra hang thanh cong", "hoan thanh cong", "da hoan", "hoan tat hoan", "tra thanh cong"))
    return { stage: "RETURNED", cod: null, final: true };
  // Đang trong quá trình hoàn: đã duyệt hoàn / đang chuyển hoàn / yêu cầu hoàn / chờ hoàn
  if (has("chuyen hoan", "duyet hoan", "yeu cau hoan", "dang hoan", "cho hoan", "hoan hang", "chuyen tra"))
    return { stage: "RETURNING", cod: null, final: false };
  // "Đã trả" đứng riêng (không phải "đã trả tiền/đã thanh toán") = đơn hoàn đã trả về người gửi
  if (has("da tra") && !has("da tra tien", "da thanh toan", "tra tien", "tra cod"))
    return { stage: "RETURNED", cod: null, final: true };
  // Giao không thành công / chờ phát lại (chưa kết thúc)
  if (has("giao khong thanh cong", "phat khong thanh cong", "cho phat lai", "phat that bai", "giao that bai", "khong gap", "delivery fail"))
    return { stage: "DELIVERY_FAILED", cod: "PENDING", final: false };
  // Giao thành công
  if (has("giao thanh cong", "phat thanh cong")) return { stage: "DELIVERED", cod: "COLLECTED", final: true };
  // Đã thanh toán COD cho đơn giao thành công (nếu xuất hiện trong cột trạng thái)
  if (has("da thanh toan cod", "da tra tien cod")) return { stage: "DELIVERED", cod: "PAID_TO_BANK", final: true };
  if (has("dang giao hang", "phat tiep", "dang phat", "di giao")) return { stage: "OUT_FOR_DELIVERY", cod: "PENDING", final: false };
  if (has("dang van chuyen", "dang trung chuyen", "trung chuyen", "dang luan chuyen")) return { stage: "IN_TRANSIT", cod: "PENDING", final: false };
  if (has("da lay hang", "da nhan hang", "lay hang thanh cong")) return { stage: "PICKED_UP", cod: "PENDING", final: false };
  if (has("cho xu ly", "cho lay hang", "cho duyet", "moi tao", "tao moi", "khoi tao")) return { stage: "PENDING", cod: "PENDING", final: false };

  // ───── Từ vựng của CHÍNH ĐVVC (STATUS_NAME trong webhook và bản sao hành trình từ Pancake) ─────
  // Khác hẳn từ vựng cột "Trạng Thái" của tệp Excel. Thiếu nhóm này thì 17.881/19.362 sự kiện
  // trong lịch sử không dịch được, và trạng thái dựng từ lịch sử chỉ nhìn thấy một phần sự thật.
  if (has("thong bao chuyen hoan", "duyet hoan", "yeu cau chuyen hoan")) return { stage: "RETURNING", cod: null, final: false };
  if (has("khach hang nghi", "khong co nha", "den buu cuc nhan", "khach tu choi", "hen phat lai", "khong lien lac"))
    return { stage: "DELIVERY_FAILED", cod: "PENDING", final: false };
  if (has("buu ta di phat", "phan cong buu ta di giao", "di phat", "phat tiep")) return { stage: "OUT_FOR_DELIVERY", cod: "PENDING", final: false };
  if (has("nhan bang ke den", "dong bang ke", "nhan tai", "van chuyen di", "dong tai", "dong tui goi", "chuyen tuyen", "nhan chuyen thu"))
    return { stage: "IN_TRANSIT", cod: "PENDING", final: false };
  if (has("buu ta da nhan hang", "lay hang thanh cong", "nhap buu cuc goc", "sua phieu gui", "sua phieu gui")) return { stage: "PICKED_UP", cod: "PENDING", final: false };
  if (has("giao cho buu ta di nhan", "dieu phoi buu ta", "dieu phoi buu cuc", "giao cho buu cuc", "don hang cho xu ly", "tiep nhan don"))
    return { stage: "PENDING", cod: "PENDING", final: false };

  return { stage: "UNKNOWN", cod: null, final: false };
}

/**
 * BẢNG KÊ ĐỐI SOÁT THANH TOÁN — tệp `BangKeChiCOD_*.xlsx` Viettel Post GỬI QUA EMAIL.
 *
 * Khác hẳn tệp tải tay từ web: một tệp có HAI phần, mỗi phần một bảng riêng với tiêu đề riêng,
 * và trước chúng là tiêu đề thư dài (tên tổng công ty, phòng tài chính, mã khách hàng…).
 *
 *   I:  CHI TIẾT SỐ TIỀN COD
 *       STT · Số BILL · Ngày gửi · Dịch vụ · Ngày phát thành công · Số tiền COD · Ghi chú
 *   II: CHI TIẾT TIỀN CƯỚC CHUYỂN PHÁT VÀ PHÍ COD
 *       STT · Số BILL · Ngày gửi · Dịch vụ · Trọng lượng · Cước phí · Cước đã thu · Giảm giá ·
 *       Tổng số tiền · Ghi chú
 *
 * Một vận đơn có thể chỉ nằm ở phần I (thu được COD), chỉ nằm ở phần II (chỉ có cước — thường là
 * vận đơn chiều hoàn CHPKE… hoặc …1P1), hoặc nằm ở cả hai. Tiền Viettel Post thực trả về tài
 * khoản = tổng COD phần I − tổng cước phần II, nên gộp hai phần theo mã vận đơn rồi tính
 * `net = cod − fee` cho từng mã.
 *
 * Vận đơn chỉ có ở phần II với COD = 0 là BẰNG CHỨNG THẬT rằng đơn đó không thu được đồng nào,
 * không phải "chưa biết" — đúng thứ ERP cần để kết luận tiền.
 */
export function parseCodPaymentStatement(input: Buffer | string, filename = ""): StatementDetailRow[] {
  const matrix = typeof input === "string" ? parseCsv(input.replace(/^﻿/, "")) : sheetMatrix(input, false, true);
  const norm = (i: number) => (matrix[i] ?? []).map((c) => normalize(String(c ?? "")));

  /** Tìm dòng tiêu đề của một phần: phải có cột Số BILL và cột tiền đặc trưng của phần đó. */
  const findHeader = (moneyKeys: string[], from = 0) => {
    for (let i = from; i < matrix.length; i++) {
      const row = norm(i);
      if (findCol(row, ["so bill", ...COL.tracking]) >= 0 && findCol(row, moneyKeys) >= 0) return { index: i, headers: row };
    }
    return null;
  };

  const secCod = findHeader(["so tien cod"]);
  const secFee = findHeader(["tong so tien"], secCod ? secCod.index + 1 : 0);
  if (!secCod && !secFee) {
    throw new Error("Không tìm thấy phần 'CHI TIẾT SỐ TIỀN COD' hay 'CHI TIẾT TIỀN CƯỚC' trong bảng kê đối soát thanh toán");
  }

  /** Đọc các dòng dữ liệu ngay dưới một tiêu đề, dừng khi hết mã vận đơn hợp lệ. */
  const readRows = (header: { index: number; headers: string[] } | null, moneyKeys: string[], dateKeys: string[], until = matrix.length) => {
    const out = new Map<string, { amount: number; date?: string }>();
    if (!header) return out;
    const cTrack = findCol(header.headers, ["so bill", ...COL.tracking]);
    const cMoney = findCol(header.headers, moneyKeys);
    const cDate = dateKeys.length ? findCol(header.headers, dateKeys) : -1;
    let blanks = 0;
    // `until` là ranh giới phần sau: thiếu nó thì phần I đọc lấn sang bảng cước của phần II và
    // lấy nhầm cột "Cước phí" làm "Số tiền COD" (cùng nằm ở cột F).
    for (let i = header.index + 1; i < until; i++) {
      const row = matrix[i] ?? [];
      const code = String(row[cTrack] ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z0-9][A-Z0-9_-]{4,}$/.test(code)) {
        // Vài dòng trống ngăn cách hai phần là bình thường; trống nhiều liên tiếp nghĩa là hết bảng.
        if (++blanks > 5) break;
        continue;
      }
      blanks = 0;
      const amount = cMoney >= 0 ? parseMoney(String(row[cMoney] ?? "")) : 0;
      const date = cDate >= 0 ? toDateKey(String(row[cDate] ?? "")) : "";
      const prev = out.get(code);
      // Cùng một mã xuất hiện nhiều dòng trong một phần thì cộng dồn, không ghi đè.
      out.set(code, { amount: (prev?.amount ?? 0) + amount, date: prev?.date || date || undefined });
    }
    return out;
  };

  const cod = readRows(secCod, ["so tien cod"], ["ngay phat thanh cong"], secFee ? secFee.index : matrix.length);
  const fee = readRows(secFee, ["tong so tien"], []);

  const rows: StatementDetailRow[] = [];
  for (const code of new Set([...cod.keys(), ...fee.keys()])) {
    const c = cod.get(code)?.amount ?? 0;
    const f = fee.get(code)?.amount ?? 0;
    rows.push({
      trackingCode: code,
      cod: c,
      fee: f,
      net: c - f,
      codReported: cod.has(code),
      paidDate: cod.get(code)?.date,
      raw: JSON.stringify({ trackingCode: code, cod: c, fee: f, source: filename }),
    });
  }
  if (!rows.length) throw new Error("Bảng kê đối soát thanh toán không có dòng vận đơn nào");
  return rows;
}
