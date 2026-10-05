import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { ListParams } from "@/lib/search-params";
import { SEARCH_PROVINCES } from "@/lib/wholesale/areas";
import { DEFAULT_KEYWORD_GROUPS, paidCostMicros, type LeadHunterConfig } from "@/lib/wholesale/config";
import { CONTACTED_STATUSES, INTERESTED_STATUSES, LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, NEGOTIATING_STATUSES, RESPONDED_STATUSES, type LeadSourceKey, type LeadStatus, isLeadStatus } from "@/lib/wholesale/constants";
import { formatVnPhone, PHONE_KIND_LABEL, type PhoneKind } from "@/lib/wholesale/phone";
import { enabledKeywords } from "@/lib/wholesale/query-plan";
import { LEAD_SEGMENT_LABEL, isLeadSegmentKey, type LeadSegment } from "@/lib/wholesale/segments";
import { billableCallsBySku, getLeadHunterConfig, vnStartOfMonth } from "@/lib/wholesale/store";

/**
 * ═══════════ SĂN KHÁCH SỈ — TRUY VẤN CHỈ ĐỌC ═══════════
 *
 * Tên / SĐT / website hiển thị = dữ liệu CỦA TỔ CHỨC nếu có, không thì snapshot Google CÒN HẠN (`coalesce`). Snapshot đã
 * xoá ⇒ ô trống «—», không phải chuỗi rỗng giả.
 *
 * Doanh thu từ lead đã thành khách: CÙNG một công thức với trang Khách hàng — `ORDER_OUTCOME_FAST = 'DELIVERED'` và
 * `REVENUE_RECOGNIZED_ON_DELIVERY` (AGENTS mục 0.2: một công thức kết quả đơn, không tự tính).
 */

const l = schema.wholesaleLeads;
const ps = schema.wholesalePlaceSnapshots;

/** Tên / SĐT hiển thị: dữ liệu của tổ chức trước, ảnh chụp Google sau. Dùng chung cho mọi truy vấn lead (cả màn điện thoại). */
export const NAME = sql<string | null>`coalesce(${l.businessName}, ${ps.displayName})`;
export const PHONE = sql<string | null>`coalesce(${l.normalizedPhone}, ${ps.normalizedPhone})`;
const PHONE_KIND = sql<string | null>`case when ${l.normalizedPhone} is not null then ${l.phoneKind} else ${ps.phoneKind} end`;
const WEBSITE = sql<string | null>`coalesce(${l.website}, ${ps.websiteUri})`;

export const WHOLESALE_LEAD_SORTABLE = ["leadScore", "name", "rating", "reviews", "lastContactAt", "nextFollowupAt", "firstSeenAt", "status"];
export const WHOLESALE_LEAD_FILTERS = ["grade", "contact", "province", "segment", "campaign", "assignee", "status", "source", "view"];

export type LeadListRow = {
  id: string;
  name: string | null;
  segment: LeadSegment;
  segmentLabel: string;
  area: string | null;
  province: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  phoneKindLabel: string | null;
  rating: number | null;
  reviews: number | null;
  website: string | null;
  score: number | null;
  grade: string | null;
  status: LeadStatus;
  statusLabel: string;
  assignee: string | null;
  lastContactAt: string | null;
  nextFollowupAt: string | null;
  nextAction: string | null;
  enrichment: string;
  filterReason: string | null;
  googleExpired: boolean;
  source: string;
  /** Ghi chú gần nhất (dòng NOTE hoặc CALL có chữ) + kết quả cuộc gọi đi kèm (nếu là dòng CALL). */
  lastNote: string | null;
  lastNoteOutcome: string | null;
  lastNoteAt: string | null;
};

/** Dòng hoạt động có chữ mới nhất của lead — câu con tương quan, khoá lead viết TƯỜNG MINH (drizzle in `id` trần thành cột của bảng con). */
const LAST_NOTE_ROW = sql`(select a.note, a.outcome, a.kind, a.created_at from wholesale_lead_activities a where a.lead_id = "wholesale_leads"."id" and a.kind in ('NOTE','CALL') and a.note <> '' order by a.created_at desc limit 1)`;

