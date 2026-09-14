"use server";

/**
 * Server Actions cho ba chiều quyền truy cập.
 *
 * MỌI thay đổi ở đây đều ghi nhật ký kèm TRƯỚC và SAU. Với phân quyền, "ai đó đã sửa" là thông
 * tin vô dụng — câu hỏi luôn là "sửa từ gì thành gì, lúc nào". Nhật ký thiếu vế TRƯỚC thì đến lúc
 * cần điều tra sẽ không có gì để đối chiếu.
 */
import { eq, ne, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { departmentCodesOfMany, effectiveAccess, toCustomRole } from "@/lib/auth/access";
import { can, loadPermissionSnapshots, loadRoleTemplates, requireUser } from "@/lib/auth/session";
import { normalizeScope } from "@/lib/constants/access-scope";
import { ORG_DEPENDENT_PATHS } from "@/lib/constants/org-surfaces";
import { effectivePreview } from "@/lib/queries/access";
import { savePositionSchema, saveAccessRoleSchema, setUserAccessSchema } from "@/lib/validation/access";

export type AccessResult = { ok: true; id?: string } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/**
 * Làm mới các màn hình đọc sự thật tổ chức.
 *
 * Danh sách này dài vì sự thật tổ chức được đọc ở nhiều nơi — đó là điều đúng: một nguồn, nhiều
 * màn hình. Thiếu một đường dẫn ở đây nghĩa là chủ shop đổi quyền xong, mở màn hình đó ra vẫn
 * thấy số cũ và tưởng thao tác của mình trượt.
 */
function refreshOrgViews() {
  for (const p of ORG_DEPENDENT_PATHS) revalidatePath(p);
  revalidatePath("/", "layout");
}

/** Tạo / sửa một vai trò tuỳ chỉnh. Vai trò hệ thống không đi qua đây — chúng không phải dòng dữ liệu. */
export async function saveAccessRole(input: unknown): Promise<AccessResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = saveAccessRoleSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();

  const trung = await db.query.accessRoles.findFirst({
    where: data.id ? and(eq(schema.accessRoles.code, data.code), ne(schema.accessRoles.id, data.id)) : eq(schema.accessRoles.code, data.code),
    columns: { id: true },
  });
  if (trung) return { error: `Mã "${data.code}" đã được dùng cho một vai trò khác` };

  const values = {
    code: data.code,
    name: data.name,
    description: data.description,
    baseRole: data.baseRole as (typeof schema.accessRoles.$inferInsert)["baseRole"],
    permissions: [...new Set(data.permissions)].sort(),
    defaultScope: data.defaultScope,
    active: data.active,
  };

  if (!data.id) {
    const [row] = await db.insert(schema.accessRoles).values(values).returning({ id: schema.accessRoles.id });
    await audit({ userId: user.id, userEmail: user.email, action: "ACCESS_ROLE_CREATE", entity: "ACCESS_ROLE", entityId: row.id, detail: { after: values } });
    refreshOrgViews();
    return { ok: true, id: row.id };
  }

  const cu = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, data.id) });
  if (!cu) return { error: "Không tìm thấy vai trò" };
  await db.update(schema.accessRoles).set(values).where(eq(schema.accessRoles.id, data.id));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ACCESS_ROLE_UPDATE",
    entity: "ACCESS_ROLE",
    entityId: data.id,
    detail: {
      before: { code: cu.code, name: cu.name, baseRole: cu.baseRole, permissions: cu.permissions, defaultScope: cu.defaultScope, active: cu.active },
      after: values,
    },
  });
  refreshOrgViews();
  return { ok: true, id: data.id };
}

/**
 * Tắt / bật một vai trò tuỳ chỉnh.
 *
 * KHÔNG XOÁ. Người đang mang vai trò ấy giữ nguyên `access_role_id`; tắt chỉ khiến phép tính quyền
 * rơi về mẫu của vai trò hệ thống nền. Bật lại là khôi phục nguyên trạng — còn xoá thì mất luôn
 * dấu vết ai từng được cấp gì.
 */
