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

/**
 * ═══════════ CHỈ NGƯỜI MỚI LÀ "ĐÃ CÓ NGƯỜI TRẢ LỜI" ═══════════
 *
 * Một lượt khách RỜI hàng đợi trợ lý khi phía shop đã đáp sau lượt ấy. Câu hỏi là: đáp bằng GÌ?
 *
 * ĐO NGÀY 16/09/2026 trên page thí điểm: 48 trên 50 hội thoại bị tính là "shop đã đáp rồi" và hàng
 * đợi ra ĐÚNG 0. Truy vấn khi ấy nhận cả `PAGE_BOT` là câu trả lời. Nghĩa là Botcake trả lời một
 * câu tự động xong thì khách BIẾN MẤT khỏi hàng đợi — không nhân viên nào còn thấy họ nữa, và
 * màn hình nói "không có việc nào" một cách hoàn toàn tự tin.
 *
 * Một câu bot KHÔNG phải một người đã xử lý khách. Nó thường là lời chào, là "shop sẽ phản hồi
 * sớm ạ", là đúng thứ khiến khách ngồi đợi. Gộp nó vào nhóm người là biến hàng đợi thành một
 * màn hình luôn rỗng — dạng hỏng tệ nhất, vì nó trông y hệt như đang làm việc tốt.
 *
 * `UNKNOWN` (tin phía shop không rõ tên người gửi) cũng KHÔNG nằm trong danh sách này. Nhánh lỗi
 * phải rơi về phía GIỮ LẠI việc: giữ nhầm thì một nhân viên đọc rồi bỏ qua, mất nhầm thì một
 * khách không bao giờ được trả lời.
 */
export const HUMAN_REPLY_SENDER_TYPES = ["PAGE_HUMAN"] as const;

/** Dạng chuỗi cho SQL: `('PAGE_HUMAN')`. Một nguồn duy nhất, không gõ lại danh sách ở truy vấn. */
export const HUMAN_REPLY_SQL_LIST = HUMAN_REPLY_SENDER_TYPES.map((t) => `'${t}'`).join(", ");

/**
 * ═══════════ CÂU MẪU LẶP LẠI KHÔNG PHẢI CÂU MỘT NGƯỜI VỪA GÕ ═══════════
 *
 * ĐO NGÀY 16/09/2026 trên page thí điểm, 339 tin mang nhãn `PAGE_HUMAN`:
 *
 *   · ĐÚNG MỘT tài khoản gửi cả 339 tin — nên không thể phân biệt người với máy bằng TÊN;
 *   · 71 tin gửi TRƯỚC tin đầu tiên của khách — nhân viên không chào trước khi khách nhắn;
 *   · 97 tin là bản sao Y HỆT của một tin khác, và hai câu dài xuất hiện ĐÚNG MỘT LẦN trong mỗi
 *     35 hội thoại khác nhau. Không ai gõ lại đúng từng chữ, đúng một lần, ở 35 chỗ.
 *
 * `classifySender` chạy lúc NẠP nên chỉ nhìn được MỘT tin: nó không thể biết câu ấy còn nằm ở 34
 * hội thoại khác. Vì thế phép nhận dạng này nằm ở LỚP ĐỌC, nơi có cả tập dữ liệu để so.
 *
 * Ngưỡng theo SỐ HỘI THOẠI chứ không theo số tin: một nhân viên có thể gửi lại cùng một câu vài
 * lần cho CÙNG một khách (gửi ảnh kèm chú thích, khách không thấy tin), nhưng cùng một câu xuất
 * hiện ở ba hội thoại KHÁC NHAU thì nó là câu mẫu.
 *
 * NHÁNH SAI RƠI VỀ PHÍA GIỮ VIỆC LẠI. Nhận nhầm câu của một nhân viên thật thành câu mẫu thì một
 * người đọc thẻ ấy rồi bỏ qua — mất vài giây. Nhận nhầm câu mẫu thành câu người thì một khách
 * biến mất khỏi hàng đợi và không bao giờ được trả lời.
 */
export const AUTOMATION_TEMPLATE_MIN_CONVERSATIONS = 3;

/** Dạng chuỗi cho SQL: `('SEND', 'EDIT_SEND', 'REJECT')`. Dẫn xuất, không gõ lại danh sách ở truy vấn. */
export const COPILOT_TERMINAL_SQL_LIST = COPILOT_TERMINAL_ACTIONS.map((a) => `'${a}'`).join(", ");

