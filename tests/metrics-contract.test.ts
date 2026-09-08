import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CONFIRMED_ORDER, COUNT_DELIVERED, DELIVERED_COGS, DELIVERED_REVENUE, POPULATION_LABEL, averageOrderValue, metricScope, successRate } from "@/lib/queries/metrics";
import { getDashboardData } from "@/lib/queries/dashboard";
import { getReturnRateSummary } from "@/lib/queries/return-rate";
import { adOrdersFromErp } from "@/lib/queries/expenses";
import type { Period } from "@/lib/search-params";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * HỢP ĐỒNG CHỈ SỐ — docs/metrics-contract.md.
 *
 * Bất biến duy nhất phải khoá: cùng chỉ số + cùng kỳ + cùng bộ lọc ⇒ cùng con số. Và hai
 * population không được dùng lẫn trong cùng một phép tính.
 */
export async function testMetricsContract(db: Db) {
  clearMemo();

  // ───────── 1. Hàm tỷ lệ: mẫu số 0 là CHƯA BIẾT, không phải 0% ─────────
  assert.equal(successRate(0, 0), null, "chưa có đơn nào kết thúc thì GTC là null, hiển thị '—'");
  assert.equal(successRate(1, 0), 100);
  assert.equal(successRate(0, 3), 0, "kết thúc mà hoàn hết thì đúng là 0%");
  assert.equal(successRate(7, 3), 70);
  assert.equal(averageOrderValue(0, 0), 0);
  assert.equal(averageOrderValue(1_000_000, 3), 333_333, "tiền VND làm tròn về số nguyên");
  assert.ok(POPULATION_LABEL.confirmed && POPULATION_LABEL.reportable);

  // ───────── 2. Doanh thu và giá vốn của đơn giao thành công phải CÙNG population ─────────
  //
  // Đây là F4: Tổng quan từng lấy doanh thu theo tập đơn đã xác nhận nhưng giá vốn theo tập rộng
  // hơn, nên lợi nhuận ước tính lệch. Kiểm tra bằng cách tính lại bằng chính bộ lọc chuẩn.
  const [truth] = await db
    .select({ revenue: DELIVERED_REVENUE, cogs: DELIVERED_COGS, delivered: COUNT_DELIVERED })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(metricScope(ALL, "confirmed"));

  const dash = await getDashboardData(ALL);
  assert.equal(dash.kpi.successRevenue, Number(truth.revenue), "doanh thu giao thành công trên Tổng quan phải bằng định nghĩa chuẩn");
  assert.equal(dash.kpi.successCogs, Number(truth.cogs), "giá vốn giao thành công phải bằng định nghĩa chuẩn");
  assert.equal(dash.finance.successCogs, dash.kpi.successCogs, "lợi nhuận ước tính phải dùng CHÍNH con số giá vốn đó, không tính lại bằng bộ lọc khác");
  assert.equal(dash.kpi.successOrders, Number(truth.delivered));

  // Giá vốn không bao giờ được vượt doanh thu của cùng tập đơn — dấu hiệu kinh điển của lệch population.
  assert.ok(dash.kpi.successCogs <= dash.kpi.successRevenue, "giá vốn của đơn giao thành công không được lớn hơn doanh thu của chính chúng");

  // Lợi nhuận ước tính đúng bằng công thức ghi trong hợp đồng chỉ số.
  const expectedProfit =
    dash.finance.netRevenue - dash.finance.successCogs - dash.finance.shipping - dash.finance.returnFee - dash.finance.adSpend - dash.finance.expenses;
  assert.equal(dash.finance.estimatedProfit, expectedProfit, "lợi nhuận ước tính phải đúng công thức trong docs/metrics-contract.md");

  // ───────── 3. Hai population phải THẬT SỰ khác nhau và ai dùng cái nào phải nhất quán ─────────
  const [confirmedCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(CONFIRMED_ORDER);
  const [reportableCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(sql`${schema.orders.stage} <> 'NEW'`);
  assert.ok(Number(reportableCount.n) >= Number(confirmedCount.n), "phạm vi báo cáo phải rộng hơn hoặc bằng phạm vi đơn đã xác nhận");

  // ───────── 4. Cùng chỉ số + cùng kỳ ⇒ cùng con số ở mọi màn hình ─────────
  const gtc = await getReturnRateSummary(ALL, "");
  const ads = await adOrdersFromErp(null, null);
  assert.equal(ads.delivered, gtc.delivered, "số đơn giao thành công phải khớp giữa Marketing và báo cáo GTC");
  assert.equal(
    dash.kpi.successRate,
    gtc.successRate === null ? null : Math.round(gtc.successRate * 10) / 10,
    "GTC trên Tổng quan phải bằng GTC của báo cáo",
  );

  // Gọi lại lần nữa (qua cache) vẫn ra đúng con số cũ — chỉ số phải xác định.
  const again = await getDashboardData(ALL);
  assert.equal(again.kpi.successRevenue, dash.kpi.successRevenue);
  assert.equal(again.kpi.successRate, dash.kpi.successRate);

  // ───────── 4b. BUỒNG LÁI: ba con số tiền phải là BA con số, và phải lấy từ đúng nơi ─────────
  const { getFinancialTruth } = await import("@/lib/queries/financial-truth");
  const financial = await getFinancialTruth(ALL);
  assert.equal(dash.money.booked, financial.revenue.booked, "Tổng quan phải lấy doanh thu lên đơn từ lớp chân lý tài chính");
  assert.equal(dash.money.delivered, financial.revenue.delivered, "…và doanh thu giao thành công");
  assert.equal(dash.money.cashReceived, financial.cash.total, "…và tiền thực nhận");
  assert.equal(dash.money.contribution, financial.contribution, "…và lợi nhuận góp");
  assert.ok(dash.money.booked >= dash.money.delivered, "doanh thu lên đơn ≥ doanh thu giao thành công");
  assert.notEqual(dash.money.delivered, dash.money.cashReceived, "giao thành công và thực nhận là hai con số khác nhau");
  assert.equal(dash.money.delivered, dash.kpi.successRevenue, "hai chỗ trên cùng trang Tổng quan không được lệch nhau");
  // Số vi phạm nghiêm trọng lấy từ chính trung tâm điều khiển, không đếm lại.
  const { getControlTower } = await import("@/lib/queries/control-tower");
  const tower = await getControlTower();
  assert.equal(dash.dataIssues.critical, tower.totals.ERROR, "Tổng quan phải lấy số vi phạm nghiêm trọng từ trung tâm điều khiển");
  assert.equal(dash.dataIssues.ruleCount, tower.ruleCount);

  // ───────── 4B. HAI TỶ LỆ QUẢNG CÁO: cùng khoảng, mẫu số KHÁC NHAU, mẫu số 0 ⇒ null ─────────
  //
  // Hai chỉ số này rất dễ bị dùng lẫn: doanh số POS là tiền ĐÃ LÊN ĐƠN, doanh thu giao thành công
  // là tiền THỰC SỰ tới tay khách. Thay mẫu số cho nhau là báo sai hiệu quả quảng cáo.
  clearMemo();
  const profit = await getNominalProfitReport(ALL);
  const pt = profit.totals;
  const kyVong = (tu: number, mau: number) => (mau > 0 ? (tu / mau) * 100 : null);
  assert.equal(pt.adsOverPosSales, kyVong(pt.adSpend, pt.salesAfterDiscount), "QC/Doanh số POS = chi quảng cáo ÷ doanh số POS");
  assert.equal(pt.adsOverDeliveredRevenue, kyVong(pt.adSpend, pt.actualRevenue), "QC/DT giao thành công = chi quảng cáo ÷ doanh thu đã giao");
  // Chỉ so khi TỬ SỐ khác 0: chi quảng cáo bằng 0 thì cả hai tỷ lệ đều đúng bằng 0, không mâu thuẫn.
  if (pt.adSpend > 0 && pt.salesAfterDiscount > 0 && pt.actualRevenue > 0 && pt.salesAfterDiscount !== pt.actualRevenue) {
    assert.notEqual(pt.adsOverPosSales, pt.adsOverDeliveredRevenue, "hai tỷ lệ có mẫu số khác nhau thì KHÔNG được ra cùng một số");
  }
  // Mẫu số 0 phải trả null để màn hình hiện "—", tuyệt đối không hiện vô cực.
  assert.equal(kyVong(1_000_000, 0), null, "mẫu số 0 ⇒ null, không phải Infinity");
  assert.ok(pt.adsOverPosSales === null || Number.isFinite(pt.adsOverPosSales), "tỷ lệ phải là số hữu hạn hoặc null");
  assert.ok(pt.adsOverDeliveredRevenue === null || Number.isFinite(pt.adsOverDeliveredRevenue), "tỷ lệ phải là số hữu hạn hoặc null");
  // Chạy lại cùng kỳ phải ra CÙNG con số — chỉ số không được phụ thuộc thứ tự gọi hay cache.
  clearMemo();
  const profit2 = await getNominalProfitReport(ALL);
  assert.equal(profit2.totals.adsOverPosSales, pt.adsOverPosSales, "cùng kỳ ⇒ cùng số");
  assert.equal(profit2.totals.adsOverDeliveredRevenue, pt.adsOverDeliveredRevenue, "cùng kỳ ⇒ cùng số");
  assert.equal(profit2.totals.operatingExpenses, pt.operatingExpenses, "chi phí vận hành đã phân bổ cũng phải xác định");

  // ───────── 5. Hợp đồng phải tồn tại và trỏ đúng nơi cài đặt ─────────
  const contract = readFileSync("docs/metrics-contract.md", "utf8");
  for (const needed of ["bookedRevenue", "deliveredRevenue", "cashReceived", "successRate", "deliveredCogs", "lib/queries/metrics.ts"]) {
    assert.ok(contract.includes(needed), `hợp đồng chỉ số phải định nghĩa ${needed}`);
  }
  assert.ok(contract.includes("cùng bộ lọc"), "hợp đồng phải nêu bất biến 'cùng chỉ số + cùng kỳ + cùng bộ lọc ⇒ cùng con số'");

  console.log(
    `✓ Hợp đồng chỉ số: doanh thu GTC ${dash.kpi.successRevenue}đ và giá vốn ${dash.kpi.successCogs}đ cùng một tập đơn · GTC ${dash.kpi.successRate}% khớp mọi màn hình · mẫu số 0 trả null · hai tỷ lệ QC đúng mẫu số riêng`,
  );
}
