/**
 * ═══════════ ẢNH CHỤP METADATA CHO CHẾ ĐỘ SỬA LẶP (Phase 8 · §2) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 * Đọc qua dịch vụ đọc sẵn có trong CSDL của tổ chức NGỮ CẢNH (`getDb()` chọn silo) và CHỌN TỪNG Ô: tên + khoá + kiểu.
 * Không đọc bản ghi, giá trị field, người dùng (kể cả "người sửa cuối"), cài đặt hay kết nối — tệp này không import
 * `lib/connectors/*` và không đọc `settings` (bài kiểm quét).
 */
import { OBJECT_REGISTRY } from "@/lib/constants/object-registry";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { loadCustomDefs } from "@/lib/metadata/common";
import { loadConfigRow } from "@/lib/metadata/config-store";
import type { CustomFieldDef } from "@/lib/metadata/types";
import { listPages } from "@/lib/pages/registry";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { listAccessRoles } from "@/lib/queries/access";
import { listRules } from "@/lib/workflow/rules";
import type { WorkflowRule } from "@/lib/workflow/types";
import type { OrgMetadataSnapshot } from "@/lib/ai-builder/prompt";

export type OrgBuilderState = {
  snapshot: OrgMetadataSnapshot;
  enabledModules: ModuleKey[];
  /** Field tuỳ biến ĐANG DÙNG theo đối tượng — để máy chủ gắn field đã có mà mảnh tham chiếu. */
  customDefs: Record<string, CustomFieldDef[]>;
};

function triggerText(r: WorkflowRule): string {
  const t = r.trigger;
  return t.kind === "event" ? `sự kiện ${t.event}` : `${t.objectKey}.${t.fieldKey} → ${t.to.join("|")}`;
}

export async function readOrgBuilderState(): Promise<OrgBuilderState> {
  const modules = await getEnabledModules();
  const customDefs: Record<string, CustomFieldDef[]> = {};
  const objects: OrgMetadataSnapshot["objects"] = [];
  for (const o of OBJECT_REGISTRY) {
    if (!o.customizable || !modules.has(o.module)) continue;
    const defs = o.capabilities.customFields ? (await loadCustomDefs(o.key, false)).filter((d) => d.status === "ACTIVE") : [];
    customDefs[o.key] = defs;
    const forms: { key: string; published: boolean }[] = [];
    for (const f of o.forms) {
      const row = await loadConfigRow("FORM", o.key, f.key);
      if (row) forms.push({ key: f.key, published: (row.publishedVersion ?? 0) > 0 });
    }
    const lists: { key: string; published: boolean }[] = [];
    for (const l of o.lists) {
      const row = await loadConfigRow("LIST_VIEW", o.key, l.key);
      if (row) lists.push({ key: l.key, published: (row.publishedVersion ?? 0) > 0 });
    }
    objects.push({
      key: o.key,
      label: o.label,
      customFields: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.options.filter((x) => x.active).map((x) => ({ value: x.value, label: x.label })) })),
      forms,
      lists,
    });
  }
  const pages = (await listPages()).map((p) => ({ slug: p.slug, name: p.name, moduleKey: p.moduleKey, published: p.publishedVersion > 0 }));
  const rules = (await listRules()).filter((r) => r.status !== "ARCHIVED").map((r) => ({ key: r.key, name: r.name, status: r.status, trigger: triggerText(r), gate: r.gate?.kind === "approval" }));
  const roles = (await listAccessRoles()).filter((r) => r.active).map((r) => ({ code: r.code, name: r.name, baseRole: r.baseRole }));
  return { snapshot: { modules: [...modules].sort(), objects, pages, rules, roles }, enabledModules: [...modules], customDefs };
}
