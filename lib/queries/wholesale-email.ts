import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { NAME } from "@/lib/queries/wholesale";
import { EMAIL_OUTBOX_STATUSES, type EmailOutboxStatus } from "@/lib/wholesale/email-constants";
import { isMissingEmailTable } from "@/lib/wholesale/email-store";

/**
 * ═══════════ HỘP THƯ ĐI BÁN SỈ — TRUY VẤN CHỈ ĐỌC (E1) ═══════════
 *
 * Phạm vi dữ liệu đi theo LEAD (`WHOLESALE_LEADS`): người chỉ thấy lead được giao thì chỉ thấy thư tới lead đó. Bảng chưa có
 * (CSDL chưa áp 0264) ⇒ `{ unavailable: true }`, trang in câu báo thay vì sập.
 */

const o = schema.wholesaleEmailOutbox;
const l = schema.wholesaleLeads;
const ps = schema.wholesalePlaceSnapshots;

export type OutboxRow = {
  id: string;
  leadId: string;
  leadName: string | null;
  assignee: string | null;
  toEmail: string;
  subject: string;
  bodyText: string;
  templateKey: string;
  sequenceStep: number;
  status: EmailOutboxStatus;
  blockedReason: string | null;
  lastError: string | null;
  preparedBy: string;
  aiModel: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  mode: string | null;
  provider: string | null;
  providerMessageId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

export const OUTBOX_VIEWS = ["open", "sent", "problem", "closed"] as const;
export type OutboxView = (typeof OUTBOX_VIEWS)[number];
export const OUTBOX_VIEW_STATUSES: Record<OutboxView, readonly EmailOutboxStatus[]> = {
  open: ["DRAFT", "APPROVED", "QUEUED", "SENDING"],
  sent: ["SENT"],
  problem: ["BLOCKED", "FAILED"],
  closed: ["CANCELLED"],
};
export const OUTBOX_VIEW_LABEL: Record<OutboxView, string> = { open: "Đang chờ", sent: "Đã gửi", problem: "Bị chặn / lỗi", closed: "Đã huỷ" };

export async function listOutbox(decision: ScopeDecision, view: OutboxView): Promise<OutboxRow[] | { unavailable: true }> {
  try {
    const db = await getDb();
    const approver = sql<string | null>`(select ${schema.users.name} from ${schema.users} where ${schema.users.id} = ${o.approvedByUserId})`;
    const rows = await db
      .select({
        id: o.id,
        leadId: o.leadId,
        leadName: NAME,
        assignee: l.assignedToName,
        toEmail: o.toEmail,
        subject: o.subject,
        bodyText: o.bodyText,
        templateKey: o.templateKey,
        sequenceStep: o.sequenceStep,
        status: o.status,
        blockedReason: o.blockedReason,
        lastError: o.lastError,
        preparedBy: o.preparedBy,
        aiModel: o.aiModel,
        approvedBy: approver,
        approvedAt: o.approvedAt,
        mode: o.mode,
        provider: o.provider,
        providerMessageId: o.providerMessageId,
        attempts: o.attempts,
        nextAttemptAt: o.nextAttemptAt,
        sentAt: o.sentAt,
        createdAt: o.createdAt,
      })
      .from(o)
      .innerJoin(l, eq(l.id, o.leadId))
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(andScope(inArray(o.status, [...OUTBOX_VIEW_STATUSES[view]]), decision))
      .orderBy(desc(sql`coalesce(${o.sentAt}, ${o.updatedAt})`))
      .limit(200);
    return rows.map((r) => ({
      ...r,
      status: (EMAIL_OUTBOX_STATUSES as readonly string[]).includes(r.status) ? (r.status as EmailOutboxStatus) : "DRAFT",
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      nextAttemptAt: r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null,
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (e) {
    if (isMissingEmailTable(e)) return { unavailable: true };
    throw e;
  }
}

/** Số thư theo nhóm xem — cho nhãn tab. */
export async function outboxCounts(decision: ScopeDecision): Promise<Record<OutboxView, number> | null> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ status: o.status, n: count() })
      .from(o)
      .innerJoin(l, eq(l.id, o.leadId))
      .where(andScope(undefined, decision))
      .groupBy(o.status);
    const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
    const sum = (v: OutboxView) => OUTBOX_VIEW_STATUSES[v].reduce((a, s) => a + (by.get(s) ?? 0), 0);
    return { open: sum("open"), sent: sum("sent"), problem: sum("problem"), closed: sum("closed") };
  } catch (e) {
    if (isMissingEmailTable(e)) return null;
    throw e;
  }
}

/** Lời chào kênh EMAIL đang mở ở hàng đợi liên hệ — nguồn để đưa vào hộp thư đi. */
export async function emailOutreachCandidates(decision: ScopeDecision): Promise<{ id: string; leadId: string; leadName: string | null; email: string | null; preparedBy: string; message: string }[]> {
  const db = await getDb();
  const it = schema.wholesaleOutreachItems;
  return db
    .select({ id: it.id, leadId: it.leadId, leadName: NAME, email: l.email, preparedBy: it.preparedBy, message: it.message })
    .from(it)
    .innerJoin(l, eq(l.id, it.leadId))
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(andScope(and(eq(it.channel, "EMAIL"), inArray(it.status, ["DRAFT", "APPROVED"])), decision))
    .orderBy(desc(it.createdAt))
    .limit(100);
}

/** Chiến dịch săn khách (mới nhất trước) — cho ô chọn của nút dừng theo chiến dịch. */
export async function campaignOptions(): Promise<{ id: string; name: string }[]> {
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  return db.select({ id: c.id, name: c.name }).from(c).orderBy(desc(c.createdAt)).limit(100);
}
