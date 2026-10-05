import { and, asc, type Column, count, eq, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { openActiveConnection } from "@/lib/connectors/service";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { normalizeProvince, provinceRegion } from "@/lib/constants/vn-regions";
import { vnDateKey } from "@/lib/format";
import { placesRelayOf, type PlaceRecord, type PlacesClientDeps } from "@/lib/integrations/google-places/client";
import { searchProvince } from "@/lib/wholesale/areas";
import { freeTierLeft, nextCallCostMicros, quotaRetryAt, type LeadHunterConfig, type PlacesSku } from "@/lib/wholesale/config";
import { ACTIVE_PIPELINE_STATUSES, type PauseReason, PAUSE_REASON_LABEL } from "@/lib/wholesale/constants";
import { competitorHit } from "@/lib/wholesale/competitor";
import { branchHint, chainBrandHit, nameAddressKey, socialKind, websiteDomain } from "@/lib/wholesale/dedupe";
import { normalizeVnPhone, type PhoneKind } from "@/lib/wholesale/phone";
import { googlePlacesProvider, websiteEnrichmentProvider, type DiscoveryProvider, type EnrichmentProvider } from "@/lib/wholesale/providers";
import { learnedAdjustment, scoreLead, type ScoreResult, type SegmentOutcomeStats } from "@/lib/wholesale/scoring";
import { classifySegment, foldVietnamese, isLeadSegmentKey, type LeadSegment } from "@/lib/wholesale/segments";
import { currentSpend, getLeadHunterConfig, notifyOwners, recordUsage, segmentOutcomeStats, suppressionHit } from "@/lib/wholesale/store";
import type { WebsiteDeps } from "@/lib/wholesale/website";

/**
 * ═══════════ SĂN KHÁCH SỈ — LÕI QUÉT NỀN ═══════════
 *
 * Một LƯỢT (`runLeadHunterTick`) làm việc trong một trần thời gian rồi dừng; job `wholesale-leads` gọi lượt mỗi vài
 * phút cho từng tổ chức. Không có vòng chạy dài trong một yêu cầu HTTP.
 *
 * ─── VÌ SAO CHẠY LẠI / TẠM DỪNG / CHẾT GIỮA CHỪNG ĐỀU AN TOÀN ───
 *
 *  · Tiến độ nằm ở TỪNG DÒNG: ô quét (`wholesale_campaign_cells`: trạng thái, `page_token`, số trang) và lead
 *    (`enrichment_status`, `details_next_at`). Lượt sau đọc đúng chỗ lượt trước dừng.
 *  · Ô đang xử lý giữ bằng KHOÁ THUÊ (`locked_until`), không bằng cờ: lượt chết giữa chừng thì hết thuê, lượt sau lấy lại.
 *  · Mọi lượt ghi là UPSERT theo khoá tự nhiên: lead theo `place_id` (UNIQUE), lượt thấy theo (chiến dịch, place_id),
 *    snapshot theo `place_id`. Quét lại cùng trang mười lần vẫn MỘT lead.
 *  · Tạm dừng = đổi trạng thái chiến dịch; lượt đang chạy kiểm lại trạng thái TRƯỚC mỗi lượt gọi API.
 *
 * ─── TIỀN ───
 *
 * Trước MỖI lượt gọi tính tiền: chi hôm nay + đơn giá ≤ trần ngày, chi tháng + đơn giá ≤ trần tháng, số lượt hôm nay < trần
 * lượt. Chạm trần ⇒ tạm dừng MỌI chiến dịch đang chạy, ghi lý do, báo chủ shop (một tin mỗi ngày), dừng lượt. Trần ngày /
 * lượt tự mở lại từ 0 giờ hôm sau, trần tháng từ ngày 1 tháng sau (giờ VN) — cùng nghĩa với chữ «trần ngày».
 */

export type TickDeps = {
  now?: () => Date;
  /** Bài kiểm đưa nhà cung cấp giả vào — bỏ qua bước mở kết nối. */
  provider?: DiscoveryProvider;
  places?: PlacesClientDeps;
  enricher?: EnrichmentProvider;
  website?: WebsiteDeps;
  sleep?: (ms: number) => Promise<void>;
};

export type TickOptions = { budgetMs?: number; trigger?: string };

export type TickResult = {
  skipped: string | null;
  detail: string;
  calls: number;
  costMicros: number;
  newLeads: number;
  detailsDone: number;
  websitesDone: number;
  refreshed: number;
  purged: number;
  paused: { campaignId: string; reason: PauseReason }[];
  completed: string[];
  /** Lead vừa tự lên «Đủ điều kiện» trong lượt này — tầng job soạn sẵn lời chào nếu cấu hình bật. */
  qualified: string[];
};

type Campaign = typeof schema.wholesaleCampaigns.$inferSelect;
type Lead = typeof schema.wholesaleLeads.$inferSelect;
type Snapshot = typeof schema.wholesalePlaceSnapshots.$inferSelect;

const LEASE_MS = 3 * 60_000;
const MAX_CELL_ATTEMPTS = 3;
const MAX_DETAILS_ATTEMPTS = 3;
const REFRESH_AHEAD_MS = 3 * 86_400_000;

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** Khoá ngày / tháng VN của một mốc — để biết trần đã «mở lại» chưa. */
function periodKeys(d: Date): { day: string; month: string } {
  const day = vnDateKey(d);
  return { day, month: day.slice(0, 7) };
}

/**
 * Tỉnh của lead: đọc từ địa chỉ (phần cuối nhận ra được là tên tỉnh), không thì tỉnh của Ô đã tìm ra nó. Text Search
 * có thể trả địa điểm ngoài khu vực hỏi — địa chỉ thắng.
 */
export function provinceFromAddress(address: string | null | undefined): { key: string; label: string } | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((p) => p.replace(/\b\d{5,6}\b/g, "").trim())
    .filter((p) => p && !/^vi[eệ]t nam$/i.test(p));
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 3); i--) {
    const reg = provinceRegion(parts[i]);
    if (reg) {
      const known = searchProvince(reg.key);
      return { key: reg.key, label: known?.label ?? parts[i]!.replace(/^(Tỉnh|Thành phố|TP\.?)\s+/i, "") };
    }
  }
  return null;
}

function phoneOf(rec: { nationalPhone: string | null; internationalPhone: string | null }) {
  return normalizeVnPhone(rec.nationalPhone) ?? normalizeVnPhone(rec.internationalPhone);
}

export type LeadView = {
  name: string | null;
  address: string | null;
  phone: string | null;
  phoneKind: PhoneKind | null;
  website: string | null;
  hasOtherChannel: boolean;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  types: string[];
  primaryType: string | null;
  /** Đã xin trường đánh giá (tier ENTERPRISE / DETAILS) — Google bỏ trống ô khi CHƯA có đánh giá nào. */
  ratingsRequested: boolean;
};

/** Ghép dữ liệu của tổ chức (ưu tiên) với snapshot Google còn hạn. */
export function leadView(lead: Lead, snap: Snapshot | null | undefined): LeadView {
  const s = snap && !snap.purgedAt ? snap : null;
  const ownPhone = lead.normalizedPhone ? normalizeVnPhone(lead.normalizedPhone) : null;
  const gPhone = s ? phoneOf(s) : null;
  const phone = ownPhone?.normalized ? ownPhone : gPhone;
  return {
    name: lead.businessName ?? s?.displayName ?? null,
    address: lead.address ?? s?.formattedAddress ?? null,
    phone: phone?.normalized ?? null,
    phoneKind: phone?.normalized ? phone.kind : null,
    website: lead.website ?? s?.websiteUri ?? null,
    hasOtherChannel: Boolean(lead.email || lead.facebookUrl || lead.zaloUrl),
    rating: s?.rating ?? null,
    reviewCount: s?.userRatingCount ?? null,
    businessStatus: s?.businessStatus ?? null,
    types: s?.types ?? [],
    primaryType: s?.primaryType ?? null,
    ratingsRequested: Boolean(s && (s.fieldsTier === "ENTERPRISE" || s.fieldsTier === "DETAILS")),
  };
}

