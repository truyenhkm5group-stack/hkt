/**
 * ═══════════ XUẤT CẤU HÌNH TỔ CHỨC THÀNH MỘT BLUEPRINT (Phase 11 · H3) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 * `exportOrgBlueprint()` dựng NGƯỢC cấu hình HIỆN TẠI của tổ chức ngữ cảnh (`getDb()` chọn CSDL silo — không tham số
 * nào nhận mã tổ chức, nên tổ chức B không có đường nào đọc cấu hình của A) thành MỘT gói đúng định dạng Phase 7.
 * Khôi phục cấu hình = cài gói đó vào một tổ chức mới qua CÙNG bộ cài (`installBlueprint`) — không có bộ nhập thứ hai.
 *
 * Gói mang: module đang bật · vai trò tuỳ chỉnh đang bật (trừ quyền luật 31 cấm) · đối tượng tuỳ biến ACTIVE · field
 * tuỳ biến ACTIVE (trên đối tượng hệ thống lẫn tuỳ biến) · override trạng thái hệ thống · form + danh sách ĐÃ XUẤT BẢN ·
 * trang ĐÃ XUẤT BẢN (kèm menu) · luật (bộ cài luôn sinh ở NHÁP + CHẠY THỬ) · cài đặt trong danh sách AN TOÀN · ngữ cảnh AI.
 *
 * KHÔNG mang: bản ghi, giá trị field, người dùng, email, bí mật kết nối, id nội bộ (mọi mục đi bằng KHOÁ TỰ NHIÊN —
 * slug trang, khoá luật, mã vai trò, khoá đối tượng / field). Mọi đọc đi qua dịch vụ sẵn có; tệp này không ghi gì
 * (`tests/blueprints.test.ts` quét cả thư mục).
 *
 * TRUNG THỰC VỀ PHẦN MẤT: thứ blueprint KHÔNG chở được thì không bị bỏ im lặng —
 *   · `omitted` — cả mục không vào gói (module chỉ tổ chức nhà bật được, vai trò đang tắt, trang chưa xuất bản…) kèm lý do;
 *   · `lossy`   — mục vào gói nhưng thiếu một phần (giá trị mặc định / quyền riêng của field, quyền luật 31 bị gỡ…).
 * Gói cuối cùng PHẢI qua `validateBlueprint`: mục nào làm gói hỏng (vd trang trỏ field đã lưu trữ) bị gỡ khỏi gói và
 * ghi vào `omitted` với đúng câu lỗi của bộ kiểm — thà thiếu một trang có nói ra còn hơn một tệp không cài được.
 */
import { can, type SessionUser } from "@/lib/auth/session";
import { ROLE_BUILDER_FORBIDDEN } from "@/lib/constants/access-scope";
import { OBJECT_REGISTRY, type AnyObjectDef } from "@/lib/constants/object-registry";
import { moduleDef, type ModuleKey } from "@/lib/constants/platform-modules";
import { loadCustomDefs } from "@/lib/metadata/common";
import { loadConfigRow } from "@/lib/metadata/config-store";
import { listCustomObjectDefs } from "@/lib/metadata/object-resolver";
import { getStatusOverrides } from "@/lib/metadata/statuses";
import type { CustomFieldDef, FormSchema, ListViewSchema } from "@/lib/metadata/types";
import { getPageBySlug, listPages } from "@/lib/pages/registry";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { listAccessRoles } from "@/lib/queries/access";
import { getSettingJson } from "@/lib/settings";
import { listRules } from "@/lib/workflow/rules";
import { stableHash } from "@/lib/blueprints/hash";
import { orderModules } from "@/lib/blueprints/plan";
import { projectForm, projectList } from "@/lib/blueprints/project";
import { SAFE_SETTING_VALUE_Z } from "@/lib/blueprints/schema";
import { BLUEPRINT_TEMPLATES } from "@/lib/blueprints/templates";
import { validateBlueprint } from "@/lib/blueprints/validate";
import {
  AI_PROFILE_SETTING_KEY,
  BLUEPRINT_FORMAT,
  BLUEPRINT_FORMAT_VERSION,
  BLUEPRINT_ROLE_KEY_PATTERN,
  SAFE_SETTING_KEYS,
  SAFE_SETTING_SPEC,
  type Blueprint,
  type BlueprintField,
  type BlueprintForm,
  type BlueprintIntegration,
  type BlueprintItemKind,
  type BlueprintListView,
  type BlueprintObject,
  type BlueprintPage,
  type BlueprintRole,
  type BlueprintSetting,
  type BlueprintStatusOverride,
  type BlueprintValidation,
  type BlueprintWorkflow,
} from "@/lib/blueprints/types";

