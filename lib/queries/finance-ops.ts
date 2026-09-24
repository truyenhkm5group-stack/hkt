/**
 * ═══════ HÀNG ĐỢI TÁC VỤ TÀI CHÍNH ═══════
 *
 * Sổ ngân hàng giờ nhận giao dịch REALTIME (SePay). Chỗ hụt không còn là THIẾU DỮ LIỆU mà là THỪA
 * VIỆC: mỗi dòng tiền vào/ra đều cần một người quyết "đây là khoản gì, có chứng từ nào không". Trước
 * đây việc đó nằm rải rác ở năm trang khác nhau (Sổ ngân hàng → ba tab, Chi phí, Đối soát COD, Lương,
 * Tài khoản ngân hàng) và không ai thấy hết một lượt.
 *
 * Tệp này KHÔNG phát minh luật mới, KHÔNG tạo bảng mới. Nó chỉ GOM LẠI đúng những việc còn treo mà
 * các truy vấn đã có (`lib/queries/bank.ts`, `lib/queries/bank-match.ts`) đang tính, cộng thêm vài
 * lát cắt còn thiếu (khoản chi chưa có chứng từ tiền, khoản tiền đã phân loại nhưng chưa nối chứng
 * từ, gợi ý ghép cặp chuyển nội bộ, gợi ý nhân sự theo tên). Hành động ghi dữ liệu vẫn đi qua ĐÚNG
 * các Server Action đã có ở `lib/actions/bank.ts` / `lib/actions/expenses.ts` — không có action ghi
 * nào mới ngoài một hàm TÌM KIẾM chứng từ để nối tay (`lib/actions/finance-ops.ts`).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BANK_GROUP_SPEC, BANK_GROUPS, type BankGroup } from "@/lib/constants/bank";
import { codMatchStatus, matchEmployeeByText, rankBankExceptions, type FinanceOpsCodStatus } from "@/lib/constants/finance-ops";
import { matchInternalTransferPairs, type InternalTransferTxn } from "@/lib/integrations/bank/internal-transfer";
import { getMatchOverview } from "@/lib/queries/bank-match";
import { expenseUnpaidCond } from "@/lib/queries/expense-payment";
import { listBankAccounts, type BankAccountRow } from "@/lib/queries/bank";
import { listEmployees } from "@/lib/queries/payroll";

const b = schema.bankTransactions;

function rowsOf<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Nhóm kế toán CÓ chứng từ để nối tới bảng Chi phí — đúng những nhóm `BANK_GROUP_SPEC[g].linkTo === "EXPENSE"`. */
const EXPENSE_LINKABLE_GROUPS = BANK_GROUPS.filter((g) => BANK_GROUP_SPEC[g].linkTo === "EXPENSE");
const PAYROLL_GROUPS: BankGroup[] = ["PAYROLL_SALARY", "PAYROLL_COMMISSION"];

export type QueueBankTxnRow = {
  id: string;
  txnAt: Date;
  amount: number;
  description: string;
  counterparty: string;
  bankRef: string;
  accountingGroup: string;
  categoryCode: string;
  note: string;
  classifiedBy: string;
  source: string;
  ruleId: string | null;
  linkedType: string;
  linkedId: string;
  linked: boolean;
};

/** Đúng bộ cột của `listBankTransactions` (lib/queries/bank.ts) để dùng lại được `RuleFromTxnButton` mà không phải sửa nó. */
const TXN_COLUMNS = {
  id: b.id,
  txnAt: b.txnAt,
  amount: b.amount,
  description: b.description,
  counterparty: b.counterparty,
  bankRef: b.bankRef,
  accountingGroup: b.accountingGroup,
  categoryCode: b.categoryCode,
  note: b.note,
  classifiedBy: b.classifiedBy,
  source: b.source,
  ruleId: b.ruleId,
  linkedType: b.linkedType,
  linkedId: b.linkedId,
  linked: sql<boolean>`${b.linkedType} <> ''`,
};

export type EmployeeSuggestion = { id: string; name: string } | null;

export type UnclassifiedBankRow = QueueBankTxnRow & { employeeSuggestion: EmployeeSuggestion };

/**
 * Trần số dòng được CHẤM ĐIỂM trong một lượt. Chấm điểm cần cả tập (điểm là hàm của tiền VÀ tuổi,
 * không có một cột SQL nào sắp theo nó được mà không chép công thức vào SQL), nên lượt đầu chỉ đọc
 * ba cột nhẹ. Vượt trần thì `truncated` nói ra — không cắt im lặng.
 */
export const UNCLASSIFIED_SCAN_CAP = 20_000;

