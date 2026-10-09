"use server";

import { and, count, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { indexAccountInCurrentOrganization } from "@/lib/auth/identities";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { ALL_PERMISSIONS, USER_PERMISSION_SNAPSHOT_KEY } from "@/lib/auth/permissions";
import { can, destroySession, loadPermissionSnapshots, requireUser, ROLE_PERMISSIONS_KEY, type SessionUser } from "@/lib/auth/session";
import { applySessionRevocation } from "@/lib/auth/session-revoke";
import { salesStaffRoleOf, SHELL_ROLE_REJECTED, shellRoleChoiceOk } from "@/lib/constants/roles";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";
import { listAccessRoles } from "@/lib/queries/access";
import { setSettingJson } from "@/lib/settings";
import { createUserCore } from "@/lib/users/create-user";
import { changePasswordSchema, resetPasswordSchema, rolePermissionsSchema, setUserActiveSchema, updateUserSchema, userPermissionsSchema } from "@/lib/validation/users";

export type ActionResult = { ok: true; id?: string; signedOut?: boolean } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/**
 * VỎ CHỐT ĐƠN: chỉ nhận ba lựa chọn Chủ cửa hàng · Nhân viên bán hàng (mã `BAN_HANG`) · Chỉ xem (`lib/constants/roles.ts`).
 * Chỉ GIỚI HẠN LỰA CHỌN — không đổi quyền nào, cổng `can()` của từng action giữ nguyên. ERP / nhà ⇒ `null`, không đọc gì thêm.
 */
async function shellRoleError(user: SessionUser, choice: { role?: unknown; accessRoleCode?: unknown }): Promise<string | null> {
  if (!isSalesAgentUser(user)) return null;
  const sales = salesStaffRoleOf(await listAccessRoles());
  return shellRoleChoiceOk(choice, Boolean(sales)) ? null : SHELL_ROLE_REJECTED;
}

function pick(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
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
  // Tạo tài khoản không gán vai trò tuỳ chỉnh ⇒ ở vỏ chỉ ADMIN / VIEWER (Nhân viên bán hàng gán tiếp qua `setUserAccess`).
  const shellError = await shellRoleError(user, { role: pick(input, "role") });
  if (shellError) return { error: shellError };
  // Đường ghi DUY NHẤT tạo tài khoản (lib/users/create-user.ts): quyền, lược đồ, email trùng, hạn mức gói (kể cả ghế đã
  // hứa cho lời mời còn hạn), băm mật khẩu, nhật ký — dùng chung với cửa nhận lời mời.
  const result = await createUserCore(user, input);
  if ("error" in result) return result;
  revalidatePath("/settings/users");
  return { ok: true, id: result.id };
}

export async function updateUser(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const shellError = await shellRoleError(user, { role: pick(input, "role") });
  if (shellError) return { error: shellError };
  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, data.id), columns: { id: true, email: true, name: true, role: true, active: true, phone: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  if (target.id === user.id && (!data.active || data.role !== "ADMIN")) return { error: "Không thể tự khoá hoặc tự hạ quyền tài khoản của chính bạn" };
  if (target.role === "ADMIN" && target.active && (data.role !== "ADMIN" || !data.active) && (await otherActiveAdmins(target.id)) === 0) {
    return { error: "Đây là quản trị viên cuối cùng — hãy tạo quản trị viên khác trước" };
  }
  await db.update(schema.users).set({ name: data.name, role: data.role, active: data.active }).where(eq(schema.users.id, data.id));
  await audit({ userId: user.id, userEmail: user.email, action: "USER_UPDATE", entity: "USER", entityId: target.id, detail: { email: target.email, before: { name: target.name, role: target.role, active: target.active }, after: { name: data.name, role: data.role, active: data.active } } });
  /*
    CHỈ khi tài khoản chuyển từ ĐANG HOẠT ĐỘNG sang BỊ KHOÁ. Hộp thoại này đổi cả tên và VAI TRÒ,
    và đổi vai trò KHÔNG được thu hồi phiên: quyền vốn đã được nạp lại từ CSDL ở mọi lượt gọi, nên
    thu hồi ở đó chỉ là đá người ta ra vì một lần sửa nhãn — và dạy cả đội bỏ qua thông báo phiên.
  */
  if (target.active && !data.active) {
    await applySessionRevocation({ targetUserId: target.id, targetEmail: target.email, trigger: "ACCOUNT_DISABLED", actor: { id: user.id, label: user.email } });
  }
  // MỞ KHOÁ ⇒ chỉ mục đăng nhập chắc chắn có (idempotent): tài khoản bị khoá không được ghi chỉ mục (cấp phát lại / đối chiếu bỏ qua
  // nó), nên mở khoá mà không ghi thì người ấy chỉ vào được khi gõ «mã tổ chức» (lib/auth/identities.ts).
  if (!target.active && data.active) await indexAccountInCurrentOrganization({ ...target, active: true });
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
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, email: true, role: true, active: true, phone: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  if (target.id === user.id && !active) return { error: "Không thể tự khoá tài khoản của chính bạn" };
  if (!active && target.role === "ADMIN" && target.active && (await otherActiveAdmins(target.id)) === 0) return { error: "Không thể khoá quản trị viên cuối cùng" };
  if (target.active === active) {
    // Không đổi gì vẫn làm mới: trang có thể đang cũ (người khác vừa làm) — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
    revalidatePath("/settings/users");
    return { ok: true, id };
  }
  await db.update(schema.users).set({ active }).where(eq(schema.users.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: active ? "USER_UNLOCK" : "USER_LOCK", entity: "USER", entityId: id, detail: { email: target.email } });
  /*
    `users.active = false` đã chặn ngay ở `resolveCurrentUser()`, nên dòng này DƯ cho hôm nay. Nó
    tồn tại cho NGÀY MỞ KHOÁ LẠI: không đẩy mốc thì token cũ (còn trong trần 30 ngày) sống lại
    nguyên vẹn vào lúc mở khoá, tức là một tài khoản từng bị khoá vì nghi ngờ lại tự động tiếp tục
    phiên cũ. Rẻ: cùng một câu UPDATE.
  */
  if (!active) {
    await applySessionRevocation({ targetUserId: id, targetEmail: target.email, trigger: "ACCOUNT_DISABLED", actor: { id: user.id, label: user.email } });
  }
  // Mở khoá ⇒ chỉ mục đăng nhập chắc chắn có (idempotent) — cùng lý do với `updateUser`.
  if (active) await indexAccountInCurrentOrganization({ ...target, active: true });
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
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, email: true, phone: true, active: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "USER_RESET_PASSWORD", entity: "USER", entityId: id, detail: { email: target.email } });
  // Mật khẩu mới ⇒ tài khoản dùng được bằng mật khẩu ⇒ chỉ mục đăng nhập chắc chắn có (tài khoản tạo trước 08/10/2026 chưa có;
  // idempotent — lib/auth/identities.ts). Đặt hộ không phải một lượt đăng nhập: không mốc dùng.
  await indexAccountInCurrentOrganization(target);
  // Đặt lại mật khẩu mà token cũ vẫn sống thì việc đặt lại KHÔNG có tác dụng gì — đây chính là lý
  // do tồn tại của cả tính năng thu hồi. Bắt buộc, không có cờ tắt.
  await applySessionRevocation({ targetUserId: id, targetEmail: target.email, trigger: "PASSWORD_RESET", actor: { id: user.id, label: user.email } });
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
  // Đổi mật khẩu thu hồi TOÀN BỘ phiên, kể cả phiên đang dùng. Chừa lại đúng cái đang cầm thì câu
  // "đổi mật khẩu là cắt mọi truy cập cũ" không còn đúng nữa, mà đó là câu người dùng đang tin.
  await applySessionRevocation({ targetUserId: user.id, targetEmail: user.email, trigger: "PASSWORD_RESET", actor: { id: user.id, label: user.email } });
  // Xoá cookie ngay tại đây: để lại thì lượt điều hướng kế tiếp đá họ ra với câu "phiên đã bị thu
  // hồi", đọc lên như thể có ai đó vừa can thiệp — trong khi chính họ vừa bấm đổi mật khẩu.
  await destroySession();
  return { ok: true, id: user.id, signedOut: true };
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
  // Ghi lại bộ khoá quyền TẠI THỜI ĐIỂM LƯU. Khoá sinh ra sau này chưa từng được hỏi nên sẽ áp mẫu
  // của vai trò — nếu không, người có quyền tuỳ chỉnh bị đóng băng và mọi module mới đều vô hình.
  const snapshots = await loadPermissionSnapshots();
  if (next) snapshots[id] = [...(ALL_PERMISSIONS as string[])].sort();
  else delete snapshots[id];
  await setSettingJson(USER_PERMISSION_SNAPSHOT_KEY, snapshots);
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
