import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "erp_session";
const SESSION_DAYS = 7;

export type SessionUser = { id: string; email: string; name: string; role: Role };

function secretKey() {
  return new TextEncoder().encode(env.authSecret);
}

export async function signSession(user: SessionUser) {
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload.sub) return null;
    return { id: payload.sub, email: String(payload.email ?? ""), name: String(payload.name ?? ""), role: (payload.role as Role) ?? "VIEWER" };
  } catch {
    return null;
  }
}

export async function createSession(user: SessionUser) {
  const token = await signSession(user);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && env.appUrl.startsWith("https"),
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Lấy người dùng hiện tại (kiểm tra còn active trong DB), chuyển hướng /login nếu chưa đăng nhập */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, session.id), columns: { id: true, email: true, name: true, role: true, active: true } });
  if (!user || !user.active) redirect("/login?reason=inactive");
  if (roles && !roles.includes(user.role) && user.role !== "ADMIN") redirect("/?forbidden=1");
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Quản trị",
  MANAGER: "Quản lý",
  ACCOUNTANT: "Kế toán",
  WAREHOUSE: "Kho",
  CS: "CSKH",
  MARKETING: "Marketing",
  VIEWER: "Chỉ xem",
};

/** Quyền theo module */
export const PERMISSIONS: Record<string, Role[]> = {
  "orders:read": ["ADMIN", "MANAGER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"],
  "cod:write": ["ADMIN", "MANAGER", "ACCOUNTANT"],
  "expenses:write": ["ADMIN", "MANAGER", "ACCOUNTANT", "MARKETING"],
  "inventory:write": ["ADMIN", "MANAGER", "WAREHOUSE"],
  "sync:run": ["ADMIN", "MANAGER"],
  "users:manage": ["ADMIN"],
  "settings:manage": ["ADMIN"],
};

export function can(role: Role, permission: keyof typeof PERMISSIONS) {
  return role === "ADMIN" || (PERMISSIONS[permission] ?? []).includes(role);
}
