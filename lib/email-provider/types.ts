/**
 * ═══════════ LỚP NHÀ CUNG CẤP EMAIL — HỢP ĐỒNG (E1) ═══════════
 *
 * Mọi nhà cung cấp (chạy thử hôm nay; SES / Resend / Gmail khi chủ shop chọn) cài cùng MỘT giao diện, nên hàng đợi và cổng
 * chính sách không đổi khi thêm nhà cung cấp. Nhà cung cấp KHÔNG quyết định được gửi hay không — đó là việc của cổng
 * (`lib/wholesale/email-policy.ts`); nó chỉ nhận một thư ĐÃ dựng xong (tiêu đề + thân + chân thư) và đưa đi.
 *
 * Vì sao KHÔNG nằm ở `lib/integrations/`: thư mục đó là sổ connector (mỗi tệp thuộc đúng một mục `CONNECTORS`, có kiểm tra kết
 * nối, khoá, trang Kết nối dữ liệu). Hôm nay chỉ có nhà cung cấp CHẠY THỬ — không có dịch vụ ngoài nào để khai. Adapter thật đầu
 * tiên (SES / Resend / Gmail) mới là một connector: nó vào `lib/integrations/<nhà cung cấp>/` + một mục sổ, và cài giao diện này.
 */

export type EmailAddress = { name: string; email: string };

/** Thư đã dựng xong, sẵn sàng giao nhà cung cấp. `headers` chỉ chứa tiêu đề CẤU TRÚC (Message-ID, luồng, huỷ đăng ký). */
export type OutgoingEmail = {
  from: EmailAddress;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  /** Khoá chống gửi trùng của hàng đợi — nhà cung cấp hỗ trợ `Idempotency-Key` thì chuyển tiếp nguyên văn. */
  idempotencyKey: string;
};

export type EmailSendResult = { providerMessageId: string; messageIdHeader: string };

export interface EmailProvider {
  /** Tên ghi vào `wholesale_email_outbox.provider`. */
  readonly name: string;
  /** Chế độ ghi vào cột `mode` và vào `meta` của sự kiện SENT. */
  readonly mode: "DRY_RUN" | "LIVE";
  send(msg: OutgoingEmail): Promise<EmailSendResult>;
}

/**
 * Lỗi của nhà cung cấp. `transient = true` (mạng, 429, 5xx) ⇒ hàng đợi thử lại có lùi dần; `false` (địa chỉ sai, bị từ chối)
 * ⇒ FAILED ngay. Lỗi không phải `EmailSendError` coi là TẠM — không biết thì không kết luận là vĩnh viễn.
 */
export class EmailSendError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "EmailSendError";
    this.transient = transient;
  }
}
