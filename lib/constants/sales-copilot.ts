/**
 * NẤC TRỢ LÝ (COPILOT) — MÁY SOẠN, NGƯỜI BẤM GỬI.
 *
 * Tệp này khai ba thứ, và cả ba đều là DANH SÁCH ĐÓNG: page nào được thí điểm, nhân viên làm được
 * những việc gì trên một câu gợi ý, và từ chối thì vì lý do nào.
 *
 * ─── VÌ SAO PAGE PHẢI LÀ MỘT DANH SÁCH TRẮNG, KHÔNG PHẢI MỘT CỜ BẬT/TẮT ───
 *
 * Nhân sự AI là MỘT dòng trong `ai_agents` và nấc quyền hạn của nó là MỘT giá trị. Bật nấc COPILOT
 * lên thì nó bật cho mọi hội thoại nó đang đọc — mà nó đang đọc nhiều page. Thí điểm trên một page
 * mà lại phải nâng nấc toàn cục là đúng cách để một page khác vô tình gửi tin.
 *
 * Nên cổng gửi của nấc COPILOT hỏi thêm một câu nữa: page này có tên trong danh sách không. Danh
 * sách nằm ở `settings["ai.copilotPages"]` (chủ shop sửa được, có ghi nhật ký) và rỗng thì KHÔNG
 * page nào gửi được — mặc định rơi về phía hẹp hơn, như mọi nhánh lỗi khác trong ERP.
 */

/** Khoá cấu hình danh sách trắng page được phép dùng nấc COPILOT. */
export const COPILOT_PAGES_KEY = "ai.copilotPages";

/**
 * VIỆC NHÂN VIÊN LÀM ĐƯỢC TRÊN MỘT CÂU GỢI Ý.
 *
 * Ba việc đầu là KẾT THÚC: một câu gợi ý chỉ được gửi / sửa rồi gửi / từ chối đúng MỘT lần, và
 * ràng buộc ở CSDL giữ điều đó — hai lần bấm trên hai tab không được thành hai tin nhắn cho khách.
 *
 * `REGENERATE` và `TAKEOVER` không kết thúc câu gợi ý: soạn lại thì sinh ra một câu mới, còn nhận
 * việc thì đóng cả hội thoại chứ không đóng riêng câu ấy.
 */
export const COPILOT_ACTIONS = ["SEND", "EDIT_SEND", "REJECT", "REGENERATE", "TAKEOVER", "RELEASE"] as const;
export type CopilotAction = (typeof COPILOT_ACTIONS)[number];

/** Ba việc KẾT THÚC một câu gợi ý — chỉ một trong ba, và chỉ một lần. */
export const COPILOT_TERMINAL_ACTIONS: readonly CopilotAction[] = ["SEND", "EDIT_SEND", "REJECT"];

export const COPILOT_ACTION_LABEL: Record<CopilotAction, string> = {
  SEND: "Gửi nguyên văn",
  EDIT_SEND: "Sửa rồi gửi",
  REJECT: "Từ chối",
  REGENERATE: "Soạn lại",
  TAKEOVER: "Tự nhận việc",
  RELEASE: "Trả lại cho máy",
};

/**
 * VÌ SAO TỪ CHỐI — một cú bấm là đủ.
 *
 * Bắt nhân viên gõ một đoạn giải thích thì họ sẽ bỏ qua ô ấy, và ta mất luôn dữ liệu. Danh sách
 * đóng thì ĐẾM được, và đếm được mới biết máy hay hỏng ở đâu nhất.
 */
export const COPILOT_REJECT_REASONS = [
  "WRONG_PRODUCT",
  "WRONG_INTENT",
  "WRONG_PRICE",
  "WRONG_SIZE",
  "WRONG_POLICY",
  "BAD_WORDING",
  "TOO_LONG",
  "TOO_SHORT",
  "MISSED_CLOSE",
  "UNNECESSARY_HANDOFF",
  "OTHER",
] as const;
export type CopilotRejectReason = (typeof COPILOT_REJECT_REASONS)[number];

export const COPILOT_REJECT_LABEL: Record<CopilotRejectReason, string> = {
  WRONG_PRODUCT: "Sai sản phẩm",
  WRONG_INTENT: "Hiểu sai ý khách",
  WRONG_PRICE: "Sai giá",
  WRONG_SIZE: "Sai size",
  WRONG_POLICY: "Sai chính sách",
  BAD_WORDING: "Câu chữ không ổn",
  TOO_LONG: "Dài quá",
  TOO_SHORT: "Cụt quá",
  MISSED_CLOSE: "Bỏ lỡ cơ hội chốt",
  UNNECESSARY_HANDOFF: "Chuyển người không cần thiết",
  OTHER: "Khác",
};

/** Trạng thái lần gửi. `PENDING` = đã ghi phiếu nhưng chưa biết Pancake nhận chưa. */
export const COPILOT_SEND_STATUSES = ["NONE", "PENDING", "SENT", "FAILED"] as const;
export type CopilotSendStatus = (typeof COPILOT_SEND_STATUSES)[number];

