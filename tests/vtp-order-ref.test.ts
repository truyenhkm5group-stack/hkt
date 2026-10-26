/**
 * ═══ MÃ ĐƠN TRÊN VẬN ĐƠN TẠO THẲNG Ở VIETTEL POST → ĐƠN ERP (lib/integrations/viettelpost/order-reference.ts — vtp-direct-sync (4)) ═══
 *
 * Khoá:
 *  1. Thuần: số đơn POS chỉ nhận «6277» / «#6277» (1–7 chữ số) — KHÔNG gom chữ số («HD-0961-2026» không phải đơn 9612026).
 *  2. Webhook: ORDER_REFERENCE = số đơn POS của đơn đã có lần gửi PKE, mã vận đơn MỚI ⇒ LẦN GỬI MỚI của đơn đó (attempt_no + 1), dòng
 *     PKE cũ giữ nguyên mã — trước đây sự kiện bị gộp vào lần gửi mới nhất · mã gom chữ số ⇒ mồ côi · khớp hai đơn ⇒ mồ côi, không đoán.
 *  3. Tệp «Danh sách vận đơn»: cùng hàm — «Mã đơn hàng» = số đơn POS ⇒ orderRef; SĐT tệp khác SĐT đơn ⇒ dừng cho người.
 *  2b. Ca reship hiện có (ORDER_REFERENCE = mã PKE cũ) không đổi hành vi: lần gửi kế + raw.reship.of.
 *  4. Gắn tay (`linkOrphanToOrder`): gắn đúng một lần + audit mang người bấm · SĐT lệch ⇒ chặn · chiều hoàn ⇒ chặn.
 * Dữ liệu dựng (không PII): SĐT 0961008xxx.
 */
