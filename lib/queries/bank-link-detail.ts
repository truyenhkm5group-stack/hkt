import { inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { LinkTargetType } from "@/lib/constants/finance-truth";
import { formatDate, formatVND } from "@/lib/format";
import { supplierPaymentLabels } from "@/lib/queries/workshop-ledger";

/**
 * ═══════════ DIỄN GIẢI CỦA MỘT DÒNG SAO KÊ — "ĐỒNG TIỀN NÀY LÀ GÌ" ═══════════
 *
 * Chủ shop phàn nàn (25/09/2026) ghi chú trên Sổ ngân hàng "hơi chung chung": một dòng đã đối chiếu chỉ
 * mang nhãn "đã đối chiếu" kèm một mã uuid, còn nội dung là nguyên văn ngân hàng ("MBVCB.123… CK").
 *
 * Tệp này dựng câu diễn giải TỪ CHỨNG TỪ ĐÃ NỐI: "Trả xưởng Hà · Q002 lô 2 · thanh toán tiền công",
 * "Tiền COD Viettel Post · bảng kê BK123 · nhận 20/09", "Lương tháng 09/2026"… Chỉ ĐỌC và tính lúc xem —
 * KHÔNG ghi vào ô ghi chú của người dùng (AGENTS.md mục 17: nhãn người dùng không bị đè), nên câu luôn
 * đúng theo chứng từ hiện tại, kể cả khi chứng từ được sửa sau.
 */

const b = schema.bankTransactions;
const l = schema.bankTransactionLinks;

type Link = { txnId: string; targetType: LinkTargetType; targetId: string; amount: number; note: string };

const thang = (k: string) => {
  const [y, m] = k.split("-");
  return m ? `${m}/${y}` : k;
};

/** Câu diễn giải cho từng chứng từ đích, theo loại. Chứng từ đã bị xoá ⇒ nói ra, không im lặng. */
async function labelsByTarget(links: Link[]): Promise<Map<string, string>> {
  const db = await getDb();
  const ids = (t: LinkTargetType) => [...new Set(links.filter((x) => x.targetType === t).map((x) => x.targetId))];
  const out = new Map<string, string>();
  const key = (t: string, id: string) => `${t}#${id}`;

  const [exp, cod, rc, ads, other, sup] = await Promise.all([
    ids("EXPENSE").length ? db.select({ id: schema.expenses.id, d: schema.expenses.description, at: schema.expenses.occurredAt }).from(schema.expenses).where(inArray(schema.expenses.id, ids("EXPENSE"))) : [],
    ids("COD_BATCH").length ? db.select({ id: schema.codBatches.id, ref: schema.codBatches.reference, carrier: schema.codBatches.carrier, at: schema.codBatches.receivedAt }).from(schema.codBatches).where(inArray(schema.codBatches.id, ids("COD_BATCH"))) : [],
    ids("STOCK_RECEIPT").length
      ? db.select({ id: schema.stockReceipts.id, ref: schema.stockReceipts.reference, supplier: schema.stockReceipts.supplier, qty: schema.stockReceipts.totalQuantity, at: schema.stockReceipts.receivedAt }).from(schema.stockReceipts).where(inArray(schema.stockReceipts.id, ids("STOCK_RECEIPT")))
      : [],
    ids("AD_SPEND").length ? db.select({ id: schema.adSpends.id, acc: schema.adSpends.accountName, at: schema.adSpends.spendDate }).from(schema.adSpends).where(inArray(schema.adSpends.id, ids("AD_SPEND"))) : [],
    ids("BANK_TRANSACTION").length
      ? db
          .select({ id: b.id, ref: b.bankRef, acc: sql<string>`coalesce(nullif(${schema.bankAccounts.label}, ''), ${schema.bankAccounts.gateway}, '')` })
          .from(b)
          .leftJoin(schema.bankAccounts, sql`${schema.bankAccounts.id} = ${b.bankAccountId}`)
          .where(inArray(b.id, ids("BANK_TRANSACTION")))
      : [],
    supplierPaymentLabels(ids("SUPPLIER_PAYMENT")),
  ]);
  for (const r of exp) out.set(key("EXPENSE", r.id), `Chi phí · ${r.d || "(không mô tả)"} · ${formatDate(r.at)}`);
  for (const r of cod) out.set(key("COD_BATCH", r.id), `Tiền COD ${r.carrier} · ${r.ref || "(không số bảng kê)"} · nhận ${formatDate(r.at)}`);
  for (const r of rc) out.set(key("STOCK_RECEIPT", r.id), `Phiếu nhập ${r.ref || ""}${r.supplier ? ` · ${r.supplier}` : ""} · ${r.qty} cái · ${formatDate(r.at)}`.replace("Phiếu nhập  ·", "Phiếu nhập ·"));
  for (const r of ads) out.set(key("AD_SPEND", r.id), `Quảng cáo · ${r.acc || "tài khoản QC"} · ngày ${formatDate(r.at)}`);
  for (const r of other) out.set(key("BANK_TRANSACTION", r.id), `Chuyển nội bộ ↔ ${r.acc || "tài khoản khác"} · ${r.ref}`);
  for (const [id, text] of sup) out.set(key("SUPPLIER_PAYMENT", id), text);
  for (const x of links) {
    const k = key(x.targetType, x.targetId);
    if (out.has(k)) continue;
    out.set(k, x.targetType === "PAYROLL_PERIOD" ? `Lương tháng ${thang(x.targetId)}${x.note ? ` · ${x.note}` : ""}` : `Chứng từ đã bị xoá (${x.targetType})`);
  }
  return out;
}

/**
 * Diễn giải của từng dòng sao kê (chỉ dòng ĐÃ nối). Nhiều chứng từ ⇒ nhiều câu, mỗi câu kèm phần tiền
 * đã nối vào nó khi dòng tiền được chia cho nhiều chứng từ.
 */
export async function bankLinkDetails(txnIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!txnIds.length) return out;
  const db = await getDb();
  const links = (await db.select({ txnId: l.txnId, targetType: l.targetType, targetId: l.targetId, amount: l.amount, note: l.note }).from(l).where(inArray(l.txnId, txnIds))).map((x) => ({
    ...x,
    targetType: x.targetType as LinkTargetType,
    amount: Number(x.amount),
  }));
  if (!links.length) return out;
  const labels = await labelsByTarget(links);
  const perTxn = new Map<string, Link[]>();
  for (const x of links) perTxn.set(x.txnId, [...(perTxn.get(x.txnId) ?? []), x]);
  for (const [txnId, ls] of perTxn) {
    out.set(
      txnId,
      ls.map((x) => `${labels.get(`${x.targetType}#${x.targetId}`) ?? x.targetType}${ls.length > 1 ? ` — ${formatVND(x.amount)}` : ""}`),
    );
  }
  return out;
}
