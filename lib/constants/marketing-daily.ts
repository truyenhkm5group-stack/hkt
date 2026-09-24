/**
 * ═══════════ HỢP ĐỒNG BÁO CÁO HIỆU QUẢ MARKETING THEO NGÀY ═══════════
 *
 * Đặc tả đầy đủ: `docs/marketing-daily-contract.md`.
 *
 * ─── CÂU HỎI DUY NHẤT MÀ BÁO CÁO NÀY TRẢ LỜI ───
 *
 *   "Tiền quảng cáo tiêu NGÀY HÔM ĐÓ cuối cùng đẻ ra bao nhiêu đơn, bao nhiêu tiền về, và lãi hay
 *    lỗ bao nhiêu?"
 *
 * Câu hỏi đó ép ra một lựa chọn không thể thương lượng: **ngày của một dòng là NGÀY LÊN ĐƠN**, kể
 * cả khi đơn đó mãi năm ngày sau mới giao được. Đẩy doanh thu sang ngày giao là trả lời một câu
 * hỏi khác (câu hỏi DÒNG TIỀN) bằng bảng của câu hỏi này.
 *
 * ─── TỆP NÀY KHÔNG ĐỊNH NGHĨA MỘT CÔNG THỨC TIỀN NÀO ───
 *
 * Kết quả đơn vẫn là `ORDER_OUTCOME`; doanh thu / giá vốn / chi phí vận hành vẫn đi qua
 * `lib/queries/reports.ts` (bộ máy lợi nhuận canonical). Tệp này chỉ khai:
 *   · một dòng = một ngày, và ngày ấy đo theo mốc nào;
 *   · mỗi ô là tử số nào chia mẫu số nào (để hàng TỔNG tính lại được, không bao giờ trung bình %);
 *   · khi nào một ô là CHƯA BIẾT thay vì 0.
 *
 * ─── VÌ SAO CÓ HAI CỘT LỢI NHUẬN ───
 *
 * `contributionProfit` (lợi nhuận góp sau quảng cáo) = DT giao − giá vốn − cước − phí hoàn − phí
 * sàn − chi QC. Nó LỌC ĐƯỢC theo marketer / mã hàng / chiến dịch, vì mọi vế đều đếm được trên đúng
 * tập đơn ấy.
 *
 * `netProfit` (lợi nhuận canonical) = contribution − chi phí vận hành phân bổ. Chi phí vận hành là
 * của CẢ SHOP (tiền thuê, lương, phần mềm) và không có căn cứ nào chia nó cho một chiến dịch. Nên
 * khi bật bất kỳ bộ lọc chiều nào, `netProfit` là **`null` — CHƯA BIẾT**, không phải bằng
 * contribution và càng không phải 0. Chia đều chi phí cố định theo doanh thu là bịa một căn cứ
 * phân bổ, đúng thứ AGENTS.md mục 14 cấm.
 */
import type { ReportBasis } from "@/lib/queries/reports";

/** Mốc lọc của báo cáo. Dùng lại đúng hai mốc của bộ máy lợi nhuận — không dựng từ vựng thứ hai. */
export type MarketingBasis = ReportBasis;

export const MARKETING_BASIS_LABEL: Record<MarketingBasis, string> = {
  created: "Theo ngày phát sinh đơn (cohort)",
  delivered: "Theo ngày ghi nhận (tài chính)",
};

export const MARKETING_BASIS_QUESTION: Record<MarketingBasis, string> = {
  created:
    "Tiền quảng cáo tiêu ngày hôm đó cuối cùng ra kết quả gì? Đơn lên ngày 01/09 mà giao ngày 05/09 vẫn thuộc dòng 01/09. ĐÂY LÀ MỐC ĐÚNG ĐỂ ĐÁNH GIÁ QUẢNG CÁO.",
  delivered:
    "Ngày hôm đó thực sự ghi nhận được bao nhiêu tiền? Dùng cho tài chính / dòng tiền. KHÔNG dùng để chấm quảng cáo: chi quảng cáo vẫn đứng ở ngày tiêu, còn doanh thu đã nhảy sang ngày giao — hai vế không cùng một tập đơn, nên ROAS ở mốc này là con số không so được.",
};

/** Mốc mặc định. Báo cáo này sinh ra để đánh giá quảng cáo, nên cohort là mặc định. */
export const MARKETING_BASIS_DEFAULT: MarketingBasis = "created";

/**
 * ───────────── CHIỀU LỌC / BÓC TÁCH ─────────────
 *
 * `spendGrain` = chiều này có số CHI TIÊU riêng hay không. Facebook Insights được đồng bộ ở cấp
 * CHIẾN DỊCH/ngày (xem `lib/queries/ads-roas.ts`), nên nhóm theo adset/mẩu quảng cáo thì tiền chi
 * là CHƯA BIẾT — không được chia đều tiền chiến dịch cho các mẩu để bảng trông đầy đủ.
 */
export const MARKETING_DIMENSIONS = ["marketer", "product", "page", "campaign", "adset", "ad", "source"] as const;
export type MarketingDimension = (typeof MARKETING_DIMENSIONS)[number];

