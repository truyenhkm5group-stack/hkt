/**
 * ═══════════ MỘT BỘ CÀI BLUEPRINT (Phase 7 · §2) — CHỈ MÁY CHỦ ═══════════
 *
 * `applyBlueprint(plan, actor, { blueprint })` thực thi một kế hoạch ĐÃ LẬP (`planBlueprint`) theo đúng thứ tự phụ
 * thuộc: module → vai trò → field → trạng thái → form → danh sách → trang → luật → cài đặt → ngữ cảnh AI. Mỗi bước gọi
 * DỊCH VỤ SẴN CÓ — không có đường ghi riêng nào (X1, X3):
 *
 *   module   → `toggleOwnModule`      (đường ghi duy nhất của module: kiểm phụ thuộc, hai nhật ký, xoá đệm năng lực)
 *   vai trò  → `saveAccessRoleCore`   (lược đồ chặn luật 31 ở cửa vào)
 *   đối tượng → `createObject` / `updateObject` (Phase 6 — module `apps` đã bật ở bước module)
 *   field    → `createCustomField` / `updateCustomField`
 *   trạng thái → `saveStatusOverrides`
 *   form     → `saveFormDraft` (+ `publishForm` chỉ lần cài đầu khi gói khai `publish`)
 *   danh sách → `saveListViewDraft` (+ `publishListView` như trên)
 *   trang    → `createPage` / `updatePageMeta` + `savePageDraft` (+ `publishPage` như trên)
 *   luật     → `saveRule` — LUÔN sinh / quay về NHÁP + CHẠY THỬ (luật 23, 25); bộ kiểm luật có CSDL chạy ở đây
 *   cài đặt / AI → `setSettingJson` (+ nhật ký TRƯỚC/SAU)
 *
 * Mỗi bước: một dòng nhật ký `BLUEPRINT_STEP` (nối lượt cài bằng `correlationId`) cạnh dòng nhật ký của chính dịch vụ,
 * rồi một dòng `blueprint_items` với băm thực thể ĐỌC LẠI ngay sau khi ghi. Hỏng giữa chừng ⇒ DỪNG, lượt cài thành
 * `FAILED` kèm bước hỏng; các bước đã xong vẫn ở sổ nên chạy lại là đi tiếp (chúng thành UNCHANGED), không nhân đôi.
 *
 * Kế hoạch còn bước BỊ CHẶN thì không ghi gì cả.
 */
import { audit } from "@/lib/audit";
import { saveAccessRoleCore } from "@/lib/auth/access-roles";
import type { SessionUser } from "@/lib/auth/session";
import { createCustomField, updateCustomField } from "@/lib/metadata/fields";
import { createObject, updateObject } from "@/lib/objects/objects";
import { publishForm, saveFormDraft } from "@/lib/metadata/forms";
import { publishListView, saveListViewDraft } from "@/lib/metadata/lists";
import { saveStatusOverrides } from "@/lib/metadata/statuses";
import { loadCustomDefs } from "@/lib/metadata/common";
import type { FieldError } from "@/lib/metadata/types";
import { createPage, publishPage, savePageDraft, updatePageMeta } from "@/lib/pages/registry";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { actorOf } from "@/lib/platform-ui/metadata-admin";
import { toggleOwnModule } from "@/lib/platform-ui/module-toggle";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { saveRule } from "@/lib/workflow/rules";
import { stableHash } from "@/lib/blueprints/hash";
import { finishInstall, recordItem, startInstall } from "@/lib/blueprints/ledger";
import { blueprintItems, type BlueprintItem } from "@/lib/blueprints/plan";
import { projectAi } from "@/lib/blueprints/project";
import { newReadContext, readEntity, type ReadContext } from "@/lib/blueprints/state";
import { fieldValidationOf } from "@/lib/blueprints/validate";
import {
  AI_PROFILE_SETTING_KEY,
  stepKey,
  type ApplyResult,
  type Blueprint,
  type BlueprintField,
  type BlueprintForm,
  type BlueprintListView,
  type BlueprintObject,
  type BlueprintPage,
  type BlueprintPlan,
  type BlueprintRole,
  type BlueprintSetting,
  type BlueprintStatusOverride,
  type BlueprintWorkflow,
  type PlanStep,
  type StepOutcome,
} from "@/lib/blueprints/types";

type StepFailure = { error: string };
type StepDone = { ok: true };

