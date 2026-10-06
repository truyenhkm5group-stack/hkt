import { getAiProvider, giaCuaModel, type AiProvider } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { openActiveConnection } from "@/lib/connectors/service";
import { currentOrganization } from "@/lib/platform/context";
import { aiKillSwitchDenial } from "@/lib/ai-usage/control";
import { defaultEnvReader, platformAiConfig, type EnvReader, type PlatformAiConfig } from "@/lib/ai-usage/platform-ai";
import { readPlatformAiPolicy, routePlatformModel, type PlatformAiPolicy, type PlatformModelRoute } from "@/lib/ai-usage/platform-ai-policy";
import { checkAiQuota, resolveAiLimits } from "@/lib/ai-usage/quota";
import { withPlatformFallback, type PlatformPrimaryFailure } from "@/lib/ai-builder/platform-fallback";
import { ByokAnthropicProvider, ByokGeminiProvider, ByokOpenAiProvider, BUILDER_TIMEOUT_MS } from "@/lib/ai-builder/providers";
import type { AiSourceKind } from "@/lib/ai-builder/types";

/**
 * ═══════════ AI CỦA AI BUILDER — AI TRẢ TIỀN, KHOÁ NẰM ĐÂU (Phase 8 · §1, X6, X7 · ai-usage.md) — CHỈ MÁY CHỦ ═══════════
 *
 * Trước mọi thứ: CÔNG TẮC AI của người vận hành (toàn nền tảng + riêng tổ chức, `lib/ai-usage/control.ts`). Tắt ⇒
 * `AI_DISABLED_BY_OPERATOR`, không chọn provider nào, không một byte rời máy — kể cả khi kiểm thử đã ép provider giả.
 *
 * Thứ tự, không bao giờ lẫn sang tổ chức khác:
 *   1. Kết nối AI ĐANG BẬT của CHÍNH tổ chức ngữ cảnh (`anthropic-byok`, rồi `openai-byok`) — khoá giải mã qua
 *      `openActiveConnection` (AAD gắn tổ chức: bản mã chép sang tổ chức khác không giải được). Sổ AI ghi `BYOK`.
 *   2. Tổ chức NHÀ — provider sẵn có (`getAiProvider`, khoá `.env` của nhà), đúng như Copilot. Sổ AI ghi `HOME`.
 *   3. NỀN TẢNG trả tiền (`PLATFORM`) — CHỈ tổ chức KHÔNG phải nhà, CHỈ khi đủ ba điều: biến môi trường bật + có khoá
 *      của nền tảng (KHÁC khoá của nhà), gói có credit > 0, còn credit tháng này. Mặc định TẮT.
 *   4. Không có ⇒ `null` + lý do.
 *
 * Bước 2 hỏi `currentOrganization()` (ngữ cảnh tường minh HOẶC phiên đã ký), không hỏi `peekIsNonHome()`: request thường
 * của một tổ chức khác không mang ngữ cảnh tường minh, và `getAiProvider()` khi đó sẽ trả provider của nhà. Hỏi sai
 * câu ở đây là để khoá của nhà trả tiền (và nhìn thấy dữ liệu cấu hình) cho tổ chức khác. Bước 3 KHÔNG BAO GIỜ gọi
 * `getAiProvider()` — khoá của nền tảng đi tường minh vào provider BYOK-dạng (`baseURL` hằng, `authToken: null`).
 *
 * Tệp này là nơi DUY NHẤT của `lib/ai-builder/*` được import `lib/connectors/*` (bài kiểm quét): phần soạn prompt và
 * tóm tắt metadata không bao giờ chạm bí mật.
 */

export type BuilderAi = { provider: AiProvider; source: AiSourceKind; connectorKey: string | null };
export type BuilderAiResolution = { ok: true; ai: BuilderAi } | { ok: false; reason: string };

/** Hai kết nối AI theo tổ chức, theo thứ tự ưu tiên. */
export const BYOK_CONNECTORS = ["anthropic-byok", "openai-byok"] as const;

let override: BuilderAi | null | undefined;

/** Chỉ cho kiểm thử: ép AI của builder (`null` = không có AI); `undefined` = bỏ ép. Mã sản phẩm không gọi. */
export function setBuilderAiForTests(ai: BuilderAi | null | undefined) {
  override = ai;
}

/**
 * `deps.env` chỉ để bài kiểm đưa môi trường GIẢ vào nhánh nền tảng (không đọc / đặt `process.env` của máy chạy — luật 65).
 */
export async function getBuilderAi(deps: PlatformAiDeps = {}): Promise<BuilderAiResolution> {
  const ctx = await currentOrganization();
  const killed = await aiKillSwitchDenial(ctx.code);
  if (killed) return { ok: false, reason: killed };
  if (override !== undefined) return override ? { ok: true, ai: override } : { ok: false, reason: "AI Builder đang tắt (kiểm thử)." };
  const pending: string[] = [];
  for (const key of BYOK_CONNECTORS) {
    const conn = await openActiveConnection(key);
    if (!conn.ok) {
      if (!conn.reason.startsWith("Chưa có kết nối")) pending.push(conn.reason);
      continue;
    }
    const apiKey = conn.secrets.apiKey ?? "";
    if (!apiKey) {
      pending.push(`Kết nối «${key}» thiếu khoá.`);
      continue;
    }
    const opts = { apiKey, model: conn.settings.model || null, fetch: deps.fetch };
    const provider = key === "anthropic-byok" ? new ByokAnthropicProvider(opts) : new ByokOpenAiProvider(opts);
    return { ok: true, ai: { provider, source: "ORG_CONNECTION", connectorKey: key } };
  }
  if (ctx.isHome) {
    const home = getAiProvider("copilot", { hanChoMs: BUILDER_TIMEOUT_MS });
    if (home) return { ok: true, ai: { provider: home, source: "HOME", connectorKey: null } };
    pending.push(`Tổ chức nhà chưa cấu hình AI: ${aiDisabledReason() ?? "không rõ"}.`);
  } else {
    const platform = await platformAi(ctx.code, deps);
    if (platform.ok) return platform;
    if (platform.reason) pending.push(platform.reason);
  }
  const head = "Tổ chức chưa có kết nối AI đang bật — khai khoá Anthropic hoặc OpenAI của tổ chức ở Kết nối theo tổ chức (/settings/connections), kiểm tra rồi bật.";
  return { ok: false, reason: pending.length ? `${head} ${pending.join(" ")}` : head };
}

