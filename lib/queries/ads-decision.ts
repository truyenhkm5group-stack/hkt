import { and, eq, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { metricScope, openShippingSql, realizedShippingSql, successRate } from "@/lib/queries/metrics";
import { orderCogsFast } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT, SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";
import { spendPeriod } from "@/lib/queries/ads-roas";
import { loadAdsMapping, resolveCampaign } from "@/lib/integrations/facebook/mapping";
import { loadProductCodeIndex } from "@/lib/integrations/facebook/sync";
import { lineUnitCost } from "@/lib/queries/cogs";
import { variantLastCostSubquery } from "@/lib/queries/stock";
import { ORDER_AD_ID, ORDER_ADSET_ID, ORDER_CAMPAIGN_ID } from "@/lib/queries/ads-attribution-link";
import { adsAttributionCoverage, coverageVerdict } from "@/lib/queries/ads-attribution-coverage";
import { LOW_COVERAGE_PCT } from "@/lib/constants/sales-funnel";
import { adsRatio } from "@/lib/constants/profit";
import { OPEN_OUTCOMES_SQL } from "@/lib/constants/truth";
import {
  ADS_ACTION_ORDER,
  ADS_DECISION_RULE,
  ADS_DIMENSION_HAS_SPEND,
  type AdsAction,
  type AdsDimension,
  type AdsSpendClass,
  type DecisionBasis,
  type InheritedVerdict,
  spendClassOf,
} from "@/lib/constants/ads-decision";
import { deliveryRateCaseSql, orderDeliveryRateSql, productDeliveryRates, rateCoverage, type ProductDeliveryRates } from "@/lib/queries/delivery-rate";
import type { DeliveryRateSource } from "@/lib/constants/delivery-rate";
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
  /**
   * ─── BỐI CẢNH CHA: THỨ LÀM MỘT DANH SÁCH 1.254 MẨU TRỞ NÊN ĐỌC ĐƯỢC ───
   *
   * `null` ở cấp chiến dịch và cấp mã hàng (chúng không có cha trong cây quảng cáo), và `null` ở
   * hai cấp dưới khi sổ mẩu chưa biết mẩu ấy thuộc đâu — CHƯA BIẾT, không phải "không có cha".
   *
   * Không có nó thì tab Mẩu quảng cáo là một danh sách tên phẳng, và hai mẩu cùng tên ở hai chiến
   * dịch khác nhau trông y hệt nhau. Đó là cách một bảng đúng số vẫn không dùng được.
   */
  parentName: string | null;
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
  /**
   * ─── CHUỖI THỰC HIỆN: `openOrders` TÁCH LÀM HAI, VÀ HAI PHẦN ẤY LÀ HAI VIỆC CỦA HAI PHÒNG ───
   *
   * Với mô hình BÁN TRƯỚC, khoảng giữa "khách chốt" và "hàng rời kho" chính là SẢN XUẤT + ĐÓNG GÓI.
   * Gộp nó với "đang trên đường đi" thành một cục `openOrders` là xoá mất ranh giới giữa việc của
   * XƯỞNG và việc của ĐVVC — hai chỗ nghẽn khác nhau, hai người phải gọi khác nhau.
   *
   * Mốc rời kho đi bằng `SHIPMENT_LEFT_WAREHOUSE` (chứng từ ĐVVC), KHÔNG bằng trạng thái Pancake và
   * KHÔNG bằng `ORDER_OUTCOME` — cái sau là định nghĩa theo TIỀN (AGENTS.md mục 10).
   *
   * Cố ý KHÔNG gọi cột này là "đang sản xuất": `production_orders` là phiếu gửi xưởng theo
   * mã hàng × màu × size, không gắn với đơn khách nào, nên ERP không đo được "đơn này đang ở xưởng".
   * Cái đo được là ĐÃ CHỐT MÀ CHƯA RỜI KHO, và tên cột phải nói đúng chừng ấy.
   */
  notShippedOrders: number;
  notShippedRevenue: number;
  /** Đã rời kho, chưa ngã ngũ — tiền đang nằm trên đường. */
  inTransitOrders: number;
  inTransitRevenue: number;

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

  /**
   * ═══════════ CĂN CỨ CỦA KHUYẾN NGHỊ: ĐO ĐƯỢC, HAY THEO KẾ HOẠCH ═══════════
   *
   * `ACTUAL` — dòng đã có đủ đơn ngã ngũ, mọi con số tiền ở trên là SỐ ĐO.
   * `PROJECTED` — phần lớn đơn còn đang sản xuất / đang đi, nên khuyến nghị đứng trên **lợi nhuận
   * tạm tính**: doanh thu và giá vốn của đơn chưa ngã ngũ được cân theo tỷ lệ giao thành công ước
   * tính của chính mã hàng đó (`lib/constants/delivery-rate.ts`).
   *
   * ─── VÌ SAO KHÔNG CÒN TỪ CHỐI KẾT LUẬN ───
   *
   * Với mô hình BÁN TRƯỚC, kết quả tiền của một đồng quảng cáo hôm nay chưa tồn tại — và sẽ không
   * tồn tại thêm chút nào chỉ vì ERP đợi. Bản trước coi độ chín thấp là **lý do từ chối kết luận**;
   * đo trên production 22/09/2026 thì 425/425 dòng cấp chiến dịch đều rơi vào "chưa đủ dữ liệu".
   * Một bảng không bao giờ kết luận thì không ai mở nó lần thứ hai.
   *
   * Độ chín thấp chỉ nên là **lý do ĐỔI CĂN CỨ**. Khâu quảng cáo được chấm theo KẾ HOẠCH: tối ưu
   * trên tỷ lệ giao thành công đã khai, và nếu thực tế về cao hơn thì càng tốt, thấp hơn thì đó là
   * việc của khâu giao chứ không phải bằng chứng quảng cáo làm sai.
   *
   * Thang bậc tự chuyển sang SỐ THẬT khi mã có đủ mẫu (`minFinishedOrders` ở Giả định) — nên hai
   * chế độ này không phải hai công thức, chỉ là hai đầu của cùng một thang.
   */
  basis: DecisionBasis;
  /**
   * Doanh thu giao thành công TẠM TÍNH = đã giao thật + (đang treo × tỷ lệ GTC ước tính).
   * **Cộng vào phần đã đo, không thay nó** — cùng phép cộng với `lib/queries/marketing-daily.ts`,
   * để hai báo cáo không nói hai con số.
   *
   * Riêng CƯỚC thì bảng này đi xa hơn `marketing-daily`: nó dự phóng cả cước của phần đang treo
   * (xem `projectedProfitAfterAds`). Cố ý khác, vì đây là bảng RA QUYẾT ĐỊNH TIÊU TIỀN — một khoản
   * chi chắc chắn sẽ tới mà không có mặt sẽ làm khuyến nghị lạc quan một chiều.
   */
  projectedDeliveredRevenue: number;
  /**
   * Lợi nhuận góp sau quảng cáo TẠM TÍNH. Trừ cả cước dự phóng của phần đang treo — đã cộng doanh
   * thu tương lai thì phải trừ chi phí tương lai của đúng phần ấy (chủ shop chốt 23/09/2026).
   */
  projectedProfitAfterAds: number;
  /** Khoảng cách tới hoà vốn tính trên căn cứ TẠM TÍNH. `null` khi không biết chi tiêu. */
  projectedHeadroom: number | null;
  /**
   * Tỷ lệ GTC (%) thật sự đã áp cho phần đang treo của DÒNG NÀY — trung bình có trọng số theo tiền
   * của các mã trong dòng. `null` khi dòng không có đơn nào đang treo (không có gì để ước tính).
   */
  appliedDeliveryRate: number | null;
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

  // ── Chỉ số quảng cáo thô: `null` khi cấp này không có số chi (mục 42) ──
  impressions: number | null;
  clicks: number | null;
  messages: number | null;
  /** Chi cho 1.000 lượt hiển thị. */
  cpm: number | null;
  /** Chi cho một lượt bấm. */
  cpc: number | null;
  /** Chi cho một tin nhắn — con số marketer nhìn hằng ngày. */
  costPerMessage: number | null;
  /** Chi cho một ĐƠN CHỐT (chưa trừ hoàn). Khác hẳn CAC giao thành công ở dưới. */
  costPerOrder: number | null;
  /** Tin nhắn → đơn chốt. `null` khi chưa biết số tin nhắn. */
  closeRate: number | null;

  /**
   * ─── %CPQC CÓ HAI MẪU SỐ Ở ĐÂY, VÀ PHẢI IN RÕ ĐANG DÙNG CÁI NÀO ───
   *
   * Dùng lại `adsRatio()` của `lib/constants/profit.ts` — nơi đã dọn đúng lớp lỗi này một lần: bảng
   * lợi nhuận từng tính "CPQC / DT GTC" bằng hai mẫu số khác nhau ở hai chỗ dưới cùng một cái tên.
   *
   * Mẫu số thứ ba (doanh thu giao ƯỚC TÍNH) vẫn KHÔNG có ở đây, dù bảng nay đã tính được nó
   * (`projectedDeliveredRevenue`). %CPQC là con số người ta đọc để so với tháng trước và so với
   * shop khác; đổi mẫu số của nó sang một ước tính là làm đứt chuỗi so sánh ấy. Ước tính có chỗ
   * riêng ở `projectedHeadroom`, nơi nó được khai rõ là ước tính.
   */
  adsPctOverPos: number | null;
  adsPctOverDelivered: number | null;

  action: AdsAction;
  /**
   * Kết luận MƯỢN của mã hàng mà chiến dịch này đang chạy — chỉ có mặt khi dòng KHÔNG tự kết luận
   * được, và không bao giờ thay `action`. Xem `InheritedVerdict` để biết ba điều nó không được làm.
   *
   * `null` ở ba tình huống khác nhau, và màn hình phải phân biệt được: dòng đã tự kết luận được ·
   * chiến dịch chưa nối được về mã nào · mã của nó cũng chưa kết luận được.
   */
  inherited: InheritedVerdict | null;
  /**
   * TIỀN NÀY LÀ LOẠI GÌ — chỉ có nghĩa ở cấp CHIẾN DỊCH, `null` ở ba cấp kia.
   *
   * Tách `TEST` khỏi `UNCLASSIFIED` là cả điểm của trường này: cả hai đều không thuộc mã hàng nào
   * nên trước đây cùng đội một chữ "chưa đủ dữ liệu", trong khi một cái là **đúng như nó phải thế**
   * còn cái kia là **việc cần người làm**. Xem `AdsSpendClass`.
   */
  spendClass: AdsSpendClass | null;
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
    /** Chuỗi thực hiện ở mức tổng — bốn mốc, bốn chứng từ, không suy ra lẫn nhau. */
    notShippedOrders: number;
    notShippedRevenue: number;
    inTransitOrders: number;
    inTransitRevenue: number;
    returnedOrders: number;
    /** `null` = CHƯA BIẾT số tin nhắn ở cấp này, không phải 0 tin nhắn. */
    messages: number | null;
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
  /**
   * Bao nhiêu phần tiền quảng cáo của kỳ có chi tiết tới cấp mẩu. Chỉ có nghĩa ở cấp `adset`/`ad`:
   * phần còn lại nằm ở những ngày ERP mới chỉ có hạt CHIẾN DỊCH, và nó KHÔNG xuất hiện trong bảng.
   */
  spendDetail: SpendGrainCoverage;
  /**
   * NỀN TỶ LỆ GIAO THÀNH CÔNG đã dùng cho mọi con số tạm tính của bảng — **cùng hình dạng** với
   * `rateBasis` của Báo cáo hiệu quả marketing, vì nó là cùng một bản đồ tỷ lệ.
   *
   * Phải in cạnh mọi con số ước tính (AGENTS.md mục 8.6): `coverage` nói bao nhiêu mã đi bằng SỐ ĐO
   * và bao nhiêu mã đi bằng GIẢ ĐỊNH, `projectionError` nói hợp đồng dự báo có chạy được không.
   */
  /**
   * ĐỘ PHỦ CỦA KẾT LUẬN MƯỢN — chỉ có nghĩa ở cấp CHIẾN DỊCH.
   *
   * Ba con số vì có BA tình huống khác nhau, và gộp chúng lại là làm mất đường sửa: dòng mượn được
   * (đã có câu trả lời) · chiến dịch chưa nối được về mã nào (đi khai `ad_spends.product_id`) ·
   * mã của nó cũng chưa kết luận được (đợi thêm dữ liệu, không sửa được bằng tay).
   */
  inheritedCoverage: {
    /** Dòng không tự kết luận được NHƯNG mượn được của mã hàng. */
    rows: number;
    spend: number;
    /** Không nối được về mã nào — sửa được bằng cách khai mã cho chiến dịch. */
    unlinkedRows: number;
    unlinkedSpend: number;
    /** Nối được, nhưng chính mã ấy cũng chưa kết luận được. */
    productSilentRows: number;
    productSilentSpend: number;
    /** CHI PHÍ TEST — không phải chỗ trống, và không đi mượn. Có câu hỏi riêng của nó. */
    testRows: number;
    testSpend: number;
  };
  rateBasis: {
    fallbackDeliveryRate: number;
    coverage: Record<DeliveryRateSource, number>;
    projectionError: string | null;
  };
  /**
   * Độ tin cậy của toàn bảng — và mẫu số của nó là ĐƠN CÓ DẤU VẾT FACEBOOK, không phải mọi đơn.
   *
   * Sửa 22/09/2026: đơn chưa bao giờ đi qua quảng cáo (điện thoại · landing · khách cũ nhắn thẳng)
   * từng bị tính vào mẫu số, làm độ phủ đọc ra 60,6% trong khi con số đúng là 72,5%. Xem
   * `docs/ads-measurement-audit-2026-09-22.md` mục 5.
   */
  confidence: {
    /** `null` = CHƯA ĐO ĐƯỢC (không có đơn nào trong phạm vi), không phải 0%. */
    coveragePct: number | null;
    verdict: "SUFFICIENT" | "DATA_INSUFFICIENT";
    threshold: number;
    attributedOrders: number;
    /** Mẫu số THẬT: đơn đã chốt CÓ dấu vết Facebook. */
    attributableOrders: number;
    /** Đơn đã chốt trong kỳ, kể cả đơn không đến từ quảng cáo — để đọc được bối cảnh. */
    totalOrders: number;
    /** Đơn KHÔNG có dấu vết Facebook nào — đứng ngoài mẫu số, và phải nhìn thấy. */
    notFromAdsOrders: number;
  };
};