/** Chấm lại một lead từ dữ liệu hiện có — dùng chung cho job, nhập tệp, sửa tay. */
export async function rescoreLead(leadId: string, ctx: { cfg: LeadHunterConfig; stats: SegmentOutcomeStats[]; now: Date }): Promise<ScoreResult | null> {
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  if (!lead) return null;
  const snap = lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) }) : null;
  const v = leadView(lead, snap);
  const [{ siblings }] = await db.select({ siblings: count() }).from(schema.wholesaleLeads).where(eq(schema.wholesaleLeads.duplicateOfLeadId, lead.id));
  const segment: LeadSegment = isLeadSegmentKey(lead.segment) ? lead.segment : "UNCLASSIFIED";
  const learned = learnedAdjustment(segment, ctx.stats, ctx.cfg.learning);
  const result = scoreLead(
    {
      segment,
      segmentEvidence: lead.segmentEvidence,
      reviewCount: v.reviewCount ?? (v.ratingsRequested ? 0 : null),
      rating: v.rating,
      businessStatus: v.businessStatus,
      phoneKind: v.phoneKind,
      hasWebsite: Boolean(v.website),
      hasOtherChannel: v.hasOtherChannel,
      provinceKey: lead.provinceKey,
      provinceLabel: lead.provinceLabel,
      siblingCount: Number(siblings),
      branchHint: branchHint(v.name),
      hasAddress: Boolean(v.address),
      hasName: Boolean(v.name),
    },
    { areas: ctx.cfg.serviceAreas, thresholds: ctx.cfg.gradeThresholds, learned, sizeProfile: ctx.cfg.sizeProfile },
  );
  await db
    .update(schema.wholesaleLeads)
    .set({ leadScore: result.score, leadGrade: result.grade, scoreReasons: { summary: result.summary, components: result.components }, scoredAt: ctx.now })
    .where(eq(schema.wholesaleLeads.id, lead.id));
  return result;
}

async function addActivity(row: typeof schema.wholesaleLeadActivities.$inferInsert): Promise<void> {
  const db = await getDb();
  await db.insert(schema.wholesaleLeadActivities).values({ ...row, note: (row.note ?? "").slice(0, 2000) });
}

/** Ghi / cập nhật snapshot Google. Trường mới trống KHÔNG xoá trường cũ (lượt tìm gọn không xoá SĐT lượt chi tiết đã lấy). */
async function upsertSnapshot(place: PlaceRecord, tier: Snapshot["fieldsTier"], cfg: LeadHunterConfig, now: Date): Promise<void> {
  const db = await getDb();
  const phone = phoneOf(place);
  const values = {
    placeId: place.placeId,
    displayName: place.name,
    formattedAddress: place.address,
    nationalPhone: place.nationalPhone,
    internationalPhone: place.internationalPhone,
    websiteUri: place.website,
    googleMapsUri: place.mapsUrl,
    primaryType: place.primaryType,
    types: place.types,
    rating: place.rating,
    userRatingCount: place.reviewCount,
    businessStatus: place.businessStatus,
    lat: place.lat,
    lng: place.lng,
    normalizedPhone: phone?.normalized ?? null,
    phoneKind: phone?.normalized ? phone.kind : null,
    websiteDomain: websiteDomain(place.website),
    nameKey: nameAddressKey(place.name, place.address),
    fieldsTier: tier,
    fetchedAt: now,
    detailsFetchedAt: tier === "DETAILS" ? now : null,
    expiresAt: addMs(now, cfg.googleRetentionDays * 86_400_000),
    purgedAt: null,
  };
  const s = schema.wholesalePlaceSnapshots;
  const keep = (col: string) => sql.raw(`coalesce(excluded."${col}", "wholesale_place_snapshots"."${col}")`);
  await db
    .insert(s)
    .values(values)
    .onConflictDoUpdate({
      target: s.placeId,
      set: {
        displayName: keep("display_name"),
        formattedAddress: keep("formatted_address"),
        nationalPhone: keep("national_phone"),
        internationalPhone: keep("international_phone"),
        websiteUri: keep("website_uri"),
        googleMapsUri: keep("google_maps_uri"),
        primaryType: keep("primary_type"),
        types: sql`case when cardinality(excluded."types") > 0 then excluded."types" else "wholesale_place_snapshots"."types" end`,
        rating: keep("rating"),
        userRatingCount: keep("user_rating_count"),
        businessStatus: keep("business_status"),
        lat: keep("lat"),
        lng: keep("lng"),
        normalizedPhone: keep("normalized_phone"),
        phoneKind: keep("phone_kind"),
        websiteDomain: keep("website_domain"),
        nameKey: keep("name_key"),
        fieldsTier: sql`case when excluded."fields_tier" in ('DETAILS','ENTERPRISE') or "wholesale_place_snapshots"."purged_at" is not null then excluded."fields_tier" else "wholesale_place_snapshots"."fields_tier" end`,
        fetchedAt: now,
        detailsFetchedAt: sql`coalesce(excluded."details_fetched_at", "wholesale_place_snapshots"."details_fetched_at")`,
        expiresAt: values.expiresAt,
        purgedAt: null,
        updatedAt: now,
      },
    });
}

/** Lead khác (đang sống — không bị lọc / trùng) mang cùng SĐT / tên miền / khoá tên-địa chỉ. Lâu đời nhất thắng. */
/**
 * Số địa điểm Google KHÁC NHAU đã thấy mang cùng phần TÊN (khoá tên của `nameAddressKey`, khác địa chỉ) — dấu hiệu chuỗi
 * nhiều chi nhánh. Chỉ đếm snapshot có số nhà (khoá tên + địa chỉ đủ cụ thể); không có khoá ⇒ 0, không đoán.
 */
async function sameNamePlaces(name: string | null, address: string | null): Promise<number> {
  const key = nameAddressKey(name, address);
  const namePart = key?.split("|")[0];
  if (!namePart) return 0;
  const db = await getDb();
  const s = schema.wholesalePlaceSnapshots;
  const [row] = await db.select({ n: sql<string>`count(distinct ${s.placeId})` }).from(s).where(sql`${s.nameKey} like ${`${namePart}|%`}`);
  return Number(row?.n ?? 0);
}

export async function findMasterLead(selfId: string | null, key: { phone?: string | null; domain?: string | null; nameKey?: string | null }): Promise<{ id: string; by: "PHONE" | "DOMAIN" | "NAME" } | null> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const s = schema.wholesalePlaceSnapshots;
  const alive = and(notInArray(l.enrichmentStatus, ["FILTERED", "DUPLICATE"]), selfId ? ne(l.id, selfId) : undefined);
  const probes: { by: "PHONE" | "DOMAIN" | "NAME"; leadCol: Column; snapCol: Column; value: string }[] = [];
  if (key.phone) probes.push({ by: "PHONE", leadCol: l.normalizedPhone, snapCol: s.normalizedPhone, value: key.phone });
  if (key.domain) probes.push({ by: "DOMAIN", leadCol: l.websiteDomain, snapCol: s.websiteDomain, value: key.domain });
  if (key.nameKey) probes.push({ by: "NAME", leadCol: l.nameKey, snapCol: s.nameKey, value: key.nameKey });
  for (const p of probes) {
    const [row] = await db
      .select({ id: l.id })
      .from(l)
      .leftJoin(s, and(eq(s.placeId, l.placeId), isNull(s.purgedAt)))
      .where(and(alive, or(eq(p.leadCol, p.value), eq(p.snapCol, p.value))))
      .orderBy(asc(l.firstSeenAt), asc(l.id))
      .limit(1);
    if (row) return { id: row.id, by: p.by };
  }
  return null;
}

