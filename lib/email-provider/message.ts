import { createHash } from "node:crypto";
import type { OutgoingEmail } from "@/lib/email-provider/types";
import type { EmailSettings } from "@/lib/wholesale/email-constants";

/**
 * ═══════════ DỰNG MỘT THƯ — TIÊU ĐỀ, CHÂN THƯ, HUỶ ĐĂNG KÝ (E1) ═══════════
 *
 * Mọi thư rời ERP đều đi qua `buildOutgoingEmail`, nên không có đường nào gửi được một thư thiếu link huỷ đăng ký hay thiếu
 * danh tính người gửi:
 *  · `Message-ID` tất định theo id thư (`<wsm-<id>@<tên miền gửi>>`) — gửi lại cùng một thư mang cùng một Message-ID, nên
 *    phía nhận / bộ đọc phản hồi nhận ra đó là một thư, không phải hai.
 *  · Thư nhắc (bước ≥ 1) mang `In-Reply-To` + `References` của các thư trước trong cùng luồng (RFC 5322 §3.6.4).
 *  · `List-Unsubscribe: <https://…>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058): hộp thư lớn hiện nút
 *    «Huỷ đăng ký» và gọi POST một-chạm không cần người mở trang. (RFC 8058 còn đòi chữ ký DKIM phủ hai tiêu đề này — việc
 *    của nhà cung cấp thật khi có tên miền; chạy thử không ký.)
 *  · Chân thư: tên doanh nghiệp + địa chỉ thật + lý do nhận thư + link huỷ (CAN-SPAM; NĐ 91/2020 về chống tin rác).
 *  · Tiêu đề mang nhãn quảng cáo `[QC]` — theo cách hiểu NĐ 91/2020 cho thư quảng cáo; luật sư chưa thẩm định.
 */

/** Nhãn quảng cáo đầu tiêu đề (NĐ 91/2020 — cách hiểu kỹ thuật, chờ luật sư xác nhận). */
export const EMAIL_ADVERTISING_SUBJECT_PREFIX = "[QC] ";

/** Bỏ ký tự xuống dòng / điều khiển khỏi giá trị tiêu đề — chặn chèn tiêu đề (header injection). */
export function headerSafe(v: string): string {
  return v.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
}

/** Tên miền gửi dùng trong Message-ID: phần sau `@` của email người gửi; chưa khai ⇒ tên miền dành riêng `.invalid` (RFC 2606). */
export function senderDomainOf(sender: EmailSettings["sender"]): string {
  const at = sender.email.lastIndexOf("@");
  const d = at > 0 ? sender.email.slice(at + 1).toLowerCase() : "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : "wholesale-email.invalid";
}

export function messageIdFor(outboxId: string, domain: string): string {
  return `<wsm-${outboxId.replace(/[^A-Za-z0-9_-]/g, "")}@${domain}>`;
}

/** Băm nội dung đem duyệt: người nhận + tiêu đề + thân. Sửa một ký tự sau khi duyệt ⇒ băm khác ⇒ cổng đòi duyệt lại. */
export function emailContentHash(toEmail: string, subject: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([toEmail, subject, body]), "utf8").digest("hex");
}

/** Hai tiêu đề huỷ đăng ký theo RFC 8058. Link phải là https (http chỉ cho máy dev). */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${headerSafe(url)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

export function emailFooter(sender: EmailSettings["sender"], unsubscribeUrl: string): string {
  return [
    "--",
    sender.companyName,
    sender.address,
    `Anh/chị nhận thư này vì đã đồng ý nhận thông tin bán sỉ từ ${sender.companyName}.`,
    `Không muốn nhận thêm thư? Huỷ đăng ký một chạm: ${unsubscribeUrl}`,
  ].join("\n");
}

export type BuildEmailInput = {
  outboxId: string;
  sender: EmailSettings["sender"];
  to: string;
  subject: string;
  body: string;
  unsubscribeUrl: string;
  idempotencyKey: string;
  /** Message-ID các thư TRƯỚC trong cùng luồng, cũ → mới. Rỗng ⇒ thư mở đầu. */
  threadMessageIds: readonly string[];
};

export function buildOutgoingEmail(i: BuildEmailInput): OutgoingEmail {
  const domain = senderDomainOf(i.sender);
  const subjectRaw = headerSafe(i.subject);
  const subject = subjectRaw.startsWith(EMAIL_ADVERTISING_SUBJECT_PREFIX.trim()) ? subjectRaw : `${EMAIL_ADVERTISING_SUBJECT_PREFIX}${subjectRaw}`;
  const headers: Record<string, string> = { "Message-ID": messageIdFor(i.outboxId, domain), ...listUnsubscribeHeaders(i.unsubscribeUrl) };
  const prior = i.threadMessageIds.map(headerSafe).filter(Boolean);
  if (prior.length) {
    headers["In-Reply-To"] = prior[prior.length - 1]!;
    headers.References = prior.join(" ");
  }
  return {
    from: { name: headerSafe(i.sender.name), email: headerSafe(i.sender.email) },
    to: headerSafe(i.to),
    subject,
    text: `${i.body.trim()}\n\n${emailFooter(i.sender, i.unsubscribeUrl)}\n`,
    headers,
    idempotencyKey: i.idempotencyKey,
  };
}
