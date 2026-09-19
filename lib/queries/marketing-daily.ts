import { and, eq, sql, sum, type SQL } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { allocatedExpenseByDay } from "@/lib/queries/cost-allocation";
import { lineUnitCost } from "@/lib/queries/cogs";
import { variantLastCostSubquery } from "@/lib/queries/stock";
import { marketerLabel, marketerNames as employeeNames } from "@/lib/queries/order-marketer";
import { ORDER_CAMPAIGN_ID } from "@/lib/queries/ads-attribution-link";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { spendPeriod } from "@/lib/queries/ads-roas";
import { metricScope } from "@/lib/queries/metrics";
import { pnlFacts } from "@/lib/queries/reports";
import {
  MARKETING_BASIS_DEFAULT,
  MARKETING_DIMENSION_SPEND,
  MARKETING_SOURCES,
  MARKETING_UNATTRIBUTED,
  MARKETING_UNATTRIBUTED_LABEL,
  maturityState,
  ratioOf,
  type MarketingBasis,
  type MarketingDimension,
  type MaturityState,
} from "@/lib/constants/marketing-daily";

/** Tỷ lệ tính ở tệp hằng số (dùng chung với màn hình) — chuyển tiếp để nơi gọi cũ không phải đổi đường nhập. */
export { ratioOf };
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ HIỆU QUẢ MARKETING THEO NGÀY — MỘT DÒNG LÀ MỘT NGÀY ═══════════
 *
 * Hợp đồng: `lib/constants/marketing-daily.ts` · đặc tả: `docs/marketing-daily-contract.md`.
 *
 * ─── TỆP NÀY KHÔNG CÓ MỘT ĐỊNH NGHĨA TIỀN NÀO CỦA RIÊNG NÓ ───
 *
 * Doanh thu, giá vốn, cước, kết quả đơn và population đều đi qua `pnlFacts()` — CHÍNH bảng dẫn
 * xuất mà `getDailyBreakdown` (Báo cáo lợi nhuận) dùng. Cái tệp này thêm vào chỉ có ba thứ:
 *
 *   1. một vị ngữ LỌC THEO CHIỀU (marketer / mã hàng / fanpage / chiến dịch / adset / mẩu / nguồn);
 *   2. phễu marketing từ `ad_spends` (chi · tin nhắn) gộp theo cùng ngày;
 *   3. ĐỘ CHÍN — bao nhiêu phần đơn của ngày đã ngã ngũ.
 *
 * `tests/marketing-daily.test.ts` đối chiếu từng ngày với `getDailyBreakdown` trên cùng kỳ. Lệch
 * một đồng là đỏ, nên không có đường nào để hai báo cáo trôi xa nhau.
 *
 * ─── VÌ SAO TRÙNG ĐƠN ĐƯỢC ĐẾM RIÊNG THAY VÌ BỊ XOÁ KHỎI BẢNG ───
 *
 * Quy kết marketer loại đơn `DUPLICATE` (một lần đặt bị nhập hai lần), còn Báo cáo lợi nhuận thì
 * không. Nếu tệp này im lặng loại chúng thì hai báo cáo lệch nhau và không ai giải thích được vì
 * sao. Nên mỗi ngày mang thêm khối `duplicates`: phần đã bị loại, ghi rõ bằng số. Tổng của bảng
 * cộng khối đó lại phải BẰNG Báo cáo lợi nhuận — đó là định nghĩa của "giải thích được".
 */

const o = schema.orders;
const oa = schema.orderAttributions;
const ads = schema.adSpends;

/* ═══════════════════ BỘ LỌC CHIỀU ═══════════════════ */

export type MarketingFilters = {
  marketerId?: string | null;
  productId?: string | null;
  pageId?: string | null;
  campaignId?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  source?: string | null;
};

/** Có bật bộ lọc chiều nào không — quyết định chi phí vận hành có chia được hay không. */
export function hasDimensionFilter(f: MarketingFilters): boolean {
  return Boolean(f.marketerId || f.productId || f.pageId || f.campaignId || f.adsetId || f.adId || f.source);
}

/**
 * ĐƠN BỊ KẾT LUẬN TRÙNG — theo ẢNH CHỤP quy kết, không tự xét lại.
 *
 * `order_attributions` là nơi DUY NHẤT kết luận trùng đơn, kèm điểm chứng cứ và lý do. Viết lại
 * phép xét ở đây là dựng một luật trùng đơn thứ hai, và hai luật thì có ngày chúng bắt khác nhau.
 */
const IS_DUPLICATE_ORDER = sql`exists (select 1 from ${oa} where ${oa.orderId} = ${o.id} and ${oa.status} = 'DUPLICATE')`;

/**
 * VỊ NGỮ LỌC THEO CHIỀU — chỉ THU HẸP, không bao giờ mở rộng.
 *
 * Quy kết marketer đi bằng ẢNH CHỤP `order_attributions` chứ KHÔNG bằng bảng phân công hiện tại:
 * fanpage chuyển người ngày 15/09 thì đơn ngày 05/09 vẫn thuộc người cũ (AGENTS.md — luật bất biến
 * 1 của `lib/constants/fanpage-attribution.ts`). Một câu `join` tới bảng phân công "đang mở" sẽ làm
 * mọi báo cáo tháng trước đổi số vào đúng cái ngày shop đổi người.
 */
