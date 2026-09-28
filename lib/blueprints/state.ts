/**
 * ═══════════ ẢNH CHỤP TỔ CHỨC CHO BỘ LẬP KẾ HOẠCH (Phase 7) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 * Đọc trạng thái hiện hành của MỌI mục mà một gói nhắc tới, qua dịch vụ đọc sẵn có (`loadCustomDefs`, `loadConfigRow`,
 * `listPages` / `getPageDraft`, `listRules`, `listAccessRoles`, `getStatusOverrides`, `getSettingJson`,
 * `getEnabledModules`) rồi chiếu về hình của `project.ts`. Tổ chức là tổ chức của NGỮ CẢNH (`getDb()` chọn CSDL
 * silo) — không tham số nào nhận mã tổ chức, nên tổ chức B không có cách nào đọc sổ cài của A.
 *
 * Bộ cài dùng lại `readEntity` để đọc lại thực thể NGAY SAU khi ghi và lấy `applied_hash` — băm luôn đến từ cùng
 * một phép chiếu với lúc lập kế hoạch.
 */
import { listAccessRoles, type AccessRoleRow } from "@/lib/queries/access";
import { objectDef } from "@/lib/constants/object-registry";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { loadCustomDefs } from "@/lib/metadata/common";
import { loadConfigRow } from "@/lib/metadata/config-store";
import { getStatusOverrides } from "@/lib/metadata/statuses";
import type { CustomFieldDef, FormSchema, ListViewSchema } from "@/lib/metadata/types";
import { getPageDraft, listPages } from "@/lib/pages/registry";
import type { PageDefinition } from "@/lib/pages/types";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { getSettingJson } from "@/lib/settings";
import { listRules } from "@/lib/workflow/rules";
import type { WorkflowRule } from "@/lib/workflow/types";
import { installedItems, installedVersion } from "@/lib/blueprints/ledger";
import type { EntityState, OrgState } from "@/lib/blueprints/plan";
import { projectFieldDef, projectForm, projectList, projectPage, projectRoleRow, projectRule, projectStatusRows } from "@/lib/blueprints/project";
import { AI_PROFILE_SETTING_KEY, stepKey, type Blueprint, type BlueprintItemKind } from "@/lib/blueprints/types";

/** Đệm đọc cho MỘT lượt lập kế hoạch / cài — không sống qua lượt (M13: không đệm metadata trong tiến trình). */
export type ReadContext = {
  modules: Set<ModuleKey>;
  customDefs: Map<string, CustomFieldDef[]>;
  roles?: AccessRoleRow[];
  pages?: PageDefinition[];
  rules?: WorkflowRule[];
};

export async function newReadContext(): Promise<ReadContext> {
  return { modules: await getEnabledModules(), customDefs: new Map() };
}

async function defsOf(ctx: ReadContext, objectKey: string): Promise<CustomFieldDef[]> {
  if (!ctx.customDefs.has(objectKey)) {
    const def = objectDef(objectKey);
    ctx.customDefs.set(objectKey, def?.capabilities.customFields ? await loadCustomDefs(objectKey, true) : []);
  }
  return ctx.customDefs.get(objectKey)!;
}

const ABSENT: EntityState = { exists: false, deleted: false, projection: null };

