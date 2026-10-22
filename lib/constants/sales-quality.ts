/**
 * ═══════════ GIÁM SÁT CHẤT LƯỢNG AI BÁN HÀNG HẰNG NGÀY — GIAI ĐOẠN 2B «AI Sales Self-Optimizing» (chủ shop duyệt 21/10/2026) ═══════════
 *
 * MỘT chỗ khai mã lỗi chất lượng của bot bán hàng mà job hằng ngày đếm (lib/sales-quality/daily.ts). Mỗi mã:
 *  · ĐỊNH NGHĨA nằm ở hàm thuần CÓ SẴN của lượt sống (lib/sales-quality/detectors.ts gọi lại, không viết luật thứ hai) — `source` nói hàm nào;
 *  · ra MỘT việc / tổ chức / mã / NGÀY (khoá `salesQualityDedupeKey`), KHÔNG một việc cho mỗi hội thoại: đo production 21/10/2026 HSLC có
 *    98/214 hội thoại HANDOFF_UNANSWERED — 98 dòng việc là chôn hàng đợi;
 *  · việc đi vào /work qua `notifications.kind = SALES_QUALITY` ⇒ loại việc `SALES_QUALITY` (lib/constants/action-queue.ts) ⇒ phòng của nhóm
 *    CS, ghi đè được ở `work.ownership` (`ALERT:SALES_QUALITY`) KHÔNG cần deploy (AGENTS 22).
 * Không mã nào chấm điểm một người: lỗi của bot là lỗi cấu hình / câu mẫu / model, người đọc là người SỬA bot (AGENTS 24).
 * Mã hội thoại chỉ in ở dạng BĂM (`conversationHash`) — cùng phép băm `scripts/conv-money-trace.ts` in ra, nên ops đối chiếu được.
 * HÀM THUẦN, client import được.
 */

export const SALES_QUALITY_CODES = [
  "HANDOFF_UNANSWERED",
  "QTY_REASKED",
  "SECONDARY_INTENT_UNANSWERED",
  "WRONG_PRODUCT_TEMPLATE",
  "ADDRESS_REASK",
  "COMPLAINT_WHILE_SELLING",
  "CLARIFY_FALLBACK",
  "CLAIM_GUARD_BLOCK",
  "UPSELL_ACCEPTED_BUT_REASKED",
  "UPSELL_ACCEPTED_NOT_ATTACHED",
  "ADDRESS_RECEIVED_BUT_NOT_APPLIED",
] as const;
export type SalesQualityCode = (typeof SALES_QUALITY_CODES)[number];

export type SalesQualitySpec = {
  /** Nhãn ngắn trên /work. */
  label: string;
  /** Đơn vị đếm: một TIN bot sai, hay một HỘI THOẠI đang ở tình trạng sai (ảnh chụp lúc chạy). */
  unit: "MESSAGE" | "CONVERSATION";
  /** Hàm định nghĩa (luật sống) — kiểm thử mở đúng tệp này. */
  source: string;
  /** Việc phải làm, đủ cụ thể để người đọc biết mở trang nào. */
  action: string;
};

