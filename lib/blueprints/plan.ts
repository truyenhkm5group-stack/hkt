/**
 * ═══════════ MỘT BỘ LẬP KẾ HOẠCH (Phase 7 · §2, §3) — CHẠY THỬ, KHÔNG GHI, THUẦN ═══════════
 *
 * `planBlueprint(bp, { orgState })` nhận ẢNH CHỤP trạng thái tổ chức (đọc ở `state.ts`) và trả danh sách thao tác theo
 * đúng thứ tự ghi. Không đọc CSDL, không ghi gì: màn hình Xem trước, bộ cài và bài kiểm gọi CÙNG hàm này, nên "máy
 * sẽ làm gì" chỉ có một câu trả lời.
 *
 * PHÉP SO BA CHIỀU (X4) cho mỗi mục — bản gói CŨ (`baseTemplateHash`), bản gói MỚI (`templateHash`), bản tổ chức ĐANG
 * CÓ (`currentHash`, so với `appliedHash` = băm ngay sau lần cài trước):
 *
 *   đã cài trước ─┬─ thực thể không còn (xoá / lưu trữ / tắt)          ⇒ SKIP_DELETED   (không dựng lại)
 *                 ├─ gói không đổi mục này                             ⇒ UNCHANGED
 *                 ├─ tổ chức chưa sửa (current = applied)              ⇒ UPDATE
 *                 ├─ tổ chức đã tự sửa đúng bằng bản mới               ⇒ UNCHANGED
 *                 └─ tổ chức đã sửa                                    ⇒ SKIP_CUSTOMIZED (diff; người chọn ghi đè)
 *   chưa từng cài ┬─ chưa có                                           ⇒ CREATE
 *                 ├─ có sẵn, giống hệt bản gói                         ⇒ UNCHANGED (nhận làm của gói)
 *                 ├─ có sẵn nhưng đã lưu trữ (khoá không dùng lại được) ⇒ BLOCKED
 *                 └─ có sẵn, khác                                      ⇒ CONFLICT (diff; mặc định BỎ QUA)
 *
 * BLOCKED còn đến từ: lỗi của `validateBlueprint` gắn vào mục; thiếu quyền của bước; module cần cho mục sẽ không
 * bật. Kế hoạch có bước BLOCKED thì KHÔNG cài được — cài một nửa gói là để trang trỏ vào field không tồn tại.
 */
import { moduleDef, PLATFORM_MODULES, type ModuleKey } from "@/lib/constants/platform-modules";
import { objectDef } from "@/lib/constants/object-registry";
import type { CustomFieldDef } from "@/lib/metadata/types";
import { stableHash } from "@/lib/blueprints/hash";
import {
  diffProjections,
  itemLabel,
  projectAi,
  projectBlueprintField,
  projectBlueprintPage,
  projectBlueprintRole,
  projectBlueprintWorkflow,
  projectForm,
  projectList,
  projectStatusRows,
  statusRowsOf,
} from "@/lib/blueprints/project";
import { blueprintZ } from "@/lib/blueprints/schema";
import { blueprintFieldDef, blueprintModuleSet, validateBlueprint } from "@/lib/blueprints/validate";
import {
  BLUEPRINT_ITEM_KINDS,
  PLAN_ACTIONS,
  SAFE_SETTING_SPEC,
  stepKey,
  type Blueprint,
  type BlueprintIssue,
  type BlueprintItemKind,
  type BlueprintPlan,
  type PlanAction,
  type PlanStep,
  type StepResolution,
} from "@/lib/blueprints/types";

/** Thực thể của một mục trong tổ chức hiện hành. `deleted` = còn dòng nhưng đã lưu trữ / tắt. */
export type EntityState = { exists: boolean; deleted: boolean; projection: unknown; publishedVersion?: number; ref?: string };
export type InstalledItem = { templateHash: string; appliedHash: string | null };

/** Ảnh chụp tổ chức mà kế hoạch cần — `state.ts` dựng, bài kiểm dựng tay được. */
export type OrgState = {
  enabledModules: ModuleKey[];
  orgIsHome: boolean;
  installedVersion: string | null;
  /** Mục gói này đã sinh ra ở các lần cài trước (mới nhất cho mỗi mục), theo `stepKey`. */
  installed: Record<string, InstalledItem>;
  /** Thực thể hiện tại, theo `stepKey`. Thiếu = không tồn tại. */
  entities: Record<string, EntityState>;
  /** Field tuỳ biến hiện có (kể cả lưu trữ) theo đối tượng — để chuẩn hoá form / danh sách y như dịch vụ. */
  customDefs: Record<string, CustomFieldDef[]>;
};

