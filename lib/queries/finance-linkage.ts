/**
 * ═══════════ ĐỌC MỐI NỐI GIỮA TIỀN THẬT VÀ CHỨNG TỪ ═══════════
 *
 * Hợp đồng: `docs/finance-truth-contract.md`. Hằng số: `lib/constants/finance-truth.ts`.
 * Phép GHI nằm ở `lib/finance/linkage.ts` — `lib/queries/*` là chỉ-đọc (AGENTS.md mục 2), và
 * `tests/advisory-safety.test.ts` khoá ranh giới đó ở mức mã nguồn.
 *
 * Nửa quan trọng nhất của tệp này là `settledAmountByTarget`: trước nó, sổ chi phí biết kỳ nào nợ
 * bao nhiêu và sổ tiền biết đồng nào đã đi, nhưng KHÔNG AI trả lời được "khoản chi này đã trả chưa".
 *
 * ĐỌC MỐI NỐI KHÔNG PHẢI ĐỌC CHI PHÍ. Số tiền ở đây là phần TIỀN THẬT đã phủ lên một chứng từ, không
 * phải bản thân khoản chi — cộng nó vào báo cáo nào là đếm đôi.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { allocationOf, PAYROLL_PERIOD_RE, type Allocation, type LinkConfidence, type LinkMethod, type LinkTargetType } from "@/lib/constants/finance-truth";

const b = schema.bankTransactions;
const l = schema.bankTransactionLinks;

export type FinanceLink = {
  id: string;
  txnId: string;
  targetType: LinkTargetType;
  targetId: string;
  amount: number;
  confidence: LinkConfidence;
  method: LinkMethod;
  confirmedBy: string;
  confirmedAt: Date;
  note: string;
};

function toLink(r: typeof schema.bankTransactionLinks.$inferSelect): FinanceLink {
  return {
    id: r.id,
    txnId: r.txnId,
    targetType: r.targetType as LinkTargetType,
    targetId: r.targetId,
    amount: Number(r.amount),
    confidence: r.confidence as LinkConfidence,
    method: r.method as LinkMethod,
    confirmedBy: r.confirmedBy,
    confirmedAt: r.confirmedAt,
    note: r.note,
  };
}

/** Mối nối của một tập dòng tiền, gom theo `txnId`. */
export async function linksByTxn(txnIds: readonly string[], dbIn?: Db): Promise<Map<string, FinanceLink[]>> {
  const out = new Map<string, FinanceLink[]>();
  if (!txnIds.length) return out;
  const db = dbIn ?? (await getDb());
  const rows = await db.select().from(l).where(inArray(l.txnId, [...txnIds]));
  for (const r of rows) {
    const link = toLink(r);
    const cur = out.get(link.txnId);
    if (cur) cur.push(link);
    else out.set(link.txnId, [link]);
  }
  return out;
}

/** Tình trạng phân bổ của MỘT dòng tiền: đã nối bao nhiêu, còn lại bao nhiêu. */
export async function txnAllocation(txnId: string, dbIn?: Db): Promise<Allocation & { links: FinanceLink[] }> {
  const db = dbIn ?? (await getDb());
  const [txn] = await db.select({ amount: b.amount }).from(b).where(eq(b.id, txnId));
  const rows = await db.select().from(l).where(eq(l.txnId, txnId));
  const links = rows.map(toLink);
  return { ...allocationOf(Number(txn?.amount ?? 0), links.map((x) => x.amount)), links };
}

/**
 * "Chứng từ này đã được tiền thật phủ bao nhiêu" — tra từ phía CHỨNG TỪ.
 *
 * Đây là nửa còn thiếu của cả bài toán: sổ chi phí biết kỳ nào nợ bao nhiêu, sổ tiền biết đồng nào
 * đã đi, nhưng không ai trả lời được "khoản chi này đã trả chưa" cho tới khi có phép tra này.
 */
export async function settledAmountByTarget(targetType: LinkTargetType, targetIds: readonly string[], dbIn?: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!targetIds.length) return out;
  const db = dbIn ?? (await getDb());
  const rows = await db
    .select({ targetId: l.targetId, amount: sql<number>`coalesce(sum(${l.amount}), 0)` })
    .from(l)
    .where(and(eq(l.targetType, targetType), inArray(l.targetId, [...targetIds])))
    .groupBy(l.targetId);
  for (const r of rows) out.set(r.targetId, Number(r.amount));
  return out;
}

/** Tổng tiền thật đã nối vào một loại chứng từ trong một khoảng NGÀY GIAO DỊCH của dòng tiền. */
export async function settledTotalByType(targetType: LinkTargetType, from: Date | null, to: Date | null, dbIn?: Db): Promise<{ amount: number; links: number }> {
  const db = dbIn ?? (await getDb());
  const conds = [eq(l.targetType, targetType)];
  if (from) conds.push(sql`${b.txnAt} >= ${from}`);
  if (to) conds.push(sql`${b.txnAt} <= ${to}`);
  const [row] = await db
    .select({ amount: sql<number>`coalesce(sum(${l.amount}), 0)`, links: sql<number>`count(*)` })
    .from(l)
    .innerJoin(b, eq(b.id, l.txnId))
    .where(and(...conds));
  return { amount: Number(row?.amount ?? 0), links: Number(row?.links ?? 0) };
}

/**
 * Chứng từ đích có thật không.
 *
 * `PAYROLL_PERIOD` không có bảng để tra — bảng Lương là cấu hình. Khoá tự nhiên là tháng, nên
 * "có thật" ở đây nghĩa là ĐÚNG DẠNG `YYYY-MM`. Nói thẳng giới hạn đó thay vì giả vờ đã kiểm.
 */
export async function targetExists(targetType: LinkTargetType, targetId: string, dbIn?: Db): Promise<boolean> {
  if (targetType === "PAYROLL_PERIOD") return PAYROLL_PERIOD_RE.test(targetId);
  const db = dbIn ?? (await getDb());
  const one = async (rows: Promise<unknown[]>) => (await rows).length > 0;
  if (targetType === "EXPENSE") return one(db.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.id, targetId)).limit(1));
  if (targetType === "COD_BATCH") return one(db.select({ id: schema.codBatches.id }).from(schema.codBatches).where(eq(schema.codBatches.id, targetId)).limit(1));
  if (targetType === "STOCK_RECEIPT") return one(db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, targetId)).limit(1));
  if (targetType === "AD_SPEND") return one(db.select({ id: schema.adSpends.id }).from(schema.adSpends).where(eq(schema.adSpends.id, targetId)).limit(1));
  return one(db.select({ id: b.id }).from(b).where(eq(b.id, targetId)).limit(1));
}

