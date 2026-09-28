/**
 * ═══════════ KIỂM TRA KẾT NỐI THEO TỔ CHỨC — CHỈ BẰNG KHOÁ CỦA CHÍNH TỔ CHỨC ═══════════
 *
 * Hợp đồng: docs/platform/phase-9-contracts.md §2. Hàm ở đây nhận bí mật ĐÃ GIẢI MÃ từ
 * `lib/connectors/service.ts` (bí mật của tổ chức đang đăng nhập, trong CSDL của chính nó) — KHÔNG
 * BAO GIỜ đọc biến môi trường, nên không có credential nào của tổ chức nhà đi qua đây.
 *
 * ─── KHÔNG PHẢI MỘT MÁY GỬI REQUEST TUỲ Ý (SSRF) ───
 *
 * Người quản trị của một tổ chức gõ URL; máy chủ gọi URL đó. Nên máy chủ chỉ gọi đúng HAI loại đích:
 * `https://open.larksuite.com|open.feishu.cn/open-apis/bot/v2/hook/<mã>` và `https://api.telegram.org/bot<token>/…`.
 * Không theo chuyển hướng (`redirect: "manual"` — một 302 về 169.254.169.254 là cửa vào metadata máy
 * chủ). Trần thời gian 10 giây. Không đọc phản hồi quá 64 KB.
 *
 * ─── KHÔNG NÉM, KHÔNG LỘ ───
 *
 * Trả `{ ok, message }` tiếng Việt. Câu lỗi đi qua `scrubSecrets` — lỗi mạng của Node có thể chứa
 * URL (tức là chứa token Telegram hoặc mã hook Lark).
 *
 * `deps.fetch` để bài kiểm đưa vào một máy chủ giả: bộ kiểm thử không gọi mạng thật (luật 65).
 */

export type TesterResult = { ok: boolean; message: string };
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type TesterDeps = { fetch?: FetchLike; now?: () => Date };

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

export const LARK_HOOK_PATTERN = /^https:\/\/open\.(larksuite\.com|feishu\.cn)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,80}$/;
export const TELEGRAM_TOKEN_PATTERN = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_CHAT_PATTERN = /^-?[0-9]{3,20}$|^@[A-Za-z0-9_]{5,64}$/;

/** Thay mọi lần xuất hiện của từng bí mật (≥ 4 ký tự) bằng `***`. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out.slice(0, 300);
}

async function readCapped(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  const capped = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
  try {
    return JSON.parse(capped) as unknown;
  } catch {
    return null;
  }
}

async function post(fetchImpl: FetchLike, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function larkSign(secret: string, timestamp: string): Promise<string> {
  return import("node:crypto").then(({ createHmac }) => createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64"));
}

/**
 * Lark Custom Bot: gửi MỘT tin thử vào nhóm do tổ chức khai. Lark trả HTTP 200 kể cả khi từ chối —
 * đọc `code` / `StatusCode` trong phong bì, không tin HTTP status.
 */
