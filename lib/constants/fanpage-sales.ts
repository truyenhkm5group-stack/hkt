/**
 * HỒ SƠ BÁN HÀNG CỦA FANPAGE — mô hình vận hành thật của shop.
 *
 * ĐẢO NGƯỢC SO VỚI BẢN TRƯỚC. Bản trước cố ĐOÁN mẫu hàng từ từng tin nhắn và từng quảng cáo, đo
 * được 17% trên dữ liệu thật. Cách vận hành thật thì ngược lại: MỘT fanpage tại một thời điểm bán
 * MỘT mẫu thắng. Vậy mẫu hàng là thứ ĐÃ BIẾT TỪ TRƯỚC theo page, không phải thứ phải suy ra.
 *
 * Suy luận từ quảng cáo tụt xuống thành NGOẠI LỆ, và chỉ ngoại lệ mới phải khai.
 */

/** Một cuộc trò chuyện đến từ nguồn nào — quyết định TOÀN BỘ cách máy cư xử sau đó. */
export const SOURCE_TYPES = ["WIN", "TEST", "HUMAN_ONLY", "UNKNOWN"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  WIN: "Hàng thắng",
  TEST: "Hàng test",
  HUMAN_ONLY: "Chỉ người trả lời",
  UNKNOWN: "Chưa xác định",
};

/**
 * THỨ TỰ CĂN CỨ PHÂN LOẠI — trên đè dưới, dừng ở căn cứ đầu tiên có mặt.
 *
 * `SNAPSHOT` đứng đầu và đó là điểm mấu chốt: hội thoại đã gắn hồ sơ rồi thì đổi cấu hình page
 * KHÔNG được viết lại quá khứ. Page chuyển Q004 → Q017 thì cuộc cũ vẫn thuộc Q004.
 */
export const CLASSIFICATION_SOURCES = [
  /** Đã chốt trên chính hội thoại từ lần trước — bất biến. */
  "SNAPSHOT",
  /** Luật nguồn khai tay cho đúng quảng cáo / bài viết ấy. */
  "SOURCE_RULE",
  /** Bản đồ quảng cáo → sản phẩm (đường cũ, vẫn dùng làm ngoại lệ). */
  "AD_MAP",
  /** Mặc định của fanpage: mẫu thắng đang chạy. ĐÂY LÀ ĐƯỜNG BÌNH THƯỜNG. */
  "FANPAGE_DEFAULT",
  /** Không căn cứ nào. */
  "NONE",
] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const CLASSIFICATION_SOURCE_LABEL: Record<ClassificationSource, string> = {
  SNAPSHOT: "Ảnh chụp trên hội thoại",
  SOURCE_RULE: "Luật nguồn khai tay",
  AD_MAP: "Bản đồ quảng cáo",
  FANPAGE_DEFAULT: "Mặc định của fanpage",
  NONE: "Không có căn cứ",
};

/** Độ tin cậy cố định theo căn cứ. Không có bậc nào do mô hình tự chấm. */
export const CLASSIFICATION_CONFIDENCE: Record<ClassificationSource, number> = {
  SNAPSHOT: 1,
  SOURCE_RULE: 1,
  AD_MAP: 0.85,
  FANPAGE_DEFAULT: 0.9,
  NONE: 0,
};

/** Nguồn là quảng cáo hay bài viết. */
export const SOURCE_KINDS = ["AD", "POST"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Vòng đời một mẫu đang test. */
export const TEST_PRODUCT_STATUSES = ["DRAFT", "RUNNING", "ENDED", "PROMOTED"] as const;
export type TestProductStatus = (typeof TEST_PRODUCT_STATUSES)[number];

/**
 * QUYỀN CỦA MÁY TRÊN HÀNG TEST — mặc định AN TOÀN HƠN hàng thắng.
 *
 * Máy được trả lời và đo thị trường, nhưng KHÔNG được lên đơn cho tới khi mẫu ấy có mã hàng thật
 * và cấu hình đơn hợp lệ. Khách muốn mua mà mẫu chưa có mã ⇒ `TEST_READY_TO_BUY` rồi chuyển người
 * — TUYỆT ĐỐI không đổi sang mẫu thắng của page để "cho xong đơn".
 */
export const TEST_REPLY_DEFAULTS = {
  aiReplyEnabled: true,
  allowQuotePrice: true,
  allowAnswerMaterial: true,
  allowAskSize: true,
  allowCollectPreference: true,
  allowCollectIntent: true,
  allowCollectPhone: true,
  allowCollectAddress: true,
  allowOfferProduct: true,
  // Nhóm dưới mặc định TẮT — mở từng cái khi mẫu test đã đủ điều kiện.
  allowAutoOrderCreate: false,
  allowConfirmOrder: false,
  allowPromotion: false,
  allowUpsell: false,
  allowFollowUp: false,
} as const;
export type TestReplyPolicy = { -readonly [K in keyof typeof TEST_REPLY_DEFAULTS]: boolean };

/** Chính sách bán: hai bộ luật khác hẳn nhau, không dùng chung. */
export const SALES_POLICIES = ["WIN_SALES", "TEST_SALES", "HUMAN"] as const;
export type SalesPolicy = (typeof SALES_POLICIES)[number];

/** Nguồn nào chạy chính sách nào. Bảng này là nơi DUY NHẤT nối hai khái niệm. */
export const POLICY_BY_SOURCE: Record<SourceType, SalesPolicy> = {
  WIN: "WIN_SALES",
  TEST: "TEST_SALES",
  HUMAN_ONLY: "HUMAN",
  UNKNOWN: "HUMAN",
};

/**
 * Lý do chuyển người riêng của tầng phân loại. Tách khỏi `HandoffReason` cũ vì đây là chuyện
 * "chưa biết đang bán gì", không phải "khách hỏi điều máy không được trả lời".
 */
export const CLASSIFICATION_HANDOFFS = ["UNKNOWN_PRODUCT_CONTEXT", "TEST_READY_TO_BUY", "SOURCE_HUMAN_ONLY"] as const;
export type ClassificationHandoff = (typeof CLASSIFICATION_HANDOFFS)[number];

export const CLASSIFICATION_HANDOFF_LABEL: Record<ClassificationHandoff, string> = {
  UNKNOWN_PRODUCT_CONTEXT: "Chưa xác định được đang bán mẫu nào",
  TEST_READY_TO_BUY: "Khách muốn mua hàng test chưa có mã hàng",
  SOURCE_HUMAN_ONLY: "Nguồn này khai chỉ người trả lời",
};

/** Nấc quyền hạn khai ở hồ sơ fanpage. Trùng danh sách của nền tảng, khai lại để màn hình dùng. */
export const FANPAGE_AI_MODES = ["OFF", "SHADOW", "COPILOT", "AUTO"] as const;
export type FanpageAiMode = (typeof FANPAGE_AI_MODES)[number];
