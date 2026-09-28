/**
 * ═══════════ PHÉP CHIẾU MỘT MỤC — "thực thể này trông thế nào" (Phase 7 · §3) — THUẦN ═══════════
 *
 * Phép so ba chiều cần so được BẢN GÓI với BẢN TỔ CHỨC ĐANG CÓ. Hai bản đến từ hai nơi (một cái là JSON của gói, một
 * cái đọc từ CSDL qua dịch vụ), nên mỗi loại mục có MỘT hàm chiếu về cùng một hình, và băm được tính trên hình đó:
 *
 *  · chỉ giữ thứ gói QUẢN — nhãn, kiểu, tuỳ chọn, bố cục… — bỏ thứ máy tự sinh (id, mốc giờ, người sửa, vị trí
 *    tự tăng của field). Nếu không, băm đổi sau mỗi lần ai đó mở màn hình và mọi mục đều thành "đã tuỳ biến";
 *  · form / danh sách chỉ giữ ô ĐANG HIỆN: trình soạn nối mọi field mới vào cuối ở trạng thái ẨN, nên một field do
 *    người khác thêm cho khách hàng không được làm form của gói trông như "đã sửa". Ẩn một ô của gói thì CÓ đổi;
 *  · chuẩn hoá bằng CHÍNH hàm chuẩn hoá của dịch vụ (`normalizeFormSchema`, `normalizeListView`,
 *    `normalizePageSchema`) — bản gói sau khi cài đúng bằng bản gói chiếu ra ở đây, không có luật thứ hai.
 */
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { moduleDef, type ModuleKey } from "@/lib/constants/platform-modules";
import { normalizeFormSchema } from "@/lib/metadata/form-schema";
import { normalizeListView } from "@/lib/metadata/list-schema";
import type { CustomFieldDef, FieldOption, FormSchema, ListViewSchema } from "@/lib/metadata/types";
import { normalizePageSchema } from "@/lib/pages/components";
import type { PageNav, PageSchema } from "@/lib/pages/types";
import type { WorkflowRule } from "@/lib/workflow/types";
import { fieldValidationOf, normalizeOptions, objectOf } from "@/lib/blueprints/validate";
import { SAFE_SETTING_SPEC, type Blueprint, type BlueprintField, type BlueprintObject, type BlueprintItemKind, type BlueprintPage, type BlueprintRole, type BlueprintStatusOverride, type BlueprintWorkflow, type DiffEntry, type SafeSettingKey } from "@/lib/blueprints/types";

// ═══ Hình chiếu của từng loại ═══

export type FieldProjection = {
  type: string;
  label: string;
  required: boolean;
  options: FieldOption[];
  validation: Record<string, unknown>;
  transitions: Record<string, string[]>;
  helpText: string | null;
  relationObject: string | null;
  listable: boolean;
  filterable: boolean;
};

export function projectFieldDef(d: Pick<CustomFieldDef, "type" | "label" | "required" | "options" | "validation" | "transitions" | "helpText" | "relationObject" | "listable" | "filterable">): FieldProjection {
  return {
    type: d.type,
    label: d.label,
    required: d.required,
    options: d.options.map((o) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: o.active, position: o.position })),
    validation: { ...d.validation },
    transitions: d.transitions,
    helpText: d.helpText,
    relationObject: d.relationObject ?? null,
    listable: d.listable,
    filterable: d.filterable,
  };
}

export function projectBlueprintField(f: BlueprintField): FieldProjection {
  return projectFieldDef({
    type: f.type,
    label: f.label,
    required: f.required === true,
    options: normalizeOptions(f.options),
    validation: fieldValidationOf(f),
    transitions: f.transitions ?? {},
    helpText: f.helpText?.trim() || null,
    relationObject: f.relation?.objectKey ?? null,
    listable: f.listable !== false,
    filterable: f.filterable === true,
  });
}

/** Đối tượng tuỳ biến: đúng những cột `createObject` / `updateObject` nhận (mặc định như dịch vụ điền). */
export type ObjectProjection = { label: string; labelPlural: string; icon: string; moduleKey: string; titleLabel: string; description: string | null; viewPermission: string; writePermission: string };

