import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { NAME, PHONE } from "@/lib/queries/wholesale";
import { EMAIL_BLOCK_REASON_LABEL, EMAIL_BLOCK_REASONS, type EmailBlockReason } from "@/lib/wholesale/email-constants";
import { ACTIVITY_KIND_LABEL } from "@/lib/wholesale/constants";
import { maskContact, maskInlineContacts, runProgress, shortText, type RunProgress } from "@/lib/wholesale/run-progress";

/**
 * ═══════════ TIẾN ĐỘ HÔM NAY + NHẬT KÝ HOẠT ĐỘNG — CHỈ ĐỌC ═══════════
 *
 * Phục vụ bố cục mới của trang Săn khách và tab Liên hệ (chủ shop 30/10/2026). KHÔNG bảng mới, KHÔNG đổi luật: chỉ đếm lại
 * thứ đã ghi ở `wholesale_outreach_items`, `wholesale_email_outbox`, `wholesale_email_events`, `wholesale_lead_activities`,
 * qua đúng phạm vi dữ liệu của lead (`andScope`) như các danh sách hiện có.
 *
 * «Lượt» = HÔM NAY theo giờ Việt Nam. SĐT / email trong nhật ký luôn đi qua `maskContact` TRƯỚC khi rời máy chủ — chuỗi đầy
 * đủ không bao giờ có mặt trong dữ liệu gửi xuống trình duyệt của khối nhật ký.
 */

const l = schema.wholesaleLeads;
const ps = schema.wholesalePlaceSnapshots;

function todayStart(now: Date): Date {
  return vnStartOfDay(vnDateKey(now));
}

export type RunStats = RunProgress & {
  /** Chế độ của lượt (hộp thư đi): DRY_RUN ⇒ ô «thành công» đọc là «chạy thử». */
  dryRun?: boolean;
  /** Lý do giữ lại / bỏ qua nhiều nhất (đã dịch). */
  skippedReasons: { label: string; count: number }[];
};

const num = (v: unknown) => Number(v ?? 0);

/**
 * Hàng đợi liên hệ (Zalo / gọi / email tay) HÔM NAY: thành công = đã gửi hôm nay · thất bại = ghi «sai số» hôm nay · bỏ qua =
 * huỷ hôm nay · còn chờ = lời chào chờ duyệt / chờ gửi. Mốc bắt đầu = lần gửi / ghi kết quả đầu tiên trong ngày.
 */
export async function outreachRunStats(decision: ScopeDecision, now = new Date()): Promise<RunStats> {
  const db = await getDb();
  const o = schema.wholesaleOutreachItems;
  const since = todayStart(now);
  const [row] = await db
    .select({
      success: sql<string>`count(*) filter (where ${o.sentAt} >= ${since})`,
      failed: sql<string>`count(*) filter (where ${o.resultAt} >= ${since} and ${o.result} = 'WRONG_NUMBER')`,
      skipped: sql<string>`count(*) filter (where ${o.status} = 'CANCELLED' and ${o.updatedAt} >= ${since})`,
      pending: sql<string>`count(*) filter (where ${o.status} in ('DRAFT','APPROVED'))`,
      startedAt: sql<string | null>`min(least(case when ${o.sentAt} >= ${since} then ${o.sentAt} end, case when ${o.resultAt} >= ${since} then ${o.resultAt} end))`,
    })
    .from(o)
    .innerJoin(l, eq(l.id, o.leadId))
    .where(andScope(undefined, decision));
  const p = runProgress({ success: num(row?.success), failed: num(row?.failed), skipped: num(row?.skipped), pending: num(row?.pending), startedAt: row?.startedAt ?? null, now });
  return { ...p, skippedReasons: p.skipped ? [{ label: "Đã huỷ", count: p.skipped }] : [] };
}

/**
 * Hộp thư đi HÔM NAY: thành công = thư «đã gửi» hôm nay (chạy thử hay thật — `dryRun` nói rõ) · thất bại = thư lỗi nhà cung
 * cấp · bỏ qua = thư bị CHẶN (lý do của cổng) + thư đang GIỮ LẠI (còn xếp hàng nhưng cổng hoãn, có `last_error`) · còn chờ = đã
 * duyệt / xếp gửi / đang gửi chưa bị giữ.
 */
