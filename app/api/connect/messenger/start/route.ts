import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { appOriginForHost, signOAuthToken } from "@/lib/auth/oauth";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { sessionCookieSecure } from "@/lib/constants/session";
import { MESSENGER_CONNECT_PATH, MESSENGER_CONNECT_TTL_SEC, MESSENGER_SETTINGS_PATH, MESSENGER_STATE_COOKIE, messengerRedirectUri } from "@/lib/integrations/messenger/connect";
import { messengerApp, messengerConnectUrl } from "@/lib/integrations/messenger/graph";

export const dynamic = "force-dynamic";

/**
 * Bấm «Kết nối Facebook Page» ⇒ hộp thoại cấp quyền nhắn tin của Facebook (lib/integrations/messenger/connect.ts). Chỉ người có
 * quyền Cài đặt của tổ chức; `state` gắn tổ chức + người bấm, cất trong cookie KÝ chỉ gửi về `/api/connect/messenger`.
 */
export async function GET(req: NextRequest) {
  // Gốc phần mềm của CHÍNH host đang gọi (erp.vnxcommerce.com hoặc app.chotdontudong.com) — cả lượt đi theo nó.
  const origin = appOriginForHost(req.headers.get("host"));
  const back = (q: string) => NextResponse.redirect(new URL(`${MESSENGER_SETTINGS_PATH}?${q}`, origin));
  // Cổng chung (phiên · tổ chức còn hoạt động · module · quyền) — bị chặn thì về trang cài đặt / đăng nhập, không trả JSON.
  const guard = await apiGuard("settings:manage");
  if (guard instanceof Response) return guard.status === 401 ? NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(MESSENGER_SETTINGS_PATH)}`, origin)) : back("loi=quyen");
  const user = guard.user;
  if (!can(user, "settings:manage") || !user.organization) return back("loi=quyen");
  const app = messengerApp();
  if (!app) return back("loi=app");
  const state = randomBytes(24).toString("base64url");
  const token = await signOAuthToken("erp-messenger-connect", { state, org: user.organization.code, uid: user.id }, MESSENGER_CONNECT_TTL_SEC);
  const res = NextResponse.redirect(messengerConnectUrl(app, messengerRedirectUri(origin), state));
  res.cookies.set(MESSENGER_STATE_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(process.env.NODE_ENV, origin), path: MESSENGER_CONNECT_PATH, maxAge: MESSENGER_CONNECT_TTL_SEC });
  return res;
}
