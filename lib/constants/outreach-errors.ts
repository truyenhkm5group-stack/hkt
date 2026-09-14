/**
 * ═══════════ VÌ SAO TIN KHÔNG GỬI ĐƯỢC — PHÂN LOẠI ĐỂ HÀNH ĐỘNG ═══════════
 *
 * ─── ĐO PRODUCTION 13/09/2026 ───
 *
 *   CROSS_SELL   483 chờ gửi ·  1 đã gửi · 25 LỖI · 3 bỏ qua
 *   NURTURE    1.602 chờ gửi · 58 chuyển đổi · 20 LỖI · 25 bỏ qua
 *
 *   25/25 lỗi bán chéo:  `(#10) Tin nhắn này được gửi ngoài khoảng thời gian cho phép`
 *   17 lỗi chăm sóc:     `(#551) Người này hiện không có mặt`
 *
 * ─── `#10` KHÔNG PHẢI LỖI KỸ THUẬT ───
 *
 * Đó là **chính sách cửa sổ 24 giờ của Meta**: không được nhắn cho người dùng quá 24 giờ kể từ tin
 * cuối HỌ gửi, trừ khi dùng thẻ tin nhắn được duyệt.
 *
 * Mà bán chéo theo đúng thiết kế nhắm khách đã NHẬN HÀNG vài ngày trước — tức LUÔN LUÔN nằm ngoài
 * cửa sổ. Nói cách khác: đường bán chéo qua tin nhắn thường không thể hoạt động, không phải hôm nay
 * hỏng mà là về bản chất. Không lượt thử lại nào sửa được điều đó.
 *
 * Đây là chỗ dễ sai nhất khi đọc bảng lỗi: 25 dòng đỏ trông như một sự cố cần vá, trong khi nó là
 * một giới hạn nền tảng cần một QUYẾT ĐỊNH KINH DOANH.
 *
 * ─── VÌ SAO KHÔNG TỰ BẬT THẺ `POST_PURCHASE_UPDATE` ───
 *
 * `pages.ts` đã có sẵn `sendMessageWithFallback`: gặp `#10` thì gửi lại kèm thẻ
 * `POST_PURCHASE_UPDATE`. Đường gửi chăm sóc/bán chéo CHƯA BAO GIỜ gọi hàm đó — nên về mặt kỹ
 * thuật, nối vào là "sửa" được cả 25 dòng.
 *
 * Cố ý KHÔNG nối. Thẻ đó là thẻ Meta cấp cho **cập nhật đơn hàng** của khách đã mua; gửi nội dung
 * KHUYẾN MẠI dưới thẻ ấy là lạm dụng thẻ, và cái giá khi Meta phát hiện là hạn chế hoặc khoá trang
 * — mất luôn cả kênh chăm sóc thật. Đây là quyết định của chủ shop về tài khoản của chính họ, không
 * phải thứ một bản sửa lỗi được tự quyết.
 */

export const OUTREACH_ERROR_KINDS = ["POLICY_WINDOW", "USER_UNAVAILABLE", "CONTENT_REJECTED", "NO_CONVERSATION", "TRANSIENT", "UNKNOWN"] as const;
export type OutreachErrorKind = (typeof OUTREACH_ERROR_KINDS)[number];

export type OutreachErrorSpec = {
  kind: OutreachErrorKind;
  label: string;
  /** Thử lại có ích không. `false` ⇒ nút "gửi lại" chỉ tạo thêm một dòng đỏ nữa. */
  retryable: boolean;
  /** VIỆC PHẢI LÀM, viết cho người đọc bảng — không phải cho người viết code. */
  action: string;
};

export const OUTREACH_ERROR_SPECS: Record<OutreachErrorKind, OutreachErrorSpec> = {
  POLICY_WINDOW: {
    kind: "POLICY_WINDOW",
    label: "Ngoài cửa sổ 24 giờ của Meta",
    retryable: false,
    action:
      "Meta không cho nhắn quá 24 giờ kể từ tin cuối khách gửi. Bán chéo cho khách đã nhận hàng vài ngày trước thì LUÔN rơi vào đây — thử lại không đổi gì. Lối ra: nhắn qua Zalo/SMS, hoặc chờ khách nhắn lại rồi trả lời trong 24 giờ. Dùng thẻ tin nhắn của Meta cho nội dung khuyến mại là lạm dụng thẻ và có thể bị khoá trang.",
  },
  USER_UNAVAILABLE: {
    kind: "USER_UNAVAILABLE",
    label: "Người nhận không nhận được tin",
    retryable: false,
    action: "Khách đã chặn trang, xoá tài khoản hoặc hạn chế tin nhắn. Không có cách nào nhắn qua Facebook — chuyển sang Zalo/SMS nếu có số.",
  },
  CONTENT_REJECTED: {
    kind: "CONTENT_REJECTED",
    label: "Nội dung bị từ chối",
    retryable: true,
    action: "Tin rỗng hoặc đính kèm không hợp lệ. Kiểm tra mẫu tin và đường dẫn ảnh/video rồi gửi lại.",
  },
  NO_CONVERSATION: {
    kind: "NO_CONVERSATION",
    label: "Chưa có hội thoại Pancake",
    retryable: false,
    action: "Khách chưa từng nhắn cho trang nên không có hội thoại để trả lời. Nhắn qua Zalo/SMS.",
  },
  TRANSIENT: {
    kind: "TRANSIENT",
    label: "Lỗi tạm thời",
    retryable: true,
    action: "Mạng hoặc Pancake/Meta bận. Gửi lại sau ít phút.",
  },
  UNKNOWN: {
    kind: "UNKNOWN",
    label: "Chưa phân loại",
    retryable: true,
    action: "Chưa nhận ra mã lỗi này. Đọc nguyên văn lỗi ở cột bên và báo lại để bổ sung luật phân loại.",
  },
};

/** Bỏ dấu tiếng Việt để so khớp không phụ thuộc cách gõ. */
const khongDau = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Phân loại theo NGUYÊN VĂN lỗi mà nhà cung cấp trả về.
 *
 * Mã số (`#10`, `#551`, `#100`) là căn cứ chính vì nó ổn định; câu chữ chỉ là lối vào phụ cho
 * những bản dịch không kèm mã.
 */
export function classifyOutreachError(raw: string | null | undefined): OutreachErrorSpec {
  const s = khongDau(raw ?? "");
  if (!s.trim()) return OUTREACH_ERROR_SPECS.UNKNOWN;
  if (/#10\b/.test(s) || /ngoai khoang thoi gian|outside.*allowed.*window|24 ?h/.test(s)) return OUTREACH_ERROR_SPECS.POLICY_WINDOW;
  if (/#551\b|#1545041\b/.test(s) || /khong co mat|not available|unavailable/.test(s)) return OUTREACH_ERROR_SPECS.USER_UNAVAILABLE;
  if (/#100\b/.test(s) || /bo trong tin nhan|empty message|invalid.*attachment/.test(s)) return OUTREACH_ERROR_SPECS.CONTENT_REJECTED;
  if (/khong co hoi thoai|no conversation/.test(s)) return OUTREACH_ERROR_SPECS.NO_CONVERSATION;
  if (/timeout|econn|socket|rate limit|#4\b|#613\b|http 5\d\d/.test(s)) return OUTREACH_ERROR_SPECS.TRANSIENT;
  return OUTREACH_ERROR_SPECS.UNKNOWN;
}
