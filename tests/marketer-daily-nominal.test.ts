import assert from "node:assert/strict";
import { clearMemo } from "@/lib/cache";
import { attributionShares } from "@/lib/constants/payroll";
import { chiaTheoCanCu, fallbackShares, finishCell, getMarketerDailyNominal, getNominalDaily, NO_DAY, type NominalCell } from "@/lib/queries/marketer-daily-nominal";
import { MARKETING_UNATTRIBUTED } from "@/lib/constants/marketing-daily";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { orderDeliveryShare, type ProbabilityLookup } from "@/lib/queries/projected-delivery";
import { NOT_SHIPPED_STATE } from "@/lib/constants/projected-delivery";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ═══════════ CHIA KHÔNG ĐƯỢC LÀM RƠI MỘT ĐỒNG NÀO ═══════════
 *
 * Bảng ngày × MKTer chỉ đúng được một cách: cộng lại ra ĐÚNG số của Báo cáo lợi nhuận. Hàm chia là
 * chỗ duy nhất có thể làm rơi tiền — căn cứ toàn 0 (mọi đơn của mã đang ở trạng thái ngoài mô
 * hình) thì `distributeProportionally` trả về toàn 0 và khoản tiền biến mất khỏi bảng.
 */
function testChiaTheoCanCu() {
  const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
  assert.deepEqual(chiaTheoCanCu(100, [1, 1, 2]), [25, 25, 50]);
  // Căn cứ đầu toàn 0 ⇒ rơi sang căn cứ sau, KHÔNG trả về toàn 0.
  assert.deepEqual(chiaTheoCanCu(90, [0, 0, 0], [1, 2, 0]), [30, 60, 0]);
  // Hết căn cứ ⇒ chia đều. Tiền vẫn còn nguyên.
  assert.equal(sum(chiaTheoCanCu(1_001, [0, 0, 0], [0, 0, 0])), 1_001, "căn cứ nào cũng 0 thì vẫn phải giữ đủ tổng");
  // Largest remainder: số lẻ không lệch vì làm tròn từng phần.
  assert.equal(sum(chiaTheoCanCu(1_000_003, [1, 1, 1])), 1_000_003);
  // Khoản âm (hiếm, nhưng không được đổi dấu).
  assert.equal(sum(chiaTheoCanCu(-500, [1, 3])), -500);
  assert.deepEqual(chiaTheoCanCu(0, [1, 2]), [0, 0]);
}

/**
 * ═══════════ BẬC LÙI QUY KẾT CHỈ SỐNG Ở MỘT CHỖ ═══════════
 *
 * `fallbackShares` suy ngược phần "chia hộ" từ `attributionShares` thay vì viết lại bậc lùi. Bài
 * kiểm khoá phép suy ngược: gán được + chưa gán × phần chia hộ phải ra ĐÚNG tỷ trọng cả mã mà
 * bảng "Lợi nhuận danh nghĩa theo Marketer" đang dùng.
 */
function testFallbackShares() {
  const byPage = [
    { pageId: "p1", value: 600, adMarketerId: null, snapshotMarketerId: "an" },
    { pageId: "p2", value: 100, adMarketerId: null, snapshotMarketerId: "binh" },
    { pageId: null, value: 300, adMarketerId: null, snapshotMarketerId: null },
  ];
  const adShares = new Map<string | null, number>([
    ["an", 1_000],
    ["binh", 3_000],
  ]);
  const att = attributionShares({ byPage, pageMarketers: {}, adShares, ownerId: null });
  assert.equal(att.mode, "page");
  const mapped = new Map([
    ["an", 600],
    ["binh", 100],
  ]);
  const fb = fallbackShares(att.shares, mapped, 1_000, att.unmappedValue);
  // 300 chưa gán chia theo QC 1:3 ⇒ an 75, bình 225.
  assert.ok(Math.abs((fb.get("an") ?? 0) - 0.25) < 1e-9);
  assert.ok(Math.abs((fb.get("binh") ?? 0) - 0.75) < 1e-9);
  for (const [mid, sh] of att.shares) {
    const rebuilt = (mid ? (mapped.get(mid) ?? 0) : 0) + 300 * (fb.get(mid) ?? 0);
    assert.ok(Math.abs(rebuilt - sh * 1_000) < 1e-6, `${mid}: gán được + chia hộ phải ra đúng tỷ trọng cả mã`);
  }
  // Không page, không QC, không chủ mã ⇒ KHÔNG ai nhận — rỗng, để nơi gọi đưa vào "Chưa quy kết".
  const none = attributionShares({ byPage: [{ pageId: null, value: 50, adMarketerId: null }], pageMarketers: {}, adShares: new Map(), ownerId: null });
  assert.equal(fallbackShares(none.shares, new Map(), 50, none.unmappedValue).size, 0);
  // Chỉ có chủ mã ⇒ trọn về chủ mã.
  const owner = attributionShares({ byPage: [{ pageId: null, value: 50, adMarketerId: null }], pageMarketers: {}, adShares: new Map(), ownerId: "chu" });
  assert.equal(fallbackShares(owner.shares, new Map(), 50, owner.unmappedValue).get("chu"), 1);
}

