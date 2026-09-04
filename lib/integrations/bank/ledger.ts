/**
 * Nhập sao kê ngân hàng (app "HKT · Quản lý giao dịch MB Bank") vào chi phí ERP.
 * Hỗ trợ:
 *  - JSON: `{ transactions: [...] }` (window.HKT_SEED / bản sao lưu) hoặc mảng giao dịch
 *  - CSV "Xuất CSV" của app: Ngày, Giờ, Tiền vào, Tiền ra, Nội dung, Đối tác, Mã GD, Số dư, Mã danh mục, …
 * Chỉ tiền RA thuộc nhóm lãi/lỗ mới thành chi phí; tiền vào và các khoản không tính lãi/lỗ
 * (chuyển nội bộ, trả nợ gốc, rút vốn…) được bỏ qua và báo lại cho người dùng.
 */
import type { ExpenseCategory } from "@/db/schema";
import { normalize } from "@/lib/integrations/facebook/mapping";

export type LedgerTxn = {
  date: string; // YYYY-MM-DD
  time: string;
  amount: number; // dương = tiền vào, âm = tiền ra
  description: string;
  counterparty: string;
  bankRef: string;
  categoryCode: string;
  note: string;
};

export type PlanStatus = "new" | "duplicate" | "inflow" | "non_pl";

export type PlannedRow = {
  key: string;
  bankRef: string;
  date: string;
  amount: number; // số dương (₫)
  counterparty: string;
  description: string; // mô tả sẽ lưu vào ERP
  raw: string;
  ledgerCategory: string;
  category: ExpenseCategory;
  categorySource: "ledger" | "employee" | "keyword" | "amount" | "default";
  status: PlanStatus;
  reference: string;
};

/** Danh mục app sao kê → nhóm chi phí ERP. "SKIP" = không phải chi phí (không tính lãi/lỗ). */
export const LEDGER_TO_ERP: Record<string, ExpenseCategory | "SKIP"> = {
  HOAN_TIEN: "RETURN_FEE",
  CHIET_KHAU: "OTHER",
  MUA_HANG: "PURCHASE",
  VAN_CHUYEN_MUA: "PURCHASE",
  NGUYEN_LIEU: "PURCHASE",
  VAN_CHUYEN_BAN: "SHIPPING",
  DONG_GOI: "PACKAGING",
  QUANG_CAO: "ADS",
  PHI_SAN: "OTHER",
  HOA_HONG: "SALARY",
  KHUYEN_MAI: "OTHER",
  CP_BAN_HANG_KHAC: "OTHER",
  LUONG: "SALARY",
  THUE_MAT_BANG: "RENT",
  DIEN_NUOC_INTERNET: "RENT",
  PHAN_MEM: "SOFTWARE",
  VAN_PHONG_PHAM: "OTHER",
  LE_PHI_MON_BAI: "OTHER",
  CP_QUAN_LY_KHAC: "OTHER",
  PHI_NGAN_HANG: "OTHER",
  LAI_VAY: "OTHER",
  CHI_KHAC: "OTHER",
  PHAT_BOI_THUONG: "OTHER",
  THUE_KHOAN: "OTHER",
  RUT_VON: "SKIP",
  TRA_NO_GOC: "SKIP",
  CHUYEN_NOI_BO: "SKIP",
  THU_HO_CHI_HO: "SKIP",
  MUA_TAI_SAN: "SKIP",
  DAT_COC_NCC: "SKIP",
};

/** Từ số tiền này trở lên, chuyển khoản cho cá nhân chưa phân loại được coi là tiền nhập hàng */
export const PURCHASE_THRESHOLD = 5_000_000;

