"use server";

import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { LOGIN_BAD_CREDENTIALS, matchingLoginOrganizations, verifyLogin } from "@/lib/auth/login";
import { clearLoginFailures, loginAllowed, loginThrottleKeys, recordLoginFailure } from "@/lib/auth/login-throttle";
import { landingAfterSignIn } from "@/lib/saas/shell-landing";
import { createSession, destroySession, getSession } from "@/lib/auth/session";
import { OrgContextError } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";

/** `choose` = mật khẩu khớp tài khoản ở NHIỀU tổ chức — màn hình hỏi vào tổ chức nào (gửi lại kèm `org`). */
export type LoginState = { error?: string; choose?: { code: string; name: string }[] } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  if (!email || !password) return { error: "Nhập email (hoặc số điện thoại) và mật khẩu." };
  /*
    TỔ CHỨC NÀO (0193):
      · Tên miền con của một tổ chức đã xuất bản (0180) GẮN CỨNG tổ chức. Tên miền con không trỏ tới ERP nào ⇒ từ chối,
        KHÔNG rơi về tổ chức nhà.
      · Có gõ / chọn mã tổ chức ⇒ đúng tổ chức đó.
      · Trang chung, không mã ⇒ dò các tổ chức mà chỉ mục danh tính nói có tài khoản này (+ tổ chức nhà) — khách KHÔNG phải
        nhớ mã tổ chức. Khớp đúng một nơi ⇒ vào thẳng; khớp nhiều nơi ⇒ hỏi chọn; không nơi nào ⇒ cùng câu sai mật khẩu.
  */
  const host = await hostOrganization();
  if (host.slug && !host.org) return { error: HOST_NOT_FOUND_MESSAGE };
  const typedOrg = String(formData.get("org") ?? "").trim().toLowerCase();
  let orgCode: string | null = host.org ? host.org.code : typedOrg || null;

  // Chặn dò mật khẩu theo CẶP (email, IP) và theo IP (xem lib/auth/login-throttle.ts) — không theo
  // email trần, nếu không ai cũng khoá được tài khoản người khác. Kiểm TRƯỚC khi băm để lần thử bị
  // chặn không tốn tài nguyên. IP đọc phần Caddy ghi (lib/auth/client-ip.ts), không đọc phần client khai.
  const h = await headers();
  const ip = clientIpFrom(h.get("x-forwarded-for"));
  const throttleKeys = loginThrottleKeys(email, ip, orgCode ?? "*");
  const gate = loginAllowed(throttleKeys);
  if (!gate.ok) {
    console.warn(`[login] chặn dò mật khẩu · email=${email} · ip=${ip} · đợi ${gate.retryAfterSec}s`);
    return { error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` };
  }

  if (!orgCode) {
    const matched = await matchingLoginOrganizations(email, password);
    if (matched.length > 1) {
      // Không lộ gì cho người KHÔNG biết mật khẩu: danh sách chỉ hiện khi mật khẩu đã khớp ở mọi tổ chức trong đó.
      const choose = await Promise.all(matched.map(async (code) => ({ code, name: (await findOrganization(code))?.name ?? code })));
      return { choose };
    }
    if (matched.length === 0) {
      recordLoginFailure(throttleKeys);
      await new Promise((r) => setTimeout(r, 400));
      return { error: LOGIN_BAD_CREDENTIALS };
    }
    orgCode = matched[0];
  }

  /*
    Tra người, kiểm mật khẩu, ký phiên mang `org`, ghi `lastLoginAt` và nhật ký — TẤT CẢ trong ngữ cảnh
    của tổ chức đã chọn (lib/auth/login.ts). Mã tổ chức sai trả ĐÚNG câu của sai mật khẩu.
  */
  const verdict = await verifyLogin({ email, password, orgCode }, async (subject) => {
    clearLoginFailures(throttleKeys);
    await createSession(subject);
  });
  if (!verdict.ok) {
    if (verdict.code === "BAD_CREDENTIALS") {
      recordLoginFailure(throttleKeys);
      await new Promise((r) => setTimeout(r, 400));
    }
    return { error: verdict.error };
  }
  /*
    Chỉ đường dẫn NỘI BỘ đã chuẩn hoá (`safeNextPath` — `/\evil.com` từng lọt phép kiểm cũ), và ĐÍCH CUỐI tính ngay tại đây
    (lib/saas/shell-landing.ts): người thuộc vỏ Chốt Đơn đi thẳng tới trang nhà của vỏ — `redirect("/")` cho họ từng là trang
    trắng (F-01). ERP / nhà: đúng `safeNextPath(next)` như cũ.
  */
  redirect(await landingAfterSignIn(next));
}

export async function logoutAction() {
  const session = await getSession();
  try {
    if (session) await audit({ userId: session.id, userEmail: session.email, action: "LOGOUT", entity: "USER", entityId: session.id });
  } catch (error) {
    // Phiên của một tổ chức đã bị đình chỉ: không mở được CSDL của nó để ghi nhật ký, nhưng người dùng
    // VẪN phải đăng xuất được — một nút Đăng xuất không ăn là lỗi an ninh.
    if (!(error instanceof OrgContextError)) throw error;
  }
  await destroySession();
  redirect("/login");
}