type Ctx = {
  cfg: LeadHunterConfig;
  now: () => Date;
  deadline: number;
  provider: DiscoveryProvider | null;
  enricher: EnrichmentProvider;
  stats: SegmentOutcomeStats[];
  spend: { today: number; month: number; calls: number; dayKey: string; monthKey: string; monthBySku: Record<string, number> };
  result: TickResult;
  stop: PauseReason | null;
  sleep: (ms: number) => Promise<void>;
};

/** Trần trước một lượt gọi tính tiền. `null` = được gọi. */
function budgetBlock(ctx: Ctx, sku: PlacesSku): PauseReason | null {
  // Chế độ chỉ dùng miễn phí: chặn TRƯỚC lượt làm vượt hạn mức của đúng SKU sắp gọi (Google tính theo SKU, không theo tiền).
  if (ctx.cfg.freeTier.enabled && freeTierLeft(ctx.cfg, sku, ctx.spend.monthBySku[sku] ?? 0) <= 0) return "FREE_TIER";
  const cost = nextCallCostMicros(ctx.cfg, sku, ctx.spend.monthBySku[sku] ?? 0);
  const dayCap = Math.round(ctx.cfg.budget.dailyUsd * 1_000_000);
  const monthCap = Math.round(ctx.cfg.budget.monthlyUsd * 1_000_000);
  if (ctx.spend.calls >= ctx.cfg.budget.dailyRequestLimit) return "REQUEST_LIMIT";
  if (ctx.spend.month + cost > monthCap) return "BUDGET_MONTHLY";
  if (ctx.spend.today + cost > dayCap) return "BUDGET_DAILY";
  return null;
}

function charge(ctx: Ctx, costMicros: number, sku: PlacesSku, billable: boolean) {
  if (billable) ctx.spend.monthBySku[sku] = (ctx.spend.monthBySku[sku] ?? 0) + 1;
  ctx.spend.today += costMicros;
  ctx.spend.month += costMicros;
  ctx.spend.calls += 1;
  ctx.result.calls += 1;
  ctx.result.costMicros += costMicros;
}

async function pauseRunning(ctx: Ctx, reason: PauseReason, detail: string): Promise<void> {
  const db = await getDb();
  const now = ctx.now();
  const rows = await db
    .update(schema.wholesaleCampaigns)
    .set({ status: "PAUSED", pauseReason: reason, pausedAt: now, lastError: detail.slice(0, 500), updatedAt: now })
    .where(eq(schema.wholesaleCampaigns.status, "RUNNING"))
    .returning({ id: schema.wholesaleCampaigns.id, name: schema.wholesaleCampaigns.name });
  for (const r of rows) ctx.result.paused.push({ campaignId: r.id, reason });
  ctx.stop = reason;
  if (rows.length) {
    const keys = periodKeys(now);
    await notifyOwners({
      title: "Săn khách sỉ đã tự tạm dừng",
      body: `${PAUSE_REASON_LABEL[reason]}. ${detail} Chiến dịch: ${rows.map((r) => r.name).join(", ")}.`,
      href: "/wholesale/lead-hunter",
      dedupeKey: `wholesale:pause:${reason}:${reason === "BUDGET_MONTHLY" ? keys.month : keys.day}`,
      severity: reason === "API_AUTH" ? "critical" : "warning",
      now,
    });
  }
}

/** Chiến dịch tạm dừng vì trần ngày / tháng tự chạy lại khi sang ngày / tháng mới và trần cho phép. */
async function autoResume(ctx: Ctx): Promise<void> {
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  const paused = await db.select().from(c).where(and(eq(c.status, "PAUSED"), inArray(c.pauseReason, ["BUDGET_DAILY", "BUDGET_MONTHLY", "REQUEST_LIMIT", "FREE_TIER", "NO_CONNECTION"])));
  const now = ctx.now();
  const nowKeys = periodKeys(now);
  // Máy tự dừng vì kết nối chưa bật ⇒ máy tự chạy lại khi kết nối bật lại (người bấm «Bật» là đủ, không phải nhớ bấm «Tiếp tục»).
  const connected = paused.some((p) => p.pauseReason === "NO_CONNECTION") && (await openActiveConnection("google-places")).ok;
  for (const camp of paused) {
    if (camp.pauseReason === "NO_CONNECTION") {
      if (connected) await db.update(c).set({ status: "RUNNING", pauseReason: null, pausedAt: null, lastError: null, updatedAt: now }).where(and(eq(c.id, camp.id), eq(c.status, "PAUSED")));
      continue;
    }
    if (!camp.pausedAt) continue;
    const at = periodKeys(camp.pausedAt);
    const monthly = camp.pauseReason === "BUDGET_MONTHLY" || camp.pauseReason === "FREE_TIER";
    const reset = monthly ? at.month !== nowKeys.month : at.day !== nowKeys.day;
    if (!reset) continue;
    if (budgetBlock(ctx, searchSkuOf(camp.searchMode, camp.discoveryTier))) continue; // vẫn chạm trần ⇒ chờ
    await db.update(c).set({ status: "RUNNING", pauseReason: null, pausedAt: null, lastError: null, updatedAt: now }).where(and(eq(c.id, camp.id), eq(c.status, "PAUSED")));
  }
}

function searchSkuOf(searchMode: string, discoveryTier: string): PlacesSku {
  const tier = discoveryTier as "IDS_ONLY" | "PRO" | "ENTERPRISE";
  if (searchMode === "NEARBY") return tier === "ENTERPRISE" ? "NEARBY_SEARCH_ENTERPRISE" : "NEARBY_SEARCH_PRO";
  return tier === "IDS_ONLY" ? "TEXT_SEARCH_IDS" : tier === "PRO" ? "TEXT_SEARCH_PRO" : "TEXT_SEARCH_ENTERPRISE";
}

function blockDetail(ctx: Ctx, reason: PauseReason, sku: PlacesSku): string {
  if (reason === "FREE_TIER") return `Đã dùng ${ctx.spend.monthBySku[sku] ?? 0}/${ctx.cfg.freeTier.monthlyCalls[sku] ?? 0} lượt miễn phí ${sku} tháng này (giữ ${Math.round(ctx.cfg.freeTier.safetyPct * 100)}% dự phòng).`;
  return `Đã chi ${(ctx.spend.today / 1e6).toFixed(2)} US$ hôm nay / ${(ctx.spend.month / 1e6).toFixed(2)} US$ tháng này, ${ctx.spend.calls} lượt gọi hôm nay.`;
}

async function campaignIsRunning(id: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ status: schema.wholesaleCampaigns.status }).from(schema.wholesaleCampaigns).where(eq(schema.wholesaleCampaigns.id, id)).limit(1);
  return row?.status === "RUNNING";
}

async function campaignLeadCount(campaignId: string): Promise<number> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const [row] = await db
    .select({ n: count() })
    .from(l)
    .where(and(eq(l.sourceCampaignId, campaignId), notInArray(l.enrichmentStatus, ["FILTERED", "DUPLICATE", "FAILED"])));
  return Number(row?.n ?? 0);
}

/** Thuê một ô kế tiếp của chiến dịch (ưu tiên cao trước). Ô RUNNING hết hạn thuê được lấy lại. */
async function claimCell(campaignId: string, now: Date): Promise<(typeof schema.wholesaleCampaignCells.$inferSelect & { cell: typeof schema.wholesaleSearchCells.$inferSelect }) | null> {
  const db = await getDb();
  const cc = schema.wholesaleCampaignCells;
  const due = or(isNull(cc.nextAttemptAt), lte(cc.nextAttemptAt, now));
  const claimable = or(and(eq(cc.status, "PENDING"), due), and(eq(cc.status, "RUNNING"), lt(cc.lockedUntil, now)));
  const [next] = await db
    .select({ id: cc.id })
    .from(cc)
    .where(and(eq(cc.campaignId, campaignId), claimable))
    .orderBy(sql`${cc.priority} desc`, asc(cc.createdAt), asc(cc.id))
    .limit(1);
  if (!next) return null;
  const [row] = await db
    .update(cc)
    .set({ status: "RUNNING", lockedUntil: addMs(now, LEASE_MS), startedAt: sql`coalesce(${cc.startedAt}, ${now})`, updatedAt: now })
    .where(and(eq(cc.id, next.id), claimable))
    .returning();
  if (!row) return null; // lượt khác vừa lấy
  const cell = await db.query.wholesaleSearchCells.findFirst({ where: eq(schema.wholesaleSearchCells.id, row.cellId) });
  if (!cell) return null;
  return { ...row, cell };
}