function leadConditions(params: ListParams, viewerId: string | null): SQL[] {
  const f = params.filters;
  const conds: SQL[] = [];
  const view = f.view?.[0] ?? "active";
  if (view === "active") conds.push(eq(l.enrichmentStatus, "READY"));
  else if (view === "pending") conds.push(eq(l.enrichmentStatus, "PENDING_DETAILS"));
  else if (view === "filtered") conds.push(inArray(l.enrichmentStatus, ["FILTERED", "DUPLICATE", "FAILED"]));
  if (f.grade?.length) conds.push(inArray(l.leadGrade, f.grade));
  for (const c of f.contact ?? []) {
    if (c === "phone") conds.push(sql`${PHONE} is not null`);
    if (c === "website") conds.push(sql`${WEBSITE} is not null`);
    if (c === "never") conds.push(isNull(l.firstContactAt));
    if (c === "due") conds.push(sql`${l.nextFollowupAt} <= now()`);
  }
  if (f.province?.length) conds.push(inArray(l.provinceKey, f.province));
  if (f.segment?.length) conds.push(inArray(l.segment, f.segment));
  if (f.status?.length) conds.push(inArray(l.contactStatus, f.status));
  if (f.source?.length) conds.push(inArray(l.source, f.source));
  if (f.campaign?.length) conds.push(sql`exists (select 1 from wholesale_lead_campaigns lc where lc.lead_id = "wholesale_leads"."id" and lc.campaign_id in (${sql.join(f.campaign.map((x) => sql`${x}`), sql`, `)}))`);
  if (f.assignee?.length) {
    const parts: SQL[] = [];
    for (const a of f.assignee) {
      if (a === "none") parts.push(isNull(l.assignedToUserId));
      else if (a === "me" && viewerId) parts.push(eq(l.assignedToUserId, viewerId));
      else if (a !== "me") parts.push(eq(l.assignedToUserId, a));
    }
    if (parts.length) conds.push(or(...parts)!);
  }
  const q = params.q.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const parts: SQL[] = [ilike(sql`coalesce(${l.businessName}, ${ps.displayName}, '')`, like), ilike(sql`coalesce(${l.address}, ${ps.formattedAddress}, '')`, like)];
    if (digits.length >= 6) parts.push(sql`${PHONE} like ${`%${digits.slice(-9)}`}`);
    conds.push(or(...parts)!);
  }
  return conds;
}

export async function listWholesaleLeads(params: ListParams, decision: ScopeDecision, viewerId: string | null) {
  const db = await getDb();
  const where = andScope(and(...leadConditions(params, viewerId)), decision);
  const sortMap: Record<string, SQL> = {
    leadScore: sql`${l.leadScore}`,
    name: NAME,
    rating: sql`${ps.rating}`,
    reviews: sql`${ps.userRatingCount}`,
    lastContactAt: sql`${l.lastContactAt}`,
    nextFollowupAt: sql`${l.nextFollowupAt}`,
    firstSeenAt: sql`${l.firstSeenAt}`,
    status: sql`${l.contactStatus}`,
  };
  const col = sortMap[params.sort] ?? sortMap.leadScore!;
  const order = params.dir === "asc" ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: l.id,
        name: NAME,
        segment: l.segment,
        area: l.areaName,
        province: l.provinceLabel,
        phone: PHONE,
        phoneKind: PHONE_KIND,
        rating: ps.rating,
        reviews: ps.userRatingCount,
        website: WEBSITE,
        score: l.leadScore,
        grade: l.leadGrade,
        status: l.contactStatus,
        assignee: l.assignedToName,
        lastContactAt: l.lastContactAt,
        nextFollowupAt: l.nextFollowupAt,
        nextAction: l.nextAction,
        enrichment: l.enrichmentStatus,
        filterReason: l.filterReason,
        purgedAt: ps.purgedAt,
        placeId: l.placeId,
        source: l.source,
        lastNote: sql<string | null>`(select x.note from ${LAST_NOTE_ROW} x)`,
        lastNoteOutcome: sql<string | null>`(select case when x.kind = 'CALL' then x.outcome end from ${LAST_NOTE_ROW} x)`,
        lastNoteAt: sql<Date | string | null>`(select x.created_at from ${LAST_NOTE_ROW} x)`,
      })
      .from(l)
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(where)
      .orderBy(order, desc(l.firstSeenAt), asc(l.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    db.select({ total: count() }).from(l).leftJoin(ps, eq(ps.placeId, l.placeId)).where(where),
  ]);
  const out: LeadListRow[] = rows.map((r) => {
    const seg: LeadSegment = isLeadSegmentKey(r.segment) ? r.segment : "UNCLASSIFIED";
    const status: LeadStatus = isLeadStatus(r.status) ? r.status : "NEW";
    return {
      id: r.id,
      name: r.name,
      segment: seg,
      segmentLabel: LEAD_SEGMENT_LABEL[seg],
      area: r.area,
      province: r.province,
      phone: r.phone,
      phoneDisplay: r.phone ? formatVnPhone(r.phone) : null,
      phoneKindLabel: r.phoneKind ? PHONE_KIND_LABEL[r.phoneKind as PhoneKind] ?? null : null,
      rating: r.rating,
      reviews: r.reviews,
      website: r.website,
      score: r.score,
      grade: r.grade,
      status,
      statusLabel: LEAD_STATUS_LABEL[status],
      assignee: r.assignee,
      lastContactAt: r.lastContactAt ? r.lastContactAt.toISOString() : null,
      nextFollowupAt: r.nextFollowupAt ? r.nextFollowupAt.toISOString() : null,
      nextAction: r.nextAction,
      enrichment: r.enrichment,
      filterReason: r.filterReason,
      googleExpired: Boolean(r.placeId && r.purgedAt),
      source: LEAD_SOURCE_LABEL[r.source as LeadSourceKey] ?? r.source,
      lastNote: r.lastNote,
      lastNoteOutcome: r.lastNoteOutcome,
      lastNoteAt: r.lastNoteAt ? new Date(r.lastNoteAt).toISOString() : null,
    };
  });
  return { rows: out, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type FacetOption = { value: string; label: string; count?: number };

export async function wholesaleLeadFacets(decision: ScopeDecision) {
  const db = await getDb();
  const scoped = andScope(eq(l.enrichmentStatus, "READY"), decision);
  const [provinces, segments, statuses, campaigns, assignees] = await Promise.all([
    db.select({ v: l.provinceKey, label: sql<string>`max(${l.provinceLabel})`, n: count() }).from(l).where(and(scoped, isNotNull(l.provinceKey))).groupBy(l.provinceKey).orderBy(desc(count())),
    db.select({ v: l.segment, n: count() }).from(l).where(scoped).groupBy(l.segment).orderBy(desc(count())),
    db.select({ v: l.contactStatus, n: count() }).from(l).where(scoped).groupBy(l.contactStatus),
    db.select({ v: schema.wholesaleCampaigns.id, label: schema.wholesaleCampaigns.name }).from(schema.wholesaleCampaigns).where(eq(schema.wholesaleCampaigns.isTemplate, false)).orderBy(desc(schema.wholesaleCampaigns.createdAt)).limit(50),
    db.select({ v: l.assignedToUserId, label: sql<string>`max(${l.assignedToName})`, n: count() }).from(l).where(and(scoped, isNotNull(l.assignedToUserId))).groupBy(l.assignedToUserId),
  ]);
  return {
    province: provinces.map((r) => ({ value: r.v!, label: r.label ?? r.v!, count: Number(r.n) })),
    segment: segments.filter((r) => isLeadSegmentKey(r.v)).map((r) => ({ value: r.v, label: LEAD_SEGMENT_LABEL[r.v as LeadSegment], count: Number(r.n) })),
    status: statuses.filter((r) => isLeadStatus(r.v)).map((r) => ({ value: r.v, label: LEAD_STATUS_LABEL[r.v as LeadStatus], count: Number(r.n) })),
    campaign: campaigns.map((r) => ({ value: r.v, label: r.label })),
    assignee: [{ value: "me", label: "Của tôi" }, { value: "none", label: "Chưa giao" }, ...assignees.map((r) => ({ value: r.v!, label: r.label ?? "?", count: Number(r.n) }))],
  };
}

/** Người nhận giao lead: tài khoản đang hoạt động có quyền chăm lead. */
export async function assignableUsers(): Promise<{ id: string; name: string }[]> {
  const ids = await activeUserIdsWhoCan("wholesale:work");
  if (!ids.length) return [];
  const db = await getDb();
  return db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids)).orderBy(asc(schema.users.name));
}