const KEYWORDS: [RegExp, ExpenseCategory][] = [
  [/pancake|phan mem|software|canva|chatgpt|openai|google workspace|hosting|domain|ten mien/, "SOFTWARE"],
  [/facebook|meta platforms|fb ads|quang cao|tiktok ads|google ads/, "ADS"],
  [/viettel post|viettelpost|vtp|ghn|ghtk|giao hang|j&t|jnt|van chuyen|ship/, "SHIPPING"],
  [/luong|thuong|hoa hong/, "SALARY"],
  [/mat bang|thue nha|thue kho|tien dien|tien nuoc|internet/, "RENT"],
  [/thung|tui|bang keo|tem|bao bi|dong goi/, "PACKAGING"],
  [/nhap hang|mua hang|tien hang|xuong|vai|nha cung cap|ncc/, "PURCHASE"],
];

export const REFERENCE_PREFIX = "MB ";

export function referenceFor(txn: Pick<LedgerTxn, "bankRef" | "date" | "amount" | "description">) {
  if (txn.bankRef) return `${REFERENCE_PREFIX}${txn.bankRef}`;
  // không có mã GD → khoá theo ngày + số tiền + nội dung (cắt ngắn)
  return `${REFERENCE_PREFIX}${txn.date}:${txn.amount}:${txn.description.slice(0, 40)}`;
}

function toInt(value: unknown) {
  if (typeof value === "number") return Math.round(value);
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toDateKey(value: unknown) {
  const s = String(value ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

/** Phân tích CSV đơn giản (RFC4180, có BOM, xuống dòng \r\n) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function fromJsonRecord(r: Record<string, unknown>): LedgerTxn | null {
  const date = toDateKey(r.txn_date ?? r.date ?? r.ngay);
  if (!date) return null;
  const amount =
    r.amount !== undefined
      ? toInt(r.amount)
      : toInt(r.credit ?? r.tien_vao ?? 0) - toInt(r.debit ?? r.tien_ra ?? 0);
  if (!amount) return null;
  return {
    date,
    time: String(r.txn_time ?? r.time ?? ""),
    amount,
    description: String(r.description ?? r.noi_dung ?? "").trim(),
    counterparty: String(r.counterparty ?? r.doi_tac ?? "").trim(),
    bankRef: String(r.bank_ref ?? r.ref ?? r.ma_gd ?? "").trim(),
    categoryCode: String(r.category_code ?? r.category ?? "").trim() || "CHUA_PHAN_LOAI",
    note: String(r.note ?? "").trim(),
  };
}

function fromCsvRows(rows: string[][]): LedgerTxn[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => normalize(h).trim());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(normalize(n).trim());
      if (i >= 0) return i;
    }
    return -1;
  };
  const cDate = col("Ngày", "date", "txn_date", "Ngày giao dịch");
  const cTime = col("Giờ", "time", "txn_time");
  const cIn = col("Tiền vào", "credit", "Ghi có");
  const cOut = col("Tiền ra", "debit", "Ghi nợ");
  const cAmount = col("amount", "Số tiền");
  const cDesc = col("Nội dung", "description", "Diễn giải", "Mô tả");
  const cParty = col("Đối tác", "counterparty", "Đối ứng");
  const cRef = col("Mã GD", "bank_ref", "Số tham chiếu", "Mã giao dịch");
  const cCat = col("Mã danh mục", "category_code");
  const cNote = col("Ghi chú", "note");
  if (cDate < 0 || (cAmount < 0 && cIn < 0 && cOut < 0)) return [];
  const out: LedgerTxn[] = [];
  for (const r of rows.slice(1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const date = toDateKey(get(cDate));
    if (!date) continue;
    const amount = cAmount >= 0 ? toInt(get(cAmount)) : toInt(get(cIn)) - toInt(get(cOut));
    if (!amount) continue;
    out.push({
      date,
      time: get(cTime),
      amount,
      description: get(cDesc),
      counterparty: get(cParty),
      bankRef: get(cRef),
      categoryCode: get(cCat) || "CHUA_PHAN_LOAI",
      note: get(cNote),
    });
  }
  return out;
}

/** Nhận JSON hoặc CSV; trả về danh sách giao dịch đã chuẩn hoá (ném lỗi nếu không đọc được). */
export function parseLedger(text: string): LedgerTxn[] {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new Error("File trống");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error("JSON không hợp lệ");
    }
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { transactions?: unknown }).transactions)
        ? ((data as { transactions: unknown[] }).transactions)
        : null;
    if (!list) throw new Error("JSON cần là mảng giao dịch hoặc có trường transactions");
    return list
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map(fromJsonRecord)
      .filter((t): t is LedgerTxn => !!t);
  }
  const rows = fromCsvRows(parseCsv(trimmed));
  if (!rows.length) throw new Error("Không nhận ra cột Ngày / Tiền vào / Tiền ra trong CSV");
  return rows;
}

