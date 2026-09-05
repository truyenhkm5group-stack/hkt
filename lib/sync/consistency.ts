/**
 * Kiểm tra & sửa nhất quán dữ liệu vận đơn / COD sau khi đồng bộ từ nhiều nguồn (Pancake, webhook Viettel Post, bảng kê, danh sách vận đơn).
 * Quy tắc sửa (chỉ khi fix=true):
 *  - COD đã về ngân hàng / đã đối soát ⇒ vận đơn phải là Giao thành công.
 *  - Vận đơn hoàn / huỷ ⇒ COD không áp dụng (không có tiền về).
 *  - Giao thành công mà thiếu ngày giao ⇒ lấy ngày trạng thái Viettel Post.
 * Phần còn lại chỉ báo cáo để người vận hành nhập bổ sung từ Viettel Post.
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

export async function checkShipmentConsistency(options: { fix?: boolean; staleDays?: number } = {}) {
  const db = await getDb();
  const s = schema.shipments;
  const fix = Boolean(options.fix);
  const staleDays = options.staleDays ?? 10;
  const now = new Date();

  const codPaidNotDelivered = await db
    .select({ id: s.id, codPaidToBankAt: s.codPaidToBankAt, codReconciledAt: s.codReconciledAt, vtpStatusDate: s.vtpStatusDate })
    .from(s)
    .where(and(inArray(s.codStatus, ["PAID_TO_BANK", "RECONCILED"]), sql`${s.stage} <> 'DELIVERED'`));
  const returnedWithCod = await db.select({ id: s.id }).from(s).where(and(inArray(s.stage, ["RETURNED", "CANCELLED"]), inArray(s.codStatus, ["PENDING", "COLLECTED"])));
  const deliveredNoDate = await db.select({ id: s.id, vtpStatusDate: s.vtpStatusDate, updatedAt: s.updatedAt }).from(s).where(and(eq(s.stage, "DELIVERED"), isNull(s.deliveredAt)));

  let fixed = { codPaidNotDelivered: 0, returnedWithCod: 0, deliveredNoDate: 0 };
  if (fix) {
    for (const r of codPaidNotDelivered) {
      await db.update(s).set({ stage: "DELIVERED", isFinal: true, deliveredAt: r.codPaidToBankAt ?? r.codReconciledAt ?? r.vtpStatusDate ?? now, updatedAt: now }).where(eq(s.id, r.id));
      fixed.codPaidNotDelivered += 1;
    }
    if (returnedWithCod.length) {
      await db.update(s).set({ codStatus: "NOT_APPLICABLE", updatedAt: now }).where(inArray(s.id, returnedWithCod.map((r) => r.id)));
      fixed.returnedWithCod = returnedWithCod.length;
    }
    for (const r of deliveredNoDate) {
      await db.update(s).set({ deliveredAt: r.vtpStatusDate ?? r.updatedAt ?? now, updatedAt: now }).where(eq(s.id, r.id));
      fixed.deliveredNoDate += 1;
    }
  } else {
    fixed = { codPaidNotDelivered: 0, returnedWithCod: 0, deliveredNoDate: 0 };
  }

  // Chỉ báo cáo
  const staleCutoff = new Date(now.getTime() - staleDays * 86_400_000);
  const staleOpen = await db
    .select({ tracking: sql<string>`coalesce(${s.vtpOrderNumber}, ${s.trackingCode}, '')`, stage: s.stage, lastAt: sql<Date>`coalesce(${s.vtpStatusDate}, ${s.updatedAt})` })
    .from(s)
    .where(and(inArray(s.stage, ["PENDING", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_FAILED", "RETURNING"]), lt(sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt})`, staleCutoff)))
    .orderBy(sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt})`)
    .limit(5000);
  const [conflict] = await db
    .select({ count: sql<number>`count(*)` })
    .from(s)
    .innerJoin(schema.orders, eq(schema.orders.id, s.orderId))
    .where(and(inArray(schema.orders.stage, ["DELIVERED", "PAID"]), eq(s.stage, "RETURNED")));
  const [noVtp] = await db.select({ count: sql<number>`count(*)` }).from(s).where(and(eq(s.carrier, "Viettel Post"), or(isNull(s.vtpOrderNumber), eq(s.vtpOrderNumber, ""))));
  const [deliveredCodPending] = await db.select({ count: sql<number>`count(*)`, amount: sql<number>`coalesce(sum(${s.codAmount}),0)` }).from(s).where(and(eq(s.stage, "DELIVERED"), inArray(s.codStatus, ["PENDING", "COLLECTED"]), lt(sql`coalesce(${s.deliveredAt}, ${s.vtpStatusDate}, ${s.updatedAt})`, new Date(now.getTime() - 14 * 86_400_000))));

  return {
    fix,
    found: { codPaidNotDelivered: codPaidNotDelivered.length, returnedWithCod: returnedWithCod.length, deliveredNoDate: deliveredNoDate.length },
    fixed,
    report: {
      /** Vận đơn đang mở không cập nhật quá N ngày → cần nhập danh sách vận đơn từ Viettel Post */
      staleOpen: staleOpen.length,
      staleOpenSample: staleOpen.slice(0, 30).map((r) => `${r.tracking} ${r.stage} ${r.lastAt ? new Date(r.lastAt).toISOString().slice(0, 10) : ""}`),
      /** Đơn Pancake ghi đã giao nhưng vận đơn Viettel Post ghi hoàn */
      pancakeDeliveredVtpReturned: Number(conflict?.count ?? 0),
      /** Vận đơn Viettel Post thiếu mã vận đơn VTP (không thể đối chiếu) */
      viettelWithoutVtpNumber: Number(noVtp?.count ?? 0),
      /** Giao thành công > 14 ngày mà COD chưa về ngân hàng → thiếu bảng kê COD */
      deliveredCodPendingOver14d: { count: Number(deliveredCodPending?.count ?? 0), amount: Number(deliveredCodPending?.amount ?? 0) },
    },
  };
}
