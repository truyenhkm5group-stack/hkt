import { and, count, eq, gte, inArray, or, sql, sum } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { sendInboxMessages } from "@/lib/inbox/send";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { LEAD_HUNTER_SETTING_KEY, mergeLeadHunterConfig, type LeadHunterConfig } from "@/lib/wholesale/config";
import { RESOLVED_STATUSES } from "@/lib/wholesale/constants";
import type { SegmentOutcomeStats } from "@/lib/wholesale/scoring";
import { isLeadSegmentKey } from "@/lib/wholesale/segments";

/**
 * ═══════════ SĂN KHÁCH SỈ — ĐỌC / GHI DÙNG CHUNG (CHỈ MÁY CHỦ) ═══════════
 *
 * Cấu hình, sổ chi phí API, danh sách không liên hệ, báo chủ shop, thống kê «học từ kết quả». Mọi hàm đọc `getDb()` —
 * CSDL của tổ chức đang chạy (luật SILO).
 */

export async function getLeadHunterConfig(): Promise<LeadHunterConfig> {
  const raw = await getSettingJson<unknown>(LEAD_HUNTER_SETTING_KEY, null);
  return mergeLeadHunterConfig(raw);
}

export async function saveLeadHunterConfig(cfg: LeadHunterConfig): Promise<void> {
  await setSettingJson(LEAD_HUNTER_SETTING_KEY, cfg);
}

/** Đầu tháng theo giờ Việt Nam. */
export function vnStartOfMonth(now: Date): Date {
  const key = vnDateKey(now); // YYYY-MM-DD
  return vnStartOfDay(`${key.slice(0, 7)}-01`);
}

export type SpendSnapshot = { todayMicros: number; monthMicros: number; callsToday: number };

/** Chi phí API đã ghi hôm nay / tháng này (giờ VN) — chỉ lượt bị TÍNH TIỀN, chỉ nhà cung cấp tính tiền. */
export async function currentSpend(now: Date): Promise<SpendSnapshot> {
  const db = await getDb();
  const u = schema.wholesaleApiUsage;
  const dayStart = vnStartOfDay(vnDateKey(now));
  const monthStart = vnStartOfMonth(now);
  const [row] = await db
    .select({
      today: sql<string>`coalesce(sum(case when ${u.at} >= ${dayStart} then ${u.costMicros} else 0 end), 0)`,
      month: sql<string>`coalesce(sum(${u.costMicros}), 0)`,
      calls: sql<string>`count(*) filter (where ${u.at} >= ${dayStart} and ${u.provider} = 'GOOGLE_PLACES')`,
    })
    .from(u)
    .where(gte(u.at, monthStart));
  return { todayMicros: Number(row?.today ?? 0), monthMicros: Number(row?.month ?? 0), callsToday: Number(row?.calls ?? 0) };
}

export type UsageRow = typeof schema.wholesaleApiUsage.$inferInsert;

export async function recordUsage(row: UsageRow): Promise<void> {
  const db = await getDb();
  await db.insert(schema.wholesaleApiUsage).values({ ...row, error: row.error ? row.error.slice(0, 500) : null, query: row.query ? row.query.slice(0, 300) : null });
}

export type SuppressionProbe = { placeId?: string | null; phone?: string | null; domain?: string | null };

/** Khớp danh sách không liên hệ theo BẤT KỲ khoá nào. Trả lý do đầu tiên khớp, `null` = không bị chặn. */
export async function suppressionHit(p: SuppressionProbe): Promise<string | null> {
  const conds = [];
  const s = schema.wholesaleSuppressions;
  if (p.placeId) conds.push(and(eq(s.kind, "PLACE"), eq(s.value, p.placeId)));
  if (p.phone) conds.push(and(eq(s.kind, "PHONE"), eq(s.value, p.phone)));
  if (p.domain) conds.push(and(eq(s.kind, "DOMAIN"), eq(s.value, p.domain)));
  if (!conds.length) return null;
  const db = await getDb();
  const [row] = await db.select({ reason: s.reason }).from(s).where(or(...conds)).limit(1);
  return row?.reason ?? null;
}

/** Thống kê kết cục theo nhóm khách — đầu vào của điểm «học từ kết quả». */
export async function segmentOutcomeStats(): Promise<SegmentOutcomeStats[]> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const rows = await db
    .select({ segment: l.segment, resolved: count(), won: sql<string>`count(*) filter (where ${l.contactStatus} = 'WON')` })
    .from(l)
    .where(inArray(l.contactStatus, [...RESOLVED_STATUSES]))
    .groupBy(l.segment);
  return rows.filter((r) => isLeadSegmentKey(r.segment)).map((r) => ({ segment: r.segment as SegmentOutcomeStats["segment"], resolved: Number(r.resolved), won: Number(r.won) }));
}

/**
 * Báo người có quyền cấu hình (chủ shop / quản trị): chuông + hàng đợi chung. Khoá chống trùng do người gọi đặt (vd mỗi
 * ngày một tin khi chạm trần), nên gọi lại không nhân tin.
 */
export async function notifyOwners(input: { title: string; body: string; href: string; dedupeKey: string; severity?: "info" | "warning" | "critical"; now: Date }): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: input.severity ?? "warning", title: input.title, body: input.body, href: input.href, entityType: "WHOLESALE_LEADS", dedupeKey: input.dedupeKey, occurredAt: input.now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("wholesale:config");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "WHOLESALE_LEADS", title: input.title, body: input.body, href: input.href, dedupeKey: `${input.dedupeKey}:${userId}` })), db);
}

/** Tổng chi phí từ trước tới nay (micro-USD) theo chiến dịch — cho bảng hiệu quả. */
export async function costByCampaign(): Promise<Map<string, number>> {
  const db = await getDb();
  const u = schema.wholesaleApiUsage;
  const rows = await db.select({ id: u.campaignId, micros: sum(u.costMicros) }).from(u).groupBy(u.campaignId);
  return new Map(rows.filter((r) => r.id).map((r) => [r.id as string, Number(r.micros ?? 0)]));
}

