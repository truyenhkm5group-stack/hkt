"use server";

import { revalidatePath } from "next/cache";
import { ORG_DEPENDENT_PATHS } from "@/lib/constants/org-surfaces";
import { z } from "zod";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { impactOfLeaving, type LeavingImpact } from "@/lib/org/impact";
import {
  assignMembership,
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
  for (const p of ORG_DEPENDENT_PATHS) revalidatePath(p);
  // Bố cục cũng đọc sự thật tổ chức (menu, chuông, nhãn phòng ban), nên phải làm mới cả nó.
  revalidatePath("/", "layout");
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

/**
 * Người này đang cầm bao nhiêu việc, bao nhiêu tiền, ở phòng nào — hỏi TRƯỚC khi gỡ hay chuyển.
 *
 * Chỉ đọc, và CỐ Ý chỉ đọc. Không hàm nào trong tệp này giao lại việc hàng loạt khi đổi phòng
 * ban: một lượt giao lại tự động là hàng chục việc đổi chủ trong một nhịp mà không ai kịp nhìn,
 * và không gỡ lại được vì trạng thái cũ đã bị ghi đè ở từng miền nguồn. Xem trước → người bấm
 * quyết định → giao lại từng việc bằng công cụ đã có ở `/work/today`.
 */
export async function leavingImpact(userId: string): Promise<Result<{ impact: LeavingImpact }>> {
  const { error } = await authorize();
  if (error) return { error };
  const parsed = idSchema.safeParse(userId);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, parsed.data), columns: { id: true, name: true, email: true } });
  if (!u) return { error: "Không tìm thấy người dùng" };
  return { ok: true, impact: await impactOfLeaving(u) };
}
