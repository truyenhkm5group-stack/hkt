import { NextResponse, type NextRequest } from "next/server";
import { readOAuthToken } from "@/lib/auth/oauth";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { sessionCookieSecure } from "@/lib/constants/session";
import { env } from "@/lib/env";
import { MESSENGER_CONNECT_PATH, MESSENGER_CONNECT_TTL_SEC, MESSENGER_PAGES_COOKIE, MESSENGER_SETTINGS_PATH, MESSENGER_STATE_COOKIE, messengerRedirectUri, sealPendingPages } from "@/lib/integrations/messenger/connect";
import { messengerApp, pagesFromCode } from "@/lib/integrations/messenger/graph";
import { connectMessengerPage } from "@/lib/sales-chatbot/messenger";

export const dynamic = "force-dynamic";

/**
 * Facebook trả về sau khi chủ page cấp quyền. Khớp `state` + ĐÚNG tổ chức + ĐÚNG người đã bấm ⇒ đổi `code` lấy danh sách page:
 * một page ⇒ nối luôn; nhiều page ⇒ cookie mã hoá, người bấm chọn ở trang cài đặt. Token người dùng không được lưu.
 */
export async function GET(req: NextRequest) {
  const secure = sessionCookieSecure(process.env.NODE_ENV, env.appUrl);
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`${MESSENGER_SETTINGS_PATH}?${q}`, env.appUrl));
    res.cookies.set(MESSENGER_STATE_COOKIE, "", { path: MESSENGER_CONNECT_PATH, maxAge: 0, httpOnly: true, sameSite: "lax", secure });
    return res;
  };
  // Cổng chung (phiên · tổ chức còn hoạt động · module · quyền) — bị chặn thì về trang cài đặt / đăng nhập, không trả JSON.
  const guard = await apiGuard("settings:manage");
  if (guard instanceof Response) return guard.status === 401 ? NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(MESSENGER_SETTINGS_PATH)}`, env.appUrl)) : back("loi=quyen");
  const user = guard.user;
  if (!can(user, "settings:manage") || !user.organization) return back("loi=quyen");
  const app = messengerApp();
  if (!app) return back("loi=app");
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return back("loi=huy");
  const st = await readOAuthToken<{ state: string; org: string; uid: string }>("erp-messenger-connect", req.cookies.get(MESSENGER_STATE_COOKIE)?.value);
  if (!st || st.state !== q.get("state") || st.org !== user.organization.code || st.uid !== user.id) return back("loi=state");
  const code = q.get("code") ?? "";
  if (!code) return back("loi=huy");
  const got = await pagesFromCode(app, code, messengerRedirectUri());
  if ("error" in got) return back(`loi=fb&msg=${encodeURIComponent(got.error.slice(0, 200))}`);
  const pages = got.pages.filter((p) => p.canMessage);
  if (!pages.length) return back("loi=khongpage");
  if (pages.length === 1) {
    const r = await connectMessengerPage(user, pages[0]);
    return "error" in r ? back(`loi=fb&msg=${encodeURIComponent(r.error.slice(0, 200))}`) : back("ok=1");
  }
  const res = back("chon=1");
  res.cookies.set(MESSENGER_PAGES_COOKIE, await sealPendingPages(user.organization.code, user.id, pages), { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: MESSENGER_CONNECT_TTL_SEC });
  return res;
}