/** Doanh thu đã giao + số đơn theo khách — một công thức với trang Khách hàng. */
export async function deliveredRevenueByCustomer(customerIds: string[]): Promise<Map<string, { revenue: number; orders: number; delivered: number }>> {
  const out = new Map<string, { revenue: number; orders: number; delivered: number }>();
  if (!customerIds.length) return out;
  const db = await getDb();
  const o = schema.orders;
  for (let i = 0; i < customerIds.length; i += 500) {
    const rows = await db
      .select({
        id: o.customerId,
        orders: sql<string>`count(*) filter (where ${o.stage} not in ('CANCELLED','DELETED'))`,
        delivered: sql<string>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
        revenue: sql<string>`coalesce(sum(case when ${ORDER_OUTCOME_FAST} = 'DELIVERED' and ${REVENUE_RECOGNIZED_ON_DELIVERY} then ${o.totalPriceAfterDiscount} else 0 end), 0)`,
      })
      .from(o)
      .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
      .where(inArray(o.customerId, customerIds.slice(i, i + 500)))
      .groupBy(o.customerId);
    for (const r of rows) if (r.id) out.set(r.id, { revenue: Number(r.revenue ?? 0), orders: Number(r.orders ?? 0), delivered: Number(r.delivered ?? 0) });
  }
  return out;
}

