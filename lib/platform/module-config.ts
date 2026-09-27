import { and, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { PLATFORM_MODULES, validateModuleChange, type ModuleKey } from "@/lib/constants/platform-modules";
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { getEnabledModules, getModuleRows, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ ĐƯỜNG GHI DUY NHẤT CỦA CẤU HÌNH MODULE ═══════════
 *
 * Bật / tắt là MỘT DÒNG dữ liệu — không sinh mã, không build, không deploy (yêu cầu mục 32). Thứ tự:
 *
 *  1. Kiểm bằng hàm thuần của sổ (`validateModuleChange`): core không tắt được, phụ thuộc thiếu thì
 *     CHẶN + GIẢI THÍCH, còn module đang phụ thuộc vào nó thì CHẶN + nêu tên (target-architecture P10).
 *  2. Ghi dòng.
 *  3. Nhật ký nền tảng (CSDL nhà) — hỏng là cả lượt hỏng (hợp đồng mục 10).
 *  4. Nhật ký của CHÍNH tổ chức bị đổi (`audit_logs` trong CSDL của nó) để quản trị của họ cũng thấy.
 *     `user_id` chỉ ghi khi người bấm là thành viên của tổ chức đó — người vận hành nền tảng (tổ chức
 *     nhà) không có dòng `users` trong CSDL kia, ghi khoá của họ vào đó là một FK trỏ vào hư không.
 *  5. Xoá đệm năng lực ⇒ lần dựng kế tiếp thấy ngay.
 *
 * Người gọi (server action) chịu trách nhiệm KIỂM QUYỀN trước; hàm này chỉ kiểm tính hợp lệ.
 */

export type ModuleChangeResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "ORG_UNKNOWN" | "CORE_MODULE" | "MISSING_DEPENDENCY" | "HAS_DEPENDENTS" | "REQUIRES_HOME_CREDENTIALS" | "UNKNOWN_MODULE" | "UNKNOWN_FEATURE"; message: string; related: string[] };

type ChangeInput = { orgCode: string; reason?: string | null; actor: PlatformActor; source: PlatformAuditSource };

async function tenantAudit(orgCode: string, actor: PlatformActor, entry: { action: string; entityId: string; before: unknown; after: unknown; reason?: string | null }) {
  await withOrganization(orgCode, () =>
    audit({
      userId: actor && actor.orgCode === orgCode ? actor.userId : null,
      userEmail: actor ? (actor.orgCode === orgCode ? actor.email : `${actor.email} (vận hành nền tảng · ${actor.orgCode})`) : "system",
      actorKind: actor ? "USER" : "SYSTEM",
      action: entry.action,
      entity: "PLATFORM_MODULE",
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
      ...(entry.reason ? { reason: entry.reason } : {}),
    }),
  );
}

export async function setOrganizationModule(input: ChangeInput & { moduleKey: string; enabled: boolean }): Promise<ModuleChangeResult> {
  const org = await findOrganization(input.orgCode);
  if (!org) return { ok: false, code: "ORG_UNKNOWN", message: `Không có tổ chức "${input.orgCode}".`, related: [] };
  invalidateCapabilities(org.code);
  const current = await getEnabledModules(org.code);
  const check = validateModuleChange(current, input.moduleKey, input.enabled, { orgIsHome: org.isHome });
  if (!check.ok) return { ok: false, code: check.code, message: check.message, related: [...check.related] };
  const wasEnabled = current.has(input.moduleKey as ModuleKey);
  if (wasEnabled === input.enabled) return { ok: true, changed: false };

  const db = await getPlatformDb();
  const now = new Date();
  const updatedBy = input.actor ? `${input.actor.orgCode}:${input.actor.userId}` : `system:${input.source.toLowerCase()}`;
  await db
    .insert(schema.platformOrganizationModules)
    .values({ organizationId: org.id, moduleKey: input.moduleKey, enabled: input.enabled, enabledAt: input.enabled ? now : null, disabledAt: input.enabled ? null : now, updatedBy })
    .onConflictDoUpdate({
      target: [schema.platformOrganizationModules.organizationId, schema.platformOrganizationModules.moduleKey],
      set: input.enabled ? { enabled: true, enabledAt: now, updatedBy, updatedAt: now } : { enabled: false, disabledAt: now, updatedBy, updatedAt: now },
    });
  const action = input.enabled ? "MODULE_ENABLE" : "MODULE_DISABLE";
  await platformAudit({ action, targetOrgCode: org.code, subject: input.moduleKey, before: { enabled: wasEnabled }, after: { enabled: input.enabled }, reason: input.reason ?? null, source: input.source, actor: input.actor });
  invalidateCapabilities(org.code);
  await tenantAudit(org.code, input.actor, { action, entityId: input.moduleKey, before: { enabled: wasEnabled }, after: { enabled: input.enabled }, reason: input.reason });
  return { ok: true, changed: true };
}

/** Bật/tắt một feature (`<module>.<feature>`). Feature chỉ có hiệu lực khi module của nó bật. */
export async function setOrganizationFeature(input: ChangeInput & { featureKey: string; enabled: boolean }): Promise<ModuleChangeResult> {
  const org = await findOrganization(input.orgCode);
  if (!org) return { ok: false, code: "ORG_UNKNOWN", message: `Không có tổ chức "${input.orgCode}".`, related: [] };
  const moduleKey = input.featureKey.split(".")[0];
  const def = PLATFORM_MODULES.find((m) => m.key === moduleKey);
  if (!def) return { ok: false, code: "UNKNOWN_MODULE", message: `Không có module "${moduleKey}".`, related: [] };
  const feature = def.features.find((f) => f.key === input.featureKey);
  if (!feature) return { ok: false, code: "UNKNOWN_FEATURE", message: `Module "${def.label}" không có tính năng "${input.featureKey}".`, related: [] };

  invalidateCapabilities(org.code);
  const { rows } = await getModuleRows(org.code);
  const row = rows.find((r) => r.moduleKey === moduleKey);
  const before = row?.features?.[input.featureKey] ?? feature.defaultEnabled;
  if (before === input.enabled && row?.features?.[input.featureKey] !== undefined) return { ok: true, changed: false };

  const db = await getPlatformDb();
  const now = new Date();
  const updatedBy = input.actor ? `${input.actor.orgCode}:${input.actor.userId}` : `system:${input.source.toLowerCase()}`;
  const features = { ...(row?.features ?? {}), [input.featureKey]: input.enabled };
  if (row) {
    await db
      .update(schema.platformOrganizationModules)
      .set({ features, updatedBy, updatedAt: now })
      .where(and(eq(schema.platformOrganizationModules.organizationId, org.id), eq(schema.platformOrganizationModules.moduleKey, moduleKey)));
  } else {
    // Chưa có dòng module: trạng thái bật/tắt của module giữ nguyên theo `module_default` của tổ chức.
    const enabledNow = (await getEnabledModules(org.code)).has(moduleKey as ModuleKey);
    await db.insert(schema.platformOrganizationModules).values({ organizationId: org.id, moduleKey, enabled: enabledNow, features, enabledAt: enabledNow ? now : null, updatedBy });
  }
  await platformAudit({ action: "FEATURE_SET", targetOrgCode: org.code, subject: input.featureKey, before: { enabled: before }, after: { enabled: input.enabled }, reason: input.reason ?? null, source: input.source, actor: input.actor });
  invalidateCapabilities(org.code);
  await tenantAudit(org.code, input.actor, { action: "FEATURE_SET", entityId: input.featureKey, before: { enabled: before }, after: { enabled: input.enabled }, reason: input.reason });
  return { ok: true, changed: true };
}
