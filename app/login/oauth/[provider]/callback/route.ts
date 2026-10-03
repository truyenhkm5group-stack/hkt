import { NextResponse, type NextRequest } from "next/server";
import { completeProviderLogin } from "@/lib/auth/login";
import {
  exchangeCode,
  isOAuthProvider,
  OAUTH_IDENTITY_KIND,
  OAUTH_STATE_COOKIE,
  providerConfig,
  readOAuthToken,
  signOAuthToken,
  SOCIAL_PICK_COOKIE,
  SOCIAL_SIGNUP_COOKIE,
  SOCIAL_SIGNUP_TTL_SEC,
  type OAuthState,
} from "@/lib/auth/oauth";
import { createSession } from "@/lib/auth/session";
import { resolveSocial } from "@/lib/auth/social";
import { sessionCookieSecure } from "@/lib/constants/session";
import { env } from "@/lib/env";

/**
 * Nhà cung cấp gửi người dùng về đây (docs/platform/quick-start.md). Thứ tự là luật:
 *   `state` khớp cookie ký (chống giả mạo yêu cầu) ⇒ đổi `code` lấy hồ sơ ở MÁY CHỦ nhà cung cấp ⇒ tìm tài khoản
 *   ⇒ một tổ chức: vào thẳng · nhiều: trang chọn · chưa có: đăng ký nhanh với hồ sơ điền sẵn.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const to = (path: string) => NextResponse.redirect(new URL(path, env.appUrl));
  const secure = sessionCookieSecure(process.env.NODE_ENV, env.appUrl);
  const cfg = isOAuthProvider(provider) ? providerConfig(provider) : null;
  if (!isOAuthProvider(provider) || !cfg) return to("/login?oauth=off");

  const st = await readOAuthToken<OAuthState>("erp-oauth-state", req.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const clear = (res: NextResponse) => {
    res.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/login/oauth", maxAge: 0 });
    return res;
  };
  // Người dùng bấm «Huỷ» ở nhà cung cấp, hoặc `state` không khớp (hết hạn / giả mạo) ⇒ về màn đăng nhập, không làm gì.
  if (!st || st.p !== provider || !state || st.state !== state || !code) return clear(to("/login?oauth=failed"));

  const profile = await exchangeCode(provider, code, st.verifier, cfg);
  if ("error" in profile) return clear(to("/login?oauth=failed"));

  const found = await resolveSocial(profile);
  if (found.kind === "LOGIN") {
    const v = await completeProviderLogin({ orgCode: found.hit.orgCode, userId: found.hit.userId, provider: OAUTH_IDENTITY_KIND[provider], subject: profile.subject }, createSession);
    return clear(to(v.ok ? st.next : `/login?oauth=${v.code === "DISABLED" ? "disabled" : "failed"}`));
  }
  if (found.kind === "PICK") {
    const token = await signOAuthToken("erp-social-pick", { provider, subject: profile.subject, choices: found.hits }, SOCIAL_SIGNUP_TTL_SEC);
    const res = clear(to("/login/chon-cua-hang"));
    res.cookies.set(SOCIAL_PICK_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SOCIAL_SIGNUP_TTL_SEC });
    return res;
  }
  // Chưa có tài khoản ⇒ đăng ký nhanh: hồ sơ (mã người dùng của nhà cung cấp, email đã xác minh, tên) cất trong cookie KÝ,
  // `/start` chỉ còn hỏi tên cửa hàng, ngành hàng, SĐT.
  const token = await signOAuthToken("erp-social-signup", { provider, subject: profile.subject, email: profile.email, name: profile.name }, SOCIAL_SIGNUP_TTL_SEC);
  const res = clear(to("/start"));
  res.cookies.set(SOCIAL_SIGNUP_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SOCIAL_SIGNUP_TTL_SEC });
  return res;
}