function dimensionFilter(f: MarketingFilters): SQL | undefined {
  const conds: SQL[] = [];
  if (f.marketerId) {
    conds.push(
      f.marketerId === MARKETING_UNATTRIBUTED
        ? sql`not exists (select 1 from ${oa} where ${oa.orderId} = ${o.id} and ${oa.status} = 'ATTRIBUTED')`
        : sql`exists (select 1 from ${oa} where ${oa.orderId} = ${o.id} and ${oa.status} = 'ATTRIBUTED' and ${oa.marketerId} = ${f.marketerId})`,
    );
  }
  if (f.pageId) conds.push(f.pageId === MARKETING_UNATTRIBUTED ? sql`(${o.pageId} is null or ${o.pageId} = '')` : sql`${o.pageId} = ${f.pageId}`);
  if (f.campaignId) {
    conds.push(f.campaignId === MARKETING_UNATTRIBUTED ? sql`${ORDER_CAMPAIGN_ID} is null` : sql`${ORDER_CAMPAIGN_ID} = ${f.campaignId}`);
  }
  if (f.adsetId) conds.push(sql`exists (select 1 from fb_ads fa where fa.id = ${o.adId} and fa.adset_id = ${f.adsetId})`);
  if (f.adId) conds.push(sql`${o.adId} = ${f.adId}`);
  if (f.source) conds.push(sql`${o.source} = ${f.source}`);
  // Mã hàng lọc ở cấp ĐƠN CÓ CHỨA mã; phần tiền thì phân bổ theo DÒNG (xem `productDayRows`).
  if (f.productId) {
    conds.push(sql`exists (
      select 1 from order_items oi
      left join product_variants pvx on pvx.id = oi.variant_id
      where oi.order_id = ${o.id} and coalesce(pvx.product_id, oi.product_id) = ${f.productId}
    )`);
  }
  return conds.length ? (and(...conds) as SQL) : undefined;
}

/* ═══════════════════ HÌNH DẠNG KẾT QUẢ ═══════════════════ */

/** Số cộng được của một ngày. Mọi TỶ LỆ đều tính lại từ đây, không bao giờ lấy trung bình. */
export type MarketingDailyBase = {
  adSpend: number | null;
  messages: number | null;
  orders: number;
  units: number;
  posRevenue: number;
  deliveredRevenue: number;
  deliveredOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  pendingOrders: number;
  shippedOrders: number;
  finishedOrders: number;
  /** Mẫu số của độ chín: đã kết thúc + đang đi. Đơn HUỶ không nằm ở đây. */
  maturityBase: number;
  cogs: number;
  shippingCost: number;
  /** `null` khi có bộ lọc chiều: chi phí vận hành của cả shop không chia được cho một chiến dịch. */
  operatingCost: number | null;
  contributionProfit: number | null;
  netProfit: number | null;
};

export type MarketingDailyRow = MarketingDailyBase & {
  day: string;
  maturity: MaturityState;
  /** Chi tiêu của ngày này có quan sát được không. `false` ⇒ mọi ô chia cho chi tiêu là `—`. */
  spendKnown: boolean;
  /** Phần đã bị loại vì trùng đơn — để tổng của bảng còn nối lại được với Báo cáo lợi nhuận. */
  duplicates: { orders: number; deliveredRevenue: number; profitDelta: number };
};

export type MarketingSourceFreshness = {
  job: string;
  label: string;
  lastOkAt: Date | null;
  minutesAgo: number | null;
  stale: boolean;
  staleMinutes: number;
};

export type MarketingDaily = {
  period: Period;
  basis: MarketingBasis;
  filters: MarketingFilters;
  rows: MarketingDailyRow[];
  /** Hàng TỔNG: số cộng được thì cộng, tỷ lệ thì TÍNH LẠI từ tử/mẫu đã cộng. */
  totals: MarketingDailyBase & { maturity: MaturityState; spendKnown: boolean };
  /** Cùng hình dạng, cho kỳ liền trước — để in mũi tên ↑/↓ mà không phải gọi lại từ màn hình. */
  previousTotals: (MarketingDailyBase & { maturity: MaturityState; spendKnown: boolean }) | null;
  freshness: MarketingSourceFreshness[];
  /**
   * BIÊN QUAN SÁT CHI TIÊU — ngày gần nhất mà nguồn chi quảng cáo đã nói tới (`YYYY-MM-DD`, giờ VN).
   *
   * Đây là ranh giới giữa "hôm đó không chạy quảng cáo" (⇒ `0 ₫`) và "chưa ai đo hôm đó"
   * (⇒ `—`, và do đó lợi nhuận cũng CHƯA BIẾT). Nó phải đọc được từ bên ngoài vì đó là lời giải
   * thích duy nhất được phép cho chênh lệch với Báo cáo lợi nhuận — báo cáo ấy coi chi tiêu chưa
   * có là 0 và vẫn chốt một con số lợi nhuận.
   *
   * `null` = chưa từng có dòng chi tiêu nào, hoặc chiều đang lọc không có số chi.
   */
  spendObservedThrough: string | null;
  /** Vì sao một cột có thể trống — hiện thẳng trên màn hình, không để người đọc tự đoán. */
  warnings: string[];
};

const EMPTY_BASE = (): MarketingDailyBase => ({
  adSpend: null,
  messages: null,
  orders: 0,
  units: 0,
  posRevenue: 0,
  deliveredRevenue: 0,
  deliveredOrders: 0,
  returnedOrders: 0,
  cancelledOrders: 0,
  pendingOrders: 0,
  shippedOrders: 0,
  finishedOrders: 0,
  maturityBase: 0,
  cogs: 0,
  shippingCost: 0,
  operatingCost: null,
  contributionProfit: null,
  netProfit: null,
});

/* ═══════════════════ TỶ LỆ — MỘT ĐƯỜNG TÍNH, DÙNG CHO CẢ DÒNG LẪN HÀNG TỔNG ═══════════════════ */


