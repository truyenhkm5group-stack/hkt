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
import { evaluateAlerts } from "@/lib/alerts/rules";
import { detectFromMessages } from "@/lib/cs/chat-detect";
import { stripIgnored } from "@/lib/cs/detect";
import { detectCsCases } from "@/lib/cs/detect";
import { DEFAULT_CS_RULES } from "@/lib/constants/cs";
import { DEFAULT_NURTURE_STEPS, isDue, normalizeOutreachConfig, renderTemplate, shortName } from "@/lib/constants/outreach";
import { effectiveThreshold, isBillingBlocked, learnThreshold } from "@/lib/integrations/facebook/billing";
import { fbMinorOffset } from "@/lib/integrations/facebook/client";
import { assessCustomerRisk } from "@/lib/alerts/risk";
import { computePlan } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { clearMemo } from "@/lib/cache";
import { existingLedgerReferences, insertLedgerExpenses } from "@/lib/integrations/bank/import";
import { mapVtpStatusText, parseStatementDetail, parseStatementSummaryText, parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { applyStatementDetail, applyVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";
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

  // Bảng kê tiền COD Viettel Post
  const summaries = parseStatementSummaryText("PCOD-A-GLMTQY04-2609-55\t04/09/2026 01:00:29\t24.059.000 ₫\t563.757 ₫\t23.495.243 ₫\nPCOD-A-GLMTQY03-2609-44 03/09/2026 08:47:32 58.136.001 ₫ 6.806.381 ₫ 51.329.620 ₫\ndòng rác\n");
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[0], { reference: "PCOD-A-GLMTQY04-2609-55", receivedAt: "2026-09-04", codGross: 24059000, feeTotal: 563757, netAmount: 23495243 });
  const detailCsv = "Bảng kê PCOD-A-TEST\nSTT,Mã vận đơn,Người nhận,Tiền COD,Tổng cước,Thực nhận\n1,PKE-RR-9001,Khách A,\"500.000\",\"15.000\",\"485.000\"\n2,PKEKHONGCO,Khách B,\"200.000\",\"10.000\",\"190.000\"\n";
  const stmtRows = parseStatementDetail(detailCsv, "bang-ke.csv");
  assert.equal(stmtRows.length, 2);
  assert.equal(stmtRows[0].trackingCode, "PKE-RR-9001");
  assert.equal(stmtRows[0].cod, 500000);
  assert.equal(stmtRows[0].fee, 15000);
  const rrShipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "rr-9001") });
  assert.ok(rrShipment, "có vận đơn RR-9001");
  await db.update(schema.shipments).set({ trackingCode: "PKE-RR-9001" }).where(eq(schema.shipments.id, rrShipment.id));
  const stmtApplied = await applyStatementDetail({ reference: "PCOD-A-TEST", receivedAt: "2026-09-04", codGross: 0, feeTotal: 0, netAmount: 0 }, stmtRows, "test");
  assert.equal(stmtApplied.matched, 1);
  assert.equal(stmtApplied.unmatched, 1);
  const paidShipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, rrShipment.id) });
  assert.equal(paidShipment?.codStatus, "PAID_TO_BANK");
  assert.equal(paidShipment?.codCollected, 500000);
  assert.equal(paidShipment?.shippingFee, 15000);
  const batch = await db.query.codBatches.findFirst({ where: eq(schema.codBatches.reference, "PCOD-A-TEST") });
  assert.equal(batch?.codGross, 700000, "tổng COD trên bảng kê (kể cả dòng không ghép được)");
  assert.equal(batch?.totalAmount, 675000, "tiền thu về = COD − cước");
  console.log(`✓ Bảng kê Viettel Post: ${summaries.length} dòng tổng hợp, chi tiết ghép ${stmtApplied.matched}/${stmtRows.length} vận đơn, đợt ${batch?.reference} thu về ${batch?.totalAmount}`);

  // Cảnh báo vận hành: giao thất bại → thông báo; giao thành công → tự đóng
  const failedShipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "rr-9004") });
  assert.ok(failedShipment, "có vận đơn đang giao RR-9004");
  await db.update(schema.shipments).set({ stage: "DELIVERY_FAILED", vtpStatusName: "Phát thất bại - khách nghỉ, không có nhà", isFinal: false }).where(eq(schema.shipments.id, failedShipment.id));
  const run1 = await evaluateAlerts();
  assert.ok(run1.created >= 1, "tạo thông báo giao thất bại");
  const openFailed = await db.query.notifications.findFirst({ where: eq(schema.notifications.entityId, failedShipment.id) });
  assert.equal(openFailed?.kind, "SHIPMENT_FAILED");
  assert.equal(openFailed?.resolvedAt, null);
  const run1b = await evaluateAlerts();
  assert.equal(run1b.created, 0, "chạy lại không tạo trùng");
  await db.update(schema.shipments).set({ stage: "DELIVERED", isFinal: true }).where(eq(schema.shipments.id, failedShipment.id));
  await evaluateAlerts();
  const closed = await db.query.notifications.findFirst({ where: eq(schema.notifications.id, openFailed!.id) });
  assert.ok(closed?.resolvedAt, "tự đóng khi đã giao");
  console.log(`✓ Cảnh báo: giao thất bại → thông báo (${run1.created} mới), giao xong → tự đóng`);

  // Case CSKH tự phát hiện từ thẻ / ghi chú đơn Pancake
  await db.update(schema.orders).set({ tags: ["Trả hàng"], note: "khách nhận sai size, đổi size L cho khách" }).where(eq(schema.orders.id, "rr-9001"));
  const cs1 = await detectCsCases();
  assert.ok(cs1.created >= 2, "tạo case trả hàng + đổi size");
  const cases = await db.select().from(schema.csCases).where(eq(schema.csCases.orderId, "rr-9001"));
  assert.ok(cases.some((c) => c.kind === "RETURN" && c.source === "PANCAKE_TAG"), "case trả hàng từ thẻ");
  assert.ok(cases.some((c) => c.kind === "EXCHANGE_SIZE" && c.source === "PANCAKE_NOTE"), "case đổi size từ ghi chú");
  const cs2 = await detectCsCases();
  assert.equal(cs2.created, 0, "quét lại không tạo trùng");
  const alertsWithCs = await evaluateAlerts();
  const csNoti = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "CS_CASE"));
  assert.ok(csNoti.length >= 2, "case CSKH lên chuông cảnh báo");
  console.log(`✓ CSKH: ${cs1.created} case tự phát hiện, ${csNoti.length} thông báo (quét ${alertsWithCs.created} mới)`);

  // Danh sách vận đơn Viettel Post (Quản lý vận đơn) → trạng thái & COD
  assert.equal(mapVtpStatusText("Đã trả").cod, "PAID_TO_BANK");
  assert.equal(mapVtpStatusText("Chờ phát lại").stage, "DELIVERY_FAILED");
  assert.equal(mapVtpStatusText("Đang chuyển hoàn").stage, "RETURNING");
  const listCsv = "STT,Mã vận đơn,Người nhận,Trạng thái,Tiền thu hộ,Cước,Ngày cập nhật\n1,PKE-RR-9001,A,Đã trả,\"500.000\",\"15.000\",03/09/2026\n2,PKE-RR-9002,B,Chờ phát lại,\"300.000\",\"12.000\",04/09/2026\n";
  const listRows = parseVtpOrderList(listCsv);
  assert.equal(listRows.length, 2);
  assert.equal(listRows[1].statusDate, "2026-09-04");
  const rr2 = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "rr-9002") });
  await db.update(schema.shipments).set({ trackingCode: "PKE-RR-9002" }).where(eq(schema.shipments.id, rr2!.id));
  const applied2 = await applyVtpOrderList(listRows);
  assert.equal(applied2.matched, 2);
  const rr2After = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, rr2!.id) });
  assert.equal(rr2After?.stage, "DELIVERY_FAILED");
  assert.equal(rr2After?.vtpStatusName, "Chờ phát lại");
  const rr1After = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, "rr-9001") });
  assert.equal(rr1After?.codStatus, "PAID_TO_BANK", "đã trả giữ nguyên đã về ngân hàng");
  console.log(`✓ Danh sách vận đơn VTP: ${applied2.updated} vận đơn cập nhật, ${applied2.paid} COD về NH`);

  // Phát hiện case từ tin nhắn chat khách
  const chatHits = detectFromMessages(
    [
      { text: "Shop ơi bao giờ nhận được hàng vậy, đặt lâu quá rồi", fromPage: false },
      { text: "Dạ chị chờ em kiểm tra ạ", fromPage: true },
      { text: "em ơi chị bảo lấy hai chiếc đều size L mà sao lại có XL?!", fromPage: false },
      { text: "sao lại thu 800k, chốt với em 700k mà", fromPage: false },
    ],
    DEFAULT_CS_RULES.chatRules,
  );
  const kinds = chatHits.map((h) => h.kind);
  assert.ok(kinds.includes("URGE_DELIVERY"), "giục giao hàng");
  assert.ok(kinds.includes("SIZE_ADVICE"), "tư vấn size chưa đúng");
  assert.ok(kinds.includes("WRONG_PRICE"), "chốt sai giá");
  assert.ok(!chatHits.some((h) => h.message.includes("chị chờ em")), "bỏ qua tin nhắn của page");
  console.log(`✓ Chat Pancake: nhận diện ${kinds.join(", ")}`);
  // Câu hỏi trước mua / hỏi chính sách không phải case; sau khi có đơn mới tính
  const t0 = new Date("2026-09-01T00:00:00Z");
  const preSale = detectFromMessages(
    [
      { text: "<div>Có được kiểm tra hàng không</div>", fromPage: false, insertedAt: new Date("2026-09-02T00:00:00Z") },
      { text: "<div>Đầm có màu khác không?</div>", fromPage: false, insertedAt: new Date("2026-09-02T00:00:00Z") },
      { text: "Kiểm tra hàng chất vải ko đẹp ko nhận hàng", fromPage: false, insertedAt: new Date("2026-09-02T00:00:00Z") },
      { text: "ship bao lâu thì nhận được ạ", fromPage: false, insertedAt: new Date("2026-09-02T00:00:00Z") },
      { text: "lâu quá", fromPage: false, insertedAt: new Date("2026-08-20T00:00:00Z") },
    ],
    DEFAULT_CS_RULES.chatRules,
    [],
    { requireOrder: true, orderInsertedAt: t0, orderStage: "SHIPPED" },
  );
  assert.deepEqual(preSale, [], `câu hỏi trước mua không tạo case: ${JSON.stringify(preSale.map((h) => h.kind))}`);
  const noOrder = detectFromMessages([{ text: "sao mãi chưa nhận được hàng, lâu quá", fromPage: false, insertedAt: new Date() }], DEFAULT_CS_RULES.chatRules, [], { requireOrder: true, orderInsertedAt: null });
  assert.deepEqual(noOrder, [], "khách chưa có đơn → không tạo case giục giao");
  const real = detectFromMessages(
    [
      { text: "<div>cho em trả hàng nhé, mặc không vừa</div>", fromPage: false, insertedAt: new Date("2026-09-03T00:00:00Z") },
      { text: "chị muốn đổi màu đen sang màu đỏ", fromPage: false, insertedAt: new Date("2026-09-03T00:00:00Z") },
      { text: "sao mãi chưa nhận được hàng vậy em", fromPage: false, insertedAt: new Date("2026-09-03T00:00:00Z") },
    ],
    DEFAULT_CS_RULES.chatRules,
    [],
    { requireOrder: true, orderInsertedAt: t0, orderStage: "SHIPPED" },
  );
  const realKinds = real.map((h) => h.kind).sort();
  assert.ok(realKinds.includes("RETURN") && realKinds.includes("EXCHANGE_COLOR") && realKinds.includes("URGE_DELIVERY"), `case thật sau mua: ${realKinds.join(",")}`);
  assert.ok(!real.some((h) => h.message.includes("<div>")), "bỏ thẻ HTML trong nội dung");
  const afterDelivered = detectFromMessages([{ text: "sao mãi chưa nhận được hàng", fromPage: false, insertedAt: new Date("2026-09-03T00:00:00Z") }], DEFAULT_CS_RULES.chatRules, [], { requireOrder: true, orderInsertedAt: t0, orderStage: "DELIVERED" });
  assert.deepEqual(afterDelivered, [], "đơn đã giao xong → không còn là giục giao");
  console.log("✓ Chat Pancake: bỏ câu hỏi trước mua / chính sách, chỉ tạo case sau khi có đơn");

  // Kế hoạch đặt hàng sản xuất
  const plan1 = computePlan({ stock: 10, committed: 4, soldInWindow: 28, windowDays: 14, leadTimeDays: 7, coverDays: 14, safetyDays: 3, roundTo: 10 });
  assert.equal(plan1.available, 6);
  assert.equal(plan1.velocity, 2);
  assert.equal(plan1.leadTimeDemand, 14);
  assert.equal(plan1.safetyStock, 6);
  assert.equal(plan1.target, 48, "2/ngày × 21 ngày + 6 an toàn");
  assert.equal(plan1.suggested, 50, "48 − 6 = 42 → làm tròn bội 10");
  assert.equal(plan1.status, "CRITICAL", "còn 3 ngày < SX 7 ngày");
  const plan2 = computePlan({ stock: 100, committed: 0, soldInWindow: 14, windowDays: 14, leadTimeDays: 7, coverDays: 14, safetyDays: 3, roundTo: 1 });
  assert.equal(plan2.status, "OK");
  assert.equal(plan2.suggested, 0);
  const plan3 = computePlan({ stock: 0, committed: 2, soldInWindow: 5, windowDays: 14, leadTimeDays: 7, coverDays: 14, safetyDays: 3, roundTo: 1 });
  assert.equal(plan3.status, "OUT");
  assert.equal(plan3.shortage, 2);
  clearMemo();
  const report = await getReplenishmentPlan();
  const rrPlan = report.rows.find((r) => r.variantId === "rr-var");
  assert.ok(rrPlan, "có mẫu mã RR trong kế hoạch");
  const picker2 = await listVariantsForReceipt();
  assert.equal(rrPlan.stock, picker2.find((v) => v.id === "rr-var")?.currentStock, "tồn ERP trong kế hoạch khớp bảng tồn kho (cùng công thức)");
  console.log(`✓ Kế hoạch đặt hàng: đề xuất ${plan1.suggested} (tình trạng ${plan1.status}), RR-var tồn ${rrPlan.stock} · bán 30 ngày ${rrPlan.sold30}`);

  assert.equal(stripIgnored("[🤖 BOT ĐÃ TỰ ĐỘNG SỬA LẠI ĐỊA CHỈ SAI SANG HÀ NỘI]", DEFAULT_CS_RULES.ignorePatterns), "", "ghi chú bot bị bỏ qua");
  assert.equal(stripIgnored("khách báo sai địa chỉ [🤖 BOT ĐÃ TỰ ĐỘNG SỬA LẠI ĐỊA CHỈ SAI SANG HÀ NỘI]", DEFAULT_CS_RULES.ignorePatterns), "khách báo sai địa chỉ");
  console.log("✓ Bỏ qua ghi chú tự động của bot Pancake");

  // Mẫu tin chăm sóc khách & bán chéo
  assert.equal(shortName("Nguyễn Thị Lan"), "chị Lan");
  assert.equal(shortName("Khách hàng 123"), "chị");
  assert.equal(shortName(""), "chị");
  const tpl = "Chào {ten}, cảm ơn đã mua {san_pham} tại {shop}. Gợi ý: {goi_y}.{uu_dai}";
  assert.equal(renderTemplate(tpl, { ten: "chị Lan", san_pham: "Đầm Q003", goi_y: "Q004", shop: "Hải An", discountCode: "" }), "Chào chị Lan, cảm ơn đã mua Đầm Q003 tại Hải An. Gợi ý: Q004.");
  assert.ok(renderTemplate(tpl, { ten: "", san_pham: "", goi_y: "", shop: "", discountCode: "CAMON10" }).includes("mã CAMON10"));
  assert.ok(renderTemplate(tpl, { ten: "", san_pham: "", goi_y: "", shop: "", discountCode: "" }).startsWith("Chào chị,"));
  assert.ok(renderTemplate(DEFAULT_NURTURE_STEPS[0], { ten: "chị Lan", san_pham: "", goi_y: "", shop: "Hải An", discountCode: "", giam: "50k/váy" }).includes("giảm ngay 50k/váy"));
  const legacy = normalizeOutreachConfig({ nurtureDays: 2, nurtureTemplate: "Chào {ten}, shop hỗ trợ tư vấn thêm ạ" });
  assert.equal(legacy.nurtureWindowHours, 48, "cấu hình cũ nurtureDays → giờ");
  assert.equal(legacy.nurtureSteps.length, DEFAULT_NURTURE_STEPS.length, "mẫu cũ thành bước 1, các bước sau dùng kịch bản mẫu");
  assert.equal(normalizeOutreachConfig(null).nurtureWindowHours, 168);
  assert.equal(isDue({ status: "PENDING", nextAt: null }), true);
  assert.equal(isDue({ status: "PENDING", nextAt: new Date(Date.now() + 3_600_000) }), false, "chưa đến hạn bước tiếp theo");
  assert.equal(isDue({ status: "SENT", nextAt: null }), false);
  console.log("✓ Mẫu tin chăm sóc khách & kịch bản băn khoăn nhiều bước");

  // Ngưỡng thanh toán tài khoản quảng cáo
  assert.equal(fbMinorOffset("VND"), 1);
  assert.equal(fbMinorOffset("USD"), 100);
  assert.deepEqual(learnThreshold({ balance: 1_353_666, learnedThreshold: null }, 120_000), { learnedThreshold: 1_353_666, paid: true }, "dư nợ giảm mạnh → học ngưỡng = dư nợ trước khi thu");
  assert.deepEqual(learnThreshold({ balance: 900_000, learnedThreshold: 1_353_666 }, 1_100_000), { learnedThreshold: 1_353_666, paid: false }, "dư nợ tăng → giữ ngưỡng cũ");
  assert.deepEqual(learnThreshold({ balance: 50_000, learnedThreshold: null }, 0), { learnedThreshold: null, paid: false }, "số nhỏ không học");
  assert.equal(effectiveThreshold({ threshold: 2_000_000, learnedThreshold: 1_353_666 }), 2_000_000, "ngưỡng nhập tay ưu tiên");
  assert.equal(effectiveThreshold({ threshold: null, learnedThreshold: 1_353_666 }), 1_353_666);
  assert.equal(isBillingBlocked({ accountStatus: 2, disableReason: 0 }), true);
  assert.equal(isBillingBlocked({ accountStatus: 1, disableReason: 0 }), false);
  console.log("✓ Ngưỡng thanh toán tài khoản quảng cáo: offset tiền tệ, học ngưỡng, trạng thái khoá");

  // Đơn rủi ro: khách hoàn nhiều → xin cọc
  const riskCfg = { riskMinReturned: 2, riskReturnRatePct: 40 };
  const riskHigh = assessCustomerRisk({ succeed: 6, returned: 44, isBlock: false }, riskCfg);
  assert.ok(riskHigh.risky && riskHigh.severity === "critical" && Math.round(riskHigh.rate * 100) === 88, "GTC 6 / hoàn 44 → rủi ro nghiêm trọng");
  assert.equal(assessCustomerRisk({ succeed: 20, returned: 1, isBlock: false }, riskCfg).risky, false, "khách tốt không cảnh báo");
  assert.ok(assessCustomerRisk({ succeed: 0, returned: 0, isBlock: true }, riskCfg).risky, "bị chặn trên Pancake → rủi ro");
  assert.ok(assessCustomerRisk({ succeed: 0, returned: 0, isBlock: false, erpDelivered: 1, erpReturned: 3 }, riskCfg).risky, "lịch sử ERP cùng SĐT hoàn 3/4 → rủi ro");
  console.log("✓ Đơn rủi ro: chấm điểm khách theo GTC / hoàn / chặn");

  console.log("\nTẤT CẢ KIỂM THỬ ĐẠT");
  process.exit(0);

}

main().catch((error) => {
  console.error("✗ Kiểm thử thất bại:", error);
  process.exit(1);
});