export const MARKETING_DIMENSION_LABEL: Record<MarketingDimension, string> = {
  marketer: "MKTer",
  product: "Mã hàng",
  page: "Fanpage",
  campaign: "Chiến dịch",
  adset: "Nhóm quảng cáo",
  ad: "Mẩu quảng cáo",
  source: "Nguồn đơn",
};

export const MARKETING_DIMENSION_SPEND: Record<MarketingDimension, boolean> = {
  marketer: true,
  product: true,
  campaign: true,
  page: false,
  adset: false,
  ad: false,
  source: false,
};

/** Vì sao một chiều không có số chi — hiện ngay cạnh cột trống, không để người đọc tự đoán. */
export const MARKETING_DIMENSION_NO_SPEND_HINT =
  "Facebook chỉ trả số chi ở cấp CHIẾN DỊCH theo ngày. Ở chiều này không tồn tại con số chi tiêu, nên ROAS / CPA / giá tin nhắn là CHƯA BIẾT — cố ý không chia đều tiền chiến dịch xuống.";

/** Khoá nhóm cho dòng KHÔNG quy kết được về chiều đang xem. Luôn hiện, không bao giờ bị lọc mất. */
export const MARKETING_UNATTRIBUTED = "__unattributed__" as const;
export const MARKETING_UNATTRIBUTED_LABEL = "Chưa quy kết";

/**
 * ───────────── ĐỘ CHÍN CỦA MỘT NGÀY (MATURITY) ─────────────
 *
 * Đơn hôm nay chưa ai biết có giao được không. In lợi nhuận của ngày hôm nay cạnh lợi nhuận của
 * ngày 20 hôm trước mà không nói gì là mời người đọc so hai thứ không so được.
 *
 * `maturity` = (giao thành công + hoàn) ÷ (giao thành công + hoàn + đang đi). Đơn HUỶ không nằm ở
 * đâu trong phân số này: nó đã ngã ngũ nhưng không phải kết quả logistics.
 *
 * Ba ngưỡng dưới đây KHÔNG quyết định một con số tiền nào — chúng chỉ quyết định khi nào màn hình
 * thôi tô màu và thôi xếp hạng. Đó là lý do chúng được phép nằm trong mã nguồn, khác hẳn đích
 * đạt/không đạt (những thứ đó nằm ở `metric_targets`, AGENTS.md mục 38).
 */
export const MATURITY = {
  /** Từ mức này trở lên thì coi kết quả tiền của ngày đó đã ngã ngũ. */
  final: 0.95,
  /** Dưới mức này thì KHÔNG kết luận lãi/lỗ, KHÔNG tô màu, KHÔNG xếp hạng. */
  tooEarly: 0.6,
} as const;

export type MaturityState = "FINAL" | "PARTIAL" | "TOO_EARLY" | "NO_ORDERS";

export const MATURITY_LABEL: Record<MaturityState, string> = {
  FINAL: "Đã ngã ngũ",
  PARTIAL: "Còn đơn đang đi",
  TOO_EARLY: "Chưa kết luận được",
  NO_ORDERS: "Chưa có đơn",
};

export const MATURITY_HINT: Record<MaturityState, string> = {
  FINAL: `Từ ${Math.round(MATURITY.final * 100)}% đơn trở lên đã có kết quả cuối. Con số lợi nhuận của ngày này đọc được như kết quả thật.`,
  PARTIAL: "Phần lớn đơn đã có kết quả nhưng vẫn còn đơn đang đi. Lợi nhuận còn có thể đổi.",
  TOO_EARLY: `Dưới ${Math.round(MATURITY.tooEarly * 100)}% đơn có kết quả cuối. Lợi nhuận hiện tại là phần ĐÃ GHI NHẬN, KHÔNG phải kết quả cuối cùng của ngày — không xếp hạng, không tô màu.`,
  NO_ORDERS: "Ngày này chưa có đơn đã xác nhận nào, nên không có gì để chín.",
};

export function maturityState(finished: number, pending: number): MaturityState {
  const total = finished + pending;
  if (total === 0) return "NO_ORDERS";
  const ratio = finished / total;
  if (ratio >= MATURITY.final) return "FINAL";
  return ratio >= MATURITY.tooEarly ? "PARTIAL" : "TOO_EARLY";
}

/**
 * ───────────── SỔ CHỈ SỐ CỦA BẢNG ─────────────
 *
 * Mỗi ô của bảng phải trả lời được sáu câu ngay trên tooltip: nghĩa là gì · tử số · mẫu số · nguồn
 * · đo ở thời điểm nào · chưa biết thì in gì. Một bảng 30 cột mà không có sáu câu đó sẽ được đọc
 * bằng phỏng đoán, và phỏng đoán về tiền thì tốn tiền.
 *
 * `num`/`den` KHÔNG phải để trang trí: hàng TỔNG tính lại mọi tỷ lệ TỪ CHÍNH HAI KHOÁ NÀY
 * (`aggregateRatios`), nên không có đường nào để một phần trăm bị lấy trung bình (AGENTS.md mục
 * 8.12 / yêu cầu 27).
 */
export const MARKETING_COLUMN_GROUPS = ["FUNNEL", "REVENUE", "DELIVERY", "COST", "PROFIT"] as const;
export type MarketingColumnGroup = (typeof MARKETING_COLUMN_GROUPS)[number];

