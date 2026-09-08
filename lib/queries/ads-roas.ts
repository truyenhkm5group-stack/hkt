import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { BOOKED_REVENUE, COUNT_BOOKED, COUNT_DELIVERED, COUNT_RETURNED, DELIVERED_COGS, DELIVERED_REVENUE, IS_DELIVERED, metricScope, successRate } from "@/lib/queries/metrics";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── ROAS THEO KẾT QUẢ ĐƠN ─────────────
 *
 * Với shop bán COD, "ROAS" tính theo doanh thu LÊN ĐƠN là con số vô nghĩa: 40% đơn có thể hoàn về,
 * và trong phần giao được thì tiền còn nằm ở Viettel Post hàng tuần. Bốn mức ROAS dưới đây trả lời
 * bốn câu hỏi khác nhau, và chúng luôn giảm dần:
 *
 *  1. ROAS LÊN ĐƠN     — quảng cáo tạo ra bao nhiêu đơn (đo hiệu quả của mẩu quảng cáo);
 *  2. ROAS GIAO TC     — bao nhiêu trong đó tới tay khách (đo cả chất lượng chốt đơn);
 *  3. ROAS TIỀN VỀ     — bao nhiêu tiền thật đã vào tài khoản;
 *  4. ROAS LỢI NHUẬN GÓP — còn lại bao nhiêu sau giá vốn, cước và chính tiền quảng cáo.
 *
 * KHÔNG BỊA QUY KẾT. Chỉ đơn có `ad_id` mới được gán cho quảng cáo. Đơn không có `ad_id` và tiền
 * quảng cáo không gắn được với đơn nào đều được ĐẾM RIÊNG và hiển thị, chứ không chia đều cho các
 * chiến dịch để bảng trông đẹp.
 *
 * Kết quả đơn đi qua `ORDER_OUTCOME`; định nghĩa doanh thu lấy ở `lib/queries/metrics.ts`.
 */

const o = schema.orders;
const s = schema.shipments;

export type RoasLevel = "campaign" | "ad";

export type RoasRow = {
  key: string;
  name: string;
  level: RoasLevel;
  spend: number;
  bookedOrders: number;
  bookedRevenue: number;
  deliveredOrders: number;
  deliveredRevenue: number;
  returnedOrders: number;
  /** Tiền COD đã có chứng từ trên các đơn này. */
  cashReceived: number;
  contribution: number;
  successRate: number | null;
  /** Bốn mức ROAS; `null` khi chưa tiêu đồng quảng cáo nào (chia cho 0 là vô nghĩa, không phải 0). */
  orderRoas: number | null;
  deliveredRoas: number | null;
  cashRoas: number | null;
  contributionRoas: number | null;
  /**
   * CHI PHÍ THU HÚT MỘT KHÁCH (đồng). Nghịch đảo của ROAS nhưng trả lời câu hỏi khác: "một đơn/một
   * khách nhận hàng tốn bao nhiêu tiền quảng cáo". Chủ shop so nó với lãi gộp một đơn để biết còn
   * chạy được không.
   *
   * `null` khi chưa có đơn nào — chia cho 0 là vô nghĩa, KHÔNG phải 0.
   */
  cacBooked: number | null;
  /**
   * Đắt hơn `cacBooked` đúng bằng phần đơn hoàn: đây mới là số tiền thật đã bỏ ra cho MỘT KHÁCH
   * CẦM ĐƯỢC HÀNG. Với shop bán COD, khoảng cách giữa hai con số này thường là chỗ lỗ.
   */
  cacDelivered: number | null;
};

export type AdsRoas = {
  period: Period;
  rows: RoasRow[];
  totals: { spend: number; bookedRevenue: number; deliveredRevenue: number; cashReceived: number; contribution: number };
  /** Phần KHÔNG quy kết được — phải nhìn thấy, không được giấu. */
  unmapped: {
    /** Đơn không có ad_id: không biết đến từ quảng cáo nào. */
    ordersWithoutAd: number;
    revenueWithoutAd: number;
    /** Đơn có ad_id nhưng ad đó chưa tra được trên Facebook. */
    ordersWithUnknownAd: number;
    /** Tiền quảng cáo của chiến dịch không có đơn nào gắn vào. */
    spendWithoutOrders: number;
  };
};

