import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { settleCarrierRequests } from "@/lib/care/carrier-requests";
import { addCareNote, markCarrierManualDone, requestCarrierAction, setCareFollowUp, setCareOwner, setCareStatus, type CareActor } from "@/lib/care/service";
import { careViewOf, slaOf } from "@/lib/care/view";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { getCareReport } from "@/lib/queries/care-report";
import { getCareWorkbench } from "@/lib/queries/care-workbench";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ───────────── BÀN LÀM VIỆC GIAO VẬN ─────────────
 *
 * Khoá năm điều:
 *  1. chiều care KHÔNG chạm chiều ĐVVC: bấm "đã xong" không đổi shipments.stage;
 *  2. mọi lần đổi trạng thái / note / giao việc đều có audit_logs và cập nhật được tại dòng;
 *  3. góc nhìn: WAITING tới hạn quay về Cần care; DONE rồi giao hụt mới ⇒ mở lại; kiện rời hàng
 *     đợi khi điều kiện hết nhưng lịch sử còn;
 *  4. yêu cầu gửi ĐVVC: WEBHOOK_ONLY ⇒ MANUAL_REQUIRED (không gọi API); API_TRACKABLE ⇒ SENT → ACK,
 *     chỉ SUCCESS khi sự kiện xác nhận; idempotent; lỗi quyền ⇒ UNSUPPORTED;
 *  5. báo cáo đo theo kết cục (giao được / hoàn) chứ không theo số lần bấm.
 */
