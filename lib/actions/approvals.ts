"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import {
  APPROVAL_ENFORCE_KEY,
  APPROVAL_GROUP_LABEL,
  APPROVAL_GROUP_REASON,
  isEnforced,
  overThreshold,
  type ApprovalDecision,
  type ApprovalGroup,
} from "@/lib/constants/approval";

/**
 * ═══════ CỔNG PHÊ DUYỆT HAI BƯỚC ═══════
 *
 * Ba điều file này giữ, và cả ba đều là chỗ những cơ chế kiểu này thường hỏng:
 *
 *  1. **GHI NHẬN TRƯỚC, CƯỠNG CHẾ SAU.** Ngay cả khi nhóm chưa bật cưỡng chế, việc rủi ro vẫn được
 *     ghi lại kèm nhãn "chưa cần duyệt". Nếu chỉ ghi khi đã bật thì ngày bật lên, shop không có một
 *     dòng lịch sử nào để biết trước đó những việc này xảy ra bao nhiêu lần.
 *  2. **THIẾU NGƯỜI DUYỆT KHÔNG PHẢI LÀ ĐƯỢC DUYỆT.** Không có ai đủ tư cách gật thì việc DỪNG và
 *     nói rõ vì sao. Một cơ chế tự bỏ qua chính mình khi bất tiện sẽ im lặng đúng lúc bị lợi dụng.
 *  3. **NGƯỜI XIN KHÔNG TỰ DUYỆT** — chặn ở đây, và chặn thêm một lần nữa bằng ràng buộc CSDL.
 */

/** Ai được quyền gật một nhóm việc. Cố ý hẹp: duyệt là trách nhiệm, không phải tiện ích. */
function coTheDuyet(user: SessionUser): boolean {
  return can(user, "settings:manage") || user.role === "ADMIN" || user.role === "MANAGER";
}

async function docCauHinh(): Promise<unknown> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  return row?.value ?? null;
}

/** Có người nào KHÁC người xin đủ tư cách duyệt không. */
async function coNguoiDuyetKhac(requesterId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.users)
    .where(and(eq(schema.users.active, true), sql`${schema.users.id} <> ${requesterId}`, sql`${schema.users.role} in ('ADMIN','MANAGER')`));
  return Number(row?.n ?? 0) > 0;
}

export type GuardInput = {
  group: ApprovalGroup;
  action: string;
  summary: string;
  entity?: string;
  entityId?: string;
  /** Số tiền liên quan. `undefined` = chưa biết, và chưa biết thì coi như vượt ngưỡng. */
  amount?: number | null;
  payload?: unknown;
};

/**
 * Hỏi cổng: việc này làm luôn được, hay phải chờ người thứ hai?
 *
 * Gọi TRƯỚC khi ghi dữ liệu. Trả `PROCEED` thì cứ làm; trả hai mode còn lại thì dừng và trả thông
 * điệp cho người dùng.
 */