/** Cộng hai ngày lại. `null` + số = số; `null` + `null` = `null` (chưa biết cộng chưa biết vẫn chưa biết). */
function addMaybe(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function sumBases(rows: MarketingDailyBase[]): MarketingDailyBase {
  const t = EMPTY_BASE();
  for (const r of rows) {
    t.adSpend = addMaybe(t.adSpend, r.adSpend);
    t.messages = addMaybe(t.messages, r.messages);
    t.operatingCost = addMaybe(t.operatingCost, r.operatingCost);
    t.orders += r.orders;
    t.units += r.units;
    t.posRevenue += r.posRevenue;
    t.deliveredRevenue += r.deliveredRevenue;
    t.deliveredOrders += r.deliveredOrders;
    t.returnedOrders += r.returnedOrders;
    t.cancelledOrders += r.cancelledOrders;
    t.pendingOrders += r.pendingOrders;
    t.shippedOrders += r.shippedOrders;
    t.finishedOrders += r.finishedOrders;
    t.maturityBase += r.maturityBase;
    t.cogs += r.cogs;
    t.shippingCost += r.shippingCost;
  }
  t.contributionProfit = profitOf(t);
  t.netProfit = t.operatingCost === null ? null : (t.contributionProfit === null ? null : t.contributionProfit - t.operatingCost);
  return t;
}

/**
 * LỢI NHUẬN GÓP SAU QUẢNG CÁO = DT thực − giá vốn − cước/phí hoàn/phí sàn − chi quảng cáo.
 *
 * Chi quảng cáo CHƯA BIẾT ⇒ cả ô là `null`. Coi nó bằng 0 để "vẫn ra một con số" là in ra một khoản
 * lãi không có thật đúng vào ngày đồng bộ Facebook chết — loại sai nguy hiểm nhất của bảng này.
 */
function profitOf(b: MarketingDailyBase): number | null {
  if (b.adSpend === null) return null;
  return b.deliveredRevenue - b.cogs - b.shippingCost - b.adSpend;
}

/* ═══════════════════ ĐỌC SỐ ═══════════════════ */

const vnDayCol = (col: SQL) => sql<string>`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

/**
 * PHẠM VI CHI TIÊU = kỳ (dùng lại `spendPeriod` — MỘT định nghĩa kỳ chi tiêu cho cả ROAS, bảng
 * quyết định và báo cáo này) + các chiều lọc của riêng báo cáo này.
 */
function marketingSpendScope(period: Period, f: MarketingFilters): SQL | undefined {
  const conds: SQL[] = [spendPeriod(period.from, period.to) as SQL];
  if (f.marketerId) conds.push(f.marketerId === MARKETING_UNATTRIBUTED ? sql`${ads.marketerId} is null` : eq(ads.marketerId, f.marketerId));
  if (f.productId) conds.push(eq(ads.productId, f.productId));
  if (f.campaignId && f.campaignId !== MARKETING_UNATTRIBUTED) conds.push(sql`coalesce(${ads.campaignId}, ${ads.campaign}) = ${f.campaignId}`);
  return and(...conds);
}

/**
 * CHI TIÊU & TIN NHẮN THEO NGÀY.
 *
 * Trả về `null` (chứ không phải map rỗng) khi chiều đang lọc KHÔNG CÓ số chi: Facebook Insights
 * đồng bộ ở cấp chiến dịch/ngày, nên lọc theo adset / mẩu quảng cáo / fanpage / nguồn đơn thì
 * không tồn tại con số chi tiêu nào để đọc. Chia đều tiền chiến dịch xuống các mẩu để bảng trông
 * đầy đủ là bịa — cùng luật với `lib/queries/ads-roas.ts`.
 */
async function spendByDay(db: Db, period: Period, f: MarketingFilters): Promise<{ byDay: Map<string, { spend: number; messages: number }>; observedThrough: string | null } | null> {
  const noSpendDimension = Boolean(f.adsetId || f.adId || f.pageId || f.source);
  if (noSpendDimension) return null;
  const [rows, frontier] = await Promise.all([
    db
      .select({
        day: vnDayCol(sql`${ads.spendDate}`),
        spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
        messages: sql<number>`coalesce(sum(greatest(${ads.messages}, ${ads.leads})), 0)`,
      })
      .from(ads)
      .where(marketingSpendScope(period, f))
      .groupBy(sql`1`),
    /*
      ═══ BIÊN QUAN SÁT: NGÀY GẦN NHẤT MÀ NGUỒN CHI TIÊU ĐÃ NÓI TỚI ═══

      Đây là chỗ phân biệt được hai thứ trông giống hệt nhau trong CSDL — "hôm đó không chạy quảng
      cáo" và "hôm đó đồng bộ chưa chạy" — mà không cần một cột trạng thái nào.

      Bên TRONG biên, việc KHÔNG có dòng nào là một phép đo thật: Facebook đã báo cáo về khoảng
      thời gian ấy và không có chiến dịch nào tiêu tiền ngày đó ⇒ chi tiêu bằng **0**.
      Bên NGOÀI biên, chưa nguồn nào nói gì về ngày đó ⇒ **CHƯA BIẾT**, in `—`.

      Bản đầu tiên coi MỌI ngày không có dòng là CHƯA BIẾT. Cổng đối soát bắt ngay: một ngày lãi
      500.000đ không chạy quảng cáo bị in thành `—`, và làm lệch luôn tổng lợi nhuận so với Báo cáo
      lợi nhuận. Thận trọng quá tay cũng là một loại sai — nó xoá mất những ngày có lãi thật.

      Biên đọc trên TOÀN BẢNG, cố ý KHÔNG giới hạn theo kỳ đang xem: kỳ "tháng trước" nằm trọn
      trong vùng đã quan sát, và một câu `max` giới hạn theo kỳ sẽ dựng lại đúng cái bẫy cũ.
    */
    db.select({ day: vnDayCol(sql`max(${ads.spendDate})`) }).from(ads).where(eq(ads.excluded, false)),
  ]);
  return {
    byDay: new Map(rows.map((r) => [r.day, { spend: Number(r.spend), messages: Number(r.messages) }])),
    observedThrough: frontier[0]?.day ?? null,
  };
}

/** Số lượng sản phẩm theo ngày — grain DÒNG ĐƠN, nên phải là truy vấn riêng chứ không nằm trong bảng dẫn xuất cấp đơn. */
async function unitsByDay(db: Db, period: Period, basis: MarketingBasis, extra: SQL | undefined): Promise<Map<string, number>> {
  const dayCol = basis === "delivered" ? sql`coalesce(${schema.shipments.deliveredAt}, ${o.insertedAt})` : sql`${o.insertedAt}`;
  const conds: SQL[] = [metricScope(period, "confirmed"), sql`not ${IS_DUPLICATE_ORDER}`];
  if (extra) conds.push(extra);
  const rows = await db
    .select({ day: vnDayCol(dayCol), units: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
    .from(o)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, o.id))
    .where(and(...conds, sql`${ORDER_OUTCOME_FAST} <> 'CANCELLED'`))
    .groupBy(sql`1`);
  return new Map(rows.map((r) => [r.day, Number(r.units)]));
}

/**
 * TIỀN VÀ ĐƠN THEO NGÀY, PHÂN BỔ THEO DÒNG — chỉ dùng khi lọc theo MÃ HÀNG.
 *
 * Một đơn có hai mã hàng thì doanh thu của nó KHÔNG thuộc trọn về mã nào cả. Cước là chi phí của
 * CẢ ĐƠN nên **căn cứ phân bổ là tỷ trọng doanh thu dòng trong đơn** — khai rõ trước khi nhân
 * (AGENTS.md mục 14), và đúng căn cứ mà `lib/queries/ads-decision.ts` đã dùng cho bảng theo mã, để
 * hai báo cáo không nói hai con số về cùng một mã.
 *
 * Số ĐƠN vẫn đếm `count(distinct)`: một đơn hai mã vẫn là MỘT đơn của mỗi mã.
 */
async function productDayRows(db: Db, period: Period, basis: MarketingBasis, f: MarketingFilters, extra: SQL | undefined) {
  const i = schema.orderItems;
  const pv = schema.productVariants;
  const s = schema.shipments;
  const lastCost = variantLastCostSubquery(db);
  const dayCol = basis === "delivered" ? sql`coalesce(${s.deliveredAt}, ${o.insertedAt})` : sql`${o.insertedAt}`;
  const conds: SQL[] = [metricScope(period, "confirmed"), sql`coalesce(${pv.productId}, ${i.productId}) = ${f.productId}`];
  if (extra) conds.push(extra);

  const facts = db
    .select({
      day: vnDayCol(dayCol).as("md_day"),
      orderId: sql<string>`${o.id}`.as("md_order"),
      lineRevenue: sql<number>`coalesce(${i.lineTotal}, 0)`.as("md_line_revenue"),
      lineCogs: sql<number>`${i.quantity} * ${lineUnitCost(lastCost)}`.as("md_line_cogs"),
      qty: sql<number>`coalesce(${i.quantity}, 0)`.as("md_qty"),
      shipShare: sql<number>`coalesce(${i.lineTotal}, 0) / nullif(sum(coalesce(${i.lineTotal}, 0)) over (partition by ${o.id}), 0)`.as("md_ship_share"),
      orderShipping: sql<number>`coalesce(${o.partnerFee}, 0) + coalesce(${o.returnFee}, 0) + coalesce(${o.feeMarketplace}, 0)`.as("md_ship"),
      outcome: ORDER_OUTCOME_FAST.as("md_outcome"),
      duplicate: sql<boolean>`${IS_DUPLICATE_ORDER}`.as("md_dup"),
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .innerJoin(i, eq(i.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .leftJoin(lastCost, eq(lastCost.variantId, i.variantId))
    .where(and(...conds))
    .offset(OUTCOME_FENCE)
    .as("md_product_facts");

  const delivered = sql`${facts.outcome} = 'DELIVERED'`;
  const returned = sql`${facts.outcome} in ('RETURNED','RETURNED_BY_RULE')`;
  const booked = sql`${facts.outcome} <> 'CANCELLED'`;
  const open = sql`${facts.outcome} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN')`;
  const shipped = sql`${facts.outcome} in ('DELIVERED','RETURNED','RETURNED_BY_RULE','IN_TRANSIT')`;
  const live = sql`not ${facts.duplicate}`;
  const cnt = (cond: SQL) => sql<number>`count(distinct ${facts.orderId}) filter (where ${cond} and ${live})`;
  const money = (expr: SQL, cond: SQL) => sql<number>`coalesce(sum(${expr}) filter (where ${cond} and ${live}), 0)`;

  return db
    .select({
      day: sql<string>`${facts.day}`,
      orders: cnt(booked),
      units: sql<number>`coalesce(sum(${facts.qty}) filter (where ${booked} and ${live}), 0)`,
      posRevenue: money(sql`${facts.lineRevenue}`, booked),
      deliveredRevenue: money(sql`${facts.lineRevenue}`, delivered),
      deliveredOrders: cnt(delivered),
      returnedOrders: cnt(returned),
      cancelledOrders: cnt(sql`${facts.outcome} = 'CANCELLED'`),
      pendingOrders: cnt(open),
      shippedOrders: cnt(shipped),
      cogs: money(sql`${facts.lineCogs}`, delivered),
      shippingCost: money(sql`${facts.orderShipping} * coalesce(${facts.shipShare}, 0)`, sql`(${delivered} or ${returned})`),
      dupOrders: sql<number>`count(distinct ${facts.orderId}) filter (where ${booked} and ${facts.duplicate})`,
      dupDeliveredRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${delivered} and ${facts.duplicate}), 0)`,
      dupCogs: sql<number>`coalesce(sum(${facts.lineCogs}) filter (where ${delivered} and ${facts.duplicate}), 0)`,
      dupShipping: sql<number>`coalesce(sum(${facts.orderShipping} * coalesce(${facts.shipShare}, 0)) filter (where (${delivered} or ${returned}) and ${facts.duplicate}), 0)`,
    })
    .from(facts)
    .groupBy(facts.day);
}

/** Đơn và tiền theo ngày ở grain ĐƠN — đi thẳng qua bảng dẫn xuất của Báo cáo lợi nhuận. */
async function orderDayRows(db: Db, period: Period, basis: MarketingBasis, extra: SQL | undefined) {
  const { base, predicates } = pnlFacts(db, basis, period.from, period.to, extra);
  const live = sql`not ${base.duplicate}`;
  const cnt = (cond: SQL) => sql<number>`count(*) filter (where ${cond} and ${live})`;
  const money = (expr: SQL, cond: SQL) => sql<number>`coalesce(sum(${expr}) filter (where ${cond} and ${live}), 0)`;
  const ship = sql`${base.partnerFee} + ${base.returnFee} + ${base.feeMarketplace}`;
  return db
    .select({
      day: base.day,
      orders: cnt(predicates.notCancelled as SQL),
      posRevenue: money(sql`${base.revenue}`, predicates.notCancelled as SQL),
      deliveredRevenue: money(sql`${base.revenue}`, predicates.success as SQL),
      deliveredOrders: cnt(predicates.success as SQL),
      returnedOrders: cnt(predicates.returned as SQL),
      cancelledOrders: cnt(predicates.cancelled as SQL),
      pendingOrders: cnt(sql`${base.outcome} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN')`),
      shippedOrders: cnt(predicates.shipped as SQL),
      cogs: money(sql`${base.cogs}`, predicates.success as SQL),
      // CƯỚC: cùng bậc thang với bộ máy lợi nhuận — cước của đơn ĐÃ GỬI, phí hoàn và phí sàn của
      // đơn không huỷ. Gộp thành một cột vì ba khoản đều là chi phí giao nhận của chính đơn đó.
      shippingCost: sql<number>`coalesce(sum(${base.partnerFee}) filter (where ${predicates.shipped} and ${live}), 0)
        + coalesce(sum(${base.returnFee} + ${base.feeMarketplace}) filter (where ${predicates.notCancelled} and ${live}), 0)`,
      dupOrders: sql<number>`count(*) filter (where ${predicates.notCancelled} and ${base.duplicate})`,
      dupDeliveredRevenue: sql<number>`coalesce(sum(${base.revenue}) filter (where ${predicates.success} and ${base.duplicate}), 0)`,
      dupCogs: sql<number>`coalesce(sum(${base.cogs}) filter (where ${predicates.success} and ${base.duplicate}), 0)`,
      dupShipping: sql<number>`coalesce(sum(${ship}) filter (where ${predicates.notCancelled} and ${base.duplicate}), 0)`,
    })
    .from(base)
    .groupBy(base.day)
    .orderBy(base.day);
}