/** Phần giao được của một đơn: đúng bảng phân loại của hợp đồng dự báo. */
function testOrderDeliveryShare() {
  const lookup = {
    of: (state: string) => ({ p: state === NOT_SHIPPED_STATE ? 0.4 : null, basis: "GLOBAL_STATE", confidence: "HIGH", sample: 100 }),
  } as unknown as ProbabilityLookup;
  const ctx = { productCode: null, ageHours: null };
  assert.equal(orderDeliveryShare({ outcome: "DELIVERED", con: "", ...ctx }, lookup), 1);
  assert.equal(orderDeliveryShare({ outcome: "RETURNED", con: "", ...ctx }, lookup), 0);
  assert.equal(orderDeliveryShare({ outcome: "RETURNED_BY_RULE", con: "", ...ctx }, lookup), 0);
  assert.equal(orderDeliveryShare({ outcome: "CANCELLED", con: "", ...ctx }, lookup), 0);
  // Hàng còn trong kho shop — chưa gửi hay đã có mã mà ĐVVC chưa cầm — cân bằng CÙNG một P(chưa rời kho).
  assert.equal(orderDeliveryShare({ outcome: "NOT_SHIPPED", con: "", ...ctx }, lookup), 0.4);
  assert.equal(orderDeliveryShare({ outcome: "AWAITING_PICKUP", con: "", ...ctx }, lookup), 0.4);
}

/**
 * ═══════════ QC CHƯA BIẾT ⇒ LỢI NHUẬN CHƯA BIẾT, KHÔNG PHẢI MỘT KHOẢN LÃI ═══════════
 *
 * AGENTS.md mục 67: marketer chưa được ghép chiến dịch nào in `0 ₫` chi quảng cáo là in một khoản
 * lãi không có thật cho họ, trong khi tiền thật nằm ở dòng "Chưa quy kết".
 */
function testFinishCell() {
  const base: NominalCell = { orders: 3, deliveredOrders: 1, returnedOrders: 1, openOrders: 1, posSales: 1_500_000, expectedRevenue: 900_000, expectedCogs: 300_000, expectedQty: 2, cogsUncoveredQty: 0, shipCost: 90_000, opex: 50_000, inventoryRisk: 30_000, tax: 9_000, adSpend: null, messages: null, otherCost: null, expectedProfit: null, netProfit: null, marketerPriceAdj: 0 };
  const unknown = finishCell(base, 0.05);
  assert.equal(unknown.expectedProfit, null, "QC chưa biết ⇒ LN danh nghĩa CHƯA BIẾT");
  assert.equal(unknown.netProfit, null, "QC chưa biết ⇒ LN ròng CHƯA BIẾT");
  const known = finishCell({ ...base, adSpend: 200_000 }, 0.05);
  assert.equal(known.otherCost, 10_000);
  assert.equal(known.expectedProfit, 900_000 - 300_000 - 90_000 - 200_000);
  assert.equal(known.netProfit, 310_000 - 50_000 - 30_000 - 9_000 - 10_000);
  // QC = 0 THẬT (đã đo, không chạy) vẫn là một con số.
  assert.equal(finishCell({ ...base, adSpend: 0 }, 0.05).expectedProfit, 510_000);
}

/**
 * ═══════════ CỘNG MỌI Ô RA ĐÚNG BÁO CÁO LỢI NHUẬN DANH NGHĨA ═══════════
 *
 * Đây là lý do bảng này tồn tại: chủ shop đòi số của từng MKT theo ĐÚNG logic Báo cáo lợi nhuận.
 * DT GTC ƯT và LN danh nghĩa phải khớp tới từng đồng; LN ròng chỉ được lệch phần làm tròn của
 * "CP khác = % QC" (báo cáo làm tròn mỗi mã, bảng này làm tròn mỗi ô) — và phải NHỎ.
 */
