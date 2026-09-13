/**
 * ═══════════ PHÂN LOẠI KHÁCH THEO KẾT QUẢ LOGISTICS THẬT ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Trang bán chéo chỉ dựng danh sách từ đơn `DELIVERED`. Khách hoàn hàng và khách đang giao đơn
 * giản là KHÔNG TỒN TẠI trên màn hình. Hệ quả:
 *
 *  · không chạy được chiến dịch phục hồi cho khách vừa hoàn — nhóm cần nói chuyện nhất;
 *  · không ai thấy tỷ lệ giữa ba nhóm, nên không ai biết danh sách bán chéo đang đại diện cho
 *    bao nhiêu phần khách hàng;
 *  · và không có chỗ nào nói "chưa biết", nên một khách thiếu chứng từ sẽ lặng lẽ bị xếp nhầm.
 *
 * ─── LUẬT PHÂN LOẠI, VIẾT RA ĐỂ KIỂM CHỨNG ĐƯỢC ───
 *
 * Grain là KHÁCH HÀNG, và mốc là **đơn gần nhất ĐÃ CÓ KẾT QUẢ**:
 *
 *   DELIVERED — đơn gần nhất có kết quả là `DELIVERED` theo `ORDER_OUTCOME`.
 *   RETURNED  — đơn gần nhất có kết quả là `RETURNED` hoặc `RETURNED_BY_RULE`.
 *   PENDING   — chưa đơn nào có kết quả cuối, và có ít nhất một đơn đang chạy.
 *   UNKNOWN   — có đơn nhưng không đơn nào cho kết luận được (thiếu chứng từ).
 *
 * ─── VÌ SAO "ĐƠN GẦN NHẤT" CHỨ KHÔNG PHẢI "TỪNG HOÀN" ───
 *
 * Một khách mua mười lần, hoàn một lần, thì họ là khách tốt — không phải "khách hoàn hàng". Lấy
 * "từng hoàn" làm nhãn sẽ dán nhãn xấu lên gần hết khách quen. Lấy đơn GẦN NHẤT trả lời đúng câu
 * mà người bán đang hỏi: *lần gần đây nhất làm việc với khách này đã kết thúc thế nào.*
 *
 * ─── HAI ĐIỀU KHÔNG ĐƯỢC LÀM ───
 *
 * KHÔNG dùng trạng thái đơn Pancake làm sự thật logistics, và KHÔNG suy "đã giao" từ COD hay bất
 * kỳ chứng từ tiền nào. Tiền và logistics là hai chiều độc lập
 * (`docs/business-rules/ORDER_OUTCOME.md`). Ở đây mọi kết luận đọc lại `ORDER_OUTCOME` đã vật chất
 * hoá trong `canonical_order_outcome` — không tính lại, không diễn giải.
 */

export const CUSTOMER_OUTCOMES = ["DELIVERED", "RETURNED", "PENDING", "UNKNOWN"] as const;
export type CustomerOutcome = (typeof CUSTOMER_OUTCOMES)[number];

export const CUSTOMER_OUTCOME_LABEL: Record<CustomerOutcome, string> = {
  DELIVERED: "Đã nhận hàng",
  RETURNED: "Đã hoàn hàng",
  PENDING: "Đang giao",
  UNKNOWN: "Chưa xác định",
};

export const CUSTOMER_OUTCOME_HINT: Record<CustomerOutcome, string> = {
  DELIVERED: "Đơn gần nhất CÓ KẾT QUẢ của khách này là giao thành công, theo chứng từ ĐVVC.",
  RETURNED: "Đơn gần nhất có kết quả là hoàn — kể cả hoàn theo luật doanh thu. Đây là nhóm cần hỏi lý do trước khi mời mua tiếp.",
  PENDING: "Chưa đơn nào của khách có kết quả cuối, và đang có đơn chạy dở.",
  UNKNOWN: "Có đơn nhưng không đơn nào kết luận được — thiếu chứng từ. KHÔNG phải 'chưa mua bao giờ'.",
};

export const CUSTOMER_OUTCOME_TONE: Record<CustomerOutcome, string> = {
  DELIVERED: "bg-success/12 text-success",
  RETURNED: "bg-destructive/10 text-destructive",
  PENDING: "bg-info/12 text-info",
  UNKNOWN: "bg-muted text-muted-foreground",
};

/**
 * ĐƯỢC PHÉP MỜI MUA TIẾP CHƯA?
 *
 * Đây là luật CHÍNH SÁCH, không phải luật dữ liệu — nên nó nằm riêng và nói rõ lý do từ chối.
 *
 * Khách đang có đơn chạy dở KHÔNG được nhận tin bán chéo: mời mua thêm trong lúc người ta còn
 * đang chờ hàng là cách nhanh nhất để bị chặn tin. Khách vừa hoàn thì cần HỎI LÝ DO trước, bằng
 * một kịch bản khác — không phải kịch bản bán chéo.
 */
export type OutreachEligibility = { allowed: boolean; campaign: "CROSS_SELL" | "RECOVERY" | null; reason: string };

export function outreachEligibility(outcome: CustomerOutcome): OutreachEligibility {
  switch (outcome) {
    case "DELIVERED":
      return { allowed: true, campaign: "CROSS_SELL", reason: "Khách đã nhận hàng — mời mua thêm là đúng lúc." };
    case "RETURNED":
      return { allowed: true, campaign: "RECOVERY", reason: "Khách vừa hoàn — hỏi lý do trước, KHÔNG dùng kịch bản bán chéo." };
    case "PENDING":
      return { allowed: false, campaign: null, reason: "Đơn còn đang chạy — mời mua thêm lúc khách chưa nhận được hàng là cách nhanh nhất để bị chặn tin." };
    case "UNKNOWN":
      return { allowed: false, campaign: null, reason: "Chưa kết luận được lần mua gần nhất — nhắn lúc này là đoán." };
  }
}
