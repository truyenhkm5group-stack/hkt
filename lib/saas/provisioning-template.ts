/**
 * ═══════════ BƯỚC «MẪU» CỦA JOB TẠO KHÁCH — CHỈ MÁY CHỦ (lib/saas/create-customer-rules.ts §3) ═══════════
 *
 * Khách CHỈ thuê Chốt Đơn sống trong vỏ app 8 mục, nơi `/settings/templates` bị cổng vỏ chặn — nên họ không tự cài được mẫu
 * «Chỉ cần AI bán hàng» mà `/start` cài cho cửa hàng tự đăng ký (vai trò Nhân viên bán hàng, field cho bot đọc, luật «Đơn chốt ⇒
 * báo nhóm», hồ sơ cửa hàng cho AI). Bước này cài ĐÚNG mẫu đó bằng ĐÚNG bộ cài của `/start`: `buildSignupBlueprint` → `installBlueprint`
 * trong `withOrganization`, người đứng tên là quản trị đầu tiên (`adminSessionUser`) — không có đường ghi thứ hai. Bộ cài luôn ghi
 * luật ở NHÁP (luật 23: mẫu không tự kích hoạt).
 *
 * IDEMPOTENT: mẫu đã cài XONG đúng phiên bản ⇒ SKIPPED, không thêm lượt cài nào vào sổ — chạy lại job không nhân đôi vai trò,
 * field, luật. Lượt cài trước hỏng giữa chừng ⇒ bộ cài đi tiếp từ sổ (mục đã ghi thành UNCHANGED).
 *
 * KHÔNG BAO GIỜ NÉM (cùng khuôn bước thuê bao của `/start`, lib/saas/signup-subscriptions.ts): tới bước này workspace, quản trị,
 * thuê bao và thu phí đã xong — khách vẫn dùng được AI bán hàng, chỉ thiếu phần dựng sẵn. Hỏng ⇒ trả `FAILED` kèm câu lỗi (job
 * ghi vào bước TEMPLATE), `console.warn`, và MỘT dòng nhật ký nền tảng `ORG_SETUP` · chủ đề `provisioning-template` (trang khách
 * của người vận hành đọc được).
 */
import { installBlueprint } from "@/lib/blueprints/install";
import { installedVersion } from "@/lib/blueprints/ledger";
import { BLUEPRINT_ITEM_KIND_LABEL, type BlueprintItemKind } from "@/lib/blueprints/types";
import { buildSignupBlueprint, suggestedModules } from "@/lib/onboarding/blueprint";
import { adminSessionUser } from "@/lib/onboarding/service";
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import type { CreateTemplate } from "@/lib/saas/create-customer-rules";

/** Chủ đề của dòng nhật ký nền tảng `ORG_SETUP` khi bước này hỏng. */
export const PROVISIONING_TEMPLATE_AUDIT_SUBJECT = "provisioning-template";

export type TemplateStepOutcome = { status: "DONE" | "SKIPPED" | "FAILED"; detail: string; installId: string | null };

let faultHook: (() => void) | null = null;
/** Chỉ bộ kiểm thử gọi: ném BÊN TRONG vùng bắt lỗi của bước — lỗi tiêm đi đúng đường của một lỗi thật. `null` để gỡ. */
export function setProvisioningTemplateFaultForTests(hook: (() => void) | null) {
  faultHook = hook;
}

function doneSummary(outcomes: readonly { kind: BlueprintItemKind; status: string }[]): string {
  const n = new Map<BlueprintItemKind, number>();
  for (const o of outcomes) if (o.status === "DONE") n.set(o.kind, (n.get(o.kind) ?? 0) + 1);
  const label = (kind: BlueprintItemKind) => BLUEPRINT_ITEM_KIND_LABEL[kind].charAt(0).toLowerCase() + BLUEPRINT_ITEM_KIND_LABEL[kind].slice(1);
  return [...n].map(([kind, count]) => `${count} ${label(kind)}`).join(" · ") || "không mục nào cần ghi";
}

export async function installProvisioningTemplate(input: { orgCode: string; adminEmail: string; template: CreateTemplate; actor: PlatformActor; auditSource: PlatformAuditSource }): Promise<TemplateStepOutcome> {
  try {
    const org = await findOrganization(input.orgCode);
    if (!org) throw new Error(`Không có workspace "${input.orgCode}".`);
    if (org.isHome) throw new Error("Workspace nhà không nhận mẫu qua job «Tạo khách».");
    // CÙNG bản nháp mà /start dựng cho loại hình «Chỉ cần AI bán hàng»: mẫu + module gợi ý của chính mẫu.
    const built = buildSignupBlueprint({ businessType: input.template.businessType, templateKey: input.template.templateKey, modules: suggestedModules(input.template.templateKey, input.template.businessType) });
    if ("error" in built) throw new Error(built.error);
    const installed = await withOrganization(org.code, () => installedVersion(built.bp.key));
    if (installed === built.bp.version) return { status: "SKIPPED", detail: `«${built.bp.name}» ${installed} đã cài từ trước — không cài lại`, installId: null };
    const subject = await adminSessionUser(org.code, org.name, input.adminEmail.trim().toLowerCase());
    if (!subject) throw new Error("Workspace chưa có quản trị đang hoạt động — không có người đứng tên lượt cài mẫu.");
    faultHook?.();
    const result = await withOrganization(org.code, () => installBlueprint(built.bp, subject));
    if (!result.ok) throw new Error(`Cài «${built.bp.name}» hỏng: ${result.errors.map((e) => e.message).join(" · ")}`);
    return { status: "DONE", detail: `cài «${built.bp.name}» ${built.bp.version}: ${doneSummary(result.outcomes)} (luật ở NHÁP) · lượt cài ${result.installId.slice(0, 8)}`, installId: result.installId };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.warn(`[saas] chưa cài được mẫu «${input.template.label}» cho ${input.orgCode}: ${error}`);
    try {
      await platformAudit({ action: "ORG_SETUP", targetOrgCode: input.orgCode, subject: PROVISIONING_TEMPLATE_AUDIT_SUBJECT, after: { step: "TEMPLATE", outcome: "FAILED", template: input.template.templateKey }, reason: error, source: input.auditSource, actor: input.actor });
    } catch (auditError) {
      console.warn(`[saas] không ghi được nhật ký lỗi cài mẫu cho ${input.orgCode}: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
    }
    return { status: "FAILED", detail: `${error} — cấp phát vẫn xong (workspace · quản trị · thuê bao · thu phí); khách dùng được AI bán hàng, chỉ thiếu phần dựng sẵn của mẫu «${input.template.label}».`, installId: null };
  }
}
