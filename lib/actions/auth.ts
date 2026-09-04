"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession, getSession } from "@/lib/auth/session";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  if (!email || !password) return { error: "Vui lòng nhập email và mật khẩu." };

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Email hoặc mật khẩu không đúng." };
  }
  if (!user.active) return { error: "Tài khoản đã bị khoá. Liên hệ quản trị viên." };

  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await audit({ userId: user.id, userEmail: user.email, action: "LOGIN", entity: "USER", entityId: user.id });
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction() {
  const session = await getSession();
  if (session) await audit({ userId: session.id, userEmail: session.email, action: "LOGOUT", entity: "USER", entityId: session.id });
  await destroySession();
  redirect("/login");
}