export async function testLarkWebhook(input: { secrets: Record<string, string>; orgName: string }, deps: TesterDeps = {}): Promise<TesterResult> {
  const url = (input.secrets.webhookUrl ?? "").trim();
  const signSecret = (input.secrets.signSecret ?? "").trim();
  const hide = [url, signSecret, url.split("/").pop() ?? ""];
  if (!LARK_HOOK_PATTERN.test(url)) return { ok: false, message: "Webhook URL không phải địa chỉ Custom Bot của Lark (https://open.larksuite.com/open-apis/bot/v2/hook/… hoặc open.feishu.cn) — không gửi." };
  const fetchImpl = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  const payload: Record<string, unknown> = { msg_type: "text", content: { text: `Tin thử kết nối từ ERP — tổ chức «${input.orgName}» · ${now.toISOString()}. Nhóm này sẽ nhận thông báo khi kết nối được bật.` } };
  if (signSecret) {
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = await larkSign(signSecret, timestamp);
  }
  try {
    const res = await post(fetchImpl, url, payload);
    if (res.status >= 300 && res.status < 400) return { ok: false, message: `Lark trả chuyển hướng HTTP ${res.status} — không theo, kiểm tra lại URL.` };
    const data = (await readCapped(res)) as { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string } | null;
    const code = data?.code ?? data?.StatusCode ?? (res.ok ? 0 : res.status);
    if (code !== 0) return { ok: false, message: scrubSecrets(`Lark từ chối: ${data?.msg || data?.StatusMessage || `HTTP ${res.status}`} (mã ${code})`, hide) };
    return { ok: true, message: "Đã gửi tin thử vào nhóm Lark — mở nhóm để xác nhận đã nhận." };
  } catch (e) {
    return { ok: false, message: scrubSecrets(`Không gọi được Lark: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/** Telegram: `getMe` (chỉ đọc — token còn sống không) rồi gửi MỘT tin thử vào chat đã khai. */
export async function testTelegramBot(input: { secrets: Record<string, string>; settings: Record<string, string>; orgName: string }, deps: TesterDeps = {}): Promise<TesterResult> {
  const token = (input.secrets.botToken ?? "").trim();
  const chatId = (input.settings.chatId ?? "").trim();
  const hide = [token];
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) return { ok: false, message: "Bot token không đúng dạng <số>:<chuỗi> của @BotFather — không gửi." };
  if (!TELEGRAM_CHAT_PATTERN.test(chatId)) return { ok: false, message: "Chat ID không hợp lệ (số, có thể âm, hoặc @tên_kênh) — không gửi." };
  const fetchImpl = deps.fetch ?? fetch;
  const base = `https://api.telegram.org/bot${token}`;
  try {
    const me = await fetchImpl(`${base}/getMe`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const meBody = (await readCapped(me)) as { ok?: boolean; description?: string; result?: { username?: string } } | null;
    if (!me.ok || !meBody?.ok) return { ok: false, message: scrubSecrets(`Telegram không nhận token: ${meBody?.description || `HTTP ${me.status}`}`, hide) };
    const sent = await post(fetchImpl, `${base}/sendMessage`, { chat_id: chatId, text: `Tin thử kết nối từ ERP — tổ chức «${input.orgName}».`, disable_web_page_preview: true });
    const sentBody = (await readCapped(sent)) as { ok?: boolean; description?: string } | null;
    if (!sent.ok || !sentBody?.ok) return { ok: false, message: scrubSecrets(`Bot @${meBody.result?.username ?? "?"} hợp lệ nhưng không gửi được vào chat đã khai: ${sentBody?.description || `HTTP ${sent.status}`}`, hide) };
    return { ok: true, message: `Bot @${meBody.result?.username ?? "?"} đã gửi tin thử — mở chat để xác nhận đã nhận.` };
  } catch (e) {
    return { ok: false, message: scrubSecrets(`Không gọi được Telegram: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/*
  ═══════════ KHOÁ AI CỦA TỔ CHỨC (Phase 8) — HỎI "KHOÁ CÒN SỐNG KHÔNG" BẰNG LỜI GỌI RẺ NHẤT ═══════════

  `GET /v1/models` ở cả hai nhà cung cấp: chỉ đọc, KHÔNG sinh token nào (không tốn tiền của tổ chức), trả 401 khi khoá
  sai. Địa chỉ là HẰNG SỐ trong mã — người dùng chỉ nhập khoá, không nhập URL, nên không có đường nào đưa request đi
  chỗ khác. Không theo chuyển hướng, trần 10 giây, khoá bị che trong mọi câu lỗi.
*/
export const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;
export const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,200}$/;
export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

async function probeModels(fetchImpl: FetchLike, url: string, headers: Record<string, string>, vendor: string, hide: string[]): Promise<TesterResult> {
  try {
    const res = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) return { ok: false, message: `${vendor} trả chuyển hướng HTTP ${res.status} — không theo.` };
    const body = (await readCapped(res)) as { error?: { message?: string; type?: string } | string } | null;
    if (res.status === 401 || res.status === 403) return { ok: false, message: `${vendor} từ chối khoá (HTTP ${res.status}) — khoá sai, đã thu hồi, hoặc không có quyền.` };
    if (!res.ok) {
      const detail = typeof body?.error === "string" ? body.error : (body?.error?.message ?? `HTTP ${res.status}`);
      return { ok: false, message: scrubSecrets(`${vendor} trả lỗi: ${detail}`, hide) };
    }
    return { ok: true, message: `${vendor} nhận khoá (đã liệt kê model — lời gọi chỉ đọc, không tốn token).` };
  } catch (e) {
    return { ok: false, message: scrubSecrets(`Không gọi được ${vendor}: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/** Anthropic: `GET https://api.anthropic.com/v1/models` với `x-api-key` của tổ chức. */
export async function testAnthropicKey(input: { secrets: Record<string, string> }, deps: TesterDeps = {}): Promise<TesterResult> {
  const key = (input.secrets.apiKey ?? "").trim();
  if (!ANTHROPIC_KEY_PATTERN.test(key)) return { ok: false, message: "Khoá không đúng dạng khoá Anthropic (sk-ant-…) — không gửi." };
  return probeModels(deps.fetch ?? fetch, ANTHROPIC_MODELS_URL, { "x-api-key": key, "anthropic-version": "2023-06-01" }, "Anthropic", [key]);
}

/** OpenAI: `GET https://api.openai.com/v1/models` với `Authorization: Bearer` của tổ chức. */
export async function testOpenAiKey(input: { secrets: Record<string, string> }, deps: TesterDeps = {}): Promise<TesterResult> {
  const key = (input.secrets.apiKey ?? "").trim();
  if (!OPENAI_KEY_PATTERN.test(key)) return { ok: false, message: "Khoá không đúng dạng khoá OpenAI (sk-…) — không gửi." };
  return probeModels(deps.fetch ?? fetch, OPENAI_MODELS_URL, { authorization: `Bearer ${key}` }, "OpenAI", [key]);
}

/** Bảng tra: connector → hàm kiểm tra. Khoá phải khớp `healthRef` trong sổ (bài kiểm đối chiếu). */
export const ORG_CONNECTION_TESTERS: Readonly<Record<string, (input: { secrets: Record<string, string>; settings: Record<string, string>; orgName: string }, deps?: TesterDeps) => Promise<TesterResult>>> = {
  "lark-webhook": (input, deps) => testLarkWebhook(input, deps),
  "telegram-bot": (input, deps) => testTelegramBot(input, deps),
  "anthropic-byok": (input, deps) => testAnthropicKey(input, deps),
  "openai-byok": (input, deps) => testOpenAiKey(input, deps),
};
