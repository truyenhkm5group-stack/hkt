/**
 * ═══════════ AI BUILDER — BẢN NHÁP, XEM TRƯỚC, ÁP DỤNG (Phase 8 · §3) — CHỈ MÁY CHỦ ═══════════
 *
 * Tệp THƯỜNG (không "use server") để bài kiểm gọi thẳng với `SessionUser` dựng tay — cùng mẫu `lib/blueprints/admin.ts`.
 * Server action (`lib/actions/ai-builder.ts`) chỉ là vỏ: đọc phiên → hàm ở đây → `revalidatePath`.
 *
 *  · Quyền: `metadata:manage` + phiên mang tổ chức TRÙNG ngữ cảnh (`blueprintAdminDenial` + so mã tổ chức). Quyền của
 *    từng BƯỚC cài (bật module, vai trò, luật…) do kế hoạch Phase 7 đánh dấu BỊ CHẶN — AI không vượt được.
 *  · Ghi: CHỈ bảng `ai_blueprint_drafts` của CSDL tổ chức ngữ cảnh. Mọi thực thể cấu hình do `installBlueprint` ghi
 *    qua dịch vụ sẵn có, với `expectedPlanHash` của đúng kế hoạch người đã xem.
 *  · Người bỏ chọn mục ⇒ MÁY CHỦ lọc gói đã lưu theo danh sách khoá (`filterBlueprint`) — client không gửi gói.
 *  · Sổ dùng AI (`platform_ai_usage`, ai-usage.md): MỖI lượt soạn ghi ĐÚNG một dòng qua `recordAiUsage()` với nguồn tính
 *    tiền đúng (BYOK · PLATFORM · HOME). Hạn mức AI (`checkAiQuota`) kiểm SAU khi biết nguồn và TRƯỚC khi gọi model:
 *    vượt trần ⇒ một dòng `BLOCKED_QUOTA`, không gọi model, không tạo nháp.
 *  · Vòng đời DRAFT → APPLIED | DISCARDED, chuyển có điều kiện `status = 'DRAFT'` trong câu UPDATE (bấm hai lần không
 *    áp dụng hai lần). Mỗi bước một dòng `audit_logs` mang khoá tài khoản (luật 34).
 */
import { and, count, desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";
import { blueprintAdminDenial, sanitizeResolutions } from "@/lib/blueprints/admin";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { checkEntitlement } from "@/lib/entitlements/check";
import type { ApplyResult, Blueprint, BlueprintIssue, BlueprintPlan, BlueprintValidation } from "@/lib/blueprints/types";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { draftBlueprint } from "@/lib/ai-builder/draft";
import { readOrgBuilderState } from "@/lib/ai-builder/metadata";
import { getBuilderAi } from "@/lib/ai-builder/provider";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import { filterBlueprint, sanitizeExcludedKeys, summarizeDraft } from "@/lib/ai-builder/select";
import {
  AI_BUILDER_LIMITS,
  AI_BUILDER_MODES,
  type AiBuilderMode,
  type AiBuilderResult,
  type AiBuilderView,
  type AiDraftListRow,
  type AiDraftStatus,
  type AiDraftView,
  type AiSourceKind,
} from "@/lib/ai-builder/types";

type Row = typeof schema.aiBlueprintDrafts.$inferSelect;
type OrgRef = { code: string; name: string; isHome: boolean };

/** Nguồn tính tiền của sổ AI theo nguồn provider của AI Builder. */
export function billingSourceOf(source: AiSourceKind): AiBillingSource {
  return source === "ORG_CONNECTION" ? "BYOK" : source;
}

function fail<T>(error: string): AiBuilderResult<T> {
  return { ok: false, error };
}

async function guard(user: SessionUser): Promise<OrgRef | { error: string }> {
  const denial = blueprintAdminDenial(user);
  if (denial) return { error: denial };
  const ctx = await currentOrganization();
  if (user.organization && user.organization.code !== ctx.code) return { error: "Phiên đăng nhập thuộc tổ chức khác với ngữ cảnh đang chạy — tải lại trang." };
  const org = await findOrganization(ctx.code);
  return { code: ctx.code, name: org?.name ?? user.organization?.name ?? ctx.code, isHome: ctx.isHome };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function issues(v: unknown): BlueprintIssue[] {
  return Array.isArray(v) ? v.filter((x): x is BlueprintIssue => !!x && typeof x === "object" && typeof (x as BlueprintIssue).message === "string").map((x) => ({ path: String(x.path ?? ""), message: x.message })) : [];
}

function toView(row: Row): AiDraftView {
  const validation = (row.validation ?? {}) as Partial<BlueprintValidation>;
  const errors = issues(validation.errors);
  const bp = row.blueprint as Record<string, unknown> | null;
  return {
    id: row.id,
    mode: row.mode as AiBuilderMode,
    prompt: row.prompt,
    status: row.status as AiDraftStatus,
    name: bp && typeof bp.name === "string" ? bp.name : null,
    valid: row.valid,
    error: row.error,
    errors,
    warnings: issues(validation.warnings),
    groups: bp ? summarizeDraft(bp, strings(row.contextKeys), errors) : [],
    excludedKeys: strings(row.excludedKeys),
    installId: row.installId,
    aiSource: (row.aiSource as AiSourceKind | null) ?? null,
    provider: row.provider,
    model: row.model,
    aiCalls: row.aiCalls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    createdByEmail: row.createdByEmail,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    discardedAt: row.discardedAt ? row.discardedAt.toISOString() : null,
  };
}

function toListRow(row: Row): AiDraftListRow {
  const v = toView(row);
  return { id: v.id, mode: v.mode, prompt: v.prompt, status: v.status, name: v.name, valid: v.valid, aiCalls: v.aiCalls, costUsd: v.costUsd, createdAt: v.createdAt, createdByEmail: v.createdByEmail };
}

async function findDraft(id: unknown): Promise<Row | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(id)) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.aiBlueprintDrafts).where(eq(schema.aiBlueprintDrafts.id, id)).limit(1);
  return row ?? null;
}