export const SALES_QUALITY_SPEC: Record<SalesQualityCode, SalesQualitySpec> = {
  HANDOFF_UNANSWERED: {
    label: "Khách chờ người quá hạn, chưa ai trả lời",
    unit: "CONVERSATION",
    source: "lib/constants/handoff-reply.ts",
    action: "Mở hộp thư lọc «chờ người», trả lời từ khách chờ lâu nhất; hạn đọc từ work.sla (SALES_CHAT_HANDOFF).",
  },
  QTY_REASKED: {
    label: "Khách đã chọn số lượng mà bot hỏi lại / gửi lại câu cũ",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/round-check.ts",
    action: "Xem câu mẫu / lời dặn hỏi số lượng: khách đã trả lời «2kg», «lấy 2» thì câu kế phải đi tiếp bước chốt.",
  },
  SECONDARY_INTENT_UNANSWERED: {
    label: "Khách hỏi thời gian giao kèm số lượng mà bot bỏ qua",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/delivery-intent.ts",
    action: "Bổ sung câu trả lời thời gian giao (kiến thức shop / câu mẫu giao hàng) để bot trả lời cả hai ý.",
  },
  WRONG_PRODUCT_TEMPLATE: {
    label: "Câu mẫu nói về món KHÁC món khách đang hỏi",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/quick-reply-focus.ts",
    action: "Mở Câu mẫu, sửa từ khoá kích hoạt / gắn đúng sản phẩm cho câu mẫu bị gửi nhầm món.",
  },
  // KHOÁ LƯU giữ nguyên `ADDRESS_REASK` (dedupe `sales-quality:<mã>:<ngày>` + notifications đang dùng — Tech Lead 22/10/2026). Đây là
  // hiện tượng KNOWN_ADDRESS_REASKED (hỏi lại phần địa chỉ / SĐT / tên đã biết), RỘNG HƠN dòng L KNOWN_CUSTOMER_ADDRESS_REASK của
  // scripts/conv-money-trace.ts (chỉ khách CŨ có đơn nối chắc). Một hiện tượng, một mã.
  ADDRESS_REASK: {
    label: "Bot hỏi lại địa chỉ / SĐT khách đã cho (KNOWN_ADDRESS_REASKED)",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/address-memory.ts",
    action: "Câu hỏi lại đã lọt qua hàng rào hỏi-lại — xem câu mẫu / lời dặn xin địa chỉ đang gửi ở bước chốt.",
  },
  COMPLAINT_WHILE_SELLING: {
    label: "Khách đang phàn nàn mà bot mời mua thêm",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/lifecycle.ts",
    action: "Xem câu mẫu mời mua thêm đang bật: khách phàn nàn thì xử lý khiếu nại trước, không mời mua.",
  },
  CLARIFY_FALLBACK: {
    label: "Bot gửi câu dự phòng «nói rõ hơn»",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/engine.ts",
    action: "Lượt model không ra câu nào gửi khách — xem lỗi lượt AI / độ dài lời dặn; khách nhận một câu không trả lời gì.",
  },
  // KHÔNG gồm câu ghi nhận `ORDER_RECEIVED` («Dạ em đã ghi nhận đơn của mình ạ.»): từ 22/10/2026 đó là câu THƯỜNG của mọi đơn tự chốt khi
  // địa chỉ chờ xác minh nội bộ (chủ shop: xác minh độc lập với upsell), không phải một lần hàng rào chặn khẳng định.
  CLAIM_GUARD_BLOCK: {
    label: "Hàng rào khẳng định thay câu của bot bằng câu an toàn",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/claim-guard.ts",
    action: "Bot định khẳng định điều chưa có chứng từ (đã nhận tiền · đã chốt · giá) — xem hội thoại chuyển người và lời dặn liên quan.",
  },
  UPSELL_ACCEPTED_BUT_REASKED: {
    label: "Khách đồng ý lời mời một món («Ok», 👍) mà bot hỏi lại / bắt nhắn tên món",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/short-accept.ts",
    action: "Xem hội thoại: lời mời có đúng một món + giá thì «Ok» là đồng ý — bot phải thêm món, không hỏi lại (P0 21/10/2026).",
  },
  UPSELL_ACCEPTED_NOT_ATTACHED: {
    label: "Khách đồng ý lời mời một món mà món không vào đơn",
    unit: "MESSAGE",
    source: "lib/sales-chatbot/short-accept.ts",
    action: "Mở đơn của hội thoại: khách đã đồng ý mua thêm mà đơn chưa có món — thêm món / gọi lại khách xác nhận.",
  },
  ADDRESS_RECEIVED_BUT_NOT_APPLIED: {
    label: "Khách đã cho phường / địa chỉ mà đơn vẫn «cần kiểm địa chỉ»",
    unit: "CONVERSATION",
    source: "lib/address/customer-address.ts",
    action: "Đơn bot chốt mang cờ «địa chỉ chưa ghép» trong khi đơn đã có xã / phường hoặc tin khách đã nêu phường của đúng địa chỉ — mở hàng «Cần người kiểm», chọn xã rồi xác nhận; báo kỹ thuật nếu lặp lại (luật ghép phường lọt ca).",
  },
};

/** Job chỉ chạy từ giờ này (giờ Việt Nam) — đếm NGÀY HÔM QUA trọn vẹn, báo trước giờ làm việc. Không phải ngưỡng đạt / không đạt. */
export const SALES_QUALITY_FROM_HOUR_VN = 7;
/** Trần hội thoại đọc mỗi lượt — đủ cho một shop một ngày, có trần để không quét vô hạn. */
export const SALES_QUALITY_MAX_CONVERSATIONS = 5000;
/** Lượt lỗi được thử lại tối đa chừng này lần / ngày (nhịp 5 phút của job giám sát). */
export const SALES_QUALITY_MAX_ATTEMPTS = 3;
/** Số mã hội thoại BĂM in trong một việc. */
export const SALES_QUALITY_SAMPLE_HASHES = 10;
/** Khoá settings ghi lượt đã chạy của ngày (chặn chạy lại mỗi 5 phút) + số đếm từng mã, kể cả 0. */
export const SALES_QUALITY_STATE_KEY = "sales-quality.daily";

const VN_OFFSET_MS = 7 * 3_600_000;

/** Ngày giờ Việt Nam (UTC+7) của một mốc. HÀM THUẦN. */
export function vnDayOf(at: Date): string {
  return new Date(at.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Kỳ đếm: TRỌN ngày giờ Việt Nam ngay trước ngày của `now` — [00:00, 24:00) giờ VN. HÀM THUẦN. */
export function salesQualityWindow(now: Date): { day: string; from: Date; to: Date } {
  const todayStartVn = Date.parse(`${vnDayOf(now)}T00:00:00Z`) - VN_OFFSET_MS;
  const from = new Date(todayStartVn - 86_400_000);
  return { day: vnDayOf(from), from, to: new Date(todayStartVn) };
}

/** Đã tới giờ chạy chưa (giờ Việt Nam). HÀM THUẦN. */
export const salesQualityDue = (now: Date) => new Date(now.getTime() + VN_OFFSET_MS).getUTCHours() >= SALES_QUALITY_FROM_HOUR_VN;

export const salesQualityDedupeKey = (code: SalesQualityCode, day: string) => `sales-quality:${code}:${day}`;
