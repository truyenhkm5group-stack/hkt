import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { setViettelPostClientForTests, type VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import { getIntegrationHealth } from "@/lib/queries/integration-health";
import { viettelPostHealth } from "@/lib/queries/integrations";

/**
 * ───────────── KHOẺ THEO NĂNG LỰC (chủ shop chốt 11/09/2026) ─────────────
 *
 * Vận đơn Pancake tạo thuộc tài khoản Viettel Post khác, nên tài khoản API của shop "không thấy"
 * chúng. Trước đây mỗi lượt đối chiếu vì thế ghi PARTIAL và sức khoẻ tích hợp thành "chạy nhưng có
 * lỗi" — trong khi webhook vẫn về đều và với những vận đơn đó webhook là nguồn đúng và đủ.
 *
 * Ba điều được khoá ở đây:
 *  1. `UNKNOWN_CAPABILITY` dò hữu hạn rồi KẾT LUẬN `WEBHOOK_ONLY` — lần chạy vẫn SUCCESS;
 *  2. chỉ `API_TRACKABLE` mà API không thấy mới là cảnh báo thật (PARTIAL), và không bị hạ cấp;
 *  3. sức khoẻ tích hợp / trang Kết nối nêu rõ phần vận đơn ngoài phạm vi API thay vì coi là hỏng.
 */
export async function testVtpCapability(db: Db) {
  const record = (orderNumber: string): VtpTrackingRecord => ({
    orderNumber,
    orderReference: "",
    status: 500,
    statusName: "Giao bưu tá đi phát",
    statusDate: new Date(),
    location: "Hà Nội",
    note: "",
    reasonCode: null,
    isReturning: false,
    moneyCollection: 0,
    moneyCollectionOrigin: null,
    moneyTotal: 0,
    moneyTotalFee: 0,
    moneyFeeCod: 0,
    productWeight: 0,
    service: "",
    expectedDelivery: "",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    employeeName: "",
    employeePhone: "",
    journey: [],
    raw: {},
  });
  // Client giả: chỉ vận đơn "PKE-CAP-OK" thuộc tài khoản API; mọi mã khác API trả "không tồn tại".
  setViettelPostClientForTests({ getOrderDetail: async (orderNumber: string) => (orderNumber === "PKE-CAP-OK" ? record(orderNumber) : null) });

  try {
    await db.insert(schema.orders).values([
      { id: "cap-o-unk", insertedAt: new Date() },
      { id: "cap-o-ok", insertedAt: new Date() },
      { id: "cap-o-lost", insertedAt: new Date() },
    ]).onConflictDoNothing();
    const [unk] = await db
      .insert(schema.shipments)
      .values({ orderId: "cap-o-unk", carrier: "Viettel Post", vtpOrderNumber: "PKE-CAP-UNK", stage: "IN_TRANSIT", trackingCapability: "UNKNOWN_CAPABILITY", capabilityProbes: 2 })
      .returning({ id: schema.shipments.id });
    const [ok] = await db
      .insert(schema.shipments)
      .values({ orderId: "cap-o-ok", carrier: "Viettel Post", vtpOrderNumber: "PKE-CAP-OK", stage: "PICKED_UP", trackingCapability: "API_TRACKABLE" })
      .returning({ id: schema.shipments.id });
    const [lost] = await db
      .insert(schema.shipments)
      .values({ orderId: "cap-o-lost", carrier: "Viettel Post", vtpOrderNumber: "PKE-CAP-LOST", stage: "IN_TRANSIT", trackingCapability: "API_TRACKABLE" })
      .returning({ id: schema.shipments.id });

    // ───────── 2. Vận đơn TỪNG tra được mà nay API không thấy ⇒ cảnh báo thật ─────────
    const hut = await syncViettelPostShipments({ trigger: "MANUAL", actor: "test", shipmentIds: [lost.id], includeFinal: true });
    const lanChay = async (id: string) => (await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id)))[0];
    const hutRun = await lanChay(hut.run.id);
    assert.equal(hutRun.status, "PARTIAL", "API_TRACKABLE mà API không thấy là đối chiếu hụt ⇒ PARTIAL");
    assert.match(hutRun.error ?? "", /từng tra được qua API/, "cảnh báo phải nói đúng lý do: vận đơn tra được mà nay không thấy");
    const [lostSau] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, lost.id));
    assert.equal(lostSau.trackingCapability, "API_TRACKABLE", "không được hạ cấp vận đơn đã chứng minh tra được — hụt là để người xem tài khoản, không phải để im đi");

    // ───────── 1. Dò hữu hạn rồi kết luận, lần chạy vẫn SUCCESS ─────────
    const ketLuan = await syncViettelPostShipments({ trigger: "MANUAL", actor: "test", shipmentIds: [unk.id, ok.id], includeFinal: true });
    const ketLuanRun = await lanChay(ketLuan.run.id);
    assert.equal(ketLuanRun.status, "SUCCESS", "API không thấy vận đơn CHƯA RÕ năng lực là PHÂN LOẠI, không phải lỗi ⇒ không được PARTIAL");
    assert.equal(ketLuanRun.error, null, "không có cảnh báo nào");
    assert.match(ketLuanRun.detail ?? "", /kết luận chỉ nhận webhook/, "chi tiết phải nói vận đơn vừa được kết luận");
    assert.match(ketLuanRun.detail ?? "", /ngoài phạm vi tài khoản API/, "chi tiết phải nêu phần vận đơn chỉ nhận webhook để không ai đọc 'không thấy' thành 'hỏng'");
    const [unkSau] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, unk.id));
    assert.equal(unkSau.trackingCapability, "WEBHOOK_ONLY", "đủ số lần dò ⇒ kết luận chỉ nhận webhook");
    assert.equal(unkSau.capabilityProbes, 3, "số lần dò là hữu hạn và được ghi lại");
    const [okSau] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, ok.id));
    assert.equal(okSau.trackingCapability, "API_TRACKABLE");
    assert.ok(okSau.lastVtpSyncAt, "vận đơn tra được thì đối chiếu như thường");

    // ───────── 3. Sức khoẻ tích hợp nói rõ năng lực, không coi phần ngoài phạm vi là hỏng ─────────
    clearMemo();
    const [connectors, vtp] = await Promise.all([getIntegrationHealth(), viettelPostHealth()]);
    const vtpConnector = connectors.find((c) => c.key === "VIETTELPOST")!;
    assert.ok(vtpConnector.capability, "connector Viettel Post phải báo năng lực tra cứu");
    assert.ok(vtpConnector.capability!.webhookOnly >= 1, "phải đếm được vận đơn chỉ nhận webhook");
    assert.equal(vtpConnector.lastReconciliation?.status, "SUCCESS", "lượt đối chiếu gần nhất (dò + kết luận) là SUCCESS");
    assert.doesNotMatch(vtpConnector.reason, /chỉ chạy được một phần/, "vận đơn ngoài phạm vi API không được kéo mức sức khoẻ xuống");
    assert.ok(vtp.capability.webhookOnly >= 1 && vtp.capability.apiTrackable >= 2, "trang Kết nối đọc cùng con số năng lực");

    console.log(
      `✓ Viettel Post khoẻ theo năng lực: dò hữu hạn rồi kết luận chỉ nhận webhook (SUCCESS) · API_TRACKABLE mất dấu mới là PARTIAL · ${vtp.capability.webhookOnly} vận đơn ngoài phạm vi API không kéo sức khoẻ xuống`,
    );
  } finally {
    setViettelPostClientForTests(null);
  }
}
