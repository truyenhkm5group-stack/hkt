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

  // ───────── 5. Hợp đồng phải tồn tại và trỏ đúng nơi cài đặt ─────────
  const contract = readFileSync("docs/metrics-contract.md", "utf8");
  for (const needed of ["bookedRevenue", "deliveredRevenue", "cashReceived", "successRate", "deliveredCogs", "lib/queries/metrics.ts"]) {
    assert.ok(contract.includes(needed), `hợp đồng chỉ số phải định nghĩa ${needed}`);
  }
  assert.ok(contract.includes("cùng bộ lọc"), "hợp đồng phải nêu bất biến 'cùng chỉ số + cùng kỳ + cùng bộ lọc ⇒ cùng con số'");

  console.log(
    `✓ Hợp đồng chỉ số: doanh thu GTC ${dash.kpi.successRevenue}đ và giá vốn ${dash.kpi.successCogs}đ cùng một tập đơn · GTC ${dash.kpi.successRate}% khớp mọi màn hình · mẫu số 0 trả null`,
  );
}
