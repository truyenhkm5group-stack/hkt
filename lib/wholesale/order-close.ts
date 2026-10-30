import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { manualOrderAmountDue } from "@/lib/constants/order-payments";
import { vnDateKey } from "@/lib/format";
import { getQuotation } from "@/lib/queries/wholesale-quotations";
import { createManualOrderCore } from "@/lib/records/order-create";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { convertLeadCore, updateLeadStatusCore } from "@/lib/wholesale/leads";
import { effectiveQuotationStatus } from "@/lib/wholesale/quotation-engine";

/**
 * ═══════════ CHỐT ĐƠN SỈ TỪ BÁO GIÁ + ĐỀ NGHỊ ĐỐI CHIẾU CHUYỂN KHOẢN — docs/tech/hslc-b2b-sales-agent.md · P5 ═══════════
 *
 * (a) Báo giá KHÁCH CHẤP NHẬN ⇒ «Tạo đơn sỉ». Đường ghi là ĐÚNG lõi đơn tạo tay có sẵn (`createManualOrderCore`): không có đường ghi
 *     đơn thứ hai, quyền `orders:write`, hạn mức nợ, phiếu kho… đều đi theo lõi đó.
 *     · Dòng hàng + đơn giá + chiết khấu lấy từ ẢNH CHỤP của báo giá, không tính lại.
 *     · Đơn nối với báo giá bằng khoá chống trùng của lõi (`orders.raw.agentKey = "wholesale-quotation:<id>"`): bấm hai lần ra MỘT đơn.
 *     · Lead chưa là khách ⇒ `convertLeadCore` (tạo / nối khách theo SĐT, lead WON + converted_at). Lead đã có khách nhưng chưa WON
 *       ⇒ chuyển WON qua `updateLeadStatusCore`.
 *     · Đơn mới ở trạng thái «Mới»: người kiểm tồn / địa chỉ rồi chốt ở trang đơn.
 * (b) Thanh toán: KHÔNG ghi tiền tự động. Máy chỉ ĐỀ NGHỊ giao dịch ngân hàng chưa nối hết, có số tiền ĐÚNG BẰNG số phải trả của đơn
 *     VÀ nội dung có mã báo giá / mã đơn. Người bấm «Nối» đi qua hành động nối của sổ ngân hàng (`linkBankTransaction`, loại `ORDER`,
 *     quyền bank:write). Nối là đối chiếu (luật 17), không tạo phiếu thu, không đổi công nợ.
 */

export const quotationOrderKey = (quotationId: string) => `wholesale-quotation:${quotationId}`;

/** Đơn đã tạo từ báo giá (qua khoá chống trùng của lõi đơn). */
export async function orderForQuotation(quotationId: string): Promise<{ id: string; systemId: number | null; stage: string; due: number } | null> {
  const db = await getDb();
  const o = schema.orders;
  const [row] = await db
    .select({ id: o.id, systemId: o.systemId, stage: o.stage, total: o.totalPriceAfterDiscount, ship: o.shippingFee })
    .from(o)
    .where(sql`${o.raw}->>'agentKey' = ${quotationOrderKey(quotationId)}`)
    .orderBy(desc(o.insertedAt))
    .limit(1);
  return row ? { id: row.id, systemId: row.systemId, stage: row.stage, due: manualOrderAmountDue({ totalPriceAfterDiscount: row.total, shippingFee: row.ship }) } : null;
}

export type OrderFromQuotation = { orderId: string; customerId: string; replayed: boolean };

