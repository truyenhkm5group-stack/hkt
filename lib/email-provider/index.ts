import { DryRunEmailProvider } from "@/lib/email-provider/dry-run";
import { resolveLiveEmailProvider } from "@/lib/email-provider/live";
import type { EmailProvider } from "@/lib/email-provider/types";
import type { SmtpTransportFactory } from "@/lib/integrations/gws-smtp/client";
import type { EmailMode } from "@/lib/wholesale/email-constants";

/**
 * Chọn nhà cung cấp theo chế độ. DRY_RUN ⇒ nhà cung cấp chạy thử (không mạng). LIVE ⇒ kết nối «Google Workspace — gửi email»
 * của tổ chức (`resolveLiveEmailProvider`); chưa bật ⇒ `null` + lý do. Cổng chính sách vẫn là lớp quyết định; trả `null` là lớp
 * chặn thứ hai — mọi nhánh lỗi rơi về phía HẸP, không bao giờ rơi về chạy thử mà vẫn báo «đã gửi thật».
 */
export async function resolveEmailProvider(mode: EmailMode, deps: { smtpTransport?: SmtpTransportFactory } = {}): Promise<{ provider: EmailProvider | null; reason: string | null }> {
  if (mode === "DRY_RUN") return { provider: new DryRunEmailProvider(), reason: null };
  if (mode === "LIVE") return resolveLiveEmailProvider(deps);
  return { provider: null, reason: "Email của tổ chức đang TẮT." };
}

export { DryRunEmailProvider } from "@/lib/email-provider/dry-run";
export { EmailSendError, type EmailProvider, type EmailSendResult, type OutgoingEmail } from "@/lib/email-provider/types";