async function testReconcilesWithNominalReport() {
  clearMemo();
  /*
    ĐỐI CHIẾU VỚI ĐÚNG BỘ CỜ CỦA TAB "LỢI NHUẬN DANH NGHĨA" (giá vốn dự tính BẬT, tồn kho ĐỌC) —
    thứ chủ shop nhìn thấy (ngoại lệ chốt 23/09/2026, xem `tests/estimated-cost.test.ts`). Bảng
    MKTer tắt tồn kho cho nhanh; cặp khẳng định ngay dưới chứng minh việc ấy không đổi một đồng.
  */
  const [data, report, noStock] = await Promise.all([
    getMarketerDailyNominal(ALL),
    getNominalProfitReport(ALL, "ORDERED", NO_ORDER_VALUE_FILTER, true, true),
    getNominalProfitReport(ALL, "ORDERED", NO_ORDER_VALUE_FILTER, true, true, false),
  ]);
  // Phần dự tính phải được NÓI RA, không tan vào tổng giá vốn (AGENTS.md mục 8.6).
  assert.equal(data.estimatedCogs.amount, report.totals.expectedCogsEstimated, "phần giá vốn dự tính phải bằng đúng con số của tab");
  assert.equal(data.unknownCostQty, report.totals.cogsUncoveredQty, "số sản phẩm vẫn chưa có giá vốn nào phải bằng đúng tab");
  for (const k of ["expectedRevenue", "expectedCogs", "shipCost", "expectedProfit", "netProfit", "inventoryRisk", "tax"] as const) {
    assert.equal(noStock.totals[k], report.totals[k], `bỏ đọc tồn kho KHÔNG được đổi ${k} — tồn chỉ là ô ghi chú, không vào lợi nhuận`);
  }
  assert.ok(noStock.rows.every((r) => !r.stockKnown), "không đọc tồn ⇒ tồn là CHƯA BIẾT (stockKnown = false), không phải 0 cái");
  assert.ok(data.total.orders > 0, "fixture phải có đơn — nếu không, cổng này không kiểm được gì");
  assert.equal(data.reconcile.expectedRevenue.report, report.totals.expectedRevenue);
  assert.equal(data.reconcile.expectedRevenue.ours, report.totals.expectedRevenue, "Σ DT GTC ƯT mọi ô phải bằng ĐÚNG Báo cáo lợi nhuận");
  assert.equal(data.total.expectedRevenue, report.totals.expectedRevenue);
  assert.equal(data.total.expectedCogs, report.totals.expectedCogs, "giá vốn ƯT");
  assert.equal(data.total.shipCost, report.totals.shipCost, "cước ƯT");
  assert.equal(data.total.posSales, report.totals.grossSales, "doanh số POS");
  assert.equal(data.reconcile.expectedProfit.ours, report.totals.expectedProfit, "LN danh nghĩa phải bằng ĐÚNG Báo cáo lợi nhuận");
  const tolerance = data.days.length + report.rows.length + 1;
  assert.ok(Math.abs(data.reconcile.netProfit.ours - report.totals.netProfit) <= tolerance, `LN ròng chỉ được lệch phần làm tròn CP khác: ${data.reconcile.netProfit.ours} vs ${report.totals.netProfit}`);

  // Σ các MKTer = tổng shop; Σ các ngày của một MKTer = cột tổng của họ.
  const sumBy = (pick: (c: NominalCell) => number) => data.marketers.reduce((t, m) => t + pick(m.total), 0);
  assert.equal(sumBy((c) => c.expectedRevenue), data.total.expectedRevenue, "Σ MKTer = tổng shop (DT ƯT)");
  assert.ok(Math.abs(sumBy((c) => c.orders) - data.total.orders) < 1e-6, "Σ MKTer = tổng shop (đơn)");
  for (const m of data.marketers) {
    const days = data.days.map((d) => d.cells[m.key]).filter((c): c is NominalCell => Boolean(c));
    assert.equal(days.reduce((t, c) => t + c.expectedRevenue, 0), m.total.expectedRevenue, `${m.label}: Σ ngày = cả kỳ`);
    for (const c of days) if (c.adSpend === null) assert.equal(c.netProfit, null, `${m.label}: QC chưa biết thì lợi nhuận phải CHƯA BIẾT`);
    if (!m.spendMapped) assert.equal(m.total.adSpend, null, `${m.label}: chưa ghép chiến dịch nào ⇒ Chi QC là CHƯA BIẾT, không phải 0`);
  }
  // Một đơn nhiều mã vẫn là MỘT đơn: tổng đơn phải là số nguyên.
  assert.ok(Math.abs(data.total.orders - Math.round(data.total.orders)) < 1e-6, "tổng đơn của shop phải là số nguyên");
  // Mới nhất đứng đầu.
  for (let i = 1; i < data.days.length; i += 1) assert.ok(data.days[i - 1].day > data.days[i].day, "ngày mới nhất phải ở trên cùng");
}