/** Khoá gộp của từng cấp. `adset` lấy từ `fb_ads` vì đơn chỉ mang `ad_id`. */
function groupKeyFor(dimension: AdsDimension) {
  if (dimension === "campaign") return sql`coalesce(${ORDER_CAMPAIGN_ID}, ${o.adId})`;
  if (dimension === "ad") return sql`${ORDER_AD_ID}`;
  return sql`${ORDER_ADSET_ID}`;
}

/**
 * ĐƠN THUỘC VỀ CẤP ĐANG XÉT.
 *
 * Cả ba cấp nhận đơn nối được qua BÀI VIẾT, nhưng mỗi cấp có điều kiện XÁC ĐỊNH riêng: bài viết chỉ
 * nối ở cấp nào mà nó ứng với ĐÚNG MỘT nút của cấp ấy. Một bài do hai mẩu cùng chạy thì cấp mẩu là
 * nhập nhằng (chọn bừa một mẩu là bịa quy kết) trong khi cấp chiến dịch vẫn xác định — nên ba mức
 * tính riêng, không suy ra từ nhau.
 *
 * Trước 22/09/2026 hai cấp dưới chỉ đi bằng `ad_id`, và khi ấy đó là quyết định đúng: `fb_ads` chỉ
 * có 185 dòng nên không có bài viết nào để nối. Nay sổ được điền từ TIỀN (1.254 mẩu) và bộ tra bài
 * viết đi hỏi cả chúng, nên vế thứ hai mới có nguyên liệu.
 */