export const MARKETING_GROUP_LABEL: Record<MarketingColumnGroup, string> = {
  FUNNEL: "Phễu marketing",
  REVENUE: "Doanh thu",
  DELIVERY: "Giao hàng",
  COST: "Chi phí",
  PROFIT: "Lợi nhuận",
};

export type MarketingUnit = "VND" | "COUNT" | "PERCENT" | "RATIO";

export type MarketingMetricSpec = {
  key: string;
  label: string;
  group: MarketingColumnGroup;
  unit: MarketingUnit;
  /** Một câu: ô này nói lên điều gì. */
  meaning: string;
  /** Tử số đếm cái gì. `null` với số tuyệt đối (tiền, số đếm). */
  numerator: string | null;
  denominator: string | null;
  /** Bảng / hằng số có thật mà con số đọc từ đó. */
  source: string;
  /** Đo ở mốc nào — trả lời "con số này thuộc ngày nào và vì sao". */
  timing: string;
  /** Mẫu số 0 / chưa có quan sát thì in gì. */
  nullRule: string;
  /** Khoá cộng được để hàng TỔNG tính lại tỷ lệ. Chỉ có ở ô dạng tỷ lệ. */
  num?: string;
  den?: string;
  /** `UP` càng cao càng tốt · `DOWN` càng thấp càng tốt · `CONTEXT` chỉ để đọc. */
  direction: "UP" | "DOWN" | "CONTEXT";
  /**
   * Ô này là SUY ĐOÁN, không phải phép đo (AGENTS.md mục 8.6). Màn hình KHÔNG được tô màu nó và
   * phải in nhãn — một con số giả định tô xanh là một con số giả định trông như đã đo.
   */
  estimated?: boolean;
};

const SPEND_SOURCE = "ad_spends (excluded = false) gộp theo spend_date, giờ VN";
/** Một câu, dán vào MỌI ô ước tính: căn cứ ở đâu ra và nó KHÔNG phải một phép đo. */
const ESTIMATE_NOTE =
  "Tỷ lệ theo THANG BẬC chung (lib/constants/delivery-rate.ts): ghi đè tay → số đo từng đơn của chính mã → lịch sử 90 ngày của mã → tỷ lệ khai ở Giả định. ĐÂY LÀ SUY ĐOÁN, không phải phép đo.";
const ORDER_SOURCE = "orders ⋈ shipments qua ORDER_OUTCOME (lib/queries/return-rate.ts), population đơn đã xác nhận";

