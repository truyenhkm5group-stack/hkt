import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { deriveShipmentState } from "@/lib/integrations/viettelpost/state";
import { viettelPostHealth } from "@/lib/queries/integrations";

/**
 * CỨNG HOÁ LUỒNG NẠP DỮ LIỆU VIETTEL POST.
 *
 * Bốn thứ phải đúng dù ĐVVC gửi kiểu gì: gói tin lặp, gói tin đến muộn, bước hành trình của
 * CHIỀU HOÀN, và trạng thái ERP chưa hiểu.
 */

/** Gói tin webhook thật của Viettel Post (đúng tên trường trong tài liệu). */
function payload(orderNumber: string, status: number, statusName: string, at: string, extra: Record<string, unknown> = {}) {
  return { ORDER_NUMBER: orderNumber, ORDER_STATUS: status, STATUS_NAME: statusName, ORDER_STATUSDATE: at, ...extra };
}

export async function testVtpIngestion(db: Db) {
  // ───────── 1. Bước hành trình của CHIỀU HOÀN không được thành "giao thành công" ─────────
  //
  // Ca thật: vận đơn chiều hoàn (mã gốc + 1P1) mang mã 501 "Phát thành công" — nghĩa là hàng đã
  // về tới shop, KHÔNG phải tới tay khách. Trước đây bước hành trình được ghi không kèm cờ chiều
  // nên ERP kết luận vận đơn hoàn là giao thành công (F3, docs/erp-data-truth-audit.md).
  const leg = "PKE-ING-RET1P1";
  const returnRecord = normalizeTracking(
    payload(leg, 501, "Thành công - Phát thành công", "05/09/2026 09:26:34", {
      IS_RETURNING: true,
      ORDER_REFERENCE: "PKE-ING-RET",
      LIST_TRACK: [
        { ORDER_STATUS: 300, STATUS_NAME: "Đóng tải - vận chuyển đi", ORDER_STATUSDATE: "04/09/2026 08:00:00" },
        { ORDER_STATUS: 501, STATUS_NAME: "Thành công - Phát thành công", ORDER_STATUSDATE: "05/09/2026 09:26:34" },
      ],
    }),
  );
  assert.equal(returnRecord.isReturning, true, "cờ IS_RETURNING phải đọc được từ gói tin");
  assert.equal(returnRecord.journey.length, 2, "hành trình phải đọc được đủ các bước");
  const applied = await applyVtpTracking(returnRecord, "VTP_WEBHOOK", { allowCreate: true });
  assert.ok(applied, "phải tạo được vận đơn chiều hoàn");
  const events = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, applied.shipmentId));
  const final501 = events.filter((e) => e.status === "501");
  assert.ok(final501.length > 0, "phải có sự kiện mã 501");
  for (const e of final501) assert.equal(e.legType, "RETURN", "MÃ CUỐI của chiều hoàn phải mang cờ RETURN, kể cả khi nằm trong hành trình");
  const midway = events.find((e) => e.status === "300");
  assert.equal(midway?.legType, null, "bước TRUNG GIAN không được gán cờ chiều — không có căn cứ thì không đoán");
  const derived = await deriveShipmentState(db, applied.shipmentId);
  assert.equal(derived?.stage, "RETURNED", "vận đơn chiều hoàn phát thành công nghĩa là HÀNG ĐÃ VỀ SHOP, không phải giao cho khách");
  assert.notEqual(derived?.stage, "DELIVERED");

  // Chiều đi thì ngược lại: cùng mã 501, cờ OUTBOUND, phải là giao thành công.
  const out = "PKE-ING-OUT";
  const outRecord = normalizeTracking(
    payload(out, 501, "Thành công - Phát thành công", "05/09/2026 09:26:34", {
      IS_RETURNING: false,
      LIST_TRACK: [{ ORDER_STATUS: 501, STATUS_NAME: "Thành công - Phát thành công", ORDER_STATUSDATE: "05/09/2026 09:26:34" }],
    }),
  );
  const outApplied = await applyVtpTracking(outRecord, "VTP_WEBHOOK", { allowCreate: true });
  assert.equal((await deriveShipmentState(db, outApplied!.shipmentId))?.stage, "DELIVERED", "501 chiều đi vẫn là giao thành công");

  // Không có cờ nào cả thì KHÔNG đoán — bước hành trình để trống chiều.
  const blind = "PKE-ING-BLIND";
  const blindRecord = normalizeTracking(
    payload(blind, 300, "Đóng tải - vận chuyển đi", "04/09/2026 08:00:00", {
      LIST_TRACK: [{ ORDER_STATUS: 501, STATUS_NAME: "Thành công - Phát thành công", ORDER_STATUSDATE: "05/09/2026 09:00:00" }],
    }),
  );
  const blindApplied = await applyVtpTracking(blindRecord, "VTP_WEBHOOK", { allowCreate: true });
  const blindEvents = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, blindApplied!.shipmentId));
  assert.equal(blindEvents.find((e) => e.status === "501")?.legType, null, "ĐVVC không gửi cờ thì để trống, không được suy ra OUTBOUND");

  // ───────── 2. Chỉ MỘT hàm được ghi trạng thái vận đơn ─────────
  // Đọc thẳng mã nguồn: `applyVtpTracking` không được tự ghi stage nữa, nếu không thì hai chỗ
  // cùng ghi và luồng chạy sau sẽ thắng kể cả khi mang sự kiện cũ hơn.
  const syncSrc = await import("node:fs").then((fs) => fs.readFileSync("lib/integrations/viettelpost/sync.ts", "utf8"));
  const updateBlock = syncSrc.slice(syncSrc.indexOf(".update(schema.shipments)"));
  assert.ok(!/^\s{6}stage[,:]/m.test(updateBlock.slice(0, 3000)), "applyVtpTracking KHÔNG được tự ghi shipments.stage — chỉ materializeShipmentState() mới được");

  // ───────── 3. Chống trùng ở tầng gói tin: gửi lại không đẻ dòng mới ─────────
  assert.equal(webhookDedupeKey("VIETTELPOST", ["ABC", 501, "2026-09-05"]), "VIETTELPOST|ABC|501|2026-09-05");
  assert.equal(webhookDedupeKey("VIETTELPOST", ["ABC", null, null]), null, "thiếu thông tin nhận dạng thì KHÔNG chống trùng, vẫn lưu bình thường");
  const key = webhookDedupeKey("VIETTELPOST", ["PKE-ING-DUP", 501, "2026-09-05T09:26:34.000Z"]);
  const at = new Date("2026-09-05T09:26:34.000Z");
  const first = await storeWebhook("VIETTELPOST", "tracking", "PKE-ING-DUP", { DATA: {} }, {}, { dedupeKey: key, occurredAt: at });
  const again = await storeWebhook("VIETTELPOST", "tracking", "PKE-ING-DUP", { DATA: {} }, {}, { dedupeKey: key, occurredAt: at });
  const third = await storeWebhook("VIETTELPOST", "tracking", "PKE-ING-DUP", { DATA: {} }, {}, { dedupeKey: key, occurredAt: at });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true, "lần gửi lại phải nhận ra là gói tin cũ");
  assert.equal(again.id, first.id, "lần gửi lại phải rơi vào ĐÚNG dòng cũ, không tạo dòng mới");
  assert.equal(third.deliveryCount, 3, "phải đếm được ĐVVC đã gửi lại bao nhiêu lần");
  const stored = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.dedupeKey, key!));
  assert.equal(stored.length, 1, "ba lần gửi cùng một sự việc chỉ được để lại một dòng");
  assert.equal(stored[0].occurredAt?.getTime(), at.getTime(), "mốc SỰ KIỆN phải khác mốc NHẬN GÓI TIN");
  assert.ok(stored[0].receivedAt.getTime() >= at.getTime());
  // Gói tin không có khoá vẫn phải lưu được (không nhận dạng được ≠ được phép mất dữ liệu).
  const anon1 = await storeWebhook("VIETTELPOST", "tracking", null, { DATA: {} }, {}, {});
  const anon2 = await storeWebhook("VIETTELPOST", "tracking", null, { DATA: {} }, {}, {});
  assert.notEqual(anon1.id, anon2.id, "gói tin không nhận dạng được vẫn được lưu đủ, không bị gộp nhầm");

  // ───────── 4. Trạng thái ERP chưa hiểu phải NHÌN THẤY ĐƯỢC ─────────
  const oddCode = "PKE-ING-ODD";
  await applyVtpTracking(normalizeTracking(payload(oddCode, 7777, "Trạng thái Viettel Post mới", "06/09/2026 08:00:00")), "VTP_WEBHOOK", { allowCreate: true });
  const health = await viettelPostHealth();
  assert.ok(
    health.unknownStatuses.some((u) => u.status === "7777"),
    "mã ĐVVC chưa có trong bảng phải hiện ra trên trang Kết nối dữ liệu để còn bổ sung, không được nuốt im lặng",
  );
  assert.ok(health.webhooks.redelivered >= 2, "số lần ĐVVC gửi lại phải đo được");

  console.log(
    `✓ Nạp dữ liệu VTP: mã cuối chiều hoàn mang cờ RETURN · bước trung gian không đoán chiều · một hàm duy nhất ghi trạng thái · gửi lại ${third.deliveryCount} lần chỉ 1 dòng · ${health.unknownStatuses.length} mã lạ hiện ra`,
  );
}
