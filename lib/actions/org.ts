"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import {
  assignMembership,
  impactOfLeaving,
  removeMembership,
  setDepartmentLead,
  transferMembership,
  type MembershipActor,
} from "@/lib/org/membership";

/**
 * ═══════════ SERVER ACTION CỦA SỰ THẬT TỔ CHỨC ═══════════
 *
 * HAI màn hình gọi chung đúng bộ hàm này: Cấu hình công việc (`/work/settings`) và Người dùng
 * (`/settings/users`). Trước đây chỉ màn đầu có đường ghi, còn màn thứ hai không có gì cả — nên
 * "gán phòng ban cho một người" là việc chỉ làm được từ một phía, và nếu phía đó hỏng thì không
 * còn lối nào.
 *
 * ─── QUYỀN: `users:manage` HOẶC `work:admin` ───
 *
 * Sự thật tổ chức thuộc về cả hai vai: quản trị tài khoản và quản trị bàn làm việc. Bắt buộc phải
 * có CẢ HAI thì trang Người dùng vô dụng với người chỉ quản trị nhân sự; bắt đúng một thì phía kia
 * mất đường. Nên: một trong hai là đủ, và mỗi lượt ghi đều ghi rõ ai bấm.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

function revalidate() {
  for (const p of ["/work", "/work/today", "/work/department", "/work/all", "/work/performance", "/work/settings", "/settings/users", "/"]) revalidatePath(p);
}

function actorOf(u: SessionUser): MembershipActor {
  return { id: u.id, email: u.email };
}

async function authorize() {
  const user = await requireUser();
  const ok = can(user, "users:manage") || can(user, "work:admin");
  return { user, error: ok ? null : "Bạn không có quyền sửa phòng ban của người dùng" };
}

const idSchema = z.string().trim().min(1).max(80);

export async function assignUserToDepartment(input: unknown): Promise<Result<{ changed: boolean }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ departmentId: idSchema, userId: idSchema, roleInDept: z.enum(["LEAD", "MEMBER"]).optional(), title: z.string().max(100).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await assignMembership(parsed.data, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return r;
}

export async function removeUserFromDepartment(input: unknown): Promise<Result<{ leadCleared: boolean }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ departmentId: idSchema, userId: idSchema }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await removeMembership(parsed.data, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return r;
}

export async function setLead(input: unknown): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ departmentId: idSchema, userId: idSchema.nullable() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await setDepartmentLead(parsed.data, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return { ok: true };
}

export async function transferUserDepartment(input: unknown): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ fromDepartmentId: idSchema, toDepartmentId: idSchema, userId: idSchema, roleInDept: z.enum(["LEAD", "MEMBER"]).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await transferMembership(parsed.data, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return { ok: true };
}

/*
  Báo cáo lệch KHÔNG có Server Action: trang Cấu hình gọi thẳng `membershipDrift()` ở phía máy chủ
  khi dựng trang. Bọc thêm một action chỉ-đọc mà không nút nào bấm là thêm một bề mặt để bảo trì
  và một đường vào để canh quyền, đổi lấy đúng con số không.
*/

/** Bao nhiêu việc người này đang cầm — hỏi TRƯỚC khi cho rời phòng. Chỉ đọc. */
export async function leavingImpact(userId: string): Promise<Result<{ holding: number }>> {
  const { error } = await authorize();
  if (error) return { error };
  const parsed = idSchema.safeParse(userId);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await impactOfLeaving(parsed.data);
  return { ok: true, holding: r.holding };
}