export type UnclassifiedBankQueue = {
  rows: UnclassifiedBankRow[];
  /** Tổng số dòng chưa phân loại (không bị trần). */
  total: number;
  /** `true` = có hơn `UNCLASSIFIED_SCAN_CAP` dòng; thứ tự chỉ đúng trong phần đã đọc. */
  truncated: boolean;
};

/**
 * Giao dịch CHƯA phân loại — cả hai chiều tiền, xếp theo `rankBankExceptions` (tiền đang treo ×
 * số ngày treo, xem `lib/constants/finance-ops.ts`). Tiền ra thêm gợi ý nhân sự nếu tên/bí danh khớp.
 *
 * `order: "recent"` giữ thứ tự cũ (mới nhất trước) cho nơi cần quét theo thời gian chứ không theo
 * mức ưu tiên — hiện là gợi ý lương theo bí danh.
 */
export async function unclassifiedBankQueue(limit = 100, opts: { now?: Date; order?: "priority" | "recent" } = {}): Promise<UnclassifiedBankQueue> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const [light, [countRow], employees] = await Promise.all([
    opts.order === "recent"
      ? db.select({ id: b.id, amount: b.amount, txnAt: b.txnAt }).from(b).where(eq(b.accountingGroup, "UNCLASSIFIED")).orderBy(desc(b.txnAt)).limit(limit)
      : // Vượt trần thì phần bị bỏ là các khoản NHỎ NHẤT — không phải các khoản cũ nhất, vốn đã chạm trần tuổi.
        db.select({ id: b.id, amount: b.amount, txnAt: b.txnAt }).from(b).where(eq(b.accountingGroup, "UNCLASSIFIED")).orderBy(desc(sql`abs(${b.amount})`), b.id).limit(UNCLASSIFIED_SCAN_CAP),
    db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.accountingGroup, "UNCLASSIFIED")),
    listEmployees(),
  ]);
  const picked = (opts.order === "recent" ? light : rankBankExceptions(light, now)).slice(0, limit);
  const full = picked.length ? await db.select(TXN_COLUMNS).from(b).where(inArray(b.id, picked.map((r) => r.id))) : [];
  const byId = new Map(full.map((r) => [r.id, r]));
  const rows = picked
    .map((p) => byId.get(p.id))
    // Dòng vừa được phân loại giữa hai lượt đọc thì không còn ở lượt hai — bỏ, không hiện nửa dòng.
    .filter((r): r is QueueBankTxnRow => r !== undefined)
    .map((r) => ({ ...r, employeeSuggestion: r.amount < 0 ? matchEmployeeByText(`${r.counterparty} ${r.description}`, employees) : null }));
  const total = Number(countRow?.n ?? 0);
  return { rows, total, truncated: total > UNCLASSIFIED_SCAN_CAP };
}

export async function unclassifiedBankRows(limit = 100, opts: { now?: Date; order?: "priority" | "recent" } = {}): Promise<UnclassifiedBankRow[]> {
  return (await unclassifiedBankQueue(limit, opts)).rows;
}

export type ExpenseNoPaymentRow = { id: string; description: string; amount: number; occurredAt: Date; category: string; reference: string };

/**
 * Khoản chi đã ghi sổ nhưng CHƯA có dòng sao kê nào nối tới — nghĩa là chưa có bằng chứng tiền đã
 * thật sự ra khỏi tài khoản cho khoản này (hoặc bằng chứng đó chưa được nối).
 */
export async function expensesWithoutPayment(limit = 100): Promise<ExpenseNoPaymentRow[]> {
  const db = await getDb();
  const rows = rowsOf<{ id: string; description: string; amount: string | number; occurred_at: string; category: string; reference: string }>(
    await db.execute(sql`
      select e.id, e.description, e.amount, e.occurred_at, e.category, e.reference
      from expenses e
      -- Mệnh đề "chưa có tiền nối vào" dùng CHUNG với Tổng quan tài chính (lib/queries/expense-payment.ts).
      where ${expenseUnpaidCond("e")}
      order by e.occurred_at desc
      limit ${limit}
    `),
  );
  return rows.map((r) => ({ id: r.id, description: r.description, amount: Number(r.amount), occurredAt: new Date(r.occurred_at), category: r.category, reference: r.reference }));
}

