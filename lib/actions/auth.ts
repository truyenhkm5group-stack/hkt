"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { clearLoginFailures, loginAllowed, loginThrottleKeys, recordLoginFailure } from "@/lib/auth/login-throttle";
import { verifyPassword } from "@/lib/auth/password";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { createSession, destroySession, getSession } from "@/lib/auth/session";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  if (!email || !password) return { error: "Vui lòng nhập email và mật khẩu." };

  // Chặn dò mật khẩu theo CẶP (email, IP) và theo IP (xem lib/auth/login-throttle.ts) — không theo
  // email trần, nếu không ai cũng khoá được tài khoản người khác. Kiểm TRƯỚC khi băm để lần thử bị
  // chặn không tốn tài nguyên. IP đọc phần Caddy ghi (lib/auth/client-ip.ts), không đọc phần client khai.
  const h = await headers();
  const ip = clientIpFrom(h.get("x-forwarded-for"));
  const throttleKeys = loginThrottleKeys(email, ip);
  const gate = loginAllowed(throttleKeys);
  if (!gate.ok) {
    console.warn(`[login] chặn dò mật khẩu · email=${email} · ip=${ip} · đợi ${gate.retryAfterSec}s`);
    return { error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` };
  }

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordLoginFailure(throttleKeys);
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Email hoặc mật khẩu không đúng." };
  }
  if (!user.active) return { error: "Tài khoản đã bị khoá. Liên hệ quản trị viên." };
  clearLoginFailures(throttleKeys);

  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await audit({ userId: user.id, userEmail: user.email, action: "LOGIN", entity: "USER", entityId: user.id });
  // Chỉ đường dẫn NỘI BỘ đã chuẩn hoá (lib/auth/safe-redirect.ts) — `/\evil.com` từng lọt phép kiểm cũ.
  redirect(safeNextPath(next));
}

export async function logoutAction() {
  const session = await getSession();
  if (session) await audit({ userId: session.id, userEmail: session.email, action: "LOGOUT", entity: "USER", entityId: session.id });
  await destroySession();
  redirect("/login");
}
