/**
 * ═══════════ KIỂM TRA KẾT NỐI THEO TỔ CHỨC — CHỈ BẰNG KHOÁ CỦA CHÍNH TỔ CHỨC ═══════════
 *
 * Hợp đồng: docs/platform/phase-9-contracts.md §2. Hàm ở đây nhận bí mật ĐÃ GIẢI MÃ từ
 * `lib/connectors/service.ts` (bí mật của tổ chức đang đăng nhập, trong CSDL của chính nó) — KHÔNG
 * BAO GIỜ đọc biến môi trường chứa khoá, nên không có credential nào của tổ chức nhà đi qua đây. (Ngoại lệ duy nhất là
 * cấu hình CÔNG KHAI của nền tảng: phiên bản Graph API mà client Facebook cũng dùng — không phải bí mật.)
 *
 * ─── KHÔNG PHẢI MỘT MÁY GỬI REQUEST TUỲ Ý (SSRF) ───
 *
 * Người quản trị của một tổ chức gõ URL; máy chủ gọi URL đó. Nên máy chủ chỉ gọi đúng HAI loại đích:
 * `https://open.larksuite.com|open.feishu.cn/open-apis/bot/v2/hook/<mã>` và `<TELEGRAM_API_BASE | https://api.telegram.org>/bot<token>/…`.
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
import { PANCAKE_POS_API, PANCAKE_POS_API_KEY_PATTERN, PANCAKE_POS_SHOP_ID_PATTERN } from "@/lib/constants/pancake-pos-org";
import { telegramApiBase, telegramApiHost } from "@/lib/connectors/telegram-api";
import { describeNetworkFailure, isNetworkFailure } from "@/lib/connectors/net-error";
import { adAccountStatusLabel, META_ADS_ORG_MAX_ACCOUNTS, META_SYSTEM_USER_TOKEN_PATTERN, parseAdAccountIds } from "@/lib/constants/meta-ads-org";
import { env } from "@/lib/env";

export type TesterResult = { ok: boolean; message: string };
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type TesterDeps = { fetch?: FetchLike; now?: () => Date };

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

export const LARK_HOOK_PATTERN = /^https:\/\/open\.(larksuite\.com|feishu\.cn)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,80}$/;
export const TELEGRAM_TOKEN_PATTERN = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_CHAT_PATTERN = /^-?[0-9]{3,20}$|^@[A-Za-z0-9_]{5,64}$/;
/** Zalo Bot Platform (bot.zaloplatforms.com): token «<số>:<chuỗi>», chat id là chuỗi chữ-số của Zalo (người hoặc nhóm). */
export const ZALO_BOT_API = "https://bot-api.zaloplatforms.com";
export const ZALO_TOKEN_PATTERN = /^[0-9]{5,25}:[A-Za-z0-9_.-]{10,200}$/;
export const ZALO_CHAT_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
/** Trần độ dài một tin của Zalo Bot API (1–2000 ký tự). */
export const ZALO_TEXT_MAX = 2000;

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
    return { ok: false, message: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Lark: ${describeNetworkFailure(e, new URL(url).host)}` : `Không gọi được Lark: ${e instanceof Error ? e.message : String(e)}`, hide) };
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
  const base = `${telegramApiBase()}/bot${token}`;
  try {
    const me = await fetchImpl(`${base}/getMe`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const meBody = (await readCapped(me)) as { ok?: boolean; description?: string; result?: { username?: string } } | null;
    if (!me.ok || !meBody?.ok) return { ok: false, message: scrubSecrets(`Telegram không nhận token: ${meBody?.description || `HTTP ${me.status}`}`, hide) };
    const sent = await post(fetchImpl, `${base}/sendMessage`, { chat_id: chatId, text: `Tin thử kết nối từ ERP — tổ chức «${input.orgName}».`, disable_web_page_preview: true });
    const sentBody = (await readCapped(sent)) as { ok?: boolean; description?: string } | null;
    if (!sent.ok || !sentBody?.ok) return { ok: false, message: scrubSecrets(`Bot @${meBody.result?.username ?? "?"} hợp lệ nhưng không gửi được vào chat đã khai: ${sentBody?.description || `HTTP ${sent.status}`}`, hide) };
    return { ok: true, message: `Bot @${meBody.result?.username ?? "?"} đã gửi tin thử — mở chat để xác nhận đã nhận.` };
  } catch (e) {
    return { ok: false, message: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Telegram: ${describeNetworkFailure(e, telegramApiHost())} Cách sửa: relay TELEGRAM_API_BASE, hoặc dùng «Lark — webhook nhóm của tổ chức» / «Zalo — bot của tổ chức».` : `Không gọi được Telegram: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/**
 * Zalo Bot (bot.zaloplatforms.com — tài liệu bot.zapps.me/docs): `getMe` (token còn sống không) rồi gửi MỘT tin thử vào
 * chat đã khai. Phong bì `{ ok, result | error_code, description }` giống Telegram; địa chỉ là HẰNG SỐ trong mã. Máy chủ
 * đặt tại Việt Nam gọi được Zalo kể cả khi Telegram bị chặn ở tầng mạng (đo 30/09/2026).
 */
export async function testZaloBot(input: { secrets: Record<string, string>; settings: Record<string, string>; orgName: string }, deps: TesterDeps = {}): Promise<TesterResult> {
  const token = (input.secrets.botToken ?? "").trim();
  const chatId = (input.settings.chatId ?? "").trim();
  const hide = [token];
  if (!ZALO_TOKEN_PATTERN.test(token)) return { ok: false, message: "Bot token không đúng dạng <số>:<chuỗi> của Zalo Bot Creator — không gửi." };
  if (!ZALO_CHAT_PATTERN.test(chatId)) return { ok: false, message: "Chat ID chưa có hoặc không hợp lệ — nhắn cho bot (hoặc @nhắc bot trong nhóm) rồi bấm «Tìm chat» để lấy đúng mã." };
  const fetchImpl = deps.fetch ?? fetch;
  const base = `${ZALO_BOT_API}/bot${token}`;
  try {
    const me = await post(fetchImpl, `${base}/getMe`, {});
    const meBody = (await readCapped(me)) as { ok?: boolean; description?: string; result?: { account_name?: string } } | null;
    if (!meBody?.ok) return { ok: false, message: scrubSecrets(`Zalo không nhận token: ${meBody?.description || `HTTP ${me.status}`}`, hide) };
    const name = meBody.result?.account_name ?? "?";
    const sent = await post(fetchImpl, `${base}/sendMessage`, { chat_id: chatId, text: `Tin thử kết nối từ ERP — tổ chức «${input.orgName}».` });
    const sentBody = (await readCapped(sent)) as { ok?: boolean; description?: string } | null;
    if (!sentBody?.ok) return { ok: false, message: scrubSecrets(`Bot ${name} hợp lệ nhưng không gửi được vào chat đã khai: ${sentBody?.description || `HTTP ${sent.status}`}`, hide) };
    return { ok: true, message: `Bot ${name} đã gửi tin thử — mở Zalo để xác nhận đã nhận.` };
  } catch (e) {
    return { ok: false, message: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Zalo: ${describeNetworkFailure(e, "bot-api.zaloplatforms.com")}` : `Không gọi được Zalo: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/*
  ═══════════ TÌM CHAT ID — ĐỌC TIN MỚI CỦA BOT (Zalo · Telegram) ═══════════

  Zalo không hiện mã chat cho người dùng; Telegram hiện rất khó tìm. Người cấu hình nhắn cho bot (hoặc @nhắc bot trong
  nhóm), rồi bấm «Tìm chat»: máy gọi `getUpdates` bằng token ĐÃ LƯU và trả các chat bot vừa thấy — mã, loại, tên người
  nhắn, đoạn đầu tin. Chỉ đọc. Không đặt webhook nào (getUpdates của cả hai chỉ chạy khi CHƯA có webhook).
*/
export type DiscoveredChat = { id: string; type: "PRIVATE" | "GROUP"; name: string; sample: string };
export type ChatDiscovery = { ok: true; chats: DiscoveredChat[]; message: string } | { ok: false; message: string };

function addChat(out: DiscoveredChat[], c: DiscoveredChat) {
  if (c.id && !out.some((x) => x.id === c.id)) out.push({ ...c, name: c.name.slice(0, 80), sample: c.sample.slice(0, 80) });
}

function discoveryFailure(e: unknown, vendor: string, host: string, token: string): ChatDiscovery {
  return { ok: false, message: scrubSecrets(isNetworkFailure(e) ? `Không gọi được ${vendor}: ${describeNetworkFailure(e, host)}` : `Không gọi được ${vendor}: ${e instanceof Error ? e.message : String(e)}`, [token]) };
}

async function discoverZaloChats(secrets: Record<string, string>, deps: TesterDeps): Promise<ChatDiscovery> {
  const token = (secrets.botToken ?? "").trim();
  if (!ZALO_TOKEN_PATTERN.test(token)) return { ok: false, message: "Chưa lưu bot token hợp lệ." };
  const fetchImpl = deps.fetch ?? fetch;
  const chats: DiscoveredChat[] = [];
  try {
    // Mỗi lượt getUpdates trả tối đa MỘT tin; hỏi vài lượt ngắn để gom các chat vừa nhắn.
    for (let i = 0; i < 4; i++) {
      const res = await post(fetchImpl, `${ZALO_BOT_API}/bot${token}/getUpdates`, { timeout: "2" });
      const body = (await readCapped(res)) as { ok?: boolean; description?: string; error_code?: number; result?: unknown } | null;
      if (!body?.ok) {
        if (body?.error_code === 408 || i > 0) break; // hết tin mới
        return { ok: false, message: scrubSecrets(`Zalo từ chối: ${body?.description || `HTTP ${res.status}`}`, [token]) };
      }
      const updates = Array.isArray(body.result) ? body.result : body.result ? [body.result] : [];
      if (!updates.length) break;
      for (const u of updates as { message?: { chat?: { id?: unknown; chat_type?: unknown }; from?: { display_name?: unknown }; text?: unknown } }[]) {
        const m = u.message;
        if (!m?.chat?.id) continue;
        addChat(chats, { id: String(m.chat.id), type: m.chat.chat_type === "GROUP" ? "GROUP" : "PRIVATE", name: String(m.from?.display_name ?? ""), sample: String(m.text ?? "") });
      }
    }
  } catch (e) {
    return discoveryFailure(e, "Zalo", "bot-api.zaloplatforms.com", token);
  }
  return { ok: true, chats, message: chats.length ? `Bot vừa thấy ${chats.length} chat — chọn chat nhận tin.` : "Chưa thấy tin mới — nhắn cho bot (hoặc @nhắc bot trong nhóm) rồi bấm lại." };
}

async function discoverTelegramChats(secrets: Record<string, string>, deps: TesterDeps): Promise<ChatDiscovery> {
  const token = (secrets.botToken ?? "").trim();
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) return { ok: false, message: "Chưa lưu bot token hợp lệ." };
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const res = await fetchImpl(`${telegramApiBase()}/bot${token}/getUpdates?timeout=0&limit=50`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await readCapped(res)) as { ok?: boolean; description?: string; result?: unknown } | null;
    if (!body?.ok) return { ok: false, message: scrubSecrets(`Telegram từ chối: ${body?.description || `HTTP ${res.status}`}`, [token]) };
    type TgChat = { id?: unknown; type?: unknown; title?: unknown; first_name?: unknown };
    const chats: DiscoveredChat[] = [];
    for (const u of (Array.isArray(body.result) ? body.result : []) as { message?: { chat?: TgChat; text?: unknown }; my_chat_member?: { chat?: TgChat } }[]) {
      const chat = u.message?.chat ?? u.my_chat_member?.chat;
      if (!chat?.id) continue;
      const group = chat.type === "group" || chat.type === "supergroup" || chat.type === "channel";
      addChat(chats, { id: String(chat.id), type: group ? "GROUP" : "PRIVATE", name: String(chat.title ?? chat.first_name ?? ""), sample: String(u.message?.text ?? "") });
    }
    return { ok: true, chats, message: chats.length ? `Bot vừa thấy ${chats.length} chat — chọn chat nhận tin.` : "Chưa thấy tin mới — thêm bot vào nhóm và nhắn một câu, rồi bấm lại." };
  } catch (e) {
    return discoveryFailure(e, "Telegram", telegramApiHost(), token);
  }
}

/** Bảng tra: connector → hàm tìm chat. Khoá phải khớp `CHAT_DISCOVERY_CONNECTORS` (lib/connectors/types.ts). */
export const ORG_CONNECTION_CHAT_DISCOVERY: Readonly<Record<string, (secrets: Record<string, string>, deps?: TesterDeps) => Promise<ChatDiscovery>>> = {
  "zalo-bot": (secrets, deps = {}) => discoverZaloChats(secrets, deps),
  "telegram-bot": (secrets, deps = {}) => discoverTelegramChats(secrets, deps),
};

/** Pancake Pages (fanpage của tổ chức): hỏi danh sách hội thoại của page bằng page access token — CHỈ ĐỌC, không gửi gì. */
export const PANCAKE_PAGES_API = "https://pages.fm/api/public_api";
export const PANCAKE_PAGE_ID_PATTERN = /^[A-Za-z0-9_]{5,40}$/;
export const PANCAKE_PAGE_TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,600}$/;

/**
 * Phán quyết của pages.fm cho lời gọi đọc hội thoại. Pancake trả HTTP 200 cho CẢ token sai
 * (`{"success":false,"message":"Invalid access_token"}`) — đọc phong bì, không tin HTTP status. Danh sách 60 hội thoại
 * thật thường DÀI hơn trần 64 KB của `readCapped` (đo 01/10/2026: token đúng mà màn hình báo «HTTP 200» vì JSON bị cắt), nên
 * đọc tới `PANCAKE_TEST_MAX_BYTES`; dài hơn nữa thì chỉ dò dấu từ chối trong phần đầu. HÀM THUẦN.
 */
export const PANCAKE_TEST_MAX_BYTES = 4 * 1024 * 1024;
export function pancakeVerdict(status: number, text: string): { ok: true; count: number | null } | { ok: false; reason: string } {
  if (status < 200 || status >= 300) return { ok: false, reason: `HTTP ${status}` };
  const head = text.slice(0, 4096);
  if (/"success"\s*:\s*false/.test(head)) {
    const msg = /"message"\s*:\s*"([^"]{1,200})"/.exec(head)?.[1];
    return { ok: false, reason: msg || "Pancake từ chối" };
  }
  if (text.length <= PANCAKE_TEST_MAX_BYTES) {
    try {
      const body = JSON.parse(text) as { conversations?: unknown };
      if (Array.isArray(body?.conversations)) return { ok: true, count: body.conversations.length };
      return { ok: false, reason: "phản hồi không có danh sách hội thoại" };
    } catch {
      return { ok: false, reason: "phản hồi không phải JSON" };
    }
  }
  // Quá dài để đọc hết: không có dấu từ chối + mở đầu đúng dạng danh sách hội thoại ⇒ Pancake đã nhận.
  return /"conversations"\s*:\s*\[/.test(head) ? { ok: true, count: null } : { ok: false, reason: "phản hồi không đọc được" };
}

export async function testPancakeFanpage(input: { secrets: Record<string, string>; settings: Record<string, string> }, deps: TesterDeps = {}): Promise<TesterResult> {
  const pageId = (input.settings.pageId ?? "").trim();
  const token = (input.secrets.pageAccessToken ?? "").trim();
  const hide = [token];
  if (!PANCAKE_PAGE_ID_PATTERN.test(pageId)) return { ok: false, message: "Page ID không hợp lệ — không gọi." };
  if (!PANCAKE_PAGE_TOKEN_PATTERN.test(token)) return { ok: false, message: "Page access token không đúng dạng — không gọi." };
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const url = `${PANCAKE_PAGES_API}/v2/pages/${encodeURIComponent(pageId)}/conversations?page_access_token=${encodeURIComponent(token)}`;
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const v = pancakeVerdict(res.status, await res.text().catch(() => ""));
    if (!v.ok) return { ok: false, message: scrubSecrets(`Pancake không nhận page / token: ${v.reason}`, hide) };
    return { ok: true, message: `Pancake nhận page ${pageId}${v.count !== null ? ` — đọc được ${v.count} hội thoại gần nhất` : ""}. Dán URL webhook (trang Chatbot bán hàng) vào Pancake để bot nhận tin.` };
  } catch (e) {
    return { ok: false, message: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pages.fm")}` : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, hide) };
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

