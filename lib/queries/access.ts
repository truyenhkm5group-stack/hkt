/**
 * Truy vấn chỉ-server cho ba chiều quyền truy cập: vai trò tuỳ chỉnh · chức danh · phạm vi.
 *
 * Phép cộng quyền KHÔNG nằm ở đây — nó nằm ở `lib/auth/access.ts` và chỉ ở đó. Tệp này đọc dữ
 * liệu rồi gọi sang, để màn Người dùng xem trước đúng thứ mà phiên đăng nhập sẽ tính ra. Nếu màn
 * xem trước tự cộng lấy thì nó sẽ có ngày nói một đằng và hệ thống làm một nẻo — mà đó chính là
 * thứ màn xem trước sinh ra để phòng.
 */
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { ACCESS_SOURCE_LABEL, departmentCodesOfMany, effectiveAccess, toCustomRole, type CustomRole, type EffectiveAccess } from "@/lib/auth/access";
import { ALL_PERMISSIONS, PERMISSION_LABEL } from "@/lib/auth/permissions";
import { loadPermissionSnapshots, loadRoleTemplates } from "@/lib/auth/session";
import { normalizeScope, SENSITIVE_AREAS, type AccessScope } from "@/lib/constants/access-scope";

export type AccessRoleRow = CustomRole & { description: string; sortOrder: number; usedBy: number };
export type PositionRow = { id: string; code: string; name: string; description: string; departmentId: string | null; departmentName: string; active: boolean; sortOrder: number; usedBy: number };

/** Vai trò tuỳ chỉnh, kèm số người đang dùng (để cảnh báo trước khi tắt). */
export async function listAccessRoles(): Promise<AccessRoleRow[]> {
  const db = await getDb();
  const [rows, users] = await Promise.all([
    db.query.accessRoles.findMany({ orderBy: [asc(schema.accessRoles.sortOrder), asc(schema.accessRoles.name)] }),
    db.select({ accessRoleId: schema.users.accessRoleId }).from(schema.users),
  ]);
  const dem = new Map<string, number>();
  for (const u of users) if (u.accessRoleId) dem.set(u.accessRoleId, (dem.get(u.accessRoleId) ?? 0) + 1);
  return rows.map((r) => ({ ...toCustomRole(r), description: r.description, sortOrder: r.sortOrder, usedBy: dem.get(r.id) ?? 0 }));
}

/** Chức danh, kèm tên phòng ban gắn kèm và số người đang mang. */
export async function listPositions(): Promise<PositionRow[]> {
  const db = await getDb();
  const [rows, users] = await Promise.all([
    db
      .select({
        id: schema.positions.id,
        code: schema.positions.code,
        name: schema.positions.name,
        description: schema.positions.description,
        departmentId: schema.positions.departmentId,
        departmentName: schema.departments.name,
        active: schema.positions.active,
        sortOrder: schema.positions.sortOrder,
      })
      .from(schema.positions)
      .leftJoin(schema.departments, eq(schema.departments.id, schema.positions.departmentId))
      .orderBy(asc(schema.positions.sortOrder), asc(schema.positions.name)),
    db.select({ positionId: schema.users.positionId }).from(schema.users),
  ]);
  const dem = new Map<string, number>();
  for (const u of users) if (u.positionId) dem.set(u.positionId, (dem.get(u.positionId) ?? 0) + 1);
  return rows.map((r) => ({ ...r, departmentName: r.departmentName ?? "", usedBy: dem.get(r.id) ?? 0 }));
}

export type UserAccessRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  accessRoleId: string | null;
  accessRoleName: string;
  positionId: string | null;
  positionName: string;
  scope: AccessScope;
  hasCustomPermissions: boolean;
};

/** Ba chiều hiện tại của mọi người dùng — một câu truy vấn, dùng cho bảng danh sách. */
export async function listUserAccess(): Promise<Record<string, UserAccessRow>> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      accessRoleId: schema.users.accessRoleId,
      accessRoleName: schema.accessRoles.name,
      positionId: schema.users.positionId,
      positionName: schema.positions.name,
      scope: schema.users.dataScope,
      permissions: schema.users.permissions,
    })
    .from(schema.users)
    .leftJoin(schema.accessRoles, eq(schema.accessRoles.id, schema.users.accessRoleId))
    .leftJoin(schema.positions, eq(schema.positions.id, schema.users.positionId));
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        accessRoleId: r.accessRoleId,
        accessRoleName: r.accessRoleName ?? "",
        positionId: r.positionId,
        positionName: r.positionName ?? "",
        scope: normalizeScope(r.scope),
        hasCustomPermissions: Array.isArray(r.permissions),
      },
    ]),
  );
}

export type EffectivePreview = EffectiveAccess & {
  userId: string;
  sourceLabel: string;
  /** Quyền còn hiệu lực, nhóm theo module, đã có nhãn tiếng Việt. */
  granted: { key: string; label: string }[];
  /** Vùng nhạy cảm và người này có chạm được vào không. */
  sensitive: { area: string; department: string; reason: string; allowed: boolean }[];
};

/**
 * XEM TRƯỚC: sau khi cộng vai trò + phạm vi thì người này THỰC TẾ đọc/sửa được gì.
 *
 * Nhận `override` để trả lời câu hỏi "nếu tôi đổi sang thế này thì sao" TRƯỚC khi lưu. Không có
 * nó thì chủ shop phải lưu rồi mới biết mình vừa làm gì — và với phân quyền, "lưu rồi mới biết"
 * nghĩa là có một khoảng thời gian ai đó thấy thứ họ không được thấy.
 */
export async function effectivePreview(
  userId: string,
  override?: { accessRoleId?: string | null; scope?: AccessScope },
): Promise<EffectivePreview | null> {
  const db = await getDb();
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { id: true, role: true, permissions: true, accessRoleId: true, dataScope: true },
  });
  if (!user) return null;

  const roleId = override && "accessRoleId" in override ? override.accessRoleId || null : user.accessRoleId;
  const scope = override?.scope ?? normalizeScope(user.dataScope);
  const [customRoleRow, deptMap, templates, snapshots] = await Promise.all([
    roleId ? db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, roleId) }) : Promise.resolve(undefined),
    departmentCodesOfMany([userId]),
    loadRoleTemplates(),
    loadPermissionSnapshots(),
  ]);
  const departmentCodes = deptMap[userId] ?? [];
  const access = effectiveAccess({
    role: user.role,
    userCustom: user.permissions,
    customRole: customRoleRow ? toCustomRole(customRoleRow) : null,
    scope,
    departmentCodes,
    templates,
    known: snapshots[userId] ?? null,
  });

  const con = new Set(access.permissions);
  return {
    ...access,
    userId,
    sourceLabel: ACCESS_SOURCE_LABEL[access.source],
    granted: (ALL_PERMISSIONS as string[]).filter((p) => con.has(p)).map((key) => ({ key, label: PERMISSION_LABEL[key] ?? key })),
    sensitive: SENSITIVE_AREAS.map((area) => ({
      area: area.label,
      department: area.department,
      reason: area.reason,
      allowed: area.permissions.some((p) => con.has(p)),
    })),
  };
}
