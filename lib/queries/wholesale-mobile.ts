import { and, desc, eq, gte, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { NAME, PHONE } from "@/lib/queries/wholesale";
import type { SearchParams } from "@/lib/search-params";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { CALL_OUTCOME_LABEL, isLeadStatus, LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, PRICE_REQUEST_ACTION, type CallOutcome, type LeadSourceKey, type LeadStatus } from "@/lib/wholesale/constants";
import { formatVnPhone } from "@/lib/wholesale/phone";
import { isLeadSegmentKey, LEAD_SEGMENT_LABEL } from "@/lib/wholesale/segments";

/**
 * ═══════════ SALE SỈ TRÊN ĐIỆN THOẠI — TRUY VẤN ═══════════
 *
 * Màn `/wholesale/mobile` (chủ shop 05/10/2026): nhân viên mở ERP bằng điện thoại, bấm «BẮT ĐẦU GỌI», máy đưa đúng khách
 * nên gọi tiếp theo. Mọi truy vấn đi qua `andScope` của tài nguyên `WHOLESALE_LEADS` — nhân viên phạm vi «Được giao» chỉ thấy
 * khách giao cho mình, cùng mệnh đề với danh sách trên máy tính.
 *
 * THỨ TỰ GỌI (`PRIORITY`): hẹn gọi lại đã QUÁ HẠN → hẹn trong HÔM NAY → khách đang quan tâm → điểm cao → mới tìm thấy.
 * «Khách tiếp theo» bỏ qua khách vừa liên hệ trong 2 giờ — vừa gọi xong mà máy lại đưa đúng khách đó là vòng lặp.
 */

const l = schema.wholesaleLeads;
const ps = schema.wholesalePlaceSnapshots;


export const TERMINAL_STATUSES: readonly LeadStatus[] = ["WON", "LOST", "DO_NOT_CONTACT"];
export const HOT_STATUSES: readonly LeadStatus[] = ["INTERESTED", "CATALOG_SENT", "PRICE_SENT", "SAMPLE_REQUESTED", "NEGOTIATING"];

export const MOBILE_CHIPS = [
  { key: "all", label: "Tất cả" },
  { key: "new", label: "Mới" },
  { key: "call", label: "Cần gọi" },
  { key: "today", label: "Gọi lại hôm nay" },
  { key: "hot", label: "Quan tâm" },
  { key: "price", label: "Chờ báo giá" },
  { key: "noanswer", label: "Không nghe máy" },
  { key: "done", label: "Đã xử lý" },
] as const;
export type MobileChip = (typeof MOBILE_CHIPS)[number]["key"];
export function isMobileChip(v: unknown): v is MobileChip {
  return typeof v === "string" && MOBILE_CHIPS.some((c) => c.key === v);
}

const list = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const NOT_TERMINAL = sql`${l.contactStatus} not in (${list(TERMINAL_STATUSES)})`;

function endOfTodayVn(now: Date): Date {
  return new Date(vnStartOfDay(vnDateKey(now)).getTime() + 86_400_000);
}

/** Điều kiện của từng chip (khách đã có dữ liệu đủ và có SĐT — màn này để GỌI). */
export function chipCondition(chip: MobileChip, now: Date): SQL {
  const eod = endOfTodayVn(now);
  switch (chip) {
    case "all":
      return NOT_TERMINAL;
    case "new":
      return and(NOT_TERMINAL, isNull(l.firstContactAt))!;
    case "call":
      return and(NOT_TERMINAL, or(isNull(l.firstContactAt), sql`${l.nextFollowupAt} <= ${now}`))!;
    case "today":
      return and(NOT_TERMINAL, sql`${l.nextFollowupAt} < ${eod}`)!;
    case "hot":
      return inArray(l.contactStatus, [...HOT_STATUSES]);
    case "price":
      return and(NOT_TERMINAL, eq(l.nextAction, PRICE_REQUEST_ACTION))!;
    case "noanswer":
      return eq(l.contactStatus, "NO_ANSWER");
    case "done":
      return inArray(l.contactStatus, [...TERMINAL_STATUSES]);
  }
}

/** Hạng ưu tiên (số nhỏ gọi trước) — một biểu thức, dùng chung cho hàng đợi và «khách tiếp theo». */
function priority(now: Date): SQL {
  const eod = endOfTodayVn(now);
  return sql`case
    when ${NOT_TERMINAL} and ${l.nextFollowupAt} < ${now} then 0
    when ${NOT_TERMINAL} and ${l.nextFollowupAt} < ${eod} then 1
    when ${l.contactStatus} in (${list(HOT_STATUSES)}) then 2
    else 3 end`;
}

function mobileLeadWhere(decision: ScopeDecision, extra: (SQL | undefined)[]): SQL | undefined {
  return andScope(and(eq(l.enrichmentStatus, "READY"), sql`${PHONE} is not null`, ...extra), decision);
}

export type MobileLeadCard = {
  id: string;
  name: string | null;
  segmentLabel: string;
  area: string | null;
  phoneDisplay: string | null;
  grade: string | null;
  score: number | null;
  status: LeadStatus;
  statusLabel: string;
  sourceLabel: string;
  lastContactAt: string | null;
  nextFollowupAt: string | null;
  nextAction: string | null;
  /** 0 quá hạn · 1 hôm nay · 2 đang quan tâm · 3 còn lại. */
  rank: number;
};

export async function mobileQueue(decision: ScopeDecision, chip: MobileChip, q: string, now = new Date(), limit = 60): Promise<MobileLeadCard[]> {
  const db = await getDb();
  const extra: SQL[] = [chipCondition(chip, now)];
  const term = q.trim();
  if (term) {
    const digits = term.replace(/\D/g, "");
    const like = `%${term.replace(/[%_]/g, "")}%`;
    const parts: SQL[] = [ilike(sql`coalesce(${l.businessName}, ${ps.displayName}, '')`, like), ilike(sql`coalesce(${l.areaName}, '') || ' ' || coalesce(${l.provinceLabel}, '') || ' ' || coalesce(${l.address}, ${ps.formattedAddress}, '')`, like)];
    if (digits.length >= 6) parts.push(sql`${PHONE} like ${`%${digits.slice(-9)}`}`);
    extra.push(or(...parts)!);
  }
  const rank = priority(now);
  const rows = await db
    .select({ id: l.id, name: NAME, segment: l.segment, area: l.areaName, province: l.provinceLabel, phone: PHONE, grade: l.leadGrade, score: l.leadScore, status: l.contactStatus, source: l.source, lastContactAt: l.lastContactAt, nextFollowupAt: l.nextFollowupAt, nextAction: l.nextAction, rank: sql<number>`${rank}` })
    .from(l)
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(mobileLeadWhere(decision, extra))
    .orderBy(chip === "done" ? desc(l.lastContactAt) : sql`${rank} asc`, sql`${l.leadScore} desc nulls last`, desc(l.firstSeenAt), l.id)
    .limit(limit);
  return rows.map((r) => {
    const status: LeadStatus = isLeadStatus(r.status) ? r.status : "NEW";
    return {
      id: r.id,
      name: r.name,
      segmentLabel: isLeadSegmentKey(r.segment) ? LEAD_SEGMENT_LABEL[r.segment] : r.segment,
      area: [r.area, r.province].filter(Boolean).join(", ") || null,
      phoneDisplay: r.phone ? formatVnPhone(r.phone) : null,
      grade: r.grade,
      score: r.score,
      status,
      statusLabel: LEAD_STATUS_LABEL[status],
      sourceLabel: LEAD_SOURCE_LABEL[r.source as LeadSourceKey] ?? r.source,
      lastContactAt: r.lastContactAt ? r.lastContactAt.toISOString() : null,
      nextFollowupAt: r.nextFollowupAt ? r.nextFollowupAt.toISOString() : null,
      nextAction: r.nextAction,
      rank: Number(r.rank),
    };
  });
}

/** Khách nên gọi tiếp theo trong chip đang mở: bỏ khách đang xem và khách vừa liên hệ trong 2 giờ. `null` = hết khách. */
export async function nextLeadId(decision: ScopeDecision, chip: MobileChip, exceptId: string | null, now = new Date()): Promise<string | null> {
  const db = await getDb();
  const recent = new Date(now.getTime() - 2 * 3_600_000);
  const rank = priority(now);
  const [row] = await db
    .select({ id: l.id })
    .from(l)
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(mobileLeadWhere(decision, [chip === "done" ? chipCondition("call", now) : chipCondition(chip, now), exceptId ? ne(l.id, exceptId) : undefined, or(isNull(l.lastContactAt), sql`${l.lastContactAt} < ${recent}`)]))
    .orderBy(sql`${rank} asc`, sql`${l.leadScore} desc nulls last`, desc(l.firstSeenAt), l.id)
    .limit(1);
  return row?.id ?? null;
}

/** Props của trang chỉ-chuyển-hướng `/wholesale/mobile/next` (để ở đây cho tệp trang không có cú pháp JSX / kiểu tổng quát). */
export type MobileNextProps = { searchParams: Promise<SearchParams> };

export type MobileHome = { newCount: number; toCall: number; followupDue: number; interested: number; priceWaiting: number; won: number; myCallsToday: number; myAnsweredToday: number };

export async function mobileHome(decision: ScopeDecision, userId: string, now = new Date()): Promise<MobileHome> {
  const db = await getDb();
  const eod = endOfTodayVn(now);
  const [row] = await db
    .select({
      newCount: sql<string>`count(*) filter (where ${chipCondition("new", now)})`,
      toCall: sql<string>`count(*) filter (where ${chipCondition("call", now)})`,
      followupDue: sql<string>`count(*) filter (where ${NOT_TERMINAL} and ${l.nextFollowupAt} < ${eod})`,
      interested: sql<string>`count(*) filter (where ${chipCondition("hot", now)})`,
      priceWaiting: sql<string>`count(*) filter (where ${chipCondition("price", now)})`,
      won: sql<string>`count(*) filter (where ${l.contactStatus} = 'WON')`,
    })
    .from(l)
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(mobileLeadWhere(decision, []));
  const a = schema.wholesaleLeadActivities;
  const dayStart = vnStartOfDay(vnDateKey(now));
  const [mine] = await db
    .select({
      calls: sql<string>`count(*)`,
      answered: sql<string>`count(*) filter (where ${a.outcome} not in ('NO_ANSWER','BUSY','WRONG_NUMBER'))`,
    })
    .from(a)
    .where(and(eq(a.kind, "CALL"), eq(a.actorId, userId), gte(a.createdAt, dayStart)));
  return {
    newCount: Number(row?.newCount ?? 0),
    toCall: Number(row?.toCall ?? 0),
    followupDue: Number(row?.followupDue ?? 0),
    interested: Number(row?.interested ?? 0),
    priceWaiting: Number(row?.priceWaiting ?? 0),
    won: Number(row?.won ?? 0),
    myCallsToday: Number(mine?.calls ?? 0),
    myAnsweredToday: Number(mine?.answered ?? 0),
  };
}

export type MobileHistoryRow = { id: string; leadId: string; name: string | null; outcomeLabel: string; note: string; at: string };

/** Cuộc gọi CỦA CHÍNH người xem (dòng `CALL` mang kết quả), mới nhất trước. */
export async function mobileHistory(userId: string, limit = 60): Promise<MobileHistoryRow[]> {
  const db = await getDb();
  const a = schema.wholesaleLeadActivities;
  const rows = await db
    .select({ id: a.id, leadId: a.leadId, outcome: a.outcome, note: a.note, at: a.createdAt, name: NAME })
    .from(a)
    .innerJoin(l, eq(l.id, a.leadId))
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(and(eq(a.kind, "CALL"), eq(a.actorId, userId)))
    .orderBy(desc(a.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, leadId: r.leadId, name: r.name, outcomeLabel: (CALL_OUTCOME_LABEL as Record<string, string>)[r.outcome ?? ""] ?? (r.outcome as CallOutcome | null) ?? "—", note: r.note, at: r.at.toISOString() }));
}