/** Thực thể hiện hành của MỘT mục. `fresh` = bỏ đệm danh sách (đọc lại sau khi vừa ghi). */
export async function readEntity(kind: BlueprintItemKind, key: string, ctx: ReadContext, fresh = false): Promise<EntityState> {
  switch (kind) {
    case "module": {
      if (fresh) ctx.modules = await getEnabledModules();
      const on = ctx.modules.has(key as ModuleKey);
      return { exists: on, deleted: false, projection: { enabled: on } };
    }
    case "role": {
      if (fresh || !ctx.roles) ctx.roles = await listAccessRoles();
      const r = ctx.roles.find((x) => x.code === key.toUpperCase());
      return r ? { exists: true, deleted: !r.active, projection: projectRoleRow(r), ref: r.id } : ABSENT;
    }
    case "field": {
      const [objectKey, fieldKey] = key.split(".");
      if (fresh) ctx.customDefs.delete(objectKey);
      const d = (await defsOf(ctx, objectKey)).find((x) => x.key === fieldKey);
      return d ? { exists: true, deleted: d.status === "ARCHIVED", projection: projectFieldDef(d) } : ABSENT;
    }
    case "status": {
      const [objectKey, fieldKey] = key.split(".");
      const def = objectDef(objectKey);
      if (!def || !ctx.modules.has(def.module)) return ABSENT;
      const rows = await getStatusOverrides(objectKey, fieldKey);
      return rows.length ? { exists: true, deleted: false, projection: projectStatusRows(rows) } : ABSENT;
    }
    case "form":
    case "list": {
      const [objectKey, configKey] = key.split(".");
      if (fresh) ctx.customDefs.delete(objectKey);
      const row = await loadConfigRow(kind === "form" ? "FORM" : "LIST_VIEW", objectKey, configKey);
      const raw = row ? (row.draft ?? row.published) : null;
      if (!row || raw === null || raw === undefined) return ABSENT;
      const custom = await defsOf(ctx, objectKey);
      const projection = kind === "form" ? projectForm(objectKey, raw as FormSchema, custom) : projectList(objectKey, raw as ListViewSchema, custom);
      return { exists: true, deleted: false, projection, publishedVersion: row.publishedVersion };
    }
    case "page": {
      if (fresh || !ctx.pages) ctx.pages = await listPages({ includeArchived: true });
      const p = ctx.pages.find((x) => x.slug === key);
      if (!p) return ABSENT;
      const { draft } = await getPageDraft(p.id);
      return { exists: true, deleted: p.status === "ARCHIVED", projection: projectPage(p, draft, ctx.modules), publishedVersion: p.publishedVersion, ref: p.id };
    }
    case "workflow": {
      if (fresh || !ctx.rules) ctx.rules = await listRules();
      const r = ctx.rules.find((x) => x.key === key);
      return r ? { exists: true, deleted: r.status === "ARCHIVED", projection: projectRule(r), ref: r.id } : ABSENT;
    }
    case "setting": {
      const v = await getSettingJson<unknown>(key, null);
      return v === null || v === undefined ? ABSENT : { exists: true, deleted: false, projection: v };
    }
    case "ai": {
      const v = await getSettingJson<unknown>(AI_PROFILE_SETTING_KEY, null);
      return v === null || v === undefined ? ABSENT : { exists: true, deleted: false, projection: v };
    }
    case "object":
      return ABSENT;
  }
}

/** Mọi (loại, khoá) mà gói nhắc tới — cùng khoá với `blueprintItems`. */
function itemKeys(bp: Blueprint): { kind: BlueprintItemKind; key: string }[] {
  return [
    ...bp.modules.map((m) => ({ kind: "module" as const, key: m })),
    ...(bp.roles ?? []).map((r) => ({ kind: "role" as const, key: r.key })),
    ...(bp.fields ?? []).map((f) => ({ kind: "field" as const, key: `${f.objectKey}.${f.key}` })),
    ...(bp.statuses ?? []).map((s) => ({ kind: "status" as const, key: `${s.objectKey}.${s.field}` })),
    ...(bp.forms ?? []).map((f) => ({ kind: "form" as const, key: `${f.objectKey}.${f.formKey}` })),
    ...(bp.listViews ?? []).map((l) => ({ kind: "list" as const, key: `${l.objectKey}.${l.listKey}` })),
    ...(bp.pages ?? []).map((p) => ({ kind: "page" as const, key: p.slug })),
    ...(bp.workflows ?? []).map((w) => ({ kind: "workflow" as const, key: w.key })),
    ...(bp.settings ?? []).map((s) => ({ kind: "setting" as const, key: s.key })),
    ...(bp.ai ? [{ kind: "ai" as const, key: "businessProfile" }] : []),
  ];
}

/** Ảnh chụp đầy đủ cho `planBlueprint`. */
export async function readOrgState(bp: Blueprint, opts: { orgIsHome: boolean }): Promise<OrgState> {
  const ctx = await newReadContext();
  const entities: Record<string, EntityState> = {};
  for (const { kind, key } of itemKeys(bp)) entities[stepKey(kind, key)] = await readEntity(kind, key, ctx);
  const objectKeys = new Set([...(bp.fields ?? []).map((f) => f.objectKey), ...(bp.forms ?? []).map((f) => f.objectKey), ...(bp.listViews ?? []).map((l) => l.objectKey)]);
  const customDefs: Record<string, CustomFieldDef[]> = {};
  for (const o of objectKeys) customDefs[o] = (await defsOf(ctx, o)).filter((d) => d.status === "ACTIVE");
  return {
    enabledModules: [...ctx.modules],
    orgIsHome: opts.orgIsHome,
    installedVersion: await installedVersion(bp.key),
    installed: await installedItems(bp.key),
    entities,
    customDefs,
  };
}