export async function getWholesaleLead(id: string) {
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(l.id, id) });
  if (!lead) return null;
  const [snap, activities, enrichments, outreach, campaigns, duplicates, customer, revenue, sourceCampaign] = await Promise.all([
    lead.placeId ? db.query.wholesalePlaceSnapshots.findFirst({ where: eq(ps.placeId, lead.placeId) }) : Promise.resolve(undefined),
    db.select().from(schema.wholesaleLeadActivities).where(eq(schema.wholesaleLeadActivities.leadId, id)).orderBy(desc(schema.wholesaleLeadActivities.createdAt)).limit(200),
    db.select().from(schema.wholesaleLeadEnrichments).where(eq(schema.wholesaleLeadEnrichments.leadId, id)).orderBy(asc(schema.wholesaleLeadEnrichments.kind)),
    db.select().from(schema.wholesaleOutreachItems).where(eq(schema.wholesaleOutreachItems.leadId, id)).orderBy(desc(schema.wholesaleOutreachItems.createdAt)).limit(50),
    db
      .select({ id: schema.wholesaleCampaigns.id, name: schema.wholesaleCampaigns.name })
      .from(schema.wholesaleLeadCampaigns)
      .innerJoin(schema.wholesaleCampaigns, eq(schema.wholesaleCampaigns.id, schema.wholesaleLeadCampaigns.campaignId))
      .where(eq(schema.wholesaleLeadCampaigns.leadId, id)),
    db.select({ id: l.id, name: NAME, reason: l.filterReason }).from(l).leftJoin(ps, eq(ps.placeId, l.placeId)).where(eq(l.duplicateOfLeadId, id)).limit(20),
    lead.customerId ? db.query.customers.findFirst({ where: eq(schema.customers.id, lead.customerId), columns: { id: true, name: true, phone: true } }) : Promise.resolve(undefined),
    lead.customerId ? deliveredRevenueByCustomer([lead.customerId]) : Promise.resolve(new Map<string, { revenue: number; orders: number; delivered: number }>()),
    lead.sourceCampaignId ? db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, lead.sourceCampaignId), columns: { id: true, name: true } }) : Promise.resolve(undefined),
  ]);
  return { lead, snap: snap ?? null, activities, enrichments, outreach, campaigns, duplicates, customer: customer ?? null, revenue: lead.customerId ? (revenue.get(lead.customerId) ?? { revenue: 0, orders: 0, delivered: 0 }) : null, sourceCampaign: sourceCampaign ?? null };
}

export type CampaignProgress = {
  id: string;
  name: string;
  status: string;
  pauseReason: string | null;
  isTemplate: boolean;
  discoveryTier: string;
  searchMode: string;
  maxLeads: number;
  createdAt: string;
  startedAt: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  cells: number;
  cellsDone: number;
  cellsPending: number;
  cellsFailed: number;
  cellsFresh: number;
  placesDiscovered: number;
  uniquePlaces: number;
  duplicatesRemoved: number;
  filtered: number;
  newLeads: number;
  pendingDetails: number;
  phoneFound: number;
  qualified: number;
  apiCalls: number;
  costMicros: number;
};

export async function campaignProgressList(): Promise<CampaignProgress[]> {
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  const camps = await db.select().from(c).orderBy(desc(c.isTemplate), desc(c.createdAt)).limit(60);
  if (!camps.length) return [];
  const ids = camps.map((x) => x.id);
  const cc = schema.wholesaleCampaignCells;
  const h = schema.wholesalePlaceHits;
  const u = schema.wholesaleApiUsage;
  const [cells, hits, leads, usage] = await Promise.all([
    db
      .select({
        id: cc.campaignId,
        total: count(),
        done: sql<string>`count(*) filter (where ${cc.status} = 'DONE')`,
        pending: sql<string>`count(*) filter (where ${cc.status} in ('PENDING','RUNNING'))`,
        failed: sql<string>`count(*) filter (where ${cc.status} = 'FAILED')`,
        fresh: sql<string>`count(*) filter (where ${cc.status} = 'SKIPPED_FRESH')`,
        found: sql<string>`coalesce(sum(${cc.resultsFound}), 0)`,
      })
      .from(cc)
      .where(inArray(cc.campaignId, ids))
      .groupBy(cc.campaignId),
    db
      .select({
        id: h.campaignId,
        unique: count(),
        dup: sql<string>`count(*) filter (where ${h.outcome} in ('EXISTING_LEAD','DUPLICATE'))`,
        filtered: sql<string>`count(*) filter (where ${h.outcome} in ('FILTERED','SUPPRESSED'))`,
      })
      .from(h)
      .where(inArray(h.campaignId, ids))
      .groupBy(h.campaignId),
    db
      .select({
        id: l.sourceCampaignId,
        alive: sql<string>`count(*) filter (where ${l.enrichmentStatus} not in ('FILTERED','DUPLICATE','FAILED'))`,
        pending: sql<string>`count(*) filter (where ${l.enrichmentStatus} = 'PENDING_DETAILS')`,
        filteredLater: sql<string>`count(*) filter (where ${l.enrichmentStatus} in ('FILTERED','DUPLICATE'))`,
        dupLater: sql<string>`count(*) filter (where ${l.enrichmentStatus} = 'DUPLICATE')`,
        phone: sql<string>`count(*) filter (where ${l.enrichmentStatus} = 'READY' and ${PHONE} is not null)`,
        qualified: sql<string>`count(*) filter (where ${l.enrichmentStatus} = 'READY' and ${l.qualifiedAt} is not null)`,
      })
      .from(l)
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(inArray(l.sourceCampaignId, ids))
      .groupBy(l.sourceCampaignId),
    db
      .select({ id: u.campaignId, calls: sql<string>`count(*) filter (where ${u.provider} = 'GOOGLE_PLACES')`, micros: sql<string>`coalesce(sum(${u.costMicros}), 0)` })
      .from(u)
      .where(inArray(u.campaignId, ids))
      .groupBy(u.campaignId),
  ]);
  const by = <T extends { id: string | null }>(rows: T[]) => new Map(rows.filter((r) => r.id).map((r) => [r.id as string, r]));
  const mc = by(cells);
  const mh = by(hits);
  const ml = by(leads);
  const mu = by(usage);
  return camps.map((x) => {
    const ce = mc.get(x.id);
    const hi = mh.get(x.id);
    const le = ml.get(x.id);
    const us = mu.get(x.id);
    const found = Number(ce?.found ?? 0);
    const unique = Number(hi?.unique ?? 0);
    return {
      id: x.id,
      name: x.name,
      status: x.status,
      pauseReason: x.pauseReason,
      isTemplate: x.isTemplate,
      discoveryTier: x.discoveryTier,
      searchMode: x.searchMode,
      maxLeads: x.maxLeads,
      createdAt: x.createdAt.toISOString(),
      startedAt: x.startedAt ? x.startedAt.toISOString() : null,
      lastTickAt: x.lastTickAt ? x.lastTickAt.toISOString() : null,
      lastError: x.lastError,
      cells: Number(ce?.total ?? 0),
      cellsDone: Number(ce?.done ?? 0),
      cellsPending: Number(ce?.pending ?? 0),
      cellsFailed: Number(ce?.failed ?? 0),
      cellsFresh: Number(ce?.fresh ?? 0),
      placesDiscovered: found,
      uniquePlaces: unique,
      // Trùng = lặp giữa các trang / ô của chính chiến dịch + đã là lead từ trước + trùng SĐT / website / tên-địa chỉ.
      duplicatesRemoved: Math.max(0, found - unique) + Number(hi?.dup ?? 0) + Number(le?.dupLater ?? 0),
      filtered: Number(hi?.filtered ?? 0) + Number(le?.filteredLater ?? 0) - Number(le?.dupLater ?? 0),
      newLeads: Number(le?.alive ?? 0),
      pendingDetails: Number(le?.pending ?? 0),
      phoneFound: Number(le?.phone ?? 0),
      qualified: Number(le?.qualified ?? 0),
      apiCalls: Number(us?.calls ?? 0),
      costMicros: Number(us?.micros ?? 0),
    };
  });
}