export const MARKETING_METRICS: MarketingMetricSpec[] = [
  /* ───── Phễu ───── */
  {
    key: "adSpend",
    label: "Chi quảng cáo",
    group: "FUNNEL",
    unit: "VND",
    meaning: "Tiền thực chi cho quảng cáo trong ngày, theo tài khoản quảng cáo — không phải khoản gõ tay ở bảng Chi phí.",
    numerator: null,
    denominator: null,
    source: SPEND_SOURCE,
    timing: "Ngày Facebook ghi nhận chi tiêu. KHÔNG dịch theo mốc đơn: tiền tiêu ngày nào đứng ở ngày đó ở cả hai chế độ.",
    nullRule:
      "Phân biệt bằng BIÊN QUAN SÁT (ngày gần nhất nguồn chi tiêu đã nói tới). Trong biên mà không có dòng nào ⇒ hôm đó thật sự không chạy quảng cáo ⇒ `0 ₫`. Ngoài biên (đồng bộ chưa tới ngày đó) ⇒ `—`, KHÔNG in 0: đồng bộ chết mà in 0 thì lợi nhuận sai toàn bộ.",
    direction: "CONTEXT",
  },
  {
    key: "messages",
    label: "Tin nhắn / lead",
    group: "FUNNEL",
    unit: "COUNT",
    meaning: "Số hội thoại quảng cáo tạo ra (Facebook: messaging_conversation_started), lấy giá trị lớn hơn giữa tin nhắn và lead.",
    numerator: null,
    denominator: null,
    source: SPEND_SOURCE,
    timing: "Cùng ngày chi tiêu của Facebook.",
    nullRule: "Không có dòng chi tiêu ⇒ `—`.",
    direction: "UP",
  },
  {
    key: "costPerMessage",
    label: "Giá / tin nhắn",
    group: "FUNNEL",
    unit: "VND",
    meaning: "Một hội thoại tốn bao nhiêu tiền quảng cáo.",
    numerator: "chi quảng cáo",
    denominator: "tin nhắn",
    source: SPEND_SOURCE,
    timing: "Trong ngày.",
    nullRule: "0 tin nhắn ⇒ `—` (không phải 0đ, không phải vô cực).",
    num: "adSpend",
    den: "messages",
    direction: "DOWN",
  },
  {
    key: "orders",
    label: "Đơn xác nhận",
    group: "FUNNEL",
    unit: "COUNT",
    meaning: "Đơn đã xác nhận trên Pancake, đã loại đơn huỷ/xoá và đơn bị kết luận TRÙNG.",
    numerator: null,
    denominator: null,
    source: `${ORDER_SOURCE}; trùng đơn loại theo order_attributions.status = 'DUPLICATE'`,
    timing: "Mốc đang chọn (mặc định: ngày lên đơn).",
    nullRule: "Không có đơn ⇒ 0 (đếm được là 0, không phải chưa biết).",
    direction: "UP",
  },
  {
    key: "units",
    label: "Sản phẩm",
    group: "FUNNEL",
    unit: "COUNT",
    meaning: "Tổng số lượng sản phẩm trên các đơn đó, kể cả hàng tặng.",
    numerator: null,
    denominator: null,
    source: "order_items.quantity",
    timing: "Theo đơn.",
    nullRule: "0 là 0.",
    direction: "UP",
  },
  {
    key: "unitsPerOrder",
    label: "SP / đơn",
    group: "FUNNEL",
    unit: "RATIO",
    meaning: "Một đơn trung bình có mấy sản phẩm — đọc khả năng bán kèm.",
    numerator: "sản phẩm",
    denominator: "đơn xác nhận",
    source: "order_items / orders",
    timing: "Theo đơn.",
    nullRule: "0 đơn ⇒ `—`.",
    num: "units",
    den: "orders",
    direction: "UP",
  },
  {
    key: "closeRate",
    label: "Tỷ lệ chốt",
    group: "FUNNEL",
    unit: "PERCENT",
    meaning: "Bao nhiêu phần trăm hội thoại thành đơn xác nhận.",
    numerator: "đơn xác nhận",
    denominator: "tin nhắn",
    source: `${ORDER_SOURCE} ÷ ${SPEND_SOURCE}`,
    timing:
      "Tử số theo mốc đơn, mẫu số theo ngày Facebook. Hai vế cùng ngày nhưng KHÔNG cùng một tập bản ghi — khách nhắn hôm nay chốt ngày mai vẫn rơi vào hai dòng khác nhau. Đọc như một xu hướng, không như một tỷ lệ chuyển đổi tuyệt đối.",
    nullRule: "0 tin nhắn ⇒ `—`, không bao giờ Infinity/NaN.",
    num: "orders",
    den: "messages",
    direction: "UP",
  },
  {
    key: "costPerOrder",
    label: "CPQC / đơn",
    group: "FUNNEL",
    unit: "VND",
    meaning: "Một đơn xác nhận tốn bao nhiêu tiền quảng cáo (CPA).",
    numerator: "chi quảng cáo",
    denominator: "đơn xác nhận",
    source: `${SPEND_SOURCE} ÷ ${ORDER_SOURCE}`,
    timing: "Trong ngày.",
    nullRule: "0 đơn ⇒ `—`. Có chi mà 0 đơn là CẢNH BÁO, không phải một con số.",
    num: "adSpend",
    den: "orders",
    direction: "DOWN",
  },

  /* ───── Doanh thu ───── */
  {
    key: "posRevenue",
    label: "Doanh số POS",
    group: "REVENUE",
    unit: "VND",
    meaning: "Giá trị đơn khách đã chốt (sau giảm giá). Đo khả năng CHỐT, chưa nói gì về tiền thật.",
    numerator: null,
    denominator: null,
    source: "orders.total_price_after_discount của đơn không huỷ",
    timing: "Mốc đang chọn.",
    nullRule: "0 là 0.",
    direction: "UP",
  },
  {
    key: "revenuePerOrder",
    label: "DT / đơn",
    group: "REVENUE",
    unit: "VND",
    meaning: "Giá trị trung bình một đơn chốt (AOV).",
    numerator: "doanh số POS",
    denominator: "đơn xác nhận",
    source: "orders",
    timing: "Mốc đang chọn.",
    nullRule: "0 đơn ⇒ `—`.",
    num: "posRevenue",
    den: "orders",
    direction: "UP",
  },
  {
    key: "deliveredRevenue",
    label: "Doanh thu thực",
    group: "REVENUE",
    unit: "VND",
    meaning: "Giá trị đơn ĐÃ TỚI TAY KHÁCH. Đây là con số bộ máy lợi nhuận dùng, không phải doanh số POS.",
    numerator: null,
    denominator: null,
    source: `${ORDER_SOURCE} — DELIVERED_REVENUE`,
    timing: "Đơn thuộc ngày theo mốc đang chọn; kết quả giao đọc ở thời điểm xem.",
    nullRule: "0 là 0. Nhưng đọc kèm ĐỘ CHÍN: ngày mới, đơn chưa giao xong thì 0 chỉ có nghĩa 'chưa tới lúc'.",
    direction: "UP",
  },
  {
    key: "deliveredRevenuePerOrder",
    label: "DT thực / đơn giao",
    group: "REVENUE",
    unit: "VND",
    meaning: "Một đơn giao được mang về bao nhiêu tiền.",
    numerator: "doanh thu thực",
    denominator: "đơn giao thành công",
    source: ORDER_SOURCE,
    timing: "Như trên.",
    nullRule: "0 đơn giao ⇒ `—`.",
    num: "deliveredRevenue",
    den: "deliveredOrders",
    direction: "UP",
  },

  {
    key: "projectedDeliveredRevenue",
    label: "DT thực ước tính",
    group: "REVENUE",
    unit: "VND",
    meaning:
      "Doanh thu ĐÃ TỚI TAY KHÁCH cộng phần doanh thu của đơn đang đi đã cân theo tỷ lệ giao thành công của từng mã. Đây là ô trả lời 'ngày này rồi sẽ ra bao nhiêu tiền', khác hẳn ô 'tới lúc này đã về bao nhiêu'.",
    numerator: null,
    denominator: null,
    source: `${ORDER_SOURCE}; ${ESTIMATE_NOTE}`,
    timing: "Đơn thuộc ngày theo mốc đang chọn; phần dự phóng đọc ở thời điểm xem.",
    nullRule: "Chưa dựng được bản đồ tỷ lệ ⇒ `—`.",
    direction: "UP",
    estimated: true,
  },

  /* ───── Giao hàng ───── */
  {
    key: "shippedOrders",
    label: "Đã gửi ĐVVC",
    group: "DELIVERY",
    unit: "COUNT",
    meaning: "Đơn đã rời kho sang đơn vị vận chuyển.",
    numerator: null,
    denominator: null,
    source: "ORDER_OUTCOME ∈ ELIGIBLE_SENT",
    timing: "Đơn thuộc ngày theo mốc đang chọn.",
    nullRule: "0 là 0.",
    direction: "CONTEXT",
  },
  {
    key: "deliveredOrders",
    label: "Giao thành công",
    group: "DELIVERY",
    unit: "COUNT",
    meaning: "Đơn có chứng từ ĐVVC hoặc chứng từ tiền đủ để kết luận đã tới tay khách.",
    numerator: null,
    denominator: null,
    source: "ORDER_OUTCOME = DELIVERED",
    timing: "Như trên.",
    nullRule: "0 là 0.",
    direction: "UP",
  },
  {
    key: "returnedOrders",
    label: "Hoàn",
    group: "DELIVERY",
    unit: "COUNT",
    meaning: "Đơn hoàn về (gộp RETURNED và RETURNED_BY_RULE — hai nhãn, một nghĩa trong mọi tổng hợp).",
    numerator: null,
    denominator: null,
    source: "ORDER_OUTCOME ∈ (RETURNED, RETURNED_BY_RULE)",
    timing: "Như trên.",
    nullRule: "0 là 0.",
    direction: "DOWN",
  },
  {
    key: "cancelledOrders",
    label: "Huỷ",
    group: "DELIVERY",
    unit: "COUNT",
    meaning: "Đơn bị huỷ. KHÔNG nằm trong mẫu số tỷ lệ giao thành công — huỷ không phải một lần giao hỏng.",
    numerator: null,
    denominator: null,
    source: "ORDER_OUTCOME = CANCELLED",
    timing: "Như trên.",
    nullRule: "0 là 0.",
    direction: "DOWN",
  },
  {
    key: "pendingOrders",
    label: "Đang đi",
    group: "DELIVERY",
    unit: "COUNT",
    meaning: "Đơn chưa có kết quả cuối — chính là phần làm con số lợi nhuận của ngày chưa ngã ngũ.",
    numerator: null,
    denominator: null,
    // Trỏ tới hằng số, không liệt kê lại: bản liệt kê cũ dừng ở bộ ba của trước 13/09/2026 (thiếu
    // AWAITING_PICKUP) trong khi truy vấn đã đọc OPEN_OUTCOMES_SQL.
    source: "ORDER_OUTCOME ∈ OPEN_OUTCOMES (lib/constants/truth.ts — sinh ra từ OUTCOME_GROUP)",
    timing: "Đọc ở thời điểm xem báo cáo.",
    nullRule: "0 là 0.",
    direction: "CONTEXT",
  },
  {
    key: "deliveryRate",
    label: "Tỷ lệ giao TC",
    group: "DELIVERY",
    unit: "PERCENT",
    meaning: "Trong số đơn ĐÃ NGÃ NGŨ, bao nhiêu phần trăm tới tay khách.",
    numerator: "đơn giao thành công",
    denominator: "đơn giao thành công + đơn hoàn",
    source: "lib/queries/metrics.ts::successRate",
    timing: "Chỉ đơn đã kết thúc. Đơn đang đi và đơn huỷ nằm ngoài cả tử lẫn mẫu.",
    nullRule: "Chưa đơn nào kết thúc ⇒ `—`, KHÔNG phải 0%.",
    num: "deliveredOrders",
    den: "finishedOrders",
    direction: "UP",
  },
  {
    key: "returnRate",
    label: "Tỷ lệ hoàn",
    group: "DELIVERY",
    unit: "PERCENT",
    meaning: "Phần bù của tỷ lệ giao thành công, trên cùng mẫu số.",
    numerator: "đơn hoàn",
    denominator: "đơn giao thành công + đơn hoàn",
    source: "ORDER_OUTCOME",
    timing: "Như trên.",
    nullRule: "Chưa đơn nào kết thúc ⇒ `—`.",
    num: "returnedOrders",
    den: "finishedOrders",
    direction: "DOWN",
  },
  {
    key: "projectedDeliveryRate",
    label: "TL GTC ước tính",
    group: "DELIVERY",
    unit: "PERCENT",
    meaning: "Nếu số đơn ĐANG ĐI về đích theo tỷ lệ của chính mã nó, thì cả ngày này giao thành công bao nhiêu phần trăm. Khác `Tỷ lệ giao TC` ở chỗ nó KHÔNG bỏ đơn đang đi ra khỏi mẫu số.",
    numerator: "đơn giao thành công + Σ(đơn đang đi × tỷ lệ của mã)",
    denominator: "đơn đã kết thúc + đơn đang đi",
    source: `${ORDER_SOURCE}; ${ESTIMATE_NOTE}`,
    timing: "Đọc ở thời điểm xem — đơn đang đi đổi trạng thái thì con số này đổi theo.",
    nullRule: "Chưa dựng được bản đồ tỷ lệ ⇒ `—`. Ngày không có đơn nào ⇒ `—`.",
    num: "projectedDeliveredOrders",
    den: "maturityBase",
    direction: "UP",
    estimated: true,
  },
  {
    key: "maturity",
    label: "Độ chín",
    group: "DELIVERY",
    unit: "PERCENT",
    meaning: "Bao nhiêu phần trăm đơn của ngày đã có kết quả cuối. Đọc TRƯỚC khi đọc lợi nhuận.",
    numerator: "đơn đã kết thúc",
    denominator: "đơn đã kết thúc + đơn đang đi",
    source: "ORDER_OUTCOME",
    timing: "Đọc ở thời điểm xem.",
    nullRule: "Ngày không có đơn nào ⇒ `—`.",
    num: "finishedOrders",
    den: "maturityBase",
    direction: "UP",
  },

  /* ───── Chi phí ───── */
  {
    key: "cogs",
    label: "Giá vốn",
    group: "COST",
    unit: "VND",
    meaning: "Giá vốn của ĐƠN GIAO THÀNH CÔNG — cùng tập đơn với doanh thu thực, không lệch population.",
    numerator: null,
    denominator: null,
    source: "lib/queries/cogs.ts (phiếu nhập ERP gần nhất → giá vốn Pancake → giá nhập mẫu mã)",
    timing: "Theo đơn.",
    nullRule: "Mẫu mã chưa có phiếu nhập ⇒ giá vốn thiếu; xem cảnh báo độ phủ giá vốn.",
    direction: "DOWN",
  },
  {
    key: "cogsRatio",
    label: "Giá vốn / DT",
    group: "COST",
    unit: "PERCENT",
    meaning: "Giá vốn chiếm bao nhiêu phần doanh thu thực.",
    numerator: "giá vốn",
    denominator: "doanh thu thực",
    source: "như trên",
    timing: "Theo đơn.",
    nullRule: "0 doanh thu ⇒ `—`.",
    num: "cogs",
    den: "deliveredRevenue",
    direction: "DOWN",
  },
  {
    key: "shippingCost",
    label: "Cước + phí hoàn",
    group: "COST",
    unit: "VND",
    meaning: "Cước vận chuyển của đơn đã gửi, cộng phí hoàn và phí sàn. Không lọc: cộng thêm cước / phí hoàn điều chỉnh tay có lý do của toàn shop; có lọc: chỉ cước của chính các đơn trong lát cắt.",
    numerator: null,
    denominator: null,
    source: "orders.partner_fee + orders.return_fee + orders.fee_marketplace; không lọc thì + lib/queries/cost-engine.ts::getOperatingCostByDay().logisticsAdjustment (cùng cách Báo cáo lợi nhuận cộng)",
    timing: "Theo đơn.",
    nullRule: "0 là 0.",
    direction: "DOWN",
  },
  {
    key: "adsOnPosRevenue",
    label: "QC / doanh số POS",
    group: "COST",
    unit: "PERCENT",
    meaning: "Tiền quảng cáo chiếm bao nhiêu phần doanh số chốt được.",
    numerator: "chi quảng cáo",
    denominator: "doanh số POS",
    source: "ad_spends ÷ orders",
    timing: "Trong ngày.",
    nullRule: "0 doanh số ⇒ `—`.",
    num: "adSpend",
    den: "posRevenue",
    direction: "DOWN",
  },
  {
    key: "adsOnDeliveredRevenue",
    label: "QC / DT thực",
    group: "COST",
    unit: "PERCENT",
    meaning: "Tiền quảng cáo chiếm bao nhiêu phần tiền thật về. Con số này mới quyết định còn chạy được hay không.",
    numerator: "chi quảng cáo",
    denominator: "doanh thu thực",
    source: "ad_spends ÷ DELIVERED_REVENUE",
    timing: "Trong ngày; đọc kèm độ chín.",
    nullRule: "0 doanh thu thực ⇒ `—`.",
    num: "adSpend",
    den: "deliveredRevenue",
    direction: "DOWN",
  },
  {
    key: "operatingCost",
    label: "Chi phí vận hành phân bổ",
    group: "COST",
    unit: "VND",
    meaning: "Chi phí vận hành của CẢ SHOP rải theo ngày (thuê, lương, phần mềm…).",
    numerator: null,
    denominator: null,
    source: "lib/queries/cost-engine.ts::getOperatingCostByDay",
    timing: "Chia theo số ngày chồng lấn của kỳ hiệu lực, không dồn vào ngày ghi sổ.",
    nullRule: "CÓ BẤT KỲ BỘ LỌC CHIỀU NÀO ⇒ `—`: không có căn cứ chia tiền thuê nhà cho một chiến dịch.",
    direction: "DOWN",
  },

  /* ───── Lợi nhuận ───── */
  {
    key: "contributionProfit",
    label: "Lợi nhuận góp sau QC",
    group: "PROFIT",
    unit: "VND",
    meaning: "DT thực − giá vốn − cước/phí hoàn/phí sàn − chi quảng cáo. Lọc được theo mọi chiều vì mọi vế đếm trên cùng tập đơn.",
    numerator: null,
    denominator: null,
    source: "cộng từ các cột trên",
    timing: "Theo đơn + theo ngày chi.",
    nullRule: "Chi quảng cáo chưa biết ⇒ CẢ Ô là `—`: trừ đi một số chưa biết không ra một con số.",
    direction: "UP",
  },
  {
    key: "netProfit",
    label: "Lợi nhuận (canonical)",
    group: "PROFIT",
    unit: "VND",
    meaning: "Lợi nhuận góp − chi phí vận hành phân bổ. ĐÚNG con số của Báo cáo lợi nhuận, cùng bộ máy.",
    numerator: null,
    denominator: null,
    source: "lib/queries/reports.ts::getDailyBreakdown",
    timing: "Như trên.",
    nullRule: "Có bộ lọc chiều ⇒ `—` (chi phí vận hành không chia được). KHÔNG bao giờ rơi về lợi nhuận góp.",
    direction: "UP",
  },
  {
    key: "projectedContributionProfit",
    label: "LN góp ước tính",
    group: "PROFIT",
    unit: "VND",
    meaning:
      "DT thực ƯỚC TÍNH − giá vốn ƯỚC TÍNH − cước ĐÃ PHÁT SINH − chi quảng cáo. Ngày mới, cột 'Lợi nhuận góp sau QC' luôn âm vì tiền quảng cáo đã tiêu hết mà hàng chưa tới tay ai; ô này trả lời câu hỏi thật sự đang được hỏi — chạy tiếp hay cắt.",
    numerator: null,
    denominator: null,
    source: `cộng từ các cột trên; ${ESTIMATE_NOTE}`,
    timing: "Theo đơn + theo ngày chi.",
    nullRule:
      "Chi quảng cáo chưa biết, hoặc chưa dựng được bản đồ tỷ lệ ⇒ `—`. LƯU Ý HƯỚNG SAI: cước ở đây là số ĐÃ PHÁT SINH — phí hoàn của đơn đang đi chưa có trong đó, nên ô này LẠC QUAN đúng bằng phần phí hoàn chưa tới.",
    direction: "UP",
    estimated: true,
  },
  {
    key: "projectedRoas",
    label: "ROAS ước tính",
    group: "PROFIT",
    unit: "RATIO",
    meaning: "DT thực ước tính ÷ chi quảng cáo. So được với điểm hoà vốn ngay trong ngày, không phải đợi đơn về hết.",
    numerator: "doanh thu thực ước tính",
    denominator: "chi quảng cáo",
    source: `DELIVERED_REVENUE + phần dự phóng ÷ ad_spends; ${ESTIMATE_NOTE}`,
    timing: "Trong ngày.",
    nullRule: "Chưa chi đồng nào ⇒ `—`.",
    num: "projectedDeliveredRevenue",
    den: "adSpend",
    direction: "UP",
    estimated: true,
  },
  {
    key: "profitPerOrder",
    label: "LN / đơn",
    group: "PROFIT",
    unit: "VND",
    meaning: "Lợi nhuận góp chia cho số đơn xác nhận.",
    numerator: "lợi nhuận góp",
    denominator: "đơn xác nhận",
    source: "như trên",
    timing: "Trong ngày.",
    nullRule: "0 đơn ⇒ `—`.",
    num: "contributionProfit",
    den: "orders",
    direction: "UP",
  },
  {
    key: "margin",
    label: "Margin",
    group: "PROFIT",
    unit: "PERCENT",
    meaning: "Lợi nhuận góp ÷ doanh thu thực.",
    numerator: "lợi nhuận góp",
    denominator: "doanh thu thực",
    source: "như trên",
    timing: "Trong ngày; đọc kèm độ chín.",
    nullRule: "0 doanh thu thực ⇒ `—`.",
    num: "contributionProfit",
    den: "deliveredRevenue",
    direction: "UP",
  },
  {
    key: "roasPos",
    label: "ROAS POS",
    group: "PROFIT",
    unit: "RATIO",
    meaning: "Doanh số chốt ÷ chi quảng cáo. Đo hiệu quả của mẩu quảng cáo, chưa trừ hoàn.",
    numerator: "doanh số POS",
    denominator: "chi quảng cáo",
    source: "orders ÷ ad_spends",
    timing: "Trong ngày.",
    nullRule: "Chưa chi đồng nào ⇒ `—`, không phải 0.",
    num: "posRevenue",
    den: "adSpend",
    direction: "UP",
  },
  {
    key: "roasDelivered",
    label: "ROAS thực",
    group: "PROFIT",
    unit: "RATIO",
    meaning: "Doanh thu thực ÷ chi quảng cáo. Con số thật để so với điểm hoà vốn.",
    numerator: "doanh thu thực",
    denominator: "chi quảng cáo",
    source: "DELIVERED_REVENUE ÷ ad_spends",
    timing: "Trong ngày; đọc kèm độ chín.",
    nullRule: "Chưa chi đồng nào ⇒ `—`.",
    num: "deliveredRevenue",
    den: "adSpend",
    direction: "UP",
  },
];

