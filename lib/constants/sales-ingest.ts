/**
 * ───────────── HỢP ĐỒNG NẠP HỘI THOẠI PANCAKE ─────────────
 *
 * Tệp này khai TƯỜNG MINH: mỗi trường logic được đọc từ những khoá JSON nào, và mức tin cậy của
 * ánh xạ đó. Lý do phải khai ra thay vì giấu trong hàm chuẩn hoá:
 *
 * Phần ĐỌC BÙ QUA API (`pages.fm/api/v1`) đã chạy thật trong ERP từ job `cs-chat`, nên tên trường
 * của nó là SỰ THẬT ĐÃ KIỂM CHỨNG. Phần WEBHOOK thì chưa: tài liệu Pancake POS trong kho mã
 * (`docs/API-PANCAKE-VIETTELPOST.md`) chỉ liệt kê bốn loại webhook — orders · customers · products
 * · variations_warehouses — KHÔNG có loại nào cho tin nhắn. Nghĩa là đường webhook hội thoại hiện
 * là một GIẢ ĐỊNH chưa được xác nhận.
 *
 * Vì thế bộ chuẩn hoá không bao giờ ĐOÁN: gói tin không có đủ ba khoá bắt buộc thì bị đánh dấu
 * `UNRECOGNIZED` kèm danh sách khoá thật sự có trong gói tin, để chủ shop gửi lại một mẫu thật và
 * việc ánh xạ được làm cho đúng trong vài phút — thay vì im lặng ghi một dòng sai.
 */

/** Ai gửi tin. Tách nhân viên khỏi bot là điều kiện để so sánh AI với NGƯỜI. */
export const SENDER_TYPES = ["CUSTOMER", "PAGE_HUMAN", "PAGE_BOT", "UNKNOWN"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

export const SENDER_TYPE_LABEL: Record<SenderType, string> = {
  CUSTOMER: "Khách",
  PAGE_HUMAN: "Nhân viên",
  PAGE_BOT: "Bot / tự động",
  UNKNOWN: "Chưa rõ",
};

/** Đường đã ghi một dòng tin nhắn. */
export const INGEST_SOURCES = ["WEBHOOK", "POLL", "MANUAL"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export const INGEST_SOURCE_LABEL: Record<IngestSource, string> = {
  WEBHOOK: "Webhook hội thoại",
  POLL: "Job đọc bù qua API",
  MANUAL: "Nhập tay",
};

/**
 * Tên tài khoản/ứng dụng được coi là MÁY chứ không phải người. Một tin do Botcake gửi mà bị tính
 * là "câu nhân viên trả lời" sẽ làm hỏng mọi con số đối chiếu — đây chính là bài học đã có với
 * `Bot ERP` trong bảng `cs_cases`.
 *
 * So khớp không dấu, không phân biệt hoa thường, theo CỤM (không phải chuỗi con) — xem `isBotName`.
 */
export const BOT_SENDER_NAMES = ["botcake", "bot erp", "chatbot", "pancake bot", "auto reply", "tra loi tu dong"] as const;

export type FieldConfidence = "VERIFIED" | "UNVERIFIED";

export type FieldMapping = {
  /** Ý nghĩa nghiệp vụ của trường. */
  label: string;
  /** Các khoá JSON được chấp nhận, theo thứ tự ưu tiên. */
  keys: string[];
  confidence: FieldConfidence;
  required: boolean;
  /** Vì sao mức tin cậy là như vậy — đọc lại được khi tranh luận. */
  evidence: string;
};

const PAGES_API = "Đã chạy thật qua PancakePagesClient (job cs-chat, 15 phút/lần)";
const WEBHOOK_GUESS = "CHƯA KIỂM CHỨNG: tài liệu Pancake trong kho mã không liệt kê webhook cho tin nhắn";

/**
 * Bản khai ánh xạ trường. Bộ chuẩn hoá webhook đọc CHÍNH danh sách này, nên tài liệu và mã nguồn
 * không thể lệch nhau.
 */
export const CHAT_FIELD_MAP: Record<string, FieldMapping> = {
  pageId: { label: "Mã page", keys: ["page_id"], confidence: "UNVERIFIED", required: true, evidence: WEBHOOK_GUESS },
  conversationId: { label: "Mã hội thoại", keys: ["conversation_id", "id"], confidence: "UNVERIFIED", required: true, evidence: WEBHOOK_GUESS },
  messageId: { label: "Mã tin nhắn", keys: ["id", "message_id"], confidence: "UNVERIFIED", required: true, evidence: WEBHOOK_GUESS },
  customerId: { label: "Mã khách", keys: ["customer.id", "customer.fb_id", "from.id"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  customerName: { label: "Tên khách", keys: ["customer.name", "from.name"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  senderId: { label: "Mã người gửi", keys: ["from.id", "from_id"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  senderName: { label: "Tên người gửi", keys: ["from.name"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  fromPage: { label: "Tin do page gửi", keys: ["from_page", "type=page", "from.id == page_id"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  text: { label: "Nội dung", keys: ["message", "original_message", "text"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  sentAt: { label: "Mốc gửi", keys: ["inserted_at", "created_time", "created_at"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  attachments: { label: "Tệp đính kèm", keys: ["attachments[]"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  phones: { label: "SĐT trong hội thoại", keys: ["recent_phone_numbers[]", "customer.phone_numbers[]"], confidence: "VERIFIED", required: false, evidence: PAGES_API },
  platform: { label: "Nền tảng (facebook/instagram)", keys: ["platform", "page.platform"], confidence: "UNVERIFIED", required: false, evidence: "Chỉ chắc chắn khi đọc từ danh sách page qua listPages()" },
};

/** Ba khoá thiếu một là không chuẩn hoá được — vì không còn cách nào chống trùng. */
export const REQUIRED_CHAT_FIELDS = Object.entries(CHAT_FIELD_MAP)
  .filter(([, m]) => m.required)
  .map(([key]) => key);

/** Vì sao một gói tin bị từ chối. Không bao giờ là "im lặng bỏ qua". */
export const CHAT_REJECT_REASONS = ["MISSING_REQUIRED_FIELD", "NOT_JSON_OBJECT", "EMPTY_PAYLOAD"] as const;
export type ChatRejectReason = (typeof CHAT_REJECT_REASONS)[number];

export const CHAT_REJECT_LABEL: Record<ChatRejectReason, string> = {
  MISSING_REQUIRED_FIELD: "Thiếu khoá bắt buộc (page / hội thoại / tin nhắn)",
  NOT_JSON_OBJECT: "Body không phải một object JSON",
  EMPTY_PAYLOAD: "Body rỗng",
};