export async function getCampaign(id: string) {
  const db = await getDb();
  return db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, id) });
}

export type CoverageArea = { code: string; name: string; scanned: number; total: number; newLeads: number; lastScannedAt: string | null };
export type CoverageProvince = { key: string; label: string; scanned: number; total: number; pct: number | null; newLeads: number; areas: CoverageArea[] };

/**
 * ĐỘ PHỦ theo tỉnh: ô đã quét CÒN MỚI (trong `cellFreshDays`) / mọi ô của bộ từ khoá mặc định đang bật × mọi khu vực
 * có trong sổ khu vực (và khu vực tự khai đã từng có ô). Mẫu số là MỌI ô cần có, không chỉ ô đã sinh — tỉnh chưa quét gì
 * là 0%, không biến mất khỏi bảng.
 */
export async function coverageByProvince(cfg: LeadHunterConfig, now = new Date()): Promise<{ provinces: CoverageProvince[]; keywordCount: number }> {
  const db = await getDb();
  const sc = schema.wholesaleSearchCells;
  const since = new Date(now.getTime() - cfg.cellFreshDays * 86_400_000);
  const keywords = enabledKeywords(DEFAULT_KEYWORD_GROUPS);
  const rows = await db
    .select({
      province: sc.provinceKey,
      provinceLabel: sql<string>`max(${sc.provinceLabel})`,
      area: sc.areaCode,
      areaName: sql<string>`max(${sc.areaName})`,
      scanned: sql<string>`count(distinct ${sc.keyword}) filter (where ${sc.lastStatus} = 'DONE' and ${sc.lastScannedAt} >= ${since})`,
      cells: sql<string>`count(distinct ${sc.keyword})`,
      newLeads: sql<string>`coalesce(sum(${sc.totalNewLeads}), 0)`,
      last: sql<Date | null>`max(${sc.lastScannedAt})`,
    })
    .from(sc)
    .where(eq(sc.searchMode, "TEXT"))
    .groupBy(sc.provinceKey, sc.areaCode);
  const byProv = new Map<string, CoverageProvince>();
  for (const p of SEARCH_PROVINCES) byProv.set(p.key, { key: p.key, label: p.label, scanned: 0, total: 0, pct: null, newLeads: 0, areas: p.areas.map((a) => ({ code: a.code, name: a.name, scanned: 0, total: keywords.length, newLeads: 0, lastScannedAt: null })) });
  for (const r of rows) {
    let prov = byProv.get(r.province);
    if (!prov) {
      prov = { key: r.province, label: r.provinceLabel, scanned: 0, total: 0, pct: null, newLeads: 0, areas: [] };
      byProv.set(r.province, prov);
    }
    let area = prov.areas.find((a) => a.code === r.area);
    if (!area) {
      area = { code: r.area, name: r.areaName, scanned: 0, total: Math.max(keywords.length, Number(r.cells)), newLeads: 0, lastScannedAt: null };
      prov.areas.push(area);
    }
    area.scanned = Math.min(area.total, Number(r.scanned));
    area.newLeads = Number(r.newLeads);
    const last = r.last ? new Date(r.last) : null;
    area.lastScannedAt = last ? last.toISOString() : null;
  }
  for (const prov of byProv.values()) {
    prov.total = prov.areas.reduce((x, a) => x + a.total, 0);
    prov.scanned = prov.areas.reduce((x, a) => x + a.scanned, 0);
    prov.newLeads = prov.areas.reduce((x, a) => x + a.newLeads, 0);
    prov.pct = prov.total ? Math.round((prov.scanned / prov.total) * 1000) / 10 : null;
  }
  return { provinces: [...byProv.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1)), keywordCount: keywords.length };
}