function messages(errors: readonly (FieldError | { path: string; message: string })[]): string {
  return errors.map((e) => e.message).join(" · ") || "Dịch vụ từ chối mà không nói lý do.";
}

function originOf(bp: Blueprint): string {
  return `template:${bp.key}@${bp.version}`;
}

/** Tuỳ chọn gói bỏ đi vẫn phải CÒN (dịch vụ cấm xoá tuỳ chọn đã khai — giá trị đang lưu sẽ thành rác) ⇒ giữ, tắt. */
function mergedOptions(f: BlueprintField, current: { value: string; label: string; color?: string; active: boolean; position: number }[]) {
  const own = (f.options ?? []).map((o, i) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: o.active !== false, position: o.position ?? i }));
  const keep = new Set(own.map((o) => o.value));
  const retired = current.filter((o) => !keep.has(o.value)).map((o, i) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: false, position: own.length + i }));
  return [...own, ...retired];
}

async function runStep(step: PlanStep, it: BlueprintItem, bp: Blueprint, user: SessionUser, ctx: ReadContext): Promise<StepDone | StepFailure> {
  const actor = actorOf(user);
  const reason = `${originOf(bp)} · ${step.action === "CREATE" ? "tạo" : "cập nhật"} theo mẫu`;
  switch (it.kind) {
    case "module": {
      const r = await toggleOwnModule(user, { moduleKey: it.key, enabled: true, reason: `Cài ${originOf(bp)}` });
      return "error" in r ? { error: r.error } : { ok: true };
    }
    case "role": {
      const role = it.item as BlueprintRole;
      const ent = await readEntity("role", it.key, ctx, true);
      const r = await saveAccessRoleCore(
        user,
        { id: ent.ref ?? "", code: role.key.toUpperCase(), name: role.label, description: role.description ?? "", baseRole: role.base, permissions: role.permissions, defaultScope: role.defaultScope ?? "ALL", active: true },
        { reason },
      );
      return "error" in r ? { error: r.error } : { ok: true };
    }
    case "field": {
      const f = it.item as BlueprintField;
      const input = {
        type: f.type,
        label: f.label,
        required: f.required === true,
        validation: fieldValidationOf(f),
        transitions: f.transitions ?? {},
        relationObject: f.relation?.objectKey ?? null,
        helpText: f.helpText?.trim() || null,
        listable: f.listable !== false,
        filterable: f.filterable === true,
      };
      if (step.action === "CREATE") {
        const r = await createCustomField(f.objectKey, { key: f.key, ...input, options: (f.options ?? []).map((o, i) => ({ ...o, position: o.position ?? i })) }, actor);
        return r.ok ? { ok: true } : { error: messages(r.errors) };
      }
      const current = (await loadCustomDefs(f.objectKey, true)).find((d) => d.key === f.key);
      const r = await updateCustomField(f.objectKey, f.key, { ...input, options: mergedOptions(f, current?.options ?? []) }, actor);
      return r.ok ? { ok: true } : { error: messages(r.errors) };
    }
    case "status": {
      const s = it.item as BlueprintStatusOverride;
      const r = await saveStatusOverrides(
        s.objectKey,
        s.field,
        s.options.map((o) => ({ value: o.value, label: o.label.trim() || null, position: o.position, active: o.active })),
        actor,
      );
      return r.ok ? { ok: true } : { error: messages(r.errors) };
    }
    case "form": {
      const f = it.item as BlueprintForm;
      const r = await saveFormDraft(f.objectKey, f.formKey, f.schema, actor);
      if (!r.ok) return { error: messages(r.errors) };
      if (step.publish) {
        const p = await publishForm(f.objectKey, f.formKey, actor);
        if (!p.ok) return { error: messages(p.errors) };
      }
      return { ok: true };
    }
    case "list": {
      const l = it.item as BlueprintListView;
      const r = await saveListViewDraft(l.objectKey, l.listKey, l.schema, actor);
      if (!r.ok) return { error: messages(r.errors) };
      if (step.publish) {
        const p = await publishListView(l.objectKey, l.listKey, actor);
        if (!p.ok) return { error: messages(p.errors) };
      }
      return { ok: true };
    }
    case "page": {
      const p = it.item as BlueprintPage;
      const meta = { slug: p.slug, name: p.name, moduleKey: p.moduleKey, requiredPermission: p.requiredPermission ?? null, nav: p.nav };
      let id: string;
      if (step.action === "CREATE") {
        const r = await createPage({ ...meta, draft: p.schema }, actor);
        if (!r.ok) return { error: messages(r.errors) };
        id = r.page.id;
      } else {
        const ent = await readEntity("page", p.slug, ctx, true);
        if (!ent.ref) return { error: `Không còn trang /p/${p.slug} để cập nhật.` };
        id = ent.ref;
        const m = await updatePageMeta(id, { name: meta.name, moduleKey: meta.moduleKey, requiredPermission: meta.requiredPermission, nav: meta.nav }, actor);
        if (!m.ok) return { error: messages(m.errors) };
        const d = await savePageDraft(id, p.schema, actor);
        if (!d.ok) return { error: messages(d.errors) };
      }
      if (step.publish) {
        const pub = await publishPage(id, actor);
        if (!pub.ok) return { error: messages(pub.errors) };
      }
      return { ok: true };
    }
    case "workflow": {
      const w = it.item as BlueprintWorkflow;
      const input = { key: w.key, name: w.name, ...(w.description ? { description: w.description } : {}), trigger: w.trigger, conditions: w.conditions ?? null, actions: w.actions, gate: w.gate ?? null };
      const ent = step.action === "UPDATE" ? await readEntity("workflow", w.key, ctx, true) : null;
      const r = await saveRule(ent?.ref ? { id: ent.ref, ...input } : input, actor);
      return r.ok ? { ok: true } : { error: messages(r.errors) };
    }
    case "setting": {
      const s = it.item as BlueprintSetting;
      const before = await getSettingJson<unknown>(s.key, null);
      await setSettingJson(s.key, s.value);
      await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: s.key, before, after: s.value, reason });
      return { ok: true };
    }
    case "ai": {
      const value = projectAi(it.item as NonNullable<Blueprint["ai"]>);
      const before = await getSettingJson<unknown>(AI_PROFILE_SETTING_KEY, null);
      await setSettingJson(AI_PROFILE_SETTING_KEY, value);
      await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: AI_PROFILE_SETTING_KEY, before, after: value, reason });
      return { ok: true };
    }
    case "object": {
      const o = it.item as BlueprintObject;
      const input = {
        label: o.label,
        labelPlural: o.labelPlural,
        icon: o.icon,
        moduleKey: o.moduleKey,
        titleLabel: o.titleLabel,
        description: o.description?.trim() || null,
        ...(o.viewPermission ? { viewPermission: o.viewPermission } : {}),
        ...(o.writePermission ? { writePermission: o.writePermission } : {}),
      };
      const r = step.action === "CREATE" ? await createObject(user, { key: o.key, ...input }) : await updateObject(user, o.key, input);
      return r.ok ? { ok: true } : { error: messages(r.errors) };
    }
  }
}

