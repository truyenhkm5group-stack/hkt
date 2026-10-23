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
  // Hàng rào giá trị đơn (P0 22/10/2026, đơn HSLC #8037F35A — lib/constants/sales-order-guard.ts): bốn lần CHẶN trước khi ghi + tổng lệch.
  "QUANTITY_UNIT_AMBIGUOUS",
  "PACK_MULTIPLIER_MISMATCH",
  "CART_TOTAL_CONFLICT",
  "STAFF_AI_QUOTE_CONFLICT",
  "ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT",
  // «Lọt tới khách» của hàng rào số lượng / đơn vị: đơn ĐÃ GHI số hộp = số cái khách nói (sổ tái diễn regression-reopen-watch đọc mã này).
  "PACK_MULTIPLIER_LEAKED",
  // Xin LẶP SĐT / địa chỉ / tên khách CHƯA từng cho (tách khỏi ADDRESS_REASK 23/10/2026). KHÔNG nối vào sổ tái diễn.
  "REPEAT_ASK_UNANSWERED",
] as const;
export type SalesQualityCode = (typeof SALES_QUALITY_CODES)[number];

export type SalesQualitySpec = {
  /** Nhãn ngắn trên /work. */
  label: string;
  /** Đơn vị đếm: một TIN bot sai, hay một HỘI THOẠI đang ở tình trạng sai (ảnh chụp lúc chạy). */
  unit: "MESSAGE" | "CONVERSATION";
  /**
   * Lỗi đã THÀNH SỰ THẬT hay đã bị CHẶN (sổ tái diễn — lib/constants/regression-watch.ts, 22/10/2026):
   *  · `REACHED_CUSTOMER` — không gì chặn: tin sai đã tới khách, hoặc đơn / hội thoại đã ở tình trạng sai. Sau bản sửa mà còn ⇒ TÁI DIỄN.
   *  · `BLOCKED_PRE_SEND` — hàng rào đã chặn TRƯỚC khi gửi / ghi. Đếm > 0 là bằng chứng bản sửa đang chạy, KHÔNG BAO GIỜ là tái diễn.
   */
  delivery: "REACHED_CUSTOMER" | "BLOCKED_PRE_SEND";
  /** Hàm định nghĩa (luật sống) — kiểm thử mở đúng tệp này. */
  source: string;
  /** Việc phải làm, đủ cụ thể để người đọc biết mở trang nào. */
  action: string;
  /**
   * Ngày (YYYY-MM-DD, giờ VN) định nghĩa của mã ĐỔI mà khoá giữ nguyên. Các ngày từ mốc này trở đi đếm theo định nghĩa mới — KHÔNG so
   * xu hướng qua mốc (AGENTS 40); tin việc của 7 ngày đầu in `definitionNote`.
   */
  definitionChangedAt?: string;
  definitionNote?: string;
};