export async function apiUsageSummary(now = new Date()) {
  const db = await getDb();
  const u = schema.wholesaleApiUsage;
  const dayStart = vnStartOfDay(vnDateKey(now));
  const monthStart = vnStartOfMonth(now);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const [[totals], bySku, byDay, errors] = await Promise.all([
    db
      .select({
        todayMicros: sql<string>`coalesce(sum(${u.costMicros}) filter (where ${u.at} >= ${dayStart}), 0)`,
        monthMicros: sql<string>`coalesce(sum(${u.costMicros}) filter (where ${u.at} >= ${monthStart}), 0)`,
        allMicros: sql<string>`coalesce(sum(${u.costMicros}), 0)`,
        callsToday: sql<string>`count(*) filter (where ${u.at} >= ${dayStart} and ${u.provider} = 'GOOGLE_PLACES')`,
        callsMonth: sql<string>`count(*) filter (where ${u.at} >= ${monthStart} and ${u.provider} = 'GOOGLE_PLACES')`,
        errorsToday: sql<string>`count(*) filter (where ${u.at} >= ${dayStart} and not ${u.ok})`,
      })
      .from(u),
    db
      .select({ sku: u.sku, method: u.method, calls: count(), micros: sql<string>`coalesce(sum(${u.costMicros}), 0)`, avgMs: sql<string>`round(avg(${u.durationMs}))`, results: sql<string>`coalesce(sum(${u.resultCount}), 0)`, newCount: sql<string>`coalesce(sum(${u.newCount}), 0)` })
      .from(u)
      .where(gte(u.at, monthStart))
      .groupBy(u.sku, u.method)
      .orderBy(desc(sql`sum(${u.costMicros})`)),
    db
      .select({ day: sql<string>`to_char(${u.at} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`, calls: count(), micros: sql<string>`coalesce(sum(${u.costMicros}), 0)` })
      .from(u)
      .where(and(gte(u.at, since30), eq(u.provider, "GOOGLE_PLACES")))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db.select().from(u).where(and(eq(u.ok, false), gte(u.at, since30))).orderBy(desc(u.at)).limit(20),
  ]);
  const cfg = await getLeadHunterConfig();
  const counts = await billableCallsBySku(monthStart, dayStart);
  const paid = paidCostMicros(cfg, counts.month, counts.today);
  return {
    // Tiền thật (đã trừ phần miễn phí theo tháng của từng SKU) — cùng phép tính với trần chi tiêu của máy quét.
    todayMicros: paid.todayMicros,
    monthMicros: paid.monthMicros,
    freeUsed: counts.month,
    allMicros: Number(totals?.allMicros ?? 0),
    callsToday: Number(totals?.callsToday ?? 0),
    callsMonth: Number(totals?.callsMonth ?? 0),
    errorsToday: Number(totals?.errorsToday ?? 0),
    bySku: bySku.map((r) => ({ sku: r.sku, method: r.method, calls: Number(r.calls), micros: r.sku && r.sku in paid.bySku ? (paid.bySku[r.sku as keyof typeof paid.bySku] ?? 0) : Number(r.micros), avgMs: Number(r.avgMs ?? 0), results: Number(r.results), newCount: Number(r.newCount) })),
    byDay: byDay.map((r) => ({ day: r.day, calls: Number(r.calls), micros: Number(r.micros) })),
    errors: errors.map((e) => ({ at: e.at.toISOString(), method: e.method, status: e.httpStatus, query: e.query, error: e.error })),
  };
}

export type OutreachRow = {
  id: string;
  leadId: string;
  leadName: string | null;
  phone: string | null;
  email: string | null;
  facebookUrl: string | null;
  zaloUrl: string | null;
  channel: string;
  status: string;
  message: string;
  preparedBy: string;
  createdAt: string;
  sentAt: string | null;
  result: string | null;
  score: number | null;
  grade: string | null;
  assignee: string | null;
  segmentLabel: string;
  area: string | null;
};