/**
 * Chỉ chặn thứ CHẮC CHẮN không phải khoá (khoảng trắng, ngoặc, «=»…) — đúng hay sai do Google trả lời ở lượt kiểm tra.
 * 02/10/2026: khoá Google cấp không còn chỉ dạng «AIza» + 35 ký tự, mẫu cũ chặn khoá thật của chủ shop ngay ô nhập.
 * Bộ ký tự vẫn đóng (chữ, số, «.», «_», «-») nên khoá không chèn được gì vào header.
 */
export const GEMINI_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{29,199}$/;
export const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** Gemini: `GET …/v1beta/models` với header `x-goog-api-key` của tổ chức (không đặt khoá vào URL — log proxy không thấy). */
export async function testGeminiKey(input: { secrets: Record<string, string> }, deps: TesterDeps = {}): Promise<TesterResult> {
  const key = (input.secrets.apiKey ?? "").trim();
  if (/^sk-/.test(key)) return { ok: false, message: "Đây là khoá OpenAI (sk-…), không phải khoá Gemini — lấy khoá ở aistudio.google.com → Get API key." };
  if (!GEMINI_KEY_PATTERN.test(key)) return { ok: false, message: "Khoá có ký tự lạ (khoảng trắng, dấu ngoặc, «=»…) hoặc quá ngắn — dán NGUYÊN khoá từ aistudio.google.com, không gửi." };
  return probeModels(deps.fetch ?? fetch, GEMINI_MODELS_URL, { "x-goog-api-key": key }, "Gemini", [key]);
}