function spendPeriod(from: Date | null, to: Date | null) {
  const conds = [eq(schema.adSpends.excluded, false)];
  if (from) conds.push(gte(schema.adSpends.spendDate, from));
  if (to) conds.push(lte(schema.adSpends.spendDate, to));
  return and(...conds);
}

async function roasUncached(period: Period, level: RoasLevel): Promise<AdsRoas> {
  const db = await getDb();
  const scope = metricScope(period, "confirmed");
  const HAS_AD = sql`${o.adId} is not null and ${o.adId} <> ''`;
  // Tiền COD CÓ CHỨNG TỪ trên đơn — không lấy COD khai báo.
  const CASH = sql<number>`coalesce(sum(coalesce(nullif(${s.codCollected}, 0), 0) + coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0)) filter (where ${IS_DELIVERED}), 0)`;

  // ── Kết quả đơn gộp theo chiến dịch (hoặc theo từng mẩu quảng cáo) ──
  const groupKey = level === "campaign" ? sql`coalesce(${schema.fbAds.campaignId}, ${o.adId})` : sql`${o.adId}`;
  const groupName = level === "campaign" ? sql<string>`max(coalesce(nullif(${schema.fbAds.campaignName}, ''), ${o.adId}))` : sql<string>`max(coalesce(nullif(${schema.fbAds.name}, ''), ${o.adId}))`;

  const orderRows = await db
    .select({
      key: sql<string>`${groupKey}`,
      name: groupName,
      bookedOrders: COUNT_BOOKED,
      bookedRevenue: BOOKED_REVENUE,
      deliveredOrders: COUNT_DELIVERED,
      deliveredRevenue: DELIVERED_REVENUE,
      returnedOrders: COUNT_RETURNED,
      deliveredCogs: DELIVERED_COGS,
      shipping: sql<number>`coalesce(sum(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)), 0)`,
      cash: CASH,
    })
    .from(o)
    .leftJoin(s, eq(s.orderId, o.id))
    .leftJoin(schema.fbAds, eq(schema.fbAds.id, o.adId))
    .where(and(scope, HAS_AD))
    .groupBy(sql`${groupKey}`);

  // ── Tiền quảng cáo theo cùng khoá ──
  const spendRows = await db
    .select({
      key: sql<string>`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`,
      name: sql<string>`max(${schema.adSpends.campaign})`,
      spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`,
    })
    .from(schema.adSpends)
    .where(spendPeriod(period.from, period.to))
    .groupBy(sql`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`);

  const spendByKey = new Map(spendRows.map((r) => [String(r.key), { spend: Number(r.spend), name: r.name ?? "" }]));

  const rows: RoasRow[] = [];
  const seen = new Set<string>();
  for (const r of orderRows) {
    const key = String(r.key ?? "");
    if (!key) continue;
    seen.add(key);
    const spend = spendByKey.get(key)?.spend ?? 0;
    const bookedRevenue = Number(r.bookedRevenue ?? 0);
    const deliveredRevenue = Number(r.deliveredRevenue ?? 0);
    const cash = Number(r.cash ?? 0);
    const contribution = deliveredRevenue - Number(r.deliveredCogs ?? 0) - Number(r.shipping ?? 0) - spend;
    const deliveredOrders = Number(r.deliveredOrders ?? 0);
    const returnedOrders = Number(r.returnedOrders ?? 0);
    const ratio = (value: number) => (spend > 0 ? Math.round((value / spend) * 100) / 100 : null);
    // CAC: tiền quảng cáo trên MỘT đơn. Không có đơn thì không có CAC — không phải CAC bằng 0.
    const perOrder = (count: number) => (count > 0 ? Math.round(spend / count) : null);
    const bookedOrders = Number(r.bookedOrders ?? 0);
    rows.push({
      key,
      name: r.name || key,
      level,
      spend,
      bookedOrders,
      bookedRevenue,
      deliveredOrders,
      deliveredRevenue,
      returnedOrders,
      cashReceived: cash,
      contribution,
      successRate: successRate(deliveredOrders, returnedOrders),
      orderRoas: ratio(bookedRevenue),
      deliveredRoas: ratio(deliveredRevenue),
      cashRoas: ratio(cash),
      contributionRoas: ratio(contribution),
      cacBooked: perOrder(bookedOrders),
      cacDelivered: perOrder(deliveredOrders),
    });
  }

  // Chiến dịch có tiêu tiền nhưng KHÔNG có đơn nào gắn vào — vẫn phải hiện, đó là tiền đã mất.
  let spendWithoutOrders = 0;
  for (const [key, value] of spendByKey) {
    if (seen.has(key)) continue;
    spendWithoutOrders += value.spend;
    if (value.spend > 0) {
      rows.push({
        key,
        name: value.name || key,
        level,
        spend: value.spend,
        bookedOrders: 0,
        bookedRevenue: 0,
        deliveredOrders: 0,
        deliveredRevenue: 0,
        returnedOrders: 0,
        cashReceived: 0,
        contribution: -value.spend,
        successRate: null,
        orderRoas: 0,
        deliveredRoas: 0,
        cashRoas: 0,
        contributionRoas: -1,
        // Tiêu tiền mà không đơn nào: CAC là vô hạn, không phải một con số. Để `null` và hiện "—",
        // vì in ra một số ở đây sẽ bị đọc nhầm thành "chi phí mỗi đơn".
        cacBooked: null,
        cacDelivered: null,
      });
    }
  }

  rows.sort((a, b) => b.spend - a.spend);

  const [unmappedRow] = await db
    .select({
      ordersWithoutAd: sql<number>`count(*) filter (where not (${HAS_AD}))`,
      revenueWithoutAd: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where not (${HAS_AD})), 0)`,
      ordersWithUnknownAd: sql<number>`count(*) filter (where ${HAS_AD} and not exists (select 1 from fb_ads fa where fa.id = ${o.adId}))`,
    })
    .from(o)
    .leftJoin(s, eq(s.orderId, o.id))
    .where(scope);

  const totals = rows.reduce(
    (t, r) => ({
      spend: t.spend + r.spend,
      bookedRevenue: t.bookedRevenue + r.bookedRevenue,
      deliveredRevenue: t.deliveredRevenue + r.deliveredRevenue,
      cashReceived: t.cashReceived + r.cashReceived,
      contribution: t.contribution + r.contribution,
    }),
    { spend: 0, bookedRevenue: 0, deliveredRevenue: 0, cashReceived: 0, contribution: 0 },
  );

  return {
    period,
    rows,
    totals,
    unmapped: {
      ordersWithoutAd: Number(unmappedRow?.ordersWithoutAd ?? 0),
      revenueWithoutAd: Number(unmappedRow?.revenueWithoutAd ?? 0),
      ordersWithUnknownAd: Number(unmappedRow?.ordersWithUnknownAd ?? 0),
      spendWithoutOrders,
    },
  };
}