/**
 * Nhánh 3 — AI do NỀN TẢNG trả tiền. `reason: null` = nhánh chưa bật (không nói gì thêm với khách: "chưa có kết nối AI"
 * là câu đúng); lý do cụ thể chỉ khi nền tảng ĐÃ bật mà tổ chức này không dùng được.
 */
async function platformAi(orgCode: string, deps: PlatformAiDeps): Promise<{ ok: true; ai: BuilderAi } | { ok: false; reason: string | null }> {
  const cfg = platformAiConfig(deps.env ?? defaultEnvReader);
  if (!cfg.ready) return { ok: false, reason: null };
  const limits = await resolveAiLimits(orgCode);
  if (!limits || !(limits.limits.platformCreditUsdPerMonth > 0)) return { ok: false, reason: null };
  const quota = await checkAiQuota(orgCode, "PLATFORM", { notify: false });
  if (!quota.ok) return { ok: false, reason: quota.error };
  return { ok: true, ai: { provider: platformProvider(cfg, deps.fetch, await platformRoute(cfg, orgCode, deps), deps.onPrimaryFailed), source: "PLATFORM", connectorKey: null } };
}

/**
 * Phụ thuộc của nhánh NỀN TẢNG. `policy` chỉ để bài kiểm đưa chính sách GIẢ vào (`null` = không có chính sách; bỏ trống =
 * đọc `platform.ai.policy`). `routingKey` = khoá băm canary (hội thoại) — trống ⇒ mã tổ chức. `onPrimaryFailed` = lượt hỏng
 * của model chính khi model dự phòng đã đỡ (bên gọi ghi một dòng `ERROR` vào sổ AI).
 */
export type PlatformAiDeps = { fetch?: typeof fetch; env?: EnvReader; policy?: PlatformAiPolicy | null; routingKey?: string | null; now?: Date; onPrimaryFailed?: (f: PlatformPrimaryFailure) => void };

/** Model của lượt này theo Platform AI Policy (`lib/ai-usage/platform-ai-policy.ts`) — không có chính sách ⇒ model của biến môi trường. */
export async function platformRoute(cfg: Extract<PlatformAiConfig, { ready: true }>, orgCode: string, deps: PlatformAiDeps = {}): Promise<PlatformModelRoute> {
  const policy = deps.policy !== undefined ? deps.policy : await readPlatformAiPolicy();
  return routePlatformModel({ baseModel: cfg.model, provider: cfg.provider, policy, now: deps.now ?? new Date(), routingKey: deps.routingKey || orgCode, priced: (m) => giaCuaModel(m) !== null });
}

/**
 * Provider của khoá NỀN TẢNG (đã kiểm sẵn sàng) — nhãn `<nhà cung cấp>-platform` trên sổ AI. Không truyền `route` ⇒ model của
 * biến môi trường (hành vi trước chính sách). Nhánh canary có model dự phòng ⇒ bọc `withPlatformFallback`.
 */
export function platformProvider(cfg: Extract<PlatformAiConfig, { ready: true }>, fetchImpl?: typeof fetch, route?: PlatformModelRoute, onPrimaryFailed?: (f: PlatformPrimaryFailure) => void): AiProvider {
  const make = (model: string): AiProvider => {
    const opts = { apiKey: cfg.apiKey, model, fetch: fetchImpl, name: `${cfg.provider}-platform` };
    return cfg.provider === "gemini" ? new ByokGeminiProvider(opts) : new ByokAnthropicProvider(opts);
  };
  const primary = make(route?.model ?? cfg.model);
  return route?.fallbackModel ? withPlatformFallback(primary, make(route.fallbackModel), onPrimaryFailed) : primary;
}

/**
 * Chatbot bán hàng của tổ chức `orgCode` dùng được AI của NỀN TẢNG không (cùng ba điều kiện của nhánh 3): nền tảng đã bật
 * khoá · gói có credit > 0 · còn credit tháng này. `reason` là câu cho chủ shop.
 */
export async function platformChatAi(orgCode: string, deps: PlatformAiDeps = {}): Promise<{ ok: true; provider: AiProvider } | { ok: false; reason: string }> {
  const cfg = platformAiConfig(deps.env ?? defaultEnvReader);
  if (!cfg.ready) return { ok: false, reason: "Nền tảng chưa bật AI dùng chung — chọn khoá AI riêng của shop, hoặc báo người vận hành." };
  const limits = await resolveAiLimits(orgCode);
  if (!limits || !(limits.limits.platformCreditUsdPerMonth > 0)) return { ok: false, reason: "Gói hiện tại chưa có AI dùng chung — nâng gói, hoặc chọn khoá AI riêng của shop." };
  const quota = await checkAiQuota(orgCode, "PLATFORM", { notify: false });
  if (!quota.ok) return { ok: false, reason: quota.error };
  return { ok: true, provider: platformProvider(cfg, deps.fetch, await platformRoute(cfg, orgCode, deps), deps.onPrimaryFailed) };
}
