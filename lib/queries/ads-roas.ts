import { and, eq, gte, lte, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { metricScope, successRate } from "@/lib/queries/metrics";
import { orderCogsFast } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { ORDER_CAMPAIGN_ID } from "@/lib/queries/ads-attribution-link";
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
  /**
   * Có biết chi tiêu của dòng này hay không.
   *
   * Ở cấp MẨU QUẢNG CÁO thì KHÔNG: Facebook Insights được đồng bộ ở cấp chiến dịch/ngày, nên
   * không tồn tại con số chi tiêu cho từng mẩu. Khi đó `spend` = 0 chỉ có nghĩa "chưa biết", và
   * mọi chỉ số chia cho chi tiêu đều là `null` — KHÔNG được chia đều tiền chiến dịch cho các mẩu
   * để bảng trông đầy đủ.
   */
  spendKnown: boolean;
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

/** Dùng chung với bảng quyết định quảng cáo (ads-decision.ts) — MỘT định nghĩa cho kỳ chi tiêu. */
export function spendPeriod(from: Date | null, to: Date | null) {
  const conds = [eq(schema.adSpends.excluded, false)];
  if (from) conds.push(gte(schema.adSpends.spendDate, from));
  if (to) conds.push(lte(schema.adSpends.spendDate, to));
  return and(...conds);
}

async function roasUncached(period: Period, level: RoasLevel): Promise<AdsRoas> {
  const db = await getDb();
  // Chi tiêu CHỈ tồn tại ở cấp chiến dịch. Xem docs/ads-attribution-audit.md.
  const spendKnown = level === "campaign";
  const scope = metricScope(period, "confirmed");
  /**
   * ĐƠN THUỘC VỀ QUẢNG CÁO: có `ad_id` Pancake gửi, HOẶC nối được về chiến dịch qua bài viết.
   *
   * Pancake chỉ gửi ad_id cho ~46% đơn nhưng gửi post_id cho ~82%; Facebook cho biết mẩu quảng cáo
   * nào quảng bá bài nào, nên phần chênh nối được bằng dữ kiện thật. Chi tiết và ba ràng buộc:
   * lib/queries/ads-attribution-link.ts.
   *
   * Ở cấp MẨU QUẢNG CÁO thì chỉ dùng `ad_id`: một bài có thể do nhiều mẩu chạy, chọn bừa một mẩu là
   * bịa. Nối qua bài viết chỉ có nghĩa ở cấp CHIẾN DỊCH — cũng là cấp duy nhất có số chi tiêu.
   */
  const HAS_AD = level === "campaign" ? sql`(${ORDER_CAMPAIGN_ID} is not null)` : sql`${o.adId} is not null and ${o.adId} <> ''`;
  // ── Kết quả đơn gộp theo chiến dịch (hoặc theo từng mẩu quảng cáo) ──
  // Tiền mặt tính trong bảng dẫn xuất: COD CÓ CHỨNG TỪ trên đơn, không lấy COD khai báo.
  const groupKey = level === "campaign" ? sql`coalesce(${ORDER_CAMPAIGN_ID}, ${o.adId})` : sql`${o.adId}`;

  /**
   * ───────── MỖI ĐƠN TÍNH KẾT QUẢ MỘT LẦN, KHOÁ NHÓM CŨNG VẬY ─────────
   *
   * Đo trên production 09/09/2026: hàm này mất **25–27 giây**, và mất NHƯ NHAU cho 30 ngày lẫn toàn
   * kỳ — dấu hiệu rõ ràng rằng chi phí không đi theo lượng dữ liệu mà theo số lần tính LẶP.
   *
   * Tám cột gộp ở dưới, cột nào cũng nội tuyến trọn `ORDER_OUTCOME`; riêng khoá nhóm còn chứa
   * `ORDER_CAMPAIGN_ID` (một truy vấn con tương quan) và bị tính cả ở SELECT lẫn GROUP BY. Gói vào
   * bảng dẫn xuất kèm rào thì mỗi đơn tính đúng một lần, khoá nhóm cũng chỉ dựng một lần.
   *
   * Đổi HÌNH DẠNG, KHÔNG đổi công thức. `tests/ads-roas.test.ts` và
   * `tests/metric-shape-consistency.test.ts` giữ cho con số không đổi.
   */
  const facts = db
    .select({
      key: sql<string>`${groupKey}`.as("f_key"),
      campaignName: sql<string>`${schema.fbAds.campaignName}`.as("f_campaign_name"),
      adName: sql<string>`${schema.fbAds.name}`.as("f_ad_name"),
      adId: sql<string>`${o.adId}`.as("f_ad_id"),
      revenue: sql<number>`${o.totalPriceAfterDiscount}`.as("f_revenue"),
      cogs: sql<number>`${orderCogsFast()}`.as("f_cogs"),
      shipping: sql<number>`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`.as("f_shipping"),
      cash: sql<number>`coalesce(nullif(${s.codCollected}, 0), 0) + coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0)`.as("f_cash"),
      outcome: ORDER_OUTCOME_FAST.as("f_outcome"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG (xem PRIMARY_ATTEMPT).
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .leftJoin(schema.fbAds, eq(schema.fbAds.id, o.adId))
    .where(and(scope, HAS_AD))
    .offset(OUTCOME_FENCE)
    .as("ads_facts");

  const fDelivered = sql`${facts.outcome} = 'DELIVERED'`;
  const fReturned = sql`${facts.outcome} in ('RETURNED','RETURNED_BY_RULE')`;
  const fBooked = sql`${facts.outcome} <> 'CANCELLED'`;

  /*
    JIT TAT - do duoc tren production: adsRoas 5.083ms (30 ngay) va 4.458ms (toan ky) nguoi, 0-1ms
    am. Cung ho truy van da tach bach duoc JIT: 8.578ms bat / 26ms tat, cung so khoi dem.
    Chi boc cau lenh nay; phan tien quang cao ben duoi chay rieng nhu cu.
  */
  const orderRows = await chayKhongJit(db, (tx) => tx
    .select({
      key: sql<string>`${facts.key}`,
      name:
        level === "campaign"
          ? sql<string>`max(coalesce(nullif(${facts.campaignName}, ''), ${facts.adId}))`
          : sql<string>`max(coalesce(nullif(${facts.adName}, ''), ${facts.adId}))`,
      bookedOrders: sql<number>`count(*) filter (where ${fBooked})`,
      bookedRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${fBooked}), 0)`,
      deliveredOrders: sql<number>`count(*) filter (where ${fDelivered})`,
      deliveredRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${fDelivered}), 0)`,
      returnedOrders: sql<number>`count(*) filter (where ${fReturned})`,
      deliveredCogs: sql<number>`coalesce(sum(${facts.cogs}) filter (where ${fDelivered}), 0)`,
      shipping: sql<number>`coalesce(sum(${facts.shipping}), 0)`,
      cash: sql<number>`coalesce(sum(${facts.cash}) filter (where ${fDelivered}), 0)`,
    })
    .from(facts)
    .groupBy(facts.key));

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
    const spend = spendKnown ? (spendByKey.get(key)?.spend ?? 0) : 0;
    const bookedRevenue = Number(r.bookedRevenue ?? 0);
    const deliveredRevenue = Number(r.deliveredRevenue ?? 0);
    const cash = Number(r.cash ?? 0);
    const contribution = deliveredRevenue - Number(r.deliveredCogs ?? 0) - Number(r.shipping ?? 0) - spend;
    const deliveredOrders = Number(r.deliveredOrders ?? 0);
    const returnedOrders = Number(r.returnedOrders ?? 0);
    // Không biết chi tiêu ⇒ không có ROAS và không có CAC. Đây là chỗ dễ sai nhất: chia doanh thu
    // cho 0 rồi hiện ra một con số sẽ bị đọc như thể quảng cáo đó miễn phí.
    const ratio = (value: number) => (spendKnown && spend > 0 ? Math.round((value / spend) * 100) / 100 : null);
    const perOrder = (count: number) => (spendKnown && count > 0 ? Math.round(spend / count) : null);
    const bookedOrders = Number(r.bookedOrders ?? 0);
    rows.push({
      key,
      name: r.name || key,
      level,
      spend,
      spendKnown,
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
  // Chỉ xét ở cấp chiến dịch: ở cấp mẩu quảng cáo, khoá không cùng không gian nên mọi chiến dịch
  // sẽ trông như "không có đơn nào", một kết luận sai hoàn toàn.
  let spendWithoutOrders = 0;
  for (const [key, value] of spendKnown ? spendByKey : new Map<string, { spend: number; name: string }>()) {
    if (seen.has(key)) continue;
    spendWithoutOrders += value.spend;
    if (value.spend > 0) {
      rows.push({
        key,
        name: value.name || key,
        level,
        spend: value.spend,
        spendKnown: true,
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

  // Cấp chiến dịch xếp theo tiền đã tiêu. Cấp mẩu quảng cáo KHÔNG có tiền, nên xếp theo doanh thu
  // GIAO THÀNH CÔNG — mẩu nào thật sự đưa được hàng tới tay khách thì đứng trước.
  rows.sort((a, b) => (spendKnown ? b.spend - a.spend : b.deliveredRevenue - a.deliveredRevenue) || b.deliveredOrders - a.deliveredOrders);

  const [unmappedRow] = await db
    .select({
      ordersWithoutAd: sql<number>`count(*) filter (where not (${HAS_AD}))`,
      revenueWithoutAd: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where not (${HAS_AD})), 0)`,
      ordersWithUnknownAd: sql<number>`count(*) filter (where ${HAS_AD} and not exists (select 1 from fb_ads fa where fa.id = ${o.adId}))`,
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
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
