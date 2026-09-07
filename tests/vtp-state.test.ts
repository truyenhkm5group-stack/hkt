import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { applyVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";
import { deriveShipmentState, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { clearMemo } from "@/lib/cache";

const track = (orderNumber: string, status: number, statusName: string, at: string) => ({
  orderNumber, orderReference: "", status, statusName,
  statusDate: new Date(at), location: "", note: "", reasonCode: null, isReturning: null, moneyCollectionOrigin: null,
  moneyCollection: 0, moneyTotal: 0, moneyTotalFee: 0, moneyFeeCod: 0, productWeight: 0,
  service: "", expectedDelivery: "", receiverName: "", receiverPhone: "", receiverAddress: "",
  employeeName: "", employeePhone: "", journey: [], raw: {},
});

/**
 * Trạng thái vận đơn phải là HÀM CỦA LỊCH SỬ, và mọi luồng nhập liệu phải hiểu cùng một trạng
 * thái của Viettel Post theo cùng một cách.
 */
export async function testVtpState(db: Db) {
  // ───────── 1. Một bộ dịch duy nhất: mã số và chữ không được nói hai điều khác nhau ─────────
  // Đây là ca lệch thật: mã 504 là ĐÃ HOÀN XONG, nhưng bộ dịch theo chữ cũ đọc "chuyển trả" ra
  // ĐANG HOÀN. Cùng một vận đơn nhập bằng hai đường sẽ cho hai kết luận khác nhau.
  const byCode = resolveVtpStatus({ code: 504, text: "Thành công - Chuyển trả người gửi" });
  assert.equal(byCode.stage, "RETURNED", "mã số chính thức là căn cứ mạnh nhất");
  assert.equal(byCode.final, true);
  assert.equal(byCode.basis, "code");
  assert.equal(resolveVtpStatus({ code: null, text: "Đã trả" }).stage, "RETURNED", "tệp không có mã số thì đọc theo chữ");
  assert.equal(resolveVtpStatus({ code: null, text: "" }).stage, "UNKNOWN", "không đủ căn cứ thì KHÔNG RÕ, không đoán bừa");
  assert.equal(resolveVtpStatus({ code: 9999, text: "" }).stage, "UNKNOWN", "mã lạ ngoài mọi nhóm vẫn là KHÔNG RÕ");
  assert.equal(resolveVtpStatus({ code: 553, text: "" }).stage, "OUT_FOR_DELIVERY", "mã lạ trong nhóm 5xx suy theo nhóm");

  // Bản sao hành trình từ Pancake và STATUS_NAME của webhook KHÔNG có mã số, và dùng từ vựng khác
  // hẳn cột "Trạng Thái" của tệp Excel. Thiếu nhóm này thì lịch sử gần như không đọc được.
  const theoChu = (text: string) => resolveVtpStatus({ code: null, text }).stage;
  assert.equal(theoChu("Thành công - Chuyển trả người gửi"), "RETURNED", "hoàn XONG, không được đọc thành đang hoàn");
  assert.equal(theoChu("Tồn - Thông báo chuyển hoàn bưu cục gốc"), "RETURNING");
  assert.equal(theoChu("Tồn - Khách hàng nghỉ, không có nhà"), "DELIVERY_FAILED");
  assert.equal(theoChu("Tồn - Khách hàng đến bưu cục nhận"), "DELIVERY_FAILED");
  assert.equal(theoChu("Giao bưu tá đi phát"), "OUT_FOR_DELIVERY");
  assert.equal(theoChu("Nhận bảng kê đến"), "IN_TRANSIT");
  assert.equal(theoChu("Đóng bảng kê đi"), "IN_TRANSIT");
  assert.equal(theoChu("Giao cho Bưu tá đi nhận"), "PENDING");
  assert.equal(theoChu("Đơn hàng chờ xử lý"), "PENDING");
  assert.equal(theoChu("Giao cho bưu cục"), "PENDING");
  assert.equal(theoChu("Sửa phiếu gửi"), "PICKED_UP");
  assert.equal(theoChu("Thành công - Phát thành công"), "DELIVERED");
  // Từ vựng của tệp Excel vẫn phải giữ nguyên nghĩa cũ.
  assert.equal(theoChu("Giao thành công"), "DELIVERED");
  assert.equal(theoChu("Shop hủy lấy"), "CANCELLED");
  assert.equal(theoChu("Chờ phát lại"), "DELIVERY_FAILED");

  // ───────── 2. Sự kiện đến MUỘN không được kéo lùi trạng thái ─────────
  const A = "PKE-STATE-A";
  await applyVtpTracking(track(A, 501, "Thành công - Phát thành công", "2026-09-05T10:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const afterDelivered = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, A));
  assert.equal(afterDelivered[0].stage, "DELIVERED");
  assert.equal(afterDelivered[0].isFinal, true);

  const late = await applyVtpTracking(track(A, 400, "Nhận bảng kê đến", "2026-09-05T09:30:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const afterLate = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, A));
  assert.equal(afterLate[0].stage, "DELIVERED", "gói tin đến muộn mang sự kiện cũ hơn không được hạ trạng thái");
  assert.equal(late?.reason, "stale", "phải nói rõ là sự kiện cũ, không được ghi 'đã áp dụng'");
  const events = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, afterLate[0].id));
  assert.ok(events.some((e) => e.status === "400"), "sự kiện cũ vẫn phải nằm trong lịch sử, không bị vứt");

  // Gói tin lặp y hệt: không đổi gì, không nhân đôi tác động.
  const dup = await applyVtpTracking(track(A, 501, "Thành công - Phát thành công", "2026-09-05T10:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  assert.equal(dup?.changed, false);
  assert.equal(dup?.reason, "duplicate");
  const afterDup = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, afterLate[0].id));
  assert.equal(afterDup.length, events.length, "gói tin lặp không sinh thêm sự kiện");

  // ───────── 3. Trạng thái LẠ không được im lặng ghi đè trạng thái đang đúng ─────────
  const unknown = await applyVtpTracking(track(A, 9999, "Trạng thái lạ chưa có trong bảng", "2026-09-06T10:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const afterUnknown = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, A));
  assert.equal(afterUnknown[0].stage, "DELIVERED", "trạng thái không hiểu được thì giữ nguyên trạng thái cũ");
  assert.ok(unknown, "vẫn phải nhận và lưu, không được ném lỗi về phía Viettel Post");

  // ───────── 4. Webhook và nhập tệp cho CÙNG kết quả với cùng trạng thái ─────────
  const B = "PKE-STATE-B";
  await applyVtpTracking(track(B, 501, "Thành công - Phát thành công", "2026-09-04T08:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const header = "Mã Vận Đơn,Mã đơn hàng,Ngày tạo,Tổng cước (1),VAT (2),Tổng phí (9)= (3)+(5)+(6)+(7)-(8),Tiền thu hộ (4),Trạng Thái,Trạng thái đối soát COD,Trạng thái thanh toán,Đơn chuyển hoàn,Ngày chuyển trạng thái";
  const C = "PKE-STATE-C";
  const line = `${C},REF-C,01/09/2026 08:00:00,15741,1259,17000,120000,Giao thành công,Chưa đối soát COD,Đã thanh toán,,04/09/2026 15:00:00`;
  await db.insert(schema.shipments).values({ id: "state-c", vtpOrderNumber: C, stage: "IN_TRANSIT" });
  await applyVtpOrderList(parseVtpOrderList(`${header}\n${line}`), "fixture");
  const [webhookSide] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, B));
  const [fileSide] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, C));
  assert.equal(fileSide.stage, webhookSide.stage, "cùng 'giao thành công' thì webhook và tệp phải ra cùng trạng thái");
  assert.equal(fileSide.isFinal, webhookSide.isFinal, "và cùng kết luận đã kết thúc hay chưa");

  // ───────── 4b. Mã tham chiếu dài hơn int4 không được làm hỏng cả gói tin ─────────
  // Webhook THỬ của Viettel Post gửi ORDER_REFERENCE = 123456789101112; so thẳng với
  // orders.system_id (int4) làm Postgres báo "value out of range for type integer".
  const huge = await applyVtpTracking(
    { ...track("PKE-STATE-HUGE", 500, "Giao bưu tá đi phát", "2026-09-05T11:00:00Z"), orderReference: "123456789101112" },
    "VTP_WEBHOOK",
    { allowCreate: true },
  );
  assert.ok(huge, "mã tham chiếu quá lớn vẫn phải xử lý được, không được ném lỗi");
  assert.equal(huge?.stage, "OUT_FOR_DELIVERY");

  // ───────── 4c. Mã 501 của CHIỀU HOÀN không phải là giao thành công ─────────
  // Viettel Post đặt mã 501 tên "Thành công - Phát thành công" cho cả phát tới khách lẫn phát
  // hàng hoàn về shop. Cờ IS_RETURNING (ghi vào leg_type) là thứ duy nhất phân biệt.
  await db.insert(schema.orders).values({ id: "leg-order", insertedAt: new Date() });
  const [legShip] = await db.insert(schema.shipments)
    .values({ orderId: "leg-order", vtpOrderNumber: "PKE-LEG-501", stage: "RETURNING" })
    .returning({ id: schema.shipments.id });
  await db.insert(schema.shipmentEvents).values([
    { shipmentId: legShip.id, source: "VTP_WEBHOOK", status: "505", statusName: "Tồn - Thông báo chuyển hoàn bưu cục gốc",
      occurredAt: new Date("2026-09-08T01:00:00Z"), normalizedStage: "RETURNING", legType: "OUTBOUND" },
    { shipmentId: legShip.id, source: "VTP_WEBHOOK", status: "501", statusName: "Thành công - Phát thành công",
      occurredAt: new Date("2026-09-09T01:00:00Z"), normalizedStage: "DELIVERED", legType: "RETURN" },
  ]);
  await materializeShipmentState(db, legShip.id);
  const [legAfter] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, legShip.id));
  assert.equal(legAfter.stage, "RETURNED", "501 của chiều hoàn là hàng ĐÃ VỀ SHOP, tuyệt đối không phải giao thành công");
  assert.equal(legAfter.isFinal, true, "hàng hoàn đã về tới shop là trạng thái kết thúc");

  // Còn 500 (đi phát) trên chiều hoàn thì hàng vẫn đang trên đường về, chưa kết thúc.
  await db.insert(schema.shipmentEvents).values({
    shipmentId: legShip.id, source: "VTP_WEBHOOK", status: "500", statusName: "Giao bưu tá đi phát",
    occurredAt: new Date("2026-09-10T01:00:00Z"), normalizedStage: "OUT_FOR_DELIVERY", legType: "RETURN",
  });
  await materializeShipmentState(db, legShip.id);
  const [legMoving] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, legShip.id));
  assert.equal(legMoving.stage, "RETURNING", "đang phát trên chiều hoàn = hàng vẫn đang về, không phải đang giao cho khách");
  assert.equal(legMoving.isFinal, false);

  // ───────── 5. Bản sao hành trình từ Pancake không được quyền kết luận ─────────
  // Mốc của sự kiện Pancake là giờ Pancake ghi nhận, không phải giờ sự kiện của ĐVVC. Trộn vào
  // thì vận đơn đã giao xong bị kéo ngược về "đang đi phát" (đo được 122 ca trên production).
  await db.insert(schema.shipmentEvents).values({
    shipmentId: afterLate[0].id, source: "PANCAKE", status: "Giao bưu tá đi phát",
    statusName: "Giao bưu tá đi phát", occurredAt: new Date("2026-09-09T00:00:00Z"), normalizedStage: "OUT_FOR_DELIVERY",
  });
  const sauPancake = await materializeShipmentState(db, afterLate[0].id);
  assert.equal(sauPancake.changed, false, "bản sao Pancake mới hơn không được đổi trạng thái");
  const [vanConGiao] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, afterLate[0].id));
  assert.equal(vanConGiao.stage, "DELIVERED", "trạng thái vẫn theo Viettel Post");

  // ───────── 5. Dựng lại nhiều lần cho cùng kết quả (idempotent) ─────────
  const again = await materializeShipmentState(db, fileSide.id);
  assert.equal(again.changed, false, "dựng lại trên cùng tập sự kiện không được báo thay đổi");
  const derived = await deriveShipmentState(db, afterLate[0].id);
  assert.ok(derived);
  assert.equal(derived.stage, "DELIVERED");
  assert.equal(derived.decidedBy.source, "VTP_WEBHOOK", "phải giải thích được sự kiện nào quyết định trạng thái");
  assert.equal(derived.deliveredAt?.toISOString(), "2026-09-05T10:00:00.000Z", "mốc giao lấy lần ĐẦU đạt tới, theo giờ của ĐVVC");

  // ───────── 6. Hàng quay về thì không phải giao thành công, dù ĐVVC ghi 501 ─────────
  // Hai ca thật chủ shop chỉ ra: cùng mã 501 nhưng kết quả trái ngược nhau.
  const { ORDER_OUTCOME } = await import("@/lib/queries/return-rate");
  const ketQua = async (id: string) => {
    const [r] = await db.select({ v: ORDER_OUTCOME }).from(schema.orders)
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(eq(schema.orders.id, id));
    return r?.v;
  };
  const giao = new Date("2026-09-06T09:26:34Z");
  const dungMa501 = async (id: string, code: string) => {
    await db.insert(schema.orders).values({ id, stage: "DELIVERED", cod: 849_000, insertedAt: new Date() });
    const [sp] = await db.insert(schema.shipments).values({ orderId: id, vtpOrderNumber: code, trackingCode: code,
      stage: "DELIVERED", vtpStatus: 501, codAmount: 849_000, deliveredAt: giao, vtpStatusDate: giao }).returning({ id: schema.shipments.id });
    await db.insert(schema.shipmentEvents).values({ shipmentId: sp.id, source: "VTP_WEBHOOK", status: "501",
      statusName: "Thành công - Phát thành công", occurredAt: giao, normalizedStage: "DELIVERED", legType: "OUTBOUND" });
    return sp.id;
  };

  // Ca PKE1508909064: 501, không vận đơn chiều hoàn, không sửa doanh thu → GIAO THÀNH CÔNG.
  await dungMa501("ca-giao-that", "PKE-OK-501");
  assert.equal(await ketQua("ca-giao-that"), "DELIVERED", "501 sạch thì là giao thành công, không được suy theo tiền");

  // Ca PKE1508909058: 501 nhưng Viettel Post tạo vận đơn chiều hoàn mang hàng về shop → ĐƠN HOÀN.
  await dungMa501("ca-hang-quay-ve", "PKE-BACK-501");
  await db.insert(schema.shipments).values({ vtpOrderNumber: "PKE-BACK-5011P1", trackingCode: "PKE-BACK-5011P1",
    orderReference: "PKE-BACK-501", stage: "RETURNING", codAmount: 0 });
  assert.equal(await ketQua("ca-hang-quay-ve"), "RETURNED", "có vận đơn chiều hoàn thì hàng đã về shop, không phải giao thành công");

    console.log("✓ Trạng thái vận đơn dựng từ lịch sử: một bộ dịch chung, sự kiện muộn không kéo lùi, gói tin lặp vô hại, trạng thái lạ không ghi đè");
}

