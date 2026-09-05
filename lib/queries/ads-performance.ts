/**
 * Hiệu quả quảng cáo theo Marketer và theo mã hàng (thay vì liệt kê từng chiến dịch).
 * Nguồn số liệu thống nhất với Báo cáo lợi nhuận & Lương:
 *  - Chi QC, tin nhắn/lead, lượt mua Facebook báo: bảng ad_spends (đã ghép mã hàng / marketer, bỏ dòng "Không tính").
 *  - Đơn, doanh số, lợi nhuận theo mã: báo cáo lợi nhuận danh nghĩa — LN = LN ròng ước tính (đã trừ giá vốn, ship, QC, đóng hàng,
 *    NV vận đơn, chi phí vận hành & cố định phân bổ, rủi ro tồn kho, thuế, chi phí khác); tỷ lệ hoàn theo kết quả Viettel Post.
 *  Lưu ý đơn vị: báo cáo danh nghĩa trả % (0–100); ở đây quy về phân số (0–1) để hiển thị thống nhất.
 *  - Theo marketer: doanh số / lợi nhuận của mã được chia theo tỷ trọng tiền QC mỗi người chạy cho mã đó (cùng công thức với Lương).
 */
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { getMarketerReport } from "@/lib/queries/payroll";
import type { Period } from "@/lib/search-params";

export type PerfRating = "GOOD" | "AVERAGE" | "POOR" | "NONE";

export type PerfRow = {
  id: string; // marketerId | productId | "__test__" | "__none__"
  name: string;
  code: string;
  spend: number;
  spendShare: number;
  campaigns: number;
  messages: number;
  costPerMessage: number | null;
  fbOrders: number;
  orders: number;
  cpo: number | null;
  revenue: number;
  roas: number | null;
  profit: number;
  margin: number | null;
  /** Mã hàng: tỷ lệ hoàn dự kiến (phân số 0–1, đã trộn đơn chưa kết thúc) / đã giao / đã hoàn / tỷ lệ hoàn thực tế trên đơn đã kết thúc */
  returnRate?: number;
  actualReturnRate?: number | null;
  /** Tỷ lệ GIAO THÀNH CÔNG (phân số 0–1): thực tế trên đơn đã kết thúc (GTC = COD thực > 100K) và dự kiến (= 1 − tỷ lệ hoàn dự kiến) */
  successRate?: number | null;
  expectedSuccessRate?: number;
  delivered?: number;
  returned?: number;
  /** Marketer: tiền QC test không thuộc mã */
  testSpend?: number;
  rating: PerfRating;
  reason: string;
};

export type AdsPerformance = {
  marketers: PerfRow[];
  products: PerfRow[];
  totals: { spend: number; orders: number; revenue: number; profit: number; roas: number | null; cpo: number | null; messages: number };
  bestMarketer: PerfRow | null;
  worstMarketer: PerfRow | null;
  bestProduct: PerfRow | null;
  worstProduct: PerfRow | null;
};

function rate(rowRoas: number | null, avgRoas: number | null, profit: number, spend: number, minSpend: number): { rating: PerfRating; reason: string } {
  if (spend <= 0) return { rating: "NONE", reason: "Không chạy QC trong kỳ" };
  if (spend < minSpend) return { rating: "AVERAGE", reason: "Chi tiêu còn nhỏ, chưa đủ kết luận" };
  if (rowRoas === null || rowRoas === 0) return { rating: "POOR", reason: "Có chi tiêu nhưng không ra đơn" };
  if (profit < 0) return { rating: "POOR", reason: `Lỗ ${Math.abs(Math.round(profit / 1000))}k sau QC` };
  if (avgRoas && rowRoas >= avgRoas * 1.2) return { rating: "GOOD", reason: `ROAS cao hơn trung bình ${Math.round((rowRoas / avgRoas - 1) * 100)}%` };
  if (avgRoas && rowRoas < avgRoas * 0.8) return { rating: "POOR", reason: `ROAS thấp hơn trung bình ${Math.round((1 - rowRoas / avgRoas) * 100)}%` };
  return { rating: "AVERAGE", reason: "Quanh mức trung bình" };
}

