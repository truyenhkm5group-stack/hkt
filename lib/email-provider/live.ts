import { openActiveConnection } from "@/lib/connectors/service";
import { defaultSmtpTransport, GwsSmtpProvider, smtpCredentialsOf, type SmtpTransportFactory } from "@/lib/integrations/gws-smtp/client";
import type { EmailProvider } from "@/lib/email-provider/types";

/**
 * Nhà cung cấp GỬI THẬT của tổ chức đang chạy (E2). Hôm nay chỉ có MỘT: Google Workspace SMTP (connector `gws-smtp`). Kết nối
 * chưa lưu / chưa kiểm tra đạt / chưa bật / không giải mã được ⇒ `provider: null` kèm lý do — hàng đợi giữ thư lại và in lý do,
 * KHÔNG BAO GIỜ rơi về chạy thử mà vẫn báo «đã gửi thật».
 */
export async function resolveLiveEmailProvider(deps: { smtpTransport?: SmtpTransportFactory } = {}): Promise<{ provider: EmailProvider | null; reason: string | null }> {
  const conn = await openActiveConnection("gws-smtp");
  if (!conn.ok) return { provider: null, reason: conn.reason };
  const creds = smtpCredentialsOf(conn.secrets, conn.settings);
  if ("error" in creds) return { provider: null, reason: creds.error };
  return { provider: new GwsSmtpProvider(creds, deps.smtpTransport ?? defaultSmtpTransport), reason: null };
}
