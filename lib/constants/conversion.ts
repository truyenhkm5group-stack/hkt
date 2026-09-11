/**
 * ═══════════ PHỄU CHUYỂN ĐỔI DOANH THU — SỔ ĐĂNG KÝ BẰNG CHỨNG ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` — đọc trước khi sửa.
 *
 * Đây là phần phễu NẰM TRƯỚC vận đơn: từ lúc khách nhắn tin tới lúc kiện hàng rời kho. Phần sau
 * vận đơn đã có `ORDER_OUTCOME` (`lib/queries/return-rate.ts`) và KHÔNG được tính lại ở đây.
 *
 * ─── VÌ SAO FILE NÀY TỒN TẠI: MỘT LỜI THÚ NHẬN ĐÃ GHI SẴN TRONG KHO MÃ ───
 *
 * `docs/sales-funnel-contract.md` viết: hai bước "đã liên hệ" và "đủ điều kiện" KHÔNG có nguồn dữ
 * liệu, vì "ERP không đồng bộ hội thoại Pancake". `lib/constants/operating-funnel.ts` nói thẳng hơn
 * ở khâu `LEAD`: *"Không có mốc phản hồi đầu tiên cho từng lead, nên tỷ lệ và thời gian phản hồi
 * CHƯA đo được."*
 *
 * Câu đó đúng một nửa. Job `cs-chat` VẪN ĐỌC hội thoại và tới 50 tin nhắn mỗi hội thoại, 15 phút một
 * lần — nhưng không lưu gì cả. Nên "đã liên hệ" không phải là không đo được; nó là **đọc rồi ném
 * đi**. Bảng `conversation_funnel` giữ lại đúng thứ đó, và `first_shop_reply_at` chính là cái mốc mà
 * đặc tả cũ nói là không có.
 *
 * ─── NHƯNG "ĐỦ ĐIỀU KIỆN / CÓ Ý ĐỊNH MUA" THÌ THẬT SỰ KHÔNG ĐO ĐƯỢC ───
 *
 * Xem `UNMEASURABLE_STAGES` bên dưới. Nó được KHAI RA kèm lý do và hiện thành một dòng "KHÔNG ĐO
 * ĐƯỢC" trên màn hình, chứ không bị lặng lẽ bỏ đi và cũng không bị bịa ra.
 *
 * ─── LUẬT BẤT DI BẤT DỊCH ───
 *
 *  1. Mỗi bước phải có BẬC BẰNG CHỨNG (`EvidenceTier`). Không có bằng chứng thì là `null` = CHƯA
 *     BIẾT, không phải 0 và không phải "không xảy ra".
 *  2. Bốn mốc trước đơn CHỈ được công bố tỷ lệ khi có ĐỘ PHỦ. Cửa sổ quét 48 giờ và trần 200 hội
 *     thoại mỗi page nghĩa là mẫu vừa bị cắt vừa lệch — bỏ qua điều đó thì tỷ lệ chuyển sẽ vọt lên
 *     hàng trăm phần trăm, một con số vô nghĩa trông như tin tốt.
 *  3. KHÔNG nối phễu trước đơn vào phễu đơn thành MỘT chuỗi. Hai phễu đứng cạnh nhau, vì mẫu số của
 *     chúng khác nhau về bản chất (hội thoại quét được ≠ toàn bộ hội thoại).
 *  4. Bước cuối dùng lại `ORDER_OUTCOME_FAST`, không viết lại điều kiện.
 */
import { LOW_COVERAGE_PCT } from "@/lib/constants/sales-funnel";

/**
 * ĐỘ MẠNH CỦA BẰNG CHỨNG — xếp giảm dần.
 *
 *  · `STRUCTURED` — sự thật quan sát được, không cần diễn giải: một mốc tin nhắn, một dòng đơn hàng.
 *  · `HEURISTIC`  — máy suy từ câu chữ. Có thể sai, và đã từng sai ở kho mã này (181 case).
 *  · `DECLARED`   — KHAI LÀ KHÔNG ĐO ĐƯỢC. Không có số, và đó là kết luận cuối cùng, không phải chỗ trống.
 */
export type EvidenceTier = "STRUCTURED" | "HEURISTIC" | "DECLARED";

export const EVIDENCE_TIER_LABEL: Record<EvidenceTier, string> = {
  STRUCTURED: "Chứng từ",
  HEURISTIC: "Máy suy đoán",
  DECLARED: "Khai là không đo được",
};

