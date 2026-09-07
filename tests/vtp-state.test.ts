import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { applyVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";
import { deriveShipmentState, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

const track = (orderNumber: string, status: number, statusName: string, at: string) => ({
  orderNumber, orderReference: "", status, statusName,
  statusDate: new Date(at), location: "", note: "", reasonCode: null,
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

  // ───────── 5. Dựng lại nhiều lần cho cùng kết quả (idempotent) ─────────
  const again = await materializeShipmentState(db, fileSide.id);
  assert.equal(again.changed, false, "dựng lại trên cùng tập sự kiện không được báo thay đổi");
  const derived = await deriveShipmentState(db, afterLate[0].id);
  assert.ok(derived);
  assert.equal(derived.stage, "DELIVERED");
  assert.equal(derived.decidedBy.source, "VTP_WEBHOOK", "phải giải thích được sự kiện nào quyết định trạng thái");
  assert.equal(derived.deliveredAt?.toISOString(), "2026-09-05T10:00:00.000Z", "mốc giao lấy lần ĐẦU đạt tới, theo giờ của ĐVVC");

  console.log("✓ Trạng thái vận đơn dựng từ lịch sử: một bộ dịch chung, sự kiện muộn không kéo lùi, gói tin lặp vô hại, trạng thái lạ không ghi đè");
}
