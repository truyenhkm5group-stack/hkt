/**
 * Bảng kê tiền COD Viettel Post ("Thống kê tiền hàng → Tiền hàng đã trả" trên viettelpost.vn).
 *  - Tổng hợp: dán bảng (mã bảng kê · ngày đối soát · tiền COD · cước/dư nợ · tiền thu về) → mỗi dòng một bảng kê.
 *  - Chi tiết: file Excel/CSV của một bảng kê (mỗi dòng một vận đơn) → ghép vận đơn, đánh dấu đã về ngân hàng.
 * Không đụng DB; các hàm ghi nằm ở lib/actions/cod-statements.ts.
 */
import * as XLSX from "xlsx";
import { parseCsv } from "@/lib/integrations/bank/ledger";
import { normalize } from "@/lib/text";

export type StatementSummary = { reference: string; receivedAt: string; codGross: number; feeTotal: number; netAmount: number };
export type StatementDetailRow = { trackingCode: string; cod: number; fee: number; net: number; raw: string };

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
  tracking: ["ma van don", "ma buu gui", "ma don hang", "ma don", "ma phieu gui", "order number", "order_number", "tracking", "so hieu", "ma vd"],
  cod: ["tien cod", "tien thu ho", "cod", "money collection", "tien hang", "thu ho"],
  fee: ["cuoc", "phi", "du no", "fee", "tong cuoc"],
  net: ["thuc nhan", "thu ve", "thuc tra", "con lai", "thanh toan", "net"],
};

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
    const wb = XLSX.read(input, { type: "buffer", cellDates: false });
    matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  }
  void filename;
  // tìm dòng tiêu đề trong 15 dòng đầu
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const row = (matrix[i] ?? []).map((c) => normalize(String(c ?? "")));
    if (findCol(row, COL.tracking) >= 0) {
      headerIdx = i;
      headers = row;
      break;
    }
  }
  if (headerIdx < 0) throw new Error("Không tìm thấy cột mã vận đơn trong file");
  const cTrack = findCol(headers, COL.tracking);
  const cCod = findCol(headers, COL.cod, ["cuoc", "phi"]);
  const cFee = findCol(headers, COL.fee, ["cod", "thu ho"]);
  const cNet = findCol(headers, COL.net);
  const rows: StatementDetailRow[] = [];
  for (const row of matrix.slice(headerIdx + 1)) {
    const cell = (i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    const trackingCode = cell(cTrack).toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9][A-Z0-9_-]{4,}$/.test(trackingCode)) continue;
    const cod = parseMoney(cell(cCod));
    const fee = parseMoney(cell(cFee));
    const net = cNet >= 0 ? parseMoney(cell(cNet)) : cod - fee;
    rows.push({ trackingCode, cod, fee, net, raw: row.map((c) => String(c ?? "")).join(" | ").slice(0, 200) });
  }
  if (!rows.length) throw new Error("File không có dòng vận đơn nào");
  return rows;
}

// ───────── Danh sách vận đơn xuất từ viettelpost.vn → Quản lý vận đơn ─────────

export type VtpOrderListRow = { trackingCode: string; statusText: string; cod: number; fee: number; statusDate: string; raw: string };

const LIST_COL = {
  status: ["trang thai", "status"],
  date: ["ngay cap nhat", "ngay trang thai", "thoi gian cap nhat", "ngay tra", "ngay giao", "ngay gui", "ngay tao", "ngay"],
};

/** Đọc file danh sách vận đơn (xlsx/csv): mã vận đơn, trạng thái, tiền thu hộ, cước, ngày */
export function parseVtpOrderList(input: Buffer | string): VtpOrderListRow[] {
  let matrix: unknown[][];
  if (typeof input === "string") matrix = parseCsv(input.replace(/^﻿/, ""));
  else {
    const wb = XLSX.read(input, { type: "buffer", cellDates: true });
    matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
  }
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const row = (matrix[i] ?? []).map((c) => normalize(String(c ?? "")));
    if (findCol(row, COL.tracking) >= 0 && findCol(row, LIST_COL.status) >= 0) {
      headerIdx = i;
      headers = row;
      break;
    }
  }
  if (headerIdx < 0) throw new Error("Không tìm thấy cột Mã vận đơn và Trạng thái trong file");
  const cTrack = findCol(headers, COL.tracking);
  const cStatus = findCol(headers, LIST_COL.status);
  const cCod = findCol(headers, COL.cod, ["cuoc", "phi"]);
  const cFee = findCol(headers, COL.fee, ["cod", "thu ho"]);
  const cDate = findCol(headers, LIST_COL.date);
  const rows: VtpOrderListRow[] = [];
  for (const row of matrix.slice(headerIdx + 1)) {
    const cell = (i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    const trackingCode = cell(cTrack).toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9][A-Z0-9_-]{4,}$/.test(trackingCode)) continue;
    rows.push({ trackingCode, statusText: cell(cStatus), cod: parseMoney(cell(cCod)), fee: parseMoney(cell(cFee)), statusDate: toDateKey(cell(cDate)), raw: row.map((c) => String(c ?? "")).join(" | ").slice(0, 200) });
  }
  if (!rows.length) throw new Error("File không có dòng vận đơn nào");
  return rows;
}

export type VtpStatusMap = { stage: "PENDING" | "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "DELIVERY_FAILED" | "RETURNING" | "RETURNED" | "CANCELLED" | "UNKNOWN"; cod: "PAID_TO_BANK" | "COLLECTED" | "PENDING" | "NOT_APPLICABLE" | null; final: boolean };

/** Trạng thái chữ trên viettelpost.vn → giai đoạn & trạng thái COD trong ERP */
export function mapVtpStatusText(text: string): VtpStatusMap {
  const n = normalize(text);
  const has = (...keys: string[]) => keys.some((k) => n.includes(` ${k} `) || n.includes(k));
  if (has("da tra", "da thanh toan cod")) return { stage: "DELIVERED", cod: "PAID_TO_BANK", final: true };
  if (has("giao thanh cong", "phat thanh cong")) return { stage: "DELIVERED", cod: "COLLECTED", final: true };
  if (has("cho phat lai", "phat that bai", "giao that bai")) return { stage: "DELIVERY_FAILED", cod: "PENDING", final: false };
  if (has("dang giao hang", "phat tiep", "dang phat")) return { stage: "OUT_FOR_DELIVERY", cod: "PENDING", final: false };
  if (has("dang van chuyen", "dang trung chuyen")) return { stage: "IN_TRANSIT", cod: "PENDING", final: false };
  if (has("da lay hang", "da nhan hang")) return { stage: "PICKED_UP", cod: "PENDING", final: false };
  if (has("da tra hang", "hoan thanh cong", "da hoan")) return { stage: "RETURNED", cod: "NOT_APPLICABLE", final: true };
  if (has("chuyen hoan", "duyet hoan", "yeu cau hoan")) return { stage: "RETURNING", cod: "NOT_APPLICABLE", final: false };
  if (has("huy")) return { stage: "CANCELLED", cod: "NOT_APPLICABLE", final: true };
  if (has("cho xu ly", "cho lay hang", "moi tao")) return { stage: "PENDING", cod: "PENDING", final: false };
  return { stage: "UNKNOWN", cod: null, final: false };
}