/** Dòng sổ cho một bước KHÔNG ghi: mang tiếp băm cũ để phép so ba chiều lần sau vẫn so với đúng gốc. */
function carriedItem(step: PlanStep): { templateHash: string; appliedHash: string | null } | null {
  if (step.action === "CONFLICT" || step.action === "BLOCKED") return null; // không thuộc gói ⇒ không ghi sổ
  if (step.action === "SKIP_CUSTOMIZED" || step.action === "SKIP_DELETED") return { templateHash: step.baseTemplateHash ?? step.templateHash, appliedHash: step.appliedHash };
  // UNCHANGED: gói không đổi ⇒ giữ nguyên gốc; gói đổi mà tổ chức đã khớp / nhận làm của gói ⇒ gốc mới là hiện tại.
  if (step.baseTemplateHash === step.templateHash) return { templateHash: step.templateHash, appliedHash: step.appliedHash };
  return { templateHash: step.templateHash, appliedHash: step.currentHash };
}

/** `note` = lý do của lượt cài do người gọi khai (vd «Job cấp phát <khoá>») — nối sau nguồn mẫu trong nhật ký của lượt cài. */
export type ApplyOptions = { blueprint: Blueprint; note?: string };

export async function applyBlueprint(plan: BlueprintPlan, actor: SessionUser, opts: ApplyOptions): Promise<ApplyResult> {
  const bp = opts.blueprint;
  const why = opts.note?.trim() ? `${originOf(bp)} · ${opts.note.trim()}` : originOf(bp);
  if (plan.blueprint.key !== bp.key || plan.blueprint.version !== bp.version) {
    return { ok: false, installId: null, failedStep: null, errors: [{ path: "", message: "Kế hoạch không thuộc gói này — xem trước lại." }], outcomes: [] };
  }
  if (!plan.ok) {
    const blocked = plan.steps.filter((s) => s.action === "BLOCKED");
    return {
      ok: false,
      installId: null,
      failedStep: null,
      errors: [...plan.issues, ...blocked.map((s) => ({ path: stepKey(s.kind, s.key), message: `${s.label}: ${s.reason ?? "bị chặn"}` }))],
      outcomes: plan.steps.map((s) => ({ kind: s.kind, key: s.key, label: s.label, action: s.action, status: "NOT_RUN" as const, message: s.reason })),
    };
  }

  let user = actor;
  const items = new Map(blueprintItems(bp).map((it) => [stepKey(it.kind, it.key), it]));
  const installId = await startInstall({
    blueprintKey: bp.key,
    version: bp.version,
    userId: user.id,
    email: user.email,
    plan: { planHash: plan.planHash, installedVersion: plan.installedVersion, steps: plan.steps.map((s) => ({ kind: s.kind, key: s.key, action: s.action })) },
  });
  await audit({ userId: user.id, userEmail: user.email, action: "BLUEPRINT_INSTALL_START", entity: "BLUEPRINT", entityId: bp.key, before: { version: plan.installedVersion }, after: { version: bp.version, counts: plan.counts }, reason: why, correlationId: installId });

  const ctx = await newReadContext();
  const outcomes: StepOutcome[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const sk = stepKey(step.kind, step.key);
    const it = items.get(sk);
    const writes = step.action === "CREATE" || step.action === "UPDATE";
    if (!writes) {
      const carried = carriedItem(step);
      if (carried) await recordItem(installId, { kind: step.kind, key: step.key, ...carried, action: step.action as "UNCHANGED" | "SKIP_CUSTOMIZED" | "SKIP_DELETED" });
      outcomes.push({ kind: step.kind, key: step.key, label: step.label, action: step.action, status: "SKIPPED", message: step.reason });
      continue;
    }
    let result: StepDone | StepFailure;
    try {
      result = it ? await runStep(step, it, bp, user, ctx) : { error: "Mục không còn trong gói." };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    if ("error" in result) {
      outcomes.push({ kind: step.kind, key: step.key, label: step.label, action: step.action, status: "FAILED", message: result.error });
      for (const rest of plan.steps.slice(i + 1)) outcomes.push({ kind: rest.kind, key: rest.key, label: rest.label, action: rest.action, status: "NOT_RUN", message: null });
      const error = `${step.label}: ${result.error}`;
      await finishInstall(installId, { status: "FAILED", outcomes, error });
      await audit({ userId: user.id, userEmail: user.email, action: "BLUEPRINT_INSTALL_FAILED", entity: "BLUEPRINT", entityId: bp.key, after: { version: bp.version, failedStep: sk, error }, reason: why, correlationId: installId });
      return { ok: false, installId, failedStep: { kind: step.kind, key: step.key }, errors: [{ path: sk, message: error }], outcomes };
    }
    if (step.kind === "module") {
      // Module vừa bật: phiên dựng tay / phiên của request mang danh sách module CŨ — làm mới để `can()` của bước sau đúng.
      const enabled = await getEnabledModules();
      user = { ...user, modules: [...enabled] };
      ctx.modules = enabled;
    }
    const after = await readEntity(step.kind, step.key, ctx, true);
    const appliedHash = after.exists && !after.deleted ? stableHash(after.projection) : null;
    await recordItem(installId, { kind: step.kind, key: step.key, templateHash: step.templateHash, appliedHash, action: step.action as "CREATE" | "UPDATE" });
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "BLUEPRINT_STEP",
      entity: "BLUEPRINT",
      entityId: `${bp.key}:${sk}`,
      before: { hash: step.currentHash },
      after: { hash: appliedHash, action: step.action, published: step.publish },
      reason: why,
      correlationId: installId,
    });
    outcomes.push({ kind: step.kind, key: step.key, label: step.label, action: step.action, status: "DONE", message: step.reason });
  }

  await finishInstall(installId, { status: "DONE", outcomes, error: null });
  await audit({ userId: user.id, userEmail: user.email, action: "BLUEPRINT_INSTALL_DONE", entity: "BLUEPRINT", entityId: bp.key, after: { version: bp.version, done: outcomes.filter((o) => o.status === "DONE").length }, reason: why, correlationId: installId });
  return { ok: true, installId, version: bp.version, outcomes };
}

