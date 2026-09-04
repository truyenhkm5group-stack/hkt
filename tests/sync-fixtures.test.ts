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
import { existingLedgerReferences, insertLedgerExpenses } from "@/lib/integrations/bank/import";
import { parseLedger, planImport, referenceFor } from "@/lib/integrations/bank/ledger";
import { getReturnRateByVariant, getReturnRateSummary, listOrdersForVariant } from "@/lib/queries/return-rate";
import { listVariantsForReceipt } from "@/lib/queries/stock";
import type { Period } from "@/lib/search-params";

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


  // 8. Tỷ lệ hoàn theo mã hàng + tồn kho ERP (quy tắc: giao thành công nhưng COD 0 & cước < 10K = hoàn)
  await db.insert(schema.products).values({ id: "rr-prod", name: "Đầm kiểm thử" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: "rr-var", productId: "rr-prod", sku: "RR-001", color: "Đỏ", size: "M", retailPrice: 499000 }).onConflictDoNothing();
  const now = new Date();
  const mkOrder = async (id: string, stage: (typeof schema.orders.$inferInsert)["stage"], ship?: Partial<typeof schema.shipments.$inferInsert>) => {
    await db.insert(schema.orders).values({ id, systemId: Number(id.replace(/\D/g, "")), stage, status: 0, insertedAt: now, cod: ship?.codAmount ?? 0, partnerFee: ship?.shippingFee ?? 0 });
    await db.insert(schema.orderItems).values({ id: `${id}-i`, orderId: id, variantId: "rr-var", productId: "rr-prod", productName: "Đầm kiểm thử", sku: "RR-001", quantity: 1, unitPrice: 499000, lineTotal: 499000 });
    if (ship) await db.insert(schema.shipments).values({ orderId: id, carrier: "Viettel Post", ...ship });
  };
  await mkOrder("rr-9001", "DELIVERED", { stage: "DELIVERED", codAmount: 499000, shippingFee: 17000, vtpOrderNumber: "PKE1509000001" }); // giao thật
  await mkOrder("rr-9002", "DELIVERED", { stage: "DELIVERED", codAmount: 0, shippingFee: 8501, vtpOrderNumber: "PKE1509000002" }); // hoàn theo quy tắc COD/cước
  await mkOrder("rr-9003", "DELIVERED", { stage: "DELIVERED", codAmount: 499000, shippingFee: 17000, vtpOrderNumber: "PKE1509000003" }); // có vận đơn hoàn P1 riêng
  await db.insert(schema.shipments).values({ carrier: "Viettel Post", vtpOrderNumber: "PKE15090000031P1", trackingCode: "PKE15090000031P1", orderReference: "PKE1509000003", stage: "DELIVERED", codAmount: 0, shippingFee: 8501 });
  await mkOrder("rr-9004", "SHIPPED", { stage: "IN_TRANSIT", codAmount: 499000, shippingFee: 17000, vtpOrderNumber: "PKE1509000004" }); // đang giao
  await mkOrder("rr-9005", "RETURNED", { stage: "RETURNED", codAmount: 499000, shippingFee: 17000, vtpOrderNumber: "PKE1509000005" }); // hoàn theo trạng thái
  await mkOrder("rr-9006", "CANCELLED"); // huỷ, không tính
  const all: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };
  const rr = await getReturnRateByVariant({ period: all, q: "RR-001", minShipped: 1, sort: "rate", dir: "desc", page: 1, pageSize: 10 });
  const row = rr.rows.find((r) => r.variantId === "rr-var");
  assert.ok(row, "có dòng RR-001");
  assert.equal(row.shipped, 5, "đã gửi 5");
  assert.equal(row.delivered, 1, "giao thật 1");
  assert.equal(row.returned, 3, "hoàn 3 (1 trạng thái + 2 quy tắc)");
  assert.equal(row.returnedByRule, 2, "2 đơn hoàn theo quy tắc COD/cước");
  assert.equal(row.inTransit, 1, "đang giao 1");
  assert.equal(row.cancelled, 1, "huỷ 1");
  assert.equal(row.rate, 75, "tỷ lệ hoàn 3/(1+3) = 75%");
  const summary = await getReturnRateSummary(all, "RR-001");
  assert.equal(summary.returned, 3);
  assert.equal(summary.delivered, 1);
  const detail = await listOrdersForVariant(row.key, all);
  assert.equal(detail.find((d) => d.id === "rr-9002")?.outcome, "RETURNED_BY_RULE");
  assert.equal(detail.find((d) => d.id === "rr-9003")?.outcome, "RETURNED_BY_RULE");
  assert.equal(detail.find((d) => d.id === "rr-9001")?.outcome, "DELIVERED");
  assert.equal(detail.find((d) => d.id === "rr-9004")?.outcome, "IN_TRANSIT");
  console.log(`✓ Tỷ lệ hoàn RR-001: gửi ${row.shipped} · giao thật ${row.delivered} · hoàn ${row.returned} (quy tắc ${row.returnedByRule}) · ${row.rate}%`);

  // Tồn kho ERP = Nhập − Giao thật − Đang giao
  const [receipt] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: now, totalQuantity: 10, totalCost: 2_000_000, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId: "rr-var", quantity: 10, unitCost: 200000 });
  const picker = await listVariantsForReceipt();
  const stock = picker.find((v) => v.id === "rr-var");
  assert.ok(stock, "có mẫu mã trong danh sách nhập");
  assert.equal(stock.currentStock, 8, "tồn = 10 nhập − 1 giao thật − 1 đang giao = 8 (hoàn coi như về kho)");
  assert.equal(stock.lastCost, 200000, "giá nhập gần nhất lấy từ phiếu");
  console.log(`✓ Tồn kho ERP RR-001: ${stock.currentStock} (nhập 10, giao thật 1, đang giao 1) · giá nhập ${stock.lastCost}`);

  // Nhập sao kê MB Bank → chi phí
  const ledgerJson = JSON.stringify({
    transactions: [
      { txn_date: "2026-08-25", amount: -600000, description: "CUSTOMER MBCT W7R9K7", counterparty: "CTY TNHH PANCAKE VIET NAM", bank_ref: "FT1", category_code: "PHAN_MEM" },
      { txn_date: "2026-08-18", amount: -27600000, description: "CUSTOMER Mr T chuyen khoan nhanh qua Zalo", counterparty: "NGUYEN THI MINH HUONG", bank_ref: "FT2", category_code: "CHUA_PHAN_LOAI" },
      { txn_date: "2026-08-16", amount: -1340000, description: "CUSTOMER HO KHAC TRUYEN chuyen tien", counterparty: "TRAN ANH QUAN", bank_ref: "FT3", category_code: "CHUA_PHAN_LOAI" },
      { txn_date: "2026-08-12", amount: -250000, description: "CUSTOMER MBCT Mr T chuyen khoan nhanh qua Za lo", counterparty: "NGUYEN THI TUYET TRINH", bank_ref: "FT4", category_code: "CHUA_PHAN_LOAI" },
      { txn_date: "2026-08-10", amount: -500000, description: "CUSTOMER HO KHAC TRUYEN chuyen tien. DEN: HO KHAC TRUYEN", counterparty: "HO KHAC TRUYEN", bank_ref: "FT5", category_code: "CHUYEN_NOI_BO" },
      { txn_date: "2026-08-07", amount: 10909264, description: "Tong cong ty co phan Buu chinh Viet VTP", counterparty: "TONG CONG TY CO PHAN BUU CHINH VIETTEL", bank_ref: "FT6", category_code: "DT_BAN_HANG" },
    ],
  });
  const ledgerCsv = "\uFEFFNgày,Giờ,Tiền vào,Tiền ra,Nội dung,Đối tác,Mã GD,Số dư,Mã danh mục,Danh mục\r\n2026-08-25,10:00,,600000,\"CUSTOMER MBCT, W7R9K7\",CTY TNHH PANCAKE VIET NAM,FT1,1,PHAN_MEM,Phần mềm\r\n2026-09-01,,,2366200,THU NO THE TIN DUNG,,FT7,1,TRA_NO_GOC,Trả nợ gốc\r\n";
  const txns = parseLedger(ledgerJson);
  assert.equal(txns.length, 6);
  const employees = [{ name: "Trần Anh Quân", shortName: "Quân TA" }];
  const plan = planImport(txns, await existingLedgerReferences(txns.map(referenceFor)), employees);
  const byRef = (ref: string) => plan.find((r) => r.bankRef === ref)!;
  assert.equal(byRef("FT1").category, "SOFTWARE", "PHAN_MEM → SOFTWARE");
  assert.equal(byRef("FT2").category, "PURCHASE", "≥5 triệu chưa phân loại → nhập hàng");
  assert.equal(byRef("FT2").status, "not_operating", "nhập hàng không nhập từ sao kê (đã nằm trong giá vốn)");
  assert.equal(byRef("FT3").category, "SALARY", "trùng tên nhân sự → lương");
  assert.equal(byRef("FT3").categorySource, "employee");
  assert.equal(byRef("FT4").category, "OTHER");
  assert.equal(byRef("FT5").status, "non_pl", "chuyển nội bộ bị bỏ qua");
  assert.equal(byRef("FT6").status, "inflow", "tiền vào bị bỏ qua");
  assert.equal(byRef("FT1").description, "CTY TNHH PANCAKE VIET NAM · W7R9K7");
  const fresh = plan.filter((r) => r.status === "new");
  assert.equal(fresh.length, 3);
  const imported = await insertLedgerExpenses(fresh.map((r) => ({ reference: r.reference, date: r.date, amount: r.amount, category: r.category, description: r.description })), "test");
  assert.equal(imported.inserted, 3);
  const again = planImport(txns, await existingLedgerReferences(txns.map(referenceFor)), employees);
  assert.equal(again.filter((r) => r.status === "duplicate").length, 3, "nhập lại → toàn bộ trùng");
  const csvTxns = parseLedger(ledgerCsv);
  assert.equal(csvTxns.length, 2);
  assert.equal(csvTxns[0].amount, -600000);
  assert.equal(csvTxns[0].description, "CUSTOMER MBCT, W7R9K7", "CSV có dấu phẩy trong ngoặc kép");
  const csvPlan = planImport(csvTxns, await existingLedgerReferences(csvTxns.map(referenceFor)));
  assert.equal(csvPlan.find((r) => r.bankRef === "FT1")?.status, "duplicate", "CSV cùng mã GD → trùng với JSON đã nhập");
  assert.equal(csvPlan.find((r) => r.bankRef === "FT7")?.status, "non_pl");
  const ledgerRows = await db.select().from(schema.expenses).where(eq(schema.expenses.reference, "MB FT3"));
  assert.equal(ledgerRows[0]?.amount, 1340000);
  console.log(`✓ Nhập sao kê: ${imported.inserted} khoản chi vận hành, bỏ qua tiền vào/nội bộ/nhập hàng, chống trùng theo mã GD`);

  console.log("\nTẤT CẢ KIỂM THỬ ĐẠT");
  process.exit(0);
}

main().catch((error) => {
  console.error("✗ Kiểm thử thất bại:", error);
  process.exit(1);
});
