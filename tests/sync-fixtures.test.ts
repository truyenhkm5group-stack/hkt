/**
 * Kiểm thử luồng đồng bộ với dữ liệu mẫu (không gọi API thật).
 * Chạy: npm test  (dùng CSDL PGlite tạm trong ./data/pglite-test, không ảnh hưởng dữ liệu thật)
 */
import "./setup-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { parseJsonSafeInts } from "@/lib/integrations/http";
import { mapOrder, mapProduct } from "@/lib/integrations/pancake/mapper";
import { upsertOrder, upsertProduct } from "@/lib/integrations/pancake/sync";
import { detectKind, parseWebhookBody } from "@/lib/integrations/pancake/webhook";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

async function main() {
  await ensureMigrated();
  const db = await getDb();

  // 1. Sản phẩm
  const productsFixture = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures-pancake-products.json"), "utf8"));
  for (const raw of productsFixture.data) {
    const mapped = mapProduct(raw);
    assert.ok(mapped, "map product");
    await upsertProduct(mapped);
  }
  const variants = await db.query.productVariants.findMany({ with: { stocks: true } });
  assert.ok(variants.length >= 1, "có mẫu mã");
  assert.ok(variants[0].stocks.length >= 1, "có tồn kho theo kho");
  console.log(`✓ Sản phẩm: ${variants.length} mẫu mã, tồn kho theo kho OK`);

  // 2. Đơn hàng (từ fixture API thật, anonymised)
  const orderFixture = parseJsonSafeInts(readFileSync(path.join(process.cwd(), "tests/fixtures-pancake-order.json"), "utf8")) as { data: Record<string, unknown> };
  const rawOrder = { ...orderFixture.data, id: 480, system_id: 480 };
  const mapped = mapOrder(rawOrder);
  assert.ok(mapped, "map order");
  assert.equal(mapped.id, "480");
  assert.equal(mapped.status, 0);
  assert.equal(mapped.stage, "NEW");
  assert.equal(mapped.items.length, 2);
  assert.equal(mapped.totalPrice, 3725000);
  assert.equal(mapped.cod, 3905000);
  assert.ok(mapped.customer, "có khách hàng");
  const r1 = await upsertOrder(mapped, { force: true });
  assert.equal(r1, "created");
  const r2 = await upsertOrder(mapped, { force: false });
  assert.equal(r2, "skipped", "không ghi đè khi không mới hơn");
  const stored = await db.query.orders.findFirst({ where: eq(schema.orders.id, "480"), with: { items: true, customer: true, shipment: true } });
  assert.ok(stored);
  assert.equal(stored.items.length, 2);
  assert.ok(stored.customer?.phone === "0900000000");
  assert.equal(stored.shipment, null, "đơn mới chưa có vận đơn");
  console.log(`✓ Đơn hàng #${stored.systemId}: ${stored.items.length} sản phẩm, khách ${stored.customer?.name}, giá vốn ${stored.cogs}`);

  // 3. Đơn chuyển sang đã gửi hàng với Viettel Post
  const shipped = mapOrder({
    ...rawOrder,
    status: 2,
    updated_at: "2026-05-08T02:00:00",
    partner: {
      partner_id: 3,
      partner_name: "Viettel Post",
      extend_code: "1234567890123",
      order_number_vtp: "1234567890123",
      partner_status: "picked_up",
      total_fee: 32000,
      cod: 0,
      picked_up_at: "2026-05-08T01:30:00",
      updated_at: "2026-05-08T02:00:00",
      extend_update: [{ status: "picked_up", note: "Đã lấy hàng", update_at: "2026-05-08T01:30:00" }],
    },
  });
  assert.ok(shipped?.shipment);
  assert.equal(shipped.shipment.carrier, "Viettel Post");
  assert.equal(shipped.shipment.vtpOrderNumber, "1234567890123");
  assert.equal(shipped.shipment.stage, "PICKED_UP");
  const r3 = await upsertOrder(shipped, { force: false });
  assert.equal(r3, "updated");
  const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "480"), with: { events: true } });
  assert.ok(shipment);
  assert.equal(shipment.stage, "PICKED_UP");
  assert.equal(shipment.codAmount, 3905000);
  assert.equal(shipment.codStatus, "PENDING");
  assert.ok(shipment.events.length >= 1);
  console.log(`✓ Vận đơn ${shipment.vtpOrderNumber}: ${shipment.stage}, COD ${shipment.codAmount}`);

  // 4. Webhook Viettel Post: phát thành công
  const webhookBody = {
    DATA: {
      ORDER_NUMBER: "1234567890123",
      ORDER_REFERENCE: "480",
      ORDER_STATUSDATE: "09/05/2026 15:20:00",
      ORDER_STATUS: 501,
      STATUS_NAME: "Phát thành công",
      LOCALION_CURRENTLY: "Bưu cục Cầu Giấy",
      NOTE: "Giao thành công",
      MONEY_COLLECTION: 3905000,
      MONEY_TOTAL: 33000,
      MONEY_FEECOD: 0,
      PRODUCT_WEIGHT: 500,
      ORDER_SERVICE: "VCN",
    },
    TOKEN: "secret",
  };
  const record = normalizeTracking(webhookBody.DATA);
  assert.equal(record.status, 501);
  assert.ok(record.statusDate);
  const applied = await applyVtpTracking(record, "VTP_WEBHOOK", { allowCreate: true });
  assert.ok(applied?.changed);
  const delivered = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "480"), with: { events: true } });
  assert.equal(delivered?.stage, "DELIVERED");
  assert.equal(delivered?.codStatus, "COLLECTED");
  assert.equal(delivered?.isFinal, true);
  assert.equal(delivered?.vtpStatus, 501);
  assert.ok(delivered?.deliveredAt);
  console.log(`✓ Webhook VTP 501 → ${delivered?.stage}, COD ${delivered?.codStatus}, ${delivered?.events.length} sự kiện`);

  // 5. Webhook Pancake về muộn (updated_at cũ hơn) không ghi đè trạng thái VTP
  const late = mapOrder({ ...rawOrder, status: 2, updated_at: "2026-05-08T02:00:00", partner: { partner_name: "Viettel Post", order_number_vtp: "1234567890123", partner_status: "picked_up", updated_at: "2026-05-08T02:00:00" } });
  const r4 = await upsertOrder(late!, { force: true });
  assert.equal(r4, "updated");
  const after = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "480") });
  assert.equal(after?.stage, "DELIVERED", "giữ trạng thái VTP mới hơn");
  assert.equal(after?.codStatus, "COLLECTED");
  console.log("✓ Dữ liệu Pancake cũ hơn không ghi đè trạng thái Viettel Post");

  // 6. Webhook Pancake: nhận diện loại
  const body = parseWebhookBody(JSON.stringify({ type: "orders", ...rawOrder }));
  assert.equal(detectKind(body, ""), "orders");
  assert.equal(detectKind({ variation_id: "x", warehouse_id: "y", remain_quantity: 3 }, ""), "variations_warehouses");
  assert.equal(detectKind({}, "hooks/customers"), "customers");
  console.log("✓ Nhận diện webhook Pancake OK");

  // 7. Vận đơn VTP không có trong Pancake (tạo đơn lẻ)
  const orphan = normalizeTracking({ ORDER_NUMBER: "9999999999999", ORDER_STATUS: 200, STATUS_NAME: "Lấy hàng thành công", ORDER_STATUSDATE: "09/05/2026 09:00:00", MONEY_COLLECTION: 250000, RECEIVER_FULLNAME: "Khách lẻ" });
  const created = await applyVtpTracking(orphan, "VTP_IMPORT", { allowCreate: true });
  assert.ok(created?.created);
  console.log("✓ Vận đơn Viettel Post ngoài Pancake được tạo riêng");

  console.log("\nTẤT CẢ KIỂM THỬ ĐẠT");
  process.exit(0);
}

main().catch((error) => {
  console.error("✗ Kiểm thử thất bại:", error);
  process.exit(1);
});
