/**
 * ═══════════ MỘT BỘ KIỂM BLUEPRINT (Phase 7 · §2) — KHÔNG ĐỌC CSDL ═══════════
 *
 * `validateBlueprint(bp)` trả lời "gói này có cài được vào MỘT tổ chức có đúng các module của gói không" — không hỏi
 * CSDL của tổ chức nào (kế hoạch mới hỏi). Hai lớp:
 *
 *  1. HÌNH — `blueprintZ` (strict, tập đóng).
 *  2. THAM CHIẾU CHÉO NỘI BỘ — mọi thứ gói trỏ tới phải có trong GÓI hoặc trong SỔ của mã nguồn:
 *     · module đóng dưới phụ thuộc (sổ module);
 *     · vai trò theo luật 31: không khoá cấm của trình dựng vai trò (`ROLE_BUILDER_FORBIDDEN` — có `users:manage`),
 *       không nền ADMIN (đã chặn ở hình);
 *     · field trỏ đối tượng hệ thống có năng lực field custom, module của đối tượng nằm trong gói;
 *     · form / danh sách qua CHÍNH hàm kiểm tham chiếu của Phase 2 (`formRefProblems`, `listRefProblems`);
 *     · trang qua CHÍNH `validatePageSchema` của Phase 4 với tập module CỦA GÓI, module tắt là LỖI (trang của mẫu
 *       có thể được xuất bản ngay); field custom trang trỏ tới phải khai trong gói;
 *     · luật theo đúng các luật của bộ kiểm Phase 3 mà không cần CSDL (sự kiện có trong sổ, field trạng thái có
 *       trong gói, không tự ghi field mình nghe, tối đa một thông báo…). Bộ kiểm có CSDL (`validateRuleInput`) vẫn
 *       chạy lần nữa lúc cài — nó là tiếng nói cuối.
 *
 * Mỗi lỗi mang `path` của mục (vd `roles.0.permissions`) để kế hoạch đánh dấu ĐÚNG mục đó là BỊ CHẶN.
 *
 * PHIÊN BẢN NÀY CHƯA HỖ TRỢ đối tượng tuỳ biến (`objects`) và field quan hệ — chúng thuộc Phase 6 (đang làm song
 * song). Từ chối RÕ RÀNG thay vì bỏ qua: một gói khai 3 đối tượng mà cài ra 0 đối tượng là cài thiếu im lặng.
 */
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { ROLE_BUILDER_FORBIDDEN, ROLE_BUILDER_FORBIDDEN_REASON } from "@/lib/constants/access-scope";
import { ZONE_ORDER } from "@/lib/constants/department-modules";
import { DEPARTMENT_CODES } from "@/lib/constants/departments";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import { objectDef } from "@/lib/constants/object-registry";
import { moduleDef, moduleOfPermission, PLATFORM_MODULES, type ModuleKey } from "@/lib/constants/platform-modules";
import { formRefProblems } from "@/lib/metadata/form-schema";
import { listRefProblems } from "@/lib/metadata/list-schema";
import type { CustomFieldDef, FieldOption } from "@/lib/metadata/types";
import { compilePattern } from "@/lib/metadata/validate";
import { customRefsOf, validatePageSchema } from "@/lib/pages/components";
import type { PageSchema } from "@/lib/pages/types";
import { conditionDepth, WORKFLOW_CONDITION_MAX_DEPTH, WORKFLOW_CONDITION_OPS } from "@/lib/workflow/evaluate";
import { EVENT_SUBJECT_REFS, PAYLOAD_REF_PREFIX } from "@/lib/workflow/subject";
import { blueprintZ, SAFE_SETTING_VALUE_Z } from "@/lib/blueprints/schema";
import { SAFE_SETTING_SPEC, type Blueprint, type BlueprintField, type BlueprintIssue, type BlueprintValidation } from "@/lib/blueprints/types";

export const NOT_SUPPORTED_YET = "chưa hỗ trợ ở phiên bản này (đối tượng tuỳ biến và field quan hệ thuộc Phase 6)";

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);
const ZONE_SET: ReadonlySet<string> = new Set(ZONE_ORDER);
const OPTION_TYPES = new Set(["select", "multi_select", "status"]);
const NUMBER_TYPES = new Set(["number", "currency"]);
const STRING_TYPES = new Set(["text", "textarea", "email", "phone", "url"]);