export async function countExpensesWithoutPayment(): Promise<number> {
  const db = await getDb();
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from expenses e where ${expenseUnpaidCond("e")}`),
  );
  return Number(row?.n ?? 0);
}

/** Dòng sao kê đã gán nhóm chi phí (nhóm mà `BANK_GROUP_SPEC.linkTo === "EXPENSE"`) nhưng CHƯA nối tới khoản chi nào. */
export async function paymentsWithoutExpense(limit = 100): Promise<QueueBankTxnRow[]> {
  const db = await getDb();
  return db
    .select(TXN_COLUMNS)
    .from(b)
    .where(and(inArray(b.accountingGroup, EXPENSE_LINKABLE_GROUPS), eq(b.linkedType, "")))
    .orderBy(desc(b.txnAt))
    .limit(limit);
}

export async function countPaymentsWithoutExpense(): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(b).where(and(inArray(b.accountingGroup, EXPENSE_LINKABLE_GROUPS), eq(b.linkedType, "")));
  return Number(row?.n ?? 0);
}

export type PayrollQueueReason = "CLASSIFIED_NOT_LINKED" | "ALIAS_MATCH";
export type PayrollQueueRow = QueueBankTxnRow & { reason: PayrollQueueReason; employeeSuggestion: EmployeeSuggestion };

/**
 * Hai loại việc lương/hoa hồng còn treo: (a) ĐÃ gán nhóm Lương/Hoa hồng nhưng chưa nối khoản chi nào
 * — thiếu bằng chứng đối chiếu; (b) CHƯA phân loại nhưng tên/bí danh trong nội dung khớp một nhân sự
 * đã khai ở trang Lương — gợi ý phân loại, không tự gán.
 */
export async function payrollUnmatched(limit = 100): Promise<PayrollQueueRow[]> {
  const db = await getDb();
  const [classified, unclassified] = await Promise.all([
    db.select(TXN_COLUMNS).from(b).where(and(inArray(b.accountingGroup, PAYROLL_GROUPS), eq(b.linkedType, ""))).orderBy(desc(b.txnAt)).limit(limit),
    // Gợi ý lương quét theo THỜI GIAN (lương trả theo kỳ), không theo mức ưu tiên tiền.
    unclassifiedBankRows(limit, { order: "recent" }),
  ]);
  const a: PayrollQueueRow[] = classified.map((r) => ({ ...r, reason: "CLASSIFIED_NOT_LINKED", employeeSuggestion: null }));
  const bRows: PayrollQueueRow[] = unclassified.filter((r) => r.employeeSuggestion).map((r) => ({ ...r, reason: "ALIAS_MATCH" }));
  return [...a, ...bRows].sort((x, y) => y.txnAt.getTime() - x.txnAt.getTime()).slice(0, limit);
}

/** Tài khoản ngân hàng đang chờ chủ shop / quản trị xác nhận — ERP tự khai để không mất giao dịch, nhưng không tự đặt ACTIVE. */
export async function unconfirmedAccountRows(): Promise<BankAccountRow[]> {
  const all = await listBankAccounts();
  return all.filter((a) => a.status === "UNCONFIRMED");
}

export type InternalTransferQueueRow = {
  out: QueueBankTxnRow;
  in: QueueBankTxnRow;
  amount: number;
  dayDiff: number;
  reasons: string[];
};

/** Cặp tiền ra/tiền vào CHƯA phân loại, cùng số tiền, khác tài khoản — nghi ngờ là chuyển nội bộ. */
export async function internalTransferCandidateRows(limit = 200): Promise<InternalTransferQueueRow[]> {
  const db = await getDb();
  const rows = await db
    .select({ ...TXN_COLUMNS, bankAccountId: b.bankAccountId })
    .from(b)
    .where(and(eq(b.accountingGroup, "UNCLASSIFIED"), sql`${b.bankAccountId} is not null`))
    .orderBy(desc(b.txnAt))
    .limit(limit);
  const txns: InternalTransferTxn[] = rows.map((r) => ({ id: r.id, amount: r.amount, txnAt: r.txnAt, bankAccountId: r.bankAccountId }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return matchInternalTransferPairs(txns)
    .map((p) => {
      const out = byId.get(p.outId);
      const inn = byId.get(p.inId);
      if (!out || !inn) return null;
      const row: InternalTransferQueueRow = { out, in: inn, amount: p.amount, dayDiff: p.dayDiff, reasons: p.reasons };
      return row;
    })
    .filter((x): x is InternalTransferQueueRow => x !== null);
}

export type CodQueueRow = {
  txnId: string;
  txnAt: Date;
  bankAmount: number;
  description: string;
  counterparty: string;
  status: FinanceOpsCodStatus;
  settlementAmount: number | null;
  difference: number | null;
  reference: string | null;
  reasons: string[];
  target: { type: "EXPENSE" | "COD_BATCH" | "STOCK_RECEIPT" | "AD_SPEND"; id: string; label: string; amount: number } | null;
  others: { type: "EXPENSE" | "COD_BATCH" | "STOCK_RECEIPT" | "AD_SPEND"; id: string; label: string; amount: number }[];
};

/**
 * BANK → COD: tiền vào từ ĐVVC được gợi ý đối khớp với đợt COD (`getMatchOverview` đã tính sẵn), quy
 * đổi sang bốn trạng thái MATCHED / PARTIAL / UNMATCHED / REVIEW. Không tạo doanh thu mới — chỉ đối
 * chiếu tiền về với đợt COD đã có.
 */
export async function codMatchQueue(limit = 100): Promise<{ rows: CodQueueRow[]; counts: Record<FinanceOpsCodStatus, number> }> {
  const overview = await getMatchOverview(limit);
  const counts: Record<FinanceOpsCodStatus, number> = { MATCHED: 0, PARTIAL: 0, UNMATCHED: 0, REVIEW: 0 };
  const rows: CodQueueRow[] = overview.suggestions
    .filter((s) => s.amount > 0)
    .map((s) => {
      const r = codMatchStatus(s.amount, { confidence: s.confidence, target: s.target, others: s.others });
      counts[r.status] += 1;
      const single = s.target ?? (s.others.length === 1 ? s.others[0] : null);
      return {
        txnId: s.txnId,
        txnAt: s.txnAt,
        bankAmount: s.amount,
        description: s.description,
        counterparty: s.counterparty,
        status: r.status,
        settlementAmount: single?.amount ?? null,
        difference: r.difference,
        reference: single?.label ?? null,
        reasons: s.reasons,
        target: s.target,
        others: s.others,
      };
    });
  return { rows, counts };
}

export type LinkCandidate = { id: string; label: string; amount: number; at: Date };

/** Tìm khoản chi để nối tay — dùng cho hộp thoại "Liên kết khoản có sẵn" của hàng đợi. */
export async function searchExpensesForLink(q: string, limit = 20): Promise<LinkCandidate[]> {
  const db = await getDb();
  const term = q.trim();
  const rows = rowsOf<{ id: string; description: string; amount: string | number; occurred_at: string; reference: string }>(
    await db.execute(
      term
        ? sql`select id, description, amount, occurred_at, reference from expenses where description ilike ${`%${term}%`} or reference ilike ${`%${term}%`} order by occurred_at desc limit ${limit}`
        : sql`select id, description, amount, occurred_at, reference from expenses order by occurred_at desc limit ${limit}`,
    ),
  );
  return rows.map((r) => ({ id: r.id, label: r.reference ? `${r.description} · ${r.reference}` : r.description, amount: Number(r.amount), at: new Date(r.occurred_at) }));
}

/** Tìm đợt COD để nối tay — dùng cho hộp thoại "Liên kết khoản có sẵn" phía tiền vào. */
export async function searchCodBatchesForLink(q: string, limit = 20): Promise<LinkCandidate[]> {
  const db = await getDb();
  const term = q.trim();
  const rows = rowsOf<{ id: string; reference: string; total_amount: string | number; received_at: string }>(
    await db.execute(
      term
        ? sql`select id, reference, total_amount, received_at from cod_batches where reference ilike ${`%${term}%`} order by received_at desc limit ${limit}`
        : sql`select id, reference, total_amount, received_at from cod_batches order by received_at desc limit ${limit}`,
    ),
  );
  return rows.map((r) => ({ id: r.id, label: r.reference || r.id, amount: Number(r.total_amount), at: new Date(r.received_at) }));
}

export type FinanceQueueCounts = {
  unclassified: number;
  cod: Record<FinanceOpsCodStatus, number>;
  expenseNoPayment: number;
  paymentNoExpense: number;
  payrollUnmatched: number;
  accountUnconfirmed: number;
  internalTransferCandidates: number;
};

/** Số đếm gọn cho dải chỉ số đầu trang — mỗi số trỏ đúng về phần việc của nó. */
export async function getFinanceQueueCounts(): Promise<FinanceQueueCounts> {
  const db = await getDb();
  const [[unclassifiedRow], expenseNoPayment, paymentNoExpense, cod, accounts, transfers] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.accountingGroup, "UNCLASSIFIED")),
    countExpensesWithoutPayment(),
    countPaymentsWithoutExpense(),
    codMatchQueue(200),
    unconfirmedAccountRows(),
    internalTransferCandidateRows(200),
  ]);
  const [payrollRow] = await db.select({ n: sql<number>`count(*)` }).from(b).where(and(inArray(b.accountingGroup, PAYROLL_GROUPS), eq(b.linkedType, "")));
  return {
    unclassified: Number(unclassifiedRow?.n ?? 0),
    cod: cod.counts,
    expenseNoPayment,
    paymentNoExpense,
    payrollUnmatched: Number(payrollRow?.n ?? 0),
    accountUnconfirmed: accounts.length,
    internalTransferCandidates: transfers.length,
  };
}
