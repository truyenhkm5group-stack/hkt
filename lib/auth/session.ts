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
import { SESSION_COOKIE as COOKIE_PHIEN, SESSION_IDLE_DAYS, SESSION_LOGIN_CLAIM, claimsFrom, cookieMaxAgeSec, sessionCookieSecure } from "@/lib/constants/session";
import { DENY_REASON_PARAM, sessionRevoked, type SessionDenyReason } from "@/lib/constants/session-revocation";

export const ROLE_PERMISSIONS_KEY = "auth.rolePermissions";

/*
  LUẬT PHIÊN Ở MỘT CHỖ: `lib/constants/session.ts`. Tệp đó không import gì nên `middleware.ts`
  (chạy ở Edge) nạp được cùng một bản — số ngày, phép quyết định gia hạn và thuộc tính cookie chỉ
  tồn tại một lần trong kho mã.
*/
export { SESSION_COOKIE } from "@/lib/constants/session";

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

const NGAY_GIAY = 86_400;

/** Phần danh tính đi vào cookie. Quyền / phạm vi KHÔNG nằm trong token — chúng được nạp lại từ
 *  CSDL ở mỗi lần dựng, nên thu hẹp phạm vi của một người có hiệu lực ngay, không đợi họ đăng
 *  nhập lại. */
export type SessionIdentity = Pick<SessionUser, "id" | "email" | "name" | "role">;

/**
 * Ký một token phiên.
 *
 * `loginAtSec` là mốc ĐĂNG NHẬP GỐC và nó ĐI THEO token qua mọi lần gia hạn — đó là thứ duy nhất
 * giữ cho trần tuyệt đối có nghĩa. Bỏ trống ⇒ đây là một lần đăng nhập mới, mốc là bây giờ.
 *
 * `iat` thì ngược lại: nó luôn là LÚC NÀY. Hai mốc tách nhau vì chúng trả lời hai câu khác nhau —
 * "phiên này bắt đầu khi nào" và "tờ giấy này được ký lại lần gần nhất khi nào".
 */
export async function signSession(user: SessionIdentity, opts: { loginAtSec?: number; nowSec?: number } = {}) {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const loginAtSec = opts.loginAtSec ?? nowSec;
  return new SignJWT({ email: user.email, name: user.name, role: user.role, [SESSION_LOGIN_CLAIM]: loginAtSec })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + SESSION_IDLE_DAYS * NGAY_GIAY)
    .sign(secretKey());
}

/**
 * Phiên đọc từ cookie, KÈM mốc đăng nhập gốc.
 *
 * `loginAtSec` là thứ luật thu hồi so sánh. Nó phải đi cùng danh tính từ đây tới
 * `resolveCurrentUser()` — đọc lại token lần thứ hai ở tầng dưới là mở đường cho hai chỗ đọc hai
 * giá trị khác nhau.
 */
type PhienDaDoc = { user: SessionUser; loginAtSec: number | null };

async function readSessionToken(token: string): Promise<PhienDaDoc | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload.sub) return null;
    const role = (payload.role as Role) ?? "VIEWER";
    // quyền thực tế được nạp lại từ DB trong requireUser / getCurrentUser
    const user: SessionUser = { id: payload.sub, email: String(payload.email ?? ""), name: String(payload.name ?? ""), role, permissions: resolvePermissions(role, null), scope: "ALL", departmentCodes: [], positionId: null };
    return { user, loginAtSec: claimsFrom(payload as Record<string, unknown>)?.loginAtSec ?? null };
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  return (await readSessionToken(token))?.user ?? null;
}

export async function createSession(user: SessionIdentity) {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signSession(user, { nowSec });
  const store = await cookies();
  store.set(COOKIE_PHIEN, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(process.env.NODE_ENV, env.appUrl),
    path: "/",
    // Hạn của cookie đi ĐÚNG với hạn của token. Lệch nhau thì hoặc trình duyệt vứt một tờ giấy
    // còn hạn, hoặc nó giữ một tờ giấy đã chết rồi gửi lên để nhận về 401.
    maxAge: cookieMaxAgeSec(nowSec + SESSION_IDLE_DAYS * NGAY_GIAY, nowSec),
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_PHIEN);
}

async function getSessionRaw(): Promise<PhienDaDoc | null> {
  const store = await cookies();
  const token = store.get(COOKIE_PHIEN)?.value;
  if (!token) return null;
  return readSessionToken(token);
}