/**
 * ═══════════ ĐỦ BAO NHIÊU LƯỢT THÌ MỚI ĐỌC ĐƯỢC KẾT QUẢ THÍ ĐIỂM ═══════════
 *
 * Không phải một hạn chót. Đây là CỠ MẪU: dưới 20 lượt khách được nhân viên soát thì mọi tỷ lệ
 * đọc ra đều là tiếng ồn — một lần từ chối biến tỷ lệ dùng được từ 100% xuống 80%, và không ai
 * phân biệt được "câu máy soạn tệ" với "hôm đó gặp đúng một khách khó".
 *
 * Trần 50 để chốt lại: thí điểm là để RA QUYẾT ĐỊNH, không phải để chạy mãi. Đủ 50 lượt mà vẫn
 * chưa kết luận được thì vấn đề nằm ở câu hỏi, không nằm ở dữ liệu.
 *
 * ĐẾM CÁI GÌ: một lượt = MỘT CÂU MÁY SOẠN được một người kết thúc (gửi · sửa rồi gửi · từ chối).
 * KHÔNG đếm tin hệ thống, tin bot, tin nhân viên, và KHÔNG đếm lượt khách chưa ai soát. Cũng
 * không được kéo hội thoại cũ vào cho đủ số: cỡ mẫu đi kèm điều kiện "trên khách thật, trong kỳ
 * thí điểm", bỏ điều kiện ấy thì con số không còn nghĩa gì.
 */
export const PILOT_REVIEWED_TURNS_TARGET = { min: 20, max: 50 } as const;

/**
 * LIÊN KẾT TỚI HỘI THOẠI GỐC TRÊN PANCAKE.
 *
 * Người chấm cần đọc NGỮ CẢNH, không chỉ một lượt: ERP giữ tin kích hoạt và câu nhân viên trả
 * lời, nhưng một hội thoại 25 tin thì hai câu ấy không đủ để nói câu máy soạn có đúng hay không.
 *
 * Định dạng này đã tồn tại rải rác ở hơn mười nơi trong kho mã (đơn hàng, CSKH, cảnh báo, hàng
 * đợi tắc nghẽn…). Khai ở đây để nơi thứ mười một dùng lại thay vì chép chuỗi lần nữa — Pancake
 * đổi đường dẫn thì có ĐÚNG MỘT chỗ phải sửa.
 *
 * Trả `null` khi thiếu một trong hai khoá. Một liên kết dựng từ chuỗi rỗng vẫn bấm được, vẫn mở
 * ra một trang, và trang ấy là hội thoại của người khác hoặc một lỗi 404 — cả hai đều tệ hơn
 * việc không hiện nút.
 */
export function pancakeConversationUrl(pageId: string, conversationExternalId: string): string | null {
  if (!pageId.trim() || !conversationExternalId.trim()) return null;
  return `https://pancake.vn/${pageId}?c_id=${conversationExternalId}`;
}

/**
 * ═══════════ AI TRẢ LẠI HỘI THOẠI CHO MÁY ĐƯỢC ═══════════
 *
 * `human_takeover_at` bật lên theo HAI đường, và chúng cần hai luật khác nhau:
 *
 *   · NGƯỜI bấm "Tự nhận việc"      ⇒ `takeoverByUserId` CÓ giá trị. Người ấy có thể đang gõ dở
 *     một câu cho khách; ai cũng bật máy lên được thì máy nói chen vào giữa. Chặn — trừ chính họ
 *     và người có quyền cấu hình.
 *   · MÁY gọi `conversation.handoff` ⇒ `takeoverByUserId` NULL. **KHÔNG AI CẦM CẢ.**
 *
 * Luật cũ áp một mệnh đề cho cả hai, nên ở trường hợp thứ hai nó bảo vệ một người KHÔNG TỒN TẠI:
 * 295 hội thoại kẹt cứng, và màn hình hiện đúng một câu "Chỉ người đang cầm việc mới trả lại
 * được" — không kèm một cái nút nào. Chủ shop mở ra ngày 23/09/2026: "tôi không biết phải làm gì
 * tiếp với cái này."
 *
 * Tách thành hàm THUẦN để bài kiểm chạm được vào nó: cái ngõ cụt ấy là một mệnh đề `if` sai, và
 * một mệnh đề `if` chôn trong Server Action thì không bài kiểm nào với tới mà không dựng cả phiên
 * đăng nhập.
 */
export function canReleaseTakeover(p: { takeoverByUserId: string | null; userId: string; canManage: boolean }): boolean {
  if (!p.takeoverByUserId) return true; // máy tự rút — không có ai để bảo vệ
  return p.takeoverByUserId === p.userId || p.canManage;
}
