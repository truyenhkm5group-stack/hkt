import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { carrierCapabilitiesFor } from "@/lib/care/carrier-capabilities";
import { settleCarrierRequests } from "@/lib/care/carrier-requests";
import { addCareNote, markCarrierManualDone, reopenCase, requestCarrierAction, setCareFollowUp, setCareOwner, setCareStatus, type CareActor } from "@/lib/care/service";
import { careViewOf, slaOf } from "@/lib/care/view";
import { CARE_STATUSES, CARE_TRANSITIONS, canTransition } from "@/lib/constants/care";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { getCareReport } from "@/lib/queries/care-report";
import { getCareCaseDetail, getCareEvents, getCareQueue } from "@/lib/queries/care-workbench";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ───────────── OPERATIONAL CARE ENGINE ─────────────
 *
 * Khoá:
 *  1. chiều care KHÔNG chạm chiều ĐVVC: RESOLVED không đổi shipments.stage;
 *  2. vòng đời đi theo CARE_TRANSITIONS; RESOLVED/CANCELLED chỉ mở lại bằng reopen; hàng loạt bỏ
 *     qua kiện sai đường và nêu lý do;
 *  3. mọi lần đổi ghi care_case_events (chỉ thêm, có trạng thái trước/sau, SLA, nguồn) + audit_logs;
 *  4. hàng đợi mặc định = actionable population; kiện cũ dữ liệu tách sang dataGaps; WAITING tới
 *     hạn quay về Cần care; giao hụt mới sau khi đóng ⇒ mở lại;
 *  5. yêu cầu ĐVVC: WEBHOOK_ONLY ⇒ MANUAL_REQUIRED (không gọi API); API_TRACKABLE ⇒ SENT →
 *     ACKNOWLEDGED, chỉ SUCCESS khi sự kiện xác nhận; idempotent; lỗi tạm thời retry hữu hạn;
 *     lỗi quyền ⇒ UNSUPPORTED; ma trận năng lực đúng theo credential × kiện × chặng;
 *  6. báo cáo đo theo KẾT CỤC với attribution chặt (can thiệp phải đi trước kết cục).
 */