/** Độ tươi của từng nguồn — đọc lượt đồng bộ THÀNH CÔNG gần nhất, không đọc lượt đang chạy. */
export async function marketingFreshness(db: Db): Promise<MarketingSourceFreshness[]> {
  const rows = await db
    .select({ job: schema.syncRuns.job, at: sql<Date | null>`max(${schema.syncRuns.finishedAt})` })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "SUCCESS"))
    .groupBy(schema.syncRuns.job);
  const byJob = new Map(rows.map((r) => [r.job, r.at ? new Date(r.at) : null]));
  const now = Date.now();
  return MARKETING_SOURCES.map((s) => {
    const at = byJob.get(s.job) ?? null;
    const minutesAgo = at ? Math.round((now - at.getTime()) / 60_000) : null;
    return { job: s.job, label: s.label, lastOkAt: at, minutesAgo, stale: minutesAgo === null || minutesAgo > s.staleMinutes, staleMinutes: s.staleMinutes };
  });
}

/* ═══════════════════ HÀM CHÍNH ═══════════════════ */

async function buildDays(db: Db, period: Period, basis: MarketingBasis, filters: MarketingFilters): Promise<{ rows: MarketingDailyRow[]; spendObservedThrough: string | null }> {
  const extra = dimensionFilter(filters);
  const filtered = hasDimensionFilter(filters);
  const [moneyRows, spend, units, allocated] = await Promise.all([
    filters.productId ? productDayRows(db, period, basis, filters, extra) : orderDayRows(db, period, basis, extra),
    spendByDay(db, period, filters),
    filters.productId ? Promise.resolve(null) : unitsByDay(db, period, basis, extra),
    // Chi phí vận hành phân bổ CHỈ có nghĩa ở mức toàn shop. Có bộ lọc ⇒ không đọc, và ô là `—`.
    filtered ? Promise.resolve(null) : allocatedExpenseByDay(db, period.from, period.to),
  ]);

  const map = new Map<string, MarketingDailyRow>();
  const get = (day: string): MarketingDailyRow => {
    let row = map.get(day);
    if (!row) {
      row = { day, ...EMPTY_BASE(), maturity: "NO_ORDERS", spendKnown: false, duplicates: { orders: 0, deliveredRevenue: 0, profitDelta: 0 } };
      map.set(day, row);
    }
    return row;
  };

  for (const r of moneyRows) {
    const row = get(r.day);
    row.orders = Number(r.orders);
    row.posRevenue = Number(r.posRevenue);
    row.deliveredRevenue = Number(r.deliveredRevenue);
    row.deliveredOrders = Number(r.deliveredOrders);
    row.returnedOrders = Number(r.returnedOrders);
    row.cancelledOrders = Number(r.cancelledOrders);
    row.pendingOrders = Number(r.pendingOrders);
    row.shippedOrders = Number(r.shippedOrders);
    row.cogs = Number(r.cogs);
    row.shippingCost = Number(r.shippingCost);
    if ("units" in r) row.units = Number((r as { units: number }).units);
    row.duplicates = {
      orders: Number(r.dupOrders),
      deliveredRevenue: Number(r.dupDeliveredRevenue),
      profitDelta: Number(r.dupDeliveredRevenue) - Number(r.dupCogs) - Number(r.dupShipping),
    };
  }
  if (units) for (const [day, qty] of units) get(day).units = qty;
  // Ngày chỉ có chi quảng cáo (không đơn nào) vẫn phải là một dòng: đó chính là ngày đốt tiền không ra gì.
  if (spend) for (const day of spend.byDay.keys()) get(day);
  const allocatedAds = new Map<string, number>();
  if (allocated) for (const [day, amounts] of allocated) {
    const row = get(day);
    // CÙNG CÁCH CỘNG với `getDailyBreakdown`: khoản chi nhóm Quảng cáo đã phân bổ đi vào chi quảng
    // cáo, phần còn lại đi vào chi phí vận hành. Không tự chọn cách khác, nếu không hai báo cáo lệch.
    if (amounts.ads) allocatedAds.set(day, (allocatedAds.get(day) ?? 0) + amounts.ads);
    row.operatingCost = (row.operatingCost ?? 0) + amounts.other;
  }

  const rows = [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const row of rows) {
    /*
      CHI TIÊU ĐƯỢC ĐIỀN Ở ĐÂY, SAU KHI MỌI NGUỒN ĐÃ TẠO XONG DÒNG NGÀY.

      Bản trước điền ngay sau lượt đọc `ad_spends`, nên một ngày chỉ có chi phí vận hành phân bổ
      (chưa tồn tại lúc đó) không bao giờ được điền — nó giữ `null`, kéo lợi nhuận về CHƯA BIẾT, và
      cổng đối soát bắt được đúng một ngày lệch 250.000đ so với Báo cáo lợi nhuận. Thứ tự các vòng
      lặp là một phần của phép tính, không phải chuyện sắp xếp mã.
    */
    if (spend) {
      const observed = spend.byDay.get(row.day);
      const inWindow = spend.observedThrough !== null && row.day <= spend.observedThrough;
      if (observed || inWindow) {
        row.spendKnown = true;
        row.adSpend = (observed?.spend ?? 0) + (allocatedAds.get(row.day) ?? 0);
        row.messages = observed?.messages ?? 0;
      }
    }
    row.finishedOrders = row.deliveredOrders + row.returnedOrders;
    row.maturityBase = row.finishedOrders + row.pendingOrders;
    row.maturity = maturityState(row.finishedOrders, row.pendingOrders);
    if (!filtered && row.operatingCost === null) row.operatingCost = 0;
    row.contributionProfit = profitOf(row);
    row.netProfit = row.operatingCost === null || row.contributionProfit === null ? null : row.contributionProfit - row.operatingCost;
  }
  return { rows, spendObservedThrough: spend?.observedThrough ?? null };
}