/** Hộp thử nhắn tin (0180): không gọi mạng — "kiểm tra" chỉ xác nhận tên kênh hợp lệ. Tin thử thật đi qua màn hình Thông báo nhóm. */
export async function testSandboxMessaging(input: { settings: Record<string, string> }): Promise<TesterResult> {
  const name = (input.settings.channelName ?? "").trim();
  if (!name) return { ok: false, message: "Thiếu tên kênh thử." };
  return { ok: true, message: `Hộp thử «${name}» sẵn sàng — CHẾ ĐỘ THỬ: tin nằm trong ERP (Cài đặt → Thông báo nhóm), không gửi ra ngoài.` };
}

/*
  ═══════════ QUẢNG CÁO FACEBOOK CỦA TỔ CHỨC (meta-ads-org) — HỎI TỪNG TÀI KHOẢN ĐÃ KHAI ═══════════

  `GET https://graph.facebook.com/<phiên bản>/act_<id>?fields=name,currency,account_status` cho TỪNG tài khoản: chỉ đọc,
  không tốn tiền, trả đúng ba thứ job đồng bộ cần (tên để in, tiền tệ để quy đổi, trạng thái để người cấu hình biết).
  Token đi trong tiêu đề `Authorization` (không nằm trong URL), không theo chuyển hướng, trần 10 giây, che token trong
  mọi câu lỗi. ĐẠT chỉ khi MỌI tài khoản đọc được — một tài khoản hỏng nghĩa là lượt đồng bộ sẽ thiếu tiền của nó.
*/
export const META_GRAPH_HOST = "https://graph.facebook.com";

