/**
 * ═══════ CƯỚC THEO GHI NHẬN VIETTEL POST + LỊCH CƯỚC ƯỚC TÍNH THEO KHOẢNG THỜI GIAN (chủ shop 21/10/2026) ═══════
 *
 *  · lịch cước: mốc có hiệu lực TỪ ngày của nó tới trước mốc kế tiếp; trước mốc đầu ⇒ ô chung; kỳ vắt qua mốc
 *    ⇒ bình quân theo số ngày; mốc hỏng / trùng ngày bị bỏ;
 *  · một vận đơn: có cước Viettel Post ⇒ ĐÚNG số ấy; có vận đơn mà chưa có cước ⇒ lịch cước tại ngày lên đơn
 *    (KHÔNG lấy partner_fee của Pancake); không vận đơn, không cước đối tác ⇒ 0 (không bịa cước);
 *  · cơ sở lương và máy chi phí cùng một con số; bảng đối soát tách bảng kê · VTP chưa bảng kê · ước tính.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DEFAULT_PROFIT_ASSUMPTIONS, PROFIT_ASSUMPTIONS_KEY, shipFeeScheduleOf, shipFeesAt, shipFeesForPeriod, type ProfitAssumptions } from "@/lib/constants/profit";
import { buildMonthReconciliation } from "@/lib/payroll/profit-reconciliation";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getMonthReconciliation } from "@/lib/queries/payroll-reconciliation";
import { getPayrollReport, monthReportPeriod } from "@/lib/queries/payroll";
import { shipmentCostSql } from "@/lib/queries/shipping-cost";
import { getSettingJson, setSettingJson } from "@/lib/settings";

function testPure() {
  const base = { delivered: 17_000, returned: 34_000 };
  const lich = shipFeeScheduleOf({
    shipFeeSchedule: [
      { from: "2026-10-15", shipFeeDelivered: 15_000, shipFeeReturned: null, note: "VTP giảm giá theo sản lượng" },
      { from: "2026-09-01", shipFeeDelivered: 16_000, shipFeeReturned: 30_000, note: "hợp đồng mới" },
      { from: "khong-phai-ngay", shipFeeDelivered: 1, shipFeeReturned: null, note: "hỏng" },
      { from: "2026-12-01", shipFeeDelivered: -5, shipFeeReturned: null, note: "âm" },
    ],
  });
  assert.deepEqual(lich.map((x) => x.from), ["2026-09-01", "2026-10-15"], "xếp tăng theo ngày, bỏ mốc hỏng / âm");
  assert.deepEqual(shipFeesAt(base, lich, "2026-08-31"), { ...base, from: null }, "trước mốc đầu ⇒ ô chung");
  assert.equal(shipFeesAt(base, lich, "2026-09-01").delivered, 16_000, "đúng ngày hiệu lực ⇒ mốc ấy");
  assert.equal(shipFeesAt(base, lich, "2026-10-14").delivered, 16_000, "trước mốc kế tiếp một ngày ⇒ vẫn mốc cũ");
  assert.equal(shipFeesAt(base, lich, "2026-10-15").delivered, 15_000);
  assert.equal(shipFeesAt(base, lich, "2026-10-15").returned, 30_000, "cước hoàn để trống ⇒ cước gửi + phí hoàn về (không dữ liệu ⇒ gấp đôi)");
  assert.equal(shipFeesAt(base, lich, "2026-10-15", 9_000).returned, 24_000, "có phí hoàn về bình quân ⇒ cước gửi + phí ấy");
  // Tháng 10: 14 ngày 16.000 + 17 ngày 15.000 ⇒ bình quân theo NGÀY.
  assert.equal(shipFeesForPeriod(base, lich, "2026-10-01", "2026-10-31").delivered, Math.round((14 * 16_000 + 17 * 15_000) / 31));
  assert.equal(shipFeesForPeriod(base, lich, "2026-08-01", "2026-08-31").delivered, 17_000, "kỳ trước mọi mốc ⇒ ô chung");
  assert.equal(shipFeesForPeriod(base, [], "2026-10-01", "2026-10-31").delivered, 17_000, "không có lịch ⇒ y như trước");
  assert.equal(shipFeesForPeriod(base, lich, null, null).delivered, 15_000, "kỳ toàn bộ ⇒ mốc đang hiệu lực");
  const dup = shipFeeScheduleOf({ shipFeeSchedule: [{ from: "2026-09-01", shipFeeDelivered: 1, shipFeeReturned: null, note: "a" }, { from: "2026-09-01", shipFeeDelivered: 2, shipFeeReturned: null, note: "b" }] });
  assert.equal(dup.length, 1, "trùng ngày ⇒ một mốc");

  // Bảng đối soát: VTP chưa có bảng kê ⇒ CHƯA đối soát; chỉ ước tính ⇒ ƯỚC TÍNH.
  const goc = (o: Partial<Parameters<typeof buildMonthReconciliation>[0]["orders"]>) =>
    buildMonthReconciliation(
      {
        monthKey: "2031-04",
        basis: { revenue: 1_000_000, cogs: 0, adsCode: 0, adsTest: 0, adsCodeInPersonLines: 0, shippingPerShipment: 40_000, returnLegToCodes: 0, returnLegShared: 0, logisticsAdjustment: 0, logisticsAdjustmentUnallocated: 0, operatingEntered: 0, fixedCostAssumption: 0, perOrderOpsEstimate: 0, sharedUnallocated: 0, profit: 0, basisExclusionMeasured: 0, basisExclusionEstimated: 0 },
        adsRaw: { codeWithMarketer: 0, codeNoMarketer: 0, testWithMarketer: 0, testNoMarketer: 0 },
        engine: { cogs: 0, ads: 0, shipping: 40_000, returnCost: 0, operatingTotal: 0 },
        orders: { deliveredRevenue: 1_000_000, deliveredRevenueNoProduct: 0, deliveredRevenueWithMoney: 1_000_000, deliveredOrders: 2, deliveredOrdersWithMoney: 2, openOrders: 0, openValue: 0, settledValue: 1_000_000, returnedOrders: 0, cancelledOrders: 0, unknownCostLines: 0, unknownCostRevenue: 0, cogsNoProduct: 0, inTransitShipping: 0, sentOrders: 2, sentNoFeeOrders: 0, shipOnStatementOrders: 2, shipOnStatement: 40_000, shipVtpOnlyOrders: 0, shipVtpOnly: 0, shipEstimatedOrders: 0, shipEstimated: 0, ...o },
        costWarnings: [],
        codes: [],
      },
      "q",
    );
  const dong = (rc: ReturnType<typeof goc>, k: string) => rc.lines.find((l) => l.key === k);
  assert.equal(dong(goc({}), "shipping-billing")?.status, "MATCHED", "mọi cước đã nằm trong bảng kê ⇒ đối soát xong");
  const chuaBangKe = goc({ shipOnStatementOrders: 1, shipOnStatement: 20_000, shipVtpOnlyOrders: 1, shipVtpOnly: 20_000 });
  assert.equal(dong(chuaBangKe, "shipping-billing")?.status, "UNRECONCILED", "VTP ghi nhận mà chưa có bảng kê ⇒ CHƯA đối soát cùng COD");
  assert.ok(chuaBangKe.issues.some((i) => i.code === "shipping-billing" && i.count === 1 && i.amount === 20_000));
  const uocTinh = goc({ shipOnStatementOrders: 1, shipOnStatement: 23_000, shipEstimatedOrders: 1, shipEstimated: 17_000 });
  assert.equal(dong(uocTinh, "shipping-billing")?.status, "ESTIMATED");
  assert.equal(dong(uocTinh, "shipping")?.status, "ESTIMATED", "hai vế dùng cùng biểu thức ⇒ khớp không chứng minh được cước thật — có ước tính thì ghi ƯỚC TÍNH");
}

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);

async function reset(db: Db) {
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'sc-%'`);
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'sc-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'sc-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'sc-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'sc-%'`);
  clearMemo();
}

async function testFlow(db: Db) {
  const truoc = await getSettingJson<ProfitAssumptions | null>(PROFIT_ASSUMPTIONS_KEY, null);
  await reset(db);
  try {
    // Ô chung đặt tay 17.000 + một mốc từ 15/04/2031: 15.000.
    await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...DEFAULT_PROFIT_ASSUMPTIONS, ...(truoc ?? {}), shipFeeDelivered: 17_000, shipFeeReturned: 34_000, shipFeeExplicitZero: true, shipFeeSchedule: [{ from: "2031-04-15", shipFeeDelivered: 15_000, shipFeeReturned: null, note: "VTP giảm giá theo sản lượng" }] });
    clearMemo();
    await db.insert(schema.products).values({ id: "sc-prod", name: "Mã cước", customId: "SC-A" });
    await db.insert(schema.productVariants).values({ id: "sc-var", productId: "sc-prod", sku: "SC-A", detail: "mặc định" });
    const don = async (id: string, ngay: string, partnerFee: number, ship: { fee: number; statement?: boolean } | null) => {
      await db.insert(schema.orders).values({ id, insertedAt: d(ngay), stage: "DELIVERED", status: 3, totalPriceAfterDiscount: 300_000, partnerFee, returnFee: 0, cod: 300_000 });
      await db.insert(schema.orderItems).values({ id: `${id}-i`, orderId: id, variantId: "sc-var", productId: "sc-prod", productName: "Mã cước", quantity: 1, lineTotal: 300_000, unitCost: 100_000, isBonus: false });
      if (ship) await db.insert(schema.shipments).values({ id: `${id}-s`, orderId: id, vtpOrderNumber: `SC${id.replace(/\D/g, "").padStart(10, "0")}`, stage: "DELIVERED", shippingFee: ship.fee, codAmount: 300_000, codCollected: 300_000, codStatus: "RECONCILED", deliveredAt: d(ngay), codStatementRef: ship.statement ? "BK-SC-1" : null });
    };
    await don("sc-o1", "2031-04-05", 25_000, { fee: 21_000, statement: true }); // cước VTP, có bảng kê
    await don("sc-o2", "2031-04-06", 25_000, { fee: 0 }); // có vận đơn, chưa có cước ⇒ ô chung 17.000 (KHÔNG 25.000 Pancake)
    await don("sc-o3", "2031-04-20", 0, { fee: 0 }); // sau mốc 15/04 ⇒ 15.000
    await don("sc-o4", "2031-04-21", 0, { fee: 19_000 }); // cước VTP, CHƯA có bảng kê
    await don("sc-o5", "2031-04-22", 0, null); // không vận đơn, không cước đối tác ⇒ 0
    clearMemo();

    const { fee, estimated } = await shipmentCostSql();
    const rows = await db
      .select({ id: schema.orders.id, fee: sql<number>`${fee}`, est: sql<number>`${estimated}` })
      .from(schema.orders)
      .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id}`)
      .where(sql`${schema.orders.id} like 'sc-o%'`);
    const by = new Map(rows.map((r) => [r.id, { fee: Number(r.fee), est: Number(r.est) }]));
    assert.deepEqual(by.get("sc-o1"), { fee: 21_000, est: 0 }, "có cước Viettel Post ⇒ đúng số ấy");
    assert.deepEqual(by.get("sc-o2"), { fee: 17_000, est: 17_000 }, "chưa có cước VTP ⇒ lịch cước (ô chung trước mốc), KHÔNG lấy 25.000 của Pancake");
    assert.deepEqual(by.get("sc-o3"), { fee: 15_000, est: 15_000 }, "lên đơn sau mốc 15/04 ⇒ cước của mốc");
    assert.deepEqual(by.get("sc-o4"), { fee: 19_000, est: 0 });
    assert.deepEqual(by.get("sc-o5"), { fee: 0, est: 0 }, "không vận đơn, không cước đối tác ⇒ 0 (không bịa cước)");

    const ky = monthReportPeriod("2031-04");
    const engine = await getRecognizedCosts(ky);
    const tong = 21_000 + 17_000 + 15_000 + 19_000;
    assert.equal(engine.components.SHIPPING.amount, tong, "máy chi phí: cước theo ghi nhận VTP + ước tính, không cước Pancake");
    assert.deepEqual(engine.shippingEstimate, { amount: 32_000, orders: 2 }, "máy chi phí nêu riêng phần ước tính");
    const r = await getPayrollReport(ky, "profit1");
    const a = r.marketers.products.find((p) => p.productId === "sc-prod");
    assert.equal(a?.shipping, tong, "cơ sở lương = máy chi phí (cùng một biểu thức)");
    const rc = await getMonthReconciliation("2031-04", { report: r });
    const bill = rc.lines.find((l) => l.key === "shipping-billing");
    assert.equal(bill?.source, 21_000, "chỉ cước đã nằm trong bảng kê là đã đối soát cùng COD");
    assert.equal(bill?.status, "UNRECONCILED", "sc-o4 có cước VTP mà chưa có bảng kê");
    assert.equal(rc.lines.find((l) => l.key === "shipping")?.status, "ESTIMATED", "có kiện tính cước ước tính");
  } finally {
    await reset(db);
    if (truoc === null) await db.delete(schema.settings).where(sql`${schema.settings.key} = ${PROFIT_ASSUMPTIONS_KEY}`);
    else await setSettingJson(PROFIT_ASSUMPTIONS_KEY, truoc);
    clearMemo();
  }
}

function testSource() {
  const action = readFileSync("lib/actions/report-settings.ts", "utf8");
  assert.ok(action.includes("shipFeeSchedule: z"), "lược đồ lưu giả định PHẢI nhận shipFeeSchedule — zod bỏ trường lạ ⇒ thiếu là mỗi lần Lưu xoá sạch lịch cước");
  const cost = readFileSync("lib/queries/shipping-cost.ts", "utf8");
  // Cước Pancake chỉ xuất hiện đúng MỘT lần, và lần ấy là DẤU HIỆU "có gửi qua ĐVVC" (so > 0), không phải số tiền.
  assert.equal(cost.split("${o.partnerFee}").length - 1, 1, "partner_fee của Pancake chỉ được dùng ở đúng một chỗ");
  assert.ok(cost.includes("coalesce(${o.partnerFee}, 0) > 0"), "và chỗ ấy chỉ hỏi 'có cước đối tác không', không lấy làm cước");
  for (const f of ["lib/queries/payroll.ts", "lib/queries/payroll-reconciliation.ts", "lib/queries/cost-engine.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}"), `${f}: không còn tự lùi về cước Pancake — dùng shipmentCostSql()`);
    assert.ok(src.includes("shipmentCostSql()"), `${f}: cước đi qua biểu thức chung`);
  }
}

export async function testShippingCost(db?: Db) {
  testPure();
  testSource();
  await testFlow(db ?? (await getDb()));
  console.log("✓ Cước theo ghi nhận Viettel Post: lịch cước ước tính theo khoảng thời gian (mốc · trước mốc · bình quân theo ngày) · có cước VTP ⇒ đúng số ấy · chưa có ⇒ lịch cước, KHÔNG cước Pancake · không vận đơn ⇒ 0 · lương = máy chi phí · đối soát cước cùng bảng kê COD");
}
