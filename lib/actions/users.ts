"use server";

import { and, count, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { can, requireUser, ROLE_PERMISSIONS_KEY } from "@/lib/auth/session";
import { setSettingJson } from "@/lib/settings";
import { changePasswordSchema, createUserSchema, resetPasswordSchema, rolePermissionsSchema, setUserActiveSchema, updateUserSchema, userPermissionsSchema } from "@/lib/validation/users";

export type ActionResult = { ok: true; id?: string } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/** Số quản trị viên đang hoạt động, trừ người dùng `exceptId` */
async function otherActiveAdmins(exceptId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ count: count() })
    .from(schema.users)
    .where(and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true), ne(schema.users.id, exceptId)));
  return Number(row?.count ?? 0);
}

export async function createUser(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, data.email), columns: { id: true } });
  if (existing) return { error: "Email này đã được sử dụng" };
  const [row] = await db
    .insert(schema.users)
    .values({ email: data.email, name: data.name, role: data.role, passwordHash: await hashPassword(data.password), active: true })
    .returning({ id: schema.users.id });
  await audit({ userId: user.id, userEmail: user.email, action: "USER_CREATE", entity: "USER", entityId: row.id, detail: { email: data.email, name: data.name, role: data.role } });
  revalidatePath("/settings/users");
  return { ok: true, id: row.id };
}

export async function updateUser(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, data.id), columns: { id: true, email: true, name: true, role: true, active: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  if (target.id === user.id && (!data.active || data.role !== "ADMIN")) return { error: "Không thể tự khoá hoặc tự hạ quyền tài khoản của chính bạn" };
  if (target.role === "ADMIN" && target.active && (data.role !== "ADMIN" || !data.active) && (await otherActiveAdmins(target.id)) === 0) {
    return { error: "Đây là quản trị viên cuối cùng — hãy tạo quản trị viên khác trước" };
  }
  await db.update(schema.users).set({ name: data.name, role: data.role, active: data.active }).where(eq(schema.users.id, data.id));
  await audit({ userId: user.id, userEmail: user.email, action: "USER_UPDATE", entity: "USER", entityId: target.id, detail: { email: target.email, before: { name: target.name, role: target.role, active: target.active }, after: { name: data.name, role: data.role, active: data.active } } });
  revalidatePath("/settings/users");
  return { ok: true, id: target.id };
}

export async function setUserActive(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = setUserActiveSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, active } = parsed.data;
  const db = await getDb();
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, email: true, role: true, active: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  if (target.id === user.id && !active) return { error: "Không thể tự khoá tài khoản của chính bạn" };
  if (!active && target.role === "ADMIN" && target.active && (await otherActiveAdmins(target.id)) === 0) return { error: "Không thể khoá quản trị viên cuối cùng" };
  if (target.active === active) return { ok: true, id };
  await db.update(schema.users).set({ active }).where(eq(schema.users.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: active ? "USER_UNLOCK" : "USER_LOCK", entity: "USER", entityId: id, detail: { email: target.email } });
  revalidatePath("/settings/users");
  return { ok: true, id };
}

export async function resetUserPassword(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, password } = parsed.data;
  const db = await getDb();
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, email: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "USER_RESET_PASSWORD", entity: "USER", entityId: id, detail: { email: target.email } });
  revalidatePath("/settings/users");
  return { ok: true, id };
}

/** Người dùng tự đổi mật khẩu của mình */
export async function changeMyPassword(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { currentPassword, newPassword } = parsed.data;
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id), columns: { id: true, passwordHash: true } });
  if (!row) return { error: "Không tìm thấy tài khoản" };
  if (!(await verifyPassword(currentPassword, row.passwordHash))) {
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Mật khẩu hiện tại không đúng" };
  }
  await db.update(schema.users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(schema.users.id, user.id));
  await audit({ userId: user.id, userEmail: user.email, action: "PASSWORD_CHANGE", entity: "USER", entityId: user.id });
  return { ok: true, id: user.id };
}

/** Tuỳ chỉnh quyền riêng cho một người dùng (null = quay về mẫu quyền của vai trò) */
export async function updateUserPermissions(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = userPermissionsSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, permissions } = parsed.data;
  const db = await getDb();
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, email: true, role: true, permissions: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  if (target.role === "ADMIN") return { error: "Quản trị viên luôn có toàn quyền; đổi vai trò nếu muốn giới hạn" };
  const next = permissions ? [...new Set(permissions)].sort() : null;
  await db.update(schema.users).set({ permissions: next }).where(eq(schema.users.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "USER_PERMISSIONS", entity: "USER", entityId: id, detail: { email: target.email, before: target.permissions ?? null, after: next } });
  revalidatePath("/settings/users");
  revalidatePath("/", "layout");
  return { ok: true, id };
}

/** Lưu mẫu quyền của các vai trò (áp dụng cho mọi người dùng chưa tuỳ chỉnh riêng) */
export async function saveRolePermissions(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = rolePermissionsSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const map = Object.fromEntries(Object.entries(parsed.data).map(([role, list]) => [role, [...new Set(list)].sort()]));
  await setSettingJson(ROLE_PERMISSIONS_KEY, map);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: ROLE_PERMISSIONS_KEY, detail: map });
  revalidatePath("/settings/users");
  revalidatePath("/", "layout");
  return { ok: true };
}
