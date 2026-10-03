"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { completeProviderLogin } from "@/lib/auth/login";
import { OAUTH_IDENTITY_KIND, readOAuthToken, SOCIAL_PICK_COOKIE, SOCIAL_SIGNUP_COOKIE, type SocialPick } from "@/lib/auth/oauth";
import { createSession } from "@/lib/auth/session";

/** Cho cookie của luồng OAuth hết hạn ngay (không phải dữ liệu nghiệp vụ — tệp này không ghi CSDL; nhật ký LOGIN ghi ở lib/auth/login.ts). */
async function expireCookie(name: string): Promise<void> {
  (await cookies()).set(name, "", { path: "/", maxAge: 0 });
}

/**
 * Trang «Chọn cửa hàng» sau Google / Facebook: danh tính khớp nhiều tổ chức. Danh sách được chọn nằm trong cookie KÝ do
 * máy chủ ghi ở bước callback — trình duyệt chỉ gửi mã tổ chức, và mã đó phải nằm trong danh sách ấy.
 */
export async function pickSocialOrgAction(orgCode: string): Promise<{ error: string } | void> {
  const store = await cookies();
  const pick = await readOAuthToken<SocialPick>("erp-social-pick", store.get(SOCIAL_PICK_COOKIE)?.value);
  if (!pick) return { error: "Phiên chọn cửa hàng đã hết hạn — đăng nhập lại." };
  const hit = pick.choices.find((c) => c.orgCode === String(orgCode ?? ""));
  if (!hit) return { error: "Cửa hàng này không nằm trong danh sách của bạn." };
  const v = await completeProviderLogin({ orgCode: hit.orgCode, userId: hit.userId, provider: OAUTH_IDENTITY_KIND[pick.provider], subject: pick.subject }, createSession);
  if (!v.ok) return { error: v.error };
  await expireCookie(SOCIAL_PICK_COOKIE);
  redirect("/");
}

/** Bỏ hồ sơ Google / Facebook đang điền sẵn ở `/start` (người dùng muốn đăng ký bằng email). */
export async function forgetSocialSignupAction(): Promise<void> {
  await expireCookie(SOCIAL_SIGNUP_COOKIE);
  redirect("/start");
}