export async function guardSecondApproval(input: GuardInput): Promise<ApprovalDecision & { requestId?: string }> {
  const user = await requireUser();
  const db = await getDb();
  const enforce = isEnforced(await docCauHinh(), input.group);
  const vuotNguong = overThreshold(input.group, input.amount);

  // ── Chưa bật cưỡng chế, hoặc dưới ngưỡng: LÀM LUÔN nhưng vẫn để lại dấu vết ──
  //
  // Dấu vết này là thứ khiến ngày bật cưỡng chế lên không phải bắt đầu từ con số không: shop nhìn
  // được sáu tháng qua nhóm việc đó xảy ra bao nhiêu lần và do ai.
  if (!enforce || !vuotNguong) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: `approval.skip:${input.action}`,
      entity: input.entity ?? "APPROVAL",
      entityId: input.entityId ?? "",
      detail: {
        group: input.group,
        summary: input.summary,
        amount: input.amount ?? null,
        lyDo: !enforce ? "nhóm chưa bật cưỡng chế" : "dưới ngưỡng",
      },
    });
    return { mode: "PROCEED", recorded: true, group: input.group };
  }

  const reason = APPROVAL_GROUP_REASON[input.group];

  // ── Cần duyệt nhưng KHÔNG CÓ AI để duyệt ──
  if (!(await coNguoiDuyetKhac(user.id))) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: `approval.blocked:${input.action}`,
      entity: input.entity ?? "APPROVAL",
      entityId: input.entityId ?? "",
      detail: { group: input.group, summary: input.summary, lyDo: "không có người duyệt nào khác" },
    });
    return { mode: "BLOCKED_NO_APPROVER", group: input.group, reason };
  }

  const [req] = await db
    .insert(schema.approvalRequests)
    .values({
      group: input.group,
      action: input.action,
      entity: input.entity ?? "",
      entityId: input.entityId ?? "",
      amount: input.amount ?? null,
      summary: input.summary,
      payload: (input.payload ?? null) as never,
      requestedBy: user.id,
      requestedByEmail: user.email,
    })
    .returning({ id: schema.approvalRequests.id });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: `approval.request:${input.action}`,
    entity: "APPROVAL_REQUEST",
    entityId: req.id,
    detail: { group: input.group, summary: input.summary, amount: input.amount ?? null },
  });
  revalidatePath("/alerts");
  return { mode: "NEEDS_APPROVAL", group: input.group, reason, requestId: req.id };
}

export async function decideApproval(id: string, dong_y: boolean, note?: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!coTheDuyet(user)) return { error: "Không có quyền duyệt" };
  const db = await getDb();
  const a = schema.approvalRequests;
  const [req] = await db.select().from(a).where(eq(a.id, id));
  if (!req) return { error: "Không tìm thấy yêu cầu" };
  if (req.status !== "PENDING") return { error: `Yêu cầu đã ở trạng thái ${req.status}, không quyết lại được` };

  // LÝ DO TỒN TẠI CỦA CẢ CƠ CHẾ. Không có dòng này thì nó chỉ là một nút bấm thêm.
  if (req.requestedBy && req.requestedBy === user.id) return { error: "Người xin không được tự duyệt việc của mình" };
  if (!dong_y && !note?.trim()) return { error: "Từ chối phải nêu lý do — người xin cần biết vì sao" };

  await db
    .update(a)
    .set({ status: dong_y ? "APPROVED" : "REJECTED", decidedBy: user.id, decidedByEmail: user.email, decidedAt: new Date(), note: note?.trim() || null })
    .where(eq(a.id, id));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: dong_y ? "approval.approve" : "approval.reject",
    entity: "APPROVAL_REQUEST",
    entityId: id,
    detail: { group: req.group, summary: req.summary, requestedBy: req.requestedByEmail, note: note ?? null },
  });
  revalidatePath("/alerts");
  return { ok: true };
}

export type PendingApproval = {
  id: string;
  group: ApprovalGroup;
  groupLabel: string;
  summary: string;
  amount: number | null;
  requestedByEmail: string;
  requestedAt: Date;
  /** Người đang xem có được duyệt việc này không — người xin thì KHÔNG. */
  canDecide: boolean;
};

export async function listPendingApprovals(limit = 50): Promise<PendingApproval[]> {
  const user = await requireUser();
  const db = await getDb();
  const a = schema.approvalRequests;
  const rows = await db.select().from(a).where(eq(a.status, "PENDING")).orderBy(desc(a.requestedAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    group: r.group as ApprovalGroup,
    groupLabel: APPROVAL_GROUP_LABEL[r.group as ApprovalGroup] ?? r.group,
    summary: r.summary,
    amount: r.amount ?? null,
    requestedByEmail: r.requestedByEmail,
    requestedAt: r.requestedAt,
    canDecide: coTheDuyet(user) && r.requestedBy !== user.id,
  }));
}