async function usedToday(now = new Date()): Promise<number> {
  const db = await getDb();
  const [r] = await db.select({ n: count() }).from(schema.aiBlueprintDrafts).where(gte(schema.aiBlueprintDrafts.createdAt, dauNgayVN(now)));
  return Number(r?.n ?? 0);
}

// ───────────────────────────── ĐỌC ─────────────────────────────

export async function loadAiBuilderView(user: SessionUser): Promise<AiBuilderResult<AiBuilderView>> {
  const org = await guard(user);
  if ("error" in org) return fail(org.error);
  const ai = await getBuilderAi();
  const db = await getDb();
  const rows = await db.select().from(schema.aiBlueprintDrafts).orderBy(desc(schema.aiBlueprintDrafts.createdAt)).limit(50);
  return {
    ok: true,
    value: {
      organization: org,
      ai: ai.ok ? { available: true, source: ai.ai.source, provider: ai.ai.provider.name, model: ai.ai.provider.model, reason: null } : { available: false, source: null, provider: null, model: null, reason: ai.reason },
      usedToday: await usedToday(),
      limits: AI_BUILDER_LIMITS,
      drafts: rows.map(toListRow),
    },
  };
}

export async function loadDraft(user: SessionUser, id: unknown): Promise<AiBuilderResult<AiDraftView>> {
  const org = await guard(user);
  if ("error" in org) return fail(org.error);
  const row = await findDraft(id);
  return row ? { ok: true, value: toView(row) } : fail("Không có bản nháp này trong tổ chức.");
}

// ───────────────────────────── TẠO NHÁP ─────────────────────────────