export async function getSession(): Promise<SessionUser | null> {
  return (await getSessionRaw())?.user ?? null;
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

/** Kết quả đầy đủ: hoặc là người dùng, hoặc là LÝ DO bị từ chối. Ba lý do, ba câu khác nhau. */
export type ResolvedUser = { user: SessionUser } | { denied: SessionDenyReason };

/**
 * Người dùng hiện tại với quyền đã tính, HOẶC lý do bị từ chối. Không chuyển hướng.
 *
 * `cache()` của React khử trùng lặp TRONG MỘT LẦN DỰNG: layout gọi `requireUser`, trang gọi
 * `requirePermission`, các khối Suspense gọi `can` — trước đây mỗi lời gọi là một lượt tra
 * người dùng riêng. Không phải đệm theo thời gian: lần dựng kế tiếp vẫn tra lại, nên khoá tài
 * khoản — và thu hồi phiên — có hiệu lực ngay ở lần điều hướng tiếp theo.
 */
export const resolveCurrentUser = cache(async (): Promise<ResolvedUser> => {
  const session = await getSessionRaw();
  if (!session) return { denied: "NOT_FOUND" };
  const db = await getDb();
  const [user, templates, snapshots] = await Promise.all([
    db.query.users.findFirst({
      where: eq(schema.users.id, session.user.id),
      // `sessionInvalidBefore` đi CÙNG lượt tra này — không thêm một câu truy vấn nào. Và tuyệt đối
      // KHÔNG được bọc lượt tra này trong `memo()`: một cửa sổ đệm 60 giây là 60 giây mà token vừa
      // bị thu hồi vẫn dùng được, tức là tính năng này không còn là thu hồi nữa.
      columns: { id: true, email: true, name: true, role: true, active: true, permissions: true, accessRoleId: true, positionId: true, dataScope: true, sessionInvalidBefore: true },
    }),
    loadRoleTemplates(),
    loadPermissionSnapshots(),
  ]);
  if (!user) return { denied: "NOT_FOUND" };
  if (!user.active) return { denied: "DISABLED" };
  /*
    THU HỒI PHIÊN. So mốc đăng nhập GỐC của token (`lgn`) với `users.session_invalid_before`.

    Middleware ở Edge vẫn gia hạn cookie của một phiên đã bị thu hồi — nó không có CSDL để biết.
    Vô hại, và cố ý: gia hạn giữ NGUYÊN `lgn`, nên tờ giấy vừa được ký lại vẫn bị chặn ở ngay đây.
    Đó chính là lý do luật so với `lgn` chứ không so với `iat`.
  */
  if (sessionRevoked(session.loginAtSec, user.sessionInvalidBefore)) return { denied: "REVOKED" };
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
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        permissions: resolvePermissions(user.role, user.permissions, templates, known),
        scope,
        departmentCodes: [],
        positionId: user.positionId ?? null,
      },
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
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: access.permissions,
      scope: access.scope,
      departmentCodes: access.departmentCodes,
      positionId: user.positionId ?? null,
    },
  };
});

/**
 * Người dùng hiện tại, hoặc `null`. Lớp mỏng trên `resolveCurrentUser()` — nó nuốt LÝ DO từ chối
 * đi, nên chỉ dùng cho những chỗ chỉ cần biết "có hay không" (API trả 401, khối tuỳ quyền).
 * Chỗ nào phải NÓI cho người dùng biết vì sao thì đọc `resolveCurrentUser()`.
 */
export const getCurrentUser = async (): Promise<SessionUser | null> => {
  const ket = await resolveCurrentUser();
  return "user" in ket ? ket.user : null;
};

/** Lấy người dùng hiện tại (kiểm tra còn active trong DB), chuyển hướng /login nếu chưa đăng nhập */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const ket = await resolveCurrentUser();
  if ("denied" in ket) {
    /*
      BA NGUYÊN NHÂN, BA CÂU. Trước bản này cả ba đều ra `?reason=inactive`, tức là nói với một
      nhân viên rằng tài khoản họ bị khoá trong khi tài khoản hoàn toàn bình thường — và họ đi gọi
      quản trị. Không có cookie thì về `/login` trần như cũ, vì lúc đó chẳng có gì để giải thích.
    */
    if (ket.denied === "NOT_FOUND" && !(await getSession())) redirect("/login");
    redirect(`/login?reason=${DENY_REASON_PARAM[ket.denied]}`);
  }
  const user = ket.user;
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