type PlaceOutcome = "NEW_LEAD" | "EXISTING_LEAD" | "FILTERED" | "SUPPRESSED" | "DUPLICATE" | "SEEN";

/** Một địa điểm vừa tìm thấy ⇒ một kết cục. Idempotent: gọi lại với cùng (chiến dịch, place) ⇒ `SEEN`. */
async function handleDiscoveredPlace(ctx: Ctx, camp: Campaign, cell: typeof schema.wholesaleSearchCells.$inferSelect, place: PlaceRecord): Promise<PlaceOutcome> {
  const db = await getDb();
  const now = ctx.now();
  const tier = camp.discoveryTier as "IDS_ONLY" | "PRO" | "ENTERPRISE";
  const hitInsert = await db
    .insert(schema.wholesalePlaceHits)
    .values({ campaignId: camp.id, cellId: cell.id, placeId: place.placeId, outcome: "FILTERED", reason: "PENDING" })
    .onConflictDoNothing({ target: [schema.wholesalePlaceHits.campaignId, schema.wholesalePlaceHits.placeId] })
    .returning({ id: schema.wholesalePlaceHits.id });
  if (!hitInsert.length) return "SEEN";
  const hitId = hitInsert[0]!.id;
  const setHit = (outcome: Exclude<PlaceOutcome, "SEEN">, reason: string | null, leadId: string | null) =>
    db.update(schema.wholesalePlaceHits).set({ outcome, reason, leadId }).where(eq(schema.wholesalePlaceHits.id, hitId));

  const existing = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.placeId, place.placeId) });
  if (existing) {
    if (existing.contactStatus !== "DO_NOT_CONTACT") {
      await db.insert(schema.wholesaleLeadCampaigns).values({ leadId: existing.id, campaignId: camp.id }).onConflictDoNothing();
    }
    // Snapshot sắp / đã hết hạn được làm mới miễn phí bằng chính trường vừa trả về (không xoá trường đắt hơn đã có).
    if (tier !== "IDS_ONLY") await upsertSnapshot(place, tier, ctx.cfg, now);
    await setHit("EXISTING_LEAD", null, existing.id);
    return "EXISTING_LEAD";
  }

  if (await suppressionHit({ placeId: place.placeId })) {
    await setHit("SUPPRESSED", "PLACE", null);
    return "SUPPRESSED";
  }

  const seg = classifySegment({ name: place.name, primaryType: place.primaryType, types: place.types });
  if (tier !== "IDS_ONLY") {
    if (place.businessStatus === "CLOSED_PERMANENTLY" || place.businessStatus === "CLOSED_TEMPORARILY") {
      await setHit("FILTERED", place.businessStatus === "CLOSED_PERMANENTLY" ? "CLOSED" : "CLOSED_TEMPORARILY", null);
      return "FILTERED";
    }
    const folded = foldVietnamese(place.name);
    const excluded = camp.excludeKeywords.find((k) => {
      const f = foldVietnamese(k).trim();
      return f && folded.includes(` ${f} `);
    });
    if (excluded) {
      await setHit("FILTERED", "EXCLUDED_KEYWORD", null);
      return "FILTERED";
    }
    // Chuỗi lớn / nơi quá đông — lọc TRƯỚC khi tốn lượt chi tiết (mức PRO) và trước khi thành lead.
    if (ctx.cfg.chainFilter.enabled && chainBrandHit(place.name, ctx.cfg.chainFilter.brands)) {
      await setHit("FILTERED", "CHAIN", null);
      return "FILTERED";
    }
    if (ctx.cfg.maxReviews != null && place.reviewCount != null && place.reviewCount > ctx.cfg.maxReviews) {
      await setHit("FILTERED", "TOO_LARGE", null);
      return "FILTERED";
    }
    if (competitorHit(place.name, (provinceFromAddress(place.address) ?? { key: cell.provinceKey }).key, ctx.cfg.competitorFilter)) {
      await setHit("FILTERED", "COMPETITOR", null);
      return "FILTERED";
    }
    if (camp.targetSegments.length && seg.segment !== "UNCLASSIFIED" && !camp.targetSegments.includes(seg.segment)) {
      await setHit("FILTERED", "SEGMENT", null);
      return "FILTERED";
    }
    const master = await findMasterLead(null, { nameKey: nameAddressKey(place.name, place.address) });
    if (master) {
      await setHit("DUPLICATE", "DUPLICATE_NAME", master.id);
      return "DUPLICATE";
    }
  }

  const prov = provinceFromAddress(place.address) ?? { key: cell.provinceKey, label: cell.provinceLabel };
  const inCell = normalizeProvince(prov.key) === cell.provinceKey;
  await upsertSnapshot(place, tier, ctx.cfg, now);
  const inserted = await db
    .insert(schema.wholesaleLeads)
    .values({
      placeId: place.placeId,
      source: "GOOGLE_PLACES",
      provinceKey: prov.key,
      provinceLabel: prov.label,
      areaCode: inCell ? cell.areaCode : null,
      areaName: inCell ? cell.areaName : null,
      segment: seg.segment,
      segmentEvidence: tier === "IDS_ONLY" ? null : seg.evidence,
      sourceQuery: cell.queryText,
      sourceCampaignId: camp.id,
      sourceCellId: cell.id,
      enrichmentStatus: tier === "ENTERPRISE" ? "READY" : "PENDING_DETAILS",
      detailsNextAt: tier === "ENTERPRISE" ? null : now,
      firstSeenAt: now,
    })
    .onConflictDoNothing({ target: schema.wholesaleLeads.placeId })
    .returning({ id: schema.wholesaleLeads.id });
  if (!inserted.length) {
    // Lượt song song vừa tạo cùng địa điểm — vẫn MỘT lead.
    const other = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.placeId, place.placeId) });
    await setHit("EXISTING_LEAD", null, other?.id ?? null);
    return "EXISTING_LEAD";
  }
  const leadId = inserted[0]!.id;
  await db.insert(schema.wholesaleLeadCampaigns).values({ leadId, campaignId: camp.id }).onConflictDoNothing();
  await addActivity({ leadId, kind: "DISCOVERED", note: `Tìm thấy qua «${cell.queryText}» (chiến dịch «${camp.name}»)`, actorId: null, actorName: "Máy" });
  await setHit("NEW_LEAD", null, leadId);
  if (tier === "ENTERPRISE" && (await finalizeLead(ctx, leadId, camp)) === "QUALIFIED") ctx.result.qualified.push(leadId);
  return "NEW_LEAD";
}

/**
 * Lead đã có đủ dữ liệu liên hệ (sau chi tiết, hoặc ngay sau lượt tìm Enterprise) ⇒ lọc theo chiến dịch, khử trùng SĐT /
 * website, chấm điểm, tự lên «Đủ điều kiện», xếp hàng đọc website.
 */
