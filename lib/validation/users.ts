import { z } from "zod";
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { ROLE_ORDER } from "@/lib/constants/roles";

const name = z.string().trim().min(2, "Tên tối thiểu 2 ký tự").max(100, "Tên tối đa 100 ký tự");
const password = z.string().min(8, "Mật khẩu tối thiểu 8 ký tự").max(100, "Mật khẩu tối đa 100 ký tự");
const role = z.enum(ROLE_ORDER, { error: "Chọn vai trò" });

export const createUserSchema = z.object({
  name,
  email: z.email("Email không hợp lệ").trim().toLowerCase().max(200),
  password,
  role,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  id: z.string().min(1),
  name,
  role,
  active: z.boolean(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  id: z.string().min(1),
  password,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const setUserActiveSchema = z.object({
  id: z.string().min(1),
  active: z.boolean(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Nhập mật khẩu hiện tại"),
    newPassword: password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "Mật khẩu nhập lại không khớp" })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ["newPassword"], message: "Mật khẩu mới phải khác mật khẩu hiện tại" });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

const permissionList = z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(100);

/** Quyền tuỳ chỉnh của một người dùng; null = dùng mẫu quyền của vai trò */
export const userPermissionsSchema = z.object({
  id: z.string().min(1),
  permissions: permissionList.nullable(),
});
export type UserPermissionsInput = z.infer<typeof userPermissionsSchema>;

/** Mẫu quyền của các vai trò (không gồm ADMIN) */
export const rolePermissionsSchema = z.record(z.enum(ROLE_ORDER.filter((r) => r !== "ADMIN") as [string, ...string[]]), permissionList);
export type RolePermissionsInput = z.infer<typeof rolePermissionsSchema>;