/** Một câu trả lời của Graph cho `act_<id>` ⇒ phán quyết. Hàm THUẦN. */
export function metaAccountVerdict(status: number, body: unknown): { ok: true; name: string; currency: string; status: number } | { ok: false; reason: string } {
  const rec = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const err = rec && rec.error && typeof rec.error === "object" ? (rec.error as Record<string, unknown>) : null;
  if (err || status < 200 || status >= 300) {
    const code = err && typeof err.code === "number" ? err.code : null;
    const msg = err && typeof err.message === "string" ? err.message.slice(0, 160) : `HTTP ${status}`;
    if (code === 190) return { ok: false, reason: `token không hợp lệ hoặc đã hết hạn (mã 190)` };
    if (code === 200 || code === 10 || code === 100 || status === 403) return { ok: false, reason: `token không có quyền ads_read trên tài khoản này, hoặc sai mã tài khoản — ${msg}` };
    return { ok: false, reason: msg };
  }
  if (!rec || typeof rec.id !== "string") return { ok: false, reason: "phản hồi không có mã tài khoản" };
  return {
    ok: true,
    name: typeof rec.name === "string" && rec.name ? rec.name : rec.id,
    currency: typeof rec.currency === "string" ? rec.currency.toUpperCase() : "",
    status: typeof rec.account_status === "number" ? rec.account_status : 0,
  };
}