export async function finalizeLead(ctx: Pick<Ctx, "cfg" | "now" | "stats">, leadId: string, camp: Campaign | null): Promise<"QUALIFIED" | "READY" | "FILTERED" | "DUPLICATE" | "MISSING"> {
  const db = await getDb();
  const now = ctx.now();
  const l = schema.wholesaleLeads;
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(l.id, leadId) });
  if (!lead) return "MISSING";
  const snap = lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) }) : null;
  const v = leadView(lead, snap);
  const domain = lead.websiteDomain ?? websiteDomain(v.website);

  const filter = async (reason: string): Promise<"FILTERED"> => {
    await db.update(l).set({ enrichmentStatus: "FILTERED", filterReason: reason, detailsNextAt: null, updatedAt: now }).where(eq(l.id, leadId));
    return "FILTERED";
  };
  if (await suppressionHit({ placeId: lead.placeId, phone: v.phone, domain })) return filter("SUPPRESSED");
  if (v.businessStatus === "CLOSED_PERMANENTLY") return filter("CLOSED");
  // Chỉ lead do MÁY tìm (Google) mới bị lọc chuỗi / quy mô; lead nhân viên nhập tay là quyết định của người.
  if (lead.source === "GOOGLE_PLACES") {
    if (ctx.cfg.chainFilter.enabled && chainBrandHit(v.name, ctx.cfg.chainFilter.brands)) return filter("CHAIN");
    if (ctx.cfg.maxReviews != null && v.reviewCount != null && v.reviewCount > ctx.cfg.maxReviews) return filter("TOO_LARGE");
    if (ctx.cfg.chainFilter.enabled && (await sameNamePlaces(v.name, v.address)) > ctx.cfg.chainFilter.maxSameName) return filter("CHAIN");
    if (competitorHit(v.name, provinceFromAddress(v.address)?.key ?? lead.provinceKey, ctx.cfg.competitorFilter)) return filter("COMPETITOR");
  }
  if (camp) {
    if (camp.requirePhone && !v.phone) return filter("NO_PHONE");
    if (camp.requireWebsite && !v.website) return filter("NO_WEBSITE");
    const reviews = v.reviewCount ?? (v.ratingsRequested ? 0 : null);
    if (camp.minReviews != null && reviews != null && reviews < camp.minReviews) return filter("LOW_REVIEWS");
    if (camp.minRating != null && v.ratingsRequested && (v.rating == null || v.rating < camp.minRating)) return filter("LOW_RATING");
  }
  const master = await findMasterLead(leadId, { phone: v.phone, domain });
  if (master) {
    await db
      .update(l)
      .set({ enrichmentStatus: "DUPLICATE", duplicateOfLeadId: master.id, filterReason: master.by === "PHONE" ? "DUPLICATE_PHONE" : master.by === "DOMAIN" ? "DUPLICATE_DOMAIN" : "DUPLICATE_NAME", detailsNextAt: null, updatedAt: now })
      .where(eq(l.id, leadId));
    await rescoreLead(master.id, { cfg: ctx.cfg, stats: ctx.stats, now });
    return "DUPLICATE";
  }

  // Website là trang Facebook / Zalo ⇒ đó là kênh liên hệ, không phải website để đọc.
  const social = socialKind(v.website);
  await db
    .update(l)
    .set({
      enrichmentStatus: "READY",
      filterReason: null,
      detailsNextAt: null,
      lastRefreshedAt: now,
      facebookUrl: social === "FACEBOOK" && !lead.facebookUrl ? v.website : lead.facebookUrl,
      zaloUrl: social === "ZALO" && !lead.zaloUrl ? v.website : lead.zaloUrl,
      websiteStatus: v.website && !social && ctx.cfg.websiteEnrichment.enabled && lead.websiteStatus === "NONE" ? "PENDING" : lead.websiteStatus,
      updatedAt: now,
    })
    .where(eq(l.id, leadId));
  const score = await rescoreLead(leadId, { cfg: ctx.cfg, stats: ctx.stats, now });
  if (score && v.phone && score.score >= ctx.cfg.qualifyMinScore) {
    const moved = await db
      .update(l)
      .set({ contactStatus: "QUALIFIED", qualifiedAt: now, updatedAt: now })
      .where(and(eq(l.id, leadId), eq(l.contactStatus, "NEW")))
      .returning({ id: l.id });
    if (moved.length) {
      await addActivity({ leadId, kind: "STATUS", fromStatus: "NEW", toStatus: "QUALIFIED", note: `Tự lên «Đủ điều kiện»: ${score.score} điểm ≥ ${ctx.cfg.qualifyMinScore} và có SĐT. ${score.summary}`, actorId: null, actorName: "Máy" });
      return "QUALIFIED";
    }
  }
  return "READY";
}

