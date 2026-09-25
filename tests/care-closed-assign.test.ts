import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { setCareOwner, type CareActor } from "@/lib/care/service";
import { getCareCaseDetail, getCareQueue } from "@/lib/queries/care-workbench";

/**
 * ═══ CA ĐÃ ĐÓNG KHÔNG ĐỨNG Ở "CẦN CARE", VÀ GIAO NGƯỜI KHÔNG GHI VÀO CA ĐÃ ĐÓNG ═══
 *
 * Chủ shop báo 25/09/2026: giao case cho Trần Anh Quân, màn hình hiện tên, F5 lại thấy "chưa giao".
 * Nguyên nhân: kiện còn trong một rổ của tháp giao vận mà ca care gần nhất ĐÃ ĐÓNG. Hàng đợi chỉ nạp
 * ca đang mở + ca đóng trong 7 ngày, nên dòng rơi về "ca mới, chưa ai nhận"; `setCareOwner` ghi
 * người vào CA ĐÃ ĐÓNG (đọc lại không lọc `active` nên hiện tên), F5 thì hàng đợi không thấy.
 * Chủ shop chốt: ca đã đóng thì không còn cần care, không có việc để giao.
 *
 *  (a) ca đóng từ lâu, ĐVVC không báo gì mới ⇒ KHÔNG ở "Cần care"; giao ⇒ bị từ chối có lý do,
 *      ca đã đóng không bị ghi người;
 *  (b) ca đóng rồi ĐVVC báo sự cố MỚI (vào lại Cần care) ⇒ giao = mở lại ca rồi giao, và F5 (đọc lại
 *      hàng đợi + ngăn chi tiết) vẫn thấy đúng người.
 */
export async function testCareClosedAssign(db: Db) {
  const actor: CareActor = { id: null, email: "lead@test", name: "Trưởng nhóm", source: "API" };
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);
  await db.insert(schema.users).values({ id: "cca-quan", email: "quan@test", name: "Trần Anh Quân", passwordHash: "x", role: "CS", active: true }).onConflictDoNothing();

  // (a) Giao hụt 10 ngày trước, người đã đóng ca 8 ngày trước, ĐVVC im từ đó.
  await db.insert(schema.orders).values({ id: "cca-o1", stage: "SHIPPED", status: 3, insertedAt: gio(300), billFullName: "Khách Cũ", billPhone: "0900000101" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "cca-s1", orderId: "cca-o1", carrier: "Viettel Post", vtpOrderNumber: "CCA001", stage: "DELIVERY_FAILED", codAmount: 400_000, vtpStatusDate: gio(240), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "cca-s1", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(240), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  await db.insert(schema.shipmentCare).values({ shipmentId: "cca-s1", orderId: "cca-o1", trackingNumber: "CCA001", episodeNo: 1, active: false, careStatus: "RESOLVED", openedAt: gio(239), doneAt: gio(200), careOutcome: "PENDING" });

  // (b) Ca đóng 30 giờ trước, rồi ĐVVC báo giao hụt MỚI 3 giờ trước.
  await db.insert(schema.orders).values({ id: "cca-o2", stage: "SHIPPED", status: 3, insertedAt: gio(100), billFullName: "Khách Mới Hỏng", billPhone: "0900000102" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "cca-s2", orderId: "cca-o2", carrier: "Viettel Post", vtpOrderNumber: "CCA002", stage: "DELIVERY_FAILED", codAmount: 500_000, vtpStatusDate: gio(3), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values([
    { shipmentId: "cca-s2", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(40), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" },
    { shipmentId: "cca-s2", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(3), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" },
  ]).onConflictDoNothing();
  await db.insert(schema.shipmentCare).values({ shipmentId: "cca-s2", orderId: "cca-o2", trackingNumber: "CCA002", episodeNo: 1, active: false, careStatus: "RESOLVED", openedAt: gio(39), doneAt: gio(30), careOutcome: "PENDING" });

  clearMemo();
  const q = await getCareQueue();
  assert.ok(!q.cases.some((c) => c.shipmentId === "cca-s1" && c.view === "care"), "(a) ca đã đóng, ĐVVC không báo gì mới ⇒ KHÔNG đứng ở Cần care như một ca mới chưa ai nhận");
  const r2 = q.cases.find((c) => c.shipmentId === "cca-s2");
  assert.equal(r2?.view, "care", "(b) sự cố MỚI sau lúc đóng ⇒ vào lại Cần care");
  assert.equal(r2?.reopened, true);

  // (a) Giao ⇒ từ chối có lý do, ca đã đóng KHÔNG bị ghi người.
  const g1 = await setCareOwner(actor, { shipmentIds: ["cca-s1"], ownerId: "cca-quan" });
  assert.ok("ok" in g1 && g1.ok);
  assert.equal(g1.data.states["cca-s1"], undefined, "không trả về trạng thái 'đã giao' giả");
  assert.match(g1.data.skipped[0]?.reason ?? "", /đã đóng/, "phải nói lý do: ca đã đóng, không có việc để giao");
  const dong1 = await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, "cca-s1") });
  assert.equal(dong1?.ownerId, null, "ca đã đóng KHÔNG bị ghi người — đó chính là chỗ F5 làm tên 'biến mất'");
  assert.equal(dong1?.active, false);

  // (b) Giao ⇒ mở lại ca rồi giao; F5 (đọc lại hàng đợi + ngăn chi tiết) vẫn thấy đúng người.
  const g2 = await setCareOwner(actor, { shipmentIds: ["cca-s2"], ownerId: "cca-quan" });
  assert.ok("ok" in g2 && g2.ok);
  assert.equal(g2.data.states["cca-s2"]?.owner?.name, "Trần Anh Quân");
  assert.equal(g2.data.states["cca-s2"]?.status, "ASSIGNED", "ca mở lại chưa ai cầm ⇒ giao xong là ASSIGNED");
  const dangMo = await db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, "cca-s2"), eq(schema.shipmentCare.active, true)) });
  assert.equal(dangMo?.ownerId, "cca-quan", "người được ghi vào ca ĐANG MỞ");
  clearMemo();
  const f5 = (await getCareQueue()).cases.find((c) => c.shipmentId === "cca-s2");
  assert.equal(f5?.care.owner?.name, "Trần Anh Quân", "F5: hàng đợi đọc lại vẫn thấy người được giao (lỗi chủ shop báo 25/09/2026)");
  assert.equal(f5?.view, "care");
  const chiTiet = await getCareCaseDetail("cca-s2");
  assert.equal(chiTiet?.care.owner?.name, "Trần Anh Quân", "ngăn chi tiết đọc lại cũng thấy đúng người");
  const suKien = await db.select().from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "cca-s2"));
  assert.ok(suKien.some((e) => e.action === "REOPEN") && suKien.some((e) => e.action === "ASSIGN"), "mở lại và giao đều để lại dấu vết");

  await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "cca-s2"));
  await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, "cca-s1"));
  await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, "cca-s2"));
  await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, "cca-s1"));
  await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, "cca-s2"));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, "cca-s1"));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, "cca-s2"));
  clearMemo();
  console.log("✓ Ca đã đóng không đứng ở Cần care; giao vào ca đã đóng bị từ chối có lý do; kiện vào lại Cần care thì giao = mở lại rồi giao, F5 vẫn thấy đúng người");
}
