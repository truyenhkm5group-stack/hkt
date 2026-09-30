/**
 * ═══════════ NHÀ CUNG CẤP NHẮN TIN THEO TỔ CHỨC (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * MỘT giao diện `MessagingProvider` cho ba loại kết nối (Lark webhook · Telegram bot · hộp thử). Bí mật đến từ
 * `openActiveConnection` — kết nối ĐANG BẬT của CHÍNH tổ chức ngữ cảnh (AAD gắn tổ chức), không bao giờ từ biến môi
 * trường của tổ chức nhà. Kết nối chưa bật / lần kiểm gần nhất hỏng ⇒ không gửi (nói rõ vì sao).
 *
 * KHÔNG PHẢI MÁY GỬI REQUEST TUỲ Ý (cùng hàng rào với `lib/connectors/testers.ts`): chỉ hai loại đích —
 * `https://open.larksuite.com|open.feishu.cn/open-apis/bot/v2/hook/<mã>` và `https://api.telegram.org/bot<token>/sendMessage`;
 * không theo chuyển hướng; trần 10 giây; câu lỗi đi qua `scrubSecrets`. Hộp thử KHÔNG gọi mạng: tin chỉ nằm trong sổ
 * `messaging_deliveries` — đúng thứ "chế độ thử" hứa với người cấu hình.
 *
 * `deps.fetch` để bài kiểm đưa máy chủ giả vào (luật 65: bộ kiểm thử không gọi mạng thật).
 */
import { createHmac, randomUUID } from "node:crypto";
import { openActiveConnection } from "@/lib/connectors/service";
import { LARK_HOOK_PATTERN, scrubSecrets, TELEGRAM_CHAT_PATTERN, TELEGRAM_TOKEN_PATTERN } from "@/lib/connectors/testers";
import type { MessagingConnectorKey } from "@/lib/messaging/types";

export type OutgoingMessage = { title: string | null; text: string; destination: string | null };
export type SendResult = { ok: true; providerMessageId: string | null; destination: string | null } | { ok: false; error: string };
export type MessagingDeps = { fetch?: typeof fetch; now?: () => Date };

export interface MessagingProvider {
  readonly key: MessagingConnectorKey;
  /** Nơi nhận mặc định của kết nối (chat ID / tên kênh thử / "nhóm của webhook") — để hiện và ghi sổ. */
  readonly defaultDestination: string | null;
  send(msg: OutgoingMessage): Promise<SendResult>;
}

