import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { careStateFor, failedAfterDecision } from "@/lib/care/filters";
import { recordCareDecision, type CareActor } from "@/lib/care/service";
import { careViewOf, decisionParksCase, queueViewOf, slaOf, type CareStateLike } from "@/lib/care/view";
import { getCareQueue } from "@/lib/queries/care-workbench";

/**
 * ═══ CA ĐÃ CÓ KẾT QUẢ "PHÁT TIẾP" NẰM Ở "ĐANG CHỜ KẾT QUẢ", KHÔNG Ở "CẦN CARE" ═══
 *
 * Chủ shop gửi ảnh 25/09/2026 (tối): PKE1522237996 và PKE1527380314 — kết quả "Phát tiếp", trạng
 * thái "Chờ phát lại", giờ hẹn đã qua (quá hẹn 19–23 phút), một ca có "ĐVVC có tin mới sau lượt xử
 * lý cuối" — vẫn đứng ở "Cần care". Chủ shop chốt: ca đã xử lý và có kết quả trên ERP thì về "Đang
 * chờ kết quả" / "Đã xử lý"; bấm đổi trạng thái thì dòng phải sang đúng tab ngay.
 *
 *  (1) Phát tiếp + chờ + hẹn đã qua ⇒ Đang chờ kết quả, SLA đóng ca tạm dừng.
 *  (2) Phát tiếp + tin ĐVVC thường sau lượt xử lý ⇒ vẫn Đang chờ kết quả.
 *  (3) Phát tiếp rồi ĐVVC báo GIAO HỤT MỚI sau lúc bấm ⇒ về Cần care (việc mới thật).
 *  (4) "Xử lý sau" vẫn là một cái hẹn: qua giờ ⇒ về Cần care như cũ.
 *  (5) Người đổi sang "Đang xử lý" ⇒ Cần care, dù kết quả là Phát tiếp.
 *  (6) Qua hàng đợi thật: bấm "Phát tiếp" ⇒ máy chủ và trình duyệt cùng xếp dòng vào "Đang chờ".
 */
