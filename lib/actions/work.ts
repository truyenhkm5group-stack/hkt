"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { DEPARTMENT_CODES } from "@/lib/constants/departments";
import { WORK_PRIORITIES, WORK_STATUSES } from "@/lib/constants/work";
import * as svc from "@/lib/work/service";

/**
 * ═══════════ SERVER ACTION CỦA LỚP CÔNG VIỆC ═══════════
 *
 * Theo đúng lối `lib/actions/cs.ts`: kiểm quyền → zod → gọi service → `audit()` → `revalidatePath`.
 * Toàn bộ LUẬT nằm ở `lib/work/service.ts` để kiểm thử gọi được mà không cần phiên đăng nhập.
 *
 * KHÔNG có action nào ở đây ghi vào bảng nghiệp vụ. Nút "Hoàn thành" của một case CSKH trên hàng
 * đợi gọi `csQuickAction` của `lib/actions/cs.ts` — cùng kiểm quyền, cùng `audit()`, cùng lịch sử
 * case. Đó là điều kiện để hàng đợi không trở thành một đường ghi thứ hai không ai giám sát.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

function revalidate() {
  for (const p of ["/work", "/work/department", "/work/all", "/work/performance", "/"]) revalidatePath(p);
}

function actorOf(user: SessionUser): svc.WorkActor {
  return { id: user.id, email: user.email, name: user.name, source: "UI" };
}

async function authorize(permission: "work:manage" | "work:assign" | "work:admin" | "review:manage" | "okr:manage") {
  const user = await requireUser();
  const labels = {
    "work:manage": "xử lý công việc",
    "work:assign": "giao việc cho người khác",
    "work:admin": "cấu hình phòng ban / việc định kỳ",
    "review:manage": "lập và chốt kỳ review",
    "okr:manage": "đặt và chấm mục tiêu",
  };
  return { user, error: can(user, permission) ? null : `Bạn không có quyền ${labels[permission]}` };
}

const keySchema = z.string().trim().min(3).max(300);

/* ═══════════════════ GIAO VIỆC / NHẬN VIỆC ═══════════════════ */

export async function claimWork(key: string): Promise<Result> {
  const { user, error } = await authorize("work:manage");
  if (error) return { error };
  const parsed = keySchema.safeParse(key);
  if (!parsed.success) return { error: "Khoá việc không hợp lệ" };
  const r = await svc.assignWork(parsed.data, user.id, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_CLAIM", entity: "WORK_ITEM", entityId: parsed.data, detail: {} });
  revalidate();
  return { ok: true };
}

export async function assignWork(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, assigneeId: z.string().trim().min(1).nullable() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await svc.assignWork(parsed.data.key, parsed.data.assigneeId, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_ASSIGN", entity: "WORK_ITEM", entityId: parsed.data.key, detail: { assigneeId: parsed.data.assigneeId } });
  revalidate();
  return { ok: true };
}

/* ═══════════════════ TRẠNG THÁI / GHI CHÚ / HOÃN / HẠN / ƯU TIÊN / CHẶN ═══════════════════ */

export async function setWorkStatus(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:manage");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, status: z.enum(WORK_STATUSES), blockedReason: z.string().trim().max(500).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await svc.setWorkStatus(parsed.data.key, parsed.data.status, actorOf(user), { blockedReason: parsed.data.blockedReason });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_STATUS", entity: "WORK_ITEM", entityId: parsed.data.key, detail: { status: parsed.data.status } });
  revalidate();
  return { ok: true };
}

export async function addWorkNote(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:manage");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, note: z.string().trim().min(1).max(2000) }).safeParse(input);
  if (!parsed.success) return { error: "Ghi chú không hợp lệ" };
  const r = await svc.addWorkNote(parsed.data.key, parsed.data.note, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return { ok: true };
}

export async function snoozeWork(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:manage");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, until: z.string().datetime().nullable() }).safeParse(input);
  if (!parsed.success) return { error: "Giờ hẹn không hợp lệ" };
  const r = await svc.snoozeWork(parsed.data.key, parsed.data.until ? new Date(parsed.data.until) : null, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return { ok: true };
}

export async function setWorkDue(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, dueAt: z.string().datetime().nullable() }).safeParse(input);
  if (!parsed.success) return { error: "Hạn không hợp lệ" };
  const r = await svc.setWorkDue(parsed.data.key, parsed.data.dueAt ? new Date(parsed.data.dueAt) : null, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return { ok: true };
}

export async function setWorkPriority(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, priority: z.enum(WORK_PRIORITIES).nullable() }).safeParse(input);
  if (!parsed.success) return { error: "Mức ưu tiên không hợp lệ" };
  const r = await svc.setWorkPriority(parsed.data.key, parsed.data.priority, actorOf(user));
  if ("error" in r) return r;
  revalidate();
  return { ok: true };
}

export async function blockWork(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:manage");
  if (error) return { error };
  const parsed = z.object({ key: keySchema, reason: z.string().trim().max(500) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await svc.blockWork(parsed.data.key, parsed.data.reason, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_BLOCK", entity: "WORK_ITEM", entityId: parsed.data.key, detail: { reason: parsed.data.reason } });
  revalidate();
  return { ok: true };
}

/* ═══════════════════ VIỆC TAY ═══════════════════ */

const manualSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(2).max(300),
  summary: z.string().trim().max(4000).optional(),
  department: z.enum(DEPARTMENT_CODES),
  assigneeId: z.string().trim().min(1).nullable().optional(),
  ownerId: z.string().trim().min(1).nullable().optional(),
  priority: z.enum(WORK_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().trim().max(40)).max(10).optional(),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300), done: z.boolean() })).max(30).optional(),
  businessEntity: z.string().trim().max(40).optional(),
  businessEntityId: z.string().trim().max(100).optional(),
  moneyAtRisk: z.number().int().nonnegative().nullable().optional(),
  moneyBasis: z.string().trim().max(300).optional(),
});