/** Mục KHÔNG vào gói, kèm vì sao. */
export type ExportOmission = { kind: BlueprintItemKind; key: string; reason: string };
/** Mục vào gói nhưng thiếu một phần mà định dạng blueprint không chở được. */
export type ExportLoss = { kind: BlueprintItemKind; key: string; message: string };

export type OrgExport = {
  blueprint: Blueprint;
  validation: BlueprintValidation;
  omitted: ExportOmission[];
  lossy: ExportLoss[];
  /** Băm NỘI DUNG (bỏ khoá / phiên bản / tên / mô tả của gói) — hai tổ chức cùng cấu hình ⇒ cùng băm. */
  contentHash: string;
  counts: { modules: number; roles: number; objects: number; fields: number; statuses: number; forms: number; lists: number; pages: number; workflows: number; settings: number; ai: number };
};

/** Trường của gói KHÔNG thuộc nội dung cấu hình: định danh + mô tả của chính tệp xuất. */
export const EXPORT_HEADER_FIELDS = ["key", "version", "name", "description", "industry"] as const;

/** Gói bỏ phần đầu — thứ hai lần xuất cùng một cấu hình phải trùng nhau từng byte. */
export function comparableBlueprint(bp: Blueprint): Omit<Blueprint, (typeof EXPORT_HEADER_FIELDS)[number]> {
  const out = { ...bp } as Record<string, unknown>;
  for (const k of EXPORT_HEADER_FIELDS) delete out[k];
  return out as Omit<Blueprint, (typeof EXPORT_HEADER_FIELDS)[number]>;
}

export function blueprintContentHash(bp: Blueprint): string {
  return stableHash(comparableBlueprint(bp));
}

/** Khoá gói xuất: `org-<mã tổ chức>` — cùng dạng khoá gói, không đụng khoá mẫu nào. */
export function exportKeyOf(orgCode: string): string {
  const clean = orgCode.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "");
  return `org-${clean || "to-chuc"}`.slice(0, 41);
}

/** Phiên bản gói = mốc xuất (UTC) `YYYY.MMDD.HHMM` — tăng dần, nên cài bản xuất mới hơn là một lượt NÂNG. */
export function exportVersionOf(now: Date): string {
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const hm = now.getUTCHours() * 100 + now.getUTCMinutes();
  return `${now.getUTCFullYear()}.${md}.${hm}`;
}

/** Tên tệp tải xuống — chỉ ASCII an toàn (khoá gói đã là `[a-z0-9-]`). */
export function exportFileName(bp: Pick<Blueprint, "key" | "version">): string {
  return `${bp.key}-${bp.version.replace(/\./g, "-")}.blueprint.json`;
}

const VALIDATION_KEYS = ["min", "max", "minLength", "maxLength", "pattern", "patternMessage"] as const;
const OPTION_TYPES = new Set(["select", "multi_select", "status"]);

function byKey<T>(get: (x: T) => string) {
  return (a: T, b: T) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0);
}