/**
 * ───────────── BƯỚC KHÔNG ĐO ĐƯỢC, KHAI RA THAY VÌ BỊA ─────────────
 *
 * Kế hoạch ban đầu có bước "đủ điều kiện / có ý định mua" giữa "khách nhắn tin" và "đã có SĐT".
 * ERP không có nguồn nào cho nó, và mọi căn cứ nghĩ ra được đều rơi vào một trong hai bẫy:
 *
 *  1. **Đổi tên một sự thật đã đếm.** Căn cứ mạnh nhất nghĩ ra được là "khách đã cho SĐT hoặc địa
 *     chỉ" — nhưng đó ĐÚNG là hai bước kế tiếp. Đếm nó thành một bước riêng là nhân đôi cùng một sự
 *     thật rồi gọi là hai bước, và phễu sẽ có một bước luôn xấp xỉ bước sau nó.
 *  2. **Tìm từ khoá trong câu chữ.** Đúng loại suy diễn đã dựng ra 181 case "đã chốt đơn" mà phần
 *     lớn khách còn chưa cho số điện thoại (xem `lib/cs/chat-detect.ts`).
 *
 * Thứ ĐO ĐƯỢC và có ích hơn: **khách đã được trả lời chưa** (`first_shop_reply_at`). Đó là một sự
 * thật, nó là bước rơi lớn nhất trong bán hàng qua chat, và nó sinh ra được một việc làm ngay.
 *
 * `reason` dài > 30 ký tự theo đúng khuôn `NGOAI_PHEU` của `lib/constants/operating-funnel.ts`:
 * một bước bị loại phải nói được VÌ SAO, nếu không nó chỉ là một chỗ trống không ai giải thích.
 */
export const UNMEASURABLE_STAGES: Record<string, { label: string; reason: string; insteadUse: string }> = {
  qualified_intent: {
    label: "Đủ điều kiện · có ý định mua",
    reason:
      "ERP không có nguồn nào cho bước này. Căn cứ mạnh nhất nghĩ ra được ('khách đã cho SĐT hoặc địa chỉ') chính là hai bước kế tiếp, nên đếm riêng là nhân đôi cùng một sự thật; căn cứ còn lại là tìm từ khoá trong câu chữ, đúng loại suy diễn đã dựng ra 181 case sai. Thà để trống có lý do hơn là hiện một con số không có gì đứng sau.",
    insteadUse: "Dùng bước 'Đã được trả lời' — một sự thật lấy từ mốc tin nhắn, và là bước rơi lớn nhất của bán hàng qua chat.",
  },
};

/**
 * ───────────── PHỄU 1: TRƯỚC ĐƠN (HỘI THOẠI) ─────────────
 *
 * Bốn mốc, tất cả từ `conversation_funnel`. Mẫu số là hội thoại QUÉT ĐƯỢC, không phải toàn bộ hội
 * thoại — nên mọi con số ở đây phải đi kèm độ phủ.
 */
export type PreOrderMarkerKey = "MESSAGED" | "ANSWERED" | "PHONE_CAPTURED" | "ADDRESS_CAPTURED";

export type PreOrderMarkerSpec = {
  key: PreOrderMarkerKey;
  label: string;
  order: number;
  tier: EvidenceTier;
  /** Cột thật cấp dữ liệu. Nói bằng tên cột, không nói chung chung. */
  source: string;
  /** Điều phải nói thẳng về giới hạn của mốc này. '' = không có giới hạn đáng kể. */
  caveat: string;
};

export const PRE_ORDER_MARKERS: PreOrderMarkerSpec[] = [
  {
    key: "MESSAGED",
    label: "Khách nhắn tin",
    order: 1,
    tier: "STRUCTURED",
    source: "conversation_funnel.first_customer_message_at",
    caveat: "Chỉ gồm hội thoại quét được: cửa sổ 48 giờ, page có đơn trong 90 ngày, tối đa 200 hội thoại mỗi page mỗi lượt.",
  },
  {
    key: "ANSWERED",
    label: "Đã được trả lời",
    order: 2,
    tier: "STRUCTURED",
    source: "conversation_funnel.first_shop_reply_at — tin của shop gửi SAU tin đầu của khách",
    caveat: "",
  },
  {
    key: "PHONE_CAPTURED",
    label: "Đã có số điện thoại",
    order: 3,
    tier: "HEURISTIC",
    source: "conversation_funnel.phone_at",
    /*
      NÓI THẲNG MỘT LỖ HỔNG THẬT: biểu thức `SDT` trong chat-detect.ts đòi số bắt đầu bằng 0, nên
      khách gõ "+84…" là VÔ HÌNH. Con số này đếm THIẾU, và người đọc phải biết điều đó.
    */
    caveat: "Đếm THIẾU: biểu thức nhận SĐT đòi số bắt đầu bằng 0, nên khách gõ dạng +84… không được tính.",
  },
  {
    key: "ADDRESS_CAPTURED",
    label: "Đã có địa chỉ",
    order: 4,
    tier: "HEURISTIC",
    source: "conversation_funnel.address_at — nhận diện bằng từ chỉ đơn vị hành chính (thôn/xã/phường/quận…)",
    caveat: "Đếm THIẾU có chủ ý: luật nhận địa chỉ cố ý bảo thủ để không dựng lại đống case sai cũ. Không dùng làm mẫu số cứng.",
  },
];

