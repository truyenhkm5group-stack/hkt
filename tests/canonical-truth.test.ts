import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { orderStageEnum, shipmentStageEnum, codStatusEnum } from "@/db/schema";
import { OUTCOME_GROUP, TRUTH_DIMENSIONS, TRUTH_DIMENSION_ORDER, CARRIER_DOCUMENT_SOURCES, CARRIER_EVENT_SOURCES, isFinishedOutcome, legTypeFromReturningFlag, outcomeGroup, sqlSourceList } from "@/lib/constants/truth";
import { OUTCOME_LABEL, type OrderOutcome } from "@/lib/constants/returns";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { deriveShipmentState, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

/**
 * LỚP CHÂN LÝ NGHIỆP VỤ — kiểm thử khoá năm chiều tách bạch.
 *
 * Mỗi khẳng định ở đây trả lời đúng một câu hỏi: "chiều này có bị suy ra từ chiều kia không?".
 * Đỏ nghĩa là CODE SAI. Đặc tả: docs/business-rules/ORDER_OUTCOME.md.
 */

let seq = 0;
const nextId = () => `cn-${++seq}`;

const track = (orderNumber: string, status: number, statusName: string, at: string, extra: Record<string, unknown> = {}) => ({
  orderNumber,
  orderReference: "",
  status,
  statusName,
  statusDate: new Date(at),
  location: "",
  note: "",
  reasonCode: null,
  isReturning: null,
  moneyCollectionOrigin: null,
  moneyCollection: 0,
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
  journey: [] as { status: number | null; statusName: string; location: string; note: string; occurredAt: Date | null; raw: Record<string, unknown> }[],
  raw: {},
  ...extra,
});

type Case = {
  orderStage?: string;
  shipmentStage?: string;
  codAmount?: number;
  codCollected?: number;
  codStatus?: "NOT_APPLICABLE" | "PENDING" | "COLLECTED" | "RECONCILED" | "PAID_TO_BANK" | "DISPUTED";
  events?: { status: string; stage: string; leg?: "OUTBOUND" | "RETURN"; source?: string }[];
};

async function makeOrder(db: Db, c: Case) {
  const id = nextId();
  await db.insert(schema.orders).values({ id, stage: (c.orderStage ?? "SHIPPED") as never, cod: 0, prepaid: 0, insertedAt: new Date() });
  const [ship] = await db
    .insert(schema.shipments)
    .values({
      orderId: id,
      vtpOrderNumber: `CN-${id}`,
      trackingCode: `CN-${id}`,
      stage: (c.shipmentStage ?? "IN_TRANSIT") as never,
      codAmount: c.codAmount ?? 0,
      codCollected: c.codCollected ?? 0,
      codStatus: (c.codStatus ?? "PENDING") as never,
      deliveredAt: c.shipmentStage === "DELIVERED" ? new Date("2026-09-01T10:00:00Z") : null,
      vtpStatusDate: new Date("2026-09-01T10:00:00Z"),
    })
    .returning({ id: schema.shipments.id });
  for (const [i, e] of (c.events ?? []).entries()) {
    await db.insert(schema.shipmentEvents).values({
      shipmentId: ship.id,
      source: e.source ?? "VTP_WEBHOOK",
      status: e.status,
      statusName: e.status,
      occurredAt: new Date(2026, 8, 1, 10 + i, 0, 0),
      normalizedStage: e.stage as never,
      legType: e.leg ?? "OUTBOUND",
    });
  }
  return { id, shipmentId: ship.id };
}

async function outcomeOf(db: Db, orderId: string): Promise<OrderOutcome> {
  const [row] = await db
    .select({ v: ORDER_OUTCOME })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, orderId));
  return row.v as OrderOutcome;
}