export async function setAccessRoleActive(input: unknown): Promise<AccessResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const { id, active } = (input ?? {}) as { id?: string; active?: boolean };
  if (!id || typeof active !== "boolean") return { error: "Thiếu tham số" };
  const db = await getDb();
  const cu = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, id), columns: { id: true, code: true, name: true, active: true } });
  if (!cu) return { error: "Không tìm thấy vai trò" };
  if (cu.active === active) return { ok: true, id };
  await db.update(schema.accessRoles).set({ active }).where(eq(schema.accessRoles.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: active ? "ACCESS_ROLE_ENABLE" : "ACCESS_ROLE_DISABLE", entity: "ACCESS_ROLE", entityId: id, detail: { code: cu.code, name: cu.name, before: { active: cu.active }, after: { active } } });
  refreshOrgViews();
  return { ok: true, id };
}

/** Tạo / sửa một chức danh. Chức danh là NHÃN — không dòng nào ở đây đụng tới quyền. */
export async function savePosition(input: unknown): Promise<AccessResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = savePositionSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();

  const trung = await db.query.positions.findFirst({
    where: data.id ? and(eq(schema.positions.code, data.code), ne(schema.positions.id, data.id)) : eq(schema.positions.code, data.code),
    columns: { id: true },
  });
  if (trung) return { error: `Mã "${data.code}" đã được dùng cho một chức danh khác` };

  const values = { code: data.code, name: data.name, description: data.description, departmentId: data.departmentId || null, active: data.active };

  if (!data.id) {
    const [row] = await db.insert(schema.positions).values(values).returning({ id: schema.positions.id });
    await audit({ userId: user.id, userEmail: user.email, action: "POSITION_CREATE", entity: "POSITION", entityId: row.id, detail: { after: values } });
    refreshOrgViews();
    return { ok: true, id: row.id };
  }

  const cu = await db.query.positions.findFirst({ where: eq(schema.positions.id, data.id) });
  if (!cu) return { error: "Không tìm thấy chức danh" };
  await db.update(schema.positions).set(values).where(eq(schema.positions.id, data.id));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "POSITION_UPDATE",
    entity: "POSITION",
    entityId: data.id,
    detail: { before: { code: cu.code, name: cu.name, departmentId: cu.departmentId, active: cu.active }, after: values },
  });
  refreshOrgViews();
  return { ok: true, id: data.id };
}

export async function setPositionActive(input: unknown): Promise<AccessResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const { id, active } = (input ?? {}) as { id?: string; active?: boolean };
  if (!id || typeof active !== "boolean") return { error: "Thiếu tham số" };
  const db = await getDb();
  const cu = await db.query.positions.findFirst({ where: eq(schema.positions.id, id), columns: { id: true, code: true, name: true, active: true } });
  if (!cu) return { error: "Không tìm thấy chức danh" };
  if (cu.active === active) return { ok: true, id };
  await db.update(schema.positions).set({ active }).where(eq(schema.positions.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: active ? "POSITION_ENABLE" : "POSITION_DISABLE", entity: "POSITION", entityId: id, detail: { code: cu.code, name: cu.name, before: { active: cu.active }, after: { active } } });
  refreshOrgViews();
  return { ok: true, id };
}

/**
 * Gán ba chiều cho một người dùng.
 *
 * Ghi nhật ký cả QUYỀN THỰC TẾ trước và sau, không chỉ ba cái id. Ba id thì phải tra ngược qua
 * bảng vai trò (mà bảng ấy có thể đã bị sửa từ lúc đó) mới biết người ta thực sự được gì; ảnh
 * chụp danh sách quyền thì đọc là hiểu, kể cả một năm sau.
 */
