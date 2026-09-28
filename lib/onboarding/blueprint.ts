/**
 * ═══════════ BẢN NHÁP ĐĂNG KÝ ⇒ BLUEPRINT (Phase 10 · §2) — THUẦN ═══════════
 *
 * Onboarding KHÔNG có đường ghi thứ hai: nó dựng ra MỘT blueprint rồi đưa cho đúng bộ lập kế hoạch
 * (`planBlueprint`) và bộ cài (`installBlueprint`) của Phase 7.
 *
 *  · Có mẫu ⇒ mẫu đó, CẮT theo module người chọn: mục của mẫu nằm trong module KHÔNG được chọn thì bỏ ra và NÓI RA
 *    (`dropped`) — để nguyên thì kế hoạch BỊ CHẶN ("module sẽ không bật"), cắt lặng lẽ thì người dùng không biết mình
 *    mất gì. Module người chọn thêm ngoài mẫu vẫn vào gói (khoá gói giữ nguyên để lần nâng mẫu sau còn nhận ra).
 *  · "Bắt đầu trắng" ⇒ gói chỉ có module (`start-blank`) — cùng bộ cài, cùng sổ cài, cùng nhật ký.
 *
 * `freshOrgState` là ảnh chụp của MỘT TỔ CHỨC CHƯA TỒN TẠI (chỉ có module lõi) — đủ cho bước Xem trước, vì lúc đó
 * chưa có CSDL nào để đọc. Lúc cài, `installBlueprint` lập LẠI kế hoạch trên tổ chức thật.
 */
import { moduleDef, moduleOfPermission, type ModuleKey } from "@/lib/constants/platform-modules";
import { objectDef } from "@/lib/constants/object-registry";
import type { OrgState } from "@/lib/blueprints/plan";
import { templateBlueprint } from "@/lib/blueprints/templates";
import { BLUEPRINT_FORMAT, BLUEPRINT_FORMAT_VERSION, SAFE_SETTING_SPEC, type Blueprint } from "@/lib/blueprints/types";
import { BUSINESS_TYPE_SPEC, CORE_MODULES, closeUnderDependencies, type PlanStep } from "@/lib/onboarding/shared";

export const BLANK_BLUEPRINT_KEY = "start-blank";

export type DroppedItem = { kind: string; key: string; label: string; reason: string };
export type SignupBlueprint = { bp: Blueprint; modules: ModuleKey[]; autoAdded: ModuleKey[]; dropped: DroppedItem[]; fromTemplate: string | null };

function objectModule(objectKey: string): ModuleKey | null {
  return objectDef(objectKey)?.module ?? null;
}

function moduleLabel(k: string): string {
  return moduleDef(k)?.label ?? k;
}

