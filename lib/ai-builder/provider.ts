import { getAiProvider, type AiProvider } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { openActiveConnection } from "@/lib/connectors/service";
import { currentOrganization } from "@/lib/platform/context";
import { ByokAnthropicProvider, ByokOpenAiProvider, BUILDER_TIMEOUT_MS } from "@/lib/ai-builder/providers";
import type { AiSourceKind } from "@/lib/ai-builder/types";

/**
 * ═══════════ AI CỦA AI BUILDER — AI TRẢ TIỀN, KHOÁ NẰM ĐÂU (Phase 8 · §1, X6, X7) — CHỈ MÁY CHỦ ═══════════
 *
 * Thứ tự, không bao giờ lẫn sang tổ chức khác:
 *   1. Kết nối AI ĐANG BẬT của CHÍNH tổ chức ngữ cảnh (`anthropic-byok`, rồi `openai-byok`) — khoá giải mã qua
 *      `openActiveConnection` (AAD gắn tổ chức: bản mã chép sang tổ chức khác không giải được).
 *   2. Tổ chức NHÀ — provider sẵn có (`getAiProvider`, khoá `.env` của nhà), đúng như Copilot.
 *   3. Không có ⇒ `null` + lý do. KHÔNG có khoá "của nền tảng" dùng chung.
 *
 * Bước 2 hỏi `currentOrganization()` (ngữ cảnh tường minh HOẶC phiên đã ký), không hỏi `peekIsNonHome()`: request thường
 * của một tổ chức khác không mang ngữ cảnh tường minh, và `getAiProvider()` khi đó sẽ trả provider của nhà. Hỏi sai
 * câu ở đây là để khoá của nhà trả tiền (và nhìn thấy dữ liệu cấu hình) cho tổ chức khác.
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

export async function getBuilderAi(deps: { fetch?: typeof fetch } = {}): Promise<BuilderAiResolution> {
  if (override !== undefined) return override ? { ok: true, ai: override } : { ok: false, reason: "AI Builder đang tắt (kiểm thử)." };
  const ctx = await currentOrganization();
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
  }
  const head = "Tổ chức chưa có kết nối AI đang bật — khai khoá Anthropic hoặc OpenAI của tổ chức ở Kết nối theo tổ chức (/settings/connections), kiểm tra rồi bật.";
  return { ok: false, reason: pending.length ? `${head} ${pending.join(" ")}` : head };
}
