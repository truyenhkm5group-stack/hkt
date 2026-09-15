/**
 * NHẬN DIỆN SẢN PHẨM — SỔ ĐĂNG KÝ CÁC TẦNG CĂN CỨ.
 *
 * Mẻ chạy thử đầu (20 hội thoại thật, 14/09/2026) khớp được 0/20 sản phẩm vì chỉ có MỘT tầng:
 * so chữ khách gõ với tên trong danh mục. Khách thật gần như không gõ tên mẫu — họ bấm vào một
 * quảng cáo rồi nhắn "còn hàng không ạ".
 *
 * Sổ này liệt kê các tầng THEO THỨ TỰ TIN CẬY GIẢM DẦN, và — quan trọng không kém — ghi rõ tầng
 * nào KHÔNG DÙNG ĐƯỢC cùng lý do, để lần sau không ai dựng lại một tầng trên một trường không tồn
 * tại. Căn cứ là bài kiểm kê API thật (`scripts/pancake-signal-audit.ts`, page 1117899664739453,
 * 20 hội thoại + 80 tin nhắn).
 */

export const PRODUCT_RESOLUTION_SOURCES = [
  /**
   * (0) ẢNH CHỤP NGỮ CẢNH BÁN trên chính hội thoại — đứng trên tất cả, kể cả mã hàng gõ tay, vì
   * nó là chuyện ĐÃ RỒI: khách đã được tư vấn mẫu nào thì cuộc ấy thuộc mẫu đó.
   */
  "CONVERSATION_SNAPSHOT",
  /** (0b) Luật nguồn khai tay cho đúng quảng cáo / bài viết ấy. Ngoại lệ đè mặc định. */
  "SOURCE_RULE",
  /**
   * (0c) MẪU THẮNG ĐANG CHẠY CỦA FANPAGE — ĐƯỜNG BÌNH THƯỜNG.
   * Một page bán một mẫu thắng, nên mẫu hàng là thứ ĐÃ BIẾT chứ không phải thứ phải suy ra.
   * Mọi tầng suy luận bên dưới tụt xuống thành ngoại lệ.
   */
  "FANPAGE_ACTIVE_PRODUCT",
  /** (A) Khách hoặc nhân viên gõ thẳng mã hàng. Chắc chắn nhất trong các tầng SUY LUẬN. */
  "EXPLICIT_CODE",
  /** (C1) Mã quảng cáo đã có trong bản đồ do NGƯỜI đặt. Là sự thật, không phải suy luận. */
  "AD_MAP_HUMAN",
  /** (C2) Mã quảng cáo đã có trong bản đồ do MÁY tự học từ câu quảng cáo. */
  "AD_MAP_AUTO",
  /** (C3) Chưa có bản đồ: khớp CÂU QUẢNG CÁO đi kèm với danh mục ngay tại lượt này. */
  "AD_DESCRIPTION",
  /** (D) Lượt trước trong CHÍNH hội thoại này đã chốt được mẫu. */
  "CONVERSATION_HISTORY",
  /** (D2) Nhân viên đã nhắc mã hàng trong chính hội thoại này. */
  "STAFF_MESSAGE_CODE",
  /** (E) Khớp chữ khách gõ với tên/mã sản phẩm. Yếu nhất trong các tầng dùng được. */
  "TEXT_MATCH",
  /** (G) Không tầng nào kết luận được ⇒ chuyển người. KHÔNG chọn bừa. */
  "NONE",
] as const;
export type ProductResolutionSource = (typeof PRODUCT_RESOLUTION_SOURCES)[number];

/**
 * TẦNG ĐÃ XÉT VÀ KHÔNG DÙNG ĐƯỢC — kèm lý do đo được.
 *
 * Khai ra thay vì im lặng bỏ qua: một tầng vắng mặt không lý do sẽ được ai đó "bổ sung" bằng một
 * trường tưởng tượng. Mỗi dòng dưới đây là một phép đo trên dữ liệu thật, đọc lại được.
 */
export const PRODUCT_RESOLUTION_UNAVAILABLE = {
  /** (B) trong đề bài gốc. */
  PANCAKE_PRODUCT_METADATA:
    "Pages API không trả về trường product / SKU / order / cart nào trong hội thoại lẫn tin nhắn (kiểm kê 20 hội thoại + 80 tin, 14/09/2026). Pancake POS là hệ khác, không gắn với tin nhắn.",
  /** Bài viết ở mức hội thoại. */
  CONVERSATION_POST_ID:
    "`post_id` và `post` của hội thoại NULL 20/20. Chỉ tin nhắn mới mang bài viết, và chỉ khi khách bấm quảng cáo.",
  /** Tin được trích dẫn / trả lời. */
  QUOTED_MESSAGE:
    "`parent_id` NULL 80/80 — Pages API không cho biết tin nào trả lời tin nào trong hộp thư.",
  /** (F) trong đề bài gốc. */
  IMAGE_MATCH:
    "Đính kèm ảnh chỉ có `url` + `image_data.width/height`, không mã sản phẩm, không mã bài. Không có dữ liệu định danh nào để khớp ảnh với mẫu mã; nhận diện bằng thị giác chưa có trong hệ.",
} as const;

/**
 * NGƯỠNG NHẬN. Dưới ngưỡng ⇒ coi như CHƯA BIẾT và chuyển người.
 * "Ứng viên tốt nhất" không phải là "đúng": một danh mục 6 sản phẩm luôn có ứng viên tốt nhất.
 */
export const PRODUCT_RESOLUTION_ACCEPT_MIN = 0.6;

/** Độ tin cậy cố định của từng tầng. Tầng khớp chữ tự tính theo điểm khớp. */
export const PRODUCT_RESOLUTION_CONFIDENCE: Record<Exclude<ProductResolutionSource, "TEXT_MATCH" | "NONE">, number> = {
  CONVERSATION_SNAPSHOT: 1,
  SOURCE_RULE: 1,
  FANPAGE_ACTIVE_PRODUCT: 0.95,
  EXPLICIT_CODE: 1,
  AD_MAP_HUMAN: 1,
  AD_MAP_AUTO: 0.85,
  AD_DESCRIPTION: 0.75,
  CONVERSATION_HISTORY: 0.7,
  STAFF_MESSAGE_CODE: 0.9,
};

/** Điểm của `scoreProductMatch` (0–5) quy ra độ tin cậy. 2 điểm = 0,4 ⇒ dưới ngưỡng ⇒ không nhận. */
export const TEXT_MATCH_CONFIDENCE: Record<number, number> = { 5: 0.95, 4: 0.8, 3: 0.65, 2: 0.4, 1: 0.2 };

/** Nhãn tiếng Việt cho màn hình và báo cáo. */
export const PRODUCT_RESOLUTION_LABEL: Record<ProductResolutionSource, string> = {
  CONVERSATION_SNAPSHOT: "Ảnh chụp trên hội thoại",
  SOURCE_RULE: "Luật nguồn khai tay",
  FANPAGE_ACTIVE_PRODUCT: "Mẫu thắng của fanpage",
  EXPLICIT_CODE: "Mã hàng gõ thẳng",
  AD_MAP_HUMAN: "Bản đồ quảng cáo (người đặt)",
  AD_MAP_AUTO: "Bản đồ quảng cáo (máy học)",
  AD_DESCRIPTION: "Khớp câu quảng cáo",
  CONVERSATION_HISTORY: "Lượt trước trong hội thoại",
  STAFF_MESSAGE_CODE: "Nhân viên đã nhắc mã",
  TEXT_MATCH: "Khớp chữ khách gõ",
  NONE: "Không kết luận được",
};
