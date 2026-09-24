import { and, eq, sql, sum, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema, type Db } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { getOperatingCostByDay, type OperatingCostByDay } from "@/lib/queries/cost-engine";
import { COST_AUTHORITY, COST_SOURCE_LABEL, EXPENSE_CATEGORY_ECONOMIC } from "@/lib/constants/cost-sources";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/constants/expenses";
import { lineUnitCost } from "@/lib/queries/cogs";
import { variantLastCostSubquery } from "@/lib/queries/stock";
import { marketerLabel, marketerNames as employeeNames } from "@/lib/queries/order-marketer";
import { ORDER_CAMPAIGN_ID } from "@/lib/queries/ads-attribution-link";
import { OPEN_OUTCOMES_SQL } from "@/lib/constants/truth";
import { ELIGIBLE_SENT_SQL } from "@/lib/constants/returns";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { AD_MESSAGES, spendPeriod } from "@/lib/queries/ads-roas";
import { metricScope } from "@/lib/queries/metrics";
import { pnlFacts } from "@/lib/queries/reports";
import { orderDeliveryRateSql, productDeliveryRates, rateCoverage, type ProductDeliveryRates } from "@/lib/queries/delivery-rate";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import type { DeliveryRateSource } from "@/lib/constants/delivery-rate";
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
 *
 * XUẤT RA để công cụ chẩn đoán (`scripts/marketing-calibrate.ts --explain=…`) dựng được ĐÚNG tập
 * đơn mà màn hình đang đếm. Chép lại vị ngữ này sang một tệp thứ hai là cách chắc chắn nhất để một
 * bảng chi tiết cộng lại ra con số khác với ô nó đang giải thích — và khi ấy không ai biết tin cái
 * nào.
 */
