import nodemailer from "nodemailer";
import { EmailSendError, type EmailProvider, type EmailSendResult, type OutgoingEmail } from "@/lib/email-provider/types";

/**
 * ═══════════ GOOGLE WORKSPACE SMTP — ADAPTER GỬI THẬT ĐẦU TIÊN (E2, connector `gws-smtp`) ═══════════
 *
 * Chủ shop chốt 30/10/2026: gửi bằng hộp thư Google Workspace của tên miền vnxcommerce.com (MX = Google Workspace, SPF có
 * `include:_spf.google.com`). Đường gửi: `smtp.gmail.com:587`, STARTTLS BẮT BUỘC (`requireTLS` — máy chủ không nâng TLS thì
 * không gửi mật khẩu), đăng nhập bằng App Password của chính hộp thư. Thư viện `nodemailer` (chủ shop duyệt thêm phụ thuộc).
 *
 *  · Thông tin đăng nhập do CHỦ SHOP nhập ở Cài đặt → Kết nối dữ liệu, lưu mã hoá trong `org_connections` của tổ chức. Tệp này
 *    KHÔNG đọc biến môi trường, KHÔNG ghi log, và mọi câu lỗi trả ra đều đã che App Password.
 *  · Kiểm tra kết nối = `verify()` (EHLO → STARTTLS → AUTH), KHÔNG gửi thư nào.
 *  · Adapter KHÔNG quyết định gửi hay không: chỉ nhận thư đã qua cổng chính sách và đã dựng tiêu đề (Message-ID ổn định,
 *    List-Unsubscribe + List-Unsubscribe-Post theo RFC 8058) ở `lib/email-provider/message.ts`.
 *  · From LUÔN là hộp thư đã đăng nhập — Gmail tự đổi From lạ thành hộp thư đăng nhập; để máy tự đổi là để Message-ID và
 *    địa chỉ trả lời lệch nhau. Tên hiển thị lấy theo danh tính người gửi đã khai.
 */

export const GWS_SMTP_HOST = "smtp.gmail.com";
export const GWS_SMTP_PORT = 587;
export const GWS_SMTP_PROVIDER = "gws-smtp";

/** App Password của Google: 16 chữ thường, Google hiển thị thành 4 cụm có khoảng trắng — bỏ khoảng trắng trước khi dùng. */
export const GWS_APP_PASSWORD_PATTERN = /^[a-z]{16}$/;
const MAILBOX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeAppPassword(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").toLowerCase();
}

export function normalizeMailbox(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return MAILBOX_RE.test(v) ? v : null;
}

/** Phần nhỏ của nodemailer mà ERP dùng — bài kiểm tiêm bản giả, không mở socket thật. */
export type SmtpTransportLike = {
  verify(): Promise<unknown>;
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string; response?: string; accepted?: unknown[]; rejected?: unknown[] }>;
  close?(): void;
};
export type SmtpTransportFactory = (opts: { host: string; port: number; user: string; pass: string }) => SmtpTransportLike;