function rollupTotals(rows: MarketingDailyRow[]) {
  const base = sumBases(rows);
  return { ...base, maturity: maturityState(base.finishedOrders, base.pendingOrders), spendKnown: rows.some((r) => r.spendKnown) };
}

async function getMarketingDailyUncached(period: Period, basis: MarketingBasis, filters: MarketingFilters, previous: { from: Date | null; to: Date | null } | null): Promise<MarketingDaily> {
  const db = await getDb();
  const [built, freshness, prevBuilt] = await Promise.all([
    buildDays(db, period, basis, filters),
    marketingFreshness(db),
    previous?.from ? buildDays(db, { ...period, key: "custom", from: previous.from, to: previous.to }, basis, filters) : Promise.resolve(null),
  ]);
  const rows = built.rows;
  const prevRows = prevBuilt?.rows ?? null;

  const warnings: string[] = [];
  const filtered = hasDimensionFilter(filters);
  if (filtered) warnings.push("Đang lọc theo một chiều: chi phí vận hành phân bổ và Lợi nhuận canonical là CHƯA BIẾT (—) vì không có căn cứ chia chi phí toàn shop cho một chiến dịch. Dùng cột Lợi nhuận góp sau QC.");
  if (filters.adsetId || filters.adId || filters.pageId || filters.source) {
    warnings.push("Chiều đang lọc không có số chi quảng cáo (Facebook chỉ trả chi tiêu ở cấp chiến dịch/ngày), nên ROAS · CPQC/đơn · giá tin nhắn là CHƯA BIẾT — cố ý không chia đều tiền chiến dịch xuống.");
  }
  const staleSources = freshness.filter((f) => f.stale);
  for (const s of staleSources) {
    warnings.push(s.lastOkAt ? `${s.label}: lần đồng bộ thành công gần nhất cách đây ${s.minutesAgo} phút (ngưỡng ${s.staleMinutes} phút). Số của những ngày gần đây có thể còn thiếu.` : `${s.label}: chưa có lượt đồng bộ thành công nào được ghi nhận.`);
  }
  const unobserved = rows.filter((r) => !r.spendKnown && r.orders > 0);
  if (unobserved.length && !(filters.adsetId || filters.adId || filters.pageId || filters.source)) {
    /*
      NÓI THẲNG RA NGÀY NÀO CHƯA KẾT LUẬN ĐƯỢC.

      Đây cũng là câu giải thích cho chênh lệch với Báo cáo lợi nhuận: báo cáo ấy coi chi tiêu chưa
      có là 0 và vẫn chốt một con số. Ở đây thì không — trừ đi một số chưa biết không ra một con số.
    */
    warnings.push(
      `Nguồn chi quảng cáo mới đồng bộ tới ngày ${built.spendObservedThrough ?? "—"}. ${unobserved.length} ngày sau đó có đơn nhưng CHƯA BIẾT chi bao nhiêu, nên lợi nhuận của những ngày ấy để trống (—) thay vì chốt một con số. Báo cáo lợi nhuận coi phần chưa có là 0 nên sẽ cao hơn ở những ngày này.`,
    );
  }
  const dupDays = rows.filter((r) => r.duplicates.orders > 0);
  if (dupDays.length) {
    const dupOrders = dupDays.reduce((s, r) => s + r.duplicates.orders, 0);
    warnings.push(`Đã loại ${dupOrders} đơn bị kết luận TRÙNG (một lần đặt nhập hai lần) theo ảnh chụp quy kết. Vì vậy tổng ở đây nhỏ hơn Báo cáo lợi nhuận đúng bằng phần ấy — chênh lệch giải thích được, không phải sai số.`);
  }

  return {
    period,
    basis,
    filters,
    rows,
    totals: rollupTotals(rows),
    previousTotals: prevRows ? rollupTotals(prevRows) : null,
    freshness,
    spendObservedThrough: built.spendObservedThrough,
    warnings,
  };
}

