"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { createSession, getCurrentUser, requirePermission, type SessionUser } from "@/lib/auth/session";
import { createInvite, revokeInvite } from "@/lib/onboarding/invites";
import { checkAdminStep, checkInviteStep, checkOrgStep, createOrganizationFromSignup, previewSignup, retryOrganizationSetup, type SignupActor } from "@/lib/onboarding/service";
import type { SignupPreview, SignupStepResult } from "@/lib/onboarding/shared";
import { setSignupSetting } from "@/lib/onboarding/signup-mode";
import { quickSignup } from "@/lib/onboarding/quick";
import { sendSignupOtp, sendTestOtp, setPhoneOtpSetting, type PhoneOtpSetting, type SendOtpResult } from "@/lib/onboarding/phone-otp";
import { readOAuthToken, SOCIAL_SIGNUP_COOKIE, type SocialProfile } from "@/lib/auth/oauth";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { hostBrand } from "@/lib/platform/host-brand";
import { landingAfterSignIn } from "@/lib/saas/shell-landing";

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
  // Thương hiệu của host khách đang đứng (header MÁY CHỦ do middleware đặt) — liên kết về sau đi đúng phần mềm này.
  const brand = await hostBrand();
  const result = await createOrganizationFromSignup(draft, who, who.kind === "public" ? { issue: createSession, brand } : { brand });
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

/**
 * ĐĂNG KÝ NHANH một màn hình (docs/platform/quick-start.md). Hồ sơ Google / Facebook (nếu có) đọc từ cookie KÝ ở MÁY CHỦ
 * — không bao giờ từ trình duyệt. Thành công ⇒ phiên của quản trị mới rồi vào `/` (trang «Bắt đầu»).
 */
/** Gửi mã xác minh SĐT qua Zalo (đăng ký nhanh, khi người vận hành bật). Trần gửi do lõi đếm từ bảng. */
export async function sendSignupOtpAction(phone: unknown): Promise<SendOtpResult> {
  return sendSignupOtp(phone, await whoAmI());
}

export async function quickSignupAction(input: unknown): Promise<{ error: string; needOtp?: true } | void> {
  const who = await whoAmI();
  if (who.kind === "operator") return { error: "Người vận hành tạo hộ khách bằng trình hướng dẫn đầy đủ (/start?day-du=1)." };
  const store = await cookies();
  const social = await readOAuthToken<SocialProfile>("erp-social-signup", store.get(SOCIAL_SIGNUP_COOKIE)?.value);
  const r = await quickSignup(input, who, { issue: createSession, social, brand: await hostBrand() });
  if ("error" in r) return r;
  // Hồ sơ Google / Facebook đã dùng xong — cho cookie hết hạn (không phải dữ liệu nghiệp vụ).
  store.set(SOCIAL_SIGNUP_COOKIE, "", { path: "/", maxAge: 0 });
  // Đích cuối một bước (lib/saas/shell-landing.ts): cửa hàng Chốt Đơn vào thẳng trang nhà của vỏ — `redirect("/")` cho họ từng
  // là trang trắng (F-01). Không thuộc vỏ ⇒ `/` như cũ.
  redirect(r.loggedIn ? await landingAfterSignIn("/") : "/login");
}

// ─── Người vận hành nền tảng (`/platform`) ───

async function requireOperator(): Promise<{ user: SessionUser } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const denial = platformOperatorDenial(user);
  return denial ? { error: denial } : { user };
}

/** Bật / tắt mã xác minh SĐT qua Zalo ZNS khi đăng ký (người vận hành). */
export async function setPhoneOtpSettingAction(input: unknown): Promise<{ ok: true; setting: PhoneOtpSetting } | { error: string }> {
  const r = await requireOperator();
  if ("error" in r) return r;
  const out = await setPhoneOtpSetting({ orgCode: r.user.organization!.code, userId: r.user.id, email: r.user.email }, input);
  if ("ok" in out) revalidatePath("/platform");
  return out;
}

/** Gửi THỬ một mã tới SĐT người vận hành nhập, bằng mẫu đang khai — trước khi bật cho khách. */
export async function testPhoneOtpAction(input: { phone: unknown; templateId: unknown; param: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const r = await requireOperator();
  if ("error" in r) return r;
  return sendTestOtp(input);
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