export async function outboxRunStats(decision: ScopeDecision, now = new Date()): Promise<RunStats | null> {
  const db = await getDb();
  const e = schema.wholesaleEmailOutbox;
  const since = todayStart(now);
  const held = sql`${e.status} = 'QUEUED' and ${e.lastError} is not null and ${e.nextAttemptAt} > ${now}`;
  try {
    const [row] = await db
      .select({
        success: sql<string>`count(*) filter (where ${e.status} = 'SENT' and ${e.sentAt} >= ${since})`,
        dryRun: sql<string>`count(*) filter (where ${e.status} = 'SENT' and ${e.sentAt} >= ${since} and ${e.mode} = 'DRY_RUN')`,
        failed: sql<string>`count(*) filter (where ${e.status} = 'FAILED' and ${e.updatedAt} >= ${since})`,
        blocked: sql<string>`count(*) filter (where ${e.status} = 'BLOCKED' and ${e.updatedAt} >= ${since})`,
        held: sql<string>`count(*) filter (where ${held})`,
        pending: sql<string>`count(*) filter (where ${e.status} in ('APPROVED','QUEUED','SENDING') and not (${held}))`,
        startedAt: sql<string | null>`min(${e.sentAt}) filter (where ${e.sentAt} >= ${since})`,
      })
      .from(e)
      .innerJoin(l, eq(l.id, e.leadId))
      .where(andScope(undefined, decision));
    const reasons = await db
      .select({ reason: e.blockedReason, n: sql<string>`count(*)` })
      .from(e)
      .innerJoin(l, eq(l.id, e.leadId))
      .where(andScope(and(eq(e.status, "BLOCKED"), gte(e.updatedAt, since)), decision))
      .groupBy(e.blockedReason)
      .orderBy(desc(sql`count(*)`))
      .limit(3);
    const skipped = num(row?.blocked) + num(row?.held);
    const p = runProgress({ success: num(row?.success), failed: num(row?.failed), skipped, pending: num(row?.pending), startedAt: row?.startedAt ?? null, now });
    const skippedReasons = reasons.map((r) => ({ label: blockLabel(r.reason), count: num(r.n) }));
    if (num(row?.held)) skippedReasons.push({ label: "Đang giữ lại (cổng hoãn — hạn mức / chế độ / nước chưa rà)", count: num(row?.held) });
    return { ...p, dryRun: num(row?.success) > 0 && num(row?.dryRun) === num(row?.success), skippedReasons };
  } catch {
    // CSDL chưa áp migration hộp thư đi (0264) — trang đã có thông báo riêng; khối tiến độ chỉ ẩn đi.
    return null;
  }
}

function isEmailBlockReason(v: string): v is EmailBlockReason {
  return (EMAIL_BLOCK_REASONS as readonly string[]).includes(v);
}

function blockLabel(reason: string | null): string {
  if (!reason) return "Bị chặn (không ghi lý do)";
  const first = reason.split(/[\s,;·]+/)[0] ?? "";
  return isEmailBlockReason(first) ? EMAIL_BLOCK_REASON_LABEL[first] : shortText(reason, 60);
}

export type ActivityLogRow = {
  id: string;
  at: string;
  /** Kênh / loại việc đã dịch (Zalo · Gọi điện · Tìm thấy · Email…). */
  kind: string;
  /** Tên lead — chỉ tên doanh nghiệp, không phải liên hệ. */
  lead: string;
  leadId: string;
  /** SĐT / email ĐÃ CHE. */
  contact: string;
  text: string;
  status: "OK" | "FAIL" | "SKIP" | "INFO";
  actor: string;
};

const OK_OUTCOMES = new Set(["SENT", "INTERESTED", "REPLIED", "ANSWERED", "DONE", "QUALIFIED", "CONTACTED"]);
const FAIL_OUTCOMES = new Set(["WRONG_NUMBER", "FAILED", "NOT_FOUND", "BOUNCE_HARD", "COMPLAINT"]);
const SKIP_OUTCOMES = new Set(["CANCELLED", "NO_ANSWER", "NOT_INTERESTED", "DO_NOT_CONTACT", "BLOCKED", "SKIPPED"]);