export async function testCareDecisionParks(db: Db) {
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);
  const vaoHangDoi = gio(30);
  const phatTiep = (extra: Partial<CareStateLike> = {}): CareStateLike => ({
    status: "WAITING_REDELIVERY",
    followUpAt: gio(0.3),
    doneAt: null,
    firstResponseAt: gio(28),
    firstRoundAt: gio(28),
    lastDecision: { decision: "CARE_CONTINUE_DELIVERY" },
    ...extra,
  });

  assert.equal(careViewOf(phatTiep(), vaoHangDoi).view, "waiting", "(1) Phát tiếp + hẹn đã qua ⇒ Đang chờ kết quả, không bật về Cần care");
  assert.equal(slaOf(vaoHangDoi, phatTiep()).resolveBreached, false, "(1) đội đã làm phần mình ⇒ đồng hồ đóng ca dừng, không cộng vào số vỡ SLA");
  assert.equal(careViewOf(phatTiep({ carrierNewsAfterLastRound: true }), vaoHangDoi).view, "waiting", "(2) tin ĐVVC thường (trung chuyển, chờ xử lý…) không kéo ca đã chốt về");
  assert.equal(careViewOf(phatTiep({ carrierFailedAfterDecision: true }), vaoHangDoi).view, "care", "(3) giao hụt MỚI sau lúc bấm Phát tiếp ⇒ việc mới, về Cần care");
  assert.equal(decisionParksCase(phatTiep({ carrierFailedAfterDecision: true })), false);
  assert.equal(careViewOf(phatTiep({ lastDecision: { decision: "CARE_FOLLOW_UP" } }), vaoHangDoi).view, "care", "(4) Xử lý sau là một cái hẹn — qua giờ thì phải quay lại");
  assert.equal(careViewOf(phatTiep({ status: "IN_PROGRESS" }), vaoHangDoi).view, "care", "(5) người đang cầm việc (Đang xử lý) ⇒ Cần care");
  assert.equal(careViewOf(phatTiep({ lastDecision: null }), vaoHangDoi).view, "care", "chưa ai quyết gì + hẹn đã qua ⇒ vẫn quay về Cần care như cũ");

  // Mốc giao hụt so với mốc bấm — nhận cả chuỗi (dữ liệu qua ranh giới máy chủ → trình duyệt).
  assert.equal(failedAfterDecision(gio(1), gio(2)), true);
  assert.equal(failedAfterDecision(gio(3).toISOString(), gio(2).toISOString()), false, "hụt TRƯỚC lúc bấm là lý do đã được xử lý, không phải việc mới");
  assert.equal(failedAfterDecision(null, gio(2)), false);

  // (6) Qua hàng đợi thật: kiện giao hụt 30 giờ trước, ca đã giao người, hẹn đã quá.
  await db.insert(schema.orders).values({ id: "cdp-o1", stage: "SHIPPED", status: 3, insertedAt: gio(100), billFullName: "Kim Phượng", billPhone: "0900000301" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "cdp-s1", orderId: "cdp-o1", carrier: "Viettel Post", vtpOrderNumber: "CDP001", stage: "DELIVERY_FAILED", pickedUpAt: gio(90), codAmount: 524_000, vtpStatusDate: gio(30), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "cdp-s1", source: "VTP_WEBHOOK", status: "507", statusName: "Phát không thành công", occurredAt: gio(30), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  await db.insert(schema.shipmentCare).values({ shipmentId: "cdp-s1", orderId: "cdp-o1", trackingNumber: "CDP001", episodeNo: 1, active: true, careStatus: "IN_PROGRESS", openedAt: gio(30), firstResponseAt: gio(29), followUpAt: gio(0.3), careOutcome: "PENDING" });

  clearMemo();
  const truoc = (await getCareQueue()).cases.find((c) => c.shipmentId === "cdp-s1");
  assert.equal(truoc?.view, "care", "chưa ai quyết ⇒ kiện giao hụt ở Cần care");

  const actor: CareActor = { id: null, email: "quan@test", name: "Trần Anh Quân", source: "API" };
  const r = await recordCareDecision(actor, { shipmentId: "cdp-s1", decision: "CARE_CONTINUE_DELIVERY" });
  assert.ok("ok" in r && r.ok, "ghi được Phát tiếp");
  // Trình duyệt vá dòng bằng đúng luật máy chủ (workbench.tsx → careStateFor + queueViewOf).
  const vaDong = { ...truoc!, care: r.data };
  assert.equal(queueViewOf(vaDong, careStateFor(vaDong)).view, "waiting", "(6) bấm Phát tiếp ⇒ dòng sang Đang chờ ngay trên màn hình người bấm");
  const sau = (await getCareQueue()).cases.find((c) => c.shipmentId === "cdp-s1");
  assert.equal(sau?.view, "waiting", "(6) máy chủ dựng lại cũng xếp vào Đang chờ — hai bên không lệch");

  // Hẹn trôi qua (giả lập bằng cách lùi giờ hẹn) ⇒ vẫn Đang chờ.
  await db.update(schema.shipmentCare).set({ followUpAt: gio(0.2) }).where(eq(schema.shipmentCare.shipmentId, "cdp-s1"));
  clearMemo();
  assert.equal((await getCareQueue()).cases.find((c) => c.shipmentId === "cdp-s1")?.view, "waiting", "(1) qua hàng đợi thật: hẹn đã qua vẫn ở Đang chờ");

  // Bưu tá phát lại và hụt lần nữa SAU lúc bấm ⇒ về Cần care.
  await db.insert(schema.shipmentEvents).values({ shipmentId: "cdp-s1", source: "VTP_WEBHOOK", status: "507", statusName: "Phát không thành công", occurredAt: new Date(Date.now() + 1000), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  clearMemo();
  const hutLai = (await getCareQueue()).cases.find((c) => c.shipmentId === "cdp-s1");
  assert.equal(hutLai?.view, "care", "(3) qua hàng đợi thật: giao hụt mới sau Phát tiếp ⇒ Cần care");

  await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "cdp-s1"));
  await db.delete(schema.careActions).where(eq(schema.careActions.shipmentId, "cdp-s1"));
  await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, "cdp-s1"));
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ["cdp-s1"]));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, "cdp-s1"));
  clearMemo();
  console.log("✓ Ca có kết quả Phát tiếp nằm ở Đang chờ kết quả kể cả khi hẹn đã qua / ĐVVC có tin thường; chỉ giao hụt mới sau lúc bấm mới kéo về Cần care; Xử lý sau vẫn theo giờ hẹn; máy chủ và trình duyệt cùng kết luận");
}