export async function outreachQueue(decision: ScopeDecision, statuses: string[]): Promise<OutreachRow[]> {
  const db = await getDb();
  const o = schema.wholesaleOutreachItems;
  const where = andScope(inArray(o.status, statuses.length ? statuses : ["DRAFT", "APPROVED", "SENT"]), decision);
  const rows = await db
    .select({
      id: o.id,
      leadId: o.leadId,
      leadName: NAME,
      phone: PHONE,
      email: l.email,
      facebookUrl: l.facebookUrl,
      zaloUrl: l.zaloUrl,
      channel: o.channel,
      status: o.status,
      message: o.message,
      preparedBy: o.preparedBy,
      createdAt: o.createdAt,
      sentAt: o.sentAt,
      result: o.result,
      score: l.leadScore,
      grade: l.leadGrade,
      assignee: l.assignedToName,
      segment: l.segment,
      area: sql<string | null>`concat_ws(', ', ${l.areaName}, ${l.provinceLabel})`,
    })
    .from(o)
    .innerJoin(l, eq(l.id, o.leadId))
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(where)
    .orderBy(sql`case ${o.status} when 'SENT' then 0 when 'APPROVED' then 1 else 2 end`, sql`${l.leadScore} desc nulls last`, asc(o.createdAt))
    .limit(300);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    segmentLabel: isLeadSegmentKey(r.segment) ? LEAD_SEGMENT_LABEL[r.segment] : r.segment,
  }));
}

export async function suppressionList() {
  const db = await getDb();
  const t = schema.wholesaleSuppressions;
  return db.select().from(t).orderBy(desc(t.createdAt)).limit(500);
}

// ═══════════ BẢNG HIỆU QUẢ ═══════════

export const COMPARE_DIMENSIONS = ["keyword", "segment", "province", "campaign", "assignee", "source"] as const;
export type CompareDimension = (typeof COMPARE_DIMENSIONS)[number];
export const COMPARE_DIMENSION_LABEL: Record<CompareDimension, string> = {
  keyword: "Từ khoá tìm",
  segment: "Nhóm khách",
  province: "Tỉnh / thành",
  campaign: "Chiến dịch",
  assignee: "Người phụ trách",
  source: "Nguồn lead",
};

export type FunnelCounts = { discovered: number; qualified: number; contacted: number; responded: number; interested: number; negotiating: number; won: number };

export type CompareRow = FunnelCounts & {
  key: string;
  label: string;
  revenue: number;
  /** Doanh thu / 100 lead — `null` khi mẫu < 20 lead (một con số từ 3 lead không nói gì về 100 lead). */
  revenuePer100: number | null;
  /** Tỷ lệ chốt WON / lead — `null` khi mẫu < 20. */
  winRate: number | null;
  costMicros: number | null;
};

const MIN_SAMPLE = 20;

/**
 * Bảng hiệu quả: KPI, phễu, so sánh theo chiều. Kỳ lọc theo NGÀY TÌM THẤY lead (`first_seen_at`) — câu hỏi là «lead tìm
 * trong kỳ này rồi ra sao», không phải «tuần này chốt được bao nhiêu».
 */