export function dimensionFilter(f: MarketingFilters): SQL | undefined {
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
  /*
    ───────────── BỐN Ô ƯỚC TÍNH — ĐỨNG CẠNH Ô ĐO ĐƯỢC, KHÔNG THAY NÓ ─────────────

    Đơn của hôm nay chưa ai biết có giao được không, nên `deliveredRevenue` của một ngày mới gần
    bằng 0 trong khi tiền quảng cáo đã tiêu đủ — bảng vì thế ngày nào cũng âm, và một bảng ngày
    nào cũng âm thì không ai đọc nó để quyết định nữa.

    Bốn ô dưới đây trả lời câu khác: *"nếu số đơn đang đi về đích theo tỷ lệ của chính mã nó, thì
    ngày này lãi hay lỗ?"* Tỷ lệ lấy từ THANG BẬC chung (`lib/constants/delivery-rate.ts`) — ghi
    đè tay → số đo từng đơn → lịch sử của mã → tỷ lệ khai ở Giả định. Chúng LUÔN mang nhãn ước
    tính và KHÔNG được tô màu (AGENTS.md mục 8.6).

    `null` = chưa dựng được bản đồ tỷ lệ, hoặc chi quảng cáo chưa biết. Không bao giờ là 0.
  */
  projectedDeliveredRevenue: number | null;
  projectedCogs: number | null;
  projectedDeliveredOrders: number | null;
  projectedContributionProfit: number | null;
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
  /**
   * CĂN CỨ CỦA CÁC Ô ƯỚC TÍNH — bao nhiêu mã dùng số đo, bao nhiêu mã dùng tỷ lệ khai ở Giả định.
   * Một con số ước tính không đi kèm độ phủ thì đọc y hệt một con số đo được.
   */
  rateBasis: {
    /** Tỷ lệ giao thành công (%) dùng cho mã chưa có một quan sát nào — tỷ lệ khai ở Giả định. */
    fallbackDeliveryRate: number;
    coverage: Record<DeliveryRateSource, number>;
    projectionError: string | null;
  } | null;
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
  projectedDeliveredRevenue: null,
  projectedCogs: null,
  projectedDeliveredOrders: null,
  projectedContributionProfit: null,
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
    t.projectedDeliveredRevenue = addMaybe(t.projectedDeliveredRevenue, r.projectedDeliveredRevenue);
    t.projectedCogs = addMaybe(t.projectedCogs, r.projectedCogs);
    t.projectedDeliveredOrders = addMaybe(t.projectedDeliveredOrders, r.projectedDeliveredOrders);
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
  t.projectedContributionProfit = projectedProfitOf(t);
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

/**
 * LỢI NHUẬN GÓP ƯỚC TÍNH — cùng phép trừ, chỉ đổi hai vế doanh thu và giá vốn sang bản đã cân theo
 * tỷ lệ giao thành công của từng mã.
 *
 * ─── CƯỚC CỐ Ý GIỮ NGUYÊN SỐ ĐO ĐƯỢC, VÀ ĐÓ LÀ MỘT LỰA CHỌN CÓ HƯỚNG ───
 *
 * Phí hoàn của đơn đang đi CHƯA phát sinh, nên nó chưa nằm trong `shippingCost`. Dự phóng nó cần
 * thêm hai giả định nữa (cước gửi, cước hoàn) vào một tệp mà cả phần đầu khai là "không có một
 * định nghĩa tiền nào của riêng nó". Nên ô này LẠC QUAN đúng bằng phần phí hoàn chưa phát sinh —
 * và hợp đồng cột nói thẳng điều đó thay vì để người đọc tự phát hiện.
 */
function projectedProfitOf(b: MarketingDailyBase): number | null {
  if (b.adSpend === null || b.projectedDeliveredRevenue === null || b.projectedCogs === null) return null;
  return b.projectedDeliveredRevenue - b.projectedCogs - b.shippingCost - b.adSpend;
}

/* ═══════════════════ ĐỌC SỐ ═══════════════════ */

const vnDayCol = (col: SQL) => sql<string>`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

/**
 * PHẠM VI CHI TIÊU = kỳ (dùng lại `spendPeriod` — MỘT định nghĩa kỳ chi tiêu cho cả ROAS, bảng
 * quyết định và báo cáo này) + các chiều lọc của riêng báo cáo này.
 */
function marketingSpendScope(period: Period, f: MarketingFilters): SQL | undefined {
  return and(spendPeriod(period.from, period.to) as SQL, ...spendDimensionConds(f));
}

/**
 * CÁC VỊ NGỮ CHIỀU CỦA NGUỒN CHI TIÊU — TÁCH KHỎI KỲ, và đó là cả điểm của việc tách.
 *
 * Cùng bộ điều kiện này được hỏi HAI LẦN với hai ý nghĩa khác hẳn nhau:
 *   · kèm kỳ  → "chiều này tiêu bao nhiêu trong kỳ đang xem";
 *   · KHÔNG kèm kỳ → "nguồn chi tiêu có BIẾT tới chiều này không" (xem `spendByDay`).
 */
function spendDimensionConds(f: MarketingFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.marketerId) conds.push(f.marketerId === MARKETING_UNATTRIBUTED ? sql`${ads.marketerId} is null` : eq(ads.marketerId, f.marketerId));
  if (f.productId) conds.push(eq(ads.productId, f.productId));
  if (f.campaignId && f.campaignId !== MARKETING_UNATTRIBUTED) conds.push(sql`coalesce(${ads.campaignId}, ${ads.campaign}) = ${f.campaignId}`);
  return conds;
}

/**
 * CHI TIÊU & TIN NHẮN THEO NGÀY.
 *
 * Trả về `null` (chứ không phải map rỗng) khi chiều đang lọc KHÔNG CÓ số chi: Facebook Insights
 * đồng bộ ở cấp chiến dịch/ngày, nên lọc theo adset / mẩu quảng cáo / fanpage / nguồn đơn thì
 * không tồn tại con số chi tiêu nào để đọc. Chia đều tiền chiến dịch xuống các mẩu để bảng trông
 * đầy đủ là bịa — cùng luật với `lib/queries/ads-roas.ts`.
 */
async function spendByDay(
  db: Db,
  period: Period,
  f: MarketingFilters,
): Promise<{ byDay: Map<string, { spend: number; messages: number }>; observedThrough: string | null; dimensionKnown: boolean } | null> {
  const noSpendDimension = Boolean(f.adsetId || f.adId || f.pageId || f.source);
  if (noSpendDimension) return null;
  const dimConds = spendDimensionConds(f);
  const [rows, frontier, dimSeen] = await Promise.all([
    db
      .select({
        day: vnDayCol(sql`${ads.spendDate}`),
        spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
        messages: sql<number>`coalesce(sum(${AD_MESSAGES}), 0)`,
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
    /*
      ═══ NGUỒN CHI TIÊU CÓ BIẾT TỚI CHIỀU NÀY KHÔNG — CÂU HỎI KHÁC HẲN BIÊN QUAN SÁT ═══

      Biên quan sát trả lời "đồng bộ đã chạy tới ngày nào". Nó KHÔNG trả lời được "người này có
      chiến dịch nào được khai trong bảng chi tiêu không", và bản trước đã để nó trả lời thay:
      mọi ngày trong biên mà không có dòng nào đều thành `0 ₫`.

      Hệ quả đo được trên màn hình Bóc tách theo MKTer: `ad_spends.marketer_id` chỉ được điền qua
      ánh xạ CHIẾN DỊCH → marketer (khai tay / bí danh trong tên chiến dịch / tài khoản quảng cáo,
      xem `lib/integrations/facebook/mapping.ts`), trong khi ĐƠN được quy kết bằng một đường hoàn
      toàn khác — ảnh chụp phân công FANPAGE (`order_attributions`). Marketer nào chưa có chiến
      dịch nào được khai thì mọi ngày của họ in `0 ₫` chi quảng cáo, ROAS đẹp, lợi nhuận góp dương;
      còn toàn bộ tiền thật rơi vào dòng "Chưa quy kết" và dòng đó lỗ nặng. Cả hai con số đều sai,
      và không ô nào trên bảng nói rằng có gì đó chưa biết.

      Một dòng bất kỳ (KHÔNG giới hạn theo kỳ — chiến dịch của người ấy có thể chỉ chạy tháng
      trước) là đủ để kết luận "nguồn có biết tới chiều này". Không dòng nào ⇒ CHƯA BIẾT, in `—`.
    */
    dimConds.length
      ? db.select({ seen: sql<number>`count(*)` }).from(ads).where(and(eq(ads.excluded, false), ...dimConds))
      : Promise.resolve([{ seen: 1 }]),
  ]);
  return {
    byDay: new Map(rows.map((r) => [r.day, { spend: Number(r.spend), messages: Number(r.messages) }])),
    observedThrough: frontier[0]?.day ?? null,
    dimensionKnown: Number(dimSeen[0]?.seen ?? 0) > 0,
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
  const returned = sql`${facts.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)})`;
  const booked = sql`${facts.outcome} <> 'CANCELLED'`;
  const open = sql`${facts.outcome} in (${sql.raw(OPEN_OUTCOMES_SQL)})`;
  const shipped = sql`${facts.outcome} in (${sql.raw(ELIGIBLE_SENT_SQL)})`;
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
      // Tiền của đơn CHƯA NGÃ NGŨ, chưa nhân tỷ lệ: lọc theo mã thì cả ngày chỉ có MỘT tỷ lệ, nên
      // phép nhân làm ở TypeScript — rẻ hơn, và đọc ra được ngay tỷ lệ nào đã được dùng.
      openRevenue: money(sql`${facts.lineRevenue}`, open),
      openCogs: money(sql`${facts.lineCogs}`, open),
      dupOrders: sql<number>`count(distinct ${facts.orderId}) filter (where ${booked} and ${facts.duplicate})`,
      dupDeliveredRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${delivered} and ${facts.duplicate}), 0)`,
      dupCogs: sql<number>`coalesce(sum(${facts.lineCogs}) filter (where ${delivered} and ${facts.duplicate}), 0)`,
      dupShipping: sql<number>`coalesce(sum(${facts.orderShipping} * coalesce(${facts.shipShare}, 0)) filter (where (${delivered} or ${returned}) and ${facts.duplicate}), 0)`,
    })
    .from(facts)
    .groupBy(facts.day);
}