export const defaultSmtpTransport: SmtpTransportFactory = (o) =>
  nodemailer.createTransport({
    host: o.host,
    port: o.port,
    secure: false,
    requireTLS: true,
    auth: { user: o.user, pass: o.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { servername: o.host, minVersion: "TLSv1.2" },
  }) as unknown as SmtpTransportLike;

export type SmtpCredentials = { user: string; pass: string };

/** Đọc + kiểm dạng bí mật đã giải mã. Sai dạng ⇒ câu lỗi (không chứa giá trị). */
export function smtpCredentialsOf(secrets: Record<string, string>, settings: Record<string, string>): SmtpCredentials | { error: string } {
  const user = normalizeMailbox(settings.mailbox ?? secrets.mailbox);
  if (!user) return { error: "Thiếu địa chỉ hộp thư hợp lệ (vd truyenhk@vnxcommerce.com)." };
  const pass = normalizeAppPassword(secrets.appPassword);
  if (!GWS_APP_PASSWORD_PATTERN.test(pass)) return { error: "App Password phải là 16 chữ cái Google cấp (myaccount.google.com → Bảo mật → Mật khẩu ứng dụng) — không phải mật khẩu đăng nhập." };
  return { user, pass };
}

/** Che mọi lần xuất hiện của bí mật trong một câu (kể cả dạng có khoảng trắng của Google). */
export function maskSecret(text: string, pass: string): string {
  if (!pass) return text;
  let out = text.split(pass).join("••••");
  const spaced = pass.match(/.{1,4}/g)?.join(" ");
  if (spaced) out = out.split(spaced).join("••••");
  return out;
}

type SmtpErrorLike = { code?: string; responseCode?: number; command?: string; message?: string };

/**
 * Phân loại lỗi SMTP. HÀM THUẦN.
 *  · AUTH (535 / EAUTH): sai hộp thư / App Password hoặc tài khoản chưa bật xác minh 2 bước — mọi thư đều sẽ hỏng như nhau,
 *    nên lượt gửi DỪNG (không đốt hết lô) và thư nằm lại hàng đợi chờ sửa kết nối.
 *  · TẠM: 4xx, mất kết nối, hết giờ, TLS — thử lại có lùi dần.
 *  · VĨNH VIỄN: 5xx khác (địa chỉ nhận bị từ chối, nội dung bị chặn) — FAILED.
 */
export function classifySmtpError(e: unknown): { kind: "AUTH" | "TRANSIENT" | "PERMANENT"; code: string } {
  const x = (e ?? {}) as SmtpErrorLike;
  const rc = typeof x.responseCode === "number" ? x.responseCode : null;
  if (x.code === "EAUTH" || rc === 535 || rc === 534 || rc === 530) return { kind: "AUTH", code: x.code ?? String(rc) };
  if (rc !== null && rc >= 400 && rc < 500) return { kind: "TRANSIENT", code: String(rc) };
  if (rc !== null && rc >= 500) return { kind: "PERMANENT", code: String(rc) };
  return { kind: "TRANSIENT", code: x.code ?? "UNKNOWN" };
}

const AUTH_HINT = "Google từ chối đăng nhập — kiểm hộp thư, App Password (16 chữ), và tài khoản đã bật Xác minh 2 bước.";

/** Kiểm tra kết nối: EHLO → STARTTLS → AUTH, không gửi thư. Trả câu đã che bí mật. */
export async function verifySmtp(creds: SmtpCredentials, factory: SmtpTransportFactory = defaultSmtpTransport): Promise<{ ok: boolean; message: string }> {
  const t = factory({ host: GWS_SMTP_HOST, port: GWS_SMTP_PORT, user: creds.user, pass: creds.pass });
  try {
    await t.verify();
    return { ok: true, message: `Đăng nhập ${GWS_SMTP_HOST}:${GWS_SMTP_PORT} (STARTTLS) bằng ${creds.user} thành công — chưa gửi thư nào. Bật kết nối, rồi chủ shop chuyển chế độ email sang «Gửi thật» khi đã thêm DKIM + DMARC cho tên miền.` };
  } catch (e) {
    const c = classifySmtpError(e);
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, message: c.kind === "AUTH" ? AUTH_HINT : maskSecret(`Không kết nối được ${GWS_SMTP_HOST}:${GWS_SMTP_PORT} (${c.code}): ${raw.slice(0, 200)}`, creds.pass) };
  } finally {
    t.close?.();
  }
}

/** Lỗi gửi kèm cờ DỪNG LÔ (hỏng đăng nhập ⇒ mọi thư sau cũng hỏng). */
export class SmtpBatchStopError extends EmailSendError {
  readonly stopBatch = true;
}

export class GwsSmtpProvider implements EmailProvider {
  readonly name = GWS_SMTP_PROVIDER;
  readonly mode = "LIVE" as const;
  private readonly transport: SmtpTransportLike;

  constructor(
    private readonly creds: SmtpCredentials,
    factory: SmtpTransportFactory = defaultSmtpTransport,
  ) {
    this.transport = factory({ host: GWS_SMTP_HOST, port: GWS_SMTP_PORT, user: creds.user, pass: creds.pass });
  }

  async send(msg: OutgoingEmail): Promise<EmailSendResult> {
    const messageId = msg.headers["Message-ID"];
    if (!messageId) throw new EmailSendError("Thư thiếu Message-ID — không gửi (luồng trả lời sẽ không nối được).", false);
    if (!msg.headers["List-Unsubscribe"] || msg.headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click") throw new EmailSendError("Thư thiếu tiêu đề huỷ đăng ký RFC 8058 — không gửi.", false);
    const extra: Record<string, string> = { "List-Unsubscribe": msg.headers["List-Unsubscribe"], "List-Unsubscribe-Post": msg.headers["List-Unsubscribe-Post"] };
    try {
      const info = await this.transport.sendMail({
        from: { name: msg.from.name, address: this.creds.user },
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        messageId,
        ...(msg.headers["In-Reply-To"] ? { inReplyTo: msg.headers["In-Reply-To"] } : {}),
        ...(msg.headers.References ? { references: msg.headers.References } : {}),
        headers: extra,
        envelope: { from: this.creds.user, to: msg.to },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { providerMessageId: (info.messageId || messageId).slice(0, 300), messageIdHeader: messageId };
    } catch (e) {
      const c = classifySmtpError(e);
      const raw = maskSecret(e instanceof Error ? e.message : String(e), this.creds.pass).slice(0, 300);
      if (c.kind === "AUTH") throw new SmtpBatchStopError(`${AUTH_HINT} (${c.code})`, true);
      throw new EmailSendError(`SMTP ${c.code}: ${raw}`, c.kind === "TRANSIENT");
    }
  }

  close(): void {
    this.transport.close?.();
  }
}