/** «Tạo đơn sỉ» từ một báo giá KHÁCH CHẤP NHẬN. Bấm hai lần ⇒ cùng một đơn. */
export async function createOrderFromQuotationCore(user: SessionUser, quotationId: string, now = new Date()): Promise<CoreResult<OrderFromQuotation>> {
  if (!can(user, "wholesale:work")) return { error: "Bạn không có quyền chăm lead khách sỉ (wholesale:work)." };
  if (!can(user, "orders:write")) return { error: "Bạn không có quyền tạo đơn hàng (orders:write)." };
  const q = await getQuotation(user, quotationId, now);
  if (!q) return { error: "Không tìm thấy báo giá (hoặc nằm ngoài phạm vi dữ liệu của bạn)." };
  if ("unavailable" in q) return { error: "CSDL của tổ chức chưa áp migration báo giá sỉ." };
  const existing = await orderForQuotation(quotationId);
  if (existing) return { ok: true, orderId: existing.id, customerId: "", replayed: true };
  const status = effectiveQuotationStatus(q.row.status, q.row.validUntil, vnDateKey(now));
  if (status !== "ACCEPTED") return { error: "Chỉ tạo đơn từ báo giá KHÁCH ĐÃ CHẤP NHẬN." };
  if (q.row.tax !== null) return { error: "Báo giá có thuế, nhưng đơn tạo tay chưa có ô thuế — chưa tạo đơn tự động được, để không lệch tổng với báo giá." };
  const lines = q.snapshot.result.lines;
  if (!lines.length || lines.some((l) => l.unitPrice === null)) return { error: "Báo giá còn dòng chưa có giá — không tạo đơn." };

  // Khách: báo giá đã gắn khách ⇒ dùng; chỉ gắn lead ⇒ chuyển lead thành khách bằng lõi có sẵn (tạo / nối theo SĐT, lead WON).
  let customerId = q.row.customerId;
  if (q.row.leadId) {
    const db = await getDb();
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, q.row.leadId) });
    if (!lead) return { error: "Không tìm thấy lead của báo giá." };
    if (!lead.customerId) {
      const c = await convertLeadCore(user, lead.id, {}, now);
      if ("error" in c) return { error: `Chưa chuyển được lead thành khách: ${c.error}` };
      customerId = customerId ?? c.customerId;
    } else {
      customerId = customerId ?? lead.customerId;
      if (lead.contactStatus !== "WON") {
        const w = await updateLeadStatusCore(user, lead.id, { status: "WON", note: `Khách chấp nhận báo giá ${q.row.code}` }, now);
        if ("error" in w) return { error: `Chưa chuyển lead sang Thắng: ${w.error}` };
      }
    }
  }
  if (!customerId) return { error: "Báo giá không gắn khách / lead." };

  const lineDiscounts = lines.reduce((s, l) => s + l.lineDiscount, 0);
  const t = q.snapshot.result.totals;
  const r = await createManualOrderCore(
    user,
    {
      customerId,
      stage: "NEW",
      lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice as number, discount: l.lineDiscount })),
      orderDiscount: t.discount - lineDiscounts,
      shippingFee: t.shipping ?? 0,
      note: `Từ báo giá ${q.row.code} · bản ${q.row.version}${t.shipping === null ? " · phí vận chuyển CHƯA khai trên báo giá — nhập ở đơn trước khi chốt" : ""}`,
      channel: "Báo giá sỉ",
    },
    { idempotencyKey: quotationOrderKey(quotationId) },
  );
  if (!r.ok) return { error: r.errors.map((e) => e.message).join(" ") || "Không tạo được đơn." };
  if (q.row.leadId) {
    const db = await getDb();
    await db.insert(schema.wholesaleLeadActivities).values({ leadId: q.row.leadId, kind: "NOTE", note: `Tạo đơn sỉ ${r.id} từ báo giá ${q.row.code} (bản ${q.row.version})`, meta: { orderId: r.id, quotationId }, actorId: user.id, actorName: user.name, createdAt: now });
  }
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_ORDER", entity: "WHOLESALE_QUOTATION", entityId: quotationId, after: { orderId: r.id, customerId, total: t.total, reused: Boolean(r.reused) }, reason: "Tạo đơn sỉ từ báo giá khách đã chấp nhận (lõi đơn tạo tay)" });
  return { ok: true, orderId: r.id, customerId, replayed: Boolean(r.reused) };
}

export type BankMatch = { txnId: string; txnAt: string; amount: number; description: string; counterparty: string; linkedAmount: number };
export type OrderBankView = { orderId: string; due: number; codes: string[]; suggestions: BankMatch[]; linked: { txnId: string; amount: number; txnAt: string; description: string }[] };

/**
 * ĐỀ NGHỊ đối chiếu (CHỈ ĐỌC): giao dịch TIỀN VÀO có số tiền ĐÚNG BẰNG số phải trả của đơn VÀ nội dung chứa mã báo giá / mã đơn, chưa
 * nối hết. Không có gợi ý «gần bằng»: số tiền lệch là việc người xem sao kê, không phải việc máy đoán.
 */
export async function bankMatchesForQuotation(user: SessionUser, quotationId: string, quotationCode: string): Promise<OrderBankView | null> {
  if (!can(user, "bank:view") && !can(user, "bank:write")) return null;
  const order = await orderForQuotation(quotationId);
  if (!order) return null;
  const db = await getDb();
  const b = schema.bankTransactions;
  const l = schema.bankTransactionLinks;
  const codes = [quotationCode, order.id, ...(order.systemId ? [String(order.systemId)] : [])].filter((c) => c.length >= 4);
  const linkedSum = sql<number>`coalesce((select sum(${l.amount}) from ${l} where ${l.txnId} = ${b.id}), 0)`;
  const [cands, linked] = await Promise.all([
    db
      .select({ id: b.id, txnAt: b.txnAt, amount: b.amount, description: b.description, counterparty: b.counterparty, linkedAmount: linkedSum })
      .from(b)
      .where(and(eq(b.amount, order.due), or(...codes.map((c) => ilike(b.description, `%${c}%`)))))
      .orderBy(desc(b.txnAt))
      .limit(20),
    db
      .select({ txnId: l.txnId, amount: l.amount, txnAt: b.txnAt, description: b.description })
      .from(l)
      .innerJoin(b, eq(b.id, l.txnId))
      .where(and(eq(l.targetType, "ORDER"), inArray(l.targetId, [order.id]))),
  ]);
  const linkedIds = new Set(linked.map((x) => x.txnId));
  return {
    orderId: order.id,
    due: order.due,
    codes,
    suggestions: cands
      .filter((c) => !linkedIds.has(c.id) && Number(c.linkedAmount) < Math.abs(c.amount))
      .map((c) => ({ txnId: c.id, txnAt: c.txnAt.toISOString(), amount: c.amount, description: c.description, counterparty: c.counterparty, linkedAmount: Number(c.linkedAmount) })),
    linked: linked.map((x) => ({ txnId: x.txnId, amount: x.amount, txnAt: x.txnAt.toISOString(), description: x.description })),
  };
}
