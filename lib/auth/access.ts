/**
 * ═══════════ MỘT ĐƯỜNG DUY NHẤT ĐỂ BIẾT "NGƯỜI NÀY ĐƯỢC GÌ" ═══════════
 *
 * Ba chiều (vai trò · chức danh · phạm vi) được mô tả ở đầu `lib/constants/access-scope.ts`.
 * Tệp này là chỗ DUY NHẤT cộng chúng lại. Mọi màn hình, mọi server action, mọi truy vấn đọc kết
 * quả ở đây — không nơi nào tự cộng lại một lần nữa. Hai phép cộng cho cùng một câu hỏi là hai
 * cách để chúng trả lời khác nhau, và cái sai sẽ là cái nới rộng.
 *
 * THỨ TỰ ƯU TIÊN CỦA BÓ QUYỀN (hẹp dần về phía trái):
 *
 *   1. `ADMIN`                    → toàn quyền, không xét gì thêm.
 *   2. quyền tuỳ chỉnh của người → `users.permissions` (đã có từ trước, giữ nguyên ngữ nghĩa).
 *   3. vai trò tuỳ chỉnh         → `access_roles.permissions`, nếu vai trò đó còn bật.
 *   4. mẫu quyền của vai trò hệ thống → `settings["auth.rolePermissions"]` hoặc mặc định.
 *
 * Vai trò tuỳ chỉnh bị TẮT thì rơi về bậc 4 — KHÔNG BAO GIỜ rơi về "toàn quyền". Quy tắc chung:
 * mọi nhánh lỗi, dữ liệu thiếu, giá trị lạ đều phải rơi về phía HẸP HƠN.
 *
 * SAU ĐÓ PHẠM VI CẮT BỚT. Phạm vi không bao giờ thêm quyền; nó chỉ có thể gỡ quyền thuộc vùng
 * nhạy cảm (tiền · nhân sự · điều hành) của người không ở phòng ban sở hữu vùng đó.
 *
 * CHỨC DANH KHÔNG XUẤT HIỆN Ở ĐÂY. Cố ý. Xem `tests/access-model.test.ts`.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { ALL_PERMISSIONS, resolvePermissions, withDerivedApprovalDecide, type RolePermissionMap } from "@/lib/auth/permissions";
import {
  normalizeScope,
  ROLE_BUILDER_FORBIDDEN,
  SENSITIVE_AREAS,
  SENSITIVE_BY_PERMISSION,
  type AccessScope,
} from "@/lib/constants/access-scope";

/** Vai trò tuỳ chỉnh đã nạp (chỉ phần dùng để tính quyền). */
export type CustomRole = { id: string; code: string; name: string; baseRole: Role; permissions: string[]; defaultScope: AccessScope; active: boolean };

/** Vì sao một quyền bị gỡ — để màn xem trước nói được lý do thay vì chỉ báo "không có". */
export type DroppedPermission = { permission: string; area: string; reason: string };

export type EffectiveAccess = {
  /** Quyền còn hiệu lực sau khi cộng vai trò và cắt theo phạm vi. */
  permissions: string[];
  /** Quyền bó vai trò có cấp nhưng phạm vi đã cắt đi, kèm lý do. */
  dropped: DroppedPermission[];
  scope: AccessScope;
  /** Nguồn của bó quyền: dùng để hiển thị, không dùng để quyết định. */
  source: "ADMIN" | "USER_CUSTOM" | "CUSTOM_ROLE" | "ROLE_TEMPLATE";
  /** Mã phòng ban người đó là thành viên (đã lọc phòng còn hoạt động). */
  departmentCodes: string[];
};

/**
 * Bó quyền TRƯỚC khi cắt theo phạm vi.
 *
 * Tách riêng để màn xem trước chỉ ra được chênh lệch giữa "vai trò cấp gì" và "thực tế còn gì" —
 * nếu chỉ trả về kết quả cuối thì chủ shop thấy một quyền biến mất mà không biết vì sao.
 */
export function grantedPermissions(
  role: Role,
  userCustom: string[] | null | undefined,
  customRole: CustomRole | null | undefined,
  templates?: RolePermissionMap | null,
  known?: string[] | null,
): { permissions: string[]; source: EffectiveAccess["source"] } {
  if (role === "ADMIN") return { permissions: [...ALL_PERMISSIONS], source: "ADMIN" };
  if (Array.isArray(userCustom)) return { permissions: resolvePermissions(role, userCustom, templates, known), source: "USER_CUSTOM" };
  if (customRole && customRole.active) {
    const bo = customRole.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p) && !ROLE_BUILDER_FORBIDDEN.includes(p));
    // Quyền duyệt hai bước đi theo VAI hệ thống + `settings:manage`, y như trước khi có khoá (Company OS · G).
    return { permissions: withDerivedApprovalDecide(role, [...new Set(bo)]), source: "CUSTOM_ROLE" };
  }
  return { permissions: resolvePermissions(role, null, templates, known), source: "ROLE_TEMPLATE" };
}