export async function testCareWorkbench(db: Db) {
  const actor: CareActor = { id: null, email: "cs@test", name: "CS" };
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);

  await db.insert(schema.users).values({ id: "care-user-1", email: "linh@test", name: "Linh", passwordHash: "x", role: "CS", active: true }).onConflictDoNothing();

  // Kiện giao hụt 5 giờ trước, chưa ai chạm ⇒ Cần care, đã vỡ SLA phản hồi đầu (2 giờ).
  await db.insert(schema.orders).values({ id: "care-o1", stage: "SHIPPED", status: 3, insertedAt: gio(48), billFullName: "Khách A", billPhone: "0900000001", moneyToCollect: 350_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "care-s1", orderId: "care-o1", carrier: "Viettel Post", vtpOrderNumber: "CARE001", stage: "DELIVERY_FAILED", codAmount: 350_000, trackingCapability: "WEBHOOK_ONLY", vtpStatusDate: gio(5), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "care-s1", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(5), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();

  // Kiện đang giao bình thường ⇒ KHÔNG vào hàng đợi.
  await db.insert(schema.orders).values({ id: "care-o2", stage: "SHIPPED", status: 3, insertedAt: gio(10), billFullName: "Khách B", billPhone: "0900000002" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "care-s2", orderId: "care-o2", carrier: "Viettel Post", vtpOrderNumber: "CARE002", stage: "OUT_FOR_DELIVERY", codAmount: 200_000, vtpStatusDate: gio(1) }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "care-s2", source: "VTP_WEBHOOK", status: "500", statusName: "Giao bưu tá đi phát", occurredAt: gio(1), normalizedStage: "OUT_FOR_DELIVERY", legType: "OUTBOUND" }).onConflictDoNothing();

  clearMemo();
  let wb = await getCareWorkbench();
  const s1 = wb.cases.find((c) => c.shipmentId === "care-s1");
  assert.ok(s1, "kiện giao hụt phải có mặt trên bàn làm việc");
  assert.equal(s1.view, "care", "chưa ai chạm ⇒ Cần care");
  assert.equal(s1.care.status, "NEW");
  assert.ok(s1.sla.firstResponseBreached, "giao hụt 5 giờ chưa ai phản hồi ⇒ vỡ SLA phản hồi đầu");
  assert.equal(s1.carrierCapability, "MANUAL", "tài khoản API không sở hữu kiện ⇒ mọi thao tác VTP là làm tay");
  assert.ok(!wb.cases.some((c) => c.shipmentId === "care-s2"), "kiện đang giao bình thường KHÔNG được xuất hiện mặc định");

  // ───────── 2. Đổi trạng thái / giao việc / note: cập nhật tại dòng + audit ─────────
  const st = await setCareStatus(actor, { shipmentIds: ["care-s1"], status: "IN_PROGRESS" });
  assert.ok("ok" in st && st.ok);
  assert.equal(st.data["care-s1"].status, "IN_PROGRESS");
  assert.ok(st.data["care-s1"].firstResponseAt, "lần đầu có người động vào ⇒ chốt mốc phản hồi đầu");
  const ow = await setCareOwner(actor, { shipmentIds: ["care-s1"], ownerId: "care-user-1" });
  assert.ok("ok" in ow && ow.ok && ow.data["care-s1"].owner?.name === "Linh", "giao việc phải trả về tên người nhận để dòng hiện ngay");
  const nt = await addCareNote(actor, { shipmentId: "care-s1", note: "Khách hẹn mai 9h", kind: "RESCHEDULED" });
  assert.ok("ok" in nt && nt.ok && nt.data.lastNote === "Khách hẹn mai 9h" && nt.data.lastNoteBy === "cs@test");
  const [{ n: auditN }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.entityId, "care-s1"), sql`${schema.auditLogs.action} in ('care.status','care.owner','care.note')`));
  assert.equal(Number(auditN), 3, "mỗi lần đổi trạng thái / giao việc / note là một dòng nhật ký");
  const [{ n: careActionN }] = await db.select({ n: sql<number>`count(*)` }).from(schema.careActions).where(eq(schema.careActions.shipmentId, "care-s1"));
  assert.equal(Number(careActionN), 1, "note nhanh là một hành động care có ảnh chụp bối cảnh");

  // ───────── 1. Chiều care không chạm chiều ĐVVC ─────────
  const done = await setCareStatus(actor, { shipmentIds: ["care-s1"], status: "DONE" });
  assert.ok("ok" in done && done.ok && done.data["care-s1"].doneAt);
  const [sAfter] = await db.select({ stage: schema.shipments.stage }).from(schema.shipments).where(eq(schema.shipments.id, "care-s1"));
  assert.equal(sAfter.stage, "DELIVERY_FAILED", "đội bấm ĐÃ XONG không được đổi trạng thái vận chuyển của ĐVVC");
  clearMemo();
  wb = await getCareWorkbench();
  assert.equal(wb.cases.find((c) => c.shipmentId === "care-s1")?.view, "done", "đã xong ⇒ rời Cần care, sang Đã xử lý (lịch sử còn)");

  // ───────── 3. Góc nhìn: hẹn theo dõi tới hạn quay về Cần care; giao hụt mới sau khi đóng ⇒ mở lại ─────────
  const later = new Date(Date.now() + 3600_000);
  assert.equal(careViewOf({ status: "WAITING", followUpAt: later, doneAt: null, firstResponseAt: null }, gio(5)).view, "waiting");
  assert.equal(careViewOf({ status: "WAITING", followUpAt: gio(1), doneAt: null, firstResponseAt: null }, gio(5)).view, "care", "hẹn theo dõi đã tới hạn ⇒ quay về Cần care");
  const reopen = careViewOf({ status: "DONE", followUpAt: null, doneAt: gio(3), firstResponseAt: gio(4) }, gio(1));
  assert.equal(reopen.view, "care");
  assert.ok(reopen.reopened, "đóng lúc -3h, giao hụt mới lúc -1h ⇒ kiện mở lại");
  assert.ok(!slaOf(gio(5), { status: "DONE", followUpAt: null, doneAt: gio(1), firstResponseAt: gio(4) }).resolveBreached, "đã đóng thì không tính vỡ SLA đóng");
  const fu = await setCareFollowUp(actor, { shipmentId: "care-s1", at: later });
  assert.ok("ok" in fu && fu.ok && fu.data.followUpAt && fu.data.status === "DONE", "kiện đã xong thì hẹn theo dõi không tự đổi trạng thái");
  const re = await setCareStatus(actor, { shipmentIds: ["care-s1"], status: "IN_PROGRESS" });
  assert.ok("ok" in re && re.ok && re.data["care-s1"].reopenCount === 1, "mở lại kiện đã đóng ⇒ đếm một lần mở lại");

  // ───────── 4. Yêu cầu gửi ĐVVC ─────────
  let apiCalls = 0;
  setViettelPostClientForTests({
    configured: true,
    getOrderDetail: async () => null,
    updateOrder: async (orderNumber: string) => {
      apiCalls += 1;
      if (orderNumber === "CARE-DENIED") throw new Error("Không có quyền thao tác đơn hàng này");
      return { error: false, status: 200, message: "Cập nhật thành công", data: null };
    },
  });
  try {
    // WEBHOOK_ONLY ⇒ không gọi API, ghi MANUAL_REQUIRED.
    const m = await requestCarrierAction(actor, { shipmentId: "care-s1", actionKey: "redeliver", note: "gọi số phụ" });
    assert.ok("ok" in m && m.ok, JSON.stringify(m));
    assert.equal(m.data.request.status, "MANUAL_REQUIRED", "tài khoản API không sở hữu kiện ⇒ PHẢI LÀM TAY, không giả vờ gửi");
    assert.equal(apiCalls, 0, "không được gọi API khi biết trước là không có quyền");
    const md = await markCarrierManualDone(actor, { requestId: m.data.request.id, note: "đã bấm phát tiếp trên web" });
    assert.ok("ok" in md && md.ok && md.data.status === "MANUAL_DONE");

    // API_TRACKABLE ⇒ SENT → ACK; chỉ SUCCESS khi sự kiện xác nhận.
    await db.insert(schema.orders).values({ id: "care-o3", stage: "SHIPPED", status: 3, insertedAt: gio(30), billFullName: "Khách C", billPhone: "0900000003" }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: "care-s3", orderId: "care-o3", carrier: "Viettel Post", vtpOrderNumber: "CARE003", stage: "DELIVERY_FAILED", codAmount: 500_000, trackingCapability: "API_TRACKABLE", vtpStatusDate: gio(3) }).onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values({ shipmentId: "care-s3", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(3), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
    const a1 = await requestCarrierAction(actor, { shipmentId: "care-s3", actionKey: "redeliver", note: "" });
    assert.ok("ok" in a1 && a1.ok, JSON.stringify(a1));
    assert.equal(a1.data.request.status, "ACK", "API trả OK chỉ là ĐVVC đã nhận — chưa phải thành công");
    assert.equal(apiCalls, 1);
    const a2 = await requestCarrierAction(actor, { shipmentId: "care-s3", actionKey: "redeliver", note: "" });
    assert.ok("ok" in a2 && a2.ok && a2.data.request.id === a1.data.request.id, "bấm hai lần cùng yêu cầu ⇒ idempotent, không gửi lại");
    assert.equal(apiCalls, 1, "không gọi API lần hai");
    // Sự kiện "đi phát" tới ⇒ ACK → SUCCESS.
    await applyVtpTracking(
      { orderNumber: "CARE003", orderReference: "", status: 500, statusName: "Giao bưu tá đi phát", statusDate: new Date(), location: "", note: "", reasonCode: null, isReturning: false, moneyCollection: 0, moneyCollectionOrigin: null, moneyTotal: 0, moneyTotalFee: 0, moneyFeeCod: 0, productWeight: 0, service: "", expectedDelivery: "", receiverName: "", receiverPhone: "", receiverAddress: "", employeeName: "", employeePhone: "", journey: [], raw: {} },
      "VTP_WEBHOOK",
    );
    const [req] = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.id, a1.data.request.id));
    assert.equal(req.status, "SUCCESS", "sự kiện đi phát sau lúc gửi ⇒ ĐVVC xác nhận ⇒ SUCCESS");
    assert.ok(req.confirmedAt, "phải ghi mốc xác nhận");
    assert.equal(await settleCarrierRequests(db, "care-s3", "OUT_FOR_DELIVERY", new Date()), 0, "chạy lại không đổi gì");

    // Lỗi quyền từ API ⇒ UNSUPPORTED, có audit.
    await db.insert(schema.orders).values({ id: "care-o4", stage: "SHIPPED", status: 3, insertedAt: gio(30) }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: "care-s4", orderId: "care-o4", carrier: "Viettel Post", vtpOrderNumber: "CARE-DENIED", stage: "DELIVERY_FAILED", codAmount: 100_000, trackingCapability: "API_TRACKABLE" }).onConflictDoNothing();
    const den = await requestCarrierAction(actor, { shipmentId: "care-s4", actionKey: "redeliver", note: "" });
    assert.ok("error" in den, "API từ chối thì phải báo lỗi, không im");
    const [denied] = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, "care-s4"));
    assert.equal(denied.status, "UNSUPPORTED");
    // Chặng không cho phép ⇒ từ chối ngay, không tạo yêu cầu.
    const bad = await requestCarrierAction(actor, { shipmentId: "care-s2", actionKey: "approve", note: "" });
    assert.ok("error" in bad, "duyệt đơn cho kiện đang đi phát là không hợp lệ");
  } finally {
    setViettelPostClientForTests(null);
  }

  // ───────── 5. Báo cáo theo kết cục ─────────
  clearMemo();
  const report = await getCareReport(resolvePeriod({ period: "30d" }, "30d"));
  assert.ok(report.recovery.failedTotal >= 2, "hai kiện giao hụt trong kỳ (s1, s3) phải được đếm vào mẫu số");
  assert.ok(report.recovery.failedIntervened >= 1, "s1 có note của người ⇒ nhóm có can thiệp");
  assert.ok(report.recovery.failedNotIntervened >= 1, "s3 chỉ có yêu cầu ĐVVC, chưa có hành động care của người ⇒ nhóm không can thiệp — không được đếm nhầm sang có can thiệp");
  assert.ok(report.carrierRequests.total >= 3 && report.carrierRequests.success >= 1 && report.carrierRequests.manualDone >= 1 && report.carrierRequests.unsupported >= 1, "báo cáo yêu cầu ĐVVC phải đếm đủ các trạng thái");
  const linh = report.staff.find((s) => s.actor === "cs@test");
  assert.ok(linh, "nhân viên có hành động phải xuất hiện");
  assert.ok(linh.recovered <= linh.intervened, "cứu được không thể lớn hơn số kiện can thiệp");

  console.log(
    `✓ Bàn làm việc giao vận: ${wb.counts.care} cần care · care không chạm chiều ĐVVC · audit đủ · WEBHOOK_ONLY ⇒ làm tay · API ACK→SUCCESS theo sự kiện · idempotent · báo cáo theo kết cục`,
  );
}