/** Field tuỳ biến ⇒ mục field của gói. Phần gói không chở được (mặc định, quyền riêng, khoá kiểm lạ) vào `lossy`. */
function fieldOf(d: CustomFieldDef, lossy: ExportLoss[]): BlueprintField {
  const key = `${d.objectKey}.${d.key}`;
  const validation: NonNullable<BlueprintField["validation"]> = {};
  const raw = (d.validation ?? {}) as Record<string, unknown>;
  for (const k of VALIDATION_KEYS) if (raw[k] !== undefined && raw[k] !== null) (validation as Record<string, unknown>)[k] = raw[k];
  const extra = Object.keys(raw).filter((k) => raw[k] !== undefined && raw[k] !== null && k !== "unique" && !(VALIDATION_KEYS as readonly string[]).includes(k));
  if (extra.length) lossy.push({ kind: "field", key, message: `Khoá kiểm ${extra.join(", ")} không có trong định dạng gói — bỏ.` });
  if (d.defaultValue !== null && d.defaultValue !== undefined) lossy.push({ kind: "field", key, message: "Giá trị mặc định không đi theo gói — đặt lại ở màn Field sau khi cài." });
  if (d.viewPermission || d.editPermission) lossy.push({ kind: "field", key, message: "Quyền xem / sửa riêng của field không đi theo gói — đặt lại sau khi cài." });
  const isRelation = d.type === "relation" || d.type === "relation_many";
  const unique = typeof raw.unique === "boolean" && d.type === "relation" ? raw.unique : undefined;
  const f: BlueprintField = { objectKey: d.objectKey, key: d.key, label: d.label, type: d.type };
  if (OPTION_TYPES.has(d.type) && d.options.length) {
    f.options = [...d.options]
      .sort((a, b) => a.position - b.position || byKey<{ value: string }>((o) => o.value)(a, b))
      .map((o) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: o.active, position: o.position }));
  }
  if (Object.keys(validation).length) f.validation = validation;
  if (d.type === "status" && Object.keys(d.transitions ?? {}).length) f.transitions = d.transitions;
  if (isRelation && d.relationObject) f.relation = { objectKey: d.relationObject, ...(unique !== undefined ? { unique } : {}) };
  if (d.required) f.required = true;
  if (!d.listable) f.listable = false;
  if (d.filterable) f.filterable = true;
  if (d.helpText?.trim()) f.helpText = d.helpText.trim();
  return f;
}

/** Tập mục của gói theo đường dẫn lỗi của bộ kiểm (`pages.3.schema…` ⇒ mục `pages[3]`). */
const PRUNABLE: readonly (keyof Blueprint)[] = ["roles", "objects", "fields", "statuses", "forms", "listViews", "pages", "workflows", "settings"];
const KIND_OF: Record<string, BlueprintItemKind> = { roles: "role", objects: "object", fields: "field", statuses: "status", forms: "form", listViews: "list", pages: "page", workflows: "workflow", settings: "setting", modules: "module" };

function itemKeyOf(section: string, item: unknown): string {
  const o = item as Record<string, string>;
  switch (section) {
    case "fields":
      return `${o.objectKey}.${o.key}`;
    case "statuses":
      return `${o.objectKey}.${o.field}`;
    case "forms":
      return `${o.objectKey}.${o.formKey}`;
    case "listViews":
      return `${o.objectKey}.${o.listKey}`;
    case "pages":
      return o.slug;
    case "modules":
      return String(item);
    default:
      return o.key;
  }
}

/**
 * Gỡ mục làm gói hỏng cho tới khi gói hợp lệ (tối đa vài vòng — gỡ một field có thể làm form trỏ nó hỏng theo). Lỗi
 * không gắn được vào một mục (hình tổng thể) thì DỪNG và trả nguyên lỗi: không đoán.
 */
