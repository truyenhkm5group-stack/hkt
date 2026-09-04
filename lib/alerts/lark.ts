import { createHmac } from "node:crypto";

/**
 * Gửi tin nhắn vào nhóm Lark Suite qua Custom Bot (Nhóm → Cài đặt → Bots → Thêm bot tuỳ chỉnh → Webhook URL, tuỳ chọn Signature).
 * Dùng msg_type "post" (văn bản có liên kết). Trả về { ok:false, error } nếu chưa cấu hình hoặc Lark từ chối.
 */
export async function sendLark(webhookUrl: string, secret: string, title: string, lines: { text: string; href?: string }[][]): Promise<{ ok: boolean; error?: string }> {
  if (!webhookUrl) return { ok: false, error: "Chưa cấu hình Lark webhook" };
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body: Record<string, unknown> = {
      msg_type: "post",
      content: {
        post: {
          vi_vn: {
            title,
            content: lines.map((line) => line.map((part) => (part.href ? { tag: "a", text: part.text, href: part.href } : { tag: "text", text: part.text }))),
          },
        },
      },
    };
    if (secret) {
      body.timestamp = timestamp;
      body.sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
    }
    const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string };
    const code = data.code ?? data.StatusCode ?? (res.ok ? 0 : res.status);
    if (code !== 0) return { ok: false, error: data.msg || data.StatusMessage || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