export type PlanOptions = {
  orgState: OrgState;
  /** Người bấm có quyền này không (`can(user, …)`). Thiếu ⇒ mọi bước ghi coi như thiếu quyền. */
  can?: (permission: string) => boolean;
  resolutions?: Record<string, StepResolution>;
};

/** Quyền cần cho bước GHI của từng loại mục. */
export const STEP_PERMISSION: Record<BlueprintItemKind, string> = {
  module: "modules:manage",
  role: "users:manage",
  object: "metadata:manage",
  field: "metadata:manage",
  status: "metadata:manage",
  form: "metadata:manage",
  list: "metadata:manage",
  page: "metadata:manage",
  workflow: "workflow:manage",
  setting: "settings:manage",
  ai: "settings:manage",
};

/** Một mục của gói, sẵn sàng để so: băm gói, hình chiếu đích, module cần, cờ xuất bản. */
export type BlueprintItem = { kind: BlueprintItemKind; key: string; path: string | null; item: unknown; target: unknown; modules: ModuleKey[]; publish: boolean };

/** Module theo thứ tự PHỤ THUỘC (phụ thuộc trước) — cùng thứ tự `setOrganizationModule` chấp nhận. */
export function orderModules(keys: readonly ModuleKey[]): ModuleKey[] {
  const want = new Set(keys);
  const out: ModuleKey[] = [];
  const visit = (k: ModuleKey, stack: Set<ModuleKey>) => {
    if (out.includes(k) || stack.has(k)) return;
    stack.add(k);
    for (const d of moduleDef(k)?.dependsOn ?? []) if (want.has(d)) visit(d, stack);
    out.push(k);
  };
  for (const m of PLATFORM_MODULES) if (want.has(m.key)) visit(m.key, new Set());
  return out;
}

/** Field tuỳ biến của đối tượng SAU khi cài: của tổ chức (đang dùng) + của gói (gói thắng khi trùng khoá). */
function mergedDefs(bp: Blueprint, orgDefs: Record<string, CustomFieldDef[]>, objectKey: string): CustomFieldDef[] {
  const own = (bp.fields ?? []).filter((f) => f.objectKey === objectKey).map((f, i) => blueprintFieldDef(f, i));
  const keys = new Set(own.map((d) => d.key));
  return [...(orgDefs[objectKey] ?? []).filter((d) => !keys.has(d.key)), ...own];
}

/** Liệt kê mọi mục của gói theo THỨ TỰ GHI, kèm hình chiếu đích. Gói phải đã qua hình (zod). */
export function blueprintItems(bp: Blueprint, orgDefs: Record<string, CustomFieldDef[]> = {}): BlueprintItem[] {
  const modules = blueprintModuleSet(bp);
  const items: BlueprintItem[] = [];
  const objMod = (o: string): ModuleKey[] => {
    const m = objectDef(o)?.module;
    return m ? [m] : [];
  };
  const moduleIndex = new Map(bp.modules.map((m, i) => [m, i]));
  for (const m of orderModules(bp.modules)) items.push({ kind: "module", key: m, path: `modules.${moduleIndex.get(m)}`, item: m, target: { enabled: true }, modules: [], publish: false });
  (bp.roles ?? []).forEach((r, i) => items.push({ kind: "role", key: r.key, path: `roles.${i}`, item: r, target: projectBlueprintRole(r), modules: [], publish: false }));
  (bp.fields ?? []).forEach((f, i) => items.push({ kind: "field", key: `${f.objectKey}.${f.key}`, path: `fields.${i}`, item: f, target: projectBlueprintField(f), modules: objMod(f.objectKey), publish: false }));
  (bp.statuses ?? []).forEach((s, i) => items.push({ kind: "status", key: `${s.objectKey}.${s.field}`, path: `statuses.${i}`, item: s, target: projectStatusRows(statusRowsOf(s)), modules: objMod(s.objectKey), publish: false }));
  (bp.forms ?? []).forEach((f, i) =>
    items.push({ kind: "form", key: `${f.objectKey}.${f.formKey}`, path: `forms.${i}`, item: f, target: projectForm(f.objectKey, f.schema, mergedDefs(bp, orgDefs, f.objectKey)), modules: objMod(f.objectKey), publish: f.publish === true }),
  );
  (bp.listViews ?? []).forEach((l, i) =>
    items.push({ kind: "list", key: `${l.objectKey}.${l.listKey}`, path: `listViews.${i}`, item: l, target: projectList(l.objectKey, l.schema, mergedDefs(bp, orgDefs, l.objectKey)), modules: objMod(l.objectKey), publish: l.publish === true }),
  );
  (bp.pages ?? []).forEach((p, i) => items.push({ kind: "page", key: p.slug, path: `pages.${i}`, item: p, target: projectBlueprintPage(p, modules), modules: [p.moduleKey], publish: p.publish === true }));
  (bp.workflows ?? []).forEach((w, i) => {
    const o = w.trigger.kind === "custom_status" ? w.trigger.objectKey : null;
    items.push({ kind: "workflow", key: w.key, path: `workflows.${i}`, item: w, target: projectBlueprintWorkflow(w), modules: o ? objMod(o) : [], publish: false });
  });
  (bp.settings ?? []).forEach((s, i) => items.push({ kind: "setting", key: s.key, path: `settings.${i}`, item: s, target: s.value, modules: [SAFE_SETTING_SPEC[s.key].module], publish: false }));
  if (bp.ai) items.push({ kind: "ai", key: "businessProfile", path: "ai", item: bp.ai, target: projectAi(bp.ai), modules: [], publish: false });
  return items;
}