export async function setUserAccess(input: unknown): Promise<AccessResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = setUserAccessSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();

  const target = await db.query.users.findFirst({
    where: eq(schema.users.id, data.userId),
    columns: { id: true, email: true, role: true, permissions: true, accessRoleId: true, positionId: true, dataScope: true },
  });
  if (!target) return { error: "Không tìm thấy người dùng" };

  /*
    Quản trị viên không nhận phạm vi hẹp hay vai trò tuỳ chỉnh. Không phải vì họ đặc biệt, mà vì
    phép tính quyền cho `ADMIN` bỏ qua cả hai — lưu vào thì màn hình hiện một giới hạn KHÔNG CÓ
    THẬT, và đó là kiểu sai nguy hiểm nhất của một trang phân quyền: tưởng đã khoá.
  */
  if (target.role === "ADMIN" && (data.accessRoleId || data.scope !== "ALL")) {
    return { error: "Quản trị viên luôn có toàn quyền trên toàn công ty; hạ vai trò hệ thống trước nếu muốn giới hạn" };
  }

  const roleId = data.accessRoleId || null;
  const positionId = data.positionId || null;
  if (roleId) {
    const r = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, roleId), columns: { id: true, active: true } });
    if (!r) return { error: "Vai trò tuỳ chỉnh không tồn tại" };
    if (!r.active) return { error: "Vai trò này đang tắt — bật lại trước khi gán cho người dùng" };
  }
  if (positionId) {
    const p = await db.query.positions.findFirst({ where: eq(schema.positions.id, positionId), columns: { id: true, active: true } });
    if (!p) return { error: "Chức danh không tồn tại" };
    if (!p.active) return { error: "Chức danh này đang tắt — bật lại trước khi gán cho người dùng" };
  }

  const truoc = await anhChupQuyen(target.id);
  await db.update(schema.users).set({ accessRoleId: roleId, positionId, dataScope: data.scope }).where(eq(schema.users.id, data.userId));
  const sau = await anhChupQuyen(target.id);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "USER_ACCESS_SET",
    entity: "USER",
    entityId: target.id,
    detail: {
      email: target.email,
      before: { accessRoleId: target.accessRoleId, positionId: target.positionId, scope: normalizeScope(target.dataScope), permissions: truoc },
      after: { accessRoleId: roleId, positionId, scope: data.scope, permissions: sau },
    },
  });
  refreshOrgViews();
  return { ok: true, id: target.id };
}

/** Ảnh chụp danh sách quyền THỰC TẾ của một người ngay lúc này (dùng cho vế trước/sau của nhật ký). */
async function anhChupQuyen(userId: string): Promise<string[]> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { role: true, permissions: true, accessRoleId: true, dataScope: true } });
  if (!u) return [];
  const [roleRow, deptMap] = await Promise.all([
    u.accessRoleId ? db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, u.accessRoleId) }) : Promise.resolve(undefined),
    departmentCodesOfMany([userId]),
  ]);
  const [templates, snapshots] = await Promise.all([loadRoleTemplates(), loadPermissionSnapshots()]);
  return effectiveAccess({
    role: u.role,
    userCustom: u.permissions,
    customRole: roleRow ? toCustomRole(roleRow) : null,
    scope: normalizeScope(u.dataScope),
    departmentCodes: deptMap[userId] ?? [],
    templates,
    known: snapshots[userId] ?? null,
  }).permissions.sort();
}

/**
 * XEM TRƯỚC quyền thực tế cho một lựa chọn CHƯA LƯU.
 *
 * Phải là server action vì phép cộng quyền chỉ có một chỗ và chỗ đó ở phía máy chủ. Tính lại ở
 * trình duyệt sẽ nhanh hơn một nhịp và sai vào cái ngày hai bản sao lệch nhau — mà màn xem trước
 * sai còn tệ hơn không có màn xem trước, vì nó tạo ra niềm tin.
 */
export async function previewUserAccess(input: unknown): Promise<{ error: string } | { ok: true; preview: NonNullable<Awaited<ReturnType<typeof effectivePreview>>> }> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const { userId, accessRoleId, scope } = (input ?? {}) as { userId?: string; accessRoleId?: string | null; scope?: string };
  if (!userId) return { error: "Thiếu người dùng" };
  const preview = await effectivePreview(userId, { accessRoleId: accessRoleId ?? null, scope: normalizeScope(scope) });
  if (!preview) return { error: "Không tìm thấy người dùng" };
  return { ok: true, preview };
}