/**
 * Cắt bó quyền theo phạm vi.
 *
 * Luật duy nhất ở đây: quyền thuộc VÙNG NHẠY CẢM chỉ còn hiệu lực khi người đó có phạm vi `ALL`
 * hoặc là thành viên phòng ban sở hữu vùng đó. Ngoài luật này, phạm vi không đụng tới danh sách
 * quyền — nó cắt SỐ DÒNG ở tầng truy vấn (`lib/auth/scope.ts`), không cắt loại màn hình.
 *
 * `ADMIN` không bị cắt: quản trị viên là người dựng ra luật này, không phải đối tượng của nó.
 */
export function applyScope(
  role: Role,
  permissions: string[],
  scope: AccessScope,
  departmentCodes: readonly string[],
): { permissions: string[]; dropped: DroppedPermission[] } {
  if (role === "ADMIN" || scope === "ALL") return { permissions: [...permissions], dropped: [] };
  const thuoc = new Set(departmentCodes);
  const giu: string[] = [];
  const bo: DroppedPermission[] = [];
  for (const p of permissions) {
    const vung = SENSITIVE_BY_PERMISSION[p];
    if (!vung || thuoc.has(vung.department)) {
      giu.push(p);
      continue;
    }
    bo.push({ permission: p, area: vung.label, reason: `Phạm vi đang hẹp hơn toàn công ty và người này không thuộc phòng ${vung.label} — ${vung.reason}` });
  }
  return { permissions: giu, dropped: bo };
}

/** Nạp vai trò tuỳ chỉnh theo id (null nếu không có / đã bị xoá). */
export async function loadCustomRole(id: string | null | undefined): Promise<CustomRole | null> {
  if (!id) return null;
  const db = await getDb();
  const row = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, id) });
  return row ? toCustomRole(row) : null;
}

export function toCustomRole(row: typeof schema.accessRoles.$inferSelect): CustomRole {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    baseRole: row.baseRole,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    defaultScope: normalizeScope(row.defaultScope),
    active: row.active,
  };
}

/** Mã phòng ban ĐANG HOẠT ĐỘNG mà một người là thành viên còn hiệu lực. */
export async function departmentCodesOf(userId: string): Promise<string[]> {
  if (!userId) return [];
  return (await departmentCodesOfMany([userId]))[userId] ?? [];
}

/** Nạp nhiều người cùng lúc (màn danh sách) — một câu truy vấn, không N+1. */
export async function departmentCodesOfMany(userIds: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = Object.fromEntries(userIds.map((id) => [id, []]));
  if (!userIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ userId: schema.departmentMembers.userId, code: schema.departments.code })
    .from(schema.departmentMembers)
    .innerJoin(schema.departments, eq(schema.departments.id, schema.departmentMembers.departmentId))
    .where(and(inArray(schema.departmentMembers.userId, userIds), eq(schema.departmentMembers.active, true), eq(schema.departments.active, true)));
  for (const r of rows) {
    const list = out[r.userId];
    if (list && !list.includes(r.code)) list.push(r.code);
  }
  return out;
}

/** Cộng đủ ba chiều cho một người dùng đã nạp sẵn. Thuần tính toán — tiện cho kiểm thử. */
export function effectiveAccess(input: {
  role: Role;
  userCustom: string[] | null | undefined;
  customRole: CustomRole | null | undefined;
  scope: AccessScope;
  departmentCodes: readonly string[];
  templates?: RolePermissionMap | null;
  known?: string[] | null;
}): EffectiveAccess {
  const { permissions: cap, source } = grantedPermissions(input.role, input.userCustom, input.customRole, input.templates, input.known);
  const { permissions, dropped } = applyScope(input.role, cap, input.scope, input.departmentCodes);
  return { permissions, dropped, scope: input.scope, source, departmentCodes: [...input.departmentCodes] };
}

/** Nhãn tiếng Việt cho nguồn bó quyền. */
export const ACCESS_SOURCE_LABEL: Record<EffectiveAccess["source"], string> = {
  ADMIN: "Quản trị viên — toàn quyền",
  USER_CUSTOM: "Quyền tuỳ chỉnh riêng của người này",
  CUSTOM_ROLE: "Vai trò tuỳ chỉnh",
  ROLE_TEMPLATE: "Mẫu quyền của vai trò hệ thống",
};

export { SENSITIVE_AREAS };
