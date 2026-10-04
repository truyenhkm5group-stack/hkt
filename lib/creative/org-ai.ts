import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { ByokGeminiProvider, ByokOpenAiProvider, GEMINI_DEFAULT_MODEL } from "@/lib/ai-builder/providers";
import type { AiProvider } from "@/lib/ai/provider";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { aiKillSwitchDenial } from "@/lib/ai-usage/control";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import type { AiUsageFeature } from "@/lib/ai-usage/types";
import { openActiveConnection } from "@/lib/connectors/service";
import { CREATIVE_INDUSTRY_SETTING_KEY, FOOD_FACT_FIELDS, foodFactLines, isCreativeIndustry, resolveCreativeIndustry, type CreativeIndustry, type CreativeIndustryResolution } from "@/lib/constants/creative-industry";
import { geminiByokImage, openAiByokImage, scrubKey, type ByokImageDeps } from "@/lib/creative/byok-image";
import { captionFromImage, captionFromImageWithProvider, type VariantCaptioner } from "@/lib/creative/caption";
import { assertPixelSafe, editImage, type ImageEditClient, type ImageEditInput, type ImageEditResult } from "@/lib/integrations/openai/images";
import { currentOrganization } from "@/lib/platform/context";
import { assertConnectionOwner } from "@/lib/platform/credentials";
import { findOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ AI CỦA THƯ VIỆN MEDIA THEO TỔ CHỨC — CHỈ MÁY CHỦ (chủ shop 04/10/2026) ═══════════
 *
 * Ai trả tiền vẽ ảnh / viết câu chữ:
 *
 *   tổ chức NHÀ   ⇒ khoá môi trường của nhà, ĐÚNG đường cũ (`editImage` · `captionFromImage`, mỗi lối gọi mạng có
 *                   `assertHomeCredentials`). Tệp này trả lại nguyên các hàm ấy — không bọc, không đổi một tham số.
 *   tổ chức KHÁCH ⇒ khoá AI của CHÍNH tổ chức (`openai-byok` rồi `gemini-byok`, `openActiveConnection` — AAD gắn tổ chức).
 *                   Không có kết nối đang bật ⇒ KHÔNG vẽ, câu lỗi chỉ đúng chỗ cần làm. Không bao giờ lùi về khoá của nhà.
 *
 * Mỗi lời gọi model bằng khoá của tổ chức đi qua `gate()`: (1) chủ khoá — ngữ cảnh hiện hành vẫn là tổ chức đã mở kết nối
 * (`assertConnectionOwner`); (2) công tắc AI của người vận hành (`aiKillSwitchDenial`); (3) hạn mức của gói (`checkAiQuota`,
 * nguồn `BYOK` — bị chặn thì ghi MỘT dòng `BLOCKED_QUOTA` và không gọi). Xong mỗi lời gọi ghi MỘT dòng sổ dùng AI
 * (`recordAiUsage`, tính năng `creative_image` / `creative_copy`) — tiền `null` khi chưa có bảng giá (CHƯA BIẾT, không 0).
 *
 * Vòng mẫu TỰ ĐỘNG (lập lô, đọc gen nguồn, viết câu chữ trước ảnh — `lib/creative/loop.ts`) VẪN CHỈ CHẠY Ở NHÀ: đường gen TAY
 * (người bấm) là đường duy nhất tổ chức khách dùng được ở bản này.
 */

export const CREATIVE_BYOK_CONNECTORS = ["openai-byok", "gemini-byok"] as const;
export type CreativeByokConnector = (typeof CREATIVE_BYOK_CONNECTORS)[number];

const CONNECTOR_LABEL: Record<CreativeByokConnector, string> = { "openai-byok": "OpenAI — khoá của tổ chức", "gemini-byok": "Google Gemini — khoá của tổ chức" };

// ───────────────────────────── NGÀNH ─────────────────────────────

/** Ngành của Thư viện Media cho tổ chức NGỮ CẢNH — đọc mẫu ngành ở sổ tổ chức + ghi đè trong `settings` của chính tổ chức. */
export async function readCreativeIndustry(db: Db): Promise<CreativeIndustryResolution> {
  const org = await currentOrganization();
  if (org.isHome) return resolveCreativeIndustry({ isHome: true, templateKey: null });
  const [row, setting] = await Promise.all([findOrganization(org.code), db.query.settings.findFirst({ where: eq(schema.settings.key, CREATIVE_INDUSTRY_SETTING_KEY) }).catch(() => null)]);
  let override: unknown = null;
  if (setting) {
    try {
      override = JSON.parse(setting.value);
    } catch {
      override = null;
    }
  }
  return resolveCreativeIndustry({ isHome: false, templateKey: row?.templateKey ?? null, override });
}

/** Ghi đè ngành (người quản trị bấm). `null` ⇒ bỏ ghi đè, quay về mẫu ngành. Tổ chức nhà KHÔNG đổi được (luôn thời trang). */
export async function writeCreativeIndustry(db: Db, industry: CreativeIndustry | null): Promise<{ ok: true } | { error: string }> {
  const org = await currentOrganization();
  if (org.isHome) return { error: "Tổ chức nhà luôn dùng gói thời trang — không đổi ngành ở đây." };
  if (industry === null) {
    await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_INDUSTRY_SETTING_KEY));
    return { ok: true };
  }
  if (!isCreativeIndustry(industry)) return { error: "Ngành không hợp lệ." };
  const value = JSON.stringify(industry);
  await db.insert(schema.settings).values({ key: CREATIVE_INDUSTRY_SETTING_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return { ok: true };
}

/**
 * DỮ KIỆN SẢN PHẨM cho câu chữ thực phẩm: field tuỳ biến của mẫu ngành (quy cách, khối lượng tịnh, bảo quản…) + tên shop.
 * Chỉ ĐỌC; chỉ các khoá trong `FOOD_FACT_FIELDS` — field nội bộ không bao giờ vào lời nhắc.
 */
export async function loadFoodFacts(db: Db, productId: string | null): Promise<string[]> {
  const org = await currentOrganization();
  const shop = org.isHome ? null : await findOrganization(org.code);
  const out: string[] = [];
  if (productId) {
    const cv = schema.customValues;
    const [row] = await db
      .select({ values: cv.values })
      .from(cv)
      .where(and(eq(cv.objectKey, "product"), inArray(cv.recordId, [productId])))
      .limit(1)
      .catch(() => []);
    const values = (row?.values ?? {}) as Record<string, unknown>;
    out.push(...foodFactLines(Object.fromEntries(FOOD_FACT_FIELDS.map((k) => [k, values[k]]))));
  }
  if (shop?.name) out.push(`Tên shop: ${shop.name}`);
  return out;
}

// ───────────────────────────── KẾT NỐI AI CỦA TỔ CHỨC ─────────────────────────────

type OpenedAi = {
  connectorKey: CreativeByokConnector;
  owner: string;
  apiKey: string;
  /** Model vẽ ảnh; `null` = kết nối này chưa vẽ được (Gemini chưa khai «Model vẽ ảnh»). */
  imageModel: string | null;
  imageReason: string | null;
  chatModel: string;
};

/** Trạng thái để màn hình / action đọc — KHÔNG mang khoá. */
export type CreativeAiStatus =
  | { mode: "HOME" }
  | { mode: "BYOK"; connectorKey: CreativeByokConnector; label: string; imageModel: string | null; imageReady: boolean; imageReason: string | null; copyConnector: CreativeByokConnector; chatModel: string }
  | { mode: "NONE"; reason: string };

const NO_KEY_REASON =
  "Tổ chức chưa có khoá AI để vẽ ảnh / viết câu chữ: vào Cài đặt → Kết nối dữ liệu, thêm «OpenAI — khoá của tổ chức» (vẽ bằng gpt-image) hoặc «Google Gemini — khoá của tổ chức» (khai thêm ô «Model vẽ ảnh»), bấm Kiểm tra rồi Bật. Tổ chức trả tiền token trên khoá của mình.";

async function openOne(key: CreativeByokConnector, owner: string, fallbackOpenAiImageModel: string): Promise<OpenedAi | { reason: string }> {
  const c = await openActiveConnection(key);
  if (!c.ok) return { reason: c.reason };
  const apiKey = c.secrets.apiKey ?? "";
  if (!apiKey) return { reason: `Kết nối «${CONNECTOR_LABEL[key]}» chưa có khoá.` };
  const imageModelSetting = (c.settings.imageModel ?? "").trim();
  if (key === "openai-byok") {
    return { connectorKey: key, owner, apiKey, imageModel: imageModelSetting || fallbackOpenAiImageModel, imageReason: null, chatModel: (c.settings.model ?? "").trim() || MODEL_BY_TIER.openai.routine };
  }
  return {
    connectorKey: key,
    owner,
    apiKey,
    imageModel: imageModelSetting || null,
    imageReason: imageModelSetting ? null : "Kết nối Gemini chưa khai «Model vẽ ảnh» — ERP không đoán model (khoá Gemini mới không gọi được mọi dòng). Mở Kết nối dữ liệu → Google Gemini, điền model vẽ ảnh khoá của bạn dùng được trong AI Studio.",
    chatModel: (c.settings.model ?? "").trim() || GEMINI_DEFAULT_MODEL,
  };
}

/**
 * Mở kết nối AI của tổ chức ngữ cảnh cho MỘT việc. Vẽ ảnh: kết nối đầu tiên (OpenAI rồi Gemini) VẼ ĐƯỢC; viết câu chữ: kết nối
 * đầu tiên đang bật. Tổ chức nhà ⇒ `HOME` (dùng đường môi trường). Không có ⇒ lý do cụ thể.
 */
async function openCreativeAi(purpose: "image" | "copy", fallbackOpenAiImageModel: string): Promise<{ mode: "HOME" } | { mode: "BYOK"; ai: OpenedAi } | { mode: "NONE"; reason: string }> {
  const org = await currentOrganization();
  if (org.isHome) return { mode: "HOME" };
  const reasons: string[] = [];
  for (const key of CREATIVE_BYOK_CONNECTORS) {
    const o = await openOne(key, org.code, fallbackOpenAiImageModel);
    if ("reason" in o) continue;
    if (purpose === "image" && !o.imageModel) {
      reasons.push(o.imageReason ?? "");
      continue;
    }
    return { mode: "BYOK", ai: o };
  }
  return { mode: "NONE", reason: reasons.filter(Boolean)[0] ?? NO_KEY_REASON };
}

/** Trạng thái AI của Thư viện Media cho tổ chức ngữ cảnh — để màn hình nói TRƯỚC khi bấm và để action chặn lượt chắc chắn hỏng. */
export async function creativeAiStatus(fallbackOpenAiImageModel: string): Promise<CreativeAiStatus> {
  const img = await openCreativeAi("image", fallbackOpenAiImageModel);
  if (img.mode === "HOME") return { mode: "HOME" };
  const copy = await openCreativeAi("copy", fallbackOpenAiImageModel);
  if (img.mode === "BYOK") return { mode: "BYOK", connectorKey: img.ai.connectorKey, label: CONNECTOR_LABEL[img.ai.connectorKey], imageModel: img.ai.imageModel, imageReady: true, imageReason: null, copyConnector: copy.mode === "BYOK" ? copy.ai.connectorKey : img.ai.connectorKey, chatModel: copy.mode === "BYOK" ? copy.ai.chatModel : img.ai.chatModel };
  if (copy.mode === "BYOK") return { mode: "BYOK", connectorKey: copy.ai.connectorKey, label: CONNECTOR_LABEL[copy.ai.connectorKey], imageModel: null, imageReady: false, imageReason: img.mode === "NONE" ? img.reason : null, copyConnector: copy.ai.connectorKey, chatModel: copy.ai.chatModel };
  return { mode: "NONE", reason: img.mode === "NONE" ? img.reason : NO_KEY_REASON };
}

// ───────────────────────────── CỔNG MỖI LỜI GỌI + SỔ DÙNG AI ─────────────────────────────

async function gate(ai: OpenedAi, feature: AiUsageFeature, model: string, actorId: string | null, ref: string): Promise<void> {
  await assertConnectionOwner(ai.connectorKey, ai.owner);
  const killed = await aiKillSwitchDenial(ai.owner);
  if (killed) throw new Error(killed);
  const quota = await checkAiQuota(ai.owner, "BYOK");
  if (!quota.ok) {
    await recordAiUsage({ orgCode: ai.owner, feature, source: "BYOK", provider: ai.connectorKey, model, requests: 0, inputTokens: null, outputTokens: null, costUsd: null, status: "BLOCKED_QUOTA", actorId, ref }).catch(() => undefined);
    throw new Error(quota.error);
  }
}

/** Model vẽ của lượt: lượt đã ghi model cùng họ với kết nối ⇒ dùng; khác họ (kết nối vừa đổi) ⇒ model của kết nối. */
function imageModelFor(ai: OpenedAi, recorded: string): string {
  const r = recorded.trim();
  if (ai.connectorKey === "gemini-byok") return r.startsWith("gemini") ? r : (ai.imageModel ?? r);
  return r.startsWith("gpt-image") || r.startsWith("dall-e") ? r : (ai.imageModel ?? r);
}

function byokImageClient(ai: OpenedAi, deps: ByokImageDeps & { actorId?: string | null; ref?: string }): ImageEditClient {
  return async (input: ImageEditInput): Promise<ImageEditResult> => {
    // Hàng rào điểm ảnh TRƯỚC cổng: lượt bị chặn vì ảnh không an toàn không phải một lượt dùng AI (không ăn hạn mức, không
    // ghi sổ). Lối gửi (`byok-image.ts`) kiểm lại lần nữa — hàng rào ở ranh giới hàm không dựa vào nơi gọi.
    assertPixelSafe(input.images);
    const model = imageModelFor(ai, input.model);
    const ref = deps.ref ?? "manual-gen";
    await gate(ai, "creative_image", model, deps.actorId ?? null, ref);
    const key = { connectorKey: ai.connectorKey, owner: ai.owner, apiKey: ai.apiKey };
    try {
      const res = ai.connectorKey === "gemini-byok" ? await geminiByokImage({ ...input, model }, key, deps) : await openAiByokImage({ ...input, model }, key, deps);
      await recordAiUsage({ orgCode: ai.owner, feature: "creative_image", source: "BYOK", provider: ai.connectorKey, model, requests: 1, inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null, costUsd: res.costUsd, status: "OK", actorId: deps.actorId ?? null, ref }).catch(() => undefined);
      return res;
    } catch (e) {
      await recordAiUsage({ orgCode: ai.owner, feature: "creative_image", source: "BYOK", provider: ai.connectorKey, model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId: deps.actorId ?? null, ref }).catch(() => undefined);
      throw new Error(scrubKey(e instanceof Error ? e.message : String(e), ai.apiKey));
    }
  };
}

/**
 * Máy vẽ của tổ chức ngữ cảnh. Nhà ⇒ `editImage` (NGUYÊN hàm cũ). Khách ⇒ máy vẽ bằng khoá của chính tổ chức; chưa có ⇒ một
 * máy vẽ chỉ NÉM câu lý do (mỗi ảnh `GEN_FAILED` kèm việc phải làm — không lùi về khoá của nhà).
 */
export async function creativeImageClient(fallbackOpenAiImageModel: string, deps: ByokImageDeps & { actorId?: string | null } = {}): Promise<ImageEditClient> {
  const r = await openCreativeAi("image", fallbackOpenAiImageModel);
  if (r.mode === "HOME") return editImage;
  if (r.mode === "NONE") {
    const reason = r.reason;
    return async () => {
      throw new Error(reason);
    };
  }
  return byokImageClient(r.ai, deps);
}

function chatProvider(ai: OpenedAi, fetchImpl?: typeof fetch): AiProvider {
  return ai.connectorKey === "gemini-byok" ? new ByokGeminiProvider({ apiKey: ai.apiKey, model: ai.chatModel, ...(fetchImpl ? { fetch: fetchImpl } : {}) }) : new ByokOpenAiProvider({ apiKey: ai.apiKey, model: ai.chatModel, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/**
 * Bộ viết câu chữ theo ảnh của tổ chức ngữ cảnh. Nhà ⇒ `captionFromImage` (NGUYÊN hàm cũ). Khách ⇒ provider BYOK + cổng mỗi
 * lời gọi + MỘT dòng sổ dùng AI cho cả lượt viết (một lượt có thể là hai lời gọi: viết + viết lại).
 */
export async function creativeCaptioner(deps: { fetchImpl?: typeof fetch; actorId?: string | null } = {}): Promise<VariantCaptioner> {
  const r = await openCreativeAi("copy", "");
  if (r.mode === "HOME") return captionFromImage;
  if (r.mode === "NONE") {
    const reason = r.reason;
    return async () => ({ ok: false, error: reason });
  }
  const ai = r.ai;
  return async (_db, input, cdeps) => {
    const provider = chatProvider(ai, deps.fetchImpl);
    const ref = cdeps.entityId ? `caption:${cdeps.entityId}` : "caption";
    let gateError: string | null = null;
    const out = await captionFromImageWithProvider(input, {
      provider,
      guard: async () => {
        try {
          await gate(ai, "creative_copy", provider.model, deps.actorId ?? null, ref);
        } catch (e) {
          gateError = e instanceof Error ? e.message : String(e);
          throw e;
        }
      },
    });
    // Bị cổng chặn trước lời gọi đầu tiên ⇒ không có lượt dùng nào (dòng BLOCKED_QUOTA đã ghi trong `gate`).
    if (!(gateError !== null && out.requests === 0)) {
      await recordAiUsage({
        orgCode: ai.owner,
        feature: "creative_copy",
        source: "BYOK",
        provider: ai.connectorKey,
        model: out.model,
        requests: out.requests,
        inputTokens: out.requests ? out.usage.inputTokens + out.usage.cacheReadTokens + out.usage.cacheWriteTokens : null,
        outputTokens: out.requests ? out.usage.outputTokens : null,
        costUsd: out.result.ok ? out.result.costUsd : null,
        status: out.result.ok ? "OK" : "ERROR",
        actorId: deps.actorId ?? null,
        ref,
      }).catch(() => undefined);
    }
    return out.result.ok ? out.result : { ok: false, error: scrubKey(out.result.error, ai.apiKey) };
  };
}