function hasAdFor(dimension: AdsDimension) {
  if (dimension === "campaign") return sql`(${ORDER_CAMPAIGN_ID} is not null)`;
  if (dimension === "ad") return sql`(${ORDER_AD_ID} is not null)`;
  return sql`(${ORDER_ADSET_ID} is not null)`;
}

type Agg = {
  key: string;
  name: string;
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  openOrders: number;
  notShippedOrders: number;
  notShippedRevenue: number;
  inTransitOrders: number;
  inTransitRevenue: number;
  bookedRevenue: number;
  deliveredRevenue: number;
  cash: number;
  cogs: number;
  shipping: number;
  /** Doanh thu của đơn ĐANG TREO đã cân theo tỷ lệ GTC ước tính của mã. */
  openProjectedRevenue: number;
  openProjectedCogs: number;
  /**
   * Cước SẼ phát sinh của phần đang treo. KHÔNG nhân tỷ lệ: cước mất cả khi giao được lẫn khi hoàn.
   */
  openProjectedShipping: number;
  /** Số đơn đang treo đã cân theo tỷ lệ — số thập phân, vì nó là kỳ vọng chứ không phải phép đếm. */
  openProjectedOrders: number;
};

function toAgg(r: Record<string, unknown>): Agg {
  return {
    key: String(r.key ?? ""),
    name: String(r.name ?? "") || String(r.key ?? ""),
    bookedOrders: Number(r.bookedOrders ?? 0),
    deliveredOrders: Number(r.deliveredOrders ?? 0),
    returnedOrders: Number(r.returnedOrders ?? 0),
    openOrders: Number(r.openOrders ?? 0),
    notShippedOrders: Number(r.notShippedOrders ?? 0),
    notShippedRevenue: Number(r.notShippedRevenue ?? 0),
    inTransitOrders: Number(r.inTransitOrders ?? 0),
    inTransitRevenue: Number(r.inTransitRevenue ?? 0),
    bookedRevenue: Number(r.bookedRevenue ?? 0),
    deliveredRevenue: Number(r.deliveredRevenue ?? 0),
    cash: Number(r.cash ?? 0),
    cogs: Number(r.cogs ?? 0),
    shipping: Number(r.shipping ?? 0),
    openProjectedRevenue: Number(r.openProjectedRevenue ?? 0),
    openProjectedCogs: Number(r.openProjectedCogs ?? 0),
    openProjectedShipping: Number(r.openProjectedShipping ?? 0),
    openProjectedOrders: Number(r.openProjectedOrders ?? 0),
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
async function aggregateByOrder(period: Period, dimension: AdsDimension, rates: ProductDeliveryRates): Promise<Agg[]> {
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
      // Mốc VẬT LÝ: hàng đã rời kho chưa. Chứng từ ĐVVC, không phải trạng thái Pancake.
      leftWarehouse: sql<boolean>`${SHIPMENT_LEFT_WAREHOUSE}`.as("d_left_warehouse"),
      /**
       * Tỷ lệ giao thành công ƯỚC TÍNH của đơn (0–1) — trung bình có trọng số theo `line_total` của
       * các mã trong đơn. Dùng LẠI bộ tra của Báo cáo lợi nhuận, không viết bản thứ hai.
       */
      deliveryRate: sql<number>`${orderDeliveryRateSql(rates)}`.as("d_delivery_rate"),
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
  const open = sql`${facts.outcome} in (${sql.raw(OPEN_OUTCOMES_SQL)})`;

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
        notShippedOrders: sql<number>`count(*) filter (where ${open} and not ${facts.leftWarehouse})`,
        inTransitOrders: sql<number>`count(*) filter (where ${open} and ${facts.leftWarehouse})`,
        notShippedRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${open} and not ${facts.leftWarehouse}), 0)`,
        inTransitRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${open} and ${facts.leftWarehouse}), 0)`,
        bookedRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${booked}), 0)`,
        deliveredRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${delivered}), 0)`,
        cash: sql<number>`coalesce(sum(${facts.cash}) filter (where ${delivered}), 0)`,
        cogs: sql<number>`coalesce(sum(${facts.cogs}) filter (where ${delivered}), 0)`,
        /**
         * CƯỚC ĐÃ THỰC SỰ PHÁT SINH — định nghĩa và bằng chứng ở `realizedShippingSql`.
         * Trước 23/09/2026 công thức này được gõ lại ở ba nơi và MỘT trong ba nơi ấy sai.
         */
        shipping: realizedShippingSql({ shipping: facts.shipping, returnFee: facts.returnFee, outcome: facts.outcome }),
        /*
          ─── PHẦN ĐANG TREO, ĐÃ CÂN THEO TỶ LỆ ───

          Chỉ lọc `open`: đơn đã ngã ngũ thì không còn gì để dự báo, và nhân tỷ lệ lên chúng là ghi
          đè một SỐ ĐO bằng một con số đoán. Cùng phép cộng với `lib/queries/marketing-daily.ts`.

          CƯỚC CŨNG ĐƯỢC DỰ PHÓNG, nhưng KHÔNG nhân tỷ lệ — xem `openShippingSql`. Chủ shop chốt
          23/09/2026: đã dự phóng doanh thu của phần đang treo thì phải dự phóng cả chi phí của
          đúng phần ấy. Bản trước chỉ cộng doanh thu, và đo được nó làm lợi nhuận tạm tính lạc quan
          **5.789.000 ₫ / 30 ngày** — đủ để đổi một khuyến nghị từ CẮT thành TĂNG NGÂN SÁCH.
        */
        openProjectedRevenue: sql<number>`coalesce(sum(${facts.revenue} * ${facts.deliveryRate}) filter (where ${open}), 0)`,
        openProjectedCogs: sql<number>`coalesce(sum(${facts.cogs} * ${facts.deliveryRate}) filter (where ${open}), 0)`,
        openProjectedShipping: openShippingSql({ shipping: facts.shipping, outcome: facts.outcome }),
        openProjectedOrders: sql<number>`coalesce(sum(${facts.deliveryRate}) filter (where ${open}), 0)`,
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
async function aggregateByProduct(period: Period, rates: ProductDeliveryRates): Promise<Agg[]> {
  const db = await getDb();
  // Giá vốn theo ĐÚNG bậc thang chung (AGENTS.md mục 13): phiếu nhập ERP gần nhất → giá vốn Pancake
  // trên đơn → giá nhập mẫu mã — tính một lần cho mỗi mẫu mã (xem variantLastCostSubquery).
  const lastCost = variantLastCostSubquery(db);
  const productKeyExpr = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  const facts = db
    .select({
      key: sql<string>`${productKeyExpr}`.as("p_key"),
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
      leftWarehouse: sql<boolean>`${SHIPMENT_LEFT_WAREHOUSE}`.as("p_left_warehouse"),
      /**
       * Ở cấp này mỗi DÒNG đã mang đúng một mã hàng, nên tra thẳng tỷ lệ của mã ấy — đi vòng qua
       * trung bình có trọng số theo đơn là tính lại một thứ đã biết, và cho số khác ở đơn nhiều mã.
       */
      deliveryRate: sql<number>`${deliveryRateCaseSql(rates, productKeyExpr)}`.as("p_delivery_rate"),
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
  const open = sql`${facts.outcome} in (${sql.raw(OPEN_OUTCOMES_SQL)})`;
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
        notShippedOrders: countOrders(sql`${open} and not ${facts.leftWarehouse}`),
        inTransitOrders: countOrders(sql`${open} and ${facts.leftWarehouse}`),
        notShippedRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${open} and not ${facts.leftWarehouse}), 0)`,
        inTransitRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${open} and ${facts.leftWarehouse}), 0)`,
        bookedRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${booked}), 0)`,
        deliveredRevenue: sql<number>`coalesce(sum(${facts.lineRevenue}) filter (where ${delivered}), 0)`,
        cash: sql<number>`coalesce(sum(${facts.cash} * coalesce(${facts.shipShare}, 0)) filter (where ${delivered}), 0)`,
        cogs: sql<number>`coalesce(sum(${facts.lineCogs}) filter (where ${delivered}), 0)`,
        // CÙNG một hàm với cấp chiến dịch, chỉ thêm CĂN CỨ PHÂN BỔ: tỷ trọng doanh thu dòng trong đơn.
        shipping: realizedShippingSql({ shipping: facts.shipping, returnFee: facts.returnFee, outcome: facts.outcome, share: facts.shipShare }),
        // Phần đang treo — xem chú thích ở `aggregateByOrder`. Cước dùng CÙNG căn cứ phân bổ với cước đã phát sinh.
        openProjectedRevenue: sql<number>`coalesce(sum(${facts.lineRevenue} * ${facts.deliveryRate}) filter (where ${open}), 0)`,
        openProjectedCogs: sql<number>`coalesce(sum(${facts.lineCogs} * ${facts.deliveryRate}) filter (where ${open}), 0)`,
        openProjectedShipping: openShippingSql({ shipping: facts.shipping, outcome: facts.outcome, share: facts.shipShare }),
        /** Tỷ lệ là HẰNG SỐ trong một nhóm (nhóm = một mã), nên `max` chỉ là cách lấy nó ra khỏi phép gộp. */
        openProjectedOrders: sql<number>`coalesce(${countOrders(open)} * max(${facts.deliveryRate}), 0)`,
      })
      .from(facts)
      .groupBy(facts.key),
  );

  return rows.filter((r) => String(r.key ?? "").trim() !== "").map((r) => toAgg(r as Record<string, unknown>));
}

/** Tiền quảng cáo theo cùng khoá gộp. Cấp không có chi tiêu thì trả map RỖNG — KHÔNG chia đều. */
/** Tiền và chỉ số thô của một khoá chi tiêu. Ba cột sau đã có sẵn trong `ad_spends`, chỉ là chưa ai đọc. */
export type SpendRow = { spend: number; name: string; impressions: number; clicks: number; messages: number };

async function spendByKey(period: Period, dimension: AdsDimension): Promise<Map<string, SpendRow>> {
  if (!ADS_DIMENSION_HAS_SPEND[dimension]) return new Map();
  const db = await getDb();
  /*
    KHOÁ GỘP THEO CẤP — và hai cấp mới chỉ đọc được từ dòng ở HẠT MẨU.

    Dòng hạt CHIẾN DỊCH có `adset_id`/`ad_id` là `NULL`, nên chúng tự rơi khỏi phép gộp ở hai cấp
    dưới. Đó là hành vi ĐÚNG (không bịa ra một nhóm cho tiền không biết thuộc nhóm nào), nhưng nó
    im lặng — nên `spendGrainCoverage` bên dưới đo phần rơi ra và giao diện phải in nó.
  */
  const key =
    dimension === "product"
      ? sql`${schema.adSpends.productId}`
      : dimension === "adset"
        ? sql`${schema.adSpends.adsetId}`
        : dimension === "ad"
          ? sql`${schema.adSpends.adId}`
          : sql`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`;
  const rows = await db
    .select({
      key: sql<string>`${key}`,
      name: sql<string>`max(${
        dimension === "adset" ? schema.adSpends.adsetName : dimension === "ad" ? schema.adSpends.adName : schema.adSpends.campaign
      })`,
      spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`,
      impressions: sql<number>`coalesce(sum(${schema.adSpends.impressions}), 0)`,
      clicks: sql<number>`coalesce(sum(${schema.adSpends.clicks}), 0)`,
      messages: sql<number>`coalesce(sum(${schema.adSpends.messages}), 0)`,
    })
    .from(schema.adSpends)
    .where(spendPeriod(period.from, period.to))
    .groupBy(key);
  const map = new Map<string, SpendRow>();
  for (const r of rows) {
    const k = String(r.key ?? "").trim();
    if (!k) continue;
    map.set(k, {
      spend: Number(r.spend ?? 0),
      name: String(r.name ?? ""),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      messages: Number(r.messages ?? 0),
    });
  }
  return map;
}

