/**
 * Hiệu quả quảng cáo theo Marketer và theo mã hàng (thay vì liệt kê từng chiến dịch).
 * Nguồn số liệu thống nhất với Báo cáo lợi nhuận & Lương:
 *  - Chi QC, tin nhắn/lead, lượt mua Facebook báo: bảng ad_spends (đã ghép mã hàng / marketer, bỏ dòng "Không tính").
 *  - Đơn, doanh số, lợi nhuận theo mã: báo cáo lợi nhuận danh nghĩa (đơn Pancake trong kỳ, trừ giá vốn, ship, tỷ lệ hoàn dự kiến).
 *  - Theo marketer: doanh số / lợi nhuận của mã được chia theo tỷ trọng tiền QC mỗi người chạy cho mã đó (cùng công thức với Lương).
 */
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
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
  /** Mã hàng: tỷ lệ hoàn dự kiến / đã giao / đã hoàn */
  returnRate?: number;
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

export async function getAdsPerformance(period: Period): Promise<AdsPerformance> {
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
  const totalProfit = report.nominal.totals.expectedProfit;
  const avgRoas = totalSpend ? totalRevenue / totalSpend : null;
  const totalMessages = [...fbByMarketer.values()].reduce((s, e) => s + e.messages, 0);
  const minSpend = Math.max(200_000, totalSpend * 0.02);

  const marketers: PerfRow[] = report.marketers.map((m) => {
    const f = fbByMarketer.get(m.marketerId ?? "__none__");
    const spend = m.totalSpend;
    const roas = spend ? m.attributedRevenue / spend : null;
    const { rating, reason } = rate(roas, avgRoas, m.personalProfit, spend, minSpend);
    return {
      id: m.marketerId ?? "__none__",
      name: m.name,
      code: "",
      spend,
      spendShare: totalSpend ? spend / totalSpend : 0,
      campaigns: f?.campaigns ?? 0,
      messages: f?.messages ?? 0,
      costPerMessage: f?.messages ? Math.round(spend / f.messages) : null,
      fbOrders: f?.fbOrders ?? 0,
      orders: m.attributedOrders,
      cpo: m.attributedOrders ? Math.round(spend / m.attributedOrders) : null,
      revenue: m.attributedRevenue,
      roas,
      profit: m.personalProfit,
      margin: m.attributedRevenue ? m.personalProfit / m.attributedRevenue : null,
      testSpend: m.testSpend,
      rating,
      reason: m.testSpend && spend && m.testSpend / spend > 0.3 && rating !== "GOOD" ? `${reason} · ${Math.round((m.testSpend / spend) * 100)}% tiền là QC test` : reason,
    };
  });

  const products: PerfRow[] = report.nominal.rows
    .filter((r) => r.adSpend > 0 || r.orders > 0)
    .map((r) => {
      const f = fbByProduct.get(r.productId);
      const roas = r.adSpend ? r.expectedRevenue / r.adSpend : null;
      const { rating, reason } = rate(roas, avgRoas, r.expectedProfit, r.adSpend, minSpend);
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
        profit: r.expectedProfit,
        margin: r.margin,
        returnRate: r.returnRate,
        delivered: r.delivered,
        returned: r.returned,
        rating: r.adSpend ? rating : "NONE",
        reason: r.adSpend ? (r.returnRate >= 0.35 && rating !== "GOOD" ? `${reason} · tỷ lệ hoàn ${Math.round(r.returnRate * 100)}%` : reason) : "Bán không cần QC (đơn tự nhiên / khách cũ)",
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