export async function getAdsRoas(period: Period, level: RoasLevel = "campaign"): Promise<AdsRoas> {
  return memo(`adsRoas:${periodKey(period)}:${level}`, 90_000, () => roasUncached(period, level));
}

export const CAC_LABEL = {
  cacBooked: "CAC lên đơn",
  cacDelivered: "CAC giao thành công",
} as const;

export const CAC_HINT = {
  cacBooked: "Chi quảng cáo ÷ số đơn đã lên. Trả lời 'một đơn tốn bao nhiêu tiền quảng cáo'.",
  cacDelivered:
    "Chi quảng cáo ÷ số đơn ĐÃ TỚI TAY KHÁCH. Đây mới là tiền thật bỏ ra cho một khách cầm được hàng; khoảng cách với CAC lên đơn chính là phần trả cho những đơn hoàn. So nó với lãi gộp một đơn để biết còn chạy được không.",
} as const;

export const ROAS_LABEL = {
  orderRoas: "ROAS lên đơn",
  deliveredRoas: "ROAS giao thành công",
  cashRoas: "ROAS tiền về",
  contributionRoas: "ROAS lợi nhuận góp",
} as const;

export const ROAS_HINT = {
  orderRoas: "Doanh thu LÊN ĐƠN ÷ chi quảng cáo. Đo hiệu quả của mẩu quảng cáo, chưa nói gì về việc giao được hay thu được tiền.",
  deliveredRoas: "Doanh thu GIAO THÀNH CÔNG ÷ chi quảng cáo. Đơn hoàn đã bị loại, nên con số này thấp hơn và thật hơn.",
  cashRoas: "Tiền CÓ CHỨNG TỪ đã thu ÷ chi quảng cáo. Phần chênh với ROAS giao thành công là tiền Viettel Post còn giữ.",
  contributionRoas: "Lợi nhuận góp (đã trừ giá vốn, cước và chính tiền quảng cáo) ÷ chi quảng cáo. Dưới 0 nghĩa là càng chạy càng lỗ.",
} as const;