/** Một trang tìm kiếm của một ô. Trả `false` khi lượt phải dừng (trần / khoá hỏng / hạn mức Google). */
async function processCellPage(ctx: Ctx, camp: Campaign): Promise<"DID_WORK" | "NO_CELL" | "STOP"> {
  const db = await getDb();
  const cc = schema.wholesaleCampaignCells;
  if (!ctx.provider) return "STOP";
  const claimed = await claimCell(camp.id, ctx.now());
  if (!claimed) return "NO_CELL";
  const tier = camp.discoveryTier as "IDS_ONLY" | "PRO" | "ENTERPRISE";
  const mode = claimed.cell.searchMode === "NEARBY" ? "NEARBY" : "TEXT";
  const sku = searchSkuOf(mode, tier);
  const release = (extra: Partial<typeof cc.$inferInsert>) => db.update(cc).set({ status: "PENDING", lockedUntil: null, updatedAt: ctx.now(), ...extra }).where(eq(cc.id, claimed.id));

  const blocked = budgetBlock(ctx, sku);
  if (blocked) {
    await release({});
    await pauseRunning(ctx, blocked, blockDetail(ctx, blocked, sku));
    return "STOP";
  }
  if (!(await campaignIsRunning(camp.id))) {
    await release({});
    return "NO_CELL";
  }

  const page =
    mode === "NEARBY"
      ? await ctx.provider.search({ mode: "NEARBY", tier, includedTypes: claimed.cell.keyword.split("+").filter(Boolean), center: { lat: camp.nearbyLat ?? 0, lng: camp.nearbyLng ?? 0 }, radiusM: camp.radiusM ?? 1000 })
      : await ctx.provider.search({ mode: "TEXT", textQuery: claimed.cell.queryText, tier, pageToken: claimed.pageToken });
  const cost = page.meta.billable ? nextCallCostMicros(ctx.cfg, sku, ctx.spend.monthBySku[sku] ?? 0) : 0;
  charge(ctx, cost, sku, page.meta.billable);

  if (!page.ok) {
    await recordUsage({ provider: "GOOGLE_PLACES", method: mode === "NEARBY" ? "NEARBY_SEARCH" : "TEXT_SEARCH", sku, campaignId: camp.id, cellId: claimed.cell.id, query: claimed.cell.queryText, httpStatus: page.meta.httpStatus, ok: false, billable: page.meta.billable, attempts: page.meta.attempts, durationMs: page.meta.durationMs, costMicros: cost, error: page.message, at: ctx.now() });
    if (page.kind === "AUTH") {
      await release({ lastError: page.message });
      await pauseRunning(ctx, "API_AUTH", page.message);
      return "STOP";
    }
    if (page.kind === "QUOTA") {
      const retryAt = quotaRetryAt(ctx.now(), page.message);
      await release({ lastError: page.message, nextAttemptAt: retryAt });
      // Hạn mức là của CẢ dự án Google ⇒ mọi ô CÙNG KIỂU TÌM đang chờ cùng hoãn, không chỉ ô vừa hỏi. Nếu không, lượt sau
      // lấy ô khác và lại 429: đo production 05/10/2026, mỗi 3 phút một lượt 429 — 257 «lỗi API» trong một buổi tối.
      const sameMode = db.select({ id: schema.wholesaleSearchCells.id }).from(schema.wholesaleSearchCells).where(eq(schema.wholesaleSearchCells.searchMode, claimed.cell.searchMode));
      await db
        .update(cc)
        .set({ nextAttemptAt: retryAt, updatedAt: ctx.now() })
        .where(and(eq(cc.status, "PENDING"), inArray(cc.cellId, sameMode), or(isNull(cc.nextAttemptAt), lt(cc.nextAttemptAt, retryAt))));
      ctx.stop = "REQUEST_LIMIT";
      return "STOP";
    }
    // Trang kế tiếp hết hạn / tham số sai ở trang ≥ 2 ⇒ coi ô là xong với những trang đã lấy được.
    if (page.kind === "INVALID" && claimed.pageToken) {
      await db.update(cc).set({ status: "DONE", pageToken: null, lockedUntil: null, finishedAt: ctx.now(), lastError: page.message, updatedAt: ctx.now() }).where(eq(cc.id, claimed.id));
      return "DID_WORK";
    }
    const attempts = claimed.attempts + 1;
    if (attempts >= MAX_CELL_ATTEMPTS) {
      await db.update(cc).set({ status: "FAILED", attempts, lockedUntil: null, lastError: page.message, finishedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(cc.id, claimed.id));
      await db.update(schema.wholesaleSearchCells).set({ lastStatus: "FAILED", updatedAt: ctx.now() }).where(eq(schema.wholesaleSearchCells.id, claimed.cell.id));
    } else await release({ attempts, lastError: page.message, nextAttemptAt: addMs(ctx.now(), 2 ** attempts * 60_000) });
    return "DID_WORK";
  }

  let newPlaces = 0;
  let newLeads = 0;
  let dupes = 0;
  for (const place of page.places) {
    const out = await handleDiscoveredPlace(ctx, camp, claimed.cell, place);
    if (out === "NEW_LEAD") {
      newLeads++;
      newPlaces++;
    } else if (out === "FILTERED" || out === "SUPPRESSED") newPlaces++;
    else dupes++;
  }
  ctx.result.newLeads += newLeads;
  await recordUsage({ provider: "GOOGLE_PLACES", method: mode === "NEARBY" ? "NEARBY_SEARCH" : "TEXT_SEARCH", sku, campaignId: camp.id, cellId: claimed.cell.id, query: claimed.cell.queryText, httpStatus: page.meta.httpStatus, ok: true, billable: page.meta.billable, attempts: page.meta.attempts, resultCount: page.places.length, newCount: newLeads, duplicateCount: dupes, durationMs: page.meta.durationMs, costMicros: cost, at: ctx.now() });

  const pagesFetched = claimed.pagesFetched + 1;
  const ratio = page.places.length ? newPlaces / page.places.length : 0;
  const more = Boolean(page.nextPageToken) && mode === "TEXT" && pagesFetched < ctx.cfg.maxPagesPerCell && page.places.length >= 20 && ratio >= ctx.cfg.minNewRatioForNextPage;
  const totals = { pagesFetched, resultsFound: claimed.resultsFound + page.places.length, newPlaces: claimed.newPlaces + newPlaces, newLeads: claimed.newLeads + newLeads, attempts: 0, lastError: null, nextAttemptAt: null, lockedUntil: null, updatedAt: ctx.now() };
  if (more) await db.update(cc).set({ ...totals, status: "PENDING", pageToken: page.nextPageToken }).where(eq(cc.id, claimed.id));
  else {
    await db.update(cc).set({ ...totals, status: "DONE", pageToken: null, finishedAt: ctx.now() }).where(eq(cc.id, claimed.id));
    await db
      .update(schema.wholesaleSearchCells)
      .set({
        lastScannedAt: ctx.now(),
        lastStatus: "DONE",
        lastCampaignId: camp.id,
        scanCount: sql`${schema.wholesaleSearchCells.scanCount} + 1`,
        resultsFound: totals.resultsFound,
        newLeadsFound: totals.newLeads,
        totalNewLeads: sql`${schema.wholesaleSearchCells.totalNewLeads} + ${totals.newLeads}`,
        updatedAt: ctx.now(),
      })
      .where(eq(schema.wholesaleSearchCells.id, claimed.cell.id));
  }
  // Đủ số lead tối đa ⇒ huỷ ô còn chờ (lead đang lấy chi tiết vẫn chạy nốt).
  if ((await campaignLeadCount(camp.id)) >= camp.maxLeads) {
    await db.update(cc).set({ status: "CANCELLED", lockedUntil: null, updatedAt: ctx.now() }).where(and(eq(cc.campaignId, camp.id), eq(cc.status, "PENDING")));
  }
  return "DID_WORK";
}

/** Lấy chi tiết (SĐT / website / sao) cho một lead đang chờ. */
async function processDetails(ctx: Ctx, lead: Lead): Promise<"DID_WORK" | "STOP"> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  if (!ctx.provider || !lead.placeId) return "STOP";
  const blocked = budgetBlock(ctx, "DETAILS_ENTERPRISE");
  if (blocked) {
    await pauseRunning(ctx, blocked, blockDetail(ctx, blocked, "DETAILS_ENTERPRISE"));
    ctx.stop = blocked;
    return "STOP";
  }
  const snap = await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) });
  const full = !snap || snap.fieldsTier === "IDS_ONLY" || Boolean(snap.purgedAt);
  const r = await ctx.provider.details(lead.placeId, full);
  const cost = r.meta.billable ? nextCallCostMicros(ctx.cfg, "DETAILS_ENTERPRISE", ctx.spend.monthBySku.DETAILS_ENTERPRISE ?? 0) : 0;
  charge(ctx, cost, "DETAILS_ENTERPRISE", r.meta.billable);
  await recordUsage({ provider: "GOOGLE_PLACES", method: "PLACE_DETAILS", sku: "DETAILS_ENTERPRISE", campaignId: lead.sourceCampaignId, leadId: lead.id, query: lead.placeId, httpStatus: r.meta.httpStatus, ok: r.ok, billable: r.meta.billable, attempts: r.meta.attempts, resultCount: r.ok ? 1 : 0, durationMs: r.meta.durationMs, costMicros: cost, error: r.ok ? null : r.message, at: ctx.now() });
  if (!r.ok) {
    if (r.kind === "AUTH") {
      await pauseRunning(ctx, "API_AUTH", r.message);
      ctx.stop = "API_AUTH";
      return "STOP";
    }
    if (r.kind === "QUOTA") {
      // Hạn mức là của CẢ dự án ⇒ mọi lead đang chờ chi tiết cùng chờ, không chỉ lead vừa hỏi (nếu không, lượt sau hỏi lead khác và lại 429).
      await db.update(l).set({ detailsNextAt: quotaRetryAt(ctx.now(), r.message) }).where(and(eq(l.enrichmentStatus, "PENDING_DETAILS"), or(isNull(l.detailsNextAt), lt(l.detailsNextAt, quotaRetryAt(ctx.now(), r.message)))));
      ctx.stop = "REQUEST_LIMIT";
      return "STOP";
    }
    if (r.kind === "NOT_FOUND") {
      await db.update(l).set({ enrichmentStatus: "FAILED", filterReason: "PLACE_NOT_FOUND", detailsNextAt: null, updatedAt: ctx.now() }).where(eq(l.id, lead.id));
      return "DID_WORK";
    }
    const attempts = lead.detailsAttempts + 1;
    await db
      .update(l)
      .set(attempts >= MAX_DETAILS_ATTEMPTS ? { enrichmentStatus: "FAILED", filterReason: "DETAILS_FAILED", detailsAttempts: attempts, detailsNextAt: null, updatedAt: ctx.now() } : { detailsAttempts: attempts, detailsNextAt: addMs(ctx.now(), 2 ** attempts * 60_000), updatedAt: ctx.now() })
      .where(eq(l.id, lead.id));
    return "DID_WORK";
  }
  await upsertSnapshot(r.place, "DETAILS", ctx.cfg, ctx.now());
  if (lead.enrichmentStatus === "PENDING_DETAILS") {
    // Lượt tìm chỉ-ID không có tên ⇒ phân nhóm bây giờ mới làm được.
    if (!lead.segmentEvidence) {
      const seg = classifySegment({ name: r.place.name, primaryType: r.place.primaryType, types: r.place.types });
      const prov = provinceFromAddress(r.place.address);
      await db.update(l).set({ segment: seg.segment, segmentEvidence: seg.evidence, ...(prov ? { provinceKey: prov.key, provinceLabel: prov.label } : {}) }).where(eq(l.id, lead.id));
      const camp = lead.sourceCampaignId ? await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, lead.sourceCampaignId) }) : null;
      if (camp?.targetSegments.length && seg.segment !== "UNCLASSIFIED" && !camp.targetSegments.includes(seg.segment)) {
        await db.update(l).set({ enrichmentStatus: "FILTERED", filterReason: "SEGMENT", detailsNextAt: null, updatedAt: ctx.now() }).where(eq(l.id, lead.id));
        return "DID_WORK";
      }
    }
    const camp = lead.sourceCampaignId ? await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, lead.sourceCampaignId) }) : null;
    if ((await finalizeLead(ctx, lead.id, camp ?? null)) === "QUALIFIED") ctx.result.qualified.push(lead.id);
    ctx.result.detailsDone++;
  } else {
    await db.update(l).set({ lastRefreshedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(l.id, lead.id));
    await rescoreLead(lead.id, { cfg: ctx.cfg, stats: ctx.stats, now: ctx.now() });
    ctx.result.refreshed++;
  }
  return "DID_WORK";
}

