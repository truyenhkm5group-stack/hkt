/**
 * ═══════════ AI TRẢ LỜI CÂU NÀO, VÀ AI TRẢ LỜI CÂU NÀO ═══════════
 *
 * Chủ shop chốt 23/09/2026: **Meta (Facebook) auto-reply trả câu ĐẦU; khách nhắn lại lần nữa thì
 * nhân sự AI của ERP vào việc.** Bot Gemini bị gỡ hẳn — nhân sự AI thay nó, không chạy song song.
 *
 * ─── VÌ SAO PHẢI KHAI, KHÔNG ĐỂ NGẦM ───
 *
 * Trước đây trên page có HAI cái máy cùng trả lời (Gemini và nhân sự AI ở nấc trợ lý), và ERP
 * không phân biệt được chúng với nhân viên: đo 22/09/2026, toàn bộ 4.749 tin phía shop đến từ
 * đúng một cái tên là tên fanpage. Khi nhiều thứ cùng nói dưới một cái tên, "ai đang phụ trách
 * cuộc này" thôi là chuyện suy ra được — nó phải là một lời khai.
 *
 * ─── VÌ SAO ĐẾM LƯỢT KHÁCH, KHÔNG ĐẾM TIN CỦA SHOP ───
 *
 * Auto-reply của Meta có thể không tới (khách nhắn ngoài giờ khai, Meta đổi chính sách, quản trị
 * viên tắt nhầm), và khi đó ERP KHÔNG có cách nào biết. Nên luật không hỏi "Meta đã trả lời
 * chưa" — câu ấy không kiểm chứng được. Nó hỏi **"khách đã nhắn mấy lượt"**, và đó là dữ kiện
 * ERP quan sát trực tiếp.
 *
 * Hệ quả cố ý: nếu auto-reply không chạy, khách nhắn lượt thứ hai vẫn kích hoạt nhân sự AI —
 * muộn một lượt, nhưng không ai bị bỏ rơi. Nhánh sai rơi về phía TRẢ LỜI MUỘN chứ không phải
 * IM LẶNG MÃI MÃI.
 */

export const HANDOVER_MODES = ["META_AUTO_REPLY_FIRST", "AI_FROM_FIRST_MESSAGE"] as const;
export type HandoverMode = (typeof HANDOVER_MODES)[number];

export const HANDOVER_MODE_LABEL: Record<HandoverMode, string> = {
  META_AUTO_REPLY_FIRST: "Meta auto-reply trả câu đầu, AI vào từ lượt thứ hai",
  AI_FROM_FIRST_MESSAGE: "AI trả lời ngay từ câu đầu",
};

/** Khoá cấu hình. Đổi cách bàn giao là quyết định vận hành, không phải một lần deploy. */
export const HANDOVER_MODE_KEY = "ai.handoverMode";

/**
 * Mặc định theo quyết định 23/09/2026. Đây KHÔNG phải một ngưỡng nghiệp vụ cần hỏi lại mỗi lần —
 * nó là mô tả của cách page đang được vận hành, và đổi nó phải đi cùng việc đổi cấu hình Meta.
 */
export const DEFAULT_HANDOVER_MODE: HandoverMode = "META_AUTO_REPLY_FIRST";

/** Số lượt khách phải có TRƯỚC khi nhân sự AI được lên tiếng, theo từng cách bàn giao. */
export const CUSTOMER_TURNS_BEFORE_AI: Record<HandoverMode, number> = {
  META_AUTO_REPLY_FIRST: 2,
  AI_FROM_FIRST_MESSAGE: 1,
};

export type HandoverDecision = {
  /** Nhân sự AI có được xử lý lượt này không. */
  engage: boolean;
  /** Lý do đọc được, in thẳng vào lượt chạy — không để người đọc phải đoán vì sao máy im. */
  reason: string;
};

/**
 * Nhân sự AI có vào việc ở lượt này không. HÀM THUẦN.
 *
 * `customerTurns` = số tin KHÁCH đã gửi trong hội thoại, TÍNH CẢ tin đang xử lý. Đếm tin của
 * khách chứ không đếm tin của shop: xem ghi chú đầu tệp.
 */
export function shouldEngage(mode: HandoverMode, customerTurns: number): HandoverDecision {
  const can = CUSTOMER_TURNS_BEFORE_AI[mode] ?? CUSTOMER_TURNS_BEFORE_AI[DEFAULT_HANDOVER_MODE];
  if (customerTurns >= can) {
    return { engage: true, reason: `Khách đã nhắn ${customerTurns} lượt — nhân sự AI phụ trách từ lượt ${can}` };
  }
  return {
    engage: false,
    reason:
      mode === "META_AUTO_REPLY_FIRST"
        ? "Lượt đầu của khách — auto-reply của Meta trả lời; nhân sự AI vào từ lượt thứ hai"
        : `Chưa đủ ${can} lượt khách để nhân sự AI vào việc`,
  };
}

export function parseHandoverMode(raw: unknown): HandoverMode {
  // Giá trị lạ rơi về mặc định ĐANG VẬN HÀNH, không rơi về "AI trả lời ngay": một chuỗi gõ nhầm
  // trong settings không được biến thành việc máy chen vào câu đầu của mọi khách.
  return typeof raw === "string" && (HANDOVER_MODES as readonly string[]).includes(raw) ? (raw as HandoverMode) : DEFAULT_HANDOVER_MODE;
}
