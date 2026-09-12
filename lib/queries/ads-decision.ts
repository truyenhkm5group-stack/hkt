import { and, eq, gte, lte, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { metricScope, successRate } from "@/lib/queries/metrics";
import { orderCogsFast } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { lineUnitCost } from "@/lib/queries/cogs";
import { variantLastCostSubquery } from "@/lib/queries/stock";
import { ORDER_CAMPAIGN_ID } from "@/lib/queries/ads-attribution-link";
import { adsAttributionCoverage, coverageVerdict } from "@/lib/queries/ads-attribution-coverage";
import { LOW_COVERAGE_PCT } from "@/lib/constants/sales-funnel";
import {
  ADS_ACTION_ORDER,
  ADS_DECISION_RULE,
  ADS_DIMENSION_HAS_SPEND,
  type AdsAction,
  type AdsDimension,
} from "@/lib/constants/ads-decision";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════════ MÀN RA QUYẾT ĐỊNH QUẢNG CÁO ═══════════════
 *
 * Hợp đồng chỉ số: `docs/ads-decision-contract.md`. Đọc trước khi sửa bất cứ công thức nào ở đây.
 *
 * Câu hỏi mà file này trả lời — và cố ý KHÔNG trả lời quá câu hỏi đó:
 *   · dòng nào đang KIẾM RA TIỀN sau khi trừ hết giá vốn, cước và chính tiền quảng cáo;
 *   · dòng nào đang ĐỐT TIỀN;
 *   · dòng nào quảng cáo tốt nhưng CHẾT Ở KHÂU GIAO (hoàn cao / GTC thấp);
 *   · ROAS HOÀ VỐN của từng dòng — mỗi mã hàng một biên khác nhau, nên một ngưỡng ROAS chung cho
 *     cả shop là vô nghĩa;
 *   · tiền đang TREO ở nhóm chưa đủ dữ liệu để kết luận.
 *
 * ───────────── BA NGUYÊN TẮC, VÀ CHÚNG QUYẾT ĐỊNH TOÀN BỘ THIẾT KẾ ─────────────
 *
 * 1. **KHÔNG SUY TIỀN TỪ TRẠNG THÁI.** Kết quả đơn đi qua `ORDER_OUTCOME` (bản duy nhất, đặc tả
 *    `docs/business-rules/ORDER_OUTCOME.md`). Không nơi nào ở đây đọc `shipments.stage` hay trạng
 *    thái Pancake để kết luận "đã giao", và không nơi nào suy "đã giao" ra từ COD/thanh toán.
 *
 * 2. **KHÔNG BỊA QUY KẾT.** Chỉ đơn nối được về chiến dịch bằng dữ kiện thật (`ad_id` Pancake gửi,
 *    hoặc bài viết chỉ thuộc MỘT chiến dịch) mới được gán. Phần không nối được đếm riêng và hiện ra.
 *    Tiền chiến dịch KHÔNG được chia đều xuống nhóm/mẩu quảng cáo — chia đều làm tổng khớp trong
 *    khi từng dòng đều sai.
 *
 * 3. **CHƯA ĐỦ DỮ LIỆU THÌ KHÔNG CÓ Ý KIẾN.** `INSUFFICIENT_DATA` là một kết luận hợp lệ và hay
 *    gặp. Một khuyến nghị "CẮT" đưa ra trên 3 đơn không phải khuyến nghị, đó là tiếng ồn.
 *
 * ───────────── VÌ SAO KHÔNG DÙNG LẠI `getAdsPerformance` ─────────────
 *
 * `getAdsPerformance` → `getMarketerReport` → `getNominalProfitReport`: để hiện một bảng quảng cáo,
 * nó dựng TOÀN BỘ báo cáo lợi nhuận công ty (phân bổ chi phí cố định, dự phòng rủi ro tồn kho,
 * thuế, chia lương). Đo được 12/09/2026 ở quy mô 3×: **477,9ms trong tổng 492,5ms của cả trang,
 * 33 trong 39 câu truy vấn** — 97% thời gian của màn quảng cáo nằm ở bộ máy lương/lợi nhuận.
 *
 * Quyết định quảng cáo KHÔNG cần con số đó. Cái cần là **lợi nhuận góp sau quảng cáo**: doanh thu
 * giao thành công − giá vốn − cước − tiền quảng cáo. Chi phí cố định và thuế không đổi theo việc
 * tăng hay giảm ngân sách MỘT chiến dịch, nên đưa chúng vào phép so sánh giữa các chiến dịch chỉ
 * làm nhiễu. Đó là lý do màn này dựng truy vấn riêng thay vì dùng lại bộ máy kia.
 */

const o = schema.orders;
const s = schema.shipments;
const i = schema.orderItems;
const pv = schema.productVariants;

export type AdsDecisionRow = {
  key: string;
  name: string;
  dimension: AdsDimension;
  /**
   * Có biết số chi của dòng này không. `false` ⇒ mọi chỉ số chia cho tiền là `null`, KHÔNG phải 0.
   * Đây là thuộc tính của DỮ LIỆU (Facebook chỉ trả chi tiêu ở cấp chiến dịch/ngày), không phải
   * một lựa chọn hiển thị.
   */
  spendKnown: boolean;
  spend: number;

  // ── Đơn: đếm riêng từng chiều, không suy ra lẫn nhau ──
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  /** Đơn CHƯA ngã ngũ: đang giao / chưa gửi / chưa có chứng từ ĐVVC. */
  openOrders: number;

  // ── Tiền: ba con số khác nhau, không bao giờ gộp ──
  bookedRevenue: number;
  deliveredRevenue: number;
  /** Tiền CÓ CHỨNG TỪ đã về (bảng kê ĐVVC + khách chuyển trước). */
  cashReceived: number;
  cogs: number;
  shippingCost: number;

  // ── Dẫn xuất ──
  contributionBeforeAds: number;
  profitAfterAds: number;
  /** Tỷ lệ giao thành công (%), `null` khi chưa có đơn nào kết thúc. */
  successRate: number | null;
  /** Phần đơn đã ngã ngũ trên tổng đơn đã lên (0–1). Thấp ⇒ kết quả còn treo. */
  maturity: number;
  /** Biên lợi nhuận góp trên doanh thu giao thành công (0–1). `null` khi chưa có doanh thu. */
  marginRate: number | null;
  bookedRoas: number | null;
  deliveredRoas: number | null;
  cashRoas: number | null;
  /** ROAS GIAO THÀNH CÔNG phải đạt để hoà vốn = 1 ÷ biên lợi nhuận góp. */
  breakEvenDeliveredRoas: number | null;
  /**
   * ROAS LÊN ĐƠN phải đạt để hoà vốn — đã tính cả phần đơn sẽ hoàn.
   * Đây là con số so trực tiếp được với ROAS trên Facebook Ads Manager.
   */
  breakEvenBookedRoas: number | null;
  /**
   * Khoảng cách tới điểm hoà vốn = lợi nhuận góp trước quảng cáo ÷ tiền quảng cáo.
   * 1,0 = hoà vốn đúng bằng; 1,3 = dư 30%; 0,5 = mất một nửa số tiền đã tiêu.
   * `null` khi không biết chi tiêu.
   */
  headroom: number | null;
  /** Chi phí quảng cáo cho MỘT khách cầm được hàng. */
  cacDelivered: number | null;

  action: AdsAction;
  /** Giải thích bằng SỐ THẬT của chính dòng này — không có câu chữ chung chung. */
  reason: string;
  /** Dấu hiệu phụ, hiện thành nhãn cạnh hành động. */
  lowDelivery: boolean;
};

export type AdsDecision = {
  period: Period;
  dimension: AdsDimension;
  rows: AdsDecisionRow[];
  totals: {
    spend: number;
    bookedRevenue: number;
    deliveredRevenue: number;
    cashReceived: number;
    contributionBeforeAds: number;
    profitAfterAds: number;
    /**
     * CẨN THẬN Ở CẤP MÃ HÀNG: một đơn chứa hai mã được đếm cho CẢ HAI mã, nên tổng hai dòng này
     * lớn hơn số đơn thật của kỳ. Đó là hành vi đúng cho một bảng theo mã, nhưng KHÔNG được đem
     * hiển thị như "tổng số đơn" — dùng số đơn ở Tổng quan cho việc đó.
     * Tiền thì không bị vấn đề này: doanh thu và giá vốn đã tách xuống dòng đơn.
     */
    deliveredOrders: number;
    bookedOrders: number;
  };
  /** Tiền đang nằm ở những dòng KHÔNG kết luận được — phải nhìn thấy, không được giấu. */
  pending: {
    /** Chi ở dòng chưa đủ dữ liệu (ít tiền / ít đơn kết thúc / phần lớn đơn còn đang đi). */
    spendInsufficientData: number;
    /** Chi ở chiến dịch không có đơn nào gắn vào — tiền đã mất dấu hoàn toàn. */
    spendWithoutOrders: number;
    /** Đơn chưa ngã ngũ trong các dòng đang xét. */
    openOrders: number;
  };
  /**
   * Độ tin cậy của toàn bảng. Dưới ngưỡng ⇒ giao diện phải nói rõ đây là kết luận trên PHẦN QUY KẾT
   * ĐƯỢC, không phải toàn shop.
   */
  confidence: {
    coveragePct: number;
    verdict: "SUFFICIENT" | "DATA_INSUFFICIENT";
    threshold: number;
    attributedOrders: number;
    totalOrders: number;
  };
};

function spendPeriod(from: Date | null, to: Date | null) {
  const conds = [eq(schema.adSpends.excluded, false)];
  if (from) conds.push(gte(schema.adSpends.spendDate, from));
  if (to) conds.push(lte(schema.adSpends.spendDate, to));
  return and(...conds);
}

/** Khoá gộp của từng cấp. `adset` lấy từ `fb_ads` vì đơn chỉ mang `ad_id`. */
function groupKeyFor(dimension: AdsDimension) {
  if (dimension === "campaign") return sql`coalesce(${ORDER_CAMPAIGN_ID}, ${o.adId})`;
  if (dimension === "ad") return sql`${o.adId}`;
  return sql`(select fa.adset_id from fb_ads fa where fa.id = ${o.adId})`;
}

/**
 * ĐƠN THUỘC VỀ CẤP ĐANG XÉT.
 *
 * Cấp chiến dịch nhận cả đơn nối được qua BÀI VIẾT (Pancake chỉ gửi `ad_id` cho ~46% đơn nhưng gửi
 * `post_id` cho ~82%). Cấp mẩu/nhóm thì chỉ dùng `ad_id`: một bài có thể do nhiều mẩu chạy, chọn
 * bừa một mẩu là bịa quy kết.
 */
function hasAdFor(dimension: AdsDimension) {
  if (dimension === "campaign") return sql`(${ORDER_CAMPAIGN_ID} is not null)`;
  return sql`${o.adId} is not null and ${o.adId} <> ''`;
}

type Agg = {
  key: string;
  name: string;
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  openOrders: number;
  bookedRevenue: number;
  deliveredRevenue: number;
  cash: number;
  cogs: number;
  shipping: number;
};

function toAgg(r: Record<string, unknown>): Agg {
  return {
    key: String(r.key ?? ""),
    name: String(r.name ?? "") || String(r.key ?? ""),
    bookedOrders: Number(r.bookedOrders ?? 0),
    deliveredOrders: Number(r.deliveredOrders ?? 0),
    returnedOrders: Number(r.returnedOrders ?? 0),
    openOrders: Number(r.openOrders ?? 0),
    bookedRevenue: Number(r.bookedRevenue ?? 0),
    deliveredRevenue: Number(r.deliveredRevenue ?? 0),
    cash: Number(r.cash ?? 0),
    cogs: Number(r.cogs ?? 0),
    shipping: Number(r.shipping ?? 0),
  };
}

/**
 * ───────── MỖI ĐƠN TÍNH KẾT QUẢ ĐÚNG MỘT LẦN ─────────
 *
 * `ORDER_OUTCOME_FAST` và `orderCogsFast()` đều là truy vấn con tương quan, và Postgres nội tuyến
 * chúng vào TỪNG cột gộp. Mười cột gộp ⇒ mỗi đơn tính kết quả mười lần. Gói vào bảng dẫn xuất kèm
 * rào `OUTCOME_FENCE` thì mỗi đơn tính một lần, khoá nhóm cũng chỉ dựng một lần.
 *
 * Đổi HÌNH DẠNG, KHÔNG đổi công thức — cùng `ORDER_OUTCOME`, cùng population, cùng trường ngày.
 */
async function aggregateByOrder(period: Period, dimension: AdsDimension): Promise<Agg[]> {
  const db = await getDb();
  const facts = db
    .select({
      key: sql<string>`${groupKeyFor(dimension)}`.as("d_key"),
      campaignName: sql<string>`${schema.fbAds.campaignName}`.as("d_campaign_name"),
      adName: sql<string>`${schema.fbAds.name}`.as("d_ad_name"),
      adId: sql<string>`${o.adId}`.as("d_ad_id"),
      revenue: sql<number>`coalesce(${o.totalPriceAfterDiscount}, 0)`.as("d_revenue"),
      cogs: sql<number>`${orderCogsFast()}`.as("d_cogs"),
      shipping: sql<number>`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`.as("d_shipping"),
      returnFee: sql<number>`coalesce(${o.returnFee}, 0)`.as("d_return_fee"),
      cash: sql<number>`coalesce(nullif(${s.codCollected}, 0), 0) + coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0)`.as("d_cash"),
      outcome: ORDER_OUTCOME_FAST.as("d_outcome"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG (xem PRIMARY_ATTEMPT) — đơn gửi lại không được đếm hai lần.
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .leftJoin(schema.fbAds, eq(schema.fbAds.id, o.adId))
    .where(and(metricScope(period, "confirmed"), hasAdFor(dimension)))
    .offset(OUTCOME_FENCE)
    .as("ads_decision_facts");

  const delivered = sql`${facts.outcome} = 'DELIVERED'`;
  const returned = sql`${facts.outcome} in ('RETURNED','RETURNED_BY_RULE')`;
  const booked = sql`${facts.outcome} <> 'CANCELLED'`;
  const open = sql`${facts.outcome} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN')`;

  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        key: sql<string>`${facts.key}`,
        name:
          dimension === "ad"
            ? sql<string>`max(coalesce(nullif(${facts.adName}, ''), ${facts.adId}))`
            : dimension === "campaign"
              ? sql<string>`max(coalesce(nullif(${facts.campaignName}, ''), ${facts.adId}))`
              : sql<string>`max(${facts.key})`,
        bookedOrders: sql<number>`count(*) filter (where ${booked})`,
        deliveredOrders: sql<number>`count(*) filter (where ${delivered})`,
        returnedOrders: sql<number>`count(*) filter (where ${returned})`,
        openOrders: sql<number>`count(*) filter (where ${open})`,
        bookedRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${booked}), 0)`,
        deliveredRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${delivered}), 0)`,
        cash: sql<number>`coalesce(sum(${facts.cash}) filter (where ${delivered}), 0)`,
        cogs: sql<number>`coalesce(sum(${facts.cogs}) filter (where ${delivered}), 0)`,
        /**
         * CƯỚC THEO ĐÚNG BẬC THANG SỰ THẬT TÀI CHÍNH (financial-truth.ts, docs/metrics-contract.md):
         * cước của đơn ĐÃ GIAO và đơn HOÀN, cộng phí hoàn của đơn hoàn. Đơn hoàn vẫn tốn cước — đó
         * chính là phần làm biên lợi nhuận tụt, bỏ ra sẽ cho điểm hoà vốn đẹp hơn sự thật. Nhưng
         * đơn HUỶ / chưa gửi / đang đi thì CHƯA có cước thật: `orders.partner_fee` ở đó chỉ là
         * cước Pancake ước tính lúc lên đơn, cộng vào là gánh tiền chưa hề chi.
         */
        shipping: sql<number>`coalesce(sum(${facts.shipping}) filter (where ${delivered} or ${returned}), 0) + coalesce(sum(${facts.returnFee}) filter (where ${returned}), 0)`,
      })
      .from(facts)
      .groupBy(facts.key),
  );

  return rows.filter((r) => String(r.key ?? "").trim() !== "").map((r) => toAgg(r as Record<string, unknown>));
}

