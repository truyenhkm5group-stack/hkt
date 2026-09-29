import { getPlatformDb, schema } from "@/db";

/**
 * NHẬT KÝ NỀN TẢNG (`platform_audit_log`, CSDL nhà) — hợp đồng mục 10.
 *
 * Mọi lượt đổi module / feature / cờ / tổ chức ghi ở đây: ai (tổ chức + tài khoản), tổ chức đích,
 * khoá, trước → sau, lý do, nguồn. `actor = null` nghĩa là MÁY (migration, script, kiểm thử) — khác
 * hẳn "không biết ai" (AGENTS.md luật 34).
 *
 * Hàm này NÉM khi ghi hỏng, và bên gọi phải ghi nhật ký TRƯỚC khi coi lượt đổi cấu hình là xong:
 * một cấu hình đổi mà không có vết thì không ai trả lời được "vì sao hôm qua tổ chức X mất module Y".
 */
export type PlatformAuditAction = "MODULE_ENABLE" | "MODULE_DISABLE" | "FEATURE_SET" | "FLAG_SET" | "ORG_CREATE" | "ORG_STATUS" | "ORG_SETUP" | "INVITE_CREATE" | "INVITE_REVOKE" | "SIGNUP_MODE_SET" | "SECRETS_SELF_TEST" | "AI_SWITCH_SET" | "AI_ORG_CONTROL_SET"
  // Vận hành khách pilot (docs/platform/pilot-operations.md): lượt MỞ trang sức khoẻ một tổ chức (hỗ trợ có vết), đổi
  // giai đoạn / xác nhận UAT, tắt kết nối của tổ chức. Đình chỉ ⇒ `ORG_STATUS`; tạm dừng luật ⇒ `FLAG_SET`.
  | "SUPPORT_VIEW"
  | "PILOT_STAGE"
  | "PILOT_UAT"
  | "CONNECTION_DISABLE"
  // Người vận hành đổi gói của một tổ chức sau lúc tạo (`lib/platform/org-plan.ts`).
  | "ORG_PLAN_SET"
  // Hành trình tự phục vụ (0180, `lib/platform/publish.ts`): khách chọn tên miền con, khách bấm Xuất bản.
  | "ORG_DOMAIN_SET"
  | "ORG_PUBLISH";
export type PlatformAuditSource = "UI" | "SCRIPT" | "MIGRATION" | "TEST";
export type PlatformActor = { orgCode: string; userId: string; email: string } | null;

export async function platformAudit(entry: {
  action: PlatformAuditAction;
  targetOrgCode: string;
  subject: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  source: PlatformAuditSource;
  actor: PlatformActor;
}): Promise<void> {
  const db = await getPlatformDb();
  await db.insert(schema.platformAuditLog).values({
    actorOrgCode: entry.actor?.orgCode ?? null,
    actorUserId: entry.actor?.userId ?? null,
    actorEmail: entry.actor?.email ?? null,
    targetOrgCode: entry.targetOrgCode,
    action: entry.action,
    subject: entry.subject,
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
    reason: entry.reason ?? null,
    source: entry.source,
  });
}