export async function testMetaAdsOrg(input: { secrets: Record<string, string>; settings: Record<string, string> }, deps: TesterDeps = {}): Promise<TesterResult> {
  const token = (input.secrets.accessToken ?? "").trim();
  const hide = [token];
  if (!META_SYSTEM_USER_TOKEN_PATTERN.test(token)) return { ok: false, message: "Token không đúng dạng token System User của Meta (EAA…) — không gọi." };
  const { ids, invalid } = parseAdAccountIds(input.settings.adAccountIds);
  if (invalid.length) return { ok: false, message: `Mã tài khoản quảng cáo không hợp lệ: ${invalid.slice(0, 3).join(", ")} — không gọi.` };
  if (!ids.length) return { ok: false, message: "Chưa khai tài khoản quảng cáo nào — không gọi." };
  if (ids.length > META_ADS_ORG_MAX_ACCOUNTS) return { ok: false, message: `Khai quá ${META_ADS_ORG_MAX_ACCOUNTS} tài khoản — không gọi.` };
  const fetchImpl = deps.fetch ?? fetch;
  const lines: string[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      const url = `${META_GRAPH_HOST}/${encodeURIComponent(env.facebook.apiVersion)}/act_${id}?fields=name,currency,account_status`;
      const res = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status >= 300 && res.status < 400) {
        failed += 1;
        lines.push(`act_${id}: Facebook trả chuyển hướng HTTP ${res.status} — không theo`);
        continue;
      }
      const v = metaAccountVerdict(res.status, await readCapped(res));
      if (!v.ok) {
        failed += 1;
        lines.push(`act_${id}: ${v.reason}`);
      } else lines.push(`act_${id} «${v.name}» (${v.currency || "chưa rõ tiền tệ"}, ${adAccountStatusLabel(v.status)})`);
    } catch (e) {
      failed += 1;
      lines.push(`act_${id}: ${isNetworkFailure(e) ? `không gọi được Facebook — ${describeNetworkFailure(e, "graph.facebook.com")}` : e instanceof Error ? e.message : String(e)}`);
    }
  }
  const body = lines.join(" · ");
  if (failed) return { ok: false, message: scrubSecrets(`${failed}/${ids.length} tài khoản không đọc được: ${body}`, hide) };
  return { ok: true, message: scrubSecrets(`Đọc được ${ids.length}/${ids.length} tài khoản: ${body}. Bật để job «ads-spend-org» kéo chi tiêu mỗi 60 phút.`, hide) };
}

