import { DryRunEmailProvider } from "@/lib/email-provider/dry-run";
import type { EmailProvider } from "@/lib/email-provider/types";
import type { EmailMode } from "@/lib/wholesale/email-constants";

/**
 * Chọn nhà cung cấp theo chế độ. LIVE ⇒ `null`: chưa có bộ chuyển thật nào (`LIVE_EMAIL_ADAPTERS` rỗng). Cổng chính sách đã
 * chặn LIVE trước khi tới đây; trả `null` là lớp chặn thứ hai — mọi nhánh lỗi rơi về phía HẸP, không bao giờ rơi về chạy thử
 * mà vẫn báo «đã gửi thật».
 */
export function resolveEmailProvider(mode: EmailMode): EmailProvider | null {
  if (mode === "DRY_RUN") return new DryRunEmailProvider();
  return null;
}

export { DryRunEmailProvider } from "@/lib/email-provider/dry-run";
export { EmailSendError, type EmailProvider, type EmailSendResult, type OutgoingEmail } from "@/lib/email-provider/types";