/** Đơn và tiền theo ngày ở grain ĐƠN — đi thẳng qua bảng dẫn xuất của Báo cáo lợi nhuận. */
async function orderDayRows(db: Db, period: Period, basis: MarketingBasis, extra: SQL | undefined, rate: SQL | undefined) {
  const { base, predicates } = pnlFacts(db, basis, period.from, period.to, extra, rate);
  const live = sql`not ${base.duplicate}`;
  const cnt = (cond: SQL) => sql<number>`count(*) filter (where ${cond} and ${live})`;
  const money = (expr: SQL, cond: SQL) => sql<number>`coalesce(sum(${expr}) filter (where ${cond} and ${live}), 0)`;
  const ship = sql`${base.partnerFee} + ${base.returnFee} + ${base.feeMarketplace}`;
  const openCond = sql`${base.outcome} in (${sql.raw(OPEN_OUTCOMES_SQL)})`;
  return db
    .select({
      day: base.day,
      orders: cnt(predicates.notCancelled as SQL),
      posRevenue: money(sql`${base.revenue}`, predicates.notCancelled as SQL),
      deliveredRevenue: money(sql`${base.revenue}`, predicates.success as SQL),
      deliveredOrders: cnt(predicates.success as SQL),
      returnedOrders: cnt(predicates.returned as SQL),
      cancelledOrders: cnt(predicates.cancelled as SQL),
      pendingOrders: cnt(sql`${base.outcome} in (${sql.raw(OPEN_OUTCOMES_SQL)})`),
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
      /*
        PHẦN ĐANG ĐI, ĐÃ CÂN THEO TỶ LỆ — cộng vào phần đã đo ở tầng TypeScript.

        Cố ý KHÔNG `coalesce(..., 0)`: không truyền bản đồ tỷ lệ thì `base.deliveryRate` là `NULL`,
        phép nhân ra `NULL`, và `sum` ra `NULL`. Bọc `coalesce` ở đây là biến CHƯA BIẾT thành 0 ngay
        trong câu lệnh — đúng thứ mục 42 cấm. Nơi gọi biết mình có truyền tỷ lệ hay không nên nó mới
        là chỗ được phép quyết định.
      */
      openProjectedRevenue: sql<number | null>`sum(${base.revenue} * ${base.deliveryRate}) filter (where ${openCond} and ${live})`,
      openProjectedCogs: sql<number | null>`sum(${base.cogs} * ${base.deliveryRate}) filter (where ${openCond} and ${live})`,
      openProjectedOrders: sql<number | null>`sum(${base.deliveryRate}) filter (where ${openCond} and ${live})`,
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

/**
 * `skipUnits`: KHÔNG đọc số lượng sản phẩm trong lượt này.
 *
 * Chỉ bảng BÓC TÁCH truyền cờ này, và nó có lý do đo được: bóc tách chạy `buildDays` một lần cho
 * mỗi nhóm, nên câu đếm số lượng — vốn không phụ thuộc nhóm nào cả về hình dạng — bị chạy lại cho
 * từng nhóm. Đo trên production 19/09/2026: bóc tách theo chiến dịch chạy **108 câu**, trong đó
 * riêng câu đếm số lượng lặp **24 lần và tốn 2.236ms**.
 *
 * Bóc tách tự đọc số lượng MỘT LẦN cho mọi nhóm (`unitsByDimension`) rồi điền vào. Bảng chính
 * KHÔNG truyền cờ này, nên đường của người dùng thường không đổi một chút nào.
 */
async function buildDays(
  db: Db,
  period: Period,
  basis: MarketingBasis,
  filters: MarketingFilters,
  opts: { skipUnits?: boolean; rates?: ProductDeliveryRates | null } = {},
): Promise<{ rows: MarketingDailyRow[]; spendObservedThrough: string | null; spendDimensionKnown: boolean | null; opex: OperatingCostByDay | null }> {
  const extra = dimensionFilter(filters);
  const filtered = hasDimensionFilter(filters);
  const rates = opts.rates ?? null;
  /*
    TỶ LỆ ĐI VÀO SQL Ở ĐƯỜNG CẤP ĐƠN, ĐI VÀO TYPESCRIPT Ở ĐƯỜNG CẤP DÒNG HÀNG.

    Không lọc mã ⇒ mỗi đơn có một hỗn hợp mã riêng, nên tỷ lệ phải tính TRONG câu lệnh, trên chính
    bảng dẫn xuất của Báo cáo lợi nhuận (`orderDeliveryRateSql`). Có lọc mã ⇒ cả bảng chỉ có MỘT
    tỷ lệ, và nhân một hằng số ở TypeScript vừa rẻ hơn vừa đọc ra được tỷ lệ nào đã dùng.
  */
  const rateSql = rates && !filters.productId ? orderDeliveryRateSql(rates) : undefined;
  const productRate = rates && filters.productId ? (rates.byProduct.get(filters.productId) ?? rates.fallback).deliveryRate / 100 : null;
  /*
    ═══════════ HÀM NÀY KHÔNG MỞ GIAO DỊCH — NƠI GỌI MỚI MỞ ═══════════

    Bản trước bọc `chayKhongJit` NGAY TẠI ĐÂY. Đúng về ý định (lý do tắt JIT nằm ở
    `getMarketingDailyUncached`), sai về VỊ TRÍ: `getMarketingBreakdown` gọi hàm này MỘT LẦN CHO
    MỖI KHOÁ CHIỀU, nên 24 chiến dịch thành 24 lần `BEGIN` + `SET LOCAL` + `COMMIT` + xin kết nối
    trên một bể 5 chỗ.

    ĐO ĐƯỢC trên production 19/09/2026, ngay lượt deploy đầu tiên của bản vá JIT:

        bóc tách theo chiến dịch   1.195ms → 3.744ms   (+228%)
        bóc tách theo mã hàng        173ms →   500ms
        bóc tách theo marketer        74ms →   171ms

    trong khi các đường một-lượt lại nhanh lên 93–97%. Cùng một bản vá, hai hướng ngược nhau —
    dấu hiệu kinh điển của chi phí đi theo SỐ LƯỢT GỌI chứ không theo khối lượng dữ liệu.

    Nên ranh giới giao dịch chuyển lên nơi gọi: mỗi ĐƯỜNG VÀO mở đúng MỘT giao dịch, và mọi lượt
    `buildDays` bên trong dùng lại chính `tx` ấy. Không giao dịch lồng nhau, không giao dịch trong
    vòng lặp.
  */
  const [moneyRows, spend, units, allocated] = await Promise.all([
    filters.productId ? productDayRows(db, period, basis, filters, extra) : orderDayRows(db, period, basis, extra, rateSql),
    spendByDay(db, period, filters),
    filters.productId || opts.skipUnits ? Promise.resolve(null) : unitsByDay(db, period, basis, extra),
    // Chi phí vận hành phân bổ CHỈ có nghĩa ở mức toàn shop. Có bộ lọc ⇒ không đọc, và ô là `—`.
    // Qua Profit Engine: cùng sổ thẩm quyền với tổng kỳ, nên Σ các ngày = `getOperatingCost()`.
    filtered ? Promise.resolve(null) : getOperatingCostByDay(period, db),
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
    /*
      ƯỚC TÍNH = PHẦN ĐÃ ĐO + PHẦN ĐANG ĐI ĐÃ CÂN THEO TỶ LỆ.

      Cộng vào phần đã đo chứ không thay nó: đơn đã có kết cục thì không còn gì để dự báo, và nhân
      tỷ lệ lên cả những đơn ấy là ghi đè một số đo bằng một con số đoán.
    */
    if (rates) {
      const open =
        "openRevenue" in r
          ? { revenue: Number((r as { openRevenue: number }).openRevenue) * (productRate ?? 0), cogs: Number((r as { openCogs: number }).openCogs) * (productRate ?? 0), orders: row.pendingOrders * (productRate ?? 0) }
          : { revenue: Number((r as { openProjectedRevenue: number | null }).openProjectedRevenue ?? 0), cogs: Number((r as { openProjectedCogs: number | null }).openProjectedCogs ?? 0), orders: Number((r as { openProjectedOrders: number | null }).openProjectedOrders ?? 0) };
      row.projectedDeliveredRevenue = Math.round(row.deliveredRevenue + open.revenue);
      row.projectedCogs = Math.round(row.cogs + open.cogs);
      row.projectedDeliveredOrders = Math.round((row.deliveredOrders + open.orders) * 10) / 10;
    }
  }
  if (units) for (const [day, qty] of units) get(day).units = qty;
  // Ngày chỉ có chi quảng cáo (không đơn nào) vẫn phải là một dòng: đó chính là ngày đốt tiền không ra gì.
  if (spend) for (const day of spend.byDay.keys()) get(day);
  // CÙNG ĐƯỜNG với `getDailyBreakdown` và với tổng kỳ: chi phí vận hành đi qua sổ thẩm quyền. Khoản
  // nhóm Quảng cáo gõ tay KHÔNG còn được cộng vào chi quảng cáo — tài khoản QC mới có thẩm quyền, và
  // cộng thêm là trừ hai lần cùng một đồng (AGENTS.md mục 15). Phần bị loại được NÓI ra ở `warnings`.
  if (allocated) for (const [day, amount] of allocated.byDay) {
    const row = get(day);
    row.operatingCost = (row.operatingCost ?? 0) + amount;
  }
  /*
    CƯỚC / PHÍ HOÀN ĐIỀU CHỈNH CÓ LÝ DO — cùng đường, cùng ngày với `getDailyBreakdown`.

    Chỉ ở mức TOÀN SHOP, như chi phí vận hành: khoản đền bù / cước chuyến gom hàng không gắn được
    đơn nào, nên không có căn cứ chia xuống một marketer / mã / chiến dịch. Có bộ lọc thì cột cước chỉ
    còn cước của chính các đơn trong lát cắt — đúng nghĩa "chi phí giao nhận của chính đơn đó".
  */
  if (allocated) {
    for (const part of [allocated.logisticsAdjustment.shipping, allocated.logisticsAdjustment.returnFee]) {
      for (const [day, amount] of part.byDay) get(day).shippingCost += amount;
    }
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
      const inWindow = spend.dimensionKnown && spend.observedThrough !== null && row.day <= spend.observedThrough;
      if (observed || inWindow) {
        row.spendKnown = true;
        row.adSpend = observed?.spend ?? 0;
        row.messages = observed?.messages ?? 0;
      }
    }
    /*
      NGÀY KHÔNG CÓ ĐƠN NÀO ĐANG ĐI THÌ ƯỚC TÍNH BẰNG ĐÚNG SỐ ĐO — kể cả ngày chỉ có chi quảng cáo
      mà không đơn nào. Để `null` ở đó là bỏ mất đúng những ngày đốt tiền không ra gì, tức là bỏ
      mất lý do người ta mở bảng này.
    */
    if (rates && row.projectedDeliveredRevenue === null) {
      row.projectedDeliveredRevenue = row.deliveredRevenue;
      row.projectedCogs = row.cogs;
      row.projectedDeliveredOrders = row.deliveredOrders;
    }
    row.finishedOrders = row.deliveredOrders + row.returnedOrders;
    row.maturityBase = row.finishedOrders + row.pendingOrders;
    row.maturity = maturityState(row.finishedOrders, row.pendingOrders);
    if (!filtered && row.operatingCost === null) row.operatingCost = 0;
    row.contributionProfit = profitOf(row);
    row.projectedContributionProfit = projectedProfitOf(row);
    row.netProfit = row.operatingCost === null || row.contributionProfit === null ? null : row.contributionProfit - row.operatingCost;
  }
  return { rows, spendObservedThrough: spend?.observedThrough ?? null, spendDimensionKnown: spend ? spend.dimensionKnown : null, opex: allocated };
}

function rollupTotals(rows: MarketingDailyRow[]) {
  const base = sumBases(rows);
  return { ...base, maturity: maturityState(base.finishedOrders, base.pendingOrders), spendKnown: rows.some((r) => r.spendKnown) };
}

async function getMarketingDailyUncached(period: Period, basis: MarketingBasis, filters: MarketingFilters, previous: { from: Date | null; to: Date | null } | null): Promise<MarketingDaily> {
  const db = await getDb();
  /*
    ═══════════ TẮT JIT — ĐO ĐƯỢC TRÊN PRODUCTION 19/09/2026 ═══════════

    `EXPLAIN (ANALYZE, BUFFERS)` của chính câu gộp theo ngày trả lời dứt điểm câu hỏi đã treo qua
    ba lượt đo — vì sao `Seq Scan on orders` khởi động mất 3,8 giây rồi chỉ tốn 3,5ms cho toàn bộ
    1.148 dòng:

        JIT: Functions: 62
             Timing: Generation 37,8ms · Inlining 126,7ms · Optimization 1.383,5ms
                     · Emission 1.698,2ms · Total 3.246,1ms
        Execution Time: 3.738,9 ms

    3.246 trên 3.739 mili giây là BIÊN DỊCH, không phải tính toán. "Khởi động 3,8 giây" chính là
    thời gian biên dịch mà PostgreSQL gán vào nút đầu tiên của kế hoạch.

    JIT bật vì chi phí ƯỚC LƯỢNG là `cost=5.796.652..11.592.844`, vượt xa `jit_above_cost`
    (100.000) lẫn `jit_inline/optimize_above_cost` (500.000) — con số ấy đến từ SubPlan tương quan
    của `ORDER_OUTCOME`, trong khi thực tế chỉ chạm 1.752 dòng và mỗi lượt SubPlan tốn 0,26ms.

    Đo lại sau khi tắt, cùng phép đo:

        marketingDaily 30d (có kỳ trước)    4.048ms → 276ms   (−93,2%)
        marketingDaily 30d (không kỳ trước) 3.575ms → 171ms   (−95,2%)

    MỘT giao dịch cho CẢ hai lượt `buildDays` và phép đọc độ tươi — không phải một giao dịch cho
    mỗi lượt. Mỗi giao dịch giữ một kết nối suốt thời gian sống của nó, mà bể chỉ có 5 chỗ trên
    máy 2 nhân.
  */
  /*
    BẢN ĐỒ TỶ LỆ ĐỌC NGOÀI GIAO DỊCH — nó có bộ đệm riêng 90 giây và đọc những bảng khác hẳn, nên
    giữ nó bên trong sẽ chiếm một kết nối của bể 5 chỗ lâu hơn cần thiết mà không được gì.
  */
  const rates = await productDeliveryRates(period);
  const [built, freshness, prevBuilt] = await chayKhongJit(db, (tx) =>
    Promise.all([
      buildDays(tx, period, basis, filters, { rates }),
      marketingFreshness(tx),
      previous?.from ? buildDays(tx, { ...period, key: "custom", from: previous.from, to: previous.to }, basis, filters, { rates }) : Promise.resolve(null),
    ]),
  );
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
  if (unobserved.length && built.spendDimensionKnown !== false && !(filters.adsetId || filters.adId || filters.pageId || filters.source)) {
    /*
      NÓI THẲNG RA NGÀY NÀO CHƯA KẾT LUẬN ĐƯỢC.

      Đây cũng là câu giải thích cho chênh lệch với Báo cáo lợi nhuận: báo cáo ấy coi chi tiêu chưa
      có là 0 và vẫn chốt một con số. Ở đây thì không — trừ đi một số chưa biết không ra một con số.
    */
    warnings.push(
      `Nguồn chi quảng cáo mới đồng bộ tới ngày ${built.spendObservedThrough ?? "—"}. ${unobserved.length} ngày sau đó có đơn nhưng CHƯA BIẾT chi bao nhiêu, nên lợi nhuận của những ngày ấy để trống (—) thay vì chốt một con số. Báo cáo lợi nhuận coi phần chưa có là 0 nên sẽ cao hơn ở những ngày này.`,
    );
  }
  /*
    HAI CÂU GIẢI THÍCH CHO HAI Ô TRỐNG TRÔNG GIỐNG HỆT NHAU — và đưa người đọc đi hai nơi khác nhau.

    "Đồng bộ chưa chạy tới ngày đó" ⇒ đợi, hoặc chạy lại job Facebook.
    "Nguồn chi tiêu chưa biết tới chiều này" ⇒ đi KHAI ánh xạ; đợi bao lâu cũng không có số.

    Gộp hai câu lại thành một câu "chưa có số chi" là để người đọc đi đợi một thứ không bao giờ tới.
  */
  if (built.spendDimensionKnown === false) {
    warnings.push(
      filters.marketerId
        ? "Bảng chi quảng cáo KHÔNG có chiến dịch nào được khai cho marketer này, nên Chi QC · ROAS · CPQC/đơn · Lợi nhuận góp là CHƯA BIẾT (—) chứ không phải 0. Đơn được quy kết bằng ảnh chụp phân công FANPAGE, còn tiền quảng cáo đi bằng ánh xạ CHIẾN DỊCH → marketer — khai ánh xạ ấy ở trang Quảng cáo → Ghép chiến dịch thì cột tiền mới có số."
        : "Bảng chi quảng cáo chưa có dòng nào được khai cho chiều đang lọc, nên Chi QC · ROAS · CPQC/đơn · Lợi nhuận góp là CHƯA BIẾT (—) chứ không phải 0. Ghép chiến dịch với mã hàng / marketer ở trang Quảng cáo thì cột tiền mới có số.",
    );
  }
  if (rates.projectionError) warnings.push(`Mô hình dự báo giao thành công lỗi (${rates.projectionError}); các ô ước tính đang dùng tỷ lệ lịch sử của mã, hết lịch sử thì dùng tỷ lệ khai ở Giả định.`);
  const dupDays = rows.filter((r) => r.duplicates.orders > 0);
  if (dupDays.length) {
    const dupOrders = dupDays.reduce((s, r) => s + r.duplicates.orders, 0);
    warnings.push(`Đã loại ${dupOrders} đơn bị kết luận TRÙNG (một lần đặt nhập hai lần) theo ảnh chụp quy kết. Vì vậy tổng ở đây nhỏ hơn Báo cáo lợi nhuận đúng bằng phần ấy — chênh lệch giải thích được, không phải sai số.`);
  }
  /*
    KHOẢN GÕ TAY BỊ LOẠI VÌ THẨM QUYỀN — NÓI RA, KHÔNG ĐỂ BIẾN MẤT.

    Bản trước cộng khoản nhóm Quảng cáo gõ tay vào Chi QC, và khoản Nhập hàng / cước gõ tay vào chi
    phí vận hành. Nay chúng đi đúng sổ thẩm quyền như tổng kỳ — người từng thấy con số cũ phải được
    biết vì sao nó đổi, và khoản nào đang không được tính.
  */
  for (const x of built.opex?.excluded ?? []) {
    warnings.push(
      x.rule === "EXCLUDED_BY_AUTHORITY"
        ? `${x.count} khoản chi nhóm “${EXPENSE_CATEGORY_LABEL[x.category]}” gõ tay ở bảng Chi phí (${x.amount.toLocaleString("vi-VN")} ₫ trong kỳ) KHÔNG được cộng: nguồn có thẩm quyền của nhóm này là ${COST_SOURCE_LABEL[COST_AUTHORITY[EXPENSE_CATEGORY_ECONOMIC[x.category]]]}, cộng thêm là trừ hai lần cùng một đồng.`
        : `${x.count} khoản “${EXPENSE_CATEGORY_LABEL[x.category]}” gõ tay (${x.amount.toLocaleString("vi-VN")} ₫) KHÔNG được cộng vì trùng cước theo vận đơn. Khoản ngoại lệ thật thì đổi nguồn thành “Điều chỉnh thủ công” kèm lý do.`,
    );
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
    rateBasis: { fallbackDeliveryRate: rates.fallback.deliveryRate, coverage: rateCoverage(rates), projectionError: rates.projectionError },
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
/**
 * ═══════════ BÓC TÁCH: "NGÀY NÀY LỖ — LỖ Ở ĐÂU?" ═══════════
 *
 * ─── BA BẢN, BA LẦN ĐO TRÊN PRODUCTION — VÀ BẢN ĐƠN GIẢN NHẤT THẮNG ───
 *
 * Chuẩn hoá theo `/ads` (cùng trang, cùng máy, cùng lượt chạy, để loại nhiễu do phiên khác):
 *
 *     bản                         /ads     /ads/daily    tỷ lệ
 *     ────────────────────────────────────────────────────────
 *     tuần tự, một lượt/nhóm      18,4s        4,7s       0,26   ← NHANH NHẤT
 *     song song, 48 câu cùng lúc  19,2s       15,9s       0,83
 *     một câu `group by`          19,8s       21,1s       1,07   ← CHẬM NHẤT
 *
 * Cả hai bản "tối ưu" đều làm nó CHẬM ĐI, và bản thứ hai chậm hơn cả bản thứ nhất.
 *
 *   · Song song: 48 câu nặng cùng lúc tranh nhau một bể kết nối có hạn.
 *   · Một câu `group by`: gộp trên TOÀN BỘ đơn thì Postgres mất đường dùng chỉ mục mà các câu ĐÃ
 *     LỌC dùng được. Mười hai lượt quét HẸP (mỗi lượt một marketer, đi qua
 *     `order_attribution_marketer_idx`) rẻ hơn hẳn một lượt quét RỘNG kèm truy vấn con tương quan
 *     cho từng dòng.
 *
 * Nên bản đang chạy là bản tuần tự. Nó cũng là bản có bảo đảm đúng đắn MẠNH NHẤT: mỗi nhóm đọc
 * lại bằng CHÍNH đường của bảng chính, nên con số bóc tách không thể khác con số của dòng nó bóc —
 * không cần tin vào một phép suy luận nào.
 *
 * BÀI HỌC, ghi lại để lần sau không lặp: "48 câu truy vấn" nghe như vấn đề, nhưng nó chỉ là một
 * con số đếm. Cái tốn tiền là KHỐI LƯỢNG QUÉT, và 48 câu hẹp có thể rẻ hơn 1 câu rộng. Đừng sửa
 * hiệu năng bằng trực giác về hình dạng truy vấn — đo trước, rồi mới sửa.
 */
export async function getMarketingBreakdown(
  period: Period,
  basis: MarketingBasis,
  dimension: MarketingDimension,
  filters: MarketingFilters = {},
  limit = 12,
): Promise<{ dimension: MarketingDimension; spendGrain: boolean; rows: MarketingBreakdownRow[]; spendUnknown: string[] }> {
  const db = await getDb();
  const rates = await productDeliveryRates(period);
  /*
    MỘT GIAO DỊCH CHO CẢ BẢNG BÓC TÁCH — khoá chiều, số lượng sản phẩm, và mọi lượt `buildDays`.

    Đây là chỗ bản vá JIT đầu tiên đặt SAI ranh giới: nó bọc bên trong `buildDays`, mà hàm ấy được
    gọi MỘT LẦN CHO MỖI KHOÁ. 24 chiến dịch ⇒ 24 lần `BEGIN` + `SET LOCAL jit = off` + `COMMIT` +
    xin kết nối, và bảng này chậm đi từ 1.195ms lên 3.744ms trong khi các đường một-lượt nhanh lên
    93%. Đo được trên production, không suy ra.

    Vòng lặp vẫn TUẦN TỰ và vẫn gọi lại ĐÚNG đường của bảng chính — hai điều đó là lý do con số
    bóc tách không thể khác con số của dòng nó bóc, và đã được đo là nhanh hơn cả bản song song
    lẫn bản một-câu-`group by` (khối chú thích ngay trên). Thay đổi ở đây CHỈ là ranh giới giao
    dịch: cùng truy vấn, cùng thứ tự, cùng kết quả.
  */
  return chayKhongJit(db, async (tx) => {
    const keys = await dimensionKeys(tx, period, dimension, filters, limit);
    /*
      SỐ LƯỢNG SẢN PHẨM ĐỌC MỘT LẦN CHO MỌI NHÓM.

      Đây là N+1 DUY NHẤT mà bộ đo tìm được trong tính năng này, và nó đo được chứ không suy ra:
      bóc tách theo chiến dịch chạy 108 câu, riêng câu đếm số lượng lặp 24 lần tốn 2.236ms
      (perf-probe, production 19/09/2026).

      Câu này gộp `orders ⋈ order_items` — KHÔNG đụng `ORDER_OUTCOME`, không đụng bảng dẫn xuất —
      nên gộp theo khoá chiều là an toàn và rẻ. Cố ý KHÔNG gộp nốt phần TIỀN: đã thử ở bản trước và
      đo được nó CHẬM HƠN (một lượt quét rộng mất đường dùng chỉ mục mà 12 lượt quét hẹp dùng được).
      Một phép tối ưu chỉ được làm ở chỗ số đo chỉ vào.
    */
    const unitsByKey = dimension === "product" ? null : await unitsByDimension(tx, period, basis, dimensionFilter(filters), dimension);
    const rows: MarketingBreakdownRow[] = [];
    for (const k of keys) {
      const scoped: MarketingFilters = { ...filters, ...filterForDimension(dimension, k.key) };
      const { rows: days } = await buildDays(tx, period, basis, scoped, { skipUnits: unitsByKey !== null, rates });
      const base = sumBases(days);
      if (unitsByKey) base.units = unitsByKey.get(k.key) ?? 0;
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
    /*
      NHÓM NÀO CÓ TIỀN MÀ NGUỒN CHI TIÊU KHÔNG BIẾT TỚI — nói ra bằng TÊN, không chỉ bằng một ô `—`.

      Một ô trống thì người đọc đoán là "người này không chạy quảng cáo". Một câu kèm danh sách tên
      và đường đi sửa thì họ đi sửa được. Chỉ đếm nhóm CÓ ĐƠN: nhóm không đơn, không tiền là nhóm
      rỗng, không phải một chỗ hụt dữ liệu.
    */
    const spendUnknown = MARKETING_DIMENSION_SPEND[dimension] ? rows.filter((r) => r.adSpend === null && r.orders > 0).map((r) => r.label) : [];
    return { dimension, spendGrain: MARKETING_DIMENSION_SPEND[dimension], rows, spendUnknown };
  });
}

/**
 * SỐ LƯỢNG SẢN PHẨM THEO KHOÁ CHIỀU — một câu cho mọi nhóm.
 *
 * Cùng bộ lọc, cùng population, cùng quy ước loại đơn trùng và đơn huỷ như `unitsByDay`; chỉ đổi
 * cách GỘP (theo khoá chiều thay vì theo ngày). Bóc tách chỉ cần tổng cả kỳ cho mỗi nhóm.
 *
 * Khoá `NULL` gom vào nhóm "Chưa quy kết" — cùng quy ước với phần tiền. Khác quy ước thì số lượng
 * và số đơn của nhóm ấy sẽ nói về hai tập đơn khác nhau.
 */
async function unitsByDimension(
  db: Db,
  period: Period,
  basis: MarketingBasis,
  extra: SQL | undefined,
  dimension: MarketingDimension,
): Promise<Map<string, number>> {
  void basis; // số lượng là thuộc tính của ĐƠN, không của kết quả giao — không phụ thuộc mốc
  const conds: SQL[] = [metricScope(period, "confirmed"), sql`not ${IS_DUPLICATE_ORDER}`, sql`${ORDER_OUTCOME_FAST} <> 'CANCELLED'`];
  if (extra) conds.push(extra);
  const rows = await db
    .select({ key: sql<string | null>`${dimensionKeyExpr(dimension)}`, units: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
    .from(o)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, o.id))
    .where(and(...conds))
    .groupBy(sql`1`);
  return new Map(rows.map((r) => [r.key ?? MARKETING_UNATTRIBUTED, Number(r.units)]));
}

/**
 * BIỂU THỨC KHOÁ NHÓM của từng chiều, tính TRÊN `orders` — cùng chỗ mà bộ lọc chiều đọc, nên nhóm
 * ở đây và nhóm do bộ lọc chọn ra luôn là một tập đơn.
 *
 * `NULL` là một nhóm THẬT ("Chưa quy kết"), không phải một dòng bị bỏ.
 */
function dimensionKeyExpr(dimension: MarketingDimension): SQL<string | null> {
  switch (dimension) {
    case "marketer":
      return sql<string | null>`(select ${oa.marketerId} from ${oa} where ${oa.orderId} = ${o.id} and ${oa.status} = 'ATTRIBUTED' limit 1)`;
    case "page":
      return sql<string | null>`nullif(${o.pageId}, '')`;
    case "campaign":
      return sql<string | null>`${ORDER_CAMPAIGN_ID}`;
    case "adset":
      return sql<string | null>`(select fa.adset_id from fb_ads fa where fa.id = ${o.adId})`;
    case "ad":
      return sql<string | null>`(select fa.id from fb_ads fa where fa.id = ${o.adId})`;
    case "source":
      return sql<string | null>`nullif(${o.source}, '')`;
    case "product":
      // Mã hàng nằm ở DÒNG ĐƠN — bóc tách theo mã đi đường riêng, không dùng hàm này.
      return sql<string | null>`null::text`;
  }
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
    /*
      HAI NGUỒN KHOÁ, VÀ NGUỒN THỨ HAI LÀ THỨ BẢNG NÀY SINH RA ĐỂ TÌM.

      Xếp hạng theo doanh số POS chỉ thấy người CÓ ĐƠN. Người tiêu 8 triệu quảng cáo mà không ra
      đơn nào thì doanh số bằng 0, rơi khỏi `limit`, và biến mất khỏi đúng cái bảng có tên là
      "lỗ ở đâu" — trong khi họ chính là câu trả lời. Nên khoá của bảng chi tiêu được GỘP THÊM,
      không thay thế.
    */
    const [rows, spendKeys] = await Promise.all([
      db
        .select({ key: sql<string | null>`(select ${oa.marketerId} from ${oa} where ${oa.orderId} = ${o.id} and ${oa.status} = 'ATTRIBUTED' limit 1)`, total: rank })
        .from(o)
        .where(scope)
        .groupBy(sql`1`)
        .orderBy(sql`2 desc`)
        .limit(limit + 1),
      filters.marketerId
        ? Promise.resolve([] as { key: string | null }[])
        : db
            .select({ key: sql<string | null>`${ads.marketerId}` })
            .from(ads)
            .where(and(marketingSpendScope(period, {}), sql`${ads.marketerId} is not null`))
            .groupBy(sql`1`)
            .orderBy(sql`sum(${ads.spend}) desc`)
            .limit(limit),
    ]);
    const names = await employeeNames();
    const seen = new Set<string>();
    const out: { key: string; label: string }[] = [];
    for (const r of [...rows.map((r) => r.key), ...spendKeys.map((r) => r.key)]) {
      const key = r ?? MARKETING_UNATTRIBUTED;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: r ? marketerLabel(r, names) : MARKETING_UNATTRIBUTED_LABEL });
    }
    return out;
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