export const MARKETING_METRIC_BY_KEY: Record<string, MarketingMetricSpec> = Object.fromEntries(MARKETING_METRICS.map((m) => [m.key, m]));

/**
 * KHOÁ CỘNG ĐƯỢC KHÔNG CÓ CỘT RIÊNG nhưng vẫn được làm tử/mẫu số của một ô tỷ lệ.
 *
 * Khai ở đây, một lần: bài kiểm hợp đồng cột đọc CHÍNH danh sách này. Trước đây nó được gõ lại
 * trong thân bài kiểm, nên thêm một khoá nền là sửa hai chỗ — và quên một chỗ thì bài kiểm đỏ vì
 * một lý do không liên quan gì tới điều nó đang bảo vệ.
 */
export const MARKETING_BASE_ONLY_KEYS = ["finishedOrders", "maturityBase", "projectedDeliveredOrders", "projectedCogs"] as const;

/** Khoá các ô dạng TỶ LỆ — hàng tổng phải tính lại từ `num`/`den`, không được cộng rồi chia trung bình. */
export const MARKETING_RATIO_KEYS = MARKETING_METRICS.filter((m) => m.num && m.den).map((m) => m.key);

/**
 * ───────────── BỘ CỘT HIỂN THỊ ─────────────
 *
 * Bảng đầy đủ có 28 cột. Mở ra 28 cột cho một người chỉ muốn biết hôm qua lãi hay lỗ là bắt họ
 * cuộn ngang qua thứ họ không hỏi. Bốn bộ dưới đây là bốn câu hỏi khác nhau.
 */
