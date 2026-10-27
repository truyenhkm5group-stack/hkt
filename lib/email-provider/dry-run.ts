import { randomBytes } from "node:crypto";
import type { EmailProvider, EmailSendResult, OutgoingEmail } from "@/lib/email-provider/types";

/**
 * Nhà cung cấp CHẠY THỬ: KHÔNG gọi mạng, không mở socket, không đọc biến môi trường. Trả mã giả có tiền tố `dryrun-` để
 * không ai nhầm nó với mã của một nhà cung cấp thật khi đọc sổ. Hàng đợi ghi sự kiện SENT với `meta.mode = "DRY_RUN"`.
 *
 * `sent` giữ thư đã "gửi" trong bộ nhớ của CHÍNH đối tượng này (không phải biến toàn cục) — bài kiểm đọc lại tiêu đề / thân
 * thật đã dựng. Mỗi lượt job tạo một đối tượng mới nên mảng không phình theo thời gian.
 */
export class DryRunEmailProvider implements EmailProvider {
  readonly name = "dry-run";
  readonly mode = "DRY_RUN" as const;
  readonly sent: OutgoingEmail[] = [];

  async send(msg: OutgoingEmail): Promise<EmailSendResult> {
    this.sent.push(msg);
    return { providerMessageId: `dryrun-${randomBytes(12).toString("hex")}`, messageIdHeader: msg.headers["Message-ID"] ?? "" };
  }
}
