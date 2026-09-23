import assert from "node:assert/strict";
import { clearMemo } from "@/lib/cache";
import { attributionShares } from "@/lib/constants/payroll";
import { chiaTheoCanCu, fallbackShares, finishCell, getMarketerDailyNominal, type NominalCell } from "@/lib/queries/marketer-daily-nominal";
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
  const base: NominalCell = { orders: 3, deliveredOrders: 1, returnedOrders: 1, openOrders: 1, posSales: 1_500_000, expectedRevenue: 900_000, expectedCogs: 300_000, shipCost: 90_000, opex: 50_000, inventoryRisk: 30_000, tax: 9_000, adSpend: null, messages: null, otherCost: null, expectedProfit: null, netProfit: null };
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
    ĐỐI CHIẾU VỚI BÁO CÁO ĐỌC ĐỦ TỒN KHO (giá vốn dự tính TẮT — khu quảng cáo không được thấy giá
    đoán, xem `tests/estimated-cost.test.ts`). Bảng MKTer tắt tồn kho cho nhanh; cặp khẳng định
    ngay dưới chứng minh việc ấy không đổi một đồng lợi nhuận nào.
  */
  const [data, report, noStock] = await Promise.all([
    getMarketerDailyNominal(ALL),
    getNominalProfitReport(ALL, "ORDERED", NO_ORDER_VALUE_FILTER, true, false),
    getNominalProfitReport(ALL, "ORDERED", NO_ORDER_VALUE_FILTER, true, false, false),
  ]);
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

export async function testMarketerDailyNominal() {
  testChiaTheoCanCu();
  testFallbackShares();
  testOrderDeliveryShare();
  testFinishCell();
  await testReconcilesWithNominalReport();
  console.log("✓ Bóc tách MKTer theo ngày: cộng mọi ô ra đúng Báo cáo lợi nhuận danh nghĩa");
}
