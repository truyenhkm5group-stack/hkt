import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { applyCarrierEventToCare, NOT_CARE_CONDITION, reconcileCareCoverage } from "@/lib/care/lifecycle";

/**
 * ═══════════ ĐỢT NGƯỜI ĐÃ ĐÓNG VẪN PHẢI ĐƯỢC CHỐT — VÀ KHÔNG ĐƯỢC CHỐT NGƯỢC THỜI GIAN ═══════════
 *
 * Đo production 23/09/2026 trên 70 đợt "Đang treo": 3 đợt nhân viên đã bấm xong từ 16/09 trên kiện
 * Viettel Post ĐÃ GIAO vẫn treo — bộ đối chiếu chỉ quét đợt `active = true`, nên đợt đã đóng mà
 * gói tin kết cục đi đường khác không bao giờ được chốt. Và cả ba đợt ấy được MỞ ngày 12/09 trên
 * kiện đã giao từ 07–10/09: chốt chúng là "Cứu được" là gán công ngược thời gian (luật 56).
 */

const P = "csc-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

async function dung(db: Db, id: string, ship: Partial<typeof schema.shipments.$inferInsert>, care: Partial<typeof schema.shipmentCare.$inferInsert>) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(200) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), stage: "DELIVERY_FAILED", codAmount: 300_000, pickedUpAt: gio(150), ...ship })
    .onConflictDoNothing();
  await db.insert(schema.shipmentCare).values({
    shipmentId: `${P}${id}`, orderId: `${P}o-${id}`, episodeNo: 1, active: false, careStatus: "RESOLVED",
    sourceTrigger: "CARRIER_EVENT", entryCarrierState: "WAITING_REDELIVERY", openedAt: gio(100), doneAt: gio(90), careOutcome: "PENDING", updatedBy: "SYSTEM", ...care,
  });
  return `${P}${id}`;
}

const dot = async (db: Db, shipmentId: string) => (await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, shipmentId) }))!;