/**
 * PANCAKE POS CỦA TỔ CHỨC (F1): `GET /shops?api_key=…` — chỉ đọc, địa chỉ hằng số (`PANCAKE_POS_API`), không theo chuyển
 * hướng, khoá bị che trong mọi câu. Đạt ⇔ khoá được nhận VÀ mã shop đã khai nằm trong danh sách shop của khoá — khoá đúng
 * mà sai shop thì mọi lượt đồng bộ sau đều rỗng, nên phải nói ra ngay ở bước kiểm tra. HÀM THUẦN với `fetch` tiêm vào.
 */
export async function testPancakePosOrg(input: { secrets: Record<string, string>; settings: Record<string, string> }, deps: TesterDeps = {}): Promise<TesterResult> {
  const apiKey = (input.secrets.apiKey ?? "").trim();
  const shopId = (input.settings.shopId ?? "").trim();
  const hide = [apiKey];
  if (!PANCAKE_POS_API_KEY_PATTERN.test(apiKey)) return { ok: false, message: "API key Pancake POS không đúng dạng — không gọi." };
  if (!PANCAKE_POS_SHOP_ID_PATTERN.test(shopId)) return { ok: false, message: "Mã shop Pancake POS phải là số — không gọi." };
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const res = await fetchImpl(`${PANCAKE_POS_API}/shops?api_key=${encodeURIComponent(apiKey)}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) return { ok: false, message: `Pancake trả chuyển hướng HTTP ${res.status} — không theo.` };
    const body = (await readCapped(res)) as { success?: boolean; message?: string; shops?: { id?: unknown; name?: unknown }[] } | null;
    if (res.status === 401 || res.status === 403 || body?.success === false) return { ok: false, message: scrubSecrets(`Pancake không nhận khoá: ${body?.message ?? `HTTP ${res.status}`}`, hide) };
    if (!res.ok) return { ok: false, message: `Pancake trả lỗi HTTP ${res.status}.` };
    const shops = Array.isArray(body?.shops) ? body.shops : null;
    if (!shops) return { ok: false, message: "Phản hồi của Pancake không có danh sách shop." };
    const shop = shops.find((s) => String(s?.id ?? "") === shopId);
    if (!shop) return { ok: false, message: scrubSecrets(`Khoá đúng nhưng không có shop ${shopId} — khoá này thấy ${shops.length} shop: ${shops.slice(0, 5).map((s) => `${String(s?.id ?? "?")} «${String(s?.name ?? "")}»`).join(", ")}.`, hide) };
    return { ok: true, message: scrubSecrets(`Pancake nhận khoá — shop ${shopId} «${String(shop.name ?? "")}». Bật rồi bấm «Đồng bộ ngay» để kéo đơn, khách, sản phẩm; dán URL webhook vào Pancake để đơn về tức thời.`, hide) };
  } catch (e) {
    return { ok: false, message: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pos.pages.fm")}` : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/** Bảng tra: connector → hàm kiểm tra. Khoá phải khớp `healthRef` trong sổ (bài kiểm đối chiếu). */
export const ORG_CONNECTION_TESTERS: Readonly<Record<string, (input: { secrets: Record<string, string>; settings: Record<string, string>; orgName: string }, deps?: TesterDeps) => Promise<TesterResult>>> = {
  "lark-webhook": (input, deps) => testLarkWebhook(input, deps),
  "telegram-bot": (input, deps) => testTelegramBot(input, deps),
  "zalo-bot": (input, deps) => testZaloBot(input, deps),
  "anthropic-byok": (input, deps) => testAnthropicKey(input, deps),
  "openai-byok": (input, deps) => testOpenAiKey(input, deps),
  "gemini-byok": (input, deps) => testGeminiKey(input, deps),
  "sandbox-messaging": (input) => testSandboxMessaging(input),
  "pancake-fanpage": (input, deps) => testPancakeFanpage(input, deps),
  "meta-ads-org": (input, deps) => testMetaAdsOrg(input, deps),
  "pancake-pos-org": (input, deps) => testPancakePosOrg(input, deps),
};