export async function wholesaleDashboard(opts: { from: Date | null; to: Date | null; dimension: CompareDimension; decision: ScopeDecision; now?: Date }) {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const conds: SQL[] = [notInArray(l.enrichmentStatus, ["FILTERED", "DUPLICATE", "FAILED"])];
  if (opts.from) conds.push(gte(l.firstSeenAt, opts.from));
  if (opts.to) conds.push(sql`${l.firstSeenAt} <= ${opts.to}`);
  const where = andScope(and(...conds), opts.decision);
  const inList = (list: readonly string[]) => sql`${l.contactStatus} in (${sql.join(list.map((x) => sql`${x}`), sql`, `)})`;
  const funnelCols = {
    discovered: sql<string>`count(*)`,
    qualified: sql<string>`count(*) filter (where ${l.qualifiedAt} is not null or ${l.contactStatus} not in ('NEW'))`,
    contacted: sql<string>`count(*) filter (where ${l.firstContactAt} is not null or ${inList(CONTACTED_STATUSES)})`,
    responded: sql<string>`count(*) filter (where ${l.firstResponseAt} is not null or ${inList(RESPONDED_STATUSES)})`,
    interested: sql<string>`count(*) filter (where ${inList(INTERESTED_STATUSES)})`,
    negotiating: sql<string>`count(*) filter (where ${inList(NEGOTIATING_STATUSES)})`,
    won: sql<string>`count(*) filter (where ${l.contactStatus} = 'WON')`,
  };
  const dimExpr: Record<CompareDimension, SQL> = {
    keyword: sql`coalesce((select sc.keyword from wholesale_search_cells sc where sc.id = "wholesale_leads"."source_cell_id"), case when ${l.source} = 'MANUAL_IMPORT' then '(nhập tệp)' else '(không rõ)' end)`,
    segment: sql`${l.segment}`,
    province: sql`coalesce(${l.provinceLabel}, '(chưa rõ tỉnh)')`,
    campaign: sql`coalesce(${l.sourceCampaignId}, '(không chiến dịch)')`,
    assignee: sql`coalesce(${l.assignedToName}, '(chưa giao)')`,
    source: sql`${l.source}`,
  };
  const dim = dimExpr[opts.dimension];
  const dayStart = vnStartOfDay(vnDateKey(now));
  const [[kpi], groups, converted, campaignNames, usageAll] = await Promise.all([
    db
      .select({
        ...funnelCols,
        newToday: sql<string>`count(*) filter (where ${l.firstSeenAt} >= ${dayStart})`,
        gradeA: sql<string>`count(*) filter (where ${l.leadGrade} = 'A')`,
        withPhone: sql<string>`count(*) filter (where ${PHONE} is not null)`,
        catalogSent: sql<string>`count(*) filter (where ${l.contactStatus} in ('CATALOG_SENT','PRICE_SENT','SAMPLE_REQUESTED','NEGOTIATING','WON'))`,
        negotiatingNow: sql<string>`count(*) filter (where ${l.contactStatus} = 'NEGOTIATING')`,
      })
      .from(l)
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(where),
    db
      .select({ key: sql<string>`${dim}`, ...funnelCols })
      .from(l)
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(where)
      .groupBy(sql`1`),
    db
      .select({ key: sql<string>`${dim}`, customerId: l.customerId })
      .from(l)
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(and(where, isNotNull(l.customerId))),
    db.select({ id: schema.wholesaleCampaigns.id, name: schema.wholesaleCampaigns.name }).from(schema.wholesaleCampaigns),
    db
      .select({ campaignId: schema.wholesaleApiUsage.campaignId, micros: sql<string>`coalesce(sum(${schema.wholesaleApiUsage.costMicros}), 0)` })
      .from(schema.wholesaleApiUsage)
      .where(and(opts.from ? gte(schema.wholesaleApiUsage.at, opts.from) : undefined, opts.to ? sql`${schema.wholesaleApiUsage.at} <= ${opts.to}` : undefined))
      .groupBy(schema.wholesaleApiUsage.campaignId),
  ]);
  const rev = await deliveredRevenueByCustomer([...new Set(converted.map((c) => c.customerId!).filter(Boolean))]);
  const revByKey = new Map<string, number>();
  let totalRevenue = 0;
  const seenCustomer = new Set<string>();
  for (const c of converted) {
    const r = rev.get(c.customerId!)?.revenue ?? 0;
    revByKey.set(c.key, (revByKey.get(c.key) ?? 0) + r);
    if (!seenCustomer.has(c.customerId!)) {
      seenCustomer.add(c.customerId!);
      totalRevenue += r;
    }
  }
  const campName = new Map(campaignNames.map((c) => [c.id, c.name]));
  const costByCampaign = new Map(usageAll.map((u) => [u.campaignId ?? "", Number(u.micros)]));
  const totalCost = usageAll.reduce((x, u) => x + Number(u.micros), 0);
  const num = (v: string | number | null | undefined) => Number(v ?? 0);
  const f = (r: Record<keyof FunnelCounts, string>): FunnelCounts => ({ discovered: num(r.discovered), qualified: num(r.qualified), contacted: num(r.contacted), responded: num(r.responded), interested: num(r.interested), negotiating: num(r.negotiating), won: num(r.won) });
  const funnel = f(kpi as Record<keyof FunnelCounts, string>);
  const labelOf = (key: string): string => {
    if (opts.dimension === "segment") return isLeadSegmentKey(key) ? LEAD_SEGMENT_LABEL[key] : key;
    if (opts.dimension === "campaign") return campName.get(key) ?? key;
    if (opts.dimension === "source") return LEAD_SOURCE_LABEL[key as LeadSourceKey] ?? key;
    return key;
  };
  const rows: CompareRow[] = groups
    .map((g) => {
      const fc = f(g as unknown as Record<keyof FunnelCounts, string>);
      const revenue = revByKey.get(g.key) ?? 0;
      return {
        key: g.key,
        label: labelOf(g.key),
        ...fc,
        revenue,
        revenuePer100: fc.discovered >= MIN_SAMPLE ? Math.round((revenue / fc.discovered) * 100) : null,
        winRate: fc.discovered >= MIN_SAMPLE ? fc.won / fc.discovered : null,
        costMicros: opts.dimension === "campaign" ? (costByCampaign.get(g.key) ?? 0) : null,
      };
    })
    .sort((a, b) => (b.revenuePer100 ?? -1) - (a.revenuePer100 ?? -1) || b.won - a.won || b.discovered - a.discovered);
  return {
    funnel,
    kpi: {
      total: funnel.discovered,
      newToday: num(kpi?.newToday),
      gradeA: num(kpi?.gradeA),
      withPhone: num(kpi?.withPhone),
      contacted: funnel.contacted,
      responseRate: funnel.contacted ? funnel.responded / funnel.contacted : null,
      interestedRate: funnel.contacted ? funnel.interested / funnel.contacted : null,
      catalogSent: num(kpi?.catalogSent),
      negotiating: num(kpi?.negotiatingNow),
      won: funnel.won,
      conversionRate: funnel.discovered ? funnel.won / funnel.discovered : null,
      revenue: totalRevenue,
      revenuePer100: funnel.discovered >= MIN_SAMPLE ? Math.round((totalRevenue / funnel.discovered) * 100) : null,
      costMicros: totalCost,
      costPerQualifiedMicros: funnel.qualified ? Math.round(totalCost / funnel.qualified) : null,
      costPerWonMicros: funnel.won ? Math.round(totalCost / funnel.won) : null,
    },
    rows,
    minSample: MIN_SAMPLE,
  };
}