async function getAdsPerformanceUncached(period: Period): Promise<AdsPerformance> {
  const db = await getDb();
  const report = await getMarketerReport(period);
  const ads = schema.adSpends;
  const conds: SQL[] = [eq(ads.excluded, false)];
  if (period.from) conds.push(gte(ads.spendDate, period.from));
  if (period.to) conds.push(lte(ads.spendDate, period.to));
  const fb = await db
    .select({
      marketerId: ads.marketerId,
      productId: ads.productId,
      spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
      messages: sql<number>`coalesce(sum(greatest(${ads.messages}, ${ads.leads})), 0)`,
      fbOrders: sql<number>`coalesce(sum(${ads.orders}), 0)`,
      campaigns: sql<number>`count(distinct coalesce(${ads.campaignId}, ${ads.campaign}))`,
    })
    .from(ads)
    .where(and(...conds))
    .groupBy(ads.marketerId, ads.productId);

  const agg = (key: (r: (typeof fb)[number]) => string) => {
    const m = new Map<string, { messages: number; fbOrders: number; campaigns: number; spend: number }>();
    for (const r of fb) {
      const k = key(r);
      const e = m.get(k) ?? { messages: 0, fbOrders: 0, campaigns: 0, spend: 0 };
      e.messages += Number(r.messages);
      e.fbOrders += Number(r.fbOrders);
      e.campaigns += Number(r.campaigns);
      e.spend += Number(r.spend);
      m.set(k, e);
    }
    return m;
  };
  const fbByMarketer = agg((r) => r.marketerId ?? "__none__");
  const fbByProduct = agg((r) => r.productId ?? "__test__");

  const totalSpend = report.marketers.reduce((s, m) => s + m.totalSpend, 0);
  const totalRevenue = report.nominal.totals.expectedRevenue;
  const totalOrders = report.nominal.totals.orders;
  const totalProfit = report.nominal.totals.netProfit;
  const avgRoas = totalSpend ? totalRevenue / totalSpend : null;
  const totalMessages = [...fbByMarketer.values()].reduce((s, e) => s + e.messages, 0);
  const minSpend = Math.max(200_000, totalSpend * 0.02);

  // Đơn & doanh số theo marketer: chia ĐƠN ĐÃ XÁC NHẬN và DT GTC ước tính của từng mã (báo cáo danh nghĩa — cùng cơ sở với
  // thẻ "Đơn đã xác nhận" và bảng theo mã) theo tỷ trọng ghi nhận của Lương (ad_id → fanpage → tiền QC → chủ mã).
  // Bảng Lương chỉ chia đơn GIAO THÀNH CÔNG (vì trả lương theo tiền về) nên dùng số đó ở đây sẽ thiếu đơn.
  // Phần không chia được cho ai (mã không chạy QC / không có fanpage, ad_id) dồn vào "Chưa gán marketer" để tổng luôn khớp.
  const shareByProduct = new Map<string, Map<string, number>>();
  for (const m of report.marketers) {
    const key = m.marketerId ?? "__none__";
    for (const line of m.products) {
      if (!(line.share > 0)) continue;
      const e = shareByProduct.get(line.productId) ?? new Map<string, number>();
      e.set(key, (e.get(key) ?? 0) + line.share);
      shareByProduct.set(line.productId, e);
    }
  }
  const adShareByProduct = new Map<string, Map<string, number>>();
  for (const r of fb) {
    if (!r.productId) continue;
    const e = adShareByProduct.get(r.productId) ?? new Map<string, number>();
    e.set(r.marketerId ?? "__none__", (e.get(r.marketerId ?? "__none__") ?? 0) + Number(r.spend));
    adShareByProduct.set(r.productId, e);
  }
  const attributed = new Map<string, { orders: number; revenue: number }>();
  const add = (key: string, orders: number, revenue: number) => {
    const e = attributed.get(key) ?? { orders: 0, revenue: 0 };
    e.orders += orders;
    e.revenue += revenue;
    attributed.set(key, e);
  };
  for (const r of report.nominal.rows) {
    if (!r.orders && !r.expectedRevenue) continue;
    let shares = shareByProduct.get(r.productId);
    if (!shares || !shares.size) {
      // mã chưa có đơn giao thành công (Lương chưa chia) → chia tạm theo tiền QC từng người chạy cho mã
      const ad = adShareByProduct.get(r.productId);
      const total = ad ? [...ad.values()].reduce((t, v) => t + v, 0) : 0;
      shares = new Map();
      if (ad && total > 0) for (const [k, v] of ad) shares.set(k, v / total);
    }
    let used = 0;
    for (const [k, sh] of shares) {
      const s = Math.min(Math.max(sh, 0), 1);
      used += s;
      add(k, r.orders * s, r.expectedRevenue * s);
    }
    const rest = Math.max(0, 1 - used);
    if (rest > 1e-6) add("__none__", r.orders * rest, r.expectedRevenue * rest);
  }

  const marketerRow = (id: string, name: string, m: { totalSpend: number; personalProfit: number; testSpend: number }): PerfRow => {
    const f = fbByMarketer.get(id);
    const a = attributed.get(id) ?? { orders: 0, revenue: 0 };
    const orders = Math.round(a.orders);
    const revenue = Math.round(a.revenue);
    const spend = m.totalSpend;
    const roas = spend ? revenue / spend : null;
    const { rating, reason } = rate(roas, avgRoas, m.personalProfit, spend, minSpend);
    return {
      id,
      name,
      code: "",
      spend,
      spendShare: totalSpend ? spend / totalSpend : 0,
      campaigns: f?.campaigns ?? 0,
      messages: f?.messages ?? 0,
      costPerMessage: f?.messages ? Math.round(spend / f.messages) : null,
      fbOrders: f?.fbOrders ?? 0,
      orders,
      cpo: orders && spend ? Math.round(spend / orders) : null,
      revenue,
      roas,
      profit: m.personalProfit,
      margin: revenue ? m.personalProfit / revenue : null,
      testSpend: m.testSpend,
      rating: spend ? rating : "NONE",
      reason: !spend ? "Đơn không gắn được QC / fanpage / ad_id của marketer nào" : m.testSpend && spend && m.testSpend / spend > 0.3 && rating !== "GOOD" ? `${reason} · ${Math.round((m.testSpend / spend) * 100)}% tiền là QC test` : reason,
    };
  };
  const marketers: PerfRow[] = report.marketers.map((m) => marketerRow(m.marketerId ?? "__none__", m.name, m));
  const noneAttr = attributed.get("__none__");
  if (noneAttr && (noneAttr.orders >= 0.5 || noneAttr.revenue >= 1) && !marketers.some((m) => m.id === "__none__")) {
    marketers.push(marketerRow("__none__", "Chưa gán marketer", { totalSpend: 0, personalProfit: 0, testSpend: 0 }));
  }

  const products: PerfRow[] = report.nominal.rows
    .filter((r) => r.adSpend > 0 || r.orders > 0)
    .map((r) => {
      const f = fbByProduct.get(r.productId);
      const roas = r.adSpend ? r.expectedRevenue / r.adSpend : null;
      const { rating, reason } = rate(roas, avgRoas, r.netProfit, r.adSpend, minSpend);
      const finished = r.delivered + r.returned;
      const actualReturnRate = finished ? r.returned / finished : null;
      const returnRate = Math.min(Math.max(r.returnRate, 0), 100) / 100; // báo cáo danh nghĩa trả %, quy về phân số
      const successRate = finished ? r.delivered / finished : null;
      const expectedSuccessRate = 1 - returnRate;
      const lowSuccess = (successRate ?? expectedSuccessRate) < 0.65;
      return {
        id: r.productId,
        name: r.productName,
        code: r.code,
        spend: r.adSpend,
        spendShare: totalSpend ? r.adSpend / totalSpend : 0,
        campaigns: f?.campaigns ?? 0,
        messages: f?.messages ?? 0,
        costPerMessage: f?.messages ? Math.round(r.adSpend / f.messages) : null,
        fbOrders: f?.fbOrders ?? 0,
        orders: r.orders,
        cpo: r.orders && r.adSpend ? Math.round(r.adSpend / r.orders) : null,
        revenue: r.expectedRevenue,
        roas,
        profit: r.netProfit,
        margin: r.netMargin === null ? null : r.netMargin / 100,
        returnRate,
        actualReturnRate,
        successRate,
        expectedSuccessRate,
        delivered: r.delivered,
        returned: r.returned,
        rating: r.adSpend ? rating : "NONE",
        reason: r.adSpend ? (lowSuccess && rating !== "GOOD" ? `${reason} · tỷ lệ giao thành công ${Math.round((successRate ?? expectedSuccessRate) * 100)}%` : reason) : "Bán không cần QC (đơn tự nhiên / khách cũ)",
      };
    });
  if (report.nominal.unmatchedAdSpend > 0) {
    const f = fbByProduct.get("__test__");
    products.push({
      id: "__test__",
      name: "Chi phí test (không thuộc mã)",
      code: "",
      spend: report.nominal.unmatchedAdSpend,
      spendShare: totalSpend ? report.nominal.unmatchedAdSpend / totalSpend : 0,
      campaigns: f?.campaigns ?? 0,
      messages: f?.messages ?? 0,
      costPerMessage: f?.messages ? Math.round(report.nominal.unmatchedAdSpend / f.messages) : null,
      fbOrders: f?.fbOrders ?? 0,
      orders: 0,
      cpo: null,
      revenue: 0,
      roas: null,
      profit: -report.nominal.unmatchedAdSpend,
      margin: null,
      rating: "NONE",
      reason: "Chiến dịch có chữ TEST hoặc chưa ghép mã — trừ vào lợi nhuận tổng",
    });
  }
  const byProfit = (a: PerfRow, b: PerfRow) => b.profit - a.profit;
  marketers.sort((a, b) => (a.id === "__none__" ? 1 : b.id === "__none__" ? -1 : byProfit(a, b)));
  products.sort((a, b) => (a.id === "__test__" ? 1 : b.id === "__test__" ? -1 : byProfit(a, b)));
  const rated = (rows: PerfRow[]) => rows.filter((r) => r.spend >= minSpend && !r.id.startsWith("__"));
  const rm = rated(marketers);
  const rp = rated(products);
  return {
    marketers,
    products,
    totals: { spend: totalSpend, orders: totalOrders, revenue: totalRevenue, profit: totalProfit, roas: avgRoas, cpo: totalOrders ? Math.round(totalSpend / totalOrders) : null, messages: totalMessages },
    bestMarketer: rm[0] ?? null,
    worstMarketer: rm.length > 1 ? rm[rm.length - 1] : null,
    bestProduct: rp[0] ?? null,
    worstProduct: rp.length > 1 ? rp[rp.length - 1] : null,
  };
}

export async function getAdsPerformance(period: Period) : Promise<AdsPerformance> {
  return memo(`getAdsPerformance:${periodKey(period)}`, 120000, () => getAdsPerformanceUncached(period));
}