/** Tập module sau khi cài: module của gói + module lõi (luôn bật, gói không cần khai). */
export function blueprintModuleSet(bp: Pick<Blueprint, "modules">): Set<ModuleKey> {
  const set = new Set<ModuleKey>(bp.modules);
  for (const m of PLATFORM_MODULES) if (m.core) set.add(m.key);
  return set;
}

/** Field của gói ⇒ `CustomFieldDef` ACTIVE — để dùng lại NGUYÊN hàm kiểm / chuẩn hoá thuần của Phase 2. */
export function fieldDefsOf(bp: Pick<Blueprint, "fields">, objectKey: string): CustomFieldDef[] {
  return (bp.fields ?? []).filter((f) => f.objectKey === objectKey).map((f, i) => blueprintFieldDef(f, i));
}

export function normalizeOptions(raw: BlueprintField["options"]): FieldOption[] {
  return (raw ?? []).map((o, i) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: o.active !== false, position: o.position ?? i }));
}

export function blueprintFieldDef(f: BlueprintField, position: number): CustomFieldDef {
  return {
    id: "",
    objectKey: f.objectKey,
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required === true,
    defaultValue: null,
    options: normalizeOptions(f.options),
    validation: f.validation ?? {},
    transitions: f.transitions ?? {},
    relationObject: null,
    helpText: f.helpText?.trim() || null,
    viewPermission: null,
    editPermission: null,
    listable: f.listable !== false,
    filterable: f.filterable === true,
    position,
    status: "ACTIVE",
  };
}

function checkConditionRefs(cond: unknown, path: string, out: BlueprintIssue[], allowed: (ref: string) => string | null) {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) {
    out.push({ path, message: "Điều kiện sai hình: cần { all: [...] }, { any: [...] } hoặc { field, op, value }." });
    return;
  }
  const c = cond as Record<string, unknown>;
  if ("all" in c || "any" in c) {
    const k = "all" in c ? "all" : "any";
    if (Object.keys(c).length !== 1 || !Array.isArray(c[k])) {
      out.push({ path, message: `Nhóm "${k}" phải là một danh sách điều kiện và không kèm khoá khác.` });
      return;
    }
    (c[k] as unknown[]).forEach((x, i) => checkConditionRefs(x, `${path}.${k}.${i}`, out, allowed));
    return;
  }
  if (Object.keys(c).some((k) => !["field", "op", "value"].includes(k))) {
    out.push({ path, message: "Điều kiện chỉ nhận field · op · value." });
    return;
  }
  if (typeof c.field !== "string") {
    out.push({ path, message: "Điều kiện thiếu field." });
    return;
  }
  if (!WORKFLOW_CONDITION_OPS.includes(c.op as never)) out.push({ path, message: `Phép "${String(c.op)}" không có trong tập phép cho phép.` });
  const problem = allowed(c.field);
  if (problem) out.push({ path, message: problem });
}

/**
 * Kiểm một blueprint. `ok = errors.length === 0`. Không dừng ở lỗi đầu tiên — người soạn (hoặc AI ở Phase 8) thấy
 * MỌI chỗ sai trong một lượt.
 */
