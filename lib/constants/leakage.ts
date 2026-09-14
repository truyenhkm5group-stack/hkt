/**
 * ═══════════ HÀNG ĐỢI RÒ RỈ DOANH THU — CHỈ CA CÒN CỨU ĐƯỢC ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md`.
 *
 * ─── FILE NÀY KHÔNG DỰNG MỘT HÀNG ĐỢI THỨ HAI ───
 *
 * ERP đã có Hàng đợi việc (`lib/constants/action-queue.ts` + `lib/queries/action-queue.ts`) với loại
 * việc, đội phụ trách, hạn xử lý, trọng số còn-cứu-được, hành động khuyến nghị và điểm ưu tiên giải
 * thích được. Dựng một lớp việc thứ hai song song sẽ tạo ra hai danh sách nói hai con số khác nhau
 * cho cùng một vấn đề — đúng thứ tệ nhất có thể làm với một hệ thống vận hành.
 *
 * Nên bốn trong năm nhóm rò rỉ được LẤY LẠI từ loại việc đã có; chỉ hai nhóm thuộc khâu hội thoại là
 * mới, vì trước đây không có dữ liệu hội thoại nên không thể có chúng.
 *
 * ─── HAI CÁI CHẶN SPAM, VÀ CHÚNG LÀ TÍNH NĂNG ───
 *
 * 1. **TUỔI TỐI ĐA.** Khách nhắn 10 ngày trước mà chưa ai trả lời thì gọi lại bây giờ không phải thu
 *    hồi doanh thu — đó là làm khách khó chịu. Ca quá tuổi vẫn được ĐẾM trong báo cáo (nó là sự thật
 *    đã xảy ra) nhưng KHÔNG vào hàng đợi việc.
 * 2. **NGƯỠNG TIN CẬY.** Ghép hội thoại ↔ đơn nhập nhằng thì không kết luận. Một hàng đợi có lẫn
 *    phỏng đoán sẽ bị bỏ, và lúc đó những ca thật nằm trong đó cũng mất luôn.
 *
 * Cả hai lần loại bỏ đều phải ĐẾM VÀ NÊU LÝ DO (`suppressed`). Một hàng đợi lặng lẽ bỏ 200 ca là một
 * hàng đợi không ai kiểm chứng được.
 */
import type { CaseType } from "@/lib/constants/action-queue";
import { RECOMMENDATION_CONFIDENCE, type RecommendationConfidence } from "@/lib/constants/recommendation";
import { LEAD_REPLY_SLA_HOURS, type OrderStepKey, type PreOrderMarkerKey } from "@/lib/constants/conversion";

export type LeakageBucket =
  /** Khách nhắn tin, CHƯA AI trả lời. Sự thật lấy từ mốc tin nhắn — không suy diễn ý định. */
  | "NO_REPLY"
  /** Đã có SĐT trong chat mà chưa có địa chỉ và chưa có đơn. */
  | "PHONE_NO_ORDER"
  /** Đủ cả SĐT và địa chỉ mà vẫn chưa có đơn — đơn sắp bị sót. */
  | "INFO_NO_ORDER"
  /** Đơn đã lên mà chưa xác nhận / còn thiếu thông tin, quá hạn. */
  | "UNCONFIRMED"
  /** Đơn đã xác nhận mà chưa có vận đơn, quá hạn. Hàng còn trong kho. */
  | "NO_SHIPMENT";

export const LEAKAGE_BUCKETS: LeakageBucket[] = ["NO_REPLY", "PHONE_NO_ORDER", "INFO_NO_ORDER", "UNCONFIRMED", "NO_SHIPMENT"];

export const LEAKAGE_BUCKET_LABEL: Record<LeakageBucket, string> = {
  NO_REPLY: "Khách nhắn · chưa ai trả lời",
  PHONE_NO_ORDER: "Đã có SĐT · chưa lên đơn",
  INFO_NO_ORDER: "Đủ thông tin · chưa lên đơn",
  UNCONFIRMED: "Đơn chưa xác nhận quá hạn",
  NO_SHIPMENT: "Đã xác nhận · chưa có vận đơn",
};