export async function testCanonicalTruth(db: Db) {
  // ───────── 0. Bảng đăng ký năm chiều phải đầy đủ và khớp schema ─────────
  assert.equal(TRUTH_DIMENSION_ORDER.length, 5, "phải có đúng năm chiều sự thật");
  for (const key of TRUTH_DIMENSION_ORDER) {
    const d = TRUTH_DIMENSIONS[key];
    assert.equal(d.key, key);
    assert.ok(d.sourceOfTruth.length > 0 && d.neverInferFrom.length > 0, `${key} phải nêu rõ nguồn sự thật và điều cấm suy ra`);
  }
  assert.deepEqual([...TRUTH_DIMENSIONS.order_status.values], [...orderStageEnum.enumValues], "chiều trạng thái đơn phải khớp enum trong schema");
  assert.deepEqual([...TRUTH_DIMENSIONS.shipment_status.values], [...shipmentStageEnum.enumValues], "chiều trạng thái vận đơn phải khớp enum trong schema");
  assert.deepEqual([...TRUTH_DIMENSIONS.payment_status.values], [...codStatusEnum.enumValues], "chiều tiền phải khớp enum trong schema");
  assert.deepEqual(Object.keys(OUTCOME_GROUP).sort(), Object.keys(OUTCOME_LABEL).sort(), "mọi kết quả đơn phải được xếp nhóm");
  assert.equal(outcomeGroup("RETURNED_BY_RULE"), "RETURNED", "50K–100K luôn được gộp vào nhóm hoàn");
  assert.equal(isFinishedOutcome("CANCELLED"), false, "đơn huỷ KHÔNG nằm trong mẫu số tỷ lệ giao thành công");
  assert.equal(isFinishedOutcome("IN_TRANSIT"), false);
  assert.ok(isFinishedOutcome("DELIVERED") && isFinishedOutcome("RETURNED"));

  // Danh sách nguồn phải là MỘT bản: chứng từ máy không được có MANUAL.
  assert.ok(!(CARRIER_DOCUMENT_SOURCES as readonly string[]).includes("MANUAL"), "mã trạng thái CUỐI chỉ được đọc từ chứng từ máy của ĐVVC");
  assert.ok((CARRIER_EVENT_SOURCES as readonly string[]).includes("MANUAL"));
  assert.ok(!(CARRIER_EVENT_SOURCES as readonly string[]).includes("PANCAKE"), "bản sao hành trình Pancake không được quyền dựng trạng thái");
  assert.equal(sqlSourceList(["A", "B"]), "'A','B'");
  assert.equal(legTypeFromReturningFlag(null), null, "ĐVVC không gửi cờ chiều thì KHÔNG đoán");
  assert.equal(legTypeFromReturningFlag(true), "RETURN");
  assert.equal(legTypeFromReturningFlag(false), "OUTBOUND");

  // ───────── 1. Chứng từ logistics của ĐVVC ⇒ GIAO THÀNH CÔNG ─────────
  const c1 = await makeOrder(db, { shipmentStage: "DELIVERED", codAmount: 499_000, events: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] });
  assert.equal(await outcomeOf(db, c1.id), "DELIVERED", "1. mã 501 chiều đi là bằng chứng giao hàng mạnh nhất");

  // ───────── 2. Tiền đã về ngân hàng + logistics chưa biết ⇒ KHÔNG ĐƯỢC là giao thành công ─────────
  const c2 = await makeOrder(db, { orderStage: "SHIPPED", shipmentStage: "PENDING", codAmount: 499_000, codCollected: 499_000, codStatus: "PAID_TO_BANK" });
  const o2 = await outcomeOf(db, c2.id);
  assert.notEqual(o2, "DELIVERED", "2. tiền về ngân hàng KHÔNG chứng minh hàng tới tay khách");
  assert.equal(outcomeGroup(o2), "OPEN", "2. thiếu chứng từ logistics thì đơn vẫn là chưa kết thúc");

  // ───────── 3. COD đã đối soát + vận đơn đang hoàn ⇒ HOÀN ─────────
  const c3 = await makeOrder(db, { shipmentStage: "RETURNING", codAmount: 499_000, codCollected: 499_000, codStatus: "RECONCILED", events: [{ status: "505", stage: "RETURNING" }] });
  assert.equal(outcomeGroup(await outcomeOf(db, c3.id)), "RETURNED", "3. đối soát xong vẫn không cứu được đơn đang hoàn");

  // ───────── 4. COD đã thu + giao thất bại ⇒ không phải thành công ─────────
  const c4 = await makeOrder(db, { shipmentStage: "DELIVERY_FAILED", codAmount: 499_000, codCollected: 499_000, codStatus: "COLLECTED", events: [{ status: "506", stage: "DELIVERY_FAILED" }] });
  const o4 = await outcomeOf(db, c4.id);
  assert.notEqual(o4, "DELIVERED", "4. giao thất bại thì tiền đã thu cũng không thành giao thành công");
  assert.equal(o4, "IN_TRANSIT", "4. giao thất bại là CHƯA KẾT THÚC (còn chờ phát lại), không phải hoàn");

  // ───────── 5. Pancake nói khác ĐVVC ⇒ logistics thắng, và bản sao Pancake không ghi đè ─────────
  const c5 = await makeOrder(db, { orderStage: "DELIVERED", shipmentStage: "RETURNING", codAmount: 499_000, events: [{ status: "505", stage: "RETURNING" }] });
  assert.equal(outcomeGroup(await outcomeOf(db, c5.id)), "RETURNED", "5. Pancake báo 'Đã nhận' không lật được chứng từ ĐVVC");
  // Bản sao hành trình Pancake đến SAU và nói "đã giao" — vẫn không được đổi trạng thái vận đơn.
  await db.insert(schema.shipmentEvents).values({
    shipmentId: c5.shipmentId,
    source: "PANCAKE",
    status: "501",
    statusName: "Phát thành công",
    occurredAt: new Date("2026-09-30T00:00:00Z"),
    normalizedStage: "DELIVERED",
    legType: "OUTBOUND",
  });
  const derived5 = await deriveShipmentState(db, c5.shipmentId);
  assert.equal(derived5?.stage, "RETURNING", "5. bản sao Pancake KHÔNG được quyền kết luận trạng thái vận đơn");
  await materializeShipmentState(db, c5.shipmentId);
  const [ship5] = await db.select({ stage: schema.shipments.stage }).from(schema.shipments).where(eq(schema.shipments.id, c5.shipmentId));
  assert.equal(ship5.stage, "RETURNING", "5. ảnh chụp vận đơn vẫn giữ sự thật logistics");
  assert.equal(outcomeGroup(await outcomeOf(db, c5.id)), "RETURNED");

  // ───────── 6. Gói tin LẶP cho kết quả y hệt ─────────
  const dupe = "CN-DUP-1";
  const first = await applyVtpTracking(track(dupe, 501, "Thành công - Phát thành công", "2026-09-05T10:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const [afterFirst] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupe));
  const second = await applyVtpTracking(track(dupe, 501, "Thành công - Phát thành công", "2026-09-05T10:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const [afterSecond] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupe));
  assert.equal(first?.changed, true, "6. gói tin đầu phải được áp dụng");
  assert.equal(second?.changed, false, "6. gói tin lặp không được đếm là một lần cập nhật");
  assert.equal(second?.reason, "duplicate", "6. lý do phải nói rõ là gói tin lặp");
  assert.equal(afterFirst.stage, afterSecond.stage, "6. trạng thái sau khi lặp phải y hệt");
  assert.equal(afterFirst.vtpStatusDate?.getTime(), afterSecond.vtpStatusDate?.getTime());
  const [{ n: dupEvents }] = await db
    .select({ n: schema.shipmentEvents.id })
    .from(schema.shipmentEvents)
    .where(eq(schema.shipmentEvents.shipmentId, afterFirst.id))
    .then((rows) => [{ n: rows.length }]);
  assert.equal(dupEvents, 1, "6. gói tin lặp không được nhân đôi lịch sử");

  // ───────── 7. Sự kiện đến MUỘN không phá trạng thái ─────────
  const late = await applyVtpTracking(track(dupe, 300, "Đóng tải - vận chuyển đi", "2026-09-01T08:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const [afterLate] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, dupe));
  assert.equal(afterLate.stage, "DELIVERED", "7. sự kiện cũ hơn đến sau không được kéo lùi trạng thái");
  assert.equal(late?.reason, "stale", "7. phải nói rõ đây là sự kiện đến muộn, không phải đã áp dụng");
  // Xác định: dựng lại từ lịch sử cho đúng kết quả đó, không phụ thuộc thứ tự tới.
  const derived7 = await deriveShipmentState(db, afterLate.id);
  assert.equal(derived7?.stage, "DELIVERED", "7. trạng thái là hàm của TẬP sự kiện, không của thứ tự nhận");

  // ───────── 8. Mã lạ của ĐVVC ⇒ KHÔNG RÕ, không bao giờ âm thầm thành công ─────────
  assert.equal(resolveVtpStatus({ code: 9999, text: "" }).stage, "UNKNOWN", "8. mã ngoài mọi nhóm là KHÔNG RÕ");
  assert.equal(resolveVtpStatus({ code: 9999, text: "" }).basis, "unknown", "8. phải nói rõ là không có căn cứ");
  assert.equal(resolveVtpStatus({ code: null, text: "" }).stage, "UNKNOWN");
  const odd = "CN-ODD-1";
  await applyVtpTracking(track(odd, 300, "Đóng tải - vận chuyển đi", "2026-09-02T08:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  await applyVtpTracking(track(odd, 9999, "Trạng thái lạ", "2026-09-06T08:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const [afterOdd] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, odd));
  assert.equal(afterOdd.stage, "IN_TRANSIT", "8. mã lạ giữ nguyên trạng thái cũ, không đổi thành giao thành công");
  assert.notEqual(afterOdd.stage, "DELIVERED");
  const oddDerived = await deriveShipmentState(db, afterOdd.id);
  assert.equal(oddDerived?.stage, "IN_TRANSIT", "8. sự kiện KHÔNG RÕ bị loại khỏi việc dựng trạng thái, không bị đoán");
  // Nhưng vẫn phải nhìn thấy được: sự kiện lạ được lưu nguyên vẹn để xử lý lại.
  const oddEvents = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, afterOdd.id));
  assert.ok(oddEvents.some((e) => e.status === "9999"), "8. sự kiện lạ phải được lưu lại, không bị nuốt");

  console.log(`✓ Lớp chân lý: 5 chiều tách bạch · tiền không suy ra giao hàng (4 ca) · Pancake không ghi đè ĐVVC · lặp/muộn/mã lạ đều xác định`);
}
