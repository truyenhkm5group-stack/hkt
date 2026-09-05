import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { hasPermission, resolvePermissions, type Permission, type RolePermissionMap } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { getSettingJson } from "@/lib/settings";

export const ROLE_PERMISSIONS_KEY = "auth.rolePermissions";

export const SESSION_COOKIE = "erp_session";
const SESSION_DAYS = 7;

export type SessionUser = { id: string; email: string; name: string; role: Role; permissions: string[] };

function secretKey() {
  return new TextEncoder().encode(env.authSecret);
}

export async function signSession(user: Omit<SessionUser, "permissions">) {
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
    const role = (payload.role as Role) ?? "VIEWER";
    // quyền thực tế được nạp lại từ DB trong requireUser / getCurrentUser
    return { id: payload.sub, email: String(payload.email ?? ""), name: String(payload.name ?? ""), role, permissions: resolvePermissions(role, null) };
  } catch {
    return null;
  }
}

export async function createSession(user: Omit<SessionUser, "permissions">) {
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

/** Mẫu quyền của các vai trò (bản chỉnh trong settings, nếu có) */
export async function loadRoleTemplates(): Promise<RolePermissionMap> {
  return getSettingJson<RolePermissionMap>(ROLE_PERMISSIONS_KEY, {});
}

/** Người dùng hiện tại với quyền đã tính (null nếu chưa đăng nhập / bị khoá), không chuyển hướng */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getSession();
  if (!session) return null;
  const db = await getDb();
  const [user, templates] = await Promise.all([
    db.query.users.findFirst({ where: eq(schema.users.id, session.id), columns: { id: true, email: true, name: true, role: true, active: true, permissions: true } }),
    loadRoleTemplates(),
  ]);
  if (!user || !user.active) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role, permissions: resolvePermissions(user.role, user.permissions, templates) };
}

/** Lấy người dùng hiện tại (kiểm tra còn active trong DB), chuyển hướng /login nếu chưa đăng nhập */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  const user = await getCurrentUser();
  if (!user) redirect("/login?reason=inactive");
  if (roles && !roles.includes(user.role) && user.role !== "ADMIN") redirect("/?forbidden=1");
  return user;
}

/** Như requireUser nhưng bắt buộc có quyền; thiếu quyền → về trang chủ với thông báo */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, permission)) redirect("/?forbidden=1");
  return user;
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Quản trị",
  MANAGER: "Quản lý",
  LEADER: "Trưởng nhóm",
  ACCOUNTANT: "Kế toán",
  WAREHOUSE: "Kho",
  CS: "CSKH",
  MARKETING: "Marketing",
  VIEWER: "Chỉ xem",
};

/** Kiểm tra quyền: truyền người dùng (quyền đã tuỳ chỉnh) hoặc vai trò (quyền mẫu mặc định) */
export function can(subject: SessionUser | Role, permission: Permission) {
  if (typeof subject === "string") return subject === "ADMIN" || hasPermission(resolvePermissions(subject, null), permission);
  return subject.role === "ADMIN" || hasPermission(subject.permissions, permission);
}