/**
 * ───────────── PHỄU 2: ĐƠN HÀNG ─────────────
 *
 * Năm bước CỘNG DỒN: bước n là "đã qua được bước 1..n". Cộng dồn theo cấu trúc nên phễu KHÔNG THỂ
 * phình ra ở giữa — không phải nhờ kẹp số, mà nhờ định nghĩa.
 *
 * Vì sao quan trọng: một đơn bị huỷ sau khi đã gửi vẫn ĐÃ TỪNG rời kho. Đếm từng bước độc lập thì
 * "đã rời kho" có thể lớn hơn "đã xác nhận", và cái hình vẽ ra không còn là cái phễu.
 */
export type OrderStepKey = "CREATED" | "CONFIRMED" | "SHIPMENT_CREATED" | "LEFT_WAREHOUSE" | "DELIVERED";

export type OrderStepSpec = {
  key: OrderStepKey;
  label: string;
  order: number;
  tier: EvidenceTier;
  source: string;
  /** Mẫu số của tỷ lệ bước này, nói bằng lời. */
  previousLabel: string;
  caveat: string;
};

export const ORDER_STEPS: OrderStepSpec[] = [
  { key: "CREATED", label: "Đơn được tạo", order: 1, tier: "STRUCTURED", source: "orders.inserted_at", previousLabel: "chính nó", caveat: "" },
  {
    key: "CONFIRMED",
    label: "Đã rời trạng thái chờ",
    order: 2,
    tier: "STRUCTURED",
    source: "orders.stage ∉ (NEW, WAITING) — dùng lại đúng định nghĩa của getSalesFunnel",
    previousLabel: "đơn được tạo",
    /*
      HAI ĐỊNH NGHĨA "ĐÃ XÁC NHẬN" CÙNG TỒN TẠI TRONG KHO MÃ, và ở đây phải chọn một rồi nói rõ.

      · phễu bán hàng: `stage not in ('NEW','WAITING')` — LỎNG, gồm cả đơn sau đó huỷ;
      · tầng chỉ số:   `CONFIRMED_ORDER` = `stage in CONFIRMED_STAGES` — LOẠI đơn huỷ.

      Chọn bản LỎNG, cố ý: đơn huỷ sau khi đã gửi vẫn đã từng được xác nhận và đã từng rời kho. Dùng
      bản chặt sẽ làm "đã rời kho" > "đã xác nhận" ⇒ phễu phình. Đổi định nghĩa là một thay đổi chỉ
      số phải có chủ shop đồng ý kèm số trước/sau, không phải hệ quả phụ của một màn hình mới.
    */
    caveat: "Gồm cả đơn sau đó bị huỷ — đơn huỷ sau khi gửi vẫn ĐÃ TỪNG được xác nhận. Số đơn huỷ sau xác nhận hiện ở dòng riêng.",
  },
  {
    key: "SHIPMENT_CREATED",
    label: "Đã tạo vận đơn",
    order: 3,
    tier: "STRUCTURED",
    source: "có dòng shipments qua PRIMARY_ATTEMPT — mỗi đơn một lần gửi chính",
    previousLabel: "đơn đã rời trạng thái chờ",
    caveat: "Đã có mã vận đơn KHÔNG có nghĩa hàng đã ra khỏi kho: vận đơn PENDING là hàng còn trong kho.",
  },
  {
    key: "LEFT_WAREHOUSE",
    label: "Hàng đã rời kho",
    order: 4,
    tier: "STRUCTURED",
    source: "SHIPMENT_LEFT_WAREHOUSE — mốc lấy hàng / trạng thái vận đơn dựng từ sự kiện Viettel Post",
    previousLabel: "đơn đã có vận đơn",
    caveat: "Cố ý dùng sự kiện ĐVVC chứ không dùng trạng thái Pancake: Pancake nói 'đã gửi' khi người bán bấm nút.",
  },
  {
    key: "DELIVERED",
    label: "Giao thành công",
    order: 5,
    tier: "STRUCTURED",
    source: "ORDER_OUTCOME_FAST = 'DELIVERED' — công thức kết quả đơn duy nhất của ERP",
    previousLabel: "đơn đã rời kho",
    caveat: "",
  },
];

export const ORDER_STEP_LABEL: Record<OrderStepKey, string> = Object.fromEntries(ORDER_STEPS.map((s) => [s.key, s.label])) as Record<OrderStepKey, string>;