/** Đọc website công khai của một lead; mỗi phát hiện lưu kèm URL nguồn. Dữ liệu tổ chức chỉ được điền vào Ô TRỐNG. */
export async function enrichLeadWebsite(ctx: Pick<Ctx, "cfg" | "now" | "stats" | "enricher">, lead: Lead): Promise<void> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const snap = lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) }) : null;
  const website = lead.website ?? (snap && !snap.purgedAt ? snap.websiteUri : null);
  const now = ctx.now();
  if (!website) {
    await db.update(l).set({ websiteStatus: "NONE", websiteCheckedAt: now }).where(eq(l.id, lead.id));
    return;
  }
  const r = await ctx.enricher.enrich(website, { maxPages: ctx.cfg.websiteEnrichment.maxPages });
  await recordUsage({ provider: "WEBSITE", method: "WEBSITE_FETCH", leadId: lead.id, query: website, ok: r.status === "DONE", billable: false, resultCount: r.findings.length, costMicros: 0, error: r.status === "DONE" ? null : r.note, at: now });
  for (const f of r.findings) {
    await db.insert(schema.wholesaleLeadEnrichments).values({ leadId: lead.id, kind: f.kind, value: f.value.slice(0, 500), sourceUrl: f.sourceUrl.slice(0, 500), fetchedAt: now }).onConflictDoNothing();
  }
  const edited = new Set(lead.staffEditedFields);
  const first = (kind: string) => r.findings.find((f) => f.kind === kind)?.value ?? null;
  const phone = first("PHONE");
  const hasPhone = Boolean(lead.normalizedPhone || (snap && !snap.purgedAt && snap.normalizedPhone));
  const patch: Partial<typeof l.$inferInsert> = { websiteStatus: r.status, websiteCheckedAt: now, updatedAt: now };
  if (!lead.email && !edited.has("email") && first("EMAIL")) patch.email = first("EMAIL");
  if (!lead.facebookUrl && !edited.has("facebookUrl") && first("FACEBOOK")) patch.facebookUrl = first("FACEBOOK");
  if (!lead.zaloUrl && !edited.has("zaloUrl") && first("ZALO")) patch.zaloUrl = first("ZALO");
  if (!hasPhone && !edited.has("phone") && phone) {
    const p = normalizeVnPhone(phone);
    if (p?.normalized) Object.assign(patch, { phoneRaw: phone, normalizedPhone: p.normalized, phoneKind: p.kind, phoneCountryCode: p.countryCode, phoneSource: "WEBSITE" });
  }
  await db.update(l).set(patch).where(eq(l.id, lead.id));
  if (r.findings.length) {
    await addActivity({ leadId: lead.id, kind: "ENRICHED", note: `Đọc website (${r.note}): ${r.findings.filter((f) => f.kind !== "DESCRIPTION").map((f) => f.value).slice(0, 6).join(", ") || "không thấy liên hệ mới"}`, meta: { sources: [...new Set(r.findings.map((f) => f.sourceUrl))] }, actorId: null, actorName: "Máy" });
  }
  await rescoreLead(lead.id, { cfg: ctx.cfg, stats: ctx.stats, now });
}

/**
 * Hết hạn lưu: xoá trắng trường nội dung Google (giữ Place ID, giữ mốc). Lead đang chăm đã được làm mới trước đó nếu
 * ngân sách cho phép; còn lại thì người bán bấm «Làm mới» khi cần.
 */
export async function purgeExpiredSnapshots(now: Date): Promise<number> {
  const db = await getDb();
  const s = schema.wholesalePlaceSnapshots;
  const rows = await db
    .update(s)
    .set({
      displayName: null,
      formattedAddress: null,
      nationalPhone: null,
      internationalPhone: null,
      websiteUri: null,
      googleMapsUri: null,
      primaryType: null,
      types: [],
      rating: null,
      userRatingCount: null,
      businessStatus: null,
      lat: null,
      lng: null,
      normalizedPhone: null,
      phoneKind: null,
      websiteDomain: null,
      nameKey: null,
      purgedAt: now,
      updatedAt: now,
    })
    .where(and(isNull(s.purgedAt), lt(s.expiresAt, now)))
    .returning({ id: s.placeId });
  return rows.length;
}

/** Chiến dịch hết ô chờ và hết lead chờ chi tiết ⇒ Hoàn tất (báo chủ shop). */
async function completeFinished(ctx: Ctx): Promise<void> {
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  const running = await db.select().from(c).where(eq(c.status, "RUNNING"));
  for (const camp of running) {
    const [{ open }] = await db
      .select({ open: count() })
      .from(schema.wholesaleCampaignCells)
      .where(and(eq(schema.wholesaleCampaignCells.campaignId, camp.id), inArray(schema.wholesaleCampaignCells.status, ["PENDING", "RUNNING"])));
    const [{ waiting }] = await db
      .select({ waiting: count() })
      .from(schema.wholesaleLeads)
      .where(and(eq(schema.wholesaleLeads.sourceCampaignId, camp.id), eq(schema.wholesaleLeads.enrichmentStatus, "PENDING_DETAILS")));
    if (Number(open) || Number(waiting)) continue;
    const now = ctx.now();
    const done = await db.update(c).set({ status: "COMPLETED", completedAt: now, updatedAt: now }).where(and(eq(c.id, camp.id), eq(c.status, "RUNNING"))).returning({ id: c.id });
    if (!done.length) continue;
    ctx.result.completed.push(camp.id);
    const leads = await campaignLeadCount(camp.id);
    await notifyOwners({ title: "Chiến dịch săn khách sỉ đã quét xong", body: `«${camp.name}»: ${leads} lead. Mở danh sách để giao cho nhân viên.`, href: `/wholesale/leads?campaign=${camp.id}`, dedupeKey: `wholesale:done:${camp.id}`, severity: "info", now });
  }
}

/**
 * MỘT LƯỢT của job. Thứ tự: mở lại chiến dịch chạm trần đã sang kỳ → lấy chi tiết lead đang chờ (để SĐT hiện sớm) →
 * mỗi chiến dịch một trang (xoay vòng) → đọc website → làm mới lead đang chăm sắp hết hạn → xoá dữ liệu hết hạn →
 * đánh dấu chiến dịch xong.
 */
/** Khoá `settings` ghi bản luật đối thủ đã áp lên lead cũ — luật đổi (hoặc lần đầu có luật) thì quét lại một lần. */
export const COMPETITOR_SWEEP_SETTING_KEY = "wholesale.competitorSweep";

/**
 * Áp luật đối thủ lên lead ĐÃ CÓ khi luật đổi. Chỉ chạm lead do MÁY tìm, CHƯA ai liên hệ và CHƯA giao cho ai — lead người
 * đã cầm là quyết định của người. Lead bị loại chỉ đổi `enrichment_status` sang FILTERED (lý do COMPETITOR), không xoá:
 * vẫn xem được ở bộ lọc «Đã loại». Trả số lead vừa loại.
 */