/**
 * ───────────── BAO NHIÊU PHẦN CHI TIÊU CỦA KỲ CÓ CHI TIẾT TỚI CẤP MẨU ─────────────
 *
 * Lượt đồng bộ Facebook chỉ chạm N ngày gần nhất, nên ngày cũ mãi mãi ở hạt CHIẾN DỊCH và tiền của
 * chúng KHÔNG xuất hiện ở hai cấp dưới. Một bảng cấp mẩu đọc thiếu tiền mà không nói gì thì tệ hơn
 * một bảng rỗng: người đọc tin vào một ROAS tính trên nửa số tiền.
 *
 * Trả về `null` cho `pct` khi kỳ không có đồng chi tiêu nào — CHƯA ĐO ĐƯỢC, không phải 0% (mục 42).
 */
export type SpendGrainCoverage = { total: number; atAdGrain: number; pct: number | null };

async function spendGrainCoverage(period: Period): Promise<SpendGrainCoverage> {
  const db = await getDb();
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`,
      atAdGrain: sql<number>`coalesce(sum(${schema.adSpends.spend}) filter (where ${schema.adSpends.grain} = 'AD'), 0)`,
    })
    .from(schema.adSpends)
    .where(spendPeriod(period.from, period.to));
  const total = Number(row?.total ?? 0);
  const atAdGrain = Number(row?.atAdGrain ?? 0);
  return { total, atAdGrain, pct: total > 0 ? Math.round((atAdGrain / total) * 1000) / 10 : null };
}

/**
 * ───────────── TÊN CHA CHO CẤP NHÓM VÀ CẤP MẨU ─────────────
 *
 * Đọc từ `fb_ads` / `fb_adsets` chứ không từ `ad_spends`: sổ mẩu biết cả những mẩu KHÔNG tiêu tiền
 * trong kỳ đang xem (chúng vẫn có đơn từ kỳ trước), còn bảng chi tiêu thì không. Lấy từ bảng chi
 * tiêu sẽ để trống đúng những dòng khó đọc nhất.
 *
 * Trả về `Map` rỗng ở hai cấp còn lại — chiến dịch và mã hàng không có cha trong cây quảng cáo, và
 * bịa ra một cái là nói sai về hình dạng của dữ liệu.
 */
async function parentNames(dimension: AdsDimension): Promise<ParentNames> {
  const out: ParentNames = new Map();
  if (dimension !== "adset" && dimension !== "ad") return out;
  const db = await getDb();
  if (dimension === "adset") {
    const rows = await db
      .select({ adsetId: schema.fbAds.adsetId, campaignName: sql<string>`max(nullif(${schema.fbAds.campaignName}, ''))` })
      .from(schema.fbAds)
      .where(sql`${schema.fbAds.adsetId} is not null`)
      .groupBy(schema.fbAds.adsetId);
    for (const r of rows) if (r.adsetId && r.campaignName) out.set(r.adsetId, r.campaignName);
    return out;
  }
  const rows = await db
    .select({ id: schema.fbAds.id, campaignName: schema.fbAds.campaignName, adsetName: schema.fbAdsets.name })
    .from(schema.fbAds)
    .leftJoin(schema.fbAdsets, eq(schema.fbAdsets.id, schema.fbAds.adsetId));
  for (const r of rows) {
    // Ghép hai tầng bằng "›" — đọc từ trái sang là đi từ rộng vào hẹp, cùng chiều với cây quảng cáo.
    const parts = [r.campaignName, r.adsetName].map((x) => (x ?? "").trim()).filter(Boolean);
    if (parts.length) out.set(r.id, parts.join(" › "));
  }
  return out;
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
  /** Khoảng cách tới hoà vốn tính trên lợi nhuận TẠM TÍNH — căn cứ khi đơn chưa ngã ngũ. */
  projectedHeadroom: number | null;
  successRate: number | null;
  maturity: number;
  finishedOrders: number;
  /** Đơn đã lên (trừ huỷ). Đây là MẪU của căn cứ tạm tính — mỗi đơn đã lên đều có một kỳ vọng. */
  bookedOrders: number;
  appliedDeliveryRate: number | null;
  bookedRoas: number | null;
  breakEvenBookedRoas: number | null;
  deliveredOrders: number;
}): { action: AdsAction; reason: string; lowDelivery: boolean; basis: DecisionBasis } {
  const r = ADS_DECISION_RULE;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lowDelivery = input.successRate !== null && input.successRate < r.lowSuccessRate;

  /*
    ═══════════ ĐỘ CHÍN THẤP LÀ LÝ DO ĐỔI CĂN CỨ, KHÔNG PHẢI LÝ DO TỪ CHỐI KẾT LUẬN ═══════════

    Bản trước dừng lại ở hai cổng "chưa đủ đơn kết thúc" và "chưa đủ độ chín". Với mô hình BÁN
    TRƯỚC thì hai cổng ấy gần như luôn đóng: đo trên production 22/09/2026, **425/425** dòng cấp
    chiến dịch đều trả `INSUFFICIENT_DATA`, độ chín trung bình 0,02. Và không cổng nào mở ra sớm
    hơn chỉ vì ERP đợi — kết quả tiền của đồng quảng cáo hôm nay đơn giản là CHƯA TỒN TẠI.

    Nên chúng thành một phép CHỌN CĂN CỨ:
      · đủ đơn ngã ngũ  ⇒ `ACTUAL`    — quyết trên số đo;
      · chưa đủ         ⇒ `PROJECTED` — quyết trên lợi nhuận tạm tính, tức tối ưu THEO KẾ HOẠCH.

    Cái KHÔNG đổi là YÊU CẦU VỀ MẪU. Căn cứ tạm tính cần một kỳ vọng cho mỗi đơn, nên nó đòi đủ
    `minFinishedOrders` đơn ĐÃ LÊN thay vì đã kết thúc. Bỏ luôn yêu cầu ấy thì một dòng 3 đơn cũng
    có ý kiến — và đó lại đúng là thứ hai cổng cũ sinh ra để chặn.
  */
  const measured = input.finishedOrders >= r.minFinishedOrders && input.maturity >= r.minMaturity;
  const basis: DecisionBasis = measured ? "ACTUAL" : "PROJECTED";

  // CỔNG 0 — không có số chi thì không có bất kỳ kết luận nào về tiền.
  if (!input.spendKnown) {
    return {
      action: "NO_SPEND_DATA",
      reason: "Cấp này không có số chi quảng cáo (Facebook chỉ trả chi tiêu ở cấp chiến dịch/ngày), nên không tính được ROAS hay lợi nhuận.",
      lowDelivery,
      basis,
    };
  }

  // CỔNG 1 — quá ít tiền quảng cáo: chênh lệch ROAS ở đây chỉ là may rủi của vài đơn.
  if (input.spend < r.minSpend) {
    return {
      action: "INSUFFICIENT_DATA",
      reason: `Mới chi ${input.spend.toLocaleString("vi-VN")}đ, dưới mức tối thiểu ${r.minSpend.toLocaleString("vi-VN")}đ để kết luận.`,
      lowDelivery,
      basis,
    };
  }

  // CỔNG 2 — MẪU. Cùng ngưỡng cho cả hai căn cứ, chỉ khác đếm đơn nào.
  if (input.bookedOrders < r.minFinishedOrders) {
    return {
      action: "INSUFFICIENT_DATA",
      reason: `Mới có ${input.bookedOrders} đơn đã lên (cần ${r.minFinishedOrders}). Thêm hoặc bớt một đơn là tỷ lệ đổi hẳn.`,
      lowDelivery,
      basis,
    };
  }

  const h = measured ? input.headroom : input.projectedHeadroom;
  if (h === null) {
    return { action: "INSUFFICIENT_DATA", reason: "Không tính được khoảng cách tới điểm hoà vốn.", lowDelivery, basis };
  }

  const money = h >= 1 ? `lãi ${pct(h - 1)} trên tiền quảng cáo` : `lỗ ${pct(1 - h)} trên tiền quảng cáo`;
  /*
    Câu mở đầu của MỌI lý do ở căn cứ tạm tính phải nói ra nó là ước tính, và nói bằng con số nào —
    người đọc phải cãi lại được cái giả định, chứ không chỉ đọc kết luận.
  */
  /*
    KHÔNG GỌI TỶ LỆ NÀY LÀ "ƯỚC TÍNH".

    Nó có thể là số đo của chính mã, có thể là MỤC TIÊU khai chung ở Giả định — hai thứ khác hẳn
    nhau về cách sửa khi sai (mô hình sai ⇒ sửa mô hình; mục tiêu không đạt ⇒ sửa vận hành). Dòng
    này trộn nhiều mã nên nó không biết mình đang đứng trên bậc nào; nói tên bậc ở đây là đoán.

    Nên câu chữ chỉ nêu CON SỐ đã dùng, và chỉ người đọc sang dải "Căn cứ tỷ lệ GTC" ngay trên bảng
    để biết bao nhiêu mã đi bằng số đo và bao nhiêu mã đang chạy theo mục tiêu.
  */
  const nen = measured
    ? ""
    : `[TẠM TÍNH] ${pct(input.maturity)} đơn đã ngã ngũ, phần còn lại cân theo GTC ${input.appliedDeliveryRate ?? "—"}% (xem căn cứ tỷ lệ trên bảng). `;

  /**
   * CỔNG 3 — QUẢNG CÁO TỐT NHƯNG GIAO KÉM.
   *
   * Chỉ bật khi chính khâu giao là nguyên nhân: trên cơ sở ĐƠN ĐÃ LÊN thì quảng cáo đã vượt hoà
   * vốn, nhưng sau khi trừ phần hoàn thì không còn. Cắt quảng cáo ở đây là chữa sai bệnh — việc
   * phải làm là chốt đơn kỹ hơn / đóng gói / đổi ĐVVC.
   */
  if (
    measured &&
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
      basis,
    };
  }

  if (h >= r.scaleAbove) {
    return { action: "SCALE", reason: `${nen}Đang ${money}, cao hơn điểm hoà vốn ${pct(h - 1)} — còn dư địa tăng ngân sách.`, lowDelivery, basis };
  }
  if (h >= 1) {
    return { action: "HOLD", reason: `${nen}Đang ${money}: trên hoà vốn nhưng chưa đủ dày để tăng tiền (cần ${r.scaleAbove}× hoà vốn).`, lowDelivery, basis };
  }
  if (h >= r.cutBelow) {
    return { action: "WATCH", reason: `${nen}Đang ${money}, sát điểm hoà vốn. Chưa đáng cắt nhưng cũng chưa kiếm được tiền.`, lowDelivery, basis };
  }
  return {
    action: "CUT",
    reason: `${nen}Đang ${money}${input.deliveredOrders === 0 && measured ? " và chưa có đơn nào tới tay khách" : ""} — dưới ${r.cutBelow}× điểm hoà vốn, càng chạy càng lỗ.`,
    lowDelivery,
    basis,
  };
}

/**
 * Dựng một dòng quyết định từ số gộp + tiền quảng cáo. Tách hàm để kiểm thử được không cần CSDL.
 *
 * `metrics` là hiển thị / click / tin nhắn của chính khoá này. **Vắng mặt nghĩa là CHƯA BIẾT**, và
 * mọi tỷ số dẫn xuất từ nó trả `null` — không phải 0 (mục 42). Một cấp không có số chi thì cũng
 * không có ba con số này, và in "CPM 0đ" ở đó sẽ bị đọc thành "hiển thị miễn phí".
 */
export type AdMetrics = { impressions: number; clicks: number; messages: number };

/** Tên cha của một khoá ở cấp nhóm / cấp mẩu. Rỗng ở hai cấp còn lại. */
export type ParentNames = Map<string, string>;

export function buildDecisionRow(agg: Agg, dimension: AdsDimension, spend: number, spendKnown: boolean, metrics?: AdMetrics, parentName?: string | null): AdsDecisionRow {
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

  /*
    ─── CĂN CỨ TẠM TÍNH: CỘNG PHẦN ĐANG TREO ĐÃ CÂN THEO TỶ LỆ ───

    Cộng vào phần đã đo, KHÔNG thay nó: đơn đã có kết cục thì không còn gì để dự báo. Cùng phép
    cộng với `lib/queries/marketing-daily.ts`, nên hai báo cáo không nói hai con số.

    CƯỚC CŨNG ĐƯỢC CỘNG, VÀ KHÔNG NHÂN TỶ LỆ.

    Doanh thu chỉ về khi giao được nên nó nhân GTC; cước thì mất cả hai đường — giao được tốn cước
    đi, hoàn tốn cước đi cộng cước về. Nhân GTC vào cước là giả định đơn hoàn được miễn cước.

    Bản trước chỉ cộng doanh thu tương lai mà bỏ chi phí tương lai của đúng những đơn ấy. Đo
    production 23/09/2026: lợi nhuận tạm tính lạc quan **5.789.000 ₫ / 30 ngày** — với biên mỏng,
    ngần ấy đủ để đổi một khuyến nghị từ CẮT thành TĂNG NGÂN SÁCH. Chủ shop chốt sửa cùng ngày.

    CÒN THIẾU, và nói ra thay vì lặng lẽ bù: phí hoàn của đơn đang treo. `orders.return_fee` chỉ
    tồn tại sau khi hoàn thật, nên nhân nó với tỷ lệ hoàn là nhân với một ô trống.
  */
  const projectedDeliveredRevenue = agg.deliveredRevenue + agg.openProjectedRevenue;
  const projectedContributionBeforeAds =
    projectedDeliveredRevenue - (agg.cogs + agg.openProjectedCogs) - (agg.shipping + agg.openProjectedShipping);
  const projectedProfitAfterAds = projectedContributionBeforeAds - spendForRatio;
  const projectedHeadroom = spendKnown && spendForRatio > 0 ? round2(projectedContributionBeforeAds / spendForRatio) : null;
  /*
    Tỷ lệ THẬT SỰ đã áp cho dòng này, đọc ngược ra từ chính phép nhân đã làm trong SQL. Không tra
    lại bản đồ tỷ lệ ở TypeScript: một dòng cấp chiến dịch trộn nhiều mã hàng, và trọng số của phép
    trộn ấy là tiền — thứ chỉ SQL vừa mới biết.

    Mẫu số 0 (dòng không có đơn nào đang treo) ⇒ `null` = KHÔNG CÓ GÌ ĐỂ ƯỚC TÍNH, không phải 0%.
  */
  const openRevenue = agg.notShippedRevenue + agg.inTransitRevenue;
  const appliedDeliveryRate = openRevenue > 0 ? Math.round((agg.openProjectedRevenue / openRevenue) * 1000) / 10 : null;

  const rate = successRate(agg.deliveredOrders, agg.returnedOrders);
  const bookedRoas = spendKnown ? ratio(agg.bookedRevenue, spendForRatio) : null;

  const { action, reason, lowDelivery, basis } = decideAction({
    spendKnown,
    spend: spendForRatio,
    headroom,
    projectedHeadroom,
    successRate: rate,
    maturity,
    finishedOrders: finished,
    bookedOrders: agg.bookedOrders,
    appliedDeliveryRate,
    bookedRoas,
    breakEvenBookedRoas,
    deliveredOrders: agg.deliveredOrders,
  });

  /*
    ─── CHỈ SỐ QUẢNG CÁO: CHƯA BIẾT THÌ LÀ `null`, KHÔNG PHẢI 0 ───

    `metrics` vắng mặt ⇔ cấp này không có số chi (nhóm / mẩu), nên cả ba con số thô lẫn mọi tỷ số
    dẫn xuất đều là CHƯA BIẾT. Điền 0 vào đây sẽ cho "CPM 0đ" và "tỷ lệ chốt 0%" — hai câu nói
    ngược hẳn sự thật.
  */
  const m = spendKnown ? metrics : undefined;
  const impressions = m ? m.impressions : null;
  const clicks = m ? m.clicks : null;
  const messages = m ? m.messages : null;
  const cpm = impressions !== null && impressions > 0 ? Math.round((spendForRatio / impressions) * 1000) : null;
  const cpc = clicks !== null && clicks > 0 ? Math.round(spendForRatio / clicks) : null;
  const costPerMessage = messages !== null && messages > 0 ? Math.round(spendForRatio / messages) : null;
  const costPerOrder = spendKnown && agg.bookedOrders > 0 ? Math.round(spendForRatio / agg.bookedOrders) : null;
  const closeRate = messages !== null && messages > 0 ? Math.round((agg.bookedOrders / messages) * 1000) / 10 : null;

  return {
    key: agg.key,
    name: agg.name,
    parentName: parentName ?? null,
    dimension,
    spendKnown,
    spend: spendForRatio,
    bookedOrders: agg.bookedOrders,
    deliveredOrders: agg.deliveredOrders,
    returnedOrders: agg.returnedOrders,
    openOrders: agg.openOrders,
    notShippedOrders: agg.notShippedOrders,
    notShippedRevenue: agg.notShippedRevenue,
    inTransitOrders: agg.inTransitOrders,
    inTransitRevenue: agg.inTransitRevenue,
    bookedRevenue: agg.bookedRevenue,
    deliveredRevenue: agg.deliveredRevenue,
    cashReceived: agg.cash,
    cogs: agg.cogs,
    shippingCost: agg.shipping,
    contributionBeforeAds,
    profitAfterAds,
    basis,
    projectedDeliveredRevenue: Math.round(projectedDeliveredRevenue),
    projectedProfitAfterAds: Math.round(projectedProfitAfterAds),
    projectedHeadroom,
    appliedDeliveryRate,
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
    impressions,
    clicks,
    messages,
    cpm,
    cpc,
    costPerMessage,
    costPerOrder,
    closeRate,
    // Dùng LẠI `adsRatio()` của báo cáo lợi nhuận — mẫu số 0 ⇒ null, không bao giờ 0%.
    adsPctOverPos: spendKnown ? adsRatio(spendForRatio, agg.bookedRevenue) : null,
    adsPctOverDelivered: spendKnown ? adsRatio(spendForRatio, agg.deliveredRevenue) : null,
    action,
    reason,
    lowDelivery,
    // Hai trường dưới gắn ở `decisionUncached`: dựng dòng thì chưa biết gì về mã hàng lẫn bảng ghép.
    inherited: null,
    spendClass: null,
  };
}

/**
 * ───────── MỘT DÒNG CÓ MƯỢN ĐƯỢC KẾT LUẬN KHÔNG, VÀ NẾU KHÔNG THÌ VÌ SAO ─────────
 *
 * Hàm THUẦN, vì đây là chỗ dễ sai nhất của cả tính năng: bốn ngả rẽ, và ba trong số đó trông giống
 * hệt nhau trên màn hình nếu ai đó gộp chúng ("chưa đủ dữ liệu"). Gộp là đúng thứ đã giấu
 * 45.726.057 ₫ suốt hai ngày.
 *
 *  · `OWN`            — dòng tự kết luận được, không mượn gì. KHÔNG BAO GIỜ đè lên kết luận của nó.
 *  · `INHERITED`      — mượn được của mã hàng.
 *  · `TEST`           — chi phí thử fanpage/mẫu mới. KHÔNG phải chỗ trống, và không đi mượn.
 *  · `UNLINKED`       — chưa nối được về mã nào và cũng không khai là test. SỬA ĐƯỢC, cần người.
 *  · `PRODUCT_SILENT` — nối được, nhưng mã cũng chưa kết luận. Đợi dữ liệu, không sửa tay được.
 */
export type InheritBucket = "OWN" | "INHERITED" | "TEST" | "UNLINKED" | "PRODUCT_SILENT";

export function inheritVerdict(
  ownAction: AdsAction,
  productId: string | undefined,
  productVerdict: { key: string; name: string; action: AdsAction; reason: string } | undefined,
  spendClass: AdsSpendClass | null = null,
): { bucket: InheritBucket; inherited: InheritedVerdict | null } {
  /*
    CHỈ dòng `INSUFFICIENT_DATA` mới mượn. `NO_SPEND_DATA` thì KHÔNG: ở đó ERP không đọc được cả số
    chi, nên gắn một kết luận về tiền vào đấy là nói về thứ mình không nhìn thấy. Và `HOLD`/`WATCH`
    cũng là kết luận thật — đè lên chúng là thay một câu ĐÚNG bằng một câu chung chung hơn.
  */
  if (ownAction !== "INSUFFICIENT_DATA") return { bucket: "OWN", inherited: null };
  /*
    CHI PHÍ TEST KHÔNG PHẢI MỘT CHỖ TRỐNG, NÊN NÓ KHÔNG ĐI MƯỢN.

    Nó không thuộc mã hàng nào một cách CỐ Ý. Cho nó mượn kết luận của một mã là gán cho một phép
    thử fanpage cái điểm hoà vốn của một mã bán hàng — hai câu hỏi khác nhau. Đo 23/09/2026:
    318 dòng · 7.457.012 ₫ nằm ở nhóm này, tức 2/3 phần tiền trước nay bị gọi nhầm là "thiếu dữ liệu".
  */
  if (spendClass === "TEST") return { bucket: "TEST", inherited: null };
  if (!productId) return { bucket: "UNLINKED", inherited: null };
  if (!productVerdict || productVerdict.action === "INSUFFICIENT_DATA" || productVerdict.action === "NO_SPEND_DATA") {
    return { bucket: "PRODUCT_SILENT", inherited: null };
  }
  return {
    bucket: "INHERITED",
    inherited: { productKey: productVerdict.key, productName: productVerdict.name, action: productVerdict.action, reason: productVerdict.reason },
  };
}

/**
 * ───────── CHIẾN DỊCH NÀO ĐANG CHẠY MÃ NÀO ─────────
 *
 * Đọc thẳng `ad_spends`: cùng bảng, cùng kỳ, cùng không gian khoá với `spendByKey` — nên bản đồ
 * này không thể lệch khỏi phép gộp tiền ở trên.
 *
 * Một chiến dịch chạy nhiều mã thì lấy mã CHI NHIỀU NHẤT. Đó là một lựa chọn, không phải sự thật:
 * kết luận mượn khi ấy nói về phần lớn tiền của chiến dịch chứ không phải toàn bộ. Chia nhỏ kết
 * luận theo tỷ trọng sẽ cho một câu chữ không ai đọc được ("60% nên cắt, 40% nên tăng").
 */
async function campaignProductLink(period: Period): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db
    .select({
      campaignKey: sql<string>`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`,
      productId: sql<string>`${schema.adSpends.productId}`,
      spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`,
    })
    .from(schema.adSpends)
    .where(and(spendPeriod(period.from, period.to), sql`${schema.adSpends.productId} is not null`))
    .groupBy(sql`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`, schema.adSpends.productId);

  const best = new Map<string, { productId: string; spend: number }>();
  for (const r of rows) {
    const key = String(r.campaignKey ?? "");
    const pid = String(r.productId ?? "");
    if (!key || !pid) continue;
    const cur = best.get(key);
    if (!cur || Number(r.spend) > cur.spend) best.set(key, { productId: pid, spend: Number(r.spend) });
  }
  return new Map([...best].map(([k, v]) => [k, v.productId]));
}