export const MARKETING_VIEWS = ["basic", "marketing", "finance", "full"] as const;
export type MarketingView = (typeof MARKETING_VIEWS)[number];

export const MARKETING_VIEW_LABEL: Record<MarketingView, string> = {
  basic: "Gọn",
  marketing: "Marketing",
  finance: "Tài chính",
  full: "Đầy đủ",
};

export const MARKETING_VIEW_COLUMNS: Record<MarketingView, string[]> = {
  basic: ["adSpend", "messages", "orders", "posRevenue", "deliveredRevenue", "projectedDeliveredRevenue", "deliveredOrders", "contributionProfit", "projectedContributionProfit", "margin", "maturity"],
  marketing: ["adSpend", "messages", "costPerMessage", "orders", "units", "unitsPerOrder", "closeRate", "costPerOrder", "posRevenue", "revenuePerOrder", "roasPos", "roasDelivered", "projectedRoas", "deliveryRate", "projectedDeliveryRate", "maturity"],
  finance: ["adSpend", "orders", "posRevenue", "deliveredRevenue", "projectedDeliveredRevenue", "deliveredOrders", "cogs", "cogsRatio", "shippingCost", "operatingCost", "contributionProfit", "projectedContributionProfit", "netProfit", "margin", "adsOnDeliveredRevenue", "maturity"],
  full: MARKETING_METRICS.map((m) => m.key),
};