/**
 * Đệm 60 giây như Báo cáo lợi nhuận: đủ để bấm qua lại giữa các chế độ mà không tính lại, và mọi
 * lượt ghi / job đồng bộ đều gọi `clearMemo()` nên số không thể cũ hơn sự kiện nghiệp vụ gần nhất.
 * MỌI tham số ảnh hưởng kết quả đều nằm trong khoá đệm (AGENTS.md mục 2).
 */
export async function getMarketingDaily(
  period: Period,
  basis: MarketingBasis = MARKETING_BASIS_DEFAULT,
  filters: MarketingFilters = {},
  previous: { from: Date | null; to: Date | null } | null = null,
): Promise<MarketingDaily> {
  const fkey = JSON.stringify([filters.marketerId ?? "", filters.productId ?? "", filters.pageId ?? "", filters.campaignId ?? "", filters.adsetId ?? "", filters.adId ?? "", filters.source ?? ""]);
  const pkey = previous?.from ? `${previous.from.toISOString()}~${previous.to?.toISOString() ?? ""}` : "-";
  return memo(`marketingDaily:${periodKey(period)}:${basis}:${fkey}:${pkey}`, 60_000, () => getMarketingDailyUncached(period, basis, filters, previous));
}

/* ═══════════════════ BÓC TÁCH MỘT NGÀY THEO CHIỀU ═══════════════════ */

