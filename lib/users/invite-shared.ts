/**
 * ═══════════ LỜI MỜI NGƯỜI DÙNG — PHẦN THUẦN, CLIENT-SAFE ═══════════
 *
 * Hộp thoại «Mời người dùng» (`/settings/users`), form nhận lời mời (`/join/<tổ chức>/<mã>`) và lõi máy chủ
 * (`lib/users/invites.ts`) dùng CÙNG lược đồ ở đây, để "trình duyệt nói hợp lệ" và "máy chủ nói hợp lệ" không bao giờ
 * là hai luật. Tệp này không đọc CSDL, không đọc biến môi trường. Máy chủ vẫn kiểm LẠI mọi thứ.
 */
import { z } from "zod";
import type { Role } from "@/db/schema";
import { ROLE_ORDER } from "@/lib/constants/roles";
import { ADMIN_PASSWORD_MIN } from "@/lib/onboarding/shared";

/** Hạn của một lời mời. Hết hạn ⇒ quản trị tạo lời mời mới; không có nút "gia hạn" (mã cũ đã rời tay họ). */
export const USER_INVITE_TTL_DAYS = 7;

/**
 * MỘT câu cho mọi lý do một liên kết không dùng được: tổ chức không có / không hoạt động, mã sai, hết hạn, đã dùng, đã
 * thu hồi. Nói riêng từng lý do là dựng một máy dò: "tổ chức này có thật", "mã này từng đúng".
 */
export const USER_INVITE_INVALID = "Liên kết mời không dùng được — có thể đã hết hạn, đã được dùng hoặc đã bị thu hồi. Xin người mời gửi một liên kết mới.";

/** Chặn dò: quá nhiều liên kết sai từ một máy. Câu này không nói gì về tổ chức hay lời mời nào. */
export const USER_INVITE_THROTTLED = "Quá nhiều lượt thử từ máy này — thử lại sau ít phút.";

export type UserInviteStatus = "ACTIVE" | "ACCEPTED" | "EXPIRED" | "REVOKED";

export const USER_INVITE_STATUS_LABEL: Record<UserInviteStatus, string> = { ACTIVE: "Còn hạn", ACCEPTED: "Đã nhận", EXPIRED: "Hết hạn", REVOKED: "Đã thu hồi" };

/** Trạng thái của một lời mời, thứ tự ưu tiên: thu hồi → đã nhận → hết hạn → còn hạn. */
export function userInviteStatus(row: { acceptedAt: Date | string | null; revokedAt: Date | string | null; expiresAt: Date | string }, now: Date = new Date()): UserInviteStatus {
  if (row.revokedAt) return "REVOKED";
  if (row.acceptedAt) return "ACCEPTED";
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

const email = z.string().trim().toLowerCase().max(200, "Email quá dài").pipe(z.email("Email không hợp lệ"));

/**
 * Tạo lời mời: ĐÚNG MỘT trong hai — vai trò hệ thống (`role`) hoặc mã vai trò tuỳ chỉnh (`accessRoleCode`). Vai trò tuỳ
 * chỉnh mang vai trò hệ thống nền của nó; máy chủ đọc nền ấy từ `access_roles`, không nhận từ client.
 */
export const createUserInviteSchema = z
  .object({
    email,
    role: z.enum(ROLE_ORDER, { error: "Chọn vai trò" }).nullish(),
    accessRoleCode: z.string().trim().min(1).max(64).nullish(),
  })
  .refine((v) => Boolean(v.role) !== Boolean(v.accessRoleCode), { path: ["role"], message: "Chọn đúng một vai trò" });
export type CreateUserInviteInput = z.infer<typeof createUserInviteSchema>;

/** Form nhận lời mời. Mật khẩu cùng trần với quản trị đầu tiên của `/start` (`ADMIN_PASSWORD_MIN`). */
export const acceptUserInviteSchema = z
  .object({
    name: z.string().trim().min(2, "Tên tối thiểu 2 ký tự").max(100, "Tên tối đa 100 ký tự"),
    password: z.string().min(ADMIN_PASSWORD_MIN, `Mật khẩu ít nhất ${ADMIN_PASSWORD_MIN} ký tự`).max(200, "Mật khẩu quá dài"),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "Mật khẩu nhập lại không khớp" });
export type AcceptUserInviteInput = z.infer<typeof acceptUserInviteSchema>;

// ─── Ô chọn vai trò của hộp thoại: một giá trị cho hai loại vai trò ───

/** `role:ADMIN` · `access:KHO_CHINH`. */
export type InviteRoleChoice = `role:${Role}` | `access:${string}`;

export function inviteChoiceToInput(choice: string): { role: Role } | { accessRoleCode: string } | null {
  if (choice.startsWith("role:")) {
    const role = choice.slice(5) as Role;
    return ROLE_ORDER.includes(role) ? { role } : null;
  }
  if (choice.startsWith("access:") && choice.length > 7) return { accessRoleCode: choice.slice(7) };
  return null;
}