/**
 * ───────────── ĐỘ PHỦ HỘI THOẠI: CÁI GÁC CHO CẢ BỐN MỐC TRƯỚC ĐƠN ─────────────
 *
 * Job quét lùi 48 giờ mỗi lần chạy. Hội thoại xảy ra TRƯỚC lần quét đầu tiên sẽ không bao giờ có
 * trong CSDL. Chia đơn của một kỳ cho số hội thoại của kỳ chưa được quét thì tỷ lệ chuyển vọt lên
 * hàng trăm phần trăm — một con số vô nghĩa trông như tin tốt.
 */
export type ConversationCoverage = {
  /** Hội thoại cũ nhất ghi được. `null` = chưa quét lần nào. */
  from: Date | null;
  lastScanAt: Date | null;
  conversations: number;
  /** Số dòng thuộc page đã CHẠM TRẦN lượt quét ⇒ phần đếm bị cắt. */
  truncated: number;
  /** Kỳ đang xem có nằm TRỌN trong khoảng đã quét hay không. */
  periodCovered: boolean;
  /** Dùng lại đúng ba mức của `lib/constants/operating-funnel.ts` — không dựng thang thứ hai. */
  sourceStatus: "HEALTHY" | "DEGRADED" | "DATA_UNAVAILABLE";
  /** Nói bằng lời vì sao — hiện thẳng lên màn hình, không để người đọc tự đoán. */
  note: string;
};

/** Dưới ngưỡng này thì mẫu quá nhỏ, KHÔNG công bố tỷ lệ chuyển đổi. */
export const MIN_CONVERSATIONS_FOR_RATE = 20;

/** Ngưỡng độ phủ thấp: dùng lại đúng con số của phễu bán hàng, không đặt thang thứ hai. */
export const CONVERSION_LOW_COVERAGE_PCT = LOW_COVERAGE_PCT;

/** Hạn phản hồi hội thoại (giờ). Khách đang so giá ở ba shop cùng lúc; im lặng nửa ngày là mất. */
export const LEAD_REPLY_SLA_HOURS = 3;

/**
 * Mức chắc chắn của phép ghép hội thoại ↔ đơn. Lấy lại đúng ba mức của
 * `matchOrderForConversation` (`lib/cs/chat-detect.ts`) — không định nghĩa thang thứ hai.
 */
export type OrderMatchBasis = "BY_CONVERSATION" | "BY_PHONE_UNIQUE" | "AMBIGUOUS" | "NONE";

export const ORDER_MATCH_LABEL: Record<OrderMatchBasis, string> = {
  BY_CONVERSATION: "Pancake gắn đơn vào hội thoại",
  BY_PHONE_UNIQUE: "Ghép theo SĐT, đúng một đơn",
  AMBIGUOUS: "Một SĐT nhiều đơn — KHÔNG kết luận",
  NONE: "Chưa có đơn nào",
};

/**
 * Phép ghép này có đủ chắc để kết luận "hội thoại đã thành đơn" / "chưa thành đơn" hay không.
 *
 * `AMBIGUOUS` trả `false`: một SĐT nhiều đơn là chuyện thường (khách mua nhiều lần, số người nhận
 * hộ). Chọn đại một đơn là dựng kết luận sai theo CẢ HAI hướng — gọi lại khách đã mua, hoặc im lặng
 * bỏ sót một đơn thật. Nhóm này phải hiện thành một dòng RIÊNG NHÌN THẤY ĐƯỢC, không gộp vào
 * "chưa có đơn".
 */
export function matchIsConclusive(basis: OrderMatchBasis): boolean {
  return basis !== "AMBIGUOUS";
}

/**
 * ───────────── CHIỀU PHÂN TÍCH CHUYỂN ĐỔI ─────────────
 *
 * Đặt ở `constants` (không ở `lib/queries`) vì giao diện client cần nhãn, và client KHÔNG được import
 * `lib/queries/*` — `tests/client-boundary-exports.test.ts` khoá điều đó.
 *
 * Năm chiều là NĂM CÂU HỎI khác nhau, không phải năm cách sắp xếp của cùng một bảng.
 */
export type ConversionDimension = "employee" | "source" | "product" | "day" | "hour";

export const CONVERSION_DIMENSION_LABEL: Record<ConversionDimension, string> = {
  employee: "Nhân viên",
  source: "Kênh đặt hàng",
  product: "Mẫu mã",
  day: "Ngày",
  hour: "Giờ trong ngày",
};

/** Chiều nào có nhóm "chưa gán". Ngày/giờ luôn có giá trị nên không bao giờ trống. */
export function dimensionHasUnassigned(dim: ConversionDimension): boolean {
  return dim === "employee" || dim === "source" || dim === "product";
}

/** Nhãn tuổi ca — cùng cách nói với Hàng đợi việc để hai màn hình không đọc khác nhau. */
export function conversionAgeLabel(hours: number): string {
  if (hours < 1) return "dưới 1 giờ";
  if (hours < 24) return `${Math.floor(hours)} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}
