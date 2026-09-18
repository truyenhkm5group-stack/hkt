import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { hasPermission, resolvePermissions, USER_PERMISSION_SNAPSHOT_KEY, type Permission, type RolePermissionMap } from "@/lib/auth/permissions";
import { departmentCodesOfMany, effectiveAccess, loadCustomRole } from "@/lib/auth/access";
import { normalizeScope, type AccessScope } from "@/lib/constants/access-scope";
import { env } from "@/lib/env";
import { memo } from "@/lib/cache";
import { getSettingJson } from "@/lib/settings";

export const ROLE_PERMISSIONS_KEY = "auth.rolePermissions";

export const SESSION_COOKIE = "erp_session";
const SESSION_DAYS = 7;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: string[];
  /** Phạm vi dữ liệu (`lib/constants/access-scope.ts`). `ALL` = không thu hẹp gì. */
  scope: AccessScope;
  /** Mã phòng ban người này là thành viên — rỗng khi phạm vi là `ALL` (lúc đó không cần biết). */
  departmentCodes: string[];
  /** Chức danh. CHỈ ĐỂ HIỂN THỊ — không tham gia vào bất kỳ phép kiểm tra quyền nào. */
  positionId: string | null;
};

function secretKey() {
  return new TextEncoder().encode(env.authSecret);
}

/** Phần danh tính đi vào cookie. Quyền / phạm vi KHÔNG nằm trong token — chúng được nạp lại từ
 *  CSDL ở mỗi lần dựng, nên thu hẹp phạm vi của một người có hiệu lực ngay, không đợi họ đăng
 *  nhập lại. */
export type SessionIdentity = Pick<SessionUser, "id" | "email" | "name" | "role">;

export async function signSession(user: SessionIdentity) {
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
    return { id: payload.sub, email: String(payload.email ?? ""), name: String(payload.name ?? ""), role, permissions: resolvePermissions(role, null), scope: "ALL", departmentCodes: [], positionId: null };
  } catch {
    return null;
  }
}

export async function createSession(user: SessionIdentity) {
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

/**
 * Mẫu quyền của các vai trò (bản chỉnh trong settings, nếu có).
 *
 * Đệm 60 giây: hai khoá này được đọc ở MỌI lần dựng trang, mọi server action, mọi lượt hỏi
 * chuông thông báo (30 giây/lần) — mà chúng chỉ đổi khi quản trị sửa quyền, và lúc đó `audit()`
 * xoá hẳn đệm nên số mới hiện ngay. Trước đây mỗi lần điều hướng tốn 6 câu truy vấn chỉ để biết
 * người đang đăng nhập là ai (layout + trang, mỗi bên 3 câu).
 */
export async function loadRoleTemplates(): Promise<RolePermissionMap> {
  return memo("auth:roleTemplates", 60_000, () => getSettingJson<RolePermissionMap>(ROLE_PERMISSIONS_KEY, {}));
}

/**
 * Ảnh chụp "lúc lưu quyền tuỳ chỉnh cho người này, hệ thống có những khoá quyền nào".
 *
 * Để trong `settings` thay vì thêm cột: chỉ vài người dùng nên dữ liệu rất nhỏ, và tránh được một
 * migration vào lúc kho đang có phiên làm việc khác sửa dở `db/schema.ts`.
 */
export async function loadPermissionSnapshots(): Promise<Record<string, string[]>> {
  return memo("auth:permissionSnapshots", 60_000, () => getSettingJson<Record<string, string[]>>(USER_PERMISSION_SNAPSHOT_KEY, {}));
}

/**
 * Người dùng hiện tại với quyền đã tính (null nếu chưa đăng nhập / bị khoá), không chuyển hướng.
 *
 * `cache()` của React khử trùng lặp TRONG MỘT LẦN DỰNG: layout gọi `requireUser`, trang gọi
 * `requirePermission`, các khối Suspense gọi `can` — trước đây mỗi lời gọi là một lượt tra
 * người dùng riêng. Không phải đệm theo thời gian: lần dựng kế tiếp vẫn tra lại, nên khoá tài
 * khoản là có hiệu lực ngay ở lần điều hướng tiếp theo như cũ.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getSession();
  if (!session) return null;
  const db = await getDb();
  const [user, templates, snapshots] = await Promise.all([
    db.query.users.findFirst({
      where: eq(schema.users.id, session.id),
      columns: { id: true, email: true, name: true, role: true, active: true, permissions: true, accessRoleId: true, positionId: true, dataScope: true },
    }),
    loadRoleTemplates(),
    loadPermissionSnapshots(),
  ]);
  if (!user || !user.active) return null;
  const scope = normalizeScope(user.dataScope);
  const known = snapshots[user.id] ?? null;

  /*
    ĐƯỜNG NHANH: phạm vi `ALL` và không có vai trò tuỳ chỉnh — tức là MỌI tài khoản đang chạy hôm
    nay. Không thêm một câu truy vấn nào, kết quả đúng bằng hành vi trước bản này. Chỉ khi chủ shop
    CHỦ ĐỘNG thu hẹp phạm vi hoặc gán vai trò tuỳ chỉnh thì mới tốn thêm hai câu — và lúc đó tài
    khoản ấy đáng để tốn.
  */
  if (scope === "ALL" && !user.accessRoleId) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: resolvePermissions(user.role, user.permissions, templates, known),
      scope,
      departmentCodes: [],
      positionId: user.positionId ?? null,
    };
  }

  const [customRole, deptMap] = await Promise.all([loadCustomRole(user.accessRoleId), departmentCodesOfMany([user.id])]);
  const access = effectiveAccess({
    role: user.role,
    userCustom: user.permissions,
    customRole,
    scope,
    departmentCodes: deptMap[user.id] ?? [],
    templates,
    known,
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: access.permissions,
    scope: access.scope,
    departmentCodes: access.departmentCodes,
    positionId: user.positionId ?? null,
  };
});

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
  /*
    NÓI RÕ THIẾU QUYỀN GÌ. Trước đây chỉ có `?forbidden=1` và không màn hình nào đọc nó, nên người
    bị chặn chỉ thấy mình bị đưa về Tổng quan mà không biết vì sao — và "không vào được" rất dễ bị
    hiểu thành "đăng nhập hỏng". Tổng quan đọc tham số này và in ra một dòng 403 rõ ràng.
  */
  if (!can(user, permission)) redirect(`/?forbidden=${encodeURIComponent(permission)}`);
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
