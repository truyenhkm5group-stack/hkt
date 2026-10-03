import { NextResponse, type NextRequest } from "next/server";
import { beginOAuth, isOAuthProvider, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SEC, providerConfig, signOAuthToken } from "@/lib/auth/oauth";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { sessionCookieSecure } from "@/lib/constants/session";
import { env } from "@/lib/env";

/**
 * Bắt đầu đăng nhập / đăng ký bằng Google · Facebook (docs/platform/quick-start.md). `state` + PKCE cất trong cookie KÝ,
 * sống 10 phút, chỉ gửi về `/login/oauth`. Nhà cung cấp chưa khai khoá ⇒ về màn đăng nhập, không bao giờ nửa vời.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const home = (path: string) => NextResponse.redirect(new URL(path, env.appUrl));
  if (!isOAuthProvider(provider)) return home("/login");
  const cfg = providerConfig(provider);
  if (!cfg) return home("/login?oauth=off");
  const intent = req.nextUrl.searchParams.get("intent") === "signup" ? "signup" : "login";
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const { state, verifier, url } = beginOAuth(provider, cfg);
  const token = await signOAuthToken("erp-oauth-state", { p: provider, state, verifier, intent, next }, OAUTH_STATE_TTL_SEC);
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(process.env.NODE_ENV, env.appUrl), path: "/login/oauth", maxAge: OAUTH_STATE_TTL_SEC });
  return res;
}
