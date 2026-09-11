/**
 * Nhập sao kê ngân hàng (app "HKT · Quản lý giao dịch MB Bank") vào chi phí ERP.
 * Hỗ trợ:
 *  - JSON: `{ transactions: [...] }` (window.HKT_SEED / bản sao lưu) hoặc mảng giao dịch
 *  - CSV "Xuất CSV" của app: Ngày, Giờ, Tiền vào, Tiền ra, Nội dung, Đối tác, Mã GD, Số dư, Mã danh mục, …
 * Chỉ tiền RA thuộc nhóm chi phí VẬN HÀNH mới thành chi phí; tiền vào, các khoản không tính lãi/lỗ
 * (chuyển nội bộ, trả nợ gốc, rút vốn…), quảng cáo (đã lấy từ tài khoản QC) và nhập hàng (đã nằm trong giá vốn)
 * được bỏ qua và báo lại cho người dùng.
 */
import type { ExpenseCategory } from "@/db/schema";
import { normalize } from "@/lib/text";

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

export type PlanStatus = "new" | "duplicate" | "inflow" | "non_pl" | "not_operating";

/** Nhóm không nhập từ sao kê: quảng cáo đã lấy từ tài khoản QC, nhập hàng đã nằm trong giá vốn / phiếu nhập */
export const NON_OPERATING_CATEGORIES: ExpenseCategory[] = ["ADS", "PURCHASE"];

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
  const s = String(value ?? "").trim();
  if (!s) return 0;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  // Sao kê Việt Nam dùng CẢ HAI dấu phân nhóm nghìn: MB Bank ghi "3,122,361", Viettel Post ghi
  // "3.122.361". Number("3.122.361") = NaN nên phải bỏ hết dấu phân cách rồi mới đổi sang số;
  // đọc hỏng một cột tiền thì cả sao kê lệch mà không có dấu hiệu gì trên giao diện.
  const negative = s.startsWith("-") || /^\(.*\)$/.test(s);
  const digits = s.replace(/\D/g, "");
  if (!digits) return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toDateKey(value: unknown) {
  // Excel trả ô ngày dưới dạng Date khi đọc với cellDates — không được ép sang chuỗi rồi dò regex
  // vì "Wed Aug 05 2026" không khớp mẫu nào và cả tệp sẽ thành "không có giao dịch nào".
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate());
  }
  const s = String(value ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  return "";
}

/** Giờ trong ô. Sao kê MB gộp ngày và giờ vào MỘT ô ("05/08/2026 14:08:08") nên không có cột Giờ riêng. */
function toTimeKey(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return pad2(value.getHours()) + ":" + pad2(value.getMinutes());
  }
  const m = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, "0") + ":" + m[2] : "";
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

/**
 * Tên cột của MỌI định dạng sao kê ERP đọc được, khớp chính xác sau khi bỏ dấu.
 *
 * Ngoài bản "Xuất CSV" của app quản lý giao dịch còn có SAO KÊ CHÍNH THỨC ngân hàng gửi
 * (MB Bank: "Ngày giao dịch · Số bút toán · Phát sinh nợ · Phát sinh có · Số dư lũy kế · Nội dung ·
 * Đơn vị thụ hưởng/ Đơn vị chuyển"), kèm một dòng tiêu đề tiếng Anh ngay dưới. Nhận cả hai dòng để
 * không phụ thuộc vào việc ngân hàng đổi thứ tự chúng.
 */
const COLUMN_NAMES = {
  date: ["Ngày", "date", "txn_date", "Ngày giao dịch", "Transaction date", "Ngày GD"],
  time: ["Giờ", "time", "txn_time"],
  credit: ["Tiền vào", "credit", "Ghi có", "Phát sinh có", "Credit", "Số tiền ghi có"],
  debit: ["Tiền ra", "debit", "Ghi nợ", "Phát sinh nợ", "Debit", "Số tiền ghi nợ"],
  amount: ["amount", "Số tiền"],
  balance: ["Số dư lũy kế", "Accumulated balance", "Số dư", "Số dư cuối"],
  description: ["Nội dung", "description", "Diễn giải", "Mô tả", "Details", "Nội dung giao dịch"],
  counterparty: [
    "Đối tác",
    "counterparty",
    "Đối ứng",
    "Đơn vị thụ hưởng/ Đơn vị chuyển",
    "Beneficiary/Applicant",
    "Người thụ hưởng",
    "Tên đối tác",
  ],
  bankRef: ["Mã GD", "bank_ref", "Số tham chiếu", "Mã giao dịch", "Số bút toán", "Transaction No", "Số GD"],
  categoryCode: ["Mã danh mục", "category_code"],
  note: ["Ghi chú", "note"],
} as const;

type ColumnIndex = Record<keyof typeof COLUMN_NAMES, number>;
export type StatementHeader = { row: number; index: ColumnIndex };

/**
 * Sao kê chính thức có mười mấy dòng đầu thư trước bảng (tên chủ tài khoản, số tài khoản, số dư đầu
 * kỳ, lời chào song ngữ). Coi dòng ĐẦU TỆP là tiêu đề — như bản cũ — thì mọi sao kê ngân hàng gửi
 * đều bị từ chối bằng đúng một câu "không nhận ra cột", và đó chính là lỗi chủ shop gặp.
 */
const HEADER_SCAN_ROWS = 40;

export function findHeader(rows: unknown[][]): StatementHeader | null {
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const cells = (rows[r] ?? []).map((c) => normalize(String(c ?? "")).trim());
    const at = (names: readonly string[]) => {
      for (const n of names) {
        const i = cells.indexOf(normalize(n).trim());
        if (i >= 0) return i;
      }
      return -1;
    };
    const index = Object.fromEntries(Object.entries(COLUMN_NAMES).map(([k, names]) => [k, at(names)])) as ColumnIndex;
    if (index.date >= 0 && (index.amount >= 0 || index.credit >= 0 || index.debit >= 0)) return { row: r, index };
  }
  return null;
}