export const SALES_QUALITY_SPEC: Record<SalesQualityCode, SalesQualitySpec> = {
  HANDOFF_UNANSWERED: {
    label: "Khách chờ người quá hạn, chưa ai trả lời",
    unit: "CONVERSATION",
    delivery: "REACHED_CUSTOMER",
    source: "lib/constants/handoff-reply.ts",
    action: "Mở hộp thư lọc «chờ người», trả lời từ khách chờ lâu nhất; hạn đọc từ work.sla (SALES_CHAT_HANDOFF).",
  },
  QTY_REASKED: {
    label: "Khách đã chọn số lượng mà bot hỏi lại / gửi lại câu cũ",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/round-check.ts",
    action: "Xem câu mẫu / lời dặn hỏi số lượng: khách đã trả lời «2kg», «lấy 2» thì câu kế phải đi tiếp bước chốt.",
  },
  SECONDARY_INTENT_UNANSWERED: {
    label: "Khách hỏi thời gian giao kèm số lượng mà bot bỏ qua",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/delivery-intent.ts",
    action: "Bổ sung câu trả lời thời gian giao (kiến thức shop / câu mẫu giao hàng) để bot trả lời cả hai ý.",
  },
  WRONG_PRODUCT_TEMPLATE: {
    label: "Câu mẫu nói về món KHÁC món khách đang hỏi",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/quick-reply-focus.ts",
    action: "Mở Câu mẫu, sửa từ khoá kích hoạt / gắn đúng sản phẩm cho câu mẫu bị gửi nhầm món.",
  },
  // KHOÁ LƯU giữ nguyên `ADDRESS_REASK` (dedupe `sales-quality:<mã>:<ngày>` + notifications đang dùng — Tech Lead 22/10/2026). Đây là
  // hiện tượng KNOWN_ADDRESS_REASKED (hỏi lại phần địa chỉ / SĐT / tên đã biết), RỘNG HƠN dòng L KNOWN_CUSTOMER_ADDRESS_REASK của
  // scripts/conv-money-trace.ts (chỉ khách CŨ có đơn nối chắc). Một hiện tượng, một mã.
  ADDRESS_REASK: {
    label: "Bot hỏi lại địa chỉ / SĐT khách đã cho (KNOWN_ADDRESS_REASKED)",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/address-memory.ts",
    action: "Câu hỏi lại đã lọt qua hàng rào hỏi-lại — xem câu mẫu / lời dặn xin địa chỉ đang gửi ở bước chốt.",
    definitionChangedAt: "2026-10-23",
    definitionNote:
      "Định nghĩa đổi 23/10/2026: thêm vế AGENTS 3.12b (khách đã gửi chữ địa chỉ mà bot hỏi bất kỳ phần nào); xin lặp thứ khách CHƯA cho tách sang REPEAT_ASK_UNANSWERED — không so xu hướng với các ngày trước mốc này.",
  },
  COMPLAINT_WHILE_SELLING: {
    label: "Khách đang phàn nàn mà bot mời mua thêm",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/lifecycle.ts",
    action: "Xem câu mẫu mời mua thêm đang bật: khách phàn nàn thì xử lý khiếu nại trước, không mời mua.",
  },
  CLARIFY_FALLBACK: {
    label: "Bot gửi câu dự phòng «nói rõ hơn»",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/engine.ts",
    action: "Lượt model không ra câu nào gửi khách — xem lỗi lượt AI / độ dài lời dặn; khách nhận một câu không trả lời gì.",
  },
  // KHÔNG gồm câu ghi nhận `ORDER_RECEIVED` («Dạ em đã ghi nhận đơn của mình ạ.»): từ 22/10/2026 đó là câu THƯỜNG của mọi đơn tự chốt khi
  // địa chỉ chờ xác minh nội bộ (chủ shop: xác minh độc lập với upsell), không phải một lần hàng rào chặn khẳng định.
  CLAIM_GUARD_BLOCK: {
    label: "Hàng rào khẳng định thay câu của bot bằng câu an toàn",
    unit: "MESSAGE",
    delivery: "BLOCKED_PRE_SEND",
    source: "lib/sales-chatbot/claim-guard.ts",
    action: "Bot định khẳng định điều chưa có chứng từ (đã nhận tiền · đã chốt · giá) — xem hội thoại chuyển người và lời dặn liên quan.",
  },
  UPSELL_ACCEPTED_BUT_REASKED: {
    label: "Khách đồng ý lời mời một món («Ok», 👍) mà bot hỏi lại / bắt nhắn tên món",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/short-accept.ts",
    action: "Xem hội thoại: lời mời có đúng một món + giá thì «Ok» là đồng ý — bot phải thêm món, không hỏi lại (P0 21/10/2026).",
  },
  UPSELL_ACCEPTED_NOT_ATTACHED: {
    label: "Khách đồng ý lời mời một món mà món không vào đơn",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/short-accept.ts",
    action: "Mở đơn của hội thoại: khách đã đồng ý mua thêm mà đơn chưa có món — thêm món / gọi lại khách xác nhận.",
  },
  ADDRESS_RECEIVED_BUT_NOT_APPLIED: {
    label: "Khách đã cho phường / địa chỉ mà đơn vẫn «cần kiểm địa chỉ»",
    unit: "CONVERSATION",
    delivery: "REACHED_CUSTOMER",
    source: "lib/address/customer-address.ts",
    action: "Đơn bot chốt mang cờ «địa chỉ chưa ghép» trong khi đơn đã có xã / phường hoặc tin khách đã nêu phường của đúng địa chỉ — mở hàng «Cần người kiểm», chọn xã rồi xác nhận; báo kỹ thuật nếu lặp lại (luật ghép phường lọt ca).",
  },
  QUANTITY_UNIT_AMBIGUOUS: {
    label: "Khách nói số không kèm đơn vị, không quy được ra số hộp — đã chặn ghi đơn",
    unit: "MESSAGE",
    delivery: "BLOCKED_PRE_SEND",
    source: "lib/sales-chatbot/cart-commitment.ts",
    action: "Xem quy cách mẫu mã («Hộp 10 cái») và câu mời: khách hay nói số cái thì câu mời ghi rõ «1 hộp 10 cái» để khách trả lời bằng hộp.",
  },
  PACK_MULTIPLIER_MISMATCH: {
    label: "Đơn đề nghị sai bội quy cách hộp (10 cái ⇒ 10 hộp) — đã chặn ghi đơn",
    unit: "MESSAGE",
    delivery: "BLOCKED_PRE_SEND",
    source: "lib/sales-chatbot/cart-commitment.ts",
    action: "Mở hội thoại: model đọc số cái thành số hộp; kiểm tên mẫu mã có ghi số cái mỗi hộp, đơn đã chốt thì nhân viên xác nhận lại với khách.",
  },
  CART_TOTAL_CONFLICT: {
    label: "Sửa đơn đã chốt mà tổng tăng bất thường — đã chặn, chuyển người",
    unit: "MESSAGE",
    delivery: "BLOCKED_PRE_SEND",
    source: "lib/constants/sales-order-guard.ts",
    action: "Mở đơn của hội thoại, đối chiếu món / số lượng với khách rồi mới sửa; ngưỡng ở CONFIRMED_EDIT_MAX_GROWTH.",
  },
  STAFF_AI_QUOTE_CONFLICT: {
    label: "Tổng bot báo khác tổng nhân viên / page báo trong cùng hội thoại",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/cancel-recovery.ts",
    action: "Mở hội thoại: hai con số tổng tới tay khách — xác định số đúng theo đơn ERP, nhắn khách MỘT tổng, sửa nguồn sai (câu tự động Pancake / đơn POS).",
  },
  ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT: {
    label: "Bot đề nghị tăng đơn đã chốt khi khách chưa nói số lượng — đã chặn, chuyển người",
    unit: "MESSAGE",
    delivery: "BLOCKED_PRE_SEND",
    source: "lib/sales-chatbot/tools.ts",
    action: "Mở hội thoại: khách chưa nói lấy thêm bao nhiêu mà bot định sửa đơn đã chốt — nhân viên hỏi khách rồi mới sửa.",
  },
  PACK_MULTIPLIER_LEAKED: {
    label: "Đơn ĐÃ GHI số hộp bằng số cái khách nói (10 nem ⇒ 10 hộp) — lọt qua hàng rào số lượng / đơn vị tới khách",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-quality/detectors.ts",
    action: "Mở đơn của hội thoại NGAY: số hộp có thể gấp N lần ý khách — sửa về đúng số hộp (số cái / quy cách), báo khách tổng mới; báo kỹ thuật vì hàng rào sales-qty-unit-guard đã để lọt.",
  },
  REPEAT_ASK_UNANSWERED: {
    label: "Bot xin lặp SĐT / địa chỉ khách chưa từng cho (khách chưa trả lời lần trước)",
    unit: "MESSAGE",
    delivery: "REACHED_CUSTOMER",
    source: "lib/sales-chatbot/address-memory.ts",
    action: "Xem tin theo dõi / câu hỏi lặp: khách chưa trả lời lần trước — cân nhắc giãn nhịp theo dõi hoặc chuyển người, KHÔNG phải lỗi hỏi lại thứ đã cho.",
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