export function validateBlueprint(input: unknown): BlueprintValidation {
  const parsed = blueprintZ.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })), warnings: [] };
  }
  const bp = parsed.data as Blueprint;
  const errors: BlueprintIssue[] = [];
  const warnings: BlueprintIssue[] = [];
  const modules = blueprintModuleSet(bp);

  // ── Đối tượng tuỳ biến: chưa hỗ trợ ──
  if ((bp.objects ?? []).length > 0) errors.push({ path: "objects", message: `Mục «objects» ${NOT_SUPPORTED_YET}.` });

  // ── Module: không trùng, đóng dưới phụ thuộc ──
  const seenModules = new Set<string>();
  bp.modules.forEach((m, i) => {
    if (seenModules.has(m)) errors.push({ path: `modules.${i}`, message: `Module «${m}» khai hai lần.` });
    seenModules.add(m);
    const def = moduleDef(m);
    if (!def) return;
    const missing = def.dependsOn.filter((d) => !modules.has(d));
    if (missing.length) errors.push({ path: `modules.${i}`, message: `«${def.label}» cần ${missing.map((d) => `«${moduleDef(d)?.label ?? d}»`).join(", ")} — gói phải khai đủ phụ thuộc.` });
    if (def.requiresHomeCredentials) warnings.push({ path: `modules.${i}`, message: `«${def.label}» dùng thông tin kết nối của tổ chức nhà — tổ chức khác không bật được; gói nên để nó ở «integrations» (gợi ý).` });
  });

  // ── Vai trò (luật 31) ──
  const roleKeys = new Set<string>();
  (bp.roles ?? []).forEach((r, i) => {
    const p = `roles.${i}`;
    if (roleKeys.has(r.key)) errors.push({ path: `${p}.key`, message: `Vai trò «${r.key}» khai hai lần.` });
    roleKeys.add(r.key);
    for (const perm of r.permissions) {
      if (ROLE_BUILDER_FORBIDDEN.includes(perm)) errors.push({ path: `${p}.permissions`, message: ROLE_BUILDER_FORBIDDEN_REASON[perm] ?? `Vai trò tuỳ chỉnh không được cấp «${perm}».` });
      else if (!PERMISSION_SET.has(perm)) errors.push({ path: `${p}.permissions`, message: `Khoá quyền «${perm}» không có trong danh mục quyền.` });
      else {
        const owner = moduleOfPermission(perm);
        if (owner && !modules.has(owner)) warnings.push({ path: `${p}.permissions`, message: `«${perm}» thuộc module «${owner}» không có trong gói — quyền này sẽ không có hiệu lực.` });
      }
    }
  });

  // ── Field ──
  const fieldKeys = new Set<string>();
  const fieldByRef = new Map<string, BlueprintField>();
  (bp.fields ?? []).forEach((f, i) => {
    const p = `fields.${i}`;
    const id = `${f.objectKey}.${f.key}`;
    if (fieldKeys.has(id)) errors.push({ path: `${p}.key`, message: `Field «${id}» khai hai lần.` });
    fieldKeys.add(id);
    fieldByRef.set(id, f);
    if (f.objectKey.startsWith("x_")) {
      errors.push({ path: `${p}.objectKey`, message: `Field trên đối tượng tuỳ biến «${f.objectKey}» ${NOT_SUPPORTED_YET}.` });
      return;
    }
    if (f.type === "relation" || f.relation) {
      errors.push({ path: `${p}.type`, message: `Field quan hệ ${NOT_SUPPORTED_YET}.` });
      return;
    }
    const def = objectDef(f.objectKey);
    if (!def) {
      errors.push({ path: `${p}.objectKey`, message: `Đối tượng «${f.objectKey}» không có trong sổ đối tượng.` });
      return;
    }
    if (!def.customizable || !def.capabilities.customFields) errors.push({ path: `${p}.objectKey`, message: `${def.label} không nhận field tuỳ biến.` });
    if (!modules.has(def.module)) errors.push({ path: `${p}.objectKey`, message: `${def.label} thuộc module «${def.module}» — gói không khai module này.` });
    if (def.fields.some((s) => s.key === f.key)) errors.push({ path: `${p}.key`, message: `Khoá «${f.key}» trùng field hệ thống của ${def.label}.` });
    if (f.type === "user" || f.type === "file") warnings.push({ path: `${p}.type`, message: "Field người dùng / tệp không có giá trị mặc định và luật tự động không ghi được nó." });
    const options = f.options ?? [];
    if (OPTION_TYPES.has(f.type)) {
      if (options.length === 0) errors.push({ path: `${p}.options`, message: "Kiểu chọn / trạng thái cần ít nhất một tuỳ chọn." });
      const seen = new Set<string>();
      for (const o of options) {
        if (seen.has(o.value)) errors.push({ path: `${p}.options`, message: `Giá trị tuỳ chọn «${o.value}» bị trùng.` });
        seen.add(o.value);
      }
      if (options.length > 0 && !options.some((o) => o.active !== false)) errors.push({ path: `${p}.options`, message: "Phải còn ít nhất một tuỳ chọn đang dùng." });
    } else if (options.length > 0) errors.push({ path: `${p}.options`, message: "Kiểu này không có tuỳ chọn." });
    const values = new Set(options.map((o) => o.value));
    for (const [from, tos] of Object.entries(f.transitions ?? {})) {
      if (f.type !== "status") {
        errors.push({ path: `${p}.transitions`, message: "Chỉ field trạng thái nghiệp vụ mới có chuyển trạng thái." });
        break;
      }
      for (const v of [from, ...tos]) if (!values.has(v)) errors.push({ path: `${p}.transitions`, message: `Chuyển trạng thái nhắc «${v}» — giá trị không có trong tuỳ chọn.` });
    }
    const v = f.validation ?? {};
    if ((v.min !== undefined || v.max !== undefined) && !NUMBER_TYPES.has(f.type)) errors.push({ path: `${p}.validation`, message: "min / max chỉ áp cho kiểu số và tiền." });
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) errors.push({ path: `${p}.validation`, message: "min phải ≤ max." });
    if ((v.minLength !== undefined || v.maxLength !== undefined || v.pattern !== undefined) && !STRING_TYPES.has(f.type)) errors.push({ path: `${p}.validation`, message: "Độ dài / mẫu kiểm chỉ áp cho kiểu chữ." });
    if (v.pattern) {
      const c = compilePattern(v.pattern);
      if (!c.ok) errors.push({ path: `${p}.validation.pattern`, message: `Mẫu kiểm: ${c.message}.` });
    }
  });

  // ── Trạng thái HỆ THỐNG: chỉ nhãn / thứ tự / ẩn — không thêm giá trị (M10) ──
  (bp.statuses ?? []).forEach((s, i) => {
    const p = `statuses.${i}`;
    const def = objectDef(s.objectKey);
    if (!def || !def.capabilities.statuses || !def.statusFields.includes(s.field)) {
      errors.push({ path: `${p}.field`, message: `«${s.objectKey}.${s.field}» không phải trạng thái hệ thống cấu hình được.` });
      return;
    }
    if (!modules.has(def.module)) errors.push({ path: `${p}.objectKey`, message: `${def.label} thuộc module «${def.module}» — gói không khai module này.` });
    const known = new Set((def.fields.find((f) => f.key === s.field)?.options ?? []).map((o) => o.value));
    const seen = new Set<string>();
    for (const o of s.options) {
      if (!known.has(o.value)) errors.push({ path: `${p}.options`, message: `«${o.value}» không phải giá trị của ${def.label}.${s.field} — trạng thái hệ thống không thêm được giá trị mới.` });
      if (seen.has(o.value)) errors.push({ path: `${p}.options`, message: `«${o.value}» khai hai lần.` });
      seen.add(o.value);
      if (o.color) warnings.push({ path: `${p}.options`, message: `Màu của «${o.value}» bị bỏ qua — trạng thái hệ thống chỉ đổi nhãn, thứ tự và ẩn / hiện.` });
    }
  });

  // ── Form / danh sách: dùng NGUYÊN hàm kiểm tham chiếu của Phase 2 ──
  const formKeys = new Set<string>();
  (bp.forms ?? []).forEach((f, i) => {
    const p = `forms.${i}`;
    const id = `${f.objectKey}.${f.formKey}`;
    if (formKeys.has(id)) errors.push({ path: p, message: `Form «${id}» khai hai lần.` });
    formKeys.add(id);
    const def = objectDef(f.objectKey);
    if (!def || !def.capabilities.forms || !def.forms.some((x) => x.key === f.formKey)) {
      errors.push({ path: `${p}.formKey`, message: `«${f.objectKey}» không có form «${f.formKey}».` });
      return;
    }
    if (!modules.has(def.module)) errors.push({ path: `${p}.objectKey`, message: `${def.label} thuộc module «${def.module}» — gói không khai module này.` });
    for (const e of formRefProblems(f.schema, def.fields, fieldDefsOf(bp, f.objectKey))) errors.push({ path: `${p}.schema`, message: e.message });
  });
  const listKeys = new Set<string>();
  (bp.listViews ?? []).forEach((l, i) => {
    const p = `listViews.${i}`;
    const id = `${l.objectKey}.${l.listKey}`;
    if (listKeys.has(id)) errors.push({ path: p, message: `Danh sách «${id}» khai hai lần.` });
    listKeys.add(id);
    const def = objectDef(l.objectKey);
    if (!def || !def.capabilities.lists || !def.lists.some((x) => x.key === l.listKey)) {
      errors.push({ path: `${p}.listKey`, message: `«${l.objectKey}» không có danh sách «${l.listKey}».` });
      return;
    }
    if (!modules.has(def.module)) errors.push({ path: `${p}.objectKey`, message: `${def.label} thuộc module «${def.module}» — gói không khai module này.` });
    for (const e of listRefProblems(l.schema, def.fields, fieldDefsOf(bp, l.objectKey))) errors.push({ path: `${p}.schema`, message: e.message });
  });

  // ── Trang: NGUYÊN `validatePageSchema` với module của GÓI ──
  const slugs = new Set<string>();
  (bp.pages ?? []).forEach((pg, i) => {
    const p = `pages.${i}`;
    if (slugs.has(pg.slug)) errors.push({ path: `${p}.slug`, message: `Đường dẫn /p/${pg.slug} khai hai lần.` });
    slugs.add(pg.slug);
    if (!modules.has(pg.moduleKey)) errors.push({ path: `${p}.moduleKey`, message: `Module chủ «${pg.moduleKey}» không có trong gói.` });
    if (pg.requiredPermission) {
      if (!PERMISSION_SET.has(pg.requiredPermission)) errors.push({ path: `${p}.requiredPermission`, message: `Khoá quyền «${pg.requiredPermission}» không có trong danh mục quyền.` });
      const owner = moduleOfPermission(pg.requiredPermission);
      if (owner && !modules.has(owner)) errors.push({ path: `${p}.requiredPermission`, message: `Quyền «${pg.requiredPermission}» thuộc module «${owner}» không có trong gói — không ai mở được trang.` });
    }
    if (pg.nav.zone !== null && !ZONE_SET.has(pg.nav.zone)) errors.push({ path: `${p}.nav.zone`, message: `Nhóm menu «${pg.nav.zone}» không có trong bản đồ phòng ban.` });
    const v = validatePageSchema(pg.schema, { modules, moduleIssues: "error" });
    for (const e of v.errors) errors.push({ path: `${p}.schema${e.path ? `.${e.path}` : ""}`, message: e.message });
    if (!v.ok) return;
    const schema = pg.schema as PageSchema;
    if (pg.publish && schema.sections.every((s) => s.blocks.length === 0)) errors.push({ path: `${p}.schema`, message: "Trang khai xuất bản nhưng chưa có khối nào." });
    for (const r of customRefsOf(schema)) {
      const f = fieldByRef.get(`${r.objectKey}.${r.ref.slice("custom:".length)}`);
      if (!f) errors.push({ path: `${p}.schema.${r.path}`, message: `Field tuỳ biến «${r.ref}» của «${r.objectKey}» không khai trong gói.` });
      else if (r.role === "status" && f.type !== "status") errors.push({ path: `${p}.schema.${r.path}`, message: `Field «${f.label}» không phải kiểu trạng thái — kanban chỉ chạy trên field trạng thái.` });
      else if (r.role === "filter" && f.filterable !== true) errors.push({ path: `${p}.schema.${r.path}`, message: `Field «${f.label}» không bật lọc.` });
    }
  });

  // ── Luật tự động: các luật của bộ kiểm Phase 3 không cần CSDL ──
  const ruleKeys = new Set<string>();
  (bp.workflows ?? []).forEach((w, i) => {
    const p = `workflows.${i}`;
    if (ruleKeys.has(w.key)) errors.push({ path: `${p}.key`, message: `Luật «${w.key}» khai hai lần.` });
    ruleKeys.add(w.key);
    let objectKey: string | null = null;
    if (w.trigger.kind === "event") {
      const spec = DOMAIN_EVENT_BY_NAME[w.trigger.event];
      if (w.trigger.event.startsWith("workflow.")) errors.push({ path: `${p}.trigger.event`, message: "Luật không được nghe sự kiện do chính workflow phát (chặn vòng lặp)." });
      else if (!spec) errors.push({ path: `${p}.trigger.event`, message: `Sự kiện «${w.trigger.event}» không có trong sổ sự kiện.` });
      else if (objectDef(spec.subjectType)) objectKey = spec.subjectType;
    } else {
      objectKey = w.trigger.objectKey;
      const f = fieldByRef.get(`${w.trigger.objectKey}.${w.trigger.fieldKey}`);
      if (!f) errors.push({ path: `${p}.trigger.fieldKey`, message: `Field «${w.trigger.objectKey}.${w.trigger.fieldKey}» không khai trong gói.` });
      else if (f.type !== "status") errors.push({ path: `${p}.trigger.fieldKey`, message: `Field «${f.label}» không phải kiểu trạng thái nghiệp vụ.` });
      else {
        const values = new Set((f.options ?? []).map((o) => o.value));
        for (const x of [...w.trigger.to, ...(w.trigger.from ?? [])]) if (!values.has(x)) errors.push({ path: `${p}.trigger`, message: `Trạng thái «${x}» không có trong tuỳ chọn của «${f.label}».` });
      }
    }
    if (w.conditions !== undefined && w.conditions !== null) {
      if (conditionDepth(w.conditions) > WORKFLOW_CONDITION_MAX_DEPTH) errors.push({ path: `${p}.conditions`, message: `Cây điều kiện sâu tối đa ${WORKFLOW_CONDITION_MAX_DEPTH} tầng.` });
      const def = objectKey ? objectDef(objectKey) : null;
      checkConditionRefs(w.conditions, `${p}.conditions`, errors, (ref) => {
        if ((EVENT_SUBJECT_REFS as readonly string[]).includes(ref) || ref.startsWith(PAYLOAD_REF_PREFIX)) return null;
        if (ref.startsWith("system:")) return def?.fields.some((f) => `system:${f.key}` === ref) ? null : `Điều kiện trỏ «${ref}» — không có field hệ thống đó trên đối tượng của luật.`;
        if (ref.startsWith("custom:")) return objectKey && fieldByRef.has(`${objectKey}.${ref.slice(7)}`) ? null : `Điều kiện trỏ «${ref}» — field không khai trong gói.`;
        return `Field «${ref}» không hợp lệ — dạng system:<khoá> hoặc custom:<khoá>.`;
      });
    }
    if (w.actions.filter((a) => a.kind === "notify").length > 1) errors.push({ path: `${p}.actions`, message: "Mỗi luật tối đa MỘT thông báo (luật 26)." });
    w.actions.forEach((a, j) => {
      const ap = `${p}.actions.${j}`;
      if (a.kind === "create_task" && a.departmentCode && !(DEPARTMENT_CODES as readonly string[]).includes(a.departmentCode)) errors.push({ path: `${ap}.departmentCode`, message: `Phòng ban «${a.departmentCode}» không có trong sổ phòng ban.` });
      if (a.kind === "set_custom_value") {
        if (!objectKey) errors.push({ path: `${ap}.field`, message: "Luật này không gắn với một bản ghi có field tuỳ biến." });
        else if (w.trigger.kind === "custom_status" && a.field === w.trigger.fieldKey) errors.push({ path: `${ap}.field`, message: "Luật không được ghi chính field nó đang nghe (vòng lặp trực tiếp)." });
        else {
          const f = fieldByRef.get(`${objectKey}.${a.field}`);
          if (!f) errors.push({ path: `${ap}.field`, message: `Field «${a.field}» không khai trong gói.` });
          else if (f.type === "file" || f.type === "user" || f.type === "relation") errors.push({ path: `${ap}.field`, message: `Luật tự động không ghi được field kiểu «${f.type}».` });
        }
      }
    });
    if (objectKey) {
      const def = objectDef(objectKey);
      if (def && !modules.has(def.module)) errors.push({ path: `${p}.trigger`, message: `${def.label} thuộc module «${def.module}» — gói không khai module này.` });
    }
  });

  // ── Cài đặt an toàn ──
  const settingKeys = new Set<string>();
  (bp.settings ?? []).forEach((s, i) => {
    const p = `settings.${i}`;
    if (settingKeys.has(s.key)) errors.push({ path: `${p}.key`, message: `Cài đặt «${s.key}» khai hai lần.` });
    settingKeys.add(s.key);
    const spec = SAFE_SETTING_SPEC[s.key];
    if (!modules.has(spec.module)) errors.push({ path: `${p}.key`, message: `«${spec.label}» thuộc module «${spec.module}» — gói không khai module này.` });
    const v = SAFE_SETTING_VALUE_Z[s.key].safeParse(s.value);
    if (!v.success) errors.push({ path: `${p}.value`, message: v.error.issues[0]?.message ?? "Giá trị cài đặt sai hình." });
  });

  // ── Gợi ý tích hợp: chỉ connector, không bao giờ cấu hình ──
  (bp.integrations ?? []).forEach((it, i) => {
    if (moduleDef(it.connectorKey)?.category !== "CONNECTOR") errors.push({ path: `integrations.${i}.connectorKey`, message: `«${it.connectorKey}» không phải một connector.` });
  });

  return { ok: errors.length === 0, errors, warnings };
}
