"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { createSession, requireUser, type SessionUser } from "@/lib/auth/session";
import { salesStaffRoleOf, SHELL_ROLE_REJECTED, shellRoleChoiceOk } from "@/lib/constants/roles";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";
import { listAccessRoles } from "@/lib/queries/access";
import { landingAfterSignIn } from "@/lib/saas/shell-landing";
import { hostBrand } from "@/lib/platform/host-brand";
import { withBrandHint } from "@/lib/platform/site-host";
import { acceptUserInviteCore, createUserInviteCore, revokeUserInviteCore } from "@/lib/users/invites";

/**
 * ═══════════ SERVER ACTION CỦA LỜI MỜI NGƯỜI DÙNG ═══════════
 *
 * Mọi quyết định ở lõi `lib/users/invites.ts`; tệp này chỉ làm việc của Next: đọc phiên (tạo / thu hồi), đọc IP phần
 * Caddy ghi (`clientIpFrom`), ghi cookie phiên sau khi nhận lời mời, làm mới màn hình, chuyển trang. Lỗi nghiệp vụ trả
 * `{ error }`, không ném. Không tệp nào ở đây tự chọn CSDL: tạo / thu hồi chạy trên tổ chức của PHIÊN; nhận lời mời thì
 * lõi tự bọc ngữ cảnh tổ chức TƯỜNG MINH theo mã trong đường dẫn.
 */

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

export async function createUserInviteAction(input: unknown): Promise<{ ok: true; id: string; link: string; expiresAt: string; email: string } | { error: string }> {
  const user = await requireUser();
  const shellError = await shellRoleError(user, { role: pick(input, "role"), accessRoleCode: pick(input, "accessRoleCode") });
  if (shellError) return { error: shellError };
  const r = await createUserInviteCore(user, input);
  if ("error" in r) return r;
  revalidatePath("/settings/users");
  return { ok: true, id: r.id, link: r.link, expiresAt: r.expiresAt.toISOString(), email: r.email };
}

export async function revokeUserInviteAction(id: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const r = await revokeUserInviteCore(user, String(id ?? ""));
  if ("error" in r) return r;
  revalidatePath("/settings/users");
  return { ok: true };
}

/**
 * Người được mời (CHƯA có tài khoản) nhận lời mời ở `/join/<tổ chức>/<mã>`. Thành công ⇒ phiên của tài khoản mới
 * (đúng `verifyLogin` của màn đăng nhập) rồi vào `/`.
 */
export async function acceptUserInviteAction(org: string, token: string, input: unknown): Promise<{ error: string }> {
  const ip = clientIpFrom((await headers()).get("x-forwarded-for"));
  const r = await acceptUserInviteCore(String(org ?? ""), String(token ?? ""), input, { ip, issue: createSession });
  if ("error" in r) return { error: r.error };
  // Đích cuối một bước (lib/saas/shell-landing.ts, F-01): người thuộc vỏ Chốt Đơn vào thẳng trang nhà của vỏ thay vì `/` mà
  // layout chuyển hướng (trang trắng). Không thuộc vỏ ⇒ `/` như cũ.
  redirect(r.loggedIn ? await landingAfterSignIn("/") : withBrandHint("/login", await hostBrand()));
}