async function decisionUncached(period: Period, dimension: AdsDimension): Promise<AdsDecision> {
  const spendKnown = ADS_DIMENSION_HAS_SPEND[dimension];
  /*
    BẢN ĐỒ TỶ LỆ PHẢI CÓ TRƯỚC PHÉP GỘP: nó đi thẳng vào SQL (một vế `case` trong bảng dẫn xuất),
    chứ không nhân lại ở TypeScript. Trọng số của phép trộn nhiều mã trong một dòng là TIỀN, và chỉ
    phép gộp mới biết số tiền ấy.
  */
  const rates = await productDeliveryRates(period);
  const [aggs, spend, coverage, spendDetail, cha] = await Promise.all([
    dimension === "product" ? aggregateByProduct(period, rates) : aggregateByOrder(period, dimension, rates),
    spendByKey(period, dimension),
    adsAttributionCoverage(period.from, period.to),
    spendGrainCoverage(period),
    parentNames(dimension),
  ]);

  const rows: AdsDecisionRow[] = [];
  const seen = new Set<string>();
  for (const agg of aggs) {
    seen.add(agg.key);
    const sp = spend.get(agg.key);
    rows.push(buildDecisionRow(agg, dimension, sp?.spend ?? 0, spendKnown, sp, cha.get(agg.key) ?? null));
  }

  /**
   * TIỀN ĐÃ TIÊU MÀ KHÔNG CÓ ĐƠN NÀO GẮN VÀO — vẫn phải hiện, đó là tiền đã mất dấu.
   *
   * ─── VÌ SAO NHÁNH NÀY TỪNG BỊ KHOÁ Ở HAI CẤP DƯỚI, VÀ VÌ SAO NAY MỞ ─────
   *
   * Trước 22/09/2026 `ad_spends` chỉ có hạt CHIẾN DỊCH, nên khoá chi tiêu (mã chiến dịch) và khoá
   * gộp đơn ở cấp mẩu/nhóm (mã mẩu / mã nhóm) **không cùng một không gian** — mọi chiến dịch sẽ
   * trông như "không có đơn nào", một kết luận sai hoàn toàn.
   *
   * Nay chi tiêu ghi ở hạt MẨU, nên ở cấp mẩu khoá là `ad_id` và ở cấp nhóm là `adset_id` — đúng
   * cùng không gian với `fb_ads.id` / `fb_ads.adset_id` mà đơn gộp theo. Nhánh này vì thế có nghĩa
   * ở cả bốn cấp.
   *
   * Dòng chi tiêu của những NGÀY còn ở hạt chiến dịch mang `adset_id`/`ad_id` là `NULL`, nên chúng
   * tự rơi khỏi phép gộp ở hai cấp dưới thay vì bịa ra một nhóm — và phần rơi ra được đếm riêng ở
   * `spendDetail`, in ngay trên bảng.
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
            notShippedOrders: 0,
            notShippedRevenue: 0,
            inTransitOrders: 0,
            inTransitRevenue: 0,
            bookedRevenue: 0,
            deliveredRevenue: 0,
            cash: 0,
            cogs: 0,
            shipping: 0,
            // Không đơn nào ⇒ không có gì đang treo ⇒ không có gì để ước tính. Đây là 0 THẬT.
            openProjectedRevenue: 0,
            openProjectedCogs: 0,
            openProjectedShipping: 0,
            openProjectedOrders: 0,
          },
          dimension,
          value.spend,
          true,
          value,
          cha.get(key) ?? null,
        ),
      );
    }
  }

  /*
    ═══════════ MƯỢN KẾT LUẬN CỦA MÃ HÀNG CHO DÒNG KHÔNG TỰ KẾT LUẬN ĐƯỢC ═══════════

    Chỉ ở cấp CHIẾN DỊCH. Ba cấp kia không cần: cấp mã hàng LÀ nguồn cho mượn, còn nhóm/mẩu nằm
    DƯỚI chiến dịch nên mượn của mã hàng ở đó là nhảy qua hai tầng bằng chứng cùng lúc.

    Kết luận cho mượn lấy trên ĐÚNG KỲ người dùng đang xem, không lấy từ sổ. Sổ chạy trên kỳ chuẩn
    (lùi 15 ngày) nên trộn vào đây sẽ cho một màn hình mà hai nửa nói về hai khoảng thời gian khác
    nhau — thứ AGENTS.md mục 58 cấm.
  */
  const inheritedCoverage = { rows: 0, spend: 0, unlinkedRows: 0, unlinkedSpend: 0, productSilentRows: 0, productSilentSpend: 0, testRows: 0, testSpend: 0 };
  if (dimension === "campaign") {
    /*
      PHÂN LOẠI ĐỌC RA LÚC XEM, KHÔNG ĐỌC TỪ MỘT CỘT ĐÃ LƯU.

      `ad_spends` chỉ giữ `product_id`, nên "test" và "chưa phân loại" cùng thành `NULL` ở đó. Bảng
      ghép (`ads.campaignMap`, bí danh, sổ mã hàng) mới là thứ biết phân biệt — và nó đổi được bất
      cứ lúc nào, nên câu trả lời phải tính lại mỗi lượt đọc (mục 56 · 62).
    */
    const [link, theoMa, mapping, codeIndex] = await Promise.all([
      campaignProductLink(period),
      getAdsDecision(period, "product"),
      loadAdsMapping(),
      loadProductCodeIndex(),
    ]);
    const verdictOf = new Map(theoMa.rows.map((r) => [r.key, r]));
    for (const row of rows) {
      const r = resolveCampaign(row.key, row.name, mapping, codeIndex);
      row.spendClass = spendClassOf(r.source, link.get(row.key) ?? r.productId, r.excluded);
      const { bucket, inherited } = inheritVerdict(row.action, link.get(row.key), verdictOf.get(link.get(row.key) ?? ""), row.spendClass);
      if (bucket === "OWN") continue;
      if (bucket === "TEST") {
        inheritedCoverage.testRows += 1;
        inheritedCoverage.testSpend += row.spend;
      } else if (bucket === "UNLINKED") {
        inheritedCoverage.unlinkedRows += 1;
        inheritedCoverage.unlinkedSpend += row.spend;
      } else if (bucket === "PRODUCT_SILENT") {
        inheritedCoverage.productSilentRows += 1;
        inheritedCoverage.productSilentSpend += row.spend;
      } else {
        row.inherited = inherited;
        inheritedCoverage.rows += 1;
        inheritedCoverage.spend += row.spend;
      }
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
      notShippedOrders: t.notShippedOrders + r.notShippedOrders,
      notShippedRevenue: t.notShippedRevenue + r.notShippedRevenue,
      inTransitOrders: t.inTransitOrders + r.inTransitOrders,
      inTransitRevenue: t.inTransitRevenue + r.inTransitRevenue,
      returnedOrders: t.returnedOrders + r.returnedOrders,
      // Cộng chỉ số thô: `null` (chưa biết) KHÔNG được cộng như 0 — giữ null cho cả tổng.
      messages: r.messages === null ? t.messages : (t.messages ?? 0) + r.messages,
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
      notShippedOrders: 0,
      notShippedRevenue: 0,
      inTransitOrders: 0,
      inTransitRevenue: 0,
      returnedOrders: 0,
      messages: null as number | null,
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
    spendDetail,
    inheritedCoverage,
    rateBasis: { fallbackDeliveryRate: rates.fallback.deliveryRate, coverage: rateCoverage(rates), projectionError: rates.projectionError },
    confidence: {
      coveragePct: coverage.coveragePct,
      verdict: coverageVerdict(coverage.coveragePct, LOW_COVERAGE_PCT),
      threshold: LOW_COVERAGE_PCT,
      attributedOrders: coverage.uniqueDeterministic,
      attributableOrders: coverage.attributable,
      totalOrders: coverage.total,
      notFromAdsOrders: coverage.notFromAds,
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