function pruneUntilValid(bp: Blueprint, omitted: ExportOmission[]): BlueprintValidation {
  let v = validateBlueprint(bp);
  for (let round = 0; round < 8 && !v.ok; round++) {
    const drop = new Map<string, Map<number, string>>();
    let dropAi: string | null = null;
    let stuck = false;
    for (const e of v.errors) {
      const [section, idx] = e.path.split(".");
      if (section === "ai") {
        dropAi = e.message;
        continue;
      }
      const i = Number.parseInt(idx ?? "", 10);
      if (!(PRUNABLE as readonly string[]).includes(section) && section !== "modules") {
        stuck = true;
        continue;
      }
      if (!Number.isInteger(i)) {
        stuck = true;
        continue;
      }
      const m = drop.get(section) ?? new Map<number, string>();
      if (!m.has(i)) m.set(i, e.message);
      drop.set(section, m);
    }
    if (drop.size === 0 && !dropAi) break;
    for (const [section, rows] of drop) {
      const list = (bp as Record<string, unknown>)[section] as unknown[];
      for (const i of [...rows.keys()].sort((a, b) => b - a)) {
        omitted.push({ kind: KIND_OF[section], key: itemKeyOf(section, list[i]), reason: `Gói không hợp lệ nếu giữ mục này: ${rows.get(i)}` });
        list.splice(i, 1);
      }
    }
    if (dropAi) {
      omitted.push({ kind: "ai", key: "businessProfile", reason: `Ngữ cảnh AI sai hình: ${dropAi}` });
      delete bp.ai;
    }
    v = validateBlueprint(bp);
    if (stuck && !v.ok) break;
  }
  return v;
}

/**
 * Dựng blueprint từ cấu hình HIỆN TẠI của tổ chức ngữ cảnh. Chỉ đọc. `now` để bài kiểm ghim phiên bản.
 */
