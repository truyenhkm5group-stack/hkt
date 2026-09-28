"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { createSession, getCurrentUser, requirePermission, type SessionUser } from "@/lib/auth/session";
import { createInvite, revokeInvite } from "@/lib/onboarding/invites";
import { checkAdminStep, checkInviteStep, checkOrgStep, createOrganizationFromSignup, previewSignup, retryOrganizationSetup, type SignupActor } from "@/lib/onboarding/service";
import type { SignupPreview, SignupStepResult } from "@/lib/onboarding/shared";
import { setSignupSetting } from "@/lib/onboarding/signup-mode";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ SERVER ACTION CỦA `/start` VÀ MÃ MỜI Ở `/platform` (Phase 10) ═══════════
 *
 * Mọi quyết định ở lõi `lib/onboarding/service.ts`; tệp này chỉ làm việc của Next: đọc IP (phần Caddy ghi —
 * `clientIpFrom`), đọc PHIÊN để biết người gọi có phải người vận hành nền tảng không (không bao giờ tin một cờ từ
 * client), ghi cookie phiên khi khách tạo xong, chuyển trang. Lỗi nghiệp vụ trả `{ error }`, không ném.
 */

async function ipOfRequest(): Promise<string> {
  return clientIpFrom((await headers()).get("x-forwarded-for"));
}

function operatorOf(user: SessionUser | null): SignupActor | null {
  if (!user || platformOperatorDenial(user)) return null;
  return { kind: "operator", ip: "", actor: { orgCode: user.organization!.code, userId: user.id, email: user.email } };
}

/** Người đang đi luồng: người vận hành (từ PHIÊN) hoặc khách. */
async function whoAmI(): Promise<SignupActor> {
  const ip = await ipOfRequest();
  const op = operatorOf(await getCurrentUser());
  return op ? { ...op, ip } : { kind: "public", ip };
}

export async function checkInviteAction(code: string): Promise<SignupStepResult> {
  return checkInviteStep(code, await whoAmI());
}

export async function checkOrgAction(org: { name: string; code: string }, invite: string | null): Promise<SignupStepResult> {
  return checkOrgStep(org, invite, await whoAmI());
}

export async function checkAdminAction(admin: { name: string; email: string; password: string }): Promise<SignupStepResult> {
  return checkAdminStep(admin);
}

export async function previewSignupAction(input: { invite: string | null; orgCode: string; plan: unknown; planKey: string | null }): Promise<{ ok: true; preview: SignupPreview } | { error: string }> {
  return previewSignup(input, await whoAmI());
}

/**
 * Tạo. Khách: thành công ⇒ phiên của quản trị mới (đúng `verifyLogin` của màn đăng nhập) rồi vào `/`. Người vận hành:
 * KHÔNG đổi phiên của họ — trả mã tổ chức để màn hình đưa về `/platform`.
 */
export async function createOrganizationAction(draft: unknown): Promise<{ ok: true; orgCode: string; operator: boolean } | { error: string }> {
  const who = await whoAmI();
  const result = await createOrganizationFromSignup(draft, who, who.kind === "public" ? { issue: createSession } : {});
  if ("error" in result) {
    if (result.setupFailed) revalidatePath("/platform");
    return { error: result.error };
  }
  if (who.kind === "operator") {
    revalidatePath("/platform");
    return { ok: true, orgCode: result.orgCode, operator: true };
  }
  redirect(result.loggedIn ? "/" : "/login");
}

// ─── Người vận hành nền tảng (`/platform`) ───

async function requireOperator(): Promise<{ user: SessionUser } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const denial = platformOperatorDenial(user);
  return denial ? { error: denial } : { user };
}

export async function createInviteAction(input: { note?: string; planKey?: string; ttlDays?: number }): Promise<{ ok: true; code: string; expiresAt: string } | { error: string }> {
  const r = await requireOperator();
  if ("error" in r) return r;
  const note = typeof input?.note === "string" ? input.note.trim().slice(0, 200) : "";
  const planKey = typeof input?.planKey === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(input.planKey) ? input.planKey : null;
  const ttlDays = typeof input?.ttlDays === "number" && Number.isFinite(input.ttlDays) ? input.ttlDays : undefined;
  const created = await createInvite({ actor: { orgCode: r.user.organization!.code, userId: r.user.id, email: r.user.email }, note, planKey, ttlDays });
  revalidatePath("/platform");
  return { ok: true, code: created.code, expiresAt: created.expiresAt.toISOString() };
}

export async function revokeInviteAction(id: string): Promise<{ ok: true } | { error: string }> {
  const r = await requireOperator();
  if ("error" in r) return r;
  const out = await revokeInvite(String(id ?? ""), { orgCode: r.user.organization!.code, userId: r.user.id, email: r.user.email });
  revalidatePath("/platform");
  return out;
}

/**
 * Đổi chế độ đăng ký `/start` (cài đặt control plane) — KHÔNG cần deploy. Lõi (`setSignupSetting`) kiểm lại người vận
 * hành, lý do, trần môi trường, và ghi `platform_audit_log`. `/start` đọc lại cờ ở lượt dựng kế tiếp.
 */
export async function setSignupModeAction(input: { mode: string; reason: string }): Promise<{ ok: true; changed: boolean; effective: string } | { error: string }> {
  const r = await requireOperator();
  if ("error" in r) return r;
  const out = await setSignupSetting(r.user, input);
  if ("error" in out) return out;
  revalidatePath("/platform");
  revalidatePath("/start");
  return { ok: true, changed: out.changed, effective: out.state.effective };
}

export async function retrySetupAction(orgCode: string): Promise<{ ok: true } | { error: string }> {
  const r = await requireOperator();
  if ("error" in r) return r;
  const out = await retryOrganizationSetup(String(orgCode ?? ""), { kind: "operator", ip: await ipOfRequest(), actor: { orgCode: r.user.organization!.code, userId: r.user.id, email: r.user.email } });
  revalidatePath("/platform");
  return "error" in out ? { error: out.error } : { ok: true };
}