/** Băm của MỘT mục trong gói — đổi khi và chỉ khi nội dung mục trong gói đổi. */
export function templateHashOf(item: BlueprintItem): string {
  return stableHash({ kind: item.kind, item: item.item });
}

function emptyCounts(): Record<PlanAction, number> {
  return Object.fromEntries(PLAN_ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
}

/** Lỗi của bộ kiểm ⇒ mục mang lỗi (theo tiền tố `path`); lỗi không gắn được mục nào đứng ở `issues`. */
function issuesByItem(items: BlueprintItem[], issues: BlueprintIssue[]): { byItem: Map<string, string[]>; general: BlueprintIssue[] } {
  const byItem = new Map<string, string[]>();
  const general: BlueprintIssue[] = [];
  for (const issue of issues) {
    const hit = items.find((it) => it.path && (issue.path === it.path || issue.path.startsWith(`${it.path}.`)));
    if (!hit) {
      general.push(issue);
      continue;
    }
    const k = stepKey(hit.kind, hit.key);
    byItem.set(k, [...(byItem.get(k) ?? []), issue.message]);
  }
  return { byItem, general };
}

export function planBlueprint(bp: Blueprint, opts: PlanOptions): BlueprintPlan {
  const { orgState } = opts;
  const can = opts.can ?? (() => false);
  const resolutions = opts.resolutions ?? {};
  const validation = validateBlueprint(bp);
  const base = { blueprint: { key: bp.key, version: bp.version, name: bp.name }, installedVersion: orgState.installedVersion, integrations: bp.integrations ?? [], warnings: validation.warnings };

  // Gói sai HÌNH: không liệt kê được mục nào một cách tin cậy.
  if (!blueprintZ.safeParse(bp).success) {
    return { ...base, planHash: stableHash({ bp: bp.key, v: bp.version, invalid: validation.errors }), steps: [], issues: validation.errors, counts: emptyCounts(), ok: false };
  }

  const items = blueprintItems(bp, orgState.customDefs);
  const { byItem, general } = issuesByItem(items, validation.errors);
  const enabled = new Set(orgState.enabledModules);
  const willEnable = new Set<ModuleKey>(enabled);
  const steps: PlanStep[] = [];

  for (const it of items) {
    const sk = stepKey(it.kind, it.key);
    const templateHash = templateHashOf(it);
    const inst = orgState.installed[sk] ?? null;
    const ent = orgState.entities[sk];
    const alive = Boolean(ent?.exists && !ent.deleted);
    const currentHash = alive ? stableHash(ent!.projection) : null;
    const targetHash = stableHash(it.target);
    const step: PlanStep = {
      kind: it.kind,
      key: it.key,
      label: itemLabel(it.kind, it.key, bp),
      action: "UNCHANGED",
      reason: null,
      templateHash,
      baseTemplateHash: inst?.templateHash ?? null,
      appliedHash: inst?.appliedHash ?? null,
      currentHash,
      diff: [],
      publish: false,
    };
    const block = (reason: string) => {
      step.action = "BLOCKED";
      step.reason = reason;
    };

    const own = byItem.get(sk);
    if (own?.length) block(own.join(" · "));
    else if (it.kind === "module") {
      const key = it.key as ModuleKey;
      const def = moduleDef(key);
      if (enabled.has(key)) step.action = "UNCHANGED";
      else if (inst) {
        step.action = "SKIP_DELETED";
        step.reason = "Tổ chức đã tắt module này sau lần cài trước — không tự bật lại.";
      } else if (def?.requiresHomeCredentials && !orgState.orgIsHome) block(`«${def.label}» dùng thông tin kết nối của tổ chức nhà — tổ chức này không bật được.`);
      else if (def && def.dependsOn.some((d) => !willEnable.has(d))) block(`«${def.label}» cần ${def.dependsOn.filter((d) => !willEnable.has(d)).join(", ")} bật trước.`);
      else step.action = "CREATE";
      if (step.action === "CREATE") willEnable.add(key);
    } else {
      const missingModule = it.modules.find((m) => !willEnable.has(m));
      if (missingModule) block(`Module «${moduleDef(missingModule)?.label ?? missingModule}» sẽ không bật — mục này không cài được.`);
      else if (inst) {
        if (!alive) {
          step.action = "SKIP_DELETED";
          step.reason = "Tổ chức đã xoá / lưu trữ / tắt mục này sau lần cài trước — không dựng lại.";
        } else if (inst.templateHash === templateHash) {
          step.action = "UNCHANGED";
          if (currentHash !== inst.appliedHash) step.reason = "Tổ chức đã sửa mục này — gói không đổi nên giữ nguyên bản của tổ chức.";
        } else if (currentHash === inst.appliedHash) step.action = "UPDATE";
        else if (currentHash === targetHash) {
          step.action = "UNCHANGED";
          step.reason = "Tổ chức đã tự sửa đúng bằng bản mới của gói.";
        } else {
          step.action = "SKIP_CUSTOMIZED";
          step.reason = "Tổ chức đã sửa mục này sau lần cài trước — mặc định giữ bản của tổ chức.";
          step.diff = diffProjections(ent!.projection, it.target);
        }
      } else if (!ent?.exists) {
        step.action = "CREATE";
        step.publish = it.publish;
      } else if (ent.deleted && it.kind !== "role") {
        block("Khoá này đã được dùng cho một mục đã lưu trữ — khoá không dùng lại được; đổi khoá trong gói.");
      } else if (currentHash === targetHash) {
        // Có sẵn, giống hệt: nhận làm của gói. Trang/form/danh sách chưa xuất bản mà gói khai xuất bản ⇒ xuất bản.
        if (it.publish && (ent.publishedVersion ?? 1) === 0) {
          step.action = "UPDATE";
          step.publish = true;
          step.reason = "Có sẵn và giống bản gói nhưng chưa xuất bản — sẽ xuất bản.";
        } else step.action = "UNCHANGED";
      } else {
        step.action = "CONFLICT";
        step.reason = ent.deleted ? "Có sẵn một mục cùng khoá nhưng đang tắt — ghi đè sẽ bật lại với nội dung của gói." : "Tổ chức đã có một mục cùng khoá, không do gói sinh ra — mặc định BỎ QUA.";
        step.diff = alive ? diffProjections(ent.projection, it.target) : [];
      }

      // Người chọn ghi đè một mục đã tuỳ biến / trùng.
      if ((step.action === "SKIP_CUSTOMIZED" || step.action === "CONFLICT") && resolutions[sk] === "overwrite") {
        step.reason = `${step.action === "CONFLICT" ? "Trùng thứ có sẵn" : "Đã tuỳ biến"} — người bấm chọn GHI ĐÈ bằng bản gói.`;
        step.action = "UPDATE";
      }
    }

    // Quyền của bước ghi.
    if ((step.action === "CREATE" || step.action === "UPDATE") && !can(STEP_PERMISSION[it.kind])) block(`Thiếu quyền «${STEP_PERMISSION[it.kind]}» để ghi ${it.kind}.`);
    steps.push(step);
  }

  const counts = emptyCounts();
  for (const s of steps) counts[s.action] += 1;
  const issues = general;
  const planHash = stableHash({ bp: bp.key, v: bp.version, steps: steps.map((s) => [s.kind, s.key, s.action, s.templateHash, s.currentHash, s.publish]) });
  return { ...base, planHash, steps, issues, counts, ok: issues.length === 0 && counts.BLOCKED === 0 };
}

/** Thứ tự loại mục — kiểm thử và màn hình nhóm theo nó. */
export const KIND_ORDER: Record<BlueprintItemKind, number> = Object.fromEntries(BLUEPRINT_ITEM_KINDS.map((k, i) => [k, i])) as Record<BlueprintItemKind, number>;