export async function exportOrgBlueprint(opts: { now?: Date } = {}): Promise<OrgExport> {
  const now = opts.now ?? new Date();
  const ctx = await currentOrganization();
  const org = await findOrganization(ctx.code);
  const orgName = org?.name ?? ctx.code;
  const omitted: ExportOmission[] = [];
  const lossy: ExportLoss[] = [];

  // ── Module: đang bật. Module cần thông tin kết nối của tổ chức NHÀ không bật được ở tổ chức khác ⇒ rời khỏi gói,
  //    connector thành GỢI Ý (không bao giờ cấu hình bí mật); module phụ thuộc vào nó rời theo. ──
  const enabled = await getEnabledModules();
  const modules = new Set<ModuleKey>(enabled);
  const integrations: BlueprintIntegration[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of [...modules]) {
      const def = moduleDef(m);
      if (!def) continue;
      const blockedBy = def.requiresHomeCredentials ? null : def.dependsOn.find((d) => !modules.has(d));
      if (def.requiresHomeCredentials || blockedBy) {
        modules.delete(m);
        changed = true;
        if (def.requiresHomeCredentials) {
          omitted.push({ kind: "module", key: m, reason: `«${def.label}» dùng thông tin kết nối của tổ chức nhà — tổ chức khác không bật được; chuyển thành gợi ý kết nối.` });
          if (def.category === "CONNECTOR") integrations.push({ connectorKey: m, reason: `Tổ chức gốc «${orgName}» dùng «${def.label}». Gói không mang thông tin đăng nhập nào — tự kết nối nếu cần.`.slice(0, 300) });
        } else omitted.push({ kind: "module", key: m, reason: `«${def.label}» cần «${moduleDef(blockedBy!)?.label ?? blockedBy}» — module đó không đi theo gói.` });
      }
    }
  }
  const moduleList = orderModules([...modules]);

  // ── Vai trò tuỳ chỉnh ──
  const roles: BlueprintRole[] = [];
  for (const r of [...(await listAccessRoles())].sort(byKey((x) => x.code))) {
    const key = r.code.toLowerCase();
    if (!r.active) {
      omitted.push({ kind: "role", key, reason: "Vai trò đang tắt — không đi theo gói." });
      continue;
    }
    if (!BLUEPRINT_ROLE_KEY_PATTERN.test(key)) {
      omitted.push({ kind: "role", key, reason: `Mã «${r.code}» không làm được khoá gói (phải bắt đầu bằng chữ, 2–40 ký tự).` });
      continue;
    }
    if (r.baseRole === "ADMIN") {
      omitted.push({ kind: "role", key, reason: "Vai trò nền ADMIN không đi theo gói (luật 31)." });
      continue;
    }
    const forbidden = r.permissions.filter((p) => ROLE_BUILDER_FORBIDDEN.includes(p));
    if (forbidden.length) lossy.push({ kind: "role", key, message: `Gỡ ${forbidden.join(", ")} — vai trò tuỳ chỉnh không được cấp (luật 31).` });
    roles.push({
      key,
      label: r.name,
      ...(r.description?.trim() ? { description: r.description.trim() } : {}),
      base: r.baseRole as BlueprintRole["base"],
      permissions: [...new Set(r.permissions.filter((p) => !ROLE_BUILDER_FORBIDDEN.includes(p)))].sort(),
      defaultScope: r.defaultScope,
    });
  }

  // ── Đối tượng tuỳ biến ACTIVE ──
  const customObjects = modules.has("apps") ? [...(await listCustomObjectDefs())].sort(byKey((d) => d.key)) : [];
  const objects: BlueprintObject[] = [];
  for (const d of customObjects) {
    if (!d.custom) continue;
    objects.push({
      key: d.key as `x_${string}`,
      label: d.label,
      labelPlural: d.labelPlural,
      icon: d.custom.icon,
      moduleKey: d.custom.menuModule as ModuleKey,
      titleLabel: d.custom.titleLabel,
      ...(d.custom.description?.trim() ? { description: d.custom.description.trim() } : {}),
      ...(d.custom.viewPermission !== "records:view" ? { viewPermission: d.custom.viewPermission } : {}),
      ...(d.custom.writePermission !== "records:write" ? { writePermission: d.custom.writePermission } : {}),
    });
  }

  // Đối tượng mang cấu hình: hệ thống (module đang bật) + tuỳ biến ACTIVE.
  const objectDefs: AnyObjectDef[] = [...OBJECT_REGISTRY.filter((o) => modules.has(o.module)), ...customObjects];
  const activeDefs = new Map<string, CustomFieldDef[]>();
  for (const def of objectDefs) {
    const custom = def.capabilities.customFields ? (await loadCustomDefs(def.key, false)).filter((f) => f.status === "ACTIVE") : [];
    activeDefs.set(def.key, [...custom].sort((a, b) => a.position - b.position || byKey<CustomFieldDef>((x) => x.key)(a, b)));
  }

  // ── Field tuỳ biến ACTIVE ──
  const fields: BlueprintField[] = [];
  for (const def of [...objectDefs].sort(byKey((d) => d.key))) for (const d of activeDefs.get(def.key) ?? []) fields.push(fieldOf(d, lossy));

  // ── Override trạng thái hệ thống ──
  const statuses: BlueprintStatusOverride[] = [];
  for (const def of OBJECT_REGISTRY.filter((o) => modules.has(o.module) && o.capabilities.statuses)) {
    for (const fieldKey of def.statusFields) {
      let rows: Awaited<ReturnType<typeof getStatusOverrides>>;
      try {
        rows = await getStatusOverrides(def.key, fieldKey);
      } catch (error) {
        omitted.push({ kind: "status", key: `${def.key}.${fieldKey}`, reason: `Không đọc được: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (rows.length === 0) continue;
      const known = (def.fields.find((f) => f.key === fieldKey)?.options ?? []).map((o) => o.value);
      statuses.push({
        objectKey: def.key,
        field: fieldKey,
        options: [...rows]
          .sort(byKey((r) => r.value))
          .map((r) => ({ value: r.value, label: (r.label ?? "").trim().slice(0, 60), position: r.position ?? Math.max(0, known.indexOf(r.value)), active: r.active })),
      });
    }
  }

  // ── Form + danh sách ĐÃ XUẤT BẢN (chỉ ô đang hiện — cùng phép chiếu của bộ lập kế hoạch) ──
  const forms: BlueprintForm[] = [];
  const listViews: BlueprintListView[] = [];
  for (const def of [...objectDefs].sort(byKey((d) => d.key))) {
    const custom = activeDefs.get(def.key) ?? [];
    if (def.capabilities.forms) {
      for (const f of def.forms) {
        const row = await loadConfigRow("FORM", def.key, f.key);
        if (!row || row.publishedVersion <= 0 || row.published === null || row.published === undefined) continue;
        const schema = projectForm(def, row.published as FormSchema, custom);
        if (schema) forms.push({ objectKey: def.key, formKey: f.key, schema, publish: true });
      }
    }
    if (def.capabilities.lists) {
      for (const l of def.lists) {
        const row = await loadConfigRow("LIST_VIEW", def.key, l.key);
        if (!row || row.publishedVersion <= 0 || row.published === null || row.published === undefined) continue;
        const schema = projectList(def, row.published as ListViewSchema, custom);
        if (schema) listViews.push({ objectKey: def.key, listKey: l.key, schema, publish: true });
      }
    }
  }

  // ── Trang ĐÃ XUẤT BẢN (bản người dùng đang thấy, không phải nháp) + menu ──
  const pages: BlueprintPage[] = [];
  for (const p of [...(await listPages())].sort(byKey((x) => x.slug))) {
    if (p.publishedVersion <= 0) {
      omitted.push({ kind: "page", key: p.slug, reason: "Trang chưa xuất bản lần nào — gói chỉ mang bản người dùng đang thấy." });
      continue;
    }
    if (!modules.has(p.moduleKey)) {
      omitted.push({ kind: "page", key: p.slug, reason: `Module chủ «${p.moduleKey}» không đi theo gói.` });
      continue;
    }
    const published = await getPageBySlug(p.slug);
    if (!published) continue;
    pages.push({
      slug: p.slug,
      name: p.name,
      moduleKey: p.moduleKey,
      requiredPermission: p.requiredPermission ?? null,
      nav: { enabled: p.nav.enabled, label: p.nav.label.trim() || p.name, zone: p.nav.zone ?? null, order: p.nav.order },
      // Bản đã xuất bản đã được `publishPage` chuẩn hoá — mang nguyên, không chuẩn hoá lần hai bằng một sổ nguồn khác.
      schema: published.schema,
      publish: true,
    });
  }

  // ── Luật: mọi luật chưa lưu trữ. Trạng thái / chế độ KHÔNG đi theo — bộ cài luôn sinh NHÁP + CHẠY THỬ (luật 23, 25). ──
  const workflows: BlueprintWorkflow[] = [];
  for (const r of [...(await listRules())].sort(byKey((x) => x.key))) {
    if (r.status === "ARCHIVED") continue;
    if (r.status === "ACTIVE" || r.mode === "LIVE") lossy.push({ kind: "workflow", key: r.key, message: `Đang ${r.status === "ACTIVE" ? "BẬT" : r.status}${r.mode === "LIVE" ? " · CHẠY THẬT" : ""} — cài vào tổ chức khác sẽ ở NHÁP + CHẠY THỬ; bật lại là việc của người.` });
    workflows.push({
      key: r.key,
      name: r.name,
      ...(r.description?.trim() ? { description: r.description.trim() } : {}),
      trigger: r.trigger,
      conditions: r.conditions ?? null,
      actions: r.actions,
      gate: r.gate ?? null,
    });
  }

  // ── Cài đặt: CHỈ danh sách an toàn đóng. Không một khoá nào khác được đọc ở đây. ──
  const settings: BlueprintSetting[] = [];
  for (const key of SAFE_SETTING_KEYS) {
    const value = await getSettingJson<unknown>(key, null);
    if (value === null || value === undefined) continue;
    if (!modules.has(SAFE_SETTING_SPEC[key].module)) continue;
    if (!SAFE_SETTING_VALUE_Z[key].safeParse(value).success) {
      omitted.push({ kind: "setting", key, reason: "Giá trị đang lưu sai hình — không đi theo gói." });
      continue;
    }
    settings.push({ key, value });
  }

  // ── Ngữ cảnh AI ──
  const aiRaw = await getSettingJson<{ businessProfile?: unknown; glossary?: unknown } | null>(AI_PROFILE_SETTING_KEY, null);
  let ai: Blueprint["ai"];
  if (aiRaw && typeof aiRaw.businessProfile === "string" && aiRaw.businessProfile.trim()) {
    const glossary = Array.isArray(aiRaw.glossary)
      ? (aiRaw.glossary as unknown[]).filter((g): g is { term: string; meaning: string } => !!g && typeof (g as { term?: unknown }).term === "string" && typeof (g as { meaning?: unknown }).meaning === "string").map((g) => ({ term: g.term.trim(), meaning: g.meaning.trim() }))
      : [];
    ai = { businessProfile: aiRaw.businessProfile.trim(), glossary };
  }

  const bp: Blueprint = {
    format: BLUEPRINT_FORMAT,
    formatVersion: BLUEPRINT_FORMAT_VERSION,
    key: exportKeyOf(ctx.code),
    version: exportVersionOf(now),
    name: `Cấu hình của ${orgName}`.slice(0, 120),
    description: `Xuất từ tổ chức «${orgName}» lúc ${now.toISOString()}. Chỉ cấu hình — không bản ghi, không người dùng, không bí mật kết nối.`.slice(0, 2000),
    industry: null,
    modules: moduleList,
    ...(roles.length ? { roles } : {}),
    ...(objects.length ? { objects } : {}),
    ...(fields.length ? { fields } : {}),
    ...(statuses.length ? { statuses } : {}),
    ...(forms.length ? { forms } : {}),
    ...(listViews.length ? { listViews } : {}),
    ...(pages.length ? { pages } : {}),
    ...(workflows.length ? { workflows } : {}),
    ...(settings.length ? { settings } : {}),
    ...(integrations.length ? { integrations } : {}),
    ...(ai ? { ai } : {}),
  };

  const validation = pruneUntilValid(bp, omitted);
  // Mảng rỗng sau khi gỡ ⇒ bỏ hẳn khoá (hai tổ chức cùng cấu hình phải ra cùng một hình).
  for (const k of PRUNABLE) if (Array.isArray(bp[k]) && (bp[k] as unknown[]).length === 0) delete bp[k];

  return {
    blueprint: bp,
    validation,
    omitted,
    lossy,
    contentHash: blueprintContentHash(bp),
    counts: {
      modules: bp.modules.length,
      roles: bp.roles?.length ?? 0,
      objects: bp.objects?.length ?? 0,
      fields: bp.fields?.length ?? 0,
      statuses: bp.statuses?.length ?? 0,
      forms: bp.forms?.length ?? 0,
      lists: bp.listViews?.length ?? 0,
      pages: bp.pages?.length ?? 0,
      workflows: bp.workflows?.length ?? 0,
      settings: bp.settings?.length ?? 0,
      ai: bp.ai ? 1 : 0,
    },
  };
}

// ═══ CỬA VÀO CHO MÀN HÌNH / ROUTE ═══

/** Vì sao người này KHÔNG xuất được (`null` = được). Xuất là đọc CẢ cấu hình, nên cần cả hai khoá quản trị. */
export function exportDenial(user: SessionUser): string | null {
  if (!can(user, "metadata:manage") || !can(user, "settings:manage")) return "Xuất cấu hình cần quyền cấu hình dữ liệu VÀ cấu hình hệ thống.";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  return null;
}

/**
 * Xuất cho NGƯỜI của phiên: kiểm quyền lần hai, và tổ chức của phiên phải TRÙNG tổ chức ngữ cảnh — một phiên của A
 * chạy trong ngữ cảnh B (lỗi định tuyến, gọi tay) bị từ chối thay vì xuất cấu hình của B cho người của A.
 */
export async function exportForUser(user: SessionUser, opts: { now?: Date } = {}): Promise<{ ok: true; value: OrgExport } | { ok: false; error: string }> {
  const denial = exportDenial(user);
  if (denial) return { ok: false, error: denial };
  const ctx = await currentOrganization();
  if (user.organization!.code !== ctx.code) return { ok: false, error: "Phiên đăng nhập thuộc tổ chức khác với ngữ cảnh đang chạy — tải lại trang." };
  return { ok: true, value: await exportOrgBlueprint(opts) };
}

/** Khoá gói không dùng được cho tệp tải lên / tệp xuất: trùng khoá mẫu ngành sẽ trộn sổ cài của mẫu. */
export function isTemplateKey(key: string): boolean {
  return BLUEPRINT_TEMPLATES.some((t) => t.key === key);
}