export type EmployeeHint = { name: string; shortName?: string };

/** Đoán nhóm chi phí ERP cho một giao dịch tiền ra */
export function suggestCategory(
  txn: LedgerTxn,
  employees: EmployeeHint[] = [],
): { category: ExpenseCategory; source: PlannedRow["categorySource"] } {
  const mapped = LEDGER_TO_ERP[txn.categoryCode];
  if (mapped && mapped !== "SKIP") return { category: mapped, source: "ledger" };
  const party = normalize(txn.counterparty);
  if (party.trim()) {
    for (const e of employees) {
      const full = normalize(e.name).trim();
      if (full && party.includes(` ${full} `)) return { category: "SALARY", source: "employee" };
    }
  }
  const hay = normalize(`${txn.counterparty} ${txn.description} ${txn.note}`);
  for (const [re, category] of KEYWORDS) if (re.test(hay)) return { category, source: "keyword" };
  if (-txn.amount >= PURCHASE_THRESHOLD) return { category: "PURCHASE", source: "amount" };
  return { category: "OTHER", source: "default" };
}

function cleanDescription(txn: LedgerTxn) {
  // bỏ tiền tố "CUSTOMER", "MBCT", đuôi "TU:/DEN:" lặp lại tên đối tác
  let d = txn.description.replace(/^CUSTOMER\s+/i, "").replace(/^MBCT\s+/i, "").replace(/\.\s*(TU|DEN):.*$/i, "").trim();
  if (!d) d = "Chuyển khoản";
  const party = txn.counterparty.trim();
  const text = party ? `${party} · ${d}` : d;
  return (txn.note ? `${text} (${txn.note})` : text).slice(0, 500);
}

/** Lập kế hoạch nhập: đánh dấu trùng, tiền vào, không tính lãi/lỗ; đoán nhóm cho các dòng mới. */
export function planImport(txns: LedgerTxn[], existingReferences: Iterable<string>, employees: EmployeeHint[] = []): PlannedRow[] {
  const existing = new Set(existingReferences);
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];
  for (const txn of txns) {
    const reference = referenceFor(txn);
    const mapped = LEDGER_TO_ERP[txn.categoryCode];
    let status: PlanStatus = "new";
    if (txn.amount > 0) status = "inflow";
    else if (mapped === "SKIP") status = "non_pl";
    else if (existing.has(reference) || seen.has(reference)) status = "duplicate";
    seen.add(reference);
    const guess = txn.amount < 0 ? suggestCategory(txn, employees) : { category: "OTHER" as ExpenseCategory, source: "default" as const };
    rows.push({
      key: reference,
      bankRef: txn.bankRef,
      date: txn.date,
      amount: Math.abs(txn.amount),
      counterparty: txn.counterparty,
      description: cleanDescription(txn),
      raw: txn.description,
      ledgerCategory: txn.categoryCode,
      category: guess.category,
      categorySource: guess.source,
      status,
      reference,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  new: "Sẽ nhập",
  duplicate: "Đã có trong ERP",
  inflow: "Tiền vào (bỏ qua)",
  non_pl: "Không tính lãi/lỗ (bỏ qua)",
};