import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { posOrderNumberOf } from "@/lib/integrations/viettelpost/order-reference";
import { linkOrphanToOrder } from "@/lib/integrations/viettelpost/reship";
import { matchVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";
import type { VtpOrderListRow } from "@/lib/integrations/viettelpost/statement";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

const track = (orderNumber: string, orderReference: string, at: string): VtpTrackingRecord => ({
  orderNumber, orderReference, status: 103, statusName: "Giao cho bưu cục", statusDate: new Date(at), location: "", note: "", reasonCode: null, isReturning: null,
  moneyCollectionOrigin: null, moneyCollection: 499000, moneyTotal: 0, moneyTotalFee: 0, moneyFeeCod: 0, productWeight: 0, service: "", expectedDelivery: "",
  receiverName: "", receiverPhone: "", receiverAddress: "", employeeName: "", employeePhone: "", journey: [], raw: {},
});

export function testVtpOrderRefPure() {
  assert.deepEqual(["6277", "#6277", " 6277 ", "1", "9999999"].map(posOrderNumberOf), [6277, 6277, 6277, 1, 9999999]);
  assert.deepEqual(["HD-0961-2026", "12345678", "PKE1555563080", "6277a", "# 6277", "", "62 77"].map(posOrderNumberOf), [null, null, null, null, null, null, null], "không gom chữ số, không dài quá 7, không chữ");
  console.log("  ✓ thuần: số đơn POS chỉ «6277» / «#6277», không gom chữ số");
}

export async function testVtpOrderRef(db: Db) {
  testVtpOrderRefPure();
  const ORD = ["oref-1", "oref-2", "990777"];
  const codes = ["PKEOREF00001", "155990777001", "155990777002", "155990777003", "155990777004", "PKEOREF00001L"];
  try {
    await db.insert(schema.orders).values([
      { id: "oref-1", systemId: 990771, status: 1, statusName: "Đã xác nhận", stage: "CONFIRMED", shipPhone: "0961008001", insertedAt: new Date("2026-10-20T00:00:00Z") },
      // Ca nhập nhằng: id của đơn này = số đơn POS của đơn kia.
      { id: "990777", systemId: 990772, status: 1, statusName: "x", stage: "CONFIRMED", insertedAt: new Date("2026-10-20T00:00:00Z") },
      { id: "oref-2", systemId: 990777, status: 1, statusName: "x", stage: "CONFIRMED", insertedAt: new Date("2026-10-20T00:00:00Z") },
    ]);
    await db.insert(schema.shipments).values({ orderId: "oref-1", attemptNo: 1, direction: "OUTBOUND", stage: "PENDING", vtpOrderNumber: "PKEOREF00001", trackingCode: "PKEOREF00001", carrier: "Viettel Post", codAmount: 499000 });

    // 2 · webhook: số đơn POS, mã mới ⇒ lần gửi mới.
    await applyVtpTracking(track("155990777001", "990771", "2026-10-24T10:08:00Z"), "VTP_WEBHOOK", { allowCreate: true });
    const lan = await db.select({ code: schema.shipments.vtpOrderNumber, n: schema.shipments.attemptNo, order: schema.shipments.orderId }).from(schema.shipments).where(eq(schema.shipments.orderId, "oref-1"));
    assert.deepEqual(lan.map((r) => [r.code, r.n]).sort(), [["155990777001", 2], ["PKEOREF00001", 1]], `mã mới ⇒ lần gửi 2, dòng PKE giữ mã: ${JSON.stringify(lan)}`);
    await applyVtpTracking(track("155990777001", "990771", "2026-10-24T11:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
    assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, "oref-1"))).length, 2, "gói kế của cùng mã ⇒ vẫn hai dòng");
    // Ca reship HIỆN CÓ không đổi hành vi (214/214 ca dạng 155555577235 ↔ PKE1555563080, 25/10/2026): ORDER_REFERENCE = mã PKE
    // CŨ của đơn ⇒ không phải mã đơn ERP (không khớp id / custom_id / số POS) ⇒ đường reshipParentOf như trước: lần gửi kế + vết.
    const [pke] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, "PKEOREF00001"));
    await applyVtpTracking(track("155990777006", "PKEOREF00001", "2026-10-24T12:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
    codes.push("155990777006");
    const [rs] = await db.select({ order: schema.shipments.orderId, n: schema.shipments.attemptNo, raw: schema.shipments.raw }).from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, "155990777006"));
    assert.deepEqual([rs?.order, rs?.n, (rs?.raw as { reship?: { of?: string } } | null)?.reship?.of], ["oref-1", 3, pke.id], `tham chiếu = mã PKE cũ ⇒ lần gửi kế của CÙNG đơn + raw.reship.of như hôm nay: ${JSON.stringify(rs)}`);
    // gom chữ số ⇒ mồ côi.
    await applyVtpTracking(track("155990777002", "HD-990771", "2026-10-24T10:09:00Z"), "VTP_WEBHOOK", { allowCreate: true });
    const [mc] = await db.select({ order: schema.shipments.orderId }).from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, "155990777002"));
    assert.equal(mc?.order, null, "«HD-990771» không phải đơn 990771 — mồ côi");
    // nhập nhằng ⇒ mồ côi.
    await applyVtpTracking(track("155990777003", "990777", "2026-10-24T10:10:00Z"), "VTP_WEBHOOK", { allowCreate: true });
    const [nn] = await db.select({ order: schema.shipments.orderId }).from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, "155990777003"));
    assert.equal(nn?.order, null, "mã khớp hai đơn (id của đơn này = số POS của đơn kia) ⇒ không đoán");

    // 3 · tệp: cùng hàm.
    const row = (trackingCode: string, orderCode: string, receiverPhone: string): VtpOrderListRow => ({ trackingCode, orderCode, statusText: "Đóng tải - vận chuyển đi", statusCode: 300, cod: 499000, fee: 30000, statusDate: "2026-10-24", statusAt: "2026-10-24T10:00:00.000Z", raw: "{}", receiverPhone });
    const [ok, lech] = await matchVtpOrderList([row("155990777004", "#990771", "0961008001"), row("155990777005", "990771", "0961008999")]);
    assert.deepEqual([ok.matchKind, ok.orderRef?.orderId], ["orderRef", "oref-1"], `số đơn POS ở cột «Mã đơn hàng» ⇒ lần gửi mới cho đơn: ${JSON.stringify([ok.matchKind, ok.matchIssue])}`);
    assert.ok(lech.matchKind === null && /SĐT/.test(lech.matchIssue ?? ""), `SĐT tệp khác SĐT đơn ⇒ dừng cho người: ${lech.matchIssue}`);

    // 4 · gắn tay.
    const [o1] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, "155990777002"));
    const actor = { id: null, email: "test@oref.local" };
    await db.update(schema.shipments).set({ receiverPhone: "0961008999" }).where(eq(schema.shipments.id, o1.id));
    assert.deepEqual(await linkOrphanToOrder(db, { shipmentId: o1.id, orderId: "oref-1", actor, reason: "t" }), { ok: false, why: "PHONE_MISMATCH" }, "SĐT lệch ⇒ chặn");
    await db.update(schema.shipments).set({ receiverPhone: "" }).where(eq(schema.shipments.id, o1.id));
    const r = await linkOrphanToOrder(db, { shipmentId: o1.id, orderId: "oref-1", actor, reason: "t" });
    assert.deepEqual(r, { ok: true, orderId: "oref-1", attemptNo: 4 }, "thiếu SĐT một bên ⇒ người bấm là bằng chứng, gắn thành lần gửi kế (4)");
    assert.deepEqual(await linkOrphanToOrder(db, { shipmentId: o1.id, orderId: "oref-1", actor, reason: "t" }), { ok: false, why: "ALREADY_LINKED" });
    const [leg] = await db.insert(schema.shipments).values({ vtpOrderNumber: "PKEOREF000011P1", carrier: "Viettel Post", stage: "RETURNED", codAmount: 0 }).returning({ id: schema.shipments.id });
    codes.push("PKEOREF000011P1");
    assert.deepEqual(await linkOrphanToOrder(db, { shipmentId: leg.id, orderId: "oref-1", actor, reason: "t" }), { ok: false, why: "RETURN_LEG" });
    const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SHIPMENT_MANUAL_LINK"), eq(schema.auditLogs.entityId, o1.id)));
    assert.equal(logs.length, 1, "một dòng audit cho lần gắn thật");
  } finally {
    const ids = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(inArray(schema.shipments.vtpOrderNumber, codes))).map((r) => r.id);
    if (ids.length) {
      await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
      await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
    }
    await db.delete(schema.shipments).where(like(schema.shipments.vtpOrderNumber, "15599077700%"));
    await db.delete(schema.orders).where(inArray(schema.orders.id, ORD));
  }
  console.log("✓ Mã đơn trên vận đơn tạo thẳng ở VTP: số đơn POS đúng dạng ⇒ lần gửi mới (không gộp vào lần cũ) · gom chữ số / nhập nhằng ⇒ mồ côi · tệp cùng hàm, SĐT lệch dừng · gắn tay một lần + audit, chặn SĐT lệch / chiều hoàn");
}
