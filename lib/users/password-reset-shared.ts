/**
 * ═══════════ LIÊN KẾT ĐẶT LẠI MẬT KHẨU — PHẦN THUẦN, CLIENT-SAFE ═══════════
 *
 * Form `/reset/<tổ chức>/<mã>` và lõi máy chủ (`lib/users/password-reset.ts`) dùng CÙNG lược đồ ở đây, để "trình duyệt
 * nói hợp lệ" và "máy chủ nói hợp lệ" không là hai luật. Không đọc CSDL, không đọc biến môi trường.
 */
import { z } from "zod";
import { ADMIN_PASSWORD_MIN } from "@/lib/onboarding/shared";

export const PASSWORD_RESET_TTL_HOURS = 24;
export const PASSWORD_RESET_PATH = "/reset";

/** MỘT câu cho mọi lý do liên kết không dùng được — nói riêng từng lý do là dựng một máy dò. */
export const PASSWORD_RESET_INVALID = "Liên kết đặt lại mật khẩu không dùng được — có thể đã hết hạn, đã dùng, hoặc đã có liên kết mới hơn. Xin người quản trị tạo liên kết mới.";
export const PASSWORD_RESET_THROTTLED = "Thử quá nhiều lần — đợi 15 phút rồi mở lại liên kết.";

export const completeResetSchema = z
  .object({
    password: z.string().min(ADMIN_PASSWORD_MIN, `Mật khẩu ít nhất ${ADMIN_PASSWORD_MIN} ký tự`).max(200, "Mật khẩu quá dài"),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "Mật khẩu nhập lại không khớp" });
