import { buildAdBots, CHATBOT_AD_BOTS_KEY, DEFAULT_AD_BOT_CONFIG, type AdBotConfig, type AdBotLine } from "@/lib/constants/chatbot-ad-bots";
import { chatbotConfig, chatbotFetch } from "@/lib/integrations/chatbot/client";
import { peekIsNonHome } from "@/lib/platform/credentials";
import { listAdBotSources } from "@/lib/queries/chatbot-ad-bots";
import { getDb } from "@/db";
import { readCreativeImage } from "@/lib/creative/images";
import { getSettingJson } from "@/lib/settings";

/**
 * Đồng bộ "bot riêng theo quảng cáo" sang container bot: ERP dựng CẢ BỘ rồi `PUT /api/erp/ad-bots`
 * (bot thay nguyên bộ — camp tắt / đổi mẫu tự rơi). Chạy khi người lưu trên trang, và lồng sau lượt
 * `creative-loop` (camp test mới lên) cùng `facebook-ads` — không có lịch riêng.
 */

export async function getAdBotConfig(): Promise<AdBotConfig> {
  const c = await getSettingJson<AdBotConfig>(CHATBOT_AD_BOTS_KEY, DEFAULT_AD_BOT_CONFIG);
  return { enabled: c.enabled !== false, overrides: c.overrides && typeof c.overrides === "object" ? c.overrides : {}, imageSpend: Array.isArray(c.imageSpend) ? c.imageSpend : [] };
}

export type AdBotPushResult = { ok: true; pushed: number; accepted: number; skippedByBot: number } | { ok: false; pushed: number; error: string };

/**
 * Ảnh màu của mẫu test đi sang bot bằng BYTE (khoá = sha256 nội dung) — không cần một đường link công khai nào ra Internet.
 * Bot trả danh sách sha còn thiếu sau lượt PUT; chỉ gửi đúng những ảnh ấy (gửi lại cùng ảnh là không làm gì).
 */
async function uploadMissingImages(config: AdBotConfig, missing: string[]): Promise<string | null> {
  if (!missing.length) return null;
  const bySha = new Map<string, string>();
  for (const o of Object.values(config.overrides)) for (const c of o.test?.colors ?? []) bySha.set(c.sha, c.imageId);
  const db = await getDb();
  for (const sha of missing) {
    const imageId = bySha.get(sha);
    const px = imageId ? await readCreativeImage(db, imageId) : null;
    if (!px) return `Ảnh ${sha.slice(0, 8)}… không còn trong ERP (đã bị dọn) — xoá màu đó và tạo lại.`;
    const res = await chatbotFetch("/api/erp/ad-images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, contentType: px.contentType, data: px.bytes.toString("base64") }),
      timeoutMs: 20000,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return `Bot không nhận ảnh: ${b.error || `HTTP ${res.status}`}`;
    }
  }
  return null;
}

export async function pushAdBots(): Promise<AdBotPushResult> {
  const [rows, config] = await Promise.all([listAdBotSources(), getAdBotConfig()]);
  const { push } = buildAdBots(rows, config);
  try {
    const res = await chatbotFetch("/api/erp/ad-bots", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bots: push }),
      timeoutMs: 8000,
    });
    const body = (await res.json().catch(() => ({}))) as { count?: number; skipped?: number; error?: string; missingImages?: string[] };
    if (!res.ok) return { ok: false, pushed: push.length, error: body.error || `Bot trả HTTP ${res.status}` };
    const imgErr = await uploadMissingImages(config, Array.isArray(body.missingImages) ? body.missingImages : []);
    if (imgErr) return { ok: false, pushed: push.length, error: imgErr };
    return { ok: true, pushed: push.length, accepted: Number(body.count ?? 0), skippedByBot: Number(body.skipped ?? 0) };
  } catch (e) {
    return { ok: false, pushed: push.length, error: `Không gửi được sang bot: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Lượt lồng sau job nền: chỉ chạy khi máy chủ có bot (có khoá nội bộ) và là tổ chức nhà. Không bao giờ ném —
 * một bot chat chưa chạy không được làm hỏng lượt đăng camp / kéo chi tiêu quảng cáo.
 */
export async function pushAdBotsFromJob(): Promise<string> {
  if (peekIsNonHome() || !chatbotConfig().token) return "";
  const r = await pushAdBots().catch((e: unknown) => ({ ok: false as const, pushed: 0, error: e instanceof Error ? e.message : String(e) }));
  return r.ok ? `bot riêng QC: gửi ${r.accepted}` : `bot riêng QC chưa gửi được: ${r.error}`.slice(0, 200);
}

export type AdSeen = { count: number; firstAt?: string; lastAt?: string; pageId?: string; matched: string | null };
export type BotAdStatus = { reachable: true; syncedAt: string | null; count: number; seen: Record<string, AdSeen>; missingImages: string[] } | { reachable: false; error: string };

export async function getBotAdStatus(): Promise<BotAdStatus> {
  try {
    const res = await chatbotFetch("/api/erp/ad-bots", { timeoutMs: 4000 });
    if (!res.ok) return { reachable: false, error: `Bot trả HTTP ${res.status}` };
    const b = (await res.json()) as { syncedAt: string | null; count: number; seen: Record<string, AdSeen>; missingImages?: string[] };
    return { reachable: true, syncedAt: b.syncedAt ?? null, count: Number(b.count ?? 0), seen: b.seen ?? {}, missingImages: Array.isArray(b.missingImages) ? b.missingImages : [] };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadAdBotLines(): Promise<{ lines: AdBotLine[]; config: AdBotConfig }> {
  const [rows, config] = await Promise.all([listAdBotSources(), getAdBotConfig()]);
  return { lines: buildAdBots(rows, config).lines, config };
}