/**
 * Nhóm này thuộc bước nào của phễu — để hàng đợi và phễu nói cùng một hệ quy chiếu.
 *
 * Ba nhóm đầu trỏ vào MỐC TRƯỚC ĐƠN, hai nhóm cuối trỏ vào BƯỚC ĐƠN HÀNG. Hai họ khoá khác nhau vì
 * đó là hai phễu khác nhau với hai mẫu số khác nhau — gộp thành một kiểu sẽ khuyến khích đúng cái
 * việc nối hai phễu lại, thứ mà đặc tả cấm.
 */
export const LEAKAGE_STAGE: Record<LeakageBucket, PreOrderMarkerKey | OrderStepKey> = {
  NO_REPLY: "ANSWERED",
  PHONE_NO_ORDER: "PHONE_CAPTURED",
  INFO_NO_ORDER: "ADDRESS_CAPTURED",
  UNCONFIRMED: "CREATED",
  NO_SHIPMENT: "CONFIRMED",
};

/**
 * Nhóm nào lấy lại từ loại việc ĐÃ CÓ của Hàng đợi việc.
 *
 * Hai nhóm đầu (`NO_REPLY`, `PHONE_NO_ORDER`) là mảng rỗng vì ERP chưa từng có loại việc nào cho
 * chúng — không có dữ liệu hội thoại thì không thể có. Chúng đọc thẳng từ `conversation_funnel`.
 *
 * `INFO_NO_ORDER` cũng đọc từ `conversation_funnel` chứ KHÔNG từ `CS_CASE`, dù case CSKH
 * `ORDER_NOT_CREATED` đang nói cùng chuyện. Lý do: `cs_cases` chỉ giữ ca CHƯA có đơn (ca đã có đơn
 * không sinh case) nên nó không có mẫu số, và nó gom theo tuần/tháng bằng `dedupeKey` nên một ca có
 * thể biến mất khỏi danh sách dù vẫn chưa xử lý. Bảng hội thoại không có hai nhược điểm đó.
 */
export const LEAKAGE_FROM_CASE_TYPES: Record<LeakageBucket, CaseType[]> = {
  NO_REPLY: [],
  PHONE_NO_ORDER: [],
  INFO_NO_ORDER: [],
  UNCONFIRMED: ["NEW_ORDER_UNPROCESSED", "ORDER_INCOMPLETE", "ORDER_ADDRESS_NOT_NORMALIZED"],
  NO_SHIPMENT: ["ORDER_CONFIRMATION_STALE"],
};

/** Loại việc → nhóm rò rỉ. Suy từ bảng trên, một chỗ duy nhất. */
export const CASE_TYPE_TO_BUCKET: Partial<Record<CaseType, LeakageBucket>> = Object.fromEntries(
  LEAKAGE_BUCKETS.flatMap((b) => LEAKAGE_FROM_CASE_TYPES[b].map((t) => [t, b])),
) as Partial<Record<CaseType, LeakageBucket>>;

/** Hạn xử lý (giờ): quá hạn thì ca vào hàng đợi. */
export const LEAKAGE_SLA_HOURS: Record<LeakageBucket, number> = {
  NO_REPLY: LEAD_REPLY_SLA_HOURS,
  PHONE_NO_ORDER: 6,
  INFO_NO_ORDER: 2,
  // Hai nhóm cuối do Hàng đợi việc quyết định hạn (CASE_SLA_HOURS); số ở đây chỉ để xếp nhóm.
  UNCONFIRMED: 12,
  NO_SHIPMENT: 24,
};

/**
 * TUỔI TỐI ĐA (giờ) — quá mốc này thì KHÔNG còn là việc làm được nữa.
 *
 * Bốn nhóm đầu tính theo nhịp thật của bán hàng qua chat: khách đang so giá ở ba shop cùng lúc.
 * `NO_SHIPMENT` để rộng nhất (10 ngày) vì hàng vẫn nằm trong kho — vẫn gửi được, chỉ là muộn.
 */
export const LEAKAGE_MAX_AGE_HOURS: Record<LeakageBucket, number> = {
  NO_REPLY: 72,
  PHONE_NO_ORDER: 120,
  INFO_NO_ORDER: 168,
  UNCONFIRMED: 168,
  NO_SHIPMENT: 240,
};

