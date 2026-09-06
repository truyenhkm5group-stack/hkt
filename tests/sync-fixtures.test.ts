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
import { classifyFailedReason, failedMode, isReturningNote, isShopAddressIssue, parseAppointment, parsePostman, renderFailedTemplate } from "@/lib/cs/failed-delivery";
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
import { fixedCostForPeriod, opsCosts, periodMonths, rescuedFromRate } from "@/lib/constants/profit";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { isNewPhone } from "@/lib/alerts/risk";
import { attributionShares, shareFor, splitProfit } from "@/lib/constants/payroll";
import { expandLegacy, resolvePermissions, rolePermissions } from "@/lib/auth/permissions";
import { detectColumns, detectColumnsByContent, isGenericHeader, looksLikeHeader, matchVariant, normalizePhone, parseCsv, parseOfferText, parseSheetTime, parseVariantText, productCodeFromText, rowToLanding, sheetCsvUrl, sheetTabs, landingShippingFee } from "@/lib/constants/landing";
import { phoneChatState, phoneVerifyTrigger, renderPhoneVerifyTemplate } from "@/lib/cs/phone-verify";
import { getMarketerReport, getNominalMarketerBreakdown, getPayrollReport } from "@/lib/queries/payroll";
import { getAdsPerformance } from "@/lib/queries/ads-performance";
import { listLandingOrders, listLandingProductOptions } from "@/lib/queries/landing";
import { recheckAllLanding } from "@/lib/landing/sheet";

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


  // 8. Tỷ lệ giao thành công theo mã hàng + tồn kho ERP (GTC = COD thực > 100K; giao thành công nhưng COD 0 & cước < 10K = không thành công)
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
  // đơn giao thành công theo TIỀN THỰC THU: vận đơn chưa có trạng thái giao nhưng COD đã về theo bảng kê > 100K
  await mkOrder("rr-9007", "SHIPPED", { stage: "IN_TRANSIT", codAmount: 499000, codCollected: 499000, codStatus: "PAID_TO_BANK", shippingFee: 17000, vtpOrderNumber: "PKE1509000007" });
  // vận đơn "giao thành công" COD vận đơn 0 (trông như không TC) nhưng thực thu 499K → giao thành công
  await mkOrder("rr-9008", "DELIVERED", { stage: "DELIVERED", codAmount: 0, codCollected: 499000, codStatus: "COLLECTED", shippingFee: 8501, vtpOrderNumber: "PKE1509000008" });
  const all: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };
  const rr = await getReturnRateByVariant({ period: all, q: "RR-001", minShipped: 1, sort: "rate", dir: "desc", page: 1, pageSize: 10 });
  const row = rr.rows.find((r) => r.variantId === "rr-var");
  assert.ok(row, "có dòng RR-001");
  assert.equal(row.shipped, 7, "đã gửi 7");
  assert.equal(row.delivered, 3, "giao thành công 3 (1 theo trạng thái + 2 theo COD thực thu > 100K)");
  assert.equal(row.returned, 3, "không thành công 3 (1 trạng thái + 2 quy tắc)");
  assert.equal(row.returnedByRule, 2, "2 đơn không TC theo quy tắc COD/cước");
  assert.equal(row.inTransit, 1, "đang giao 1");
  assert.equal(row.cancelled, 1, "huỷ 1");
  assert.equal(row.rate, 50, "tỷ lệ hoàn 3/(3+3) = 50%");
  assert.equal(row.successRate, 50, "tỷ lệ giao thành công 3/(3+3) = 50%");
  assert.ok(row.expectedSuccessRate !== null && Math.abs(row.expectedSuccessRate - (100 - (row.expectedRate ?? 0))) < 1e-9, "dự kiến GTC = 100 − dự kiến hoàn");
  const summary = await getReturnRateSummary(all, "RR-001");
  assert.equal(summary.returned, 3);
  assert.equal(summary.delivered, 3);
  assert.equal(summary.successRate, 50);
  const detail = await listOrdersForVariant(row.key, all);
  assert.equal(detail.find((d) => d.id === "rr-9002")?.outcome, "RETURNED_BY_RULE");
  assert.equal(detail.find((d) => d.id === "rr-9003")?.outcome, "RETURNED_BY_RULE");
  assert.equal(detail.find((d) => d.id === "rr-9001")?.outcome, "DELIVERED");
  assert.equal(detail.find((d) => d.id === "rr-9004")?.outcome, "IN_TRANSIT");
  assert.equal(detail.find((d) => d.id === "rr-9007")?.outcome, "DELIVERED", "COD đã về > 100K → giao thành công dù vận đơn chưa báo giao");
  assert.equal(detail.find((d) => d.id === "rr-9008")?.outcome, "DELIVERED", "thực thu 499K → giao thành công dù COD vận đơn = 0");
  console.log(`✓ Tỷ lệ giao thành công RR-001: gửi ${row.shipped} · giao TC ${row.delivered} · không TC ${row.returned} (quy tắc ${row.returnedByRule}) · GTC ${row.successRate}%`);

  // Tồn kho ERP = Nhập − Giao thật − Đang giao
  const [receipt] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: now, totalQuantity: 10, totalCost: 2_000_000, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId: "rr-var", quantity: 10, unitCost: 200000 });
  const picker = await listVariantsForReceipt();
  const stock = picker.find((v) => v.id === "rr-var");
  assert.ok(stock, "có mẫu mã trong danh sách nhập");
  assert.equal(stock.currentStock, 6, "tồn = 10 nhập − 3 giao thành công (COD thực > 100K) − 1 đang giao = 6 (không thành công coi như về kho)");
  assert.equal(stock.lastCost, 200000, "giá nhập gần nhất lấy từ phiếu");
  console.log(`✓ Tồn kho ERP RR-001: ${stock.currentStock} (nhập 10, giao thành công 3, đang giao 1) · giá nhập ${stock.lastCost}`);

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
  assert.equal(mapVtpStatusText("Đã trả").stage, "RETURNED", "\"Đã trả\" = đơn hoàn trả về người gửi");
  assert.equal(mapVtpStatusText("Đã duyệt hoàn").stage, "RETURNING");
  assert.equal(mapVtpStatusText("Giao thành công").stage, "DELIVERED");
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
  assert.equal(rr1After?.stage, "RETURNED", "\"Đã trả\" → đơn hoàn");
  assert.equal(rr1After?.codStatus, "PAID_TO_BANK", "không hạ COD đã về ngân hàng");
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

  // Giao không thành → đọc lý do bưu tá, soạn tin riêng theo lý do, kèm giờ hẹn & SĐT bưu tá
  const noteRetry = "Người nhận hẹn phát lại ( 16:06 - 04/09/2026 ) - Bưu tá: Châu Thanh Hồng - 0971170052";
  assert.equal(classifyFailedReason([noteRetry]), "RESCHEDULED");
  assert.equal(failedMode([noteRetry]), "RETRY");
  assert.equal(classifyFailedReason(["Phát thất bại nhiều lần - Không liên lạc được khách hàng nhận - Bưu tá: Đinh Lệnh Dũng - 0396928659"]), "NO_CONTACT");
  assert.equal(classifyFailedReason(["Tồn - Khách hàng nghỉ, không có nhà"]), "NOT_HOME");
  assert.equal(classifyFailedReason(["Khách hàng từ chối nhận hàng"]), "REFUSED");
  assert.equal(classifyFailedReason(["Sai địa chỉ, không tìm thấy địa chỉ người nhận"]), "WRONG_ADDRESS");
  assert.equal(classifyFailedReason(["Giao không thành công"]), "OTHER");
  assert.equal(parseAppointment([noteRetry]), "16:06 ngày 04/09/2026");
  assert.deepEqual(parsePostman([noteRetry]), { name: "Châu Thanh Hồng", phone: "0971170052" });
  const msg = renderFailedTemplate(DEFAULT_CS_RULES.failedDeliveryTemplates.RESCHEDULED, { ten: "chị Quyên", ma_van_don: "PKE1508897551", buu_ta: "Châu Thanh Hồng", sdt_buu_ta: "0971170052", shop: "Hải An", san_pham: "Đầm Q002", gio_hen: "16:06 ngày 04/09/2026" });
  assert.ok(msg.includes("0971170052") && msg.includes("PKE1508897551") && msg.includes("16:06 ngày 04/09/2026"), "tin hẹn phát lại có giờ hẹn, SĐT bưu tá & mã vận đơn");
  const msg2 = renderFailedTemplate(DEFAULT_CS_RULES.failedDeliveryTemplates.NO_CONTACT, { ten: "chị Ngọc", ma_van_don: "PKE1508909081", buu_ta: "Đinh Lệnh Dũng", sdt_buu_ta: "0396928659", shop: "Hải An", san_pham: "Đầm Q003" });
  assert.notEqual(msg, msg2, "mỗi lý do một nội dung khác nhau");
  assert.equal(isReturningNote(["Đóng bảng kê - Bưu tá: Đặng Việt Cường - 0385372311"]), true, "đóng bảng kê = đang hoàn, không hỏi lý do");
  assert.equal(isReturningNote(["Người nhận hẹn phát lại"]), false);
  assert.equal(isShopAddressIssue("[🤖 BOT ĐÃ TỰ ĐỘNG SỬA LẠI ĐỊA CHỈ SAI SANG QUẢNG NINH]", []), true, "ghi chú bot sửa địa chỉ = lỗi shop");
  assert.equal(isShopAddressIssue("khách dặn giao giờ hành chính", ["Giao không thành"]), false);
  console.log("✓ Giao không thành: phân loại lý do bưu tá, giờ hẹn, SĐT bưu tá, tin riêng theo lý do, bỏ qua khi đang hoàn / lỗi địa chỉ của shop");

  // Giả định chi phí vận hành theo đơn (đóng hàng, nhân viên vận đơn, cố định theo kỳ)
  const opsA = { packingFeePerOrder: 5_000, opsStaffPerOrder: 2_000, opsStaffPerRescued: 10_000 };
  assert.deepEqual(opsCosts({ orders: 100, rescued: 7 }, opsA), { packingCost: 500_000, opsStaffCost: 270_000 }, "đóng hàng 100×5K, NV vận đơn 100×2K + 7×10K");
  assert.deepEqual(opsCosts({ orders: 3, rescued: 9 }, opsA), { packingCost: 15_000, opsStaffCost: 36_000 }, "đơn cứu không vượt số đơn");
  assert.deepEqual(opsCosts({ orders: 0, rescued: 0 }, opsA), { packingCost: 0, opsStaffCost: 0 });
  const m30 = periodMonths(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-31T00:00:00Z"));
  assert.ok(Math.abs(m30 - 30 / (365 / 12)) < 1e-9, "30 ngày ≈ 0,986 tháng");
  assert.equal(fixedCostForPeriod(5_000_000, 1), 5_000_000);
  assert.equal(fixedCostForPeriod(5_000_000, 0.5), 2_500_000);
  assert.equal(fixedCostForPeriod(5_000_000, 0), 0, "kỳ không có đơn thì không tính cố định");
  assert.equal(periodMonths(null, new Date()), 0);
  assert.equal(rescuedFromRate(937, 10), 94, "đơn cứu ước 10% số đơn gửi");
  assert.equal(rescuedFromRate(0, 10), 0);
  console.log("✓ Giả định vận hành: đóng hàng/đơn, NV vận đơn (đơn + đơn cứu GTC), chi phí cố định theo số tháng của kỳ");

  // Các báo cáo lợi nhuận / lương chạy được trên CSDL thật (bắt lỗi SQL: enum, cột, join)
  const nominal = await getNominalProfitReport(all);
  assert.ok(nominal.totals.orders >= 0 && Number.isFinite(nominal.totals.opexTotal), "báo cáo danh nghĩa có tổng vận hành");
  assert.equal(nominal.totals.opexTotal, nominal.operatingExpenses + nominal.totals.packingCost + nominal.totals.opsStaffCost + nominal.fixedCost, "tổng vận hành = đã nhập + đóng hàng + NV vận đơn + cố định");
  for (const r of nominal.rows) {
    assert.equal(r.opexTotal, r.operatingAlloc + r.packingCost + r.opsStaffCost + r.fixedAlloc, `vận hành từng mã ${r.code}`);
    assert.equal(r.netProfit, r.expectedProfit - r.opexTotal - r.inventoryRisk - r.tax - r.otherCost, `LN ròng ${r.code}`);
    assert.ok(r.rescued <= r.orders, "đơn cứu ≤ đơn");
    assert.equal(r.otherCostsTotal, r.opexTotal + r.inventoryRisk + r.tax + r.otherCost, `chi phí ngoài hàng-QC-VC ${r.code}`);
    if (r.orders) assert.equal(r.opexPerOrder, Math.round(r.otherCostsTotal / r.orders), `CP vận hành/đơn trước hoàn ${r.code}`);
  }
  assert.ok(nominal.assumptions.shipFeeReturnedUsed >= nominal.assumptions.shipFeeDeliveredUsed, "cước đơn hoàn ≥ cước gửi");
  for (const basis of ["profit1", "profit2", "nominal", "cash"] as const) {
    const mk = await getMarketerReport(all, basis);
    assert.equal(mk.totals.operating, mk.totals.operatingEntered + mk.totals.fixedCost + mk.totals.perOrderOps, `vận hành lương (${basis})`);
    await getPayrollReport(all, basis);
  }
  const nb = await getNominalMarketerBreakdown(all);
  for (const m of nb.rows) {
    for (const p of m.products) assert.ok(p.adSpend || p.orders || p.revenue || p.ownerBonus || p.personalNet, "chi tiết chỉ gồm mã có số liệu");
    const sum = m.products.reduce((t, p) => t + p.personalNet, 0) - m.testSpend - Math.round(m.testSpend * ((nominal.assumptions.otherCostPercentOfAds ?? 0) / 100));
    assert.ok(Math.abs(sum - m.personalNet) <= m.products.length + 1, `tổng chi tiết mã ≈ LN cá nhân của ${m.name}`);
  }
  // Hiệu quả QC: đơn theo marketer (kể cả "Chưa gán") khớp tổng đơn đã xác nhận; tỷ lệ hoàn & biên là phân số 0–1; LN mã = LN ròng
  const perf = await getAdsPerformance(all);
  const perfOrders = perf.marketers.reduce((t, m) => t + m.orders, 0);
  assert.ok(Math.abs(perfOrders - nominal.totals.orders) <= perf.marketers.length, `đơn theo marketer ${perfOrders} ≈ đơn xác nhận ${nominal.totals.orders}`);
  const perfProfit = perf.marketers.reduce((t, m) => t + m.profit, 0);
  assert.ok(Math.abs(perfProfit - nominal.totals.netProfit) <= 2 * (perf.marketers.length + nominal.rows.length), `LN sau QC theo marketer ${perfProfit} ≈ LN ròng toàn shop ${nominal.totals.netProfit}`);
  const perfRevenue = perf.marketers.reduce((t, m) => t + m.revenue, 0);
  assert.ok(Math.abs(perfRevenue - nominal.totals.expectedRevenue) <= perf.marketers.length + nominal.rows.length, "doanh số phân bổ khớp DT GTC ước tính");
  // đơn & doanh số xác nhận theo marketer khớp thẻ KPI (đơn đếm 1 lần, tổng tiền sau giảm)
  assert.ok(Math.abs(nominal.totals.ordersWeighted - nominal.totals.ordersDistinct) < 1e-6, "Σ đơn chia 1/N = số đơn đếm 1 lần");
  assert.ok(Math.abs(perfOrders - nominal.totals.ordersDistinct) <= perf.marketers.length, `đơn theo marketer ${perfOrders} ≈ đơn xác nhận đếm 1 lần ${nominal.totals.ordersDistinct}`);
  const perfSales = perf.marketers.reduce((t, m) => t + m.confirmedSales, 0);
  assert.ok(Math.abs(perfSales - nominal.totals.salesAfterDiscount) <= perf.marketers.length + nominal.rows.length, `doanh số xác nhận theo marketer ${perfSales} ≈ ${nominal.totals.salesAfterDiscount}`);
  assert.equal(perf.totals.orders, nominal.totals.ordersDistinct);
  assert.equal(perf.totals.confirmedSales, nominal.totals.salesAfterDiscount);
  for (const p of perf.products.filter((r) => !r.id.startsWith("__"))) {
    assert.ok(p.returnRate !== undefined && p.returnRate >= 0 && p.returnRate <= 1, "tỷ lệ hoàn dự kiến là phân số");
    assert.ok(p.expectedSuccessRate !== undefined && Math.abs(p.expectedSuccessRate - (1 - (p.returnRate ?? 0))) < 1e-9, "tỷ lệ GTC dự kiến = 1 − tỷ lệ hoàn dự kiến");
    if (p.successRate !== null && p.successRate !== undefined) assert.ok(p.successRate >= 0 && p.successRate <= 1);
    if (p.actualReturnRate !== null && p.actualReturnRate !== undefined) assert.ok(p.actualReturnRate >= 0 && p.actualReturnRate <= 1);
    if (p.margin !== null) assert.ok(Math.abs(p.margin) <= 50, "biên là phân số");
    const n = nominal.rows.find((r) => r.productId === p.id);
    if (n) assert.equal(p.profit, n.netProfit, "LN sau QC = LN ròng ước tính");
  }
  console.log("✓ Báo cáo danh nghĩa / lương / LN theo marketer chạy trên CSDL, chi tiết mã khớp tổng; hiệu quả QC khớp đơn xác nhận");

  // SĐT mới (Pancake tô xanh) → xác nhận số & xin số phụ
  assert.equal(isNewPhone({ phone: "0939748540", succeed: 0, returned: 0, erpOtherOrders: 0 }), true, "chưa GTC, chưa hoàn, không đơn khác = SĐT mới");
  assert.equal(isNewPhone({ phone: "0939748540", succeed: 0, returned: 0, erpOtherOrders: 1 }), false, "có đơn khác cùng số trong ERP");
  assert.equal(isNewPhone({ phone: "0939748540", succeed: 2, returned: 0, erpOtherOrders: 0 }), false, "khách đã mua");
  assert.equal(isNewPhone({ phone: "", succeed: 0, returned: 0, erpOtherOrders: 0 }), false, "không có SĐT thì không xét");
  const pvT0 = new Date("2026-09-01T08:00:00Z");
  const at = (m: number) => new Date(pvT0.getTime() + m * 60_000);
  const chat1 = [
    { text: "Cao 1 m 6 nặng 50 kg", fromPage: false, insertedAt: at(0) },
    { text: "Dạ chị cao 1m6 mặc size L nhé", fromPage: true, insertedAt: at(1) },
  ];
  assert.equal(phoneChatState(chat1, "0939748540"), null, "shop chưa hỏi SĐT → sẽ nhắn");
  const chat2 = [...chat1, { text: "Chị ơi, SĐT của mình đúng ko ạ? 0939748540", fromPage: true, insertedAt: at(2) }];
  assert.equal(phoneChatState(chat2, "0939748540"), "SHOP_ASKED", "shop đã hỏi, khách chưa trả lời → không nhắn lại");
  assert.equal(phoneChatState([...chat2, { text: "Đúng rồi em", fromPage: false, insertedAt: at(3) }], "0939748540"), "CUSTOMER_CONFIRMED", "khách xác nhận đúng");
  assert.equal(phoneChatState([...chat2, { text: "số này nè 0912 345 678", fromPage: false, insertedAt: at(3) }], "0939748540"), "CUSTOMER_CONFIRMED", "khách gửi số khác = đã trả lời");
  assert.equal(phoneChatState([...chat2, { text: "Áo đầm cũ chị gửi chưa", fromPage: false, insertedAt: at(3) }], "0939748540"), "SHOP_ASKED", "khách nhắn việc khác, vẫn chờ xác nhận");
  const pv = renderPhoneVerifyTemplate(DEFAULT_CS_RULES.phoneVerifyTemplate, { ten: "chị Loan", sdt: "0939748540", san_pham: "Đầm Q002", shop: "Hải An" });
  assert.ok(pv.includes("0939748540") && pv.includes("Đầm Q002") && /số phụ/.test(pv), "tin xác nhận có SĐT, sản phẩm và xin số phụ");
  const pvRules = { phoneVerifyTags: ["sdt moi", "xac nhan sdt"], phoneVerifyRisky: true, phoneVerifyNewPhone: false };
  const pvRisk = { riskMinReturned: 2, riskReturnRatePct: 40 };
  assert.equal(phoneVerifyTrigger({ tags: [], risk: assessCustomerRisk({ succeed: 20, returned: 3, isBlock: false }, pvRisk), newPhone: false }, pvRules), null, "khách 20 GTC / 3 hoàn: KHÔNG hỏi lại");
  assert.equal(phoneVerifyTrigger({ tags: [], risk: assessCustomerRisk({ succeed: 0, returned: 0, isBlock: false }, pvRisk), newPhone: true }, pvRules), null, "SĐT mới tại shop: mặc định không nhắn (thiếu lịch sử toàn Pancake)");
  assert.equal(phoneVerifyTrigger({ tags: [], risk: assessCustomerRisk({ succeed: 0, returned: 0, isBlock: false }, pvRisk), newPhone: true }, { ...pvRules, phoneVerifyNewPhone: true })?.kind, "NEW_PHONE", "bật cờ thì SĐT mới tại shop mới được nhắn");
  assert.equal(phoneVerifyTrigger({ tags: [], risk: assessCustomerRisk({ succeed: 6, returned: 44, isBlock: false }, pvRisk), newPhone: false }, pvRules)?.kind, "RISKY", "hoàn 44/50 → hỏi xác nhận SĐT");
  assert.equal(phoneVerifyTrigger({ tags: ["Trang", "SĐT mới"], risk: null, newPhone: false }, pvRules)?.kind, "TAG", "nhân viên gắn thẻ SĐT mới → nhắn");
  console.log("✓ SĐT mới: nhận diện, đọc chat (shop đã hỏi / khách đã xác nhận), mẫu tin xác nhận SĐT & xin số phụ; chỉ nhắn khi gắn thẻ / khách rủi ro / bật cờ SĐT mới");

  // Ghi nhận đơn theo fanpage & chia % LN chủ mã / người chạy cùng
  const pm = { P1: "A", P2: "B" };
  const a1 = attributionShares({ byPage: [{ pageId: "P1", value: 700 }, { pageId: "P2", value: 300 }], pageMarketers: pm, adShares: new Map([["A", 0.5], ["B", 0.5]]), ownerId: "A" });
  assert.equal(a1.mode, "page");
  assert.ok(Math.abs((a1.shares.get("A") ?? 0) - 0.7) < 1e-9 && Math.abs((a1.shares.get("B") ?? 0) - 0.3) < 1e-9, "theo fanpage: A 70%, B 30% dù QC 50/50");
  const a2 = attributionShares({ byPage: [{ pageId: "P1", value: 600 }, { pageId: "P9", value: 200 }, { pageId: null, value: 200 }], pageMarketers: pm, adShares: new Map([["B", 1]]), ownerId: "A" });
  assert.ok(Math.abs((a2.shares.get("A") ?? 0) - 0.6) < 1e-9 && Math.abs((a2.shares.get("B") ?? 0) - 0.4) < 1e-9, "page chưa gán / không page (40%) chia theo QC → B");
  assert.equal(a2.unmappedValue, 400);
  const a4 = attributionShares({ byPage: [{ pageId: "P1", value: 400, adMarketerId: "B" }, { pageId: "P1", value: 600 }], pageMarketers: pm, adShares: new Map(), ownerId: "A" });
  assert.ok(Math.abs((a4.shares.get("B") ?? 0) - 0.4) < 1e-9 && Math.abs((a4.shares.get("A") ?? 0) - 0.6) < 1e-9, "ad_id của đơn thắng fanpage: B chạy chung page của A vẫn được ghi nhận đúng 40%");
  const a3 = attributionShares({ byPage: [{ pageId: "P9", value: 500 }], pageMarketers: pm, adShares: new Map(), ownerId: "A" });
  assert.equal(a3.mode, "owner", "không page gán, không QC → về chủ mã");
  assert.equal(attributionShares({ byPage: [], pageMarketers: pm, adShares: new Map([["A", 0.2], ["B", 0.8]]), ownerId: null }).shares.get("B"), 0.8, "không có page → theo QC như cũ");
  assert.equal(attributionShares({ byPage: [], pageMarketers: {}, adShares: new Map(), ownerId: null }).mode, "none");
  const shDefault = shareFor({ productShares: {}, ownerSharePct: 5 }, "X");
  assert.deepEqual(shDefault, { ownerPct: 100, crossPct: 95 }, "mặc định: chủ mã 100%, chạy cùng 95% (5% về chủ mã)");
  const shCustom = shareFor({ productShares: { X: { ownerPct: 40, crossPct: 30 } }, ownerSharePct: 5 }, "X");
  assert.deepEqual(splitProfit(1_000_000, "owner", shCustom), { keep: 400_000, toOwner: 0, toShop: 600_000 }, "chủ mã 40%, shop giữ 60%");
  assert.deepEqual(splitProfit(1_000_000, "cross", shCustom), { keep: 300_000, toOwner: 700_000, toShop: 0 }, "chạy cùng 30%, 70% về chủ mã");
  assert.deepEqual(splitProfit(-200_000, "cross", shCustom), { keep: -200_000, toOwner: 0, toShop: 0 }, "LN âm người tạo đơn chịu");
  assert.deepEqual(splitProfit(1_000_000, "cross", shDefault), { keep: 950_000, toOwner: 50_000, toShop: 0 }, "mặc định 5% về chủ mã như quy tắc cũ");
  console.log("✓ Ghi nhận theo fanpage (page → marketer, phần chưa gán theo QC / chủ mã) & chia % LN chủ mã / chạy cùng");

  // Phân quyền chi tiết: quyền cũ đã lưu suy ra quyền mới; vai trò Trưởng nhóm
  const legacyPerms = resolvePermissions("MARKETING", ["orders:read", "reports:view", "payroll:view"], null);
  assert.ok(["cs:view", "outreach:view", "orders:export", "reports:cash", "reports:nominal", "reports:returns", "payroll:view-own"].every((k) => legacyPerms.includes(k)), "quyền cũ reports:view / orders:read / payroll:view mở đúng quyền mới");
  assert.ok(!legacyPerms.includes("payroll:manage") && !legacyPerms.includes("reports:assumptions"), "không tự mở quyền quản lý");
  assert.deepEqual(expandLegacy(["reports:nominal"]), ["reports:nominal"], "quyền mới giữ nguyên");
  const leader = rolePermissions("LEADER", null);
  assert.ok(leader.includes("payroll:view") && leader.includes("reports:nominal") && !leader.includes("reports:cash") && !leader.includes("users:manage"), "Trưởng nhóm: xem lương cả nhóm, BCLN danh nghĩa, không xem dòng tiền thực");
  const custom = resolvePermissions("LEADER", ["reports:cash"], { LEADER: ["reports:nominal"] });
  assert.deepEqual(custom, ["reports:cash"], "quyền riêng từng người thắng mẫu vai trò");
  assert.ok(resolvePermissions("ADMIN", ["reports:cash"], null).includes("users:manage"), "ADMIN luôn toàn quyền");
  console.log("✓ Phân quyền chi tiết: suy ra từ quyền cũ, mẫu vai trò Trưởng nhóm, quyền riêng từng người");

  // Đơn landing page: đọc CSV Google Sheet, dò cột, ghép mẫu mã
  const csv = 'Dấu thời gian,Họ và tên,Số điện thoại,Địa chỉ nhận hàng,Sản phẩm,Size,Màu sắc,Số lượng,Ghi chú,utm_campaign\n"05/09/2026 09:45:12","Huân Mai","0788 281 828","xóm đầu đồng, xã An Hưng, Hải Phòng","Đầm Q004","XL","Nâu","1","giao giờ hành chính","q004_landing"\n"9/5/2026 10:01:00","Loan Nguyen","+84939748540","Ấp Thạnh Thới, Kiên Giang","Đầm Q002 đỏ đô","L","","2","",""\n';
  const table = parseCsv(csv);
  assert.equal(table.length, 3, "2 dòng dữ liệu + tiêu đề");
  const cols = detectColumns(table[0]);
  assert.deepEqual({ time: cols.time, name: cols.name, phone: cols.phone, address: cols.address, product: cols.product, size: cols.size, color: cols.color, quantity: cols.quantity, note: cols.note, campaign: cols.campaign }, { time: 0, name: 1, phone: 2, address: 3, product: 4, size: 5, color: 6, quantity: 7, note: 8, campaign: 9 }, "dò đúng cột theo tiêu đề tiếng Việt / utm_campaign");
  const lr1 = rowToLanding(table[0], table[1], cols, 1)!;
  assert.equal(lr1.phone, "0788281828", "SĐT bỏ khoảng trắng");
  assert.equal(rowToLanding(table[0], table[2], cols, 2)!.phone, "0939748540", "+84 → 0");
  assert.equal(lr1.time?.toISOString(), new Date("2026-09-05T09:45:12+07:00").toISOString(), "dd/mm/yyyy hh:mm:ss giờ VN");
  assert.equal(parseSheetTime("9/13/2026 10:01:00")?.toISOString(), new Date("2026-09-13T10:01:00+07:00").toISOString(), "m/d/yyyy (Google Forms tiếng Anh) tự đảo khi ngày > 12");
  assert.equal(parseSheetTime("2026-09-05 08:00")?.toISOString(), new Date("2026-09-05T08:00:00+07:00").toISOString(), "yyyy-mm-dd hh:mm giờ VN");
  assert.equal(normalizePhone("84 93 974 8540"), "0939748540");
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/ABC123/edit?pli=1&gid=571194026#gid=571194026"), "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=571194026", "link sheet → link CSV giữ gid");
  const cands = [
    { id: "v1", productId: "p4", productName: "Đầm Q004", productCode: "Q004", sku: "Q004NAUXL", size: "XL", color: "Nâu" },
    { id: "v2", productId: "p4", productName: "Đầm Q004", productCode: "Q004", sku: "Q004DOXL", size: "XL", color: "Đỏ" },
    { id: "v3", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "Q002DOL", size: "L", color: "Đỏ đô" },
    { id: "v4", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "Q002DOM", size: "M", color: "Đỏ đô" },
  ];
  assert.equal(matchVariant({ product: lr1.product, variant: lr1.variant, size: lr1.size, color: lr1.color }, cands)?.variant.id, "v1", "Q004 XL Nâu → đúng mẫu");
  assert.equal(matchVariant({ product: "Đầm Q002 đỏ đô", variant: "", size: "L", color: "" }, cands)?.variant.id, "v3", "màu nằm trong tên sản phẩm, size L");
  assert.equal(matchVariant({ product: "Áo sơ mi", variant: "", size: "L", color: "" }, cands), null, "không khớp mã / tên → null");
  // Sheet KHÔNG có tiêu đề (form landing đổ thẳng dữ liệu, cột theo vị trí) → dò theo nội dung
  const noHeader: string[][] = [
    ["2026-08-05 06:42:42", "Bùi thị thuận", "933421665", "47 phù đổng thiên vương f lâm viên Đà Lạt lâm đồng", "Lâm Đồng", "Thành phố Đà Lạt", "Phường 8", "Việt Nam", "", "Size XL,Màu  Đỏ Đô", "1 Sản phẩm 499k", "https://www.japanitems.store/w2n?utm_source=QA4_C%C4%90_05%2F08_Q002_V2&utm_term=120247521093950618", "QA4_CĐ_05/08_Q002_V2", "Nhóm quảng cáo Doanh số mới", "Quảng cáo Doanh số mới TXT", "120247521093950618", "120247521093940618", "27.70.235.1", "FORM1", ""],
    ["2026-08-05 07:00:32", "Lê Bạch ", "988993583", "223 đồng khởi khóm 1 phường 9 TP Trà vinh ", "Trà Vinh", "Thành phố Trà Vinh", "Phường 9", "Việt Nam", "Gọi điện trước ", "Size XL,Màu  Đỏ Đô", "1 Sản phẩm 499k", "https://www.japanitems.store/w2n?utm_source=QA4_C%C4%90_05%2", "QA4_CĐ_05/08_Q002_V4", "Nhóm quảng cáo Doanh số mới", "Quảng cáo Doanh số mới TXT", "120247521114350618", "120247521114340618", "27.71.98.118", "FORM1", ""],
    ["2026-08-05 09:52:41", "Bùi nhâm", "338133343", "Thôn 5 Quang Trung Bỉm Sơn Thanh Hóa", "Thanh Hóa", "Thị xã Bỉm Sơn", "Xã Quang Trung", "Việt Nam", "Tôi muốn được tư vấn", "Size L,Màu  Đỏ Đô", "2 Sản phẩm 849k", "https://www.japanitems.store/w2n?utm_source=QA4_C%C4%90_05%2", "QA4_CĐ_05/08_Q002_V2", "Nhóm quảng cáo Doanh số mới - Bản sao 3", "Quảng cáo Doanh số mới TXT", "120247528386900618", "120247528386890618", "222.255.255.147", "FORM1", ""],
  ];
  assert.equal(looksLikeHeader(noHeader[0]), false, "dòng đầu có ngày giờ / SĐT → không phải tiêu đề");
  assert.equal(looksLikeHeader(table[0]), true, "dòng tiêu đề chữ → tiêu đề");
  const cc = detectColumnsByContent(noHeader);
  assert.deepEqual({ time: cc.time, name: cc.name, phone: cc.phone, address: cc.address, province: cc.province, district: cc.district, ward: cc.ward, note: cc.note, variant: cc.variant, offer: cc.offer, source: cc.source, campaign: cc.campaign, adId: cc.adId }, { time: 0, name: 1, phone: 2, address: 3, province: 4, district: 5, ward: 6, note: 8, variant: 9, offer: 10, source: 11, campaign: 12, adId: 15 }, "dò theo nội dung đúng 13 cột của sheet landing");
  const gh = Array.from({ length: 20 }, (_, i) => `Cột ${i + 1}`);
  const n1 = rowToLanding(gh, noHeader[0], cc, 1)!;
  assert.equal(n1.phone, "0933421665", "SĐT mất số 0 đầu (Sheets định dạng số) → thêm lại");
  assert.deepEqual({ size: n1.size, color: n1.color }, { size: "XL", color: "Đỏ Đô" }, "tách size / màu từ “Size XL,Màu  Đỏ Đô”");
  assert.deepEqual({ q: n1.quantity, total: n1.total, price: n1.price }, { q: 1, total: 499_000, price: 499_000 }, "“1 Sản phẩm 499k”");
  assert.equal(n1.product, "Q002", "mã hàng lấy từ tên chiến dịch QA4_CĐ_05/08_Q002_V2");
  assert.equal(n1.adId, "120247521093950618");
  assert.equal(n1.campaign, "QA4_CĐ_05/08_Q002_V2");
  assert.equal(n1.address, "47 phù đổng thiên vương f lâm viên Đà Lạt lâm đồng, Phường 8, Thành phố Đà Lạt", "địa chỉ ghép phường / quận");
  assert.equal(n1.province, "Lâm Đồng");
  const n3 = rowToLanding(gh, noHeader[2], cc, 3)!;
  assert.deepEqual({ q: n3.quantity, total: n3.total, note: n3.note, size: n3.size }, { q: 2, total: 849_000, note: "Tôi muốn được tư vấn", size: "L" }, "gói 2 sản phẩm 849k, ghi chú, size L");
  assert.deepEqual(parseOfferText("1 Sản phẩm 499k"), { quantity: 1, total: 499_000 });
  assert.deepEqual(parseOfferText("1 Sản phẩm 499 499.000đ (+25k ship)"), { quantity: 1, total: 499_000 }, "gói tab Q003 có kèm phí ship");
  assert.deepEqual(parseOfferText("2 Sản phẩm 849 849.000đ (Free ship)"), { quantity: 2, total: 849_000 });
  assert.deepEqual(parseVariantText("Size M | Màu  Đỏ Đô | Màu Đỏ Đô"), { size: "M", color: "Đỏ Đô" }, "biến thể tab Q003");
  assert.equal(parseSheetTime("06:15:01 2/9/2026")?.toISOString(), new Date("2026-09-02T06:15:01+07:00").toISOString(), "giờ trước ngày (tab Q003)");
  assert.equal(productCodeFromText("QA4_CĐ_31/01_Q003_Hải An Fashion_1"), "Q003");
  assert.equal(normalizePhone("+84336693297"), "0336693297");
  const tabsCfg = sheetTabs({ sheetUrl: "https://docs.google.com/spreadsheets/d/ABC/edit#gid=5", gid: "", tabs: "Q003, Q002" });
  assert.deepEqual(tabsCfg.map((t) => t.label), ["Q003", "Q002"]);
  assert.ok(tabsCfg[0].url.includes("gviz/tq?tqx=out:csv&sheet=Q003"), "đọc theo tên tab qua gviz");
  assert.equal(sheetTabs({ sheetUrl: "https://docs.google.com/spreadsheets/d/ABC/edit#gid=5", gid: "", tabs: "" })[0].key, "5", "không khai tab → theo gid trong link");
  assert.equal(isGenericHeader(["", "", ""]), true);
  assert.equal(isGenericHeader(["A", "B", "C"]), true);
  assert.equal(isGenericHeader(["Họ tên", "SĐT"]), false);
  const q3 = ["06:15:01 2/9/2026", "Hà ngọc", "0392663366", "Xóm đoàn kết, Xã Chiềng Hặc, Huyện Yên Châu, Sơn La", "1 Sản phẩm 499 499.000đ (+25k ship)", "Size M | Màu  Đỏ Đô | Màu Đỏ Đô", "", "QA4_CĐ_31/01_Q003_Hải An Fashion_1", "Nhóm quảng cáo Chuyển đổi mới - Bản sao 4", "Quảng cáo", "120247800000000001", "120247800000000002"];
  const q3b = ["07:50:31 2/9/2026", "Hong", "0933385828", "175 nguyen chi thanh p12 Q5, Phường 12, Quận 5, Hồ Chí Minh", "2 Sản phẩm 849 849.000đ (Free ship)", "Size 2XL | Màu  Cao 1m55 nang 5", "Bỏ đơn trước", "QA4_CĐ_31/01_Q003_Hải An Fashion_1", "Nhóm quảng cáo Chuyển đổi mới", "Quảng cáo", "120247800000000003", "120247800000000004"];
  const q3cols = detectColumnsByContent([q3, q3b, q3]);
  assert.deepEqual({ time: q3cols.time, name: q3cols.name, phone: q3cols.phone, address: q3cols.address, offer: q3cols.offer, variant: q3cols.variant, campaign: q3cols.campaign, adId: q3cols.adId, note: q3cols.note }, { time: 0, name: 1, phone: 2, address: 3, offer: 4, variant: 5, campaign: 7, adId: 10, note: 6 }, "dò cột tab Q003 (bố cục khác tab Q002)");
  const q3row = rowToLanding(Array.from({ length: 12 }, (_, i) => `Cột ${i + 1}`), q3b, q3cols, 41)!;
  assert.deepEqual({ p: q3row.product, q: q3row.quantity, t: q3row.total, s: q3row.size, n: q3row.note, ph: q3row.phone }, { p: "Q003", q: 2, t: 849_000, s: "2XL", n: "Bỏ đơn trước", ph: "0933385828" }, "dòng tab Q003: mã Q003, 2 sp 849k, size 2XL, ghi chú");
  assert.deepEqual(parseVariantText("Size M, Màu Nâu"), { size: "M", color: "Nâu" });
  assert.equal(productCodeFromText("https://x.vn/w2n?utm_source=QA4_C%C4%90_05%2F08_Q004_V2"), "Q004", "mã hàng trong utm_source đã mã hoá URL");
  const candsPlus = [...cands, { id: "v5", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "Q002DOXL", size: "XL", color: "Đỏ đô" }];
  assert.equal(matchVariant({ product: n1.product, variant: n1.variant, size: n1.size, color: n1.color }, candsPlus)?.variant.id, "v5", "Q002 XL Đỏ Đô → mẫu Q002 XL Đỏ đô");
  assert.equal(matchVariant({ product: n1.product, variant: n1.variant, size: n1.size, color: n1.color }, cands), null, "không có size XL của Q002 → chưa ghép, chọn tay");
  // Không có size lẫn màu → KHÔNG đoán mẫu (trước đây chọn bừa mẫu đầu của mã, điểm 5); mã chỉ có 1 mẫu thì vẫn ghép
  assert.equal(matchVariant({ product: "Q002", variant: "", size: "", color: "" }, cands), null, "Q002 không rõ size / màu → null");
  assert.equal(matchVariant({ product: "Q004", variant: "", size: "", color: "" }, [cands[0]])?.variant.id, "v1", "mã chỉ có 1 mẫu → ghép");
  // Bố cục form đổi: cột biến thể / gói / địa chỉ dò được bị trống → quét cả dòng
  const shifted = ["2026-09-06 08:10:46", "Nguyễn thị chiến", "0915435436", "", "Việt Nam", "", "", "", "Size M,Màu  Đỏ Đô", "", "", "Thôn 3, xã Tân Lập, huyện Đan Phượng, Hà Nội", "QA4_CĐ_06/09_Q003_Hải An Fashion_2"];
  const shiftedCols = { time: 0, name: 1, phone: 2, address: 3, variant: 5, offer: 6, campaign: 12 } as const;
  const sr = rowToLanding(Array.from({ length: 13 }, (_, i) => `Cột ${i + 1}`), shifted, shiftedCols, 84, { singlePrice: 499_000 })!;
  assert.deepEqual({ size: sr.size, color: sr.color, address: sr.address, price: sr.price, total: sr.total, q: sr.quantity, p: sr.product }, { size: "M", color: "Đỏ Đô", address: "Thôn 3, xã Tân Lập, huyện Đan Phượng, Hà Nội", price: 499_000, total: 499_000, q: 1, p: "Q003" }, "quét cả dòng: size M / màu, địa chỉ, 1 sp không ghi giá → 499k");
  const missing = rowToLanding(Array.from({ length: 13 }, (_, i) => `Cột ${i + 1}`), ["2026-09-06 08:10:46", "Hang", "0979116115", "", "Việt Nam", "", "", "", "", "", "", "", ""], shiftedCols, 82, { singlePrice: 499_000 })!;
  assert.deepEqual({ size: missing.size, address: missing.address, total: missing.total }, { size: "", address: "", total: 499_000 }, "thiếu size & địa chỉ → giữ trống để báo đỏ; giá vẫn 499k");
  assert.deepEqual([landingShippingFee(1, 25_000), landingShippingFee(2, 25_000)], [25_000, 0], "1 sp +25k ship, gói ≥ 2 sp free ship");
  // Tab khai kèm gid → đọc bằng export theo gid (gviz làm trống SĐT '0963… / giờ dạng chữ trong cột số / ngày)
  const gidTabs = sheetTabs({ sheetUrl: "https://docs.google.com/spreadsheets/d/ABC/edit#gid=5", gid: "", tabs: "Q003=1293871758, Q002=571194026" });
  assert.deepEqual(gidTabs.map((t) => [t.key, t.label, t.url]), [["tab:Q003", "Q003", "https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=1293871758"], ["tab:Q002", "Q002", "https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=571194026"]], "tên=gid → export?format=csv&gid, khoá tab giữ theo tên");
  // SĐT có dấu ' đầu ô, hoặc cột SĐT trống nhưng SĐT nằm ở ô khác; ô phường / quận không đúng dạng thì không ghép vào địa chỉ
  const q2new = ["", "Nhà hàng Sơn hà", "'0963564193", "Xã Phúc Trạch, Huyện Hương Khê, Hà Tĩnh", "1 Sản phẩm 555k", "555.000đ (+25k ship)", "Size XL | Màu Đen", "", "QA4_CĐ_06/09_Q002_ĐEN_Linh Tây Luxury_4", "Nhóm quảng cáo Chuyển đổi mới", "Quảng cáo Lượt tương tác mới TXT", "120248121230150618", "120248121229960618"];
  const q2cols = { time: 0, name: 1, phone: 2, address: 3, province: 4, district: 5, ward: 6, note: 8, variant: 9, offer: 10, source: 11, campaign: 12 } as const; // bố cục cũ của tab Q002 áp lên dòng mới
  const q2row = rowToLanding(Array.from({ length: 13 }, (_, i) => `Cột ${i + 1}`), q2new, q2cols, 194, { singlePrice: 499_000 })!;
  assert.deepEqual({ phone: q2row.phone, address: q2row.address, size: q2row.size, color: q2row.color, total: q2row.total, q: q2row.quantity, p: q2row.product }, { phone: "0963564193", address: "Xã Phúc Trạch, Huyện Hương Khê, Hà Tĩnh", size: "XL", color: "Đen", total: 555_000, q: 1, p: "Q002" }, "dòng Q002 bố cục mới: SĐT có dấu ', địa chỉ không dính size / giá, gói 555k, mã từ chiến dịch");
  const q2blank = rowToLanding(Array.from({ length: 13 }, (_, i) => `Cột ${i + 1}`), ["", "Nguyễn thị Nguyệt", "", "806/04 Quang Trung tt phù mỹ", "1 Sản phẩm 555k", "555.000đ (+25k ship)", "Màu Đen", "", "QA4_CĐ_06/09_Q002_ĐỎ_Linh Tây Luxury_3", "", "", "120248121219310618", "'0978044732"], q2cols, 195)!;
  assert.deepEqual({ phone: q2blank.phone, size: q2blank.size, color: q2blank.color }, { phone: "0978044732", size: "", color: "Đen" }, "cột SĐT trống → tìm SĐT ở ô khác (không nhầm ad_id); chỉ có màu → size trống để báo đỏ");
  const q2detect = detectColumnsByContent([["06:15:01 2/9/2026", "A", "'0912020372", "x y z 1"], ["06:16:01 2/9/2026", "B", "'0379154475", "x y z 2"], ["06:17:01 2/9/2026", "C", "'0905774678", "x y z 3"]]);
  assert.equal(q2detect.phone, 2, "dò cột SĐT dù ô có dấu ' đầu");
  // Màu so theo từ: "Chuyển đổi mới" không được coi là "đỏ" (từng ghép nhầm M Đỏ điểm 7); Q002 có mẫu Đen → L Đen
  const q2cands = [
    { id: "q2-m-do", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "002 DO M", size: "M", color: "Đỏ" },
    { id: "q2-l-do", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "002 DO L", size: "L", color: "Đỏ" },
    { id: "q2-l-den", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "002 DEN L", size: "L", color: "Đen" },
    { id: "q2-xl-den", productId: "p2", productName: "Đầm Q002", productCode: "Q002", sku: "002 DEN XL", size: "XL", color: "Đen" },
  ];
  assert.equal(matchVariant({ product: "Q002", variant: "Nhóm quảng cáo Chuyển đổi mới", size: "", color: "" }, q2cands), null, "chữ rác không phải tín hiệu màu / size → không ghép");
  assert.equal(matchVariant({ product: "Q002", variant: "Size L | Màu Đen", size: "L", color: "Đen" }, q2cands)?.variant.id, "q2-l-den", "L Đen → đúng mẫu Đen, không phải Đỏ");
  assert.equal(matchVariant({ product: "Q002", variant: "Size XL | Màu Đen", size: "XL", color: "Đen" }, q2cands)?.variant.id, "q2-xl-den");
  assert.equal(matchVariant({ product: "Q002", variant: "Màu Đen", size: "", color: "Đen" }, q2cands), null, "chỉ có màu, 2 size Đen → chưa ghép, hỏi khách size");
  {
    // Bộ lọc mới trên trang landing: theo mã hàng (Q002 / Q003…) và theo trạng thái đơn POS (đã có / nháp / chưa lên)
    const allP: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };
    const landBase = { customerName: "Khách landing", address: "Q1", province: "HCM", productText: "", variantText: "", sizeText: "", colorText: "", quantity: 1, price: 499000, total: 499000, note: "", source: "", adId: null, sheetStatus: "", raw: {}, variantId: null, variantMatchScore: 0 };
    await db
      .insert(schema.landingOrders)
      .values([
        { rowKey: "tab:Q003:2", sheetGid: "tab:Q003", rowIndex: 2, submittedAt: new Date(), phone: "0900000001", status: "PUSHED", orderId: "rr-9001", ...landBase, productText: "Q003" },
        { rowKey: "tab:Q002:2", sheetGid: "tab:Q002", rowIndex: 2, submittedAt: new Date(), phone: "0900000002", status: "NEW", ...landBase, productText: "" },
      ])
      .onConflictDoNothing();
    const every = await listLandingOrders({ period: allP });
    assert.ok(every.some((r) => r.landingProductCode === "Q003" && r.posState === "HAS") && every.some((r) => r.landingProductCode === "Q002" && r.posState === "NONE"), "mã hàng suy ra từ cột sản phẩm hoặc tên tab; trạng thái POS theo đơn đã ghép");
    if (every.length) {
      const opts = await listLandingProductOptions(allP);
      assert.ok(opts.length >= 1, "có danh sách mã hàng để lọc");
      const code = opts[0].code;
      const byCode = await listLandingOrders({ period: allP, product: [code] });
      assert.ok(byCode.length === opts[0].count && byCode.every((r) => r.landingProductCode === code), `lọc mã ${code}: ${byCode.length} dòng`);
      const noPos = await listLandingOrders({ period: allP, pos: ["NONE"] });
      assert.ok(noPos.every((r) => !r.orderId && !r.pancakeSystemId && r.posState === "NONE"), "lọc Chưa lên POS đúng");
      const hasPos = await listLandingOrders({ period: allP, pos: ["HAS"] });
      assert.ok(hasPos.every((r) => r.orderId && r.posState === "HAS"), "lọc Đã có đơn POS đúng");
      const draft = await listLandingOrders({ period: allP, pos: ["DRAFT"] });
      assert.equal(noPos.length + hasPos.length + draft.length, every.length, "3 trạng thái POS phủ hết");
      console.log(`✓ Lọc landing: mã ${code} ${byCode.length} dòng · POS đã có ${hasPos.length} / nháp ${draft.length} / chưa ${noPos.length}`);
      // Ghép yếu (điểm 5, chỉ theo tên mã) trên dòng ĐÃ có đơn POS, nhưng ô gốc có "Size M,Màu Đỏ" → recheck ghép lại đúng mẫu RR-001 (M · Đỏ)
      await db.insert(schema.productVariants).values({ id: "rr-var-l", productId: "rr-prod", sku: "RR-001-L", color: "Đỏ", size: "L", retailPrice: 499000 }).onConflictDoNothing();
      await db
        .insert(schema.landingOrders)
        .values({ rowKey: "tab:RR:9", sheetGid: "tab:RR", rowIndex: 9, submittedAt: new Date(), phone: "0900000009", status: "PUSHED", orderId: "rr-9001", ...landBase, productText: "Đầm kiểm thử", variantId: "rr-var-l", variantMatchScore: 5, raw: { "Cột 1": "Khách", "Cột 2": "Size M,Màu  Đỏ", "Cột 3": "" } })
        .onConflictDoNothing();
      const rc = await recheckAllLanding(30);
      const fixed = await db.query.landingOrders.findFirst({ where: eq(schema.landingOrders.rowKey, "tab:RR:9") });
      assert.equal(fixed?.variantId, "rr-var", `ghép yếu có size thật → ghép lại đúng mẫu M Đỏ (recheck ${rc.rechecked} dòng)`);
      assert.equal(fixed?.sizeText, "M");
      assert.ok(Number(fixed?.variantMatchScore) > 5, "điểm ghép mới cao hơn ghép yếu");
    }
  }
  console.log("✓ Đơn landing page: CSV có / không tiêu đề, dò cột theo nội dung, SĐT, size/màu, gói giá, mã hàng từ chiến dịch, ad_id, ghép mẫu mã");

  console.log("\nTẤT CẢ KIỂM THỬ ĐẠT");
  process.exit(0);

}

main().catch((error) => {
  console.error("✗ Kiểm thử thất bại:", error);
  process.exit(1);
});
