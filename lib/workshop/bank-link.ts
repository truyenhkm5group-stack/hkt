import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createLink } from "@/lib/finance/linkage";
import { supplierLinkCandidates } from "@/lib/queries/workshop-ledger";

/**
 * ═══════════ GHÉP SAO KÊ NGÂN HÀNG ↔ THANH TOÁN XƯỞNG MAY / NHÀ VẢI — LÕI ═══════════
 *
 * Chủ shop yêu cầu (25/09/2026). Mối nối đi qua ĐÚNG đường chung `createLink` (trần hai phía, khoá
 * dòng tiền) với loại `SUPPLIER_PAYMENT`. Đây là ĐỐI CHIẾU, không phải ghi nhận chi phí (AGENTS.md mục
 * 17): giá vốn vẫn đi theo phiếu kho. Tệp nhận người thao tác làm tham số để bài kiểm chạy được trên
 * CSDL thật; quyền và nhật ký nằm ở Server Action (`lib/actions/workshop-ledger.ts`).
 */

/** Dòng tiền chưa phân loại mà đã ghép vào thanh toán xưởng ⇒ nhóm "Nhập hàng · trả tiền xưởng". KHÔNG đè nhóm người đã chọn. */
async function classifyIfUnclassified(txnId: string, email: string) {
  const db = await getDb();
  await db
    .update(schema.bankTransactions)
    .set({ accountingGroup: "PURCHASE", classifiedBy: email, classifiedAt: new Date(), ruleId: null })
    .where(and(eq(schema.bankTransactions.id, txnId), eq(schema.bankTransactions.accountingGroup, "UNCLASSIFIED")));
}

/**
 * Ghép dòng tiền RA vào một đợt thanh toán ĐÃ GHI. Nối TRỌN số tiền của đợt ⇒ sao kê là chứng từ thật:
 * ngày trả, hình thức và mã giao dịch của đợt lấy theo sao kê (thay ngày TẠM của lượt nhập từ bảng
 * tính). Nối một phần ⇒ chỉ ghi mối nối, đợt giữ nguyên.
 */
export async function linkTxnToSupplierPayment(txnId: string, paymentId: string, actor: { email: string }): Promise<{ amount: number; paymentUpdated: boolean; batchId: string | null } | { error: string }> {
  const db = await getDb();
  const pay = await db.query.supplierPayments.findFirst({ where: eq(schema.supplierPayments.id, paymentId) });
  if (!pay) return { error: "Không tìm thấy đợt thanh toán" };
  if (pay.kind === "REFUND") return { error: "Đợt hoàn tiền là tiền VÀO — không ghép với dòng tiền ra" };
  const txn = await db.query.bankTransactions.findFirst({ where: eq(schema.bankTransactions.id, txnId), columns: { id: true, amount: true, txnAt: true, bankRef: true } });
  if (!txn) return { error: "Không tìm thấy giao dịch" };
  if (txn.amount >= 0) return { error: "Chỉ ghép được dòng tiền RA với thanh toán xưởng / nhà vải" };
  const kq = await createLink({ txnId: txn.id, targetType: "SUPPLIER_PAYMENT", targetId: pay.id, confidence: "MANUAL", method: "MANUAL", confirmedBy: actor.email, note: "Ghép từ sổ ngân hàng" });
  if ("error" in kq) return { error: kq.error };
  const [da] = await db
    .select({ n: sql<number>`coalesce(sum(${schema.bankTransactionLinks.amount}), 0)` })
    .from(schema.bankTransactionLinks)
    .where(and(eq(schema.bankTransactionLinks.targetType, "SUPPLIER_PAYMENT"), eq(schema.bankTransactionLinks.targetId, pay.id)));
  const du = Number(da?.n ?? 0) >= pay.amount;
  if (du) {
    await db
      .update(schema.supplierPayments)
      .set({ paidAt: txn.txnAt, method: "BANK", reference: txn.bankRef, note: pay.note.startsWith("Nhập từ bảng tính") ? "Ngày trả lấy theo sao kê ngân hàng" : pay.note })
      .where(eq(schema.supplierPayments.id, pay.id));
  }
  await classifyIfUnclassified(txn.id, actor.email);
  let batchId = pay.batchId;
  if (!batchId && pay.fabricOrderId) batchId = (await db.query.fabricOrders.findFirst({ where: eq(schema.fabricOrders.id, pay.fabricOrderId), columns: { batchId: true } }))?.batchId ?? null;
  return { amount: kq.amount, paymentUpdated: du, batchId };
}

/** Tạo đợt thanh toán MỚI bằng đúng phần CHƯA nối của dòng tiền ra, rồi nối luôn. */
export async function createPaymentFromTxn(
  d: { txnId: string; batchId: string | null; fabricOrderId: string | null; kind: "DEPOSIT" | "PAYMENT" },
  actor: { id: string | null; email: string; name: string },
): Promise<{ amount: number; paymentId: string; batchId: string | null } | { error: string }> {
  if ((d.batchId == null) === (d.fabricOrderId == null)) return { error: "Chọn đúng một lô hoặc một đợt vải" };
  const c = await supplierLinkCandidates(d.txnId);
  if (!c) return { error: "Không tìm thấy giao dịch" };
  const db = await getDb();
  const txn = await db.query.bankTransactions.findFirst({ where: eq(schema.bankTransactions.id, d.txnId), columns: { amount: true } });
  if (!txn || txn.amount >= 0) return { error: "Chỉ ghép được dòng tiền RA với thanh toán xưởng / nhà vải" };
  if (c.txn.remaining <= 0) return { error: "Dòng tiền này đã nối đủ, không còn phần nào để ghép" };
  let batchId: string | null = d.batchId;
  if (d.batchId) {
    if (!(await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, d.batchId), columns: { id: true } }))) return { error: "Không tìm thấy lô" };
  } else {
    const vai = await db.query.fabricOrders.findFirst({ where: eq(schema.fabricOrders.id, d.fabricOrderId as string), columns: { batchId: true } });
    if (!vai) return { error: "Không tìm thấy đợt vải" };
    batchId = vai.batchId;
  }
  const [pay] = await db
    .insert(schema.supplierPayments)
    .values({ batchId: d.batchId, fabricOrderId: d.fabricOrderId, kind: d.kind, amount: c.txn.remaining, paidAt: c.txn.txnAt, method: "BANK", reference: c.txn.bankRef, note: "Tạo từ sổ ngân hàng", createdByUserId: actor.id, createdBy: actor.name })
    .returning({ id: schema.supplierPayments.id });
  const kq = await createLink({ txnId: d.txnId, targetType: "SUPPLIER_PAYMENT", targetId: pay.id, confidence: "MANUAL", method: "MANUAL", confirmedBy: actor.email, note: "Tạo đợt thanh toán từ sổ ngân hàng" });
  if ("error" in kq) {
    // Không để lại một đợt thanh toán không có chứng từ chỉ vì mối nối hỏng giữa chừng.
    await db.delete(schema.supplierPayments).where(eq(schema.supplierPayments.id, pay.id));
    return { error: kq.error };
  }
  await classifyIfUnclassified(d.txnId, actor.email);
  return { amount: kq.amount, paymentId: pay.id, batchId };
}