/**
 * ───────── CẤP MÃ HÀNG: GỘP THEO DÒNG ĐƠN ─────────
 *
 * Một đơn có thể chứa nhiều mã hàng, nên doanh thu phải tách xuống DÒNG (`order_items.line_total`)
 * — đúng cách `profit-nominal.ts` đang làm, để hai báo cáo không nói hai con số.
 *
 * CƯỚC là chi phí của CẢ ĐƠN, không của dòng. **Căn cứ phân bổ: tỷ trọng doanh thu dòng trong đơn**
 * (khai rõ theo AGENTS.md mục 14 — mọi chi phí phải nói căn cứ trước khi nhân). Không phân bổ theo
 * số lượng hay khối lượng vì dữ liệu cước chỉ tồn tại ở cấp vận đơn.
 *
 * Khác cấp chiến dịch, cấp này KHÔNG lọc theo `ad_id`: mã hàng có doanh thu từ cả đơn không chạy
 * quảng cáo, còn tiền quảng cáo của mã lấy thẳng từ `ad_spends.product_id`. Lọc theo `ad_id` sẽ bỏ
 * mất phần doanh thu mà chính quảng cáo đó tạo ra nhưng Pancake không gắn mã.
 */
async function aggregateByProduct(period: Period): Promise<Agg[]> {
  const db = await getDb();
  // Giá vốn theo ĐÚNG bậc thang chung (AGENTS.md mục 13): phiếu nhập ERP gần nhất → giá vốn Pancake
  // trên đơn → giá nhập mẫu mã — tính một lần cho mỗi mẫu mã (xem variantLastCostSubquery).
  const lastCost = variantLastCostSubquery(db);
  const PID = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  const facts = db
    .select({
      key: sql<string>`${PID}`.as("p_key"),
      name: sql<string>`coalesce(nullif(${schema.products.name}, ''), ${i.productName})`.as("p_name"),
      lineRevenue: sql<number>`coalesce(${i.lineTotal}, 0)`.as("p_line_revenue"),
      lineCogs: sql<number>`${i.quantity} * ${lineUnitCost(lastCost)}`.as("p_line_cogs"),
      /** Tỷ trọng doanh thu dòng trong đơn — CĂN CỨ PHÂN BỔ cước, khai rõ ở chú thích trên. */
      shipShare: sql<number>`coalesce(${i.lineTotal}, 0) / nullif(sum(coalesce(${i.lineTotal}, 0)) over (partition by ${o.id}), 0)`.as("p_ship_share"),
      shipping: sql<number>`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`.as("p_shipping"),
      returnFee: sql<number>`coalesce(${o.returnFee}, 0)`.as("p_return_fee"),
      cash: sql<number>`coalesce(nullif(${s.codCollected}, 0), 0) + coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0)`.as("p_cash"),
      orderId: sql<string>`${o.id}`.as("p_order_id"),
      outcome: ORDER_OUTCOME_FAST.as("p_outcome"),
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .innerJoin(i, eq(i.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .leftJoin(lastCost, eq(lastCost.variantId, i.variantId))
    .leftJoin(schema.products, eq(schema.products.id, sql`coalesce(${pv.productId}, ${i.productId})`))
    .where(metricScope(period, "confirmed"))
    .offset(OUTCOME_FENCE)
    .as("ads_product_facts");

  const delivered = sql`${facts.outcome} = 'DELIVERED'`;
  const returned = sql`${facts.outcome} in ('RETURNED','RETURNED_BY_RULE')`;
  const booked = sql`${facts.outcome} <> 'CANCELLED'`;
  const open = sql`${facts.outcome} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN')`;
  /** ĐẾM ĐƠN, KHÔNG ĐẾM DÒNG: một đơn hai mã hàng vẫn là MỘT đơn của mỗi mã. */
  const countOrders = (cond: ReturnType<typeof sql>) => sql<number>`count(distinct ${facts.orderId}) filter (where ${cond})`;

  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        key: sql<string>`${facts.key}`,
        name: sql<string>`max(${facts.name})`,
        bookedOrders: countOrders(booked),
        deliveredOrders: countOrders(delivered),
        returnedOrders: countOrders(returned),
        openOrders: countOrders(open),
        bookedRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${booked}), 0)`,
        deliveredRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${delivered}), 0)`,
        cash: sql<number>`coalesce(sum(${facts.cash} * coalesce(${facts.shipShare}, 0)) filter (where ${delivered}), 0)`,
        cogs: sql<number>`coalesce(sum(${facts.lineCogs}) filter (where ${delivered}), 0)`,
        // Cùng bậc thang cước như cấp chiến dịch: chỉ đơn đã giao + đơn hoàn, cộng phí hoàn của đơn hoàn.
        shipping: sql<number>`coalesce(sum((${facts.shipping} + case when ${returned} then ${facts.returnFee} else 0 end) * coalesce(${facts.shipShare}, 0)) filter (where ${delivered} or ${returned}), 0)`,
      })
      .from(facts)
      .groupBy(facts.key),
  );

  return rows.filter((r) => String(r.key ?? "").trim() !== "").map((r) => toAgg(r as Record<string, unknown>));
}