/**
 * ───────────── ĐỘ TƯƠI CỦA NGUỒN ─────────────
 *
 * Một báo cáo tiền mà nguồn chi tiêu đứng im ba tiếng vẫn vẽ ra biểu đồ đẹp. Ngưỡng dưới đây chỉ
 * quyết định KHI NÀO MÀN HÌNH LÊN TIẾNG, không đụng tới một công thức nào.
 */
export const MARKETING_SOURCES = [
  { job: "facebook-ads", label: "Chi quảng cáo (Facebook)", staleMinutes: 180 },
  { job: "pancake-orders", label: "Đơn hàng (Pancake)", staleMinutes: 30 },
  { job: "vtp-tracking", label: "Vận đơn (Viettel Post)", staleMinutes: 60 },
] as const;

/**
 * ───────────── TÍNH MỘT Ô TỶ LỆ TỪ TỬ SỐ VÀ MẪU SỐ CỦA CHÍNH NÓ ─────────────
 *
 * Hàm THUẦN, và nó sống ở tệp hằng số chứ không ở tầng truy vấn vì **màn hình cũng phải gọi nó**:
 * bảng, hàng TỔNG, thẻ KPI và bản tin Lark đều in cùng những tỷ lệ ấy. Bốn nơi tự chia là bốn cơ
 * hội để một chỗ lấy trung bình phần trăm — đúng lỗi mà yêu cầu 27 cấm.
 *
 * Mẫu số 0 ⇒ `null` (CHƯA BIẾT), không bao giờ `Infinity`/`NaN`.
 * Tử số chưa quan sát được (chi tiêu khi đồng bộ chết) cũng ⇒ `null`, chứ không phải 0.
 */
export function ratioOf(key: string, base: Record<string, unknown>): number | null {
  const spec = MARKETING_METRIC_BY_KEY[key];
  if (!spec?.num || !spec.den) return null;
  const num = base[spec.num];
  const den = base[spec.den];
  if (num === null || num === undefined || den === null || den === undefined) return null;
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  const raw = n / d;
  if (!Number.isFinite(raw)) return null;
  return spec.unit === "PERCENT" ? Math.round(raw * 1000) / 10 : raw;
}