/**
 * Hiệu suất giao vận phải tính từ hành trình, và tuyệt đối không được coi vận đơn đang đi là
 * giao thất bại — đó là cách các báo cáo logistics hay nói dối nhất.
 */
export async function testLogisticsPerformance(db: Db) {
  const { logisticsPerformance } = await import("@/lib/queries/logistics");
  const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

  const mk = async (id: string, steps: { stage: "PICKED_UP" | "OUT_FOR_DELIVERY" | "DELIVERED" | "DELIVERY_FAILED" | "RETURNED"; at: string }[], isFinal: boolean) => {
    await db.insert(schema.shipments).values({ id, vtpOrderNumber: `LOG-${id}`, stage: steps[steps.length - 1].stage, isFinal, createdAt: new Date("2026-07-01T00:00:00Z") });
    for (const [i, st] of steps.entries()) {
      await db.insert(schema.shipmentEvents).values({
        shipmentId: id, source: "VTP_WEBHOOK", status: `log-${i}`, statusName: st.stage,
        occurredAt: new Date(st.at), normalizedStage: st.stage,
      });
    }
  };

  const before = await logisticsPerformance(ALL);

  // Giao ngay lần đầu: lấy hàng sau 2h, giao sau 24h nữa.
  await mk("log-ok", [
    { stage: "PICKED_UP", at: "2026-07-01T02:00:00Z" },
    { stage: "DELIVERED", at: "2026-07-02T02:00:00Z" },
  ], true);
  // Phát hụt một lần rồi mới giao được → không tính vào "thành công ngay lần đầu".
  await mk("log-retry", [
    { stage: "PICKED_UP", at: "2026-07-01T02:00:00Z" },
    { stage: "DELIVERY_FAILED", at: "2026-07-02T02:00:00Z" },
    { stage: "DELIVERED", at: "2026-07-03T02:00:00Z" },
  ], true);
  // Đang trên đường, chưa kết thúc → KHÔNG được tính là thất bại.
  await mk("log-flying", [{ stage: "OUT_FOR_DELIVERY", at: "2026-07-01T02:00:00Z" }], false);

  clearMemo();
  const after = await logisticsPerformance(ALL);
  assert.equal(after.delivered, before.delivered + 2, "đếm đúng số vận đơn đã giao");
  assert.equal(after.inFlight, before.inFlight + 1, "vận đơn đang đi được đếm riêng");
  assert.ok(after.terminal < after.tracked, "mẫu số 'đã kết thúc' phải nhỏ hơn 'có hành trình'");
  assert.ok(
    after.successRateAll !== null && after.successRateTerminal !== null && after.successRateAll < after.successRateTerminal,
    "tính trên mọi vận đơn thì tỷ lệ phải thấp hơn tính trên đơn đã kết thúc — hai mẫu số khác nhau, phải nêu rõ cả hai",
  );
  assert.ok(after.firstAttemptRate !== null && after.firstAttemptRate < 100, "đơn phải phát lại không được tính là thành công ngay lần đầu");
  assert.ok(after.pickupHours.p50 !== null && after.pickupHours.p50 > 0, "đo được thời gian lấy hàng");
  assert.ok(after.deliveryHours.p50 !== null && after.deliveryHours.p50 > 0, "đo được thời gian giao từ lúc lấy hàng");
  assert.ok(after.deliveryHours.sample >= before.deliveryHours.sample + 2, "hai vận đơn vừa thêm phải vào mẫu đo thời gian giao");
  assert.ok(after.stuck72h >= 1, "vận đơn chưa kết thúc và lâu không có tin phải bị nêu là kẹt");
  assert.ok(after.stuck24h >= after.stuck48h && after.stuck48h >= after.stuck72h, "ngưỡng kẹt phải lồng nhau");

  console.log(`✓ Hiệu suất giao vận: GTC ${after.successRateTerminal}% trên đơn đã kết thúc (${after.successRateAll}% trên mọi vận đơn) · lần đầu ${after.firstAttemptRate}% · lấy hàng p50 ${after.pickupHours.p50}h · giao p50 ${after.deliveryHours.p50}h · kẹt >24h ${after.stuck24h}`);
}