export type MarketingBreakdownRow = MarketingDailyBase & {
  key: string;
  label: string;
  maturity: MaturityState;
  spendKnown: boolean;
};

/**
 * BÓC TÁCH: "ngày này lỗ — lỗ ở đâu?"
 *
 * Dùng lại ĐÚNG bộ lọc của bảng chính: mỗi nhóm là một lần gọi `buildDays` với chiều được ghim
 * thêm. Chậm hơn một câu `group by` duy nhất, nhưng đổi lại KHÔNG có đường nào để con số bóc tách
 * khác con số của chính dòng nó bóc — điều đã từng xảy ra ở những báo cáo có hai câu truy vấn.
 *
 * Nhóm KHÔNG quy kết được luôn có mặt và đứng CUỐI: giấu nó đi là làm tổng của bảng bóc tách nhỏ
 * hơn dòng gốc mà không ai giải thích được.
 */
export async function getMarketingBreakdown(
  period: Period,
  basis: MarketingBasis,
  dimension: MarketingDimension,
  filters: MarketingFilters = {},
  limit = 12,
): Promise<{ dimension: MarketingDimension; spendGrain: boolean; rows: MarketingBreakdownRow[] }> {
  const db = await getDb();
  const keys = await dimensionKeys(db, period, dimension, filters, limit);
  const rows: MarketingBreakdownRow[] = [];
  for (const k of keys) {
    const scoped: MarketingFilters = { ...filters, ...filterForDimension(dimension, k.key) };
    const { rows: days } = await buildDays(db, period, basis, scoped);
    const base = sumBases(days);
    rows.push({ ...base, key: k.key, label: k.label, maturity: maturityState(base.finishedOrders, base.pendingOrders), spendKnown: days.some((d) => d.spendKnown) });
  }
  rows.sort((a, b) => {
    const pa = a.contributionProfit;
    const pb = b.contributionProfit;
    if (pa === null && pb === null) return b.posRevenue - a.posRevenue;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb; // lỗ nặng nhất đứng đầu — thứ cần xử lý trước
  });
  return { dimension, spendGrain: MARKETING_DIMENSION_SPEND[dimension], rows };
}