export async function testCareSettleClosed(db: Db) {
  const U = `${P}u`;
  await db.insert(schema.users).values({ id: U, email: "csc@shop.vn", name: "Người đóng ca", passwordHash: "x", role: "CS" }).onConflictDoNothing();

  // 1 · Người đã đóng, ĐVVC giao SAU lúc mở ⇒ chốt "cứu được", quy về người cầm ca, KHÔNG đổi trạng thái người đã chọn.
  const dongLuc = gio(90);
  const a = await dung(db, "a", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công", vtpStatusDate: gio(50) }, { ownerId: U, doneAt: dongLuc });
  // 2 · Người đã đóng, ĐVVC đã giao TRƯỚC lúc mở ⇒ không phải kết quả của đợt: rời mọi tỷ lệ.
  const b = await dung(db, "b", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công", vtpStatusDate: gio(120) }, { ownerId: U });
  // 3 · Người đã đóng, kiện hoàn về ⇒ không cứu được.
  const c = await dung(db, "c", { stage: "RETURNED", vtpStatus: 504, vtpStatusName: "Hoàn thành công", vtpStatusDate: gio(40) }, { ownerId: U });
  // 4 · Người đã đóng, kiện CHƯA kết thúc ⇒ để yên (không đoán kết quả, không tự đóng).
  const d = await dung(db, "d", { stage: "DELIVERY_FAILED", vtpStatus: 506, vtpStatusName: "Tồn - khách nghỉ", vtpStatusDate: gio(30) }, { ownerId: U });

  const lan1 = await reconcileCareCoverage(db, new Date(), { shipmentIds: [a, b, c, d] });

  const A = await dot(db, a);
  assert.equal(A.careOutcome, "RESCUED_DIRECT", "đợt đã đóng trên kiện đã giao phải được chốt — trước đây treo vĩnh viễn");
  assert.equal(A.ownerAtResolution, U, "kết quả quy về người đang cầm ca");
  assert.equal(A.careStatus, "RESOLVED", "chốt kết quả KHÔNG đổi trạng thái người đã chọn");
  assert.equal(A.doneAt?.getTime(), dongLuc.getTime(), "mốc người đóng giữ nguyên — chốt kết quả không phải một lần đóng ca");

  const B = await dot(db, b);
  assert.equal(B.careOutcome, null, "kiện giao TRƯỚC lúc mở ca ⇒ không có kết quả cứu đơn");
  assert.equal(B.resolution, NOT_CARE_CONDITION, "rời mọi tỷ lệ như đợt không phải điều kiện care");
  assert.equal(B.ownerAtResolution, null, "không quy kết quả cho ai");
  const nhatKy = await db.query.careCaseEvents.findMany({ where: eq(schema.careCaseEvents.shipmentId, b) });
  assert.ok(nhatKy.some((e) => (e.note ?? "").includes("TRƯỚC khi đợt được mở")), "nhật ký phải nói rõ vì sao đợt không có kết quả");

  assert.equal((await dot(db, c)).careOutcome, "RESCUE_FAILED");
  const D = await dot(db, d);
  assert.equal(D.careOutcome, "PENDING", "kiện chưa kết thúc ⇒ vẫn chờ");
  assert.equal(D.resolution, null, "đợt đã đóng KHÔNG bao giờ đi xuống vế tự đóng");

  assert.equal(lan1.settled, 3, "ba đợt được chốt / loại ở lượt đầu");
  const lan2 = await reconcileCareCoverage(db, new Date(), { shipmentIds: [a, b, c, d] });
  assert.equal(lan2.settled, 0, "chạy lại không ghi gì thêm (idempotent)");

  /*
    4b · KIỆN HAI ĐỢT CÙNG TREO. Đường sự kiện chỉ chốt đợt mới nhất; đợt cũ từng treo vĩnh viễn
    (production 23/09/2026: PKE1517808423 đợt 1 và 2 trên kiện đã hoàn từ 18/09). Bộ đối chiếu chốt
    CẢ HAI theo cùng chứng từ; phân loại bản sao / thật (luật 62) là việc của phía đọc.
  */
  const g = await dung(db, "g", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công", vtpStatusDate: gio(5) }, { ownerId: U });
  await db.insert(schema.shipmentCare).values({
    shipmentId: g, orderId: `${P}o-g`, episodeNo: 2, active: true, careStatus: "NEW",
    sourceTrigger: "RECONCILE", entryCarrierState: "WAITING_REDELIVERY", openedAt: gio(60), careOutcome: "PENDING", updatedBy: "SYSTEM",
  });
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [g] });
  const haiDot = await db.query.shipmentCare.findMany({ where: eq(schema.shipmentCare.shipmentId, g), orderBy: (t, { asc }) => [asc(t.episodeNo)] });
  assert.deepEqual(haiDot.map((x) => x.careOutcome), ["RESCUED_DIRECT", "RESCUED_DIRECT"], "đợt cũ KHÔNG còn bị bỏ quên khi kiện đã kết thúc");
  assert.deepEqual(haiDot.map((x) => x.ownerAtResolution), [U, null], "mỗi đợt quy về người đang cầm CHÍNH đợt đó");

  // 5 · Đường sự kiện cũng mang cùng chốt chặn: gói tin "đã giao" với mốc trước lúc mở đợt.
  const e = await dung(db, "e", { stage: "DELIVERY_FAILED", vtpStatus: 506 }, { active: true, careStatus: "IN_PROGRESS", ownerId: U, doneAt: null, openedAt: gio(10) });
  const kq = await applyCarrierEventToCare(db, { shipmentId: e, orderId: `${P}o-e`, trackingNumber: e.toUpperCase(), stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công", legType: "OUTBOUND", occurredAt: gio(20) });
  assert.equal(kq.dismissed, true, "gói tin đến muộn mang mốc trước lúc mở đợt ⇒ không chốt thành cứu được");
  assert.equal((await dot(db, e)).careOutcome, null);

  // Đối chứng: cùng gói tin nhưng mốc SAU lúc mở ⇒ chốt bình thường (chốt chặn không nuốt ca thật).
  const f = await dung(db, "f", { stage: "DELIVERY_FAILED", vtpStatus: 506 }, { active: true, careStatus: "IN_PROGRESS", ownerId: U, doneAt: null, openedAt: gio(10) });
  const kq2 = await applyCarrierEventToCare(db, { shipmentId: f, orderId: `${P}o-f`, trackingNumber: f.toUpperCase(), stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Phát thành công", legType: "OUTBOUND", occurredAt: gio(2) });
  assert.equal(kq2.resolved, true);
  assert.equal((await dot(db, f)).careOutcome, "RESCUED_DIRECT");

  /*
    DỌN DỮ LIỆU CỦA BÀI NÀY. Bộ dữ liệu mẫu là CHUNG: `projected-delivery` học xác suất "chờ phát lại
    → giao được" từ MỌI đơn 90 ngày và ghim đúng 8/12 — một đơn đã giao và một đơn hoàn gieo ở đây
    đủ làm nó đỏ. Bài này chỉ cần dữ liệu trong lúc nó chạy, nên nó trả lại bộ dữ liệu như cũ.
  */
  await db.delete(schema.careCaseEvents).where(like(schema.careCaseEvents.shipmentId, `${P}%`));
  await db.delete(schema.shipmentCare).where(like(schema.shipmentCare.shipmentId, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));

  console.log("✓ Đợt người đã đóng vẫn được chốt theo chứng từ ĐVVC · kết cục có trước lúc mở ca không bao giờ thành \"cứu được\" · chạy lại không ghi thêm");
}