export async function sweepCompetitors(cfg: LeadHunterConfig, now: Date): Promise<number> {
  const stamp = JSON.stringify(cfg.competitorFilter);
  if ((await getSettingJson<string | null>(COMPETITOR_SWEEP_SETTING_KEY, null)) === stamp) return 0;
  let n = 0;
  if (cfg.competitorFilter.enabled) {
    const db = await getDb();
    const l = schema.wholesaleLeads;
    const ps = schema.wholesalePlaceSnapshots;
    const rows = await db
      .select({ id: l.id, name: sql<string | null>`coalesce(${l.businessName}, ${ps.displayName})`, address: sql<string | null>`coalesce(${l.address}, ${ps.formattedAddress})`, provinceKey: l.provinceKey })
      .from(l)
      .leftJoin(ps, eq(ps.placeId, l.placeId))
      .where(
        and(
          eq(l.source, "GOOGLE_PLACES"),
          inArray(l.enrichmentStatus, ["READY", "PENDING_DETAILS"]),
          inArray(l.contactStatus, ["NEW", "QUALIFIED"]),
          isNull(l.lastContactAt),
          isNull(l.assignedToUserId),
        ),
      );
    const ids = rows.filter((r) => competitorHit(r.name, provinceFromAddress(r.address)?.key ?? r.provinceKey, cfg.competitorFilter)).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      await db
        .update(l)
        .set({ enrichmentStatus: "FILTERED", filterReason: "COMPETITOR", detailsNextAt: null, updatedAt: now })
        .where(inArray(l.id, ids.slice(i, i + 200)));
    }
    n = ids.length;
  }
  await setSettingJson(COMPETITOR_SWEEP_SETTING_KEY, stamp);
  return n;
}

export async function runLeadHunterTick(opts: TickOptions = {}, deps: TickDeps = {}): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const started = Date.now();
  const result: TickResult = { skipped: null, detail: "", calls: 0, costMicros: 0, newLeads: 0, detailsDone: 0, websitesDone: 0, refreshed: 0, purged: 0, paused: [], completed: [], qualified: [] };
  const db = await getDb();
  const cfg = await getLeadHunterConfig();
  const spendNow = await currentSpend(now());
  const keys = periodKeys(now());
  const ctx: Ctx = {
    cfg,
    now,
    deadline: started + (opts.budgetMs ?? 50_000),
    provider: deps.provider ?? null,
    enricher: deps.enricher ?? websiteEnrichmentProvider(deps.website),
    stats: await segmentOutcomeStats(),
    spend: { today: spendNow.todayMicros, month: spendNow.monthMicros, calls: spendNow.callsToday, dayKey: keys.day, monthKey: keys.month, monthBySku: { ...spendNow.monthCallsBySku } },
    result,
    stop: null,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const timeLeft = () => Date.now() < ctx.deadline;

  await autoResume(ctx);
  await sweepCompetitors(cfg, now());
  const c = schema.wholesaleCampaigns;
  const l = schema.wholesaleLeads;
  const runningCount = Number((await db.select({ n: count() }).from(c).where(eq(c.status, "RUNNING")))[0]?.n ?? 0);
  const pendingDetails = Number((await db.select({ n: count() }).from(l).where(eq(l.enrichmentStatus, "PENDING_DETAILS")))[0]?.n ?? 0);
  const refreshDue = await db
    .select({ id: l.id })
    .from(l)
    .innerJoin(schema.wholesalePlaceSnapshots, eq(schema.wholesalePlaceSnapshots.placeId, l.placeId))
    // Đã xoá (purged) cũng làm mới: lead đang chăm cần SĐT / địa chỉ để người bán làm việc.
    .where(and(inArray(l.contactStatus, [...ACTIVE_PIPELINE_STATUSES]), eq(l.enrichmentStatus, "READY"), lt(schema.wholesalePlaceSnapshots.expiresAt, addMs(now(), REFRESH_AHEAD_MS))))
    .limit(10);
  const needsGoogle = runningCount > 0 || pendingDetails > 0 || refreshDue.length > 0;

  if (needsGoogle && !ctx.provider) {
    const conn = await openActiveConnection("google-places");
    if (conn.ok && (conn.secrets.apiKey ?? "").trim()) {
      ctx.provider = googlePlacesProvider({ apiKey: conn.secrets.apiKey!.trim(), timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries, relay: placesRelayOf(conn.settings, conn.secrets) }, deps.places);
    } else if (runningCount > 0) {
      await pauseRunning(ctx, "NO_CONNECTION", conn.ok ? "Kết nối thiếu khoá API." : conn.reason);
    }
  }

  // 1 + 2. Chi tiết đang chờ và trang tìm kiếm — xen kẽ cho tới khi hết việc / hết giờ / chạm trần.
  if (ctx.provider) {
    let idle = false;
    while (timeLeft() && !ctx.stop && !idle) {
      idle = true;
      const waiting = await db
        .select()
        .from(l)
        .where(and(eq(l.enrichmentStatus, "PENDING_DETAILS"), or(isNull(l.detailsNextAt), lte(l.detailsNextAt, now()))))
        .orderBy(asc(l.firstSeenAt), asc(l.id))
        .limit(5);
      for (const lead of waiting) {
        if (!timeLeft() || ctx.stop) break;
        if ((await processDetails(ctx, lead)) === "STOP") break;
        idle = false;
        if (cfg.requestIntervalMs) await ctx.sleep(cfg.requestIntervalMs);
      }
      const camps = await db.select().from(c).where(eq(c.status, "RUNNING")).orderBy(asc(c.startedAt), asc(c.id));
      for (const camp of camps) {
        if (!timeLeft() || ctx.stop) break;
        const r = await processCellPage(ctx, camp);
        if (r === "STOP") break;
        if (r === "DID_WORK") {
          idle = false;
          if (cfg.requestIntervalMs) await ctx.sleep(cfg.requestIntervalMs);
        }
      }
    }
    // 4. Làm mới lead đang chăm sắp hết hạn lưu.
    for (const row of refreshDue) {
      if (!timeLeft() || ctx.stop) break;
      const lead = await db.query.wholesaleLeads.findFirst({ where: eq(l.id, row.id) });
      if (lead && (await processDetails(ctx, lead)) === "STOP") break;
    }
  }

  // 3. Website (không tính tiền, chỉ tốn thời gian) — tối đa 5 lead / lượt.
  if (cfg.websiteEnrichment.enabled) {
    const queue = await db.select().from(l).where(and(eq(l.websiteStatus, "PENDING"), eq(l.enrichmentStatus, "READY"))).orderBy(sql`${l.leadScore} desc nulls last`, asc(l.id)).limit(5);
    for (const lead of queue) {
      if (!timeLeft()) break;
      await enrichLeadWebsite(ctx, lead);
      result.websitesDone++;
    }
  }

  result.purged = await purgeExpiredSnapshots(now());
  await completeFinished(ctx);
  await db.update(c).set({ lastTickAt: now() }).where(eq(c.status, "RUNNING"));

  result.detail = [
    `${result.calls} lượt gọi Google (${(result.costMicros / 1e6).toFixed(3)} US$ ước tính)`,
    `${result.newLeads} lead mới`,
    `${result.detailsDone} lead lấy chi tiết`,
    result.websitesDone ? `${result.websitesDone} website` : "",
    result.refreshed ? `${result.refreshed} làm mới` : "",
    result.purged ? `${result.purged} địa điểm hết hạn lưu đã xoá dữ liệu Google` : "",
    result.paused.length ? `tạm dừng: ${PAUSE_REASON_LABEL[result.paused[0]!.reason]}` : "",
    result.completed.length ? `${result.completed.length} chiến dịch hoàn tất` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!needsGoogle && !result.websitesDone && !result.purged) result.skipped = "IDLE";
  return result;
}