function cellAt(row: unknown[], i: number): unknown {
  return i >= 0 ? row[i] : "";
}

/**
 * KÝ HIỆU Ô TRỐNG CỦA TRÌNH XUẤT CSV.
 *
 * MB Bank xuất .csv ghi literal "37" vào MỌI ô trống — cả ô tiền lẫn ô chữ (ngân hàng đối tác, số
 * tài khoản). Bản .xlsx của CÙNG một sao kê để ô rỗng, nên đây là lỗi của trình xuất CSV chứ không
 * phải dữ liệu. Đọc thẳng thì mỗi giao dịch lệch 37₫: quá nhỏ để ai soi ra bằng mắt, nhưng sổ sẽ
 * không bao giờ khớp số dư ngân hàng.
 *
 * Chỉ coi "37" là ô trống khi CHÍNH TỆP tự tố cáo, theo một trong hai bằng chứng dưới đây. Không có
 * bằng chứng thì 37 vẫn là số tiền thật — thà nhập thừa 37₫ còn hơn tự ý bỏ một khoản có thật.
 */
const BLANK_MARKER = "37";

function balanceMismatches(rows: unknown[][], h: ColumnIndex, blank: string | null): number | null {
  if (h.balance < 0 || (h.credit < 0 && h.debit < 0)) return null;
  let previous: number | null = null;
  let checked = 0;
  let bad = 0;
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    if (!toDateKey(cellAt(row, h.date))) continue;
    const money = (i: number) => {
      const v = cell(i);
      return !v || v === blank ? 0 : toInt(v);
    };
    const useAmount = h.amount >= 0 && cell(h.amount) !== "" && cell(h.amount) !== blank;
    const delta = useAmount ? money(h.amount) : money(h.credit) - money(h.debit);
    const shown = cell(h.balance);
    if (!shown || shown === blank) {
      previous = null;
      continue;
    }
    const current = toInt(shown);
    if (previous !== null) {
      checked += 1;
      if (current - previous !== delta) bad += 1;
    }
    previous = current;
  }
  return checked >= 3 ? bad : null;
}

function blankMarkerOf(rows: unknown[][], h: ColumnIndex): string | null {
  // Bằng chứng 1: "37" đứng ở cột CHỮ. Không ngân hàng nào tên "37", không số tài khoản nào là "37".
  const numeric = new Set([h.amount, h.credit, h.debit, h.balance, h.date, h.time]);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (numeric.has(c)) continue;
      if (String(row[c] ?? "").trim() === BLANK_MARKER) return BLANK_MARKER;
    }
  }
  // Bằng chứng 2: bỏ "37" đi thì cột SỐ DƯ LŨY KẾ của chính ngân hàng mới khớp chênh lệch từng dòng.
  const asIs = balanceMismatches(rows, h, null);
  const asBlank = balanceMismatches(rows, h, BLANK_MARKER);
  return asIs !== null && asBlank !== null && asBlank < asIs ? BLANK_MARKER : null;
}

/** Ma trận ô (CSV đã tách hoặc sheet Excel) → danh sách giao dịch đã chuẩn hoá. */
export function rowsToLedgerTxns(rows: unknown[][]): LedgerTxn[] {
  const header = findHeader(rows);
  if (!header) return [];
  const h = header.index;
  const body = rows.slice(header.row + 1);
  const blank = blankMarkerOf(body, h);
  const out: LedgerTxn[] = [];
  for (const row of body) {
    const text = (i: number) => {
      const v = i >= 0 ? String(row[i] ?? "").trim() : "";
      return v === blank ? "" : v;
    };
    const money = (i: number) => {
      const v = text(i);
      return v ? toInt(v) : 0;
    };
    // Dòng tiêu đề tiếng Anh, dòng "Tổng phát sinh trong kỳ", dòng số dư cuối kỳ và các dòng trắng
    // đều không có ngày hợp lệ nên tự rụng ở đây — không cần danh sách gõ tay các dòng phải bỏ.
    const date = toDateKey(cellAt(row, h.date));
    if (!date) continue;
    const amount = h.amount >= 0 && text(h.amount) ? money(h.amount) : money(h.credit) - money(h.debit);
    if (!amount) continue;
    out.push({
      date,
      time: toTimeKey(cellAt(row, h.time)) || toTimeKey(cellAt(row, h.date)),
      amount,
      description: text(h.description),
      counterparty: text(h.counterparty),
      bankRef: text(h.bankRef),
      categoryCode: text(h.categoryCode) || "CHUA_PHAN_LOAI",
      note: text(h.note),
    });
  }
  return out;
}

export const CSV_HEADER_HINT =
  'Không nhận ra dòng tiêu đề. Cần một cột ngày ("Ngày giao dịch" hoặc "Ngày") và cột tiền ("Phát sinh nợ" + "Phát sinh có", hoặc "Tiền ra" + "Tiền vào"). Sao kê MB Bank tải từ app / Internet Banking dùng được nguyên bản, cả .csv lẫn .xlsx.';

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
  const grid = parseCsv(trimmed);
  const txns = rowsToLedgerTxns(grid);
  if (!txns.length) throw new Error(findHeader(grid) ? "Đọc được dòng tiêu đề nhưng không có giao dịch nào bên dưới" : CSV_HEADER_HINT);
  return txns;
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
    if (status === "new" && NON_OPERATING_CATEGORIES.includes(guess.category)) status = "not_operating";
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
  not_operating: "CPQC / nhập hàng (không nhập, đã lấy từ nguồn khác)",
};