export async function createDraft(user: SessionUser, input: { mode?: unknown; prompt?: unknown }): Promise<AiBuilderResult<AiDraftView>> {
  const org = await guard(user);
  if ("error" in org) return fail(org.error);
  const mode = AI_BUILDER_MODES.find((m) => m === input.mode);
  if (!mode) return fail("Chế độ phải là dựng mới hoặc sửa lặp.");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length < 10) return fail("Mô tả quá ngắn — viết ít nhất một câu về doanh nghiệp hoặc thay đổi cần làm.");
  if (prompt.length > AI_BUILDER_LIMITS.maxPromptChars) return fail(`Mô tả dài quá ${AI_BUILDER_LIMITS.maxPromptChars} ký tự.`);
  if ((await usedToday()) >= AI_BUILDER_LIMITS.maxDraftsPerDay) return fail(`Tổ chức đã dùng hết ${AI_BUILDER_LIMITS.maxDraftsPerDay} lượt soạn hôm nay — thử lại ngày mai.`);
  // Hạn mức GÓI (Phase 10 · §5) — riêng với trần kỹ thuật ở trên, và kiểm TRƯỚC khi gọi AI: vượt gói thì không tốn một
  // token nào. Tổ chức nhà = nội bộ, không đếm gì.
  const ent = await checkEntitlement("aiDraftsPerDay", 1);
  if (!ent.ok) return fail(ent.error);
  const ai = await getBuilderAi();
  if (!ai.ok) return fail(ai.reason);
  const billing = billingSourceOf(ai.ai.source);
  const usageBase = { orgCode: org.code, feature: "ai_builder" as const, source: billing, provider: ai.ai.provider.name, model: ai.ai.provider.model, actorId: user.id };
  const quota = await checkAiQuota(org.code, billing);
  if (!quota.ok) {
    await recordAiUsage({ ...usageBase, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, status: "BLOCKED_QUOTA" });
    return fail(quota.error);
  }

  const state = await readOrgBuilderState();
  let outcome: Awaited<ReturnType<typeof draftBlueprint>> | null = null;
  let failure: string | null = null;
  try {
    outcome = await draftBlueprint(prompt, { mode, provider: ai.ai.provider, metadata: mode === "edit" ? state.snapshot : null, org: { enabledModules: state.enabledModules, customDefs: state.customDefs } });
  } catch (e) {
    // Câu lỗi của SDK không mang khoá (khoá đi trong header) — vẫn cắt ngắn, không in chồng stack.
    failure = `Gọi AI hỏng: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
  }

  const db = await getDb();
  const [row] = await db
    .insert(schema.aiBlueprintDrafts)
    .values({
      mode,
      prompt,
      status: "DRAFT",
      blueprint: outcome?.blueprint ?? null,
      contextKeys: outcome?.contextKeys ?? [],
      valid: outcome?.validation.ok === true,
      validation: outcome?.validation ?? { ok: false, errors: [{ path: "", message: failure ?? "Không rõ" }], warnings: [] },
      error: outcome?.error ?? failure,
      aiSource: ai.ai.source,
      provider: outcome?.provider ?? ai.ai.provider.name,
      model: outcome?.model ?? ai.ai.provider.model,
      aiCalls: outcome?.calls ?? 1,
      inputTokens: outcome ? outcome.usage.inputTokens + outcome.usage.cacheReadTokens + outcome.usage.cacheWriteTokens : 0,
      outputTokens: outcome?.usage.outputTokens ?? 0,
      costUsd: outcome?.costUsd ?? null,
      createdBy: user.id,
      createdByEmail: user.email,
    })
    .returning();
  // Lượt hỏng giữa chừng (SDK ném): số lời gọi / token / tiền CHƯA BIẾT ⇒ NULL, không phải 0 (luật 42).
  await recordAiUsage({
    ...usageBase,
    provider: row.provider,
    model: row.model,
    requests: outcome?.calls ?? 1,
    inputTokens: outcome ? row.inputTokens : null,
    outputTokens: outcome ? row.outputTokens : null,
    costUsd: outcome ? outcome.costUsd : null,
    status: outcome ? "OK" : "ERROR",
    ref: row.id,
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "AI_BLUEPRINT_DRAFT_CREATE",
    entity: "ai_blueprint_draft",
    entityId: row.id,
    after: { mode, valid: row.valid, errors: (outcome?.validation.errors.length ?? 1), calls: row.aiCalls, source: row.aiSource, provider: row.provider, model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, blueprintKey: outcome?.blueprint?.key ?? null },
    reason: prompt.slice(0, 300),
  });
  return { ok: true, value: { ...toView(row), quotaWarning: quota.warning } };
}

// ───────────────────────────── XEM TRƯỚC / ÁP DỤNG / BỎ ─────────────────────────────

type Usable = { row: Row; bp: Blueprint; excluded: string[] };

async function usableDraft(id: unknown, rawExcluded: unknown): Promise<Usable | { error: string }> {
  const row = await findDraft(id);
  if (!row) return { error: "Không có bản nháp này trong tổ chức." };
  if (row.status !== "DRAFT") return { error: row.status === "APPLIED" ? "Bản nháp đã được áp dụng." : "Bản nháp đã bị bỏ." };
  if (!row.blueprint) return { error: row.error ?? "Bản nháp không có gói cấu hình nào để áp dụng." };
  const context = strings(row.contextKeys);
  const excluded = sanitizeExcludedKeys(rawExcluded, row.blueprint, context);
  return { row, bp: filterBlueprint(row.blueprint as Blueprint, excluded, context), excluded };
}

export async function previewDraft(user: SessionUser, id: unknown, input: { excludedKeys?: unknown; resolutions?: unknown } = {}): Promise<AiBuilderResult<{ plan: BlueprintPlan; excludedKeys: string[] }>> {
  const org = await guard(user);
  if ("error" in org) return fail(org.error);
  const d = await usableDraft(id, input.excludedKeys);
  if ("error" in d) return fail(d.error);
  const plan = await planForOrg(d.bp, user, sanitizeResolutions(input.resolutions));
  return { ok: true, value: { plan, excludedKeys: d.excluded } };
}

function refused(message: string, path = ""): ApplyResult {
  return { ok: false, installId: null, failedStep: null, errors: [{ path, message }], outcomes: [] };
}

export async function applyDraft(user: SessionUser, id: unknown, input: { planHash?: unknown; excludedKeys?: unknown; resolutions?: unknown }): Promise<ApplyResult> {
  const org = await guard(user);
  if ("error" in org) return refused(org.error);
  if (typeof input.planHash !== "string" || !input.planHash) return refused("Thiếu kế hoạch đã xem trước — xem trước rồi mới áp dụng.", "planHash");
  const d = await usableDraft(id, input.excludedKeys);
  if ("error" in d) return refused(d.error);
  const resolutions = sanitizeResolutions(input.resolutions);
  const result = await installBlueprint(d.bp, user, { expectedPlanHash: input.planHash, resolutions });
  const db = await getDb();
  if (result.ok) {
    await db
      .update(schema.aiBlueprintDrafts)
      .set({ status: "APPLIED", installId: result.installId, planHash: input.planHash, excludedKeys: d.excluded, appliedAt: new Date(), appliedBy: user.id, updatedAt: new Date() })
      .where(and(eq(schema.aiBlueprintDrafts.id, d.row.id), eq(schema.aiBlueprintDrafts.status, "DRAFT")));
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: result.ok ? "AI_BLUEPRINT_DRAFT_APPLY" : "AI_BLUEPRINT_DRAFT_APPLY_FAILED",
    entity: "ai_blueprint_draft",
    entityId: d.row.id,
    before: { status: d.row.status },
    after: { status: result.ok ? "APPLIED" : "DRAFT", installId: result.installId, excludedKeys: d.excluded, resolutions, done: result.outcomes.filter((o) => o.status === "DONE").length },
    reason: result.ok ? undefined : result.errors.map((e) => e.message).join(" · ").slice(0, 500),
    correlationId: result.installId ?? undefined,
  });
  return result;
}

export async function discardDraft(user: SessionUser, id: unknown): Promise<AiBuilderResult<AiDraftView>> {
  const org = await guard(user);
  if ("error" in org) return fail(org.error);
  const row = await findDraft(id);
  if (!row) return fail("Không có bản nháp này trong tổ chức.");
  if (row.status !== "DRAFT") return fail("Chỉ bỏ được bản nháp chưa áp dụng.");
  const db = await getDb();
  const [next] = await db
    .update(schema.aiBlueprintDrafts)
    .set({ status: "DISCARDED", discardedAt: new Date(), discardedBy: user.id, updatedAt: new Date() })
    .where(and(eq(schema.aiBlueprintDrafts.id, row.id), eq(schema.aiBlueprintDrafts.status, "DRAFT")))
    .returning();
  if (!next) return fail("Bản nháp vừa đổi trạng thái — tải lại.");
  await audit({ userId: user.id, userEmail: user.email, action: "AI_BLUEPRINT_DRAFT_DISCARD", entity: "ai_blueprint_draft", entityId: row.id, before: { status: "DRAFT" }, after: { status: "DISCARDED" } });
  return { ok: true, value: toView(next) };
}