/** Việc cần làm. Câu lệnh cụ thể, không phải lời khuyên chung. */
export const LEAKAGE_ACTION: Record<LeakageBucket, string> = {
  NO_REPLY:
    "Mở hội thoại trả lời khách NGAY. Khách đã nhắn và đang chờ — mỗi giờ im lặng là một lần khách chuyển sang shop khác. Đây là nhóm rẻ nhất để cứu: chỉ cần một tin nhắn.",
  PHONE_NO_ORDER: "Nhắn xin địa chỉ nhận hàng rồi lên đơn. Khách đã cho số điện thoại nghĩa là đã đồng ý mua, chỉ còn thiếu địa chỉ.",
  INFO_NO_ORDER: "Tạo đơn trên Pancake ngay — khách đã cho đủ SĐT và địa chỉ. Nếu khách đổi ý thì ghi lý do vào hội thoại rồi bỏ qua ca này.",
  UNCONFIRMED: "Xác nhận đơn trên Pancake, hoặc gọi khách nếu còn thiếu thông tin.",
  NO_SHIPMENT: "Kho đóng gói và đẩy sang Viettel Post. Hàng còn trong kho, chỉ thiếu thao tác.",
};

/**
 * ───────────── TIỀN: BA CĂN CỨ, TUYỆT ĐỐI KHÔNG CỘNG VÀO NHAU ─────────────
 *
 * `lib/queries/order-intake.ts` đã từ chối ước tính tiền cho khách chưa có đơn, với lý do đúng:
 * *"nhân số khách chờ với giá trị đơn trung bình sẽ ra một con số nghe rất cụ thể mà không có gì
 * đứng sau"*. Luật đó được GIỮ NGUYÊN; ở đây chỉ nói rõ hơn bằng cách gắn căn cứ vào từng con số:
 *
 *  · `ACTUAL_ORDER` — đơn có thật, lấy đúng tiền của đơn. SỰ THẬT, được cộng vào tổng tiền treo.
 *  · `PAGE_MEDIAN`  — khách chưa có đơn: TRUNG VỊ giá trị đơn giao thành công của đúng page đó. Đây
 *                     là "một đơn của page này thường đáng bao nhiêu", KHÔNG phải "ta sẽ thu được
 *                     bấy nhiêu". Chỉ tính khi page đủ mẫu, và cộng vào một tổng RIÊNG có nhãn.
 *  · `UNKNOWN`      — không có căn cứ nào. `null`, KHÔNG phải 0.
 */
export type ValueBasis = "ACTUAL_ORDER" | "PAGE_MEDIAN" | "UNKNOWN";

export const VALUE_BASIS_LABEL: Record<ValueBasis, string> = {
  ACTUAL_ORDER: "Tiền của đơn thật",
  PAGE_MEDIAN: "Trung vị đơn của page (ước tính)",
  UNKNOWN: "Chưa biết",
};

/** Dưới số đơn này thì trung vị không đáng tin — trả `UNKNOWN` thay vì một con số mỏng. */
export const MIN_ORDERS_FOR_PAGE_MEDIAN = 20;

/** Mức tin cậy dùng lại thang của `lib/constants/recommendation.ts` — KHÔNG dựng enum thứ hai. */
export type LeakageConfidence = RecommendationConfidence;

/** Ca dưới mức này KHÔNG vào hàng đợi: phỏng đoán không phải việc cần làm. */
export const MIN_CONFIDENCE: LeakageConfidence = RECOMMENDATION_CONFIDENCE.MEDIUM;

export const CONFIDENCE_RANK: Record<LeakageConfidence, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** Lý do một ca bị loại khỏi hàng đợi. Phải đếm được và nói được — không loại lặng lẽ. */
export type SuppressionReason = "TOO_OLD" | "LOW_CONFIDENCE" | "AMBIGUOUS_MATCH" | "ALREADY_A_CASE" | "NOT_YET_DUE";

export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  TOO_OLD: "Quá cũ — gọi lại bây giờ làm khách khó chịu chứ không cứu được đơn",
  LOW_CONFIDENCE: "Bằng chứng quá mỏng — đưa vào sẽ làm loãng hàng đợi",
  AMBIGUOUS_MATCH: "Một SĐT nhiều đơn, không kết luận được là đã có đơn hay chưa",
  ALREADY_A_CASE: "Đã có case CSKH đang mở cho hội thoại này — không báo hai lần",
  NOT_YET_DUE: "Chưa quá hạn xử lý — vẫn đang trong thời gian bình thường",
};