const TIMEOUT_MS = 10_000;
/** Lark cắt tin dài; Telegram trần 4.096 ký tự. Cắt ở máy mình để biết chắc tin nào bị cắt. */
const MAX_TEXT = 3800;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function joined(msg: OutgoingMessage): string {
  return clip(msg.title ? `${msg.title}\n${msg.text}` : msg.text);
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text().catch(() => "");
  try {
    const v = JSON.parse(text.slice(0, 64 * 1024)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

class LarkProvider implements MessagingProvider {
  readonly key = "lark-webhook" as const;
  readonly defaultDestination = "Nhóm Lark của webhook";
  constructor(
    private readonly secrets: Record<string, string>,
    private readonly deps: MessagingDeps,
  ) {}
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const url = (this.secrets.webhookUrl ?? "").trim();
    const signSecret = (this.secrets.signSecret ?? "").trim();
    const hide = [url, signSecret, url.split("/").pop() ?? ""];
    if (!LARK_HOOK_PATTERN.test(url)) return { ok: false, error: "Webhook Lark đã lưu không phải địa chỉ Custom Bot hợp lệ — không gửi." };
    const payload: Record<string, unknown> = { msg_type: "text", content: { text: joined(msg) } };
    if (signSecret) {
      const timestamp = Math.floor((this.deps.now ?? (() => new Date()))().getTime() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = createHmac("sha256", `${timestamp}\n${signSecret}`).update("").digest("base64");
    }
    try {
      const res = await postJson(this.deps.fetch ?? fetch, url, payload);
      if (res.status >= 300 && res.status < 400) return { ok: false, error: `Lark trả chuyển hướng HTTP ${res.status} — không theo.` };
      const data = await readJson(res);
      const code = (data?.code ?? data?.StatusCode ?? (res.ok ? 0 : res.status)) as number;
      if (code !== 0) return { ok: false, error: scrubSecrets(`Lark từ chối: ${String(data?.msg ?? data?.StatusMessage ?? `HTTP ${res.status}`)} (mã ${code})`, hide) };
      return { ok: true, providerMessageId: null, destination: this.defaultDestination };
    } catch (e) {
      return { ok: false, error: scrubSecrets(`Không gọi được Lark: ${e instanceof Error ? e.message : String(e)}`, hide) };
    }
  }
}

class TelegramProvider implements MessagingProvider {
  readonly key = "telegram-bot" as const;
  readonly defaultDestination: string | null;
  constructor(
    private readonly secrets: Record<string, string>,
    settings: Record<string, string>,
    private readonly deps: MessagingDeps,
  ) {
    this.defaultDestination = (settings.chatId ?? "").trim() || null;
  }
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const token = (this.secrets.botToken ?? "").trim();
    const chatId = (msg.destination ?? "").trim() || this.defaultDestination || "";
    const hide = [token];
    if (!TELEGRAM_TOKEN_PATTERN.test(token)) return { ok: false, error: "Bot token đã lưu không đúng dạng — không gửi." };
    if (!TELEGRAM_CHAT_PATTERN.test(chatId)) return { ok: false, error: "Chat ID nơi nhận không hợp lệ (số, có thể âm, hoặc @tên_kênh) — không gửi." };
    try {
      const res = await postJson(this.deps.fetch ?? fetch, `https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: joined(msg), disable_web_page_preview: true });
      const body = await readJson(res);
      if (!res.ok || body?.ok !== true) return { ok: false, error: scrubSecrets(`Telegram không nhận tin: ${String(body?.description ?? `HTTP ${res.status}`)}`, hide) };
      const result = body.result as { message_id?: number } | undefined;
      return { ok: true, providerMessageId: result?.message_id !== undefined ? String(result.message_id) : null, destination: chatId };
    } catch (e) {
      return { ok: false, error: scrubSecrets(`Không gọi được Telegram: ${e instanceof Error ? e.message : String(e)}`, hide) };
    }
  }
}

/** Hộp thử: không gọi mạng. Tin đã nằm trong sổ `messaging_deliveries` (dòng do `deliverMessage` chèn) — ĐÓ là hộp thư. */
class SandboxProvider implements MessagingProvider {
  readonly key = "sandbox-messaging" as const;
  readonly defaultDestination: string;
  constructor(settings: Record<string, string>) {
    this.defaultDestination = (settings.channelName ?? "").trim() || "Hộp thử";
  }
  async send(msg: OutgoingMessage): Promise<SendResult> {
    return { ok: true, providerMessageId: `sandbox:${randomUUID()}`, destination: (msg.destination ?? "").trim() || this.defaultDestination };
  }
}

let providerOverride: ((key: MessagingConnectorKey) => MessagingProvider | null) | null = null;
/** Chỉ bài kiểm: thay nhà cung cấp (vd Lark giả). `null` để gỡ. */
export function setMessagingProviderForTests(fn: ((key: MessagingConnectorKey) => MessagingProvider | null) | null) {
  providerOverride = fn;
}

/**
 * Nhà cung cấp của kết nối ĐANG BẬT `key` thuộc tổ chức ngữ cảnh. `{ error }` khi chưa khai / chưa bật / kiểm hỏng /
 * không giải được bí mật — câu này đi thẳng vào bước hỏng của lượt chạy luật, người cấu hình đọc được vì sao.
 */
export async function messagingProvider(key: MessagingConnectorKey, deps: MessagingDeps = {}): Promise<{ ok: true; provider: MessagingProvider } | { ok: false; error: string }> {
  if (providerOverride) {
    const p = providerOverride(key);
    return p ? { ok: true, provider: p } : { ok: false, error: `Kết nối «${key}» chưa bật (kiểm thử).` };
  }
  const conn = await openActiveConnection(key);
  if (!conn.ok) return { ok: false, error: conn.reason };
  switch (key) {
    case "lark-webhook":
      return { ok: true, provider: new LarkProvider(conn.secrets, deps) };
    case "telegram-bot":
      return { ok: true, provider: new TelegramProvider(conn.secrets, conn.settings, deps) };
    case "sandbox-messaging":
      return { ok: true, provider: new SandboxProvider(conn.settings) };
  }
}