/**
 * ═══════════ LỢI NHUẬN DANH NGHĨA THEO NGÀY: LỌC LÀ CỘNG Ô, KHÔNG PHẢI TÍNH LẠI ═══════════
 *
 * Chủ shop (25/09/2026) muốn xem BCLN danh nghĩa theo ngày, lọc riêng từng mã và từng MKT. Bảng
 * theo ngày cũ của một mã nhân doanh số của ngày với MỘT tỷ lệ phẳng — cộng các ngày lại KHÔNG ra
 * dòng của mã trên cùng trang. Bảng mới chỉ cộng các ô (ngày × MKTer × mã), nên:
 *
 *     lọc một mã     Σ ngày = ĐÚNG dòng của mã trên bảng theo mã (tới từng đồng)
 *     lọc một MKTer  Σ ngày = ĐÚNG cột của người đó ở bảng ngày × MKTer
 *     không lọc      Σ ngày = dòng tổng của Báo cáo lợi nhuận
 */
async function testNominalDailyFilters() {
  clearMemo();
  const [all, report, byMkt] = await Promise.all([
    getNominalDaily(ALL, "ORDERED", { productId: null, marketerKey: null }),
    getNominalProfitReport(ALL, "ORDERED", NO_ORDER_VALUE_FILTER, true, true),
    getMarketerDailyNominal(ALL),
  ]);
  assert.ok(all.days.length > 0 && all.products.length > 0 && all.marketers.length > 0, "fixture phải có ngày, mã và MKTer — nếu không, cổng này không kiểm được gì");
  assert.equal(all.total.expectedRevenue, report.totals.expectedRevenue, "không lọc: Σ DT GTC ƯT = tổng báo cáo");
  assert.equal(all.total.expectedCogs, report.totals.expectedCogs, "không lọc: giá vốn THẬT, không phải giá báo MKT");
  assert.ok(all.reconcile, "không lọc phải có dòng đối chiếu");
  assert.equal(all.reconcile.expectedProfit.ours, all.reconcile.expectedProfit.report, "không lọc: LN danh nghĩa khớp báo cáo tới từng đồng");
  for (let i = 1; i < all.days.length; i += 1) assert.ok(all.days[i - 1].day > all.days[i].day, "ngày mới nhất phải ở trên cùng");

  /* ─── Lọc từng mã: Σ ngày = ĐÚNG dòng của mã ─── */
  let sumRev = 0;
  for (const row of report.rows.filter((r) => r.orders > 0 || r.adSpend > 0)) {
    const d = await getNominalDaily(ALL, "ORDERED", { productId: row.productId, marketerKey: null });
    const ten = row.code || row.productName;
    assert.equal(d.total.expectedRevenue, row.expectedRevenue, `${ten}: Σ ngày DT GTC ƯT = dòng của mã`);
    assert.equal(d.total.expectedCogs, row.expectedCogs, `${ten}: Σ ngày giá vốn = dòng của mã (giá vốn thật)`);
    assert.equal(d.total.shipCost, row.shipCost, `${ten}: Σ ngày cước = dòng của mã`);
    assert.equal(d.total.posSales, row.grossSales, `${ten}: Σ ngày doanh số POS = dòng của mã`);
    assert.equal(d.total.expectedQty, Math.round(row.expectedQty), `${ten}: Σ ngày SP giao TC ƯT = dòng của mã`);
    // Một đơn hai mã là một đơn của MỖI mã — bảng theo mã đếm như vậy, lọc mã phải ra đúng số ấy (không lẻ).
    assert.ok(Math.abs(d.total.orders - row.orders) < 1e-6, `${ten}: Σ ngày số đơn = dòng của mã (${d.total.orders} vs ${row.orders})`);
    assert.ok(d.reconcile, `${ten}: lọc mã phải đối chiếu với dòng của mã`);
    assert.equal(d.reconcile.expectedProfit.ours, row.expectedProfit, `${ten}: LN danh nghĩa = dòng của mã — Chi QC lấy đúng phần đã ghép vào mã`);
    assert.ok(Math.abs(d.reconcile.netProfit.ours - row.netProfit) <= d.days.length + 1, `${ten}: LN ròng chỉ được lệch phần làm tròn CP khác (${d.reconcile.netProfit.ours} vs ${row.netProfit})`);
    sumRev += d.total.expectedRevenue;
  }
  assert.equal(sumRev, report.totals.expectedRevenue, "Σ mọi mã = tổng báo cáo");

  /* ─── Lọc từng MKTer: Σ ngày = cột của người đó ở bảng ngày × MKTer ─── */
  for (const col of byMkt.marketers) {
    const d = await getNominalDaily(ALL, "ORDERED", { productId: null, marketerKey: col.key });
    assert.equal(d.reconcile, null, `${col.label}: không có dòng nào trên bảng theo mã để đối chiếu`);
    assert.equal(d.total.expectedRevenue, col.total.expectedRevenue, `${col.label}: DT GTC ƯT = cột MKTer`);
    assert.equal(d.total.expectedCogs, col.total.expectedCogs, `${col.label}: giá vốn (theo giá báo MKT) = cột MKTer`);
    assert.equal(d.total.adSpend, col.total.adSpend, `${col.label}: Chi QC = cột MKTer (null khi chưa ghép chiến dịch)`);
    assert.equal(d.total.netProfit, col.total.netProfit, `${col.label}: LN ròng = cột MKTer`);
    assert.equal(d.marketerPriceCogs, col.key !== MARKETING_UNATTRIBUTED, `${col.label}: chỉ ô của một MKT mang giá báo`);
    if (!col.spendMapped) assert.ok(d.days.every((x) => x.cell.adSpend === null && x.cell.netProfit === null), `${col.label}: chưa ghép chiến dịch ⇒ Chi QC và LN là CHƯA BIẾT mỗi ngày, không phải 0`);
  }

  /* ─── Lọc cả hai: Σ các MKTer trên một mã = mã đó ─── */
  const ma = all.products[0].value;
  const motMa = await getNominalDaily(ALL, "ORDERED", { productId: ma, marketerKey: null });
  let tong = 0;
  for (const m of all.marketers) tong += (await getNominalDaily(ALL, "ORDERED", { productId: ma, marketerKey: m.value })).total.expectedRevenue;
  assert.equal(tong, motMa.total.expectedRevenue, "Σ (mã × từng MKTer) = mã đó");

  /* ─── Đi theo MỐC của tab: bảng ngày và bảng theo mã đứng trên cùng tập đơn ─── */
  const [giao, reportGiao] = await Promise.all([
    getNominalDaily(ALL, "SHIPPED", { productId: null, marketerKey: null }),
    getNominalProfitReport(ALL, "SHIPPED", NO_ORDER_VALUE_FILTER, true, true),
  ]);
  assert.equal(giao.total.expectedRevenue, reportGiao.totals.expectedRevenue, "mốc ngày gửi: Σ ngày = tổng báo cáo cùng mốc");
  assert.equal(giao.total.posSales, reportGiao.totals.grossSales, "mốc ngày gửi: doanh số POS khớp");
  const noDay = giao.days.findIndex((x) => x.day === NO_DAY);
  assert.ok(noDay === -1 || noDay === giao.days.length - 1, "dòng “Chưa có mốc” đứng cuối, không lẫn vào các ngày");
  assert.ok(giao.days.filter((x) => x.day === NO_DAY).every((x) => x.cell.adSpend === null || x.cell.adSpend === 0), "đơn chưa có mốc không có ngày chi QC nào để ghép");
}

export async function testMarketerDailyNominal() {
  testChiaTheoCanCu();
  testFallbackShares();
  testOrderDeliveryShare();
  testFinishCell();
  await testReconcilesWithNominalReport();
  await testNominalDailyFilters();
  console.log("✓ Bóc tách MKTer theo ngày: cộng mọi ô ra đúng Báo cáo lợi nhuận danh nghĩa · LN theo ngày lọc mã = dòng của mã, lọc MKTer = cột của người đó");
}