export async function saveManualTask(input: unknown): Promise<Result<{ id: string; key: string }>> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const r = await svc.saveManualTask({ ...d, dueAt: d.dueAt ? new Date(d.dueAt) : null }, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: d.id ? "WORK_TASK_UPDATE" : "WORK_TASK_CREATE", entity: "WORK_ITEM", entityId: r.id, detail: { title: d.title, department: d.department } });
  revalidate();
  return r;
}

export async function deleteManualTask(id: string): Promise<Result> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const r = await svc.deleteManualTask(id, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_TASK_DELETE", entity: "WORK_ITEM", entityId: id, detail: {} });
  revalidate();
  return { ok: true };
}

/* ═══════════════════ VIỆC ĐỊNH KỲ ═══════════════════ */

const recurrenceSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(4000).optional(),
  department: z.enum(DEPARTMENT_CODES),
  assigneeId: z.string().trim().min(1).nullable().optional(),
  ownerId: z.string().trim().min(1).nullable().optional(),
  priority: z.enum(WORK_PRIORITIES).optional(),
  cadence: z.enum(svc.CADENCES),
  cadenceDay: z.number().int().min(1).max(28).nullable().optional(),
  hourOfDay: z.number().int().min(0).max(23).optional(),
  dueInHours: z.number().int().min(1).max(24 * 30).optional(),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300), done: z.boolean() })).max(30).optional(),
  active: z.boolean().optional(),
});

export async function saveRecurrence(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const parsed = recurrenceSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await svc.saveRecurrence(parsed.data, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_RECURRENCE_SAVE", entity: "WORK_RECURRENCE", entityId: r.id, detail: { title: parsed.data.title, cadence: parsed.data.cadence } });
  revalidate();
  return r;
}

export async function deleteRecurrence(id: string): Promise<Result> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const r = await svc.deleteRecurrence(id);
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_RECURRENCE_DELETE", entity: "WORK_RECURRENCE", entityId: id, detail: {} });
  revalidate();
  return { ok: true };
}

/** Sinh việc của kỳ hiện tại ngay bây giờ. Chạy lại nhiều lần không nhân đôi. */
export async function runRecurrenceNow(): Promise<Result<{ created: number; skipped: number }>> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const r = await svc.generateRecurringTasks(new Date(), { ...actorOf(user), source: "RECURRENCE" });
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_RECURRENCE_RUN", entity: "WORK_RECURRENCE", entityId: "", detail: r });
  revalidate();
  return { ok: true, ...r };
}

/* ═══════════════════ PHÒNG BAN ═══════════════════ */

export async function saveDepartment(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const parsed = z
    .object({
      id: z.string().optional(),
      code: z.string().trim().min(2).max(30),
      name: z.string().trim().min(2).max(100),
      description: z.string().trim().max(500).optional(),
      leadUserId: z.string().trim().min(1).nullable().optional(),
      sortOrder: z.number().int().min(0).max(999).optional(),
      active: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await svc.saveDepartment(parsed.data);
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "DEPARTMENT_SAVE", entity: "DEPARTMENT", entityId: r.id, detail: { code: parsed.data.code, name: parsed.data.name } });
  revalidate();
  return r;
}

export async function setDepartmentMember(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const parsed = z.object({ departmentId: z.string().min(1), userId: z.string().min(1), roleInDept: z.enum(["LEAD", "MEMBER"]), title: z.string().trim().max(100).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await svc.setDepartmentMember(parsed.data.departmentId, parsed.data.userId, parsed.data.roleInDept, parsed.data.title ?? "");
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "DEPARTMENT_MEMBER_SET", entity: "DEPARTMENT", entityId: parsed.data.departmentId, detail: { userId: parsed.data.userId, roleInDept: parsed.data.roleInDept } });
  revalidate();
  return { ok: true };
}

export async function removeDepartmentMember(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const parsed = z.object({ departmentId: z.string().min(1), userId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await svc.removeDepartmentMember(parsed.data.departmentId, parsed.data.userId);
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "DEPARTMENT_MEMBER_REMOVE", entity: "DEPARTMENT", entityId: parsed.data.departmentId, detail: { userId: parsed.data.userId } });
  revalidate();
  return { ok: true };
}

/** Lịch sử một việc — đọc cho ngăn kéo chi tiết. */
export async function workHistory(key: string): Promise<Result<{ events: { id: string; action: string; note: string; actor: string; at: string; previousStatus: string | null; nextStatus: string | null }[] }>> {
  const user = await requireUser();
  if (!can(user, "work:view")) return { error: "Bạn không có quyền xem công việc" };
  const events = await svc.listWorkEvents(key);
  return {
    ok: true,
    events: events.map((e) => ({ id: e.id, action: e.action, note: e.note, actor: e.actorName || e.actorEmail, at: e.createdAt.toISOString(), previousStatus: e.previousStatus, nextStatus: e.nextStatus })),
  };
}