function filterForDimension(dimension: MarketingDimension, key: string): MarketingFilters {
  switch (dimension) {
    case "marketer":
      return { marketerId: key };
    case "product":
      return { productId: key };
    case "page":
      return { pageId: key };
    case "campaign":
      return { campaignId: key };
    case "adset":
      return { adsetId: key };
    case "ad":
      return { adId: key };
    case "source":
      return { source: key };
  }
}

/** Các khoá đáng bóc tách — lấy theo doanh số POS giảm dần, cắt ở `limit`, luôn kèm nhóm chưa quy kết. */
async function dimensionKeys(db: Db, period: Period, dimension: MarketingDimension, filters: MarketingFilters, limit: number): Promise<{ key: string; label: string }[]> {
  const extra = dimensionFilter(filters);
  // Chọn KHOÁ thì chỉ cần population + kỳ + bộ lọc đang bật; tiền của từng nhóm do `buildDays` đọc
  // lại bằng đúng đường của bảng chính, nên ở đây không cần tới bảng dẫn xuất đắt tiền.
  const scope = and(metricScope(period, "confirmed"), extra);
  const rank = sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}), 0)`;

  if (dimension === "marketer") {
    const rows = await db
      .select({ key: sql<string | null>`(select ${oa.marketerId} from ${oa} where ${oa.orderId} = ${o.id} and ${oa.status} = 'ATTRIBUTED' limit 1)`, total: rank })
      .from(o)
      .where(scope)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(limit + 1);
    const names = await employeeNames();
    return rows.map((r) => ({ key: r.key ?? MARKETING_UNATTRIBUTED, label: r.key ? marketerLabel(r.key, names) : MARKETING_UNATTRIBUTED_LABEL }));
  }
  if (dimension === "product") {
    const rows = await db
      .select({
        key: sql<string>`coalesce(${schema.productVariants.productId}, ${schema.orderItems.productId})`,
        label: sql<string>`max(coalesce(nullif(${schema.products.name}, ''), ${schema.orderItems.productName}))`,
        total: sql<number>`coalesce(sum(${schema.orderItems.lineTotal}), 0)`,
      })
      .from(o)
      .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, o.id))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderItems.variantId))
      .leftJoin(schema.products, eq(schema.products.id, sql`coalesce(${schema.productVariants.productId}, ${schema.orderItems.productId})`))
      .where(scope)
      .groupBy(sql`1`)
      .orderBy(sql`3 desc`)
      .limit(limit);
    return rows.filter((r) => r.key).map((r) => ({ key: r.key, label: r.label || r.key }));
  }
  if (dimension === "campaign") {
    const rows = await db
      .select({ key: sql<string | null>`${ORDER_CAMPAIGN_ID}`, total: rank })
      .from(o)
      .where(scope)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(limit + 1);
    const names = await campaignNames();
    return rows.map((r) => ({ key: r.key ?? MARKETING_UNATTRIBUTED, label: r.key ? names.get(r.key) ?? r.key : MARKETING_UNATTRIBUTED_LABEL }));
  }
  if (dimension === "page") {
    const rows = await db.select({ key: sql<string | null>`${o.pageId}`, total: rank }).from(o).where(scope).groupBy(sql`1`).orderBy(sql`2 desc`).limit(limit);
    const pages = await db.select({ id: schema.fanpages.externalPageId, name: schema.fanpages.name, alias: schema.fanpages.alias }).from(schema.fanpages);
    const byId = new Map(pages.map((p) => [p.id, p.alias || p.name || p.id]));
    return rows.map((r) => ({ key: r.key || MARKETING_UNATTRIBUTED, label: r.key ? byId.get(r.key) ?? r.key : MARKETING_UNATTRIBUTED_LABEL }));
  }
  if (dimension === "source") {
    const rows = await db.select({ key: sql<string>`${o.source}`, total: rank }).from(o).where(scope).groupBy(sql`1`).orderBy(sql`2 desc`).limit(limit);
    return rows.filter((r) => r.key).map((r) => ({ key: r.key, label: r.key }));
  }
  // adset / ad — đi thẳng qua `fb_ads`, vì chỉ `ad_id` Pancake gửi mới nối được tới hai cấp này.
  const col = dimension === "adset" ? sql`fa.adset_id` : sql`fa.id`;
  const rows = await db
    .select({ key: sql<string | null>`(select ${col} from fb_ads fa where fa.id = ${o.adId})`, label: sql<string>`max((select fa.name from fb_ads fa where fa.id = ${o.adId}))`, total: rank })
    .from(o)
    .where(scope)
    .groupBy(sql`1`)
    .orderBy(sql`3 desc`)
    .limit(limit);
  return rows.filter((r) => r.key).map((r) => ({ key: r.key as string, label: r.label || (r.key as string) }));
}

async function campaignNames(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db
    .select({ id: sql<string>`coalesce(${ads.campaignId}, ${ads.campaign})`, name: sql<string>`max(${ads.campaign})` })
    .from(ads)
    .where(eq(ads.excluded, false))
    .groupBy(sql`1`);
  return new Map(rows.filter((r) => r.id).map((r) => [r.id, r.name || r.id]));
}

/** Tổng chi quảng cáo trong kỳ theo NGUỒN CÓ THẨM QUYỀN — dùng để đối soát với bảng. */
export async function adSpendTotal(period: Period): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ spend: sum(ads.spend) }).from(ads).where(marketingSpendScope(period, {}));
  return Number(row?.spend ?? 0);
}