export async function testCareWorkbench(db: Db) {
  const actor: CareActor = { id: null, email: "cs@test", name: "CS", source: "API" };
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);

  // ───────── Bảng chuyển trạng thái tự nhất quán ─────────
  for (const from of CARE_STATUSES) for (const to of CARE_TRANSITIONS[from]) assert.ok(CARE_STATUSES.includes(to), `${from} → ${to}: đích phải là trạng thái hợp lệ`);
  assert.ok(!canTransition("RESOLVED", "IN_PROGRESS"), "case đã đóng không đổi trạng thái thường được — phải mở lại");
  assert.ok(canTransition("WAITING_CUSTOMER", "RESOLVED"));

  await db.insert(schema.users).values({ id: "care-user-1", email: "linh@test", name: "Linh", passwordHash: "x", role: "CS", active: true }).onConflictDoNothing();

  // Kiện giao hụt 5 giờ trước, chưa ai chạm ⇒ Cần care, đã vỡ SLA phản hồi đầu (2 giờ).
  await db.insert(schema.orders).values({ id: "care-o1", stage: "SHIPPED", status: 3, insertedAt: gio(48), billFullName: "Khách A", billPhone: "0900000001", moneyToCollect: 350_000, totalPriceAfterDiscount: 350_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "care-s1", orderId: "care-o1", carrier: "Viettel Post", vtpOrderNumber: "CARE001", stage: "DELIVERY_FAILED", codAmount: 350_000, trackingCapability: "WEBHOOK_ONLY", vtpStatusDate: gio(5), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "care-s1", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(5), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  // Kiện đang giao bình thường ⇒ KHÔNG vào hàng đợi.
  await db.insert(schema.orders).values({ id: "care-o2", stage: "SHIPPED", status: 3, insertedAt: gio(10), billFullName: "Khách B", billPhone: "0900000002" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "care-s2", orderId: "care-o2", carrier: "Viettel Post", vtpOrderNumber: "CARE002", stage: "OUT_FOR_DELIVERY", codAmount: 200_000, vtpStatusDate: gio(1) }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "care-s2", source: "VTP_WEBHOOK", status: "500", statusName: "Giao bưu tá đi phát", occurredAt: gio(1), normalizedStage: "OUT_FOR_DELIVERY", legType: "OUTBOUND" }).onConflictDoNothing();
  // Kiện chưa từng có tin ⇒ DATA_FRESHNESS: ở dataGaps, không phải backlog care.
  await db.insert(schema.orders).values({ id: "care-o6", stage: "SHIPPED", status: 3, insertedAt: gio(30) }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "care-s6", orderId: "care-o6", carrier: "Viettel Post", vtpOrderNumber: "CARE006", stage: "UNKNOWN", codAmount: 90_000 }).onConflictDoNothing();

  clearMemo();
  let q = await getCareQueue();
  const s1 = q.cases.find((c) => c.shipmentId === "care-s1");
  assert.ok(s1, "kiện giao hụt phải có mặt trong hàng đợi");
  assert.equal(s1.view, "care");
  assert.equal(s1.reasonClass, "CUSTOMER_ACTION");
  assert.equal(s1.care.status, "NEW");
  assert.ok(s1.sla.firstResponseBreached, "giao hụt 5 giờ chưa ai phản hồi ⇒ vỡ SLA phản hồi đầu");
  assert.equal(s1.carrierCapability, "MANUAL");
  assert.ok(!q.cases.some((c) => c.shipmentId === "care-s2"), "kiện đang giao bình thường KHÔNG vào hàng đợi (quiet)");
  assert.ok(!q.cases.some((c) => c.shipmentId === "care-s6") && q.dataGaps.some((c) => c.shipmentId === "care-s6"), "kiện thiếu dữ liệu nằm ở dataGaps — dữ liệu cũ không phải kiện hỏng");
  assert.ok(q.byReason.some((r) => r.reason === "DELIVERY_FAILED" || r.reason === "NO_CONTACT" || r.reason === "AWAITING_REDELIVERY"), "backlog theo lý do");

  // ───────── 2+3. Vòng đời + lịch sử chỉ-thêm ─────────
  const asg = await setCareOwner(actor, { shipmentIds: ["care-s1"], ownerId: "care-user-1" });
  assert.ok("ok" in asg && asg.ok);
  assert.equal(asg.data.states["care-s1"].status, "ASSIGNED", "giao người cho case mới ⇒ ASSIGNED");
  assert.equal(asg.data.states["care-s1"].owner?.name, "Linh");
  assert.ok(asg.data.states["care-s1"].firstResponseAt, "lần đầu có người động vào ⇒ chốt mốc phản hồi đầu");
  const nt = await addCareNote(actor, { shipmentId: "care-s1", note: "Khách hẹn mai 9h", kind: "RESCHEDULED" });
  assert.ok("ok" in nt && nt.ok && nt.data.status === "IN_PROGRESS" && nt.data.lastNote === "Khách hẹn mai 9h", "note ⇒ đang xử lý");
  const later = new Date(Date.now() + 3600_000);
  const fu = await setCareFollowUp(actor, { shipmentId: "care-s1", at: later, waitingFor: "WAITING_REDELIVERY" });
  assert.ok("ok" in fu && fu.ok && fu.data.status === "WAITING_REDELIVERY" && fu.data.followUpAt, "hẹn theo dõi ⇒ chờ phát lại");
  const bad = await setCareStatus(actor, { shipmentIds: ["care-s1", "care-s2"], status: "RESOLVED" });
  assert.ok("ok" in bad && bad.ok);
  assert.equal(bad.data.states["care-s1"].status, "RESOLVED");
  assert.equal(bad.data.states["care-s2"]?.status, "RESOLVED", "kiện chưa có case (NEW ngầm) đóng được");
  const again = await setCareStatus(actor, { shipmentIds: ["care-s1"], status: "IN_PROGRESS" });
  assert.ok("ok" in again && again.ok && again.data.skipped.length === 1 && !again.data.states["care-s1"], "đổi trạng thái thường trên case đã đóng bị bỏ qua và nêu lý do");
  const [sAfter] = await db.select({ stage: schema.shipments.stage }).from(schema.shipments).where(eq(schema.shipments.id, "care-s1"));
  assert.equal(sAfter.stage, "DELIVERY_FAILED", "đội bấm ĐÃ XONG không được đổi trạng thái vận chuyển của ĐVVC");
  const ro = await reopenCase(actor, { shipmentId: "care-s1", note: "khách gọi lại" });
  assert.ok("ok" in ro && ro.ok && ro.data.status === "ASSIGNED" && ro.data.reopenCount === 1, "mở lại ⇒ về ASSIGNED (còn người), đếm một lần");
  const events = await getCareEvents("care-s1");
  // ASSIGN · NOTE · FOLLOW_UP · RESOLVE · REOPEN = 5 hành động thật; lần đổi bị bỏ qua KHÔNG được ghi.
  assert.equal(events.length, 5, `mỗi hành động thật một sự kiện, hành động bị từ chối không ghi — có ${events.length}`);
  const reopenEv = events.find((e) => e.action === "REOPEN");
  assert.ok(reopenEv && reopenEv.previousStatus === "RESOLVED" && reopenEv.nextStatus === "ASSIGNED" && reopenEv.source === "API" && reopenEv.sla, "sự kiện phải mang trạng thái trước/sau, nguồn và SLA lúc đó");
  const [{ n: auditN }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.entityId, "care-s1"), sql`${schema.auditLogs.action} like 'care.%'`));
  assert.ok(Number(auditN) >= 5, "mỗi sự kiện case cũng là một dòng nhật ký hệ thống");
  const [{ n: careActionN }] = await db.select({ n: sql<number>`count(*)` }).from(schema.careActions).where(eq(schema.careActions.shipmentId, "care-s1"));
  assert.equal(Number(careActionN), 1, "note nhanh là một hành động care có ảnh chụp bối cảnh");

  // ───────── 4. Góc nhìn ─────────
  assert.equal(careViewOf({ status: "WAITING_CARRIER", followUpAt: later, doneAt: null, firstResponseAt: null }, gio(5)).view, "waiting");
  assert.equal(careViewOf({ status: "WAITING_CUSTOMER", followUpAt: gio(1), doneAt: null, firstResponseAt: null }, gio(5)).view, "care", "hẹn theo dõi đã tới hạn ⇒ quay về Cần care");
  const reopen = careViewOf({ status: "RESOLVED", followUpAt: null, doneAt: gio(3), firstResponseAt: gio(4) }, gio(1));
  assert.ok(reopen.view === "care" && reopen.reopened, "đóng lúc -3h, giao hụt mới lúc -1h ⇒ kiện mở lại");
  assert.equal(careViewOf({ status: "CANCELLED", followUpAt: null, doneAt: gio(1), firstResponseAt: null }, gio(5)).view, "done");
  assert.ok(!slaOf(gio(5), { status: "RESOLVED", followUpAt: null, doneAt: gio(1), firstResponseAt: gio(4) }).resolveBreached, "đã đóng thì không tính vỡ SLA đóng");

  // ───────── 5. Yêu cầu ĐVVC ─────────
  const caps = carrierCapabilitiesFor({ stage: "DELIVERY_FAILED", trackingCapability: "WEBHOOK_ONLY", configured: true, tracking: "X" });
  assert.equal(caps.find((c) => c.actionKey === "redeliver")?.status, "PERMISSION_MISSING");
  assert.equal(caps.find((c) => c.actionKey === "approve")?.status, "UNSUPPORTED", "duyệt đơn không áp dụng ở chặng giao hụt");
  assert.equal(carrierCapabilitiesFor({ stage: "DELIVERY_FAILED", trackingCapability: "API_TRACKABLE", configured: true, tracking: "X" }).find((c) => c.actionKey === "redeliver")?.status, "SUPPORTED");
  assert.equal(carrierCapabilitiesFor({ stage: "DELIVERY_FAILED", trackingCapability: "UNKNOWN_CAPABILITY", configured: false, tracking: "X" }).find((c) => c.actionKey === "redeliver")?.status, "PERMISSION_MISSING", "chưa cấu hình credential thì không thể gửi");

  let apiCalls = 0;
  let flaky = 1;
  setViettelPostClientForTests({
    configured: true,
    getOrderDetail: async () => null,
    updateOrder: async (orderNumber: string) => {
      apiCalls += 1;
      if (orderNumber === "CARE-DENIED") throw new Error("Không có quyền thao tác đơn hàng này");
      if (orderNumber === "CARE-FLAKY" && flaky-- > 0) throw new Error("fetch failed: ECONNRESET");
      return { error: false, status: 200, message: "Cập nhật thành công", data: null };
    },
  });
  try {
    const m = await requestCarrierAction(actor, { shipmentId: "care-s1", actionKey: "redeliver", note: "gọi số phụ" });
    assert.ok("ok" in m && m.ok, JSON.stringify(m));
    assert.equal(m.data.request.status, "MANUAL_REQUIRED", "tài khoản API không sở hữu kiện ⇒ PHẢI LÀM TAY, không giả vờ gửi");
    assert.equal(apiCalls, 0);
    const md = await markCarrierManualDone(actor, { requestId: m.data.request.id, note: "đã bấm phát tiếp trên web" });
    assert.ok("ok" in md && md.ok && md.data.status === "MANUAL_DONE");

    await db.insert(schema.orders).values({ id: "care-o3", stage: "SHIPPED", status: 3, insertedAt: gio(30), billFullName: "Khách C", billPhone: "0900000003", totalPriceAfterDiscount: 600_000 }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: "care-s3", orderId: "care-o3", carrier: "Viettel Post", vtpOrderNumber: "CARE003", stage: "DELIVERY_FAILED", codAmount: 500_000, trackingCapability: "API_TRACKABLE", vtpStatusDate: gio(3) }).onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values({ shipmentId: "care-s3", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(3), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
    const a1 = await requestCarrierAction(actor, { shipmentId: "care-s3", actionKey: "redeliver", note: "" });
    assert.ok("ok" in a1 && a1.ok, JSON.stringify(a1));
    assert.equal(a1.data.request.status, "ACKNOWLEDGED", "API trả OK chỉ là ĐVVC đã nhận — chưa phải thành công");
    assert.equal(a1.data.request.attempts, 1);
    const a2 = await requestCarrierAction(actor, { shipmentId: "care-s3", actionKey: "redeliver", note: "" });
    assert.ok("ok" in a2 && a2.ok && a2.data.request.id === a1.data.request.id, "idempotent — không gửi lại");
    assert.equal(apiCalls, 1);
    const [rawReq] = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.id, a1.data.request.id));
    assert.ok(rawReq.rawRequest && rawReq.response, "phải lưu gói tin thô gửi đi và phản hồi thô");
    await applyVtpTracking(
      { orderNumber: "CARE003", orderReference: "", status: 500, statusName: "Giao bưu tá đi phát", statusDate: new Date(), location: "", note: "", reasonCode: null, isReturning: false, moneyCollection: 0, moneyCollectionOrigin: null, moneyTotal: 0, moneyTotalFee: 0, moneyFeeCod: 0, productWeight: 0, service: "", expectedDelivery: "", receiverName: "", receiverPhone: "", receiverAddress: "", employeeName: "", employeePhone: "", journey: [], raw: {} },
      "VTP_WEBHOOK",
    );
    const [req] = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.id, a1.data.request.id));
    assert.equal(req.status, "SUCCESS", "sự kiện đi phát sau lúc gửi ⇒ ĐVVC xác nhận ⇒ SUCCESS");
    assert.ok(req.confirmedAt);
    assert.equal(await settleCarrierRequests(db, "care-s3", "OUT_FOR_DELIVERY", new Date()), 0, "chạy lại không đổi gì");

    // Lỗi tạm thời ⇒ retry hữu hạn rồi thành công.
    await db.insert(schema.orders).values({ id: "care-o5", stage: "SHIPPED", status: 3, insertedAt: gio(30) }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: "care-s5", orderId: "care-o5", carrier: "Viettel Post", vtpOrderNumber: "CARE-FLAKY", stage: "DELIVERY_FAILED", codAmount: 100_000, trackingCapability: "API_TRACKABLE" }).onConflictDoNothing();
    const before = apiCalls;
    const fl = await requestCarrierAction(actor, { shipmentId: "care-s5", actionKey: "redeliver", note: "" });
    assert.ok("ok" in fl && fl.ok && fl.data.request.status === "ACKNOWLEDGED" && fl.data.request.attempts === 2, "lỗi mạng lần một ⇒ gửi lại lần hai, ghi số lần");
    assert.equal(apiCalls - before, 2);

    // Lỗi quyền ⇒ UNSUPPORTED, không retry.
    await db.insert(schema.orders).values({ id: "care-o4", stage: "SHIPPED", status: 3, insertedAt: gio(30) }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: "care-s4", orderId: "care-o4", carrier: "Viettel Post", vtpOrderNumber: "CARE-DENIED", stage: "DELIVERY_FAILED", codAmount: 100_000, trackingCapability: "API_TRACKABLE" }).onConflictDoNothing();
    const b2 = apiCalls;
    const den = await requestCarrierAction(actor, { shipmentId: "care-s4", actionKey: "redeliver", note: "" });
    assert.ok("error" in den);
    assert.equal(apiCalls - b2, 1, "lỗi quyền là lỗi dứt khoát — không gửi lại");
    const [denied] = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, "care-s4"));
    assert.equal(denied.status, "UNSUPPORTED");
    const badStage = await requestCarrierAction(actor, { shipmentId: "care-s2", actionKey: "approve", note: "" });
    assert.ok("error" in badStage, "duyệt đơn cho kiện đang đi phát là không hợp lệ");
  } finally {
    setViettelPostClientForTests(null);
  }

  // ───────── Chi tiết case cho ngăn kéo / AI ─────────
  const detail = await getCareCaseDetail("care-s3");
  assert.ok(detail, "phải dựng được bối cảnh đầy đủ của kiện");
  assert.equal(detail.shipment.tracking, "CARE003");
  assert.ok(detail.journey.length >= 1 && detail.carrierRequests.length >= 1 && detail.capabilities.length === 6);
  const cap = detail.capabilities.find((c) => c.actionKey === "redeliver");
  assert.ok(cap?.allowedAtStage, "đang đi phát vẫn cho phép yêu cầu phát tiếp theo luật chặng");
  assert.ok(cap && ["SUPPORTED", "PERMISSION_MISSING"].includes(cap.status), "năng lực đi theo credential: có cấu hình ⇒ SUPPORTED, không ⇒ PERMISSION_MISSING — không bao giờ giả định");

  // ───────── 6. Báo cáo theo kết cục, attribution chặt ─────────
  clearMemo();
  const report = await getCareReport(resolvePeriod({ period: "30d" }, "30d"));
  assert.ok(report.recovery.failedTotal >= 2, "kiện giao hụt trong kỳ vào mẫu số");
  assert.ok(report.recovery.failedIntervened >= 1, "s1 có note của người trước kết cục ⇒ có can thiệp");
  assert.ok(report.backlog.byReason.length >= 1 && report.backlog.dataGaps >= 1, "báo cáo mang backlog theo lý do và số kiện thiếu dữ liệu riêng");
  assert.ok(report.carrierRequests.total >= 4 && report.carrierRequests.success >= 1 && report.carrierRequests.manualDone >= 1 && report.carrierRequests.unsupported >= 1);
  const me = report.staff.find((s) => s.actor === "cs@test");
  assert.ok(me && me.recovered <= me.intervened, "cứu được không thể lớn hơn số kiện can thiệp");

  clearMemo();
  q = await getCareQueue();
  console.log(
    `✓ Care engine: ${q.counts.care} cần care · ${q.dataGaps.length} thiếu dữ liệu tách riêng · vòng đời theo bảng chuyển · ${events.length} sự kiện chỉ-thêm · ĐVVC: làm tay / ACKNOWLEDGED→SUCCESS theo sự kiện / retry hữu hạn / UNSUPPORTED · báo cáo attribution chặt`,
  );
}