export function projectBlueprintObject(o: BlueprintObject): ObjectProjection {
  return {
    label: o.label.trim(),
    labelPlural: o.labelPlural.trim(),
    icon: o.icon,
    moduleKey: o.moduleKey,
    titleLabel: o.titleLabel.trim() || "Tên",
    description: o.description?.trim() || null,
    viewPermission: o.viewPermission ?? "records:view",
    writePermission: o.writePermission ?? "records:write",
  };
}

export function projectObjectDef(d: AnyObjectDef): ObjectProjection | null {
  if (!d.custom) return null;
  return {
    label: d.label,
    labelPlural: d.labelPlural,
    icon: d.custom.icon,
    moduleKey: d.custom.menuModule,
    titleLabel: d.custom.titleLabel,
    description: d.custom.description ?? null,
    viewPermission: d.custom.viewPermission,
    writePermission: d.custom.writePermission,
  };
}

export type RoleProjection = { name: string; description: string; baseRole: string; permissions: string[]; defaultScope: string; active: boolean };

export function projectBlueprintRole(r: BlueprintRole): RoleProjection {
  return { name: r.label, description: r.description?.trim() ?? "", baseRole: r.base, permissions: [...new Set(r.permissions)].sort(), defaultScope: r.defaultScope ?? "ALL", active: true };
}

export function projectRoleRow(r: { name: string; description: string; baseRole: string; permissions: string[]; defaultScope: string; active: boolean }): RoleProjection {
  return { name: r.name, description: r.description ?? "", baseRole: r.baseRole, permissions: [...new Set(r.permissions)].sort(), defaultScope: r.defaultScope, active: r.active };
}

export type StatusRowProjection = { value: string; label: string | null; position: number | null; active: boolean };

export function projectStatusRows(rows: readonly StatusRowProjection[]): StatusRowProjection[] {
  return [...rows].map((r) => ({ value: r.value, label: r.label?.trim() || null, position: r.position ?? null, active: r.active })).sort((a, b) => a.value.localeCompare(b.value));
}

export function statusRowsOf(s: BlueprintStatusOverride): StatusRowProjection[] {
  return s.options.map((o) => ({ value: o.value, label: o.label.trim() || null, position: o.position, active: o.active }));
}

/** Form: chuẩn hoá bằng hàm của dịch vụ, rồi chỉ giữ ô ĐANG HIỆN (xem đầu tệp). */
export function projectForm(def: AnyObjectDef | null, schema: FormSchema | null | undefined, custom: readonly CustomFieldDef[]): FormSchema | null {
  if (!def || !schema) return null;
  const n = normalizeFormSchema(schema, def.fields, custom);
  return { version: 1, sections: n.sections.map((s) => ({ key: s.key, label: s.label, fields: s.fields.filter((f) => f.visible) })) };
}

export function projectList(def: AnyObjectDef | null, schema: ListViewSchema | null | undefined, custom: readonly CustomFieldDef[]): ListViewSchema | null {
  if (!def || !schema) return null;
  const n = normalizeListView(schema, def.fields, custom);
  return { version: 1, columns: n.columns.filter((c) => c.visible), defaultSort: n.defaultSort, defaultFilters: n.defaultFilters };
}

export type PageProjection = { name: string; moduleKey: string; requiredPermission: string | null; nav: PageNav; schema: PageSchema | null };

export function projectPage(p: { name: string; moduleKey: string; requiredPermission: string | null; nav: PageNav }, schema: unknown, modules: ReadonlySet<ModuleKey>): PageProjection {
  return {
    name: p.name,
    moduleKey: p.moduleKey,
    requiredPermission: p.requiredPermission ?? null,
    nav: { enabled: p.nav.enabled, label: p.nav.label.trim() || p.name, zone: p.nav.zone ?? null, order: p.nav.order },
    schema: normalizePageSchema(schema, { modules }) ?? null,
  };
}

