import { createHmac } from "node:crypto";

type LarkResult = { ok: boolean; error?: string };

/** Gửi một phong bì tới Custom Bot: ký (nếu có khoá), đọc `code` trong phản hồi — không tin HTTP status. */
async function postToLark(webhookUrl: string, secret: string, body: Record<string, unknown>): Promise<LarkResult> {
  if (!webhookUrl) return { ok: false, error: "Chưa cấu hình Lark webhook" };
  try {
    const payload: Record<string, unknown> = { ...body };
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
    }
    const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string };
    const code = data.code ?? data.StatusCode ?? (res.ok ? 0 : res.status);
    if (code !== 0) return { ok: false, error: data.msg || data.StatusMessage || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Gửi tin nhắn vào nhóm Lark Suite qua Custom Bot (Nhóm → Cài đặt → Bots → Thêm bot tuỳ chỉnh → Webhook URL, tuỳ chọn Signature).
 * Dùng msg_type "post" (văn bản có liên kết). Trả về { ok:false, error } nếu chưa cấu hình hoặc Lark từ chối.
 */
export async function sendLark(webhookUrl: string, secret: string, title: string, lines: { text: string; href?: string }[][]): Promise<LarkResult> {
  return postToLark(webhookUrl, secret, {
    msg_type: "post",
    content: {
      post: {
        vi_vn: {
          title,
          content: lines.map((line) => line.map((part) => (part.href ? { tag: "a", text: part.text, href: part.href } : { tag: "text", text: part.text }))),
        },
      },
    },
  });
}

/**
 * Gửi THẺ TƯƠNG TÁC (msg_type "interactive") — dùng khi nội dung là một BẢNG: thẻ Lark có thành phần
 * `table` với tiêu đề cột và phân trang, thứ mà tin "post" không làm được.
 */
export async function sendLarkCard(webhookUrl: string, secret: string, card: Record<string, unknown>): Promise<LarkResult> {
  return postToLark(webhookUrl, secret, { msg_type: "interactive", card });
}