/** Cắt một blueprint theo tập module (đã đóng dưới phụ thuộc, gồm lõi). */
export function tailorBlueprint(source: Blueprint, modules: readonly ModuleKey[]): { bp: Blueprint; dropped: DroppedItem[] } {
  const on = new Set<ModuleKey>([...CORE_MODULES, ...modules]);
  const dropped: DroppedItem[] = [];
  const off = (m: ModuleKey | null) => m !== null && !on.has(m);
  const why = (m: ModuleKey) => `Module «${moduleLabel(m)}» không được chọn`;

  const keepByObject = <T extends { objectKey: string }>(kind: string, rows: T[] | undefined, key: (r: T) => string, label: (r: T) => string): T[] | undefined => {
    if (!rows) return rows;
    return rows.filter((r) => {
      const m = objectModule(r.objectKey);
      if (!off(m)) return true;
      dropped.push({ kind, key: key(r), label: label(r), reason: why(m!) });
      return false;
    });
  };

  const fields = keepByObject("field", source.fields, (f) => `${f.objectKey}.${f.key}`, (f) => f.label);
  const statuses = keepByObject("status", source.statuses, (s) => `${s.objectKey}.${s.field}`, (s) => `${s.objectKey}.${s.field}`);
  const forms = keepByObject("form", source.forms, (f) => `${f.objectKey}.${f.formKey}`, (f) => `Form ${f.objectKey}`);
  const listViews = keepByObject("list", source.listViews, (l) => `${l.objectKey}.${l.listKey}`, (l) => `Danh sách ${l.objectKey}`);
  const pages = source.pages?.filter((p) => {
    if (on.has(p.moduleKey)) return true;
    dropped.push({ kind: "page", key: p.slug, label: p.name, reason: why(p.moduleKey) });
    return false;
  });
  const workflows = source.workflows?.filter((w) => {
    const m = w.trigger.kind === "custom_status" ? objectModule(w.trigger.objectKey) : null;
    if (!off(m)) return true;
    dropped.push({ kind: "workflow", key: w.key, label: w.name, reason: why(m!) });
    return false;
  });
  const settings = source.settings?.filter((s) => {
    const m = SAFE_SETTING_SPEC[s.key].module;
    if (on.has(m)) return true;
    dropped.push({ kind: "setting", key: s.key, label: SAFE_SETTING_SPEC[s.key].label, reason: why(m) });
    return false;
  });
  // Vai trò: bỏ khoá quyền thuộc module không bật (can() sẽ trả false cho chúng dù có ghi); hết khoá thì bỏ vai trò.
  const roles = source.roles
    ?.map((r) => ({ ...r, permissions: r.permissions.filter((p) => !off(moduleOfPermission(p))) }))
    .filter((r) => {
      if (r.permissions.length > 0) return true;
      dropped.push({ kind: "role", key: r.key, label: r.label, reason: "Mọi quyền của vai trò thuộc module không được chọn" });
      return false;
    });
  const integrations = source.integrations?.filter((i) => (moduleDef(i.connectorKey)?.dependsOn ?? []).every((d) => on.has(d)));

  const bp: Blueprint = {
    ...source,
    modules: [...on],
    ...(roles ? { roles } : {}),
    ...(fields ? { fields } : {}),
    ...(statuses ? { statuses } : {}),
    ...(forms ? { forms } : {}),
    ...(listViews ? { listViews } : {}),
    ...(pages ? { pages } : {}),
    ...(workflows ? { workflows } : {}),
    ...(settings ? { settings } : {}),
    ...(integrations ? { integrations } : {}),
  };
  return { bp, dropped };
}

/** Gói "bắt đầu trắng": chỉ module. */
export function blankBlueprint(modules: readonly ModuleKey[]): Blueprint {
  return {
    format: BLUEPRINT_FORMAT,
    formatVersion: BLUEPRINT_FORMAT_VERSION,
    key: BLANK_BLUEPRINT_KEY,
    version: "1.0.0",
    name: "Bắt đầu trắng",
    description: "Không mẫu ngành: chỉ bật những module người tạo tổ chức đã chọn.",
    industry: null,
    modules: [...new Set<ModuleKey>([...CORE_MODULES, ...modules])],
  };
}

/** Bước "Mẫu + Module" của bản nháp ⇒ blueprint sẽ cài. Mẫu lạ ⇒ lỗi (không đoán). */
export function buildSignupBlueprint(step: PlanStep): SignupBlueprint | { error: string } {
  const closed = closeUnderDependencies(step.modules);
  if (step.templateKey === null) {
    return { bp: blankBlueprint(closed.modules), modules: closed.modules, autoAdded: closed.added, dropped: [], fromTemplate: null };
  }
  const template = templateBlueprint(step.templateKey);
  if (!template) return { error: `Không có mẫu «${step.templateKey}».` };
  const { bp, dropped } = tailorBlueprint(template, closed.modules);
  return { bp, modules: closed.modules, autoAdded: closed.added, dropped, fromTemplate: template.key };
}

/** Module gợi ý khi vừa chọn một mẫu / loại hình (không tính lõi). */
export function suggestedModules(templateKey: string | null, businessType: keyof typeof BUSINESS_TYPE_SPEC): ModuleKey[] {
  const template = templateKey ? templateBlueprint(templateKey) : null;
  const raw = template ? template.modules : BUSINESS_TYPE_SPEC[businessType].modules;
  return closeUnderDependencies(raw).modules;
}

/** Ảnh chụp của một tổ chức chưa có gì ngoài lõi — cho bước Xem trước trước khi CSDL tồn tại. */
export function freshOrgState(): OrgState {
  return { enabledModules: [...CORE_MODULES], orgIsHome: false, installedVersion: null, installed: {}, entities: {}, customDefs: {} };
}