export function projectBlueprintPage(p: BlueprintPage, modules: ReadonlySet<ModuleKey>): PageProjection {
  return projectPage({ name: p.name, moduleKey: p.moduleKey, requiredPermission: p.requiredPermission ?? null, nav: p.nav }, p.schema, modules);
}

export type WorkflowProjection = Pick<WorkflowRule, "name" | "description" | "trigger" | "conditions" | "actions" | "gate" | "status" | "mode">;

export function projectRule(r: WorkflowProjection): WorkflowProjection {
  return { name: r.name, description: r.description ?? null, trigger: r.trigger, conditions: r.conditions ?? null, actions: r.actions, gate: r.gate ?? null, status: r.status, mode: r.mode };
}

export function projectBlueprintWorkflow(w: BlueprintWorkflow): WorkflowProjection {
  // Luật do gói sinh ra LUÔN ở NHÁP + CHẠY THỬ (luật 23, 25) — nên người bật luật là một lần "tuỳ biến": nâng
  // phiên bản sau đó không lặng lẽ kéo luật đang chạy về nháp.
  return projectRule({ name: w.name, description: w.description?.trim() || null, trigger: w.trigger, conditions: w.conditions ?? null, actions: w.actions, gate: w.gate ?? null, status: "DRAFT", mode: "DRY_RUN" });
}

export function projectAi(ai: NonNullable<Blueprint["ai"]>): { businessProfile: string; glossary: { term: string; meaning: string }[] } {
  return { businessProfile: ai.businessProfile.trim(), glossary: (ai.glossary ?? []).map((g) => ({ term: g.term.trim(), meaning: g.meaning.trim() })) };
}

// ═══ Khác biệt để người xem quyết ═══

const MAX_DIFF = 40;

function flatten(value: unknown, prefix: string, out: Map<string, unknown>, depth: number) {
  if (depth > 8 || value === null || typeof value !== "object") {
    out.set(prefix || "(gốc)", value);
    return;
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    out.set(prefix || "(gốc)", Array.isArray(value) ? [] : {});
    return;
  }
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
}

/** Khác biệt theo đường dẫn lá — tối đa 40 dòng (đủ cho người đọc quyết, không thành một bức tường chữ). */
export function diffProjections(current: unknown, template: unknown): DiffEntry[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(current, "", a, 0);
  flatten(template, "", b, 0);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const out: DiffEntry[] = [];
  for (const k of keys) {
    const x = a.has(k) ? a.get(k) : undefined;
    const y = b.has(k) ? b.get(k) : undefined;
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    out.push({ path: k, current: x === undefined ? null : x, template: y === undefined ? null : y });
    if (out.length >= MAX_DIFF) break;
  }
  return out;
}

/** Nhãn đọc được của một mục trên màn hình. */
export function itemLabel(kind: BlueprintItemKind, key: string, bp: Blueprint): string {
  switch (kind) {
    case "module":
      return moduleDef(key)?.label ?? key;
    case "setting":
      return key in SAFE_SETTING_SPEC ? SAFE_SETTING_SPEC[key as SafeSettingKey].label : key;
    case "ai":
      return "Hồ sơ doanh nghiệp cho trợ lý AI";
    case "role":
      return bp.roles?.find((r) => r.key === key)?.label ?? key;
    case "object":
      return bp.objects?.find((o) => o.key === key)?.label ?? key;
    case "field": {
      const [o, k] = key.split(".");
      const f = bp.fields?.find((x) => x.objectKey === o && x.key === k);
      return f ? `${objectOf(bp, o)?.label ?? o} · ${f.label}` : key;
    }
    case "page":
      return bp.pages?.find((p) => p.slug === key)?.name ?? key;
    case "workflow":
      return bp.workflows?.find((w) => w.key === key)?.name ?? key;
    case "form":
    case "list":
    case "status": {
      const [o, k] = key.split(".");
      return `${objectOf(bp, o)?.label ?? o} · ${k}`;
    }
    default:
      return key;
  }
}