/** Tiền quảng cáo theo cùng khoá gộp. Cấp không có chi tiêu thì trả map RỖNG — KHÔNG chia đều. */
async function spendByKey(period: Period, dimension: AdsDimension): Promise<Map<string, { spend: number; name: string }>> {
  if (!ADS_DIMENSION_HAS_SPEND[dimension]) return new Map();
  const db = await getDb();
  const key = dimension === "product" ? sql`${schema.adSpends.productId}` : sql`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`;
  const rows = await db
    .select({
      key: sql<string>`${key}`,
      name: sql<string>`max(${schema.adSpends.campaign})`,
      spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`,
    })
    .from(schema.adSpends)
    .where(spendPeriod(period.from, period.to))
    .groupBy(key);
  const map = new Map<string, { spend: number; name: string }>();
  for (const r of rows) {
    const k = String(r.key ?? "").trim();
    if (!k) continue;
    map.set(k, { spend: Number(r.spend ?? 0), name: String(r.name ?? "") });
  }
  return map;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Chia an toàn: mẫu số 0 ⇒ `null` (CHƯA BIẾT), không bao giờ 0. Hợp đồng chỉ số mục 6.5. */
const ratio = (numerator: number, denominator: number): number | null => (denominator > 0 ? round2(numerator / denominator) : null);

/**
 * ───────── QUY TẮC KHUYẾN NGHỊ ─────────
 *
 * Mọi nhánh phải giải thích được bằng số của CHÍNH DÒNG ĐÓ; không nhánh nào trả về câu chữ chung
 * chung. Thứ tự các cổng là cố ý: **từ chối kết luận trước, kết luận sau.**
 *
 * Tách khỏi truy vấn để kiểm thử được mà không cần CSDL — bảng chân lý nằm ở `tests/ads-decision.test.ts`.
 */
export function decideAction(input: {
  spendKnown: boolean;
  spend: number;
  headroom: number | null;
  successRate: number | null;
  maturity: number;
  finishedOrders: number;
  bookedRoas: number | null;
  breakEvenBookedRoas: number | null;
  deliveredOrders: number;
}): { action: AdsAction; reason: string; lowDelivery: boolean } {
  const r = ADS_DECISION_RULE;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lowDelivery = input.successRate !== null && input.successRate < r.lowSuccessRate;

  // CỔNG 0 — không có số chi thì không có bất kỳ kết luận nào về tiền.
  if (!input.spendKnown) {
    return {
      action: "NO_SPEND_DATA",
      reason: "Cấp này không có số chi quảng cáo (Facebook chỉ trả chi tiêu ở cấp chiến dịch/ngày), nên không tính được ROAS hay lợi nhuận.",
      lowDelivery,
    };
  }

  // CỔNG 1 — quá ít tiền, hoặc quá ít đơn đã ngã ngũ.
  if (input.spend < r.minSpend) {
    return {
      action: "INSUFFICIENT_DATA",
      reason: `Mới chi ${input.spend.toLocaleString("vi-VN")}đ, dưới mức tối thiểu ${r.minSpend.toLocaleString("vi-VN")}đ để kết luận.`,
      lowDelivery,
    };
  }
  if (input.finishedOrders < r.minFinishedOrders) {
    return {
      action: "INSUFFICIENT_DATA",
      reason: `Mới có ${input.finishedOrders} đơn đã kết thúc (cần ${r.minFinishedOrders}). Thêm hoặc bớt một đơn là tỷ lệ đổi hẳn.`,
      lowDelivery,
    };
  }

  // CỔNG 2 — phần lớn đơn còn đang đi: tiền đã tiêu nhưng KẾT QUẢ CHƯA NGÃ NGŨ.
  if (input.maturity < r.minMaturity) {
    return {
      action: "INSUFFICIENT_DATA",
      reason: `Mới ${pct(input.maturity)} số đơn ngã ngũ (cần ${pct(r.minMaturity)}). Phần hoàn chưa về hết nên lợi nhuận hiện tại đang đẹp hơn sự thật.`,
      lowDelivery,
    };
  }

  const h = input.headroom;
  if (h === null) {
    return { action: "INSUFFICIENT_DATA", reason: "Không tính được khoảng cách tới điểm hoà vốn.", lowDelivery };
  }

  const money = h >= 1 ? `lãi ${pct(h - 1)} trên tiền quảng cáo` : `lỗ ${pct(1 - h)} trên tiền quảng cáo`;

  /**
   * CỔNG 3 — QUẢNG CÁO TỐT NHƯNG GIAO KÉM.
   *
   * Chỉ bật khi chính khâu giao là nguyên nhân: trên cơ sở ĐƠN ĐÃ LÊN thì quảng cáo đã vượt hoà
   * vốn, nhưng sau khi trừ phần hoàn thì không còn. Cắt quảng cáo ở đây là chữa sai bệnh — việc
   * phải làm là chốt đơn kỹ hơn / đóng gói / đổi ĐVVC.
   */
  if (
    lowDelivery &&
    h < r.scaleAbove &&
    input.bookedRoas !== null &&
    input.breakEvenBookedRoas !== null &&
    input.bookedRoas >= input.breakEvenBookedRoas
  ) {
    return {
      action: "FIX_DELIVERY",
      reason: `Tỷ lệ giao thành công ${input.successRate}% (dưới ${r.lowSuccessRate}%) — trên đơn ĐÃ LÊN thì ROAS ${input.bookedRoas}× đã vượt hoà vốn ${input.breakEvenBookedRoas}×, nhưng phần hoàn ăn hết phần lãi (${money}). Vấn đề ở khâu giao, không phải ở quảng cáo.`,
      lowDelivery,
    };
  }

  if (h >= r.scaleAbove) {
    return { action: "SCALE", reason: `Đang ${money}, cao hơn điểm hoà vốn ${pct(h - 1)} — còn dư địa tăng ngân sách.`, lowDelivery };
  }
  if (h >= 1) {
    return { action: "HOLD", reason: `Đang ${money}: trên hoà vốn nhưng chưa đủ dày để tăng tiền (cần ${r.scaleAbove}× hoà vốn).`, lowDelivery };
  }
  if (h >= r.cutBelow) {
    return { action: "WATCH", reason: `Đang ${money}, sát điểm hoà vốn. Chưa đáng cắt nhưng cũng chưa kiếm được tiền.`, lowDelivery };
  }
  return {
    action: "CUT",
    reason: `Đang ${money}${input.deliveredOrders === 0 ? " và chưa có đơn nào tới tay khách" : ""} — dưới ${r.cutBelow}× điểm hoà vốn, càng chạy càng lỗ.`,
    lowDelivery,
  };
}

/** Dựng một dòng quyết định từ số gộp + tiền quảng cáo. Tách hàm để kiểm thử được không cần CSDL. */
export function buildDecisionRow(agg: Agg, dimension: AdsDimension, spend: number, spendKnown: boolean): AdsDecisionRow {
  const contributionBeforeAds = agg.deliveredRevenue - agg.cogs - agg.shipping;
  const spendForRatio = spendKnown ? spend : 0;
  const profitAfterAds = contributionBeforeAds - spendForRatio;
  const finished = agg.deliveredOrders + agg.returnedOrders;
  const maturity = agg.bookedOrders > 0 ? finished / agg.bookedOrders : 0;
  const marginRate = agg.deliveredRevenue > 0 ? round2(contributionBeforeAds / agg.deliveredRevenue) : null;
  /**
   * Tỷ lệ doanh thu SỐNG SÓT: bao nhiêu đồng doanh thu lên đơn thật sự tới tay khách. Đo thẳng từ
   * dữ liệu, KHÔNG suy từ tỷ lệ ĐƠN — đơn to và đơn nhỏ hoàn với tỷ lệ khác nhau.
   */
  const deliveredShare = agg.bookedRevenue > 0 ? agg.deliveredRevenue / agg.bookedRevenue : null;

  const breakEvenDeliveredRoas = marginRate !== null && marginRate > 0 ? round2(1 / marginRate) : null;
  const breakEvenBookedRoas =
    marginRate !== null && marginRate > 0 && deliveredShare !== null && deliveredShare > 0
      ? round2(1 / (marginRate * deliveredShare))
      : null;

  // Khoảng cách tới hoà vốn = lợi nhuận góp trước QC ÷ tiền QC. ≥ 1 ⟺ có lãi sau quảng cáo.
  const headroom = spendKnown && spendForRatio > 0 ? round2(contributionBeforeAds / spendForRatio) : null;

  const rate = successRate(agg.deliveredOrders, agg.returnedOrders);
  const bookedRoas = spendKnown ? ratio(agg.bookedRevenue, spendForRatio) : null;

  const { action, reason, lowDelivery } = decideAction({
    spendKnown,
    spend: spendForRatio,
    headroom,
    successRate: rate,
    maturity,
    finishedOrders: finished,
    bookedRoas,
    breakEvenBookedRoas,
    deliveredOrders: agg.deliveredOrders,
  });

  return {
    key: agg.key,
    name: agg.name,
    dimension,
    spendKnown,
    spend: spendForRatio,
    bookedOrders: agg.bookedOrders,
    deliveredOrders: agg.deliveredOrders,
    returnedOrders: agg.returnedOrders,
    openOrders: agg.openOrders,
    bookedRevenue: agg.bookedRevenue,
    deliveredRevenue: agg.deliveredRevenue,
    cashReceived: agg.cash,
    cogs: agg.cogs,
    shippingCost: agg.shipping,
    contributionBeforeAds,
    profitAfterAds,
    successRate: rate,
    maturity: Math.round(maturity * 100) / 100,
    marginRate,
    bookedRoas,
    deliveredRoas: spendKnown ? ratio(agg.deliveredRevenue, spendForRatio) : null,
    cashRoas: spendKnown ? ratio(agg.cash, spendForRatio) : null,
    breakEvenDeliveredRoas,
    breakEvenBookedRoas,
    headroom,
    cacDelivered: spendKnown && agg.deliveredOrders > 0 ? Math.round(spendForRatio / agg.deliveredOrders) : null,
    action,
    reason,
    lowDelivery,
  };
}

async function decisionUncached(period: Period, dimension: AdsDimension): Promise<AdsDecision> {
  const spendKnown = ADS_DIMENSION_HAS_SPEND[dimension];
  const [aggs, spend, coverage] = await Promise.all([
    dimension === "product" ? aggregateByProduct(period) : aggregateByOrder(period, dimension),
    spendByKey(period, dimension),
    adsAttributionCoverage(period.from, period.to),
  ]);

  const rows: AdsDecisionRow[] = [];
  const seen = new Set<string>();
  for (const agg of aggs) {
    seen.add(agg.key);
    rows.push(buildDecisionRow(agg, dimension, spend.get(agg.key)?.spend ?? 0, spendKnown));
  }

  /**
   * TIỀN ĐÃ TIÊU MÀ KHÔNG CÓ ĐƠN NÀO GẮN VÀO — vẫn phải hiện, đó là tiền đã mất dấu.
   *
   * Chỉ có nghĩa ở cấp CÓ chi tiêu; ở cấp mẩu/nhóm, khoá không cùng không gian nên mọi chiến dịch
   * sẽ trông như "không có đơn nào", một kết luận sai hoàn toàn.
   */
  let spendWithoutOrders = 0;
  const withoutOrders = new Set<string>();
  if (spendKnown) {
    for (const [key, value] of spend) {
      if (seen.has(key) || value.spend <= 0) continue;
      spendWithoutOrders += value.spend;
      withoutOrders.add(key);
      rows.push(
        buildDecisionRow(
          {
            key,
            name: value.name || key,
            bookedOrders: 0,
            deliveredOrders: 0,
            returnedOrders: 0,
            openOrders: 0,
            bookedRevenue: 0,
            deliveredRevenue: 0,
            cash: 0,
            cogs: 0,
            shipping: 0,
          },
          dimension,
          value.spend,
          true,
        ),
      );
    }
  }

  const totals = rows.reduce(
    (t, r) => ({
      spend: t.spend + r.spend,
      bookedRevenue: t.bookedRevenue + r.bookedRevenue,
      deliveredRevenue: t.deliveredRevenue + r.deliveredRevenue,
      cashReceived: t.cashReceived + r.cashReceived,
      contributionBeforeAds: t.contributionBeforeAds + r.contributionBeforeAds,
      profitAfterAds: t.profitAfterAds + r.profitAfterAds,
      deliveredOrders: t.deliveredOrders + r.deliveredOrders,
      bookedOrders: t.bookedOrders + r.bookedOrders,
    }),
    {
      spend: 0,
      bookedRevenue: 0,
      deliveredRevenue: 0,
      cashReceived: 0,
      contributionBeforeAds: 0,
      profitAfterAds: 0,
      deliveredOrders: 0,
      bookedOrders: 0,
    },
  );

  const pending = {
    // Hai nhóm này phải RỜI NHAU: dòng "có chi mà không có đơn" cũng rơi vào INSUFFICIENT_DATA (0 đơn
    // kết thúc), cộng cả hai là đếm cùng một đồng hai lần trên thẻ "Tiền chưa kết luận được".
    spendInsufficientData: rows.filter((r) => r.action === "INSUFFICIENT_DATA" && !withoutOrders.has(r.key)).reduce((t, r) => t + r.spend, 0),
    spendWithoutOrders,
    openOrders: rows.reduce((t, r) => t + r.openOrders, 0),
  };

  // Việc cần làm ngay đứng trước; trong cùng nhóm thì dòng động tới nhiều tiền hơn đứng trước.
  rows.sort(
    (a, b) =>
      ADS_ACTION_ORDER[a.action] - ADS_ACTION_ORDER[b.action] ||
      Math.abs(b.profitAfterAds) - Math.abs(a.profitAfterAds) ||
      b.spend - a.spend ||
      b.deliveredRevenue - a.deliveredRevenue,
  );

  return {
    period,
    dimension,
    rows,
    totals,
    pending,
    confidence: {
      coveragePct: coverage.coveragePct,
      verdict: coverageVerdict(coverage.coveragePct, LOW_COVERAGE_PCT),
      threshold: LOW_COVERAGE_PCT,
      attributedOrders: coverage.uniqueDeterministic,
      totalOrders: coverage.total,
    },
  };
}

export async function getAdsDecision(period: Period, dimension: AdsDimension = "campaign"): Promise<AdsDecision> {
  return memo(`adsDecision:${periodKey(period)}:${dimension}`, 90_000, () => decisionUncached(period, dimension));
}

export const DECISION_METRIC_HINT = {
  spend: "Tiền quảng cáo đã tiêu trong kỳ, lấy từ Facebook Insights (cấp chiến dịch/ngày) và các dòng nhập tay. Đã bỏ chiến dịch đánh dấu 'không tính'.",
  bookedRevenue: "Doanh thu LÊN ĐƠN: tổng giá trị đơn đã chốt. Chưa nói gì về việc giao được hay thu được tiền.",
  deliveredRevenue:
    "Doanh thu GIAO THÀNH CÔNG: giá trị đơn ĐÃ tới tay khách, theo ORDER_OUTCOME. Không suy ra từ COD, từ thanh toán, hay từ trạng thái Pancake.",
  cashReceived:
    "Tiền CÓ CHỨNG TỪ đã về: thực thu theo bảng kê Viettel Post cộng tiền khách chuyển trước. Chênh với doanh thu giao thành công là tiền ĐVVC còn giữ.",
  contributionBeforeAds:
    "Lợi nhuận góp TRƯỚC quảng cáo = doanh thu giao thành công − giá vốn − cước. Cước tính cả trên đơn hoàn, vì đơn hoàn vẫn tốn cước.",
  profitAfterAds:
    "Lợi nhuận góp SAU quảng cáo = lợi nhuận góp trước quảng cáo − tiền quảng cáo. Cố ý KHÔNG trừ chi phí cố định, thuế hay lương: những khoản đó không đổi theo việc tăng/giảm ngân sách một chiến dịch, đưa vào chỉ làm nhiễu phép so sánh.",
  successRate:
    "Tỷ lệ giao thành công = giao thành công ÷ (giao thành công + hoàn), tính trên ĐƠN ĐÃ KẾT THÚC. Đơn đang đi không nằm ở mẫu số.",
  maturity: "Phần đơn đã ngã ngũ trên tổng đơn đã lên. Thấp nghĩa là phần hoàn chưa về hết — lợi nhuận đang đẹp hơn sự thật.",
  breakEvenDeliveredRoas:
    "ROAS GIAO THÀNH CÔNG cần đạt để hoà vốn = 1 ÷ biên lợi nhuận góp. Mỗi mã hàng một biên khác nhau, nên một ngưỡng ROAS chung cho cả shop là vô nghĩa.",
  breakEvenBookedRoas:
    "ROAS LÊN ĐƠN cần đạt để hoà vốn — đã tính cả phần đơn sẽ hoàn. Đây là con số so trực tiếp được với ROAS trên Facebook Ads Manager.",
  headroom:
    "Khoảng cách tới điểm hoà vốn = lợi nhuận góp trước quảng cáo ÷ tiền quảng cáo. 1,0× là hoà vốn; 1,3× là dư 30%; 0,5× là mất một nửa số tiền đã tiêu.",
  cacDelivered: "Tiền quảng cáo cho MỘT khách cầm được hàng. So nó với lợi nhuận góp một đơn để biết còn chạy được không.",
} as const;