/**
 * CÂU GỢI Ý CŨ QUÁ THÌ KHÔNG GỬI NỮA.
 *
 * Nhân viên mở hàng đợi lúc 9 giờ, đi ăn trưa, 13 giờ quay lại bấm gửi — trong khi khách đã nhắn
 * thêm ba tin. Câu gợi ý ấy trả lời một cuộc hội thoại không còn tồn tại. Cổng gửi kiểm hai điều:
 * câu chưa quá hạn dưới đây, VÀ chưa có tin khách nào tới sau khi nó được soạn.
 */
export const COPILOT_SUGGESTION_TTL_MINUTES = 30;

/**
 * CẢNH BÁO THIẾU DỮ LIỆU — hiện TRÊN THẺ, trước khi nhân viên bấm.
 *
 * Ba chỗ ERP có thể KHÔNG biết, và cả ba đều là chỗ một câu trả lời trôi chảy dễ nói bừa nhất.
 * Máy đã được chặn không đoán (luật 10, 47 và cổng năng lực), nhưng NHÂN VIÊN vẫn sửa tay rồi gửi
 * được — đó là quyền của họ. Việc của hệ thống là: nói rõ đang thiếu gì TRƯỚC khi họ bấm, rồi GHI
 * LẠI rằng họ đã bấm trong lúc thiếu. Giấu đi thì lần sau không ai biết vì sao một lời hứa sai đã
 * ra khỏi cửa.
 */
export const COPILOT_WARNINGS = ["SIZE_DATA_MISSING", "POLICY_MISSING", "SELLABILITY_UNKNOWN"] as const;
export type CopilotWarning = (typeof COPILOT_WARNINGS)[number];

export const COPILOT_WARNING_LABEL: Record<CopilotWarning, string> = {
  SIZE_DATA_MISSING: "CHƯA CÓ BẢNG SỐ ĐO — máy không đoán size",
  POLICY_MISSING: "CHƯA KHAI CHÍNH SÁCH ĐỔI TRẢ — máy không tự cam kết",
  SELLABILITY_UNKNOWN: "CHƯA BIẾT CÒN HÀNG — máy không nói \"còn hàng\"",
};

/**
 * HỘI THOẠI CŨ HƠN NGẦN NÀY GIỜ THÌ RỜI HÀNG ĐỢI.
 *
 * Hàng đợi xếp người chờ LÂU NHẤT lên trước, nên nếu không có mốc cắt thì một tồn đọng vài ngày sẽ
 * đẩy những cuộc nguội ngắt lên đầu và chôn người vừa nhắn xuống dưới. Cắt ở đây là cách nói
 * "chờ lâu nhất trong số CÒN ĐÁNG TRẢ LỜI", chứ không phải "cũ nhất trong lịch sử".
 *
 * Facebook cũng chỉ cho nhắn lại trong 24 giờ kể từ tin cuối của khách mà không cần thẻ tin nhắn,
 * nên quá mốc ấy phần lớn là không gửi được nữa — mốc kinh doanh và mốc kỹ thuật trùng nhau.
 */
export const COPILOT_QUEUE_RELEVANT_HOURS = 24;

/** Trần ký tự của một tin nhắn bán hàng — bằng trần mà lưới soi bản mô hình viết đang dùng. */
export const COPILOT_MAX_REPLY_CHARS = 1200;

/**
 * Câu gợi ý và câu nhân viên gửi đi khác nhau tới mức nào thì gọi là ĐÃ SỬA ĐÁNG KỂ.
 *
 * Sửa một dấu câu không nói lên điều gì; viết lại nửa câu thì có. Ngưỡng tính theo tỷ lệ ký tự
 * khác nhau trên độ dài câu gốc, để một câu dài và một câu ngắn được đo cùng một thước.
 */
export const COPILOT_MEANINGFUL_EDIT_RATIO = 0.2;

/** Khoảng cách sửa (Levenshtein). HÀM THUẦN, dùng cho cả chỉ số lẫn kiểm thử. */
export function editDistance(a: string, b: string): number {
  const s = a ?? "";
  const t = b ?? "";
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let truoc = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const hienTai = [i];
    for (let j = 1; j <= t.length; j += 1) {
      hienTai[j] = Math.min(truoc[j] + 1, hienTai[j - 1] + 1, truoc[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    truoc = hienTai;
  }
  return truoc[t.length];
}

/** Có phải một lần sửa ĐÁNG KỂ không. Câu gốc rỗng ⇒ mọi thứ gõ vào đều là đáng kể. */
export function isMeaningfulEdit(suggestion: string, final: string): boolean {
  const goc = (suggestion ?? "").trim();
  const cuoi = (final ?? "").trim();
  if (goc === cuoi) return false;
  if (!goc.length) return true;
  return editDistance(goc, cuoi) / goc.length >= COPILOT_MEANINGFUL_EDIT_RATIO;
}
