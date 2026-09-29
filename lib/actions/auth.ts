"use server";

import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { loginOrgCode, verifyLogin } from "@/lib/auth/login";
import { clearLoginFailures, loginAllowed, loginThrottleKeys, recordLoginFailure } from "@/lib/auth/login-throttle";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { createSession, destroySession, getSession } from "@/lib/auth/session";
import { OrgContextError } from "@/lib/platform/context";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  if (!email || !password) return { error: "Vui lòng nhập email và mật khẩu." };
  // Ô "Mã tổ chức" chỉ hiện khi nền tảng có hơn một tổ chức; bỏ trống ⇒ tổ chức nhà, như trước đây.
  // Tên miền con của một tổ chức đã xuất bản (0180) GẮN CỨNG tổ chức — ô «Mã tổ chức» của form bị bỏ qua. Tên miền con
  // không trỏ tới ERP nào ⇒ từ chối, KHÔNG rơi về tổ chức nhà.
  const host = await hostOrganization();
  if (host.slug && !host.org) return { error: HOST_NOT_FOUND_MESSAGE };
  const orgCode = host.org ? host.org.code : await loginOrgCode(String(formData.get("org") ?? ""));

  // Chặn dò mật khẩu theo CẶP (email, IP) và theo IP (xem lib/auth/login-throttle.ts) — không theo
  // email trần, nếu không ai cũng khoá được tài khoản người khác. Kiểm TRƯỚC khi băm để lần thử bị
  // chặn không tốn tài nguyên. IP đọc phần Caddy ghi (lib/auth/client-ip.ts), không đọc phần client khai.
  const h = await headers();
  const ip = clientIpFrom(h.get("x-forwarded-for"));
  const throttleKeys = loginThrottleKeys(email, ip, orgCode);
  const gate = loginAllowed(throttleKeys);
  if (!gate.ok) {
    console.warn(`[login] chặn dò mật khẩu · email=${email} · ip=${ip} · đợi ${gate.retryAfterSec}s`);
    return { error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` };
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
  // Chỉ đường dẫn NỘI BỘ đã chuẩn hoá (lib/auth/safe-redirect.ts) — `/\evil.com` từng lọt phép kiểm cũ.
  redirect(safeNextPath(next));
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
