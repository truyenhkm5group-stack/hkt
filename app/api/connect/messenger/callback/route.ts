import { NextResponse, type NextRequest } from "next/server";
import { appOriginForHost, readOAuthToken } from "@/lib/auth/oauth";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { sessionCookieSecure } from "@/lib/constants/session";
import { MESSENGER_CONNECT_PATH, MESSENGER_SETTINGS_PATH, MESSENGER_STATE_COOKIE, messengerRedirectUri, storePendingPages } from "@/lib/integrations/messenger/connect";
import { checkPageWebhook, discoveryLogLine, isPermissionReason, messengerApp, pagesFromCode, type DiscoveryDiagnostic } from "@/lib/integrations/messenger/graph";
import { setSettingJson } from "@/lib/settings";
import { connectMessengerPage } from "@/lib/sales-chatbot/messenger";

export const dynamic = "force-dynamic";

/**
 * Facebook trả về sau khi chủ page cấp quyền. Khớp `state` + ĐÚNG tổ chức + ĐÚNG người đã bấm ⇒ đổi `code` lấy danh sách page:
 * một page ⇒ nối luôn; nhiều page ⇒ cookie mã hoá, người bấm chọn ở trang cài đặt. Token người dùng không được lưu.
 */
export async function GET(req: NextRequest) {
  // Cùng gốc với lượt start (Facebook trả về đúng host đã gửi đi) — bước đổi mã phải dùng ĐÚNG redirect_uri đó.
  const origin = appOriginForHost(req.headers.get("host"));
  const secure = sessionCookieSecure(process.env.NODE_ENV, origin);
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`${MESSENGER_SETTINGS_PATH}?${q}`, origin));
    res.cookies.set(MESSENGER_STATE_COOKIE, "", { path: MESSENGER_CONNECT_PATH, maxAge: 0, httpOnly: true, sameSite: "lax", secure });
    return res;
  };
  // Cổng chung (phiên · tổ chức còn hoạt động · module · quyền) — bị chặn thì về trang cài đặt / đăng nhập, không trả JSON.
  const guard = await apiGuard("settings:manage");
  if (guard instanceof Response) return guard.status === 401 ? NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(MESSENGER_SETTINGS_PATH)}`, origin)) : back("loi=quyen");
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
  const got = await pagesFromCode(app, code, messengerRedirectUri(origin));
  if ("error" in got) return back(`loi=fb&msg=${encodeURIComponent(got.error.slice(0, 200))}`);
  // Vết của lượt khám phá: một dòng log (chỉ quyền + số đếm) + bản chẩn đoán đầy đủ trong CSDL tổ chức — không token nào.
  console.info(discoveryLogLine(user.organization.code, got.diagnostic));
  await setSettingJson("messenger.lastConnectDiagnostic", { at: new Date().toISOString(), by: user.id, ...got.diagnostic }).catch(() => undefined);
  const pages = got.pages.filter((p) => p.canMessage);
  // Chặn theo QUYỀN / TOKEN trước (page hiện đủ mà thiếu pages_messaging thì gửi tin vẫn hỏng), rồi mới tới «không có page».
  if (got.diagnostic.reason && (isPermissionReason(got.diagnostic.reason) || !pages.length)) return back(`loi=khongpage&lydo=${got.diagnostic.reason}&ct=${encodeURIComponent(diagnosticDetail(got.diagnostic))}`);
  if (!pages.length) return back("loi=khongpage");
  if (pages.length === 1) {
    const r = await connectMessengerPage(user, pages[0]);
    if ("error" in r) return back(`loi=fb&msg=${encodeURIComponent(r.error.slice(0, 200))}`);
    // Lưu xong ⇒ ĐỌC lại ở Meta xem page có thật sự gửi tin về app không (chỉ đọc, không đăng ký lại). Vết không token.
    const check = await checkPageWebhook(app, pages[0].id, pages[0].token);
    await setSettingJson("messenger.lastWebhookCheck", { at: new Date().toISOString(), by: user.id, pages: [{ ...check, name: pages[0].name }] }).catch(() => undefined);
    return back(check.state === "OK" || check.state === "UNKNOWN" ? "ok=1" : `ok=1&webhook=${check.state}`);
  }
  // Nhiều page ⇒ cho chọn (nhiều page một lượt). Danh sách + token lưu niêm phong ở máy chủ, không ở cookie (trần 4 KB).
  await storePendingPages(user.organization.code, user.id, pages);
  return back("chon=1");
}

/** Phần cụ thể của lý do (tên quyền / tên page / quyền đang có trên page) — ngắn, không token. */
function diagnosticDetail(d: DiscoveryDiagnostic): string {
  if (d.reason?.startsWith("PERMISSION_")) return d.missing.join(", ");
  if (d.reason === "TOKEN_EXPIRED") return d.userToken?.why ?? "";
  if (d.reason === "NO_PAGE_TOKEN") return `${d.accountsSeen} page${d.viaBusiness ? ` (${d.viaBusiness} qua Business Portfolio)` : ""}: ${d.withoutToken.slice(0, 3).join(", ")}`;
  if (d.reason === "NO_MESSAGING_TASK") return d.withoutMessaging.slice(0, 3).map((p) => `${p.name} (${p.tasks.join("/") || "không quyền"})`).join(", ");
  return d.granted ? `quyền đã cấp: ${d.granted.join(", ") || "không"}` : "";
}
