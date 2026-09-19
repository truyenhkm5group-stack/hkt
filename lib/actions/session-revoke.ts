"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { applySessionRevocation } from "@/lib/auth/session-revoke";
import { can, destroySession, requireUser } from "@/lib/auth/session";
import { revokeSessionsSchema } from "@/lib/validation/session-revoke";

export type RevokeActionResult = { ok: true } | { error: string };

/**
 * ═══════════ "ĐĂNG XUẤT" VÀ "ĐĂNG XUẤT MỌI THIẾT BỊ" LÀ HAI VIỆC KHÁC NHAU ═══════════
 *
 * Đăng xuất thường (`logoutAction`) chỉ XOÁ COOKIE trên máy đang dùng — máy khác không hề hay
 * biết, và đó đúng là điều người dùng muốn khi họ rời khỏi một máy mượn.
 *
 * Hàm này thì ngược lại: nó đẩy mốc `session_invalid_before` lên, nên MỌI token đã cấp trước đó
 * đều chết, kể cả token đang cầm. Thiết bị hiện tại CŨNG bị đăng xuất — cố ý: "mọi token cũ" mà
 * chừa lại đúng cái đang dùng thì không còn là một câu nói được nữa, và khe hở ấy là chỗ mà một
 * phiên vừa bị thu hồi lại được cấp phép lại.
 */
export async function logoutAllDevices(): Promise<never> {
  const user = await requireUser();
  await applySessionRevocation({
    targetUserId: user.id,
    targetEmail: user.email,
    trigger: "SELF_LOGOUT_ALL",
    actor: { id: user.id, label: user.email },
  });
  // Xoá cookie ngay: không đợi lượt dựng sau. Nếu không, người dùng thấy một lượt chuyển hướng
  // qua `?reason=revoked` — đúng về kỹ thuật, nhưng đọc lên như thể họ vừa bị ai đó đá ra.
  await destroySession();
  redirect("/login");
}

/**
 * Quản trị thu hồi mọi phiên của một người khác.
 *
 * KHÔNG khoá tài khoản, KHÔNG đổi mật khẩu, KHÔNG đổi quyền — chỉ bắt người đó đăng nhập lại.
 * Đây là công cụ cho tình huống "máy bị mất, tài khoản vẫn tốt".
 */
export async function revokeSessionsOfUser(input: unknown): Promise<RevokeActionResult> {
  const user = await requireUser();
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = revokeSessionsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, reason } = parsed.data;

  const db = await getDb();
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, email: true } });
  if (!target) return { error: "Không tìm thấy người dùng" };

  await applySessionRevocation({
    targetUserId: target.id,
    targetEmail: target.email,
    trigger: "ADMIN_REVOKE",
    reason,
    actor: { id: user.id, label: user.email },
  });
  revalidatePath("/settings/users");
  return { ok: true };
}