function statusOf(outcome: string | null, kind: string): ActivityLogRow["status"] {
  if (outcome && OK_OUTCOMES.has(outcome)) return "OK";
  if (outcome && FAIL_OUTCOMES.has(outcome)) return "FAIL";
  if (outcome && SKIP_OUTCOMES.has(outcome)) return "SKIP";
  return kind === "DISCOVERED" || kind === "ENRICHED" ? "OK" : "INFO";
}

/**
 * Nhật ký hoạt động gọn, MỚI NHẤT TRÊN CÙNG, từ `wholesale_lead_activities` (kinds truyền vào). Liên hệ đi qua `maskContact`
 * ở đây — không bao giờ gửi chuỗi SĐT / email đầy đủ xuống khối này.
 */
export async function activityLog(decision: ScopeDecision, kinds: readonly string[], limit = 30): Promise<ActivityLogRow[]> {
  const db = await getDb();
  const a = schema.wholesaleLeadActivities;
  const rows = await db
    .select({ id: a.id, at: a.createdAt, kind: a.kind, channel: a.channel, outcome: a.outcome, note: a.note, actor: a.actorName, leadId: a.leadId, lead: NAME, phone: PHONE, email: l.email })
    .from(a)
    .innerJoin(l, eq(l.id, a.leadId))
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(andScope(inArray(a.kind, [...kinds]), decision))
    .orderBy(desc(a.createdAt), desc(a.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    kind: (r.channel === "EMAIL" ? "Email" : null) ?? ACTIVITY_KIND_LABEL[r.kind] ?? r.kind,
    lead: r.lead ?? "—",
    leadId: r.leadId,
    contact: maskContact({ phone: r.phone, email: r.email, channel: r.channel }),
    text: shortText(maskInlineContacts(r.note)),
    status: statusOf(r.outcome, r.kind),
    actor: r.actor || "Máy",
  }));
}

const EMAIL_EVENT_LABEL: Record<string, string> = {
  QUEUED: "Xếp gửi",
  SENT: "Đã gửi",
  DELIVERED: "Đã tới hộp thư",
  BOUNCE_HARD: "Trả về (vĩnh viễn)",
  BOUNCE_SOFT: "Trả về (tạm)",
  COMPLAINT: "Bị báo thư rác",
  REPLY: "Khách trả lời",
  UNSUBSCRIBE: "Huỷ đăng ký",
  BLOCKED: "Cổng chặn",
  FAILED: "Lỗi gửi",
};

/** Nhật ký hộp thư đi từ sổ sự kiện thư (chỉ thêm). Email người nhận ĐÃ CHE. CSDL chưa có bảng ⇒ danh sách rỗng. */
export async function emailEventLog(decision: ScopeDecision, limit = 30): Promise<ActivityLogRow[]> {
  const db = await getDb();
  const ev = schema.wholesaleEmailEvents;
  const e = schema.wholesaleEmailOutbox;
  try {
    const rows = await db
      .select({ id: ev.id, at: ev.createdAt, kind: ev.kind, leadId: ev.leadId, lead: NAME, toEmail: e.toEmail, subject: e.subject, mode: e.mode, reason: e.blockedReason })
      .from(ev)
      .innerJoin(l, eq(l.id, ev.leadId))
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .leftJoin(e, eq(e.id, ev.outboxId))
      .where(andScope(undefined, decision))
      .orderBy(desc(ev.createdAt), desc(ev.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      kind: `Email · ${EMAIL_EVENT_LABEL[r.kind] ?? r.kind}${r.kind === "SENT" && r.mode === "DRY_RUN" ? " (chạy thử)" : ""}`,
      lead: r.lead ?? "—",
      leadId: r.leadId,
      contact: maskContact({ email: r.toEmail, channel: "EMAIL" }),
      text: shortText(maskInlineContacts(r.kind === "BLOCKED" ? blockLabel(r.reason) : (r.subject ?? ""))),
      status: r.kind === "SENT" || r.kind === "DELIVERED" || r.kind === "REPLY" ? "OK" : r.kind === "FAILED" || r.kind === "BOUNCE_HARD" || r.kind === "COMPLAINT" ? "FAIL" : r.kind === "BLOCKED" || r.kind === "UNSUBSCRIBE" || r.kind === "BOUNCE_SOFT" ? "SKIP" : "INFO",
      actor: "Máy",
    }));
  } catch {
    return [];
  }
}
