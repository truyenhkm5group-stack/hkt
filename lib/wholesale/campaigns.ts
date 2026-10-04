import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { parseCustomAreas, SEARCH_PROVINCES, type SearchProvince } from "@/lib/wholesale/areas";
import { DEFAULT_KEYWORD_GROUPS, DEFAULT_TARGET_SEGMENTS, DISCOVERY_TIERS, type KeywordGroup } from "@/lib/wholesale/config";
import type { CampaignStatus } from "@/lib/wholesale/constants";
import { type CostEstimate, enabledKeywords, estimateCost, planNearbyCell, planTextCells, type PlannedCell } from "@/lib/wholesale/query-plan";
import { LEAD_SEGMENTS, type LeadSegment } from "@/lib/wholesale/segments";
import { getLeadHunterConfig } from "@/lib/wholesale/store";

/**
 * ═══════════ CHIẾN DỊCH QUÉT — LÕI GHI (CHỈ MÁY CHỦ) ═══════════
 *
 * Server action gọi các hàm `*Core(user, …)` ở đây (mẫu lib/records/appointments.ts): quyền → zod → ghi → audit. Trả
 * `{ error }` cho lỗi nghiệp vụ. Bắt đầu quét KHÔNG gọi Google trong yêu cầu HTTP — chỉ dựng hàng đợi ô; job nền làm phần
 * còn lại.
 */

export type CoreResult<T extends object = object> = ({ ok: true } & T) | { error: string };

const FORBIDDEN_SCAN = "Bạn không có quyền chạy chiến dịch quét (wholesale:scan).";

const areaSelection = z.record(z.string().max(60), z.array(z.string().max(60)).max(200));

export const campaignInputSchema = z
  .object({
    name: z.string().trim().min(2, "Cần tên chiến dịch").max(160),
    productFocus: z.string().trim().max(300).default(""),
    provinces: z.array(z.string().max(60)).max(70).default([]),
    /** Khu vực đã chọn theo tỉnh; tỉnh không có khoá ⇒ mọi khu vực của tỉnh. */
    areas: areaSelection.default({}),
    customAreas: z.string().max(5000).default(""),
    keywordGroups: z.array(z.object({ key: z.string().max(40), enabled: z.boolean() })).max(40).default([]),
    extraKeywords: z.string().max(2000).default(""),
    excludeKeywords: z.string().max(2000).default(""),
    targetSegments: z.array(z.enum(LEAD_SEGMENTS)).max(LEAD_SEGMENTS.length).default([]),
    maxLeads: z.coerce.number().int().min(1).max(100_000).default(500),
    minRating: z.coerce.number().min(0).max(5).nullable().default(null),
    minReviews: z.coerce.number().int().min(0).max(1_000_000).nullable().default(null),
    requirePhone: z.boolean().default(true),
    requireWebsite: z.boolean().default(false),
    searchMode: z.enum(["TEXT", "NEARBY"]).default("TEXT"),
    nearbyLat: z.coerce.number().min(-90).max(90).nullable().default(null),
    nearbyLng: z.coerce.number().min(-180).max(180).nullable().default(null),
    radiusM: z.coerce.number().int().min(100).max(50_000).nullable().default(null),
    discoveryTier: z.enum(DISCOVERY_TIERS).default("PRO"),
    note: z.string().max(2000).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.searchMode === "NEARBY" && (v.nearbyLat == null || v.nearbyLng == null || v.radiusM == null)) ctx.addIssue({ code: "custom", message: "Nearby Search cần toạ độ tâm và bán kính." });
    if (v.searchMode === "TEXT" && !v.provinces.length && !v.customAreas.trim()) ctx.addIssue({ code: "custom", message: "Chọn ít nhất một tỉnh / thành hoặc khai khu vực." });
  });

export type CampaignInput = z.input<typeof campaignInputSchema>;
type CampaignParsed = z.output<typeof campaignInputSchema>;

function splitList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 80);
}

/** Tỉnh + khu vực đã chọn ⇒ danh sách tỉnh đầy đủ (gộp ô «khu vực tự khai»). */
export function resolveProvinces(input: Pick<CampaignParsed, "provinces" | "areas" | "customAreas">): { provinces: SearchProvince[]; invalid: string[] } {
  const out = new Map<string, SearchProvince>();
  for (const key of input.provinces) {
    const p = SEARCH_PROVINCES.find((x) => x.key === key);
    if (!p) continue;
    const pick = input.areas[key];
    const areas = pick && pick.length ? p.areas.filter((a) => pick.includes(a.code)) : p.areas;
    if (areas.length) out.set(p.key, { ...p, areas: [...areas] });
  }
  const custom = parseCustomAreas(input.customAreas);
  for (const p of custom.provinces) {
    const prev = out.get(p.key);
    if (!prev) out.set(p.key, p);
    else for (const a of p.areas) if (!prev.areas.some((x) => x.code === a.code)) prev.areas.push(a);
  }
  return { provinces: [...out.values()], invalid: custom.invalid };
}

export function resolveKeywordGroups(picks: CampaignParsed["keywordGroups"]): KeywordGroup[] {
  return DEFAULT_KEYWORD_GROUPS.map((g) => {
    const pick = picks.find((p) => p.key === g.key);
    return { ...g, keywords: [...g.keywords], enabled: pick ? pick.enabled : g.enabled };
  });
}

type CampaignRow = typeof schema.wholesaleCampaigns.$inferSelect;

/** Dàn ô của một chiến dịch đã lưu (đọc lại đúng thứ đã lưu, không đọc form). */
export function planForCampaign(c: Pick<CampaignRow, "provinces" | "keywordGroups" | "searchMode" | "nearbyLat" | "nearbyLng" | "radiusM" | "targetSegments" | "name">): { cells: PlannedCell[]; truncated: boolean } {
  if (c.searchMode === "NEARBY") {
    const types = nearbyTypesFor(c.targetSegments as LeadSegment[]);
    return { cells: [planNearbyCell({ lat: c.nearbyLat ?? 0, lng: c.nearbyLng ?? 0, radiusM: c.radiusM ?? 1000, includedTypes: types, label: c.name })], truncated: false };
  }
  const groups = (Array.isArray(c.keywordGroups) ? c.keywordGroups : []) as (KeywordGroup & { extra?: boolean })[];
  const keywords = enabledKeywords(groups);
  const provinces = (Array.isArray(c.provinces) ? c.provinces : []) as SearchProvince[];
  return planTextCells(keywords, provinces);
}

/** Nhóm khách ⇒ loại hình Google cho Nearby Search (Nearby không nhận từ khoá). */
export function nearbyTypesFor(segments: readonly LeadSegment[]): string[] {
  const map: Partial<Record<LeadSegment, string[]>> = {
    SEAFOOD_RESTAURANT: ["seafood_restaurant"],
    BUFFET: ["buffet_restaurant"],
    BBQ: ["barbecue_restaurant"],
    HOTPOT: ["restaurant"],
    RESTAURANT: ["restaurant"],
    PUB_BEER: ["bar", "pub"],
    HOTEL_RESORT: ["hotel", "resort_hotel"],
    CATERING: ["catering_service"],
    FROZEN_FOOD_STORE: ["grocery_store", "food_store"],
    SUPERMARKET: ["supermarket", "grocery_store"],
  };
  const out = new Set<string>();
  for (const s of segments.length ? segments : DEFAULT_TARGET_SEGMENTS) for (const t of map[s] ?? []) out.add(t);
  return [...out];
}

function rowFromInput(v: CampaignParsed, provinces: SearchProvince[]) {
  const groups = resolveKeywordGroups(v.keywordGroups);
  const extra = splitList(v.extraKeywords);
  if (extra.length) groups.push({ key: "tu-khai", label: "Từ khoá tự khai", keywords: extra, enabled: true });
  return {
    name: v.name,
    productFocus: v.productFocus,
    provinces,
    keywordGroups: groups,
    excludeKeywords: splitList(v.excludeKeywords),
    targetSegments: v.targetSegments,
    maxLeads: v.maxLeads,
    minRating: v.minRating,
    minReviews: v.minReviews,
    requirePhone: v.requirePhone,
    requireWebsite: v.requireWebsite,
    searchMode: v.searchMode,
    nearbyLat: v.searchMode === "NEARBY" ? v.nearbyLat : null,
    nearbyLng: v.searchMode === "NEARBY" ? v.nearbyLng : null,
    radiusM: v.searchMode === "NEARBY" ? v.radiusM : null,
    discoveryTier: v.discoveryTier,
    note: v.note,
  };
}

async function freshCellKeys(keys: string[], freshDays: number, now: Date): Promise<Set<string>> {
  const db = await getDb();
  const s = schema.wholesaleSearchCells;
  const since = new Date(now.getTime() - freshDays * 86_400_000);
  const fresh = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await db
      .select({ key: s.cellKey })
      .from(s)
      .where(and(inArray(s.cellKey, keys.slice(i, i + 500)), eq(s.lastStatus, "DONE"), gte(s.lastScannedAt, since)));
    for (const r of rows) fresh.add(r.key);
  }
  return fresh;
}

export type CampaignPreview = {
  cells: number;
  truncated: boolean;
  freshCells: number;
  byProvince: { label: string; areas: number; cells: number }[];
  keywords: string[];
  sample: string[];
  estimate: CostEstimate;
  usdToVnd: number;
  invalidAreas: string[];
};

/** «Xem trước truy vấn»: không ghi, không gọi Google. */
export async function previewCampaignCore(user: SessionUser, raw: unknown): Promise<CoreResult<{ preview: CampaignPreview }>> {
  if (!can(user, "wholesale:scan")) return { error: FORBIDDEN_SCAN };
  const parsed = campaignInputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { provinces, invalid } = resolveProvinces(parsed.data);
  const row = rowFromInput(parsed.data, provinces);
  const plan = planForCampaign(row);
  const cfg = await getLeadHunterConfig();
  const fresh = await freshCellKeys(
    plan.cells.map((c) => c.cellKey),
    cfg.cellFreshDays,
    new Date(),
  );
  const byProvince = provinces.map((p) => ({ label: p.label, areas: p.areas.length, cells: plan.cells.filter((c) => c.provinceKey === p.key).length }));
  return {
    ok: true,
    preview: {
      cells: plan.cells.length,
      truncated: plan.truncated,
      freshCells: fresh.size,
      byProvince,
      keywords: enabledKeywords(row.keywordGroups),
      sample: plan.cells.filter((c) => !fresh.has(c.cellKey)).slice(0, 40).map((c) => c.queryText),
      estimate: estimateCost({ cellCount: plan.cells.length, freshCount: fresh.size, mode: row.searchMode, tier: row.discoveryTier, maxLeads: row.maxLeads }, cfg),
      usdToVnd: cfg.usdToVnd,
      invalidAreas: invalid,
    },
  };
}

export async function createCampaignCore(user: SessionUser, raw: unknown): Promise<CoreResult<{ id: string }>> {
  if (!can(user, "wholesale:scan")) return { error: FORBIDDEN_SCAN };
  const parsed = campaignInputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { provinces, invalid } = resolveProvinces(parsed.data);
  if (invalid.length) return { error: `Không đọc được dòng khu vực: ${invalid.slice(0, 3).join(" · ")}` };
  if (parsed.data.searchMode === "TEXT" && !provinces.some((p) => p.areas.length)) return { error: "Chưa có khu vực nào để quét." };
  const db = await getDb();
  const [row] = await db
    .insert(schema.wholesaleCampaigns)
    .values({ ...rowFromInput(parsed.data, provinces), status: "DRAFT", createdByUserId: user.id, createdByName: user.name })
    .returning({ id: schema.wholesaleCampaigns.id });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_CAMPAIGN_CREATE", entity: "WHOLESALE_CAMPAIGN", entityId: row!.id, after: { name: parsed.data.name, provinces: provinces.map((p) => p.key), tier: parsed.data.discoveryTier, maxLeads: parsed.data.maxLeads }, reason: "Tạo chiến dịch săn khách sỉ" });
  return { ok: true, id: row!.id };
}

/** Ưu tiên ô theo kinh nghiệm: từ khoá từng ra nhiều lead mới / lượt quét được quét trước. */
async function keywordPriorities(): Promise<Map<string, number>> {
  const db = await getDb();
  const s = schema.wholesaleSearchCells;
  const rows = await db
    .select({ keyword: s.keyword, scans: sql<string>`sum(${s.scanCount})`, leads: sql<string>`sum(${s.totalNewLeads})` })
    .from(s)
    .groupBy(s.keyword);
  const out = new Map<string, number>();
  for (const r of rows) {
    const scans = Number(r.scans ?? 0);
    if (scans >= 3) out.set(r.keyword, Math.round((Number(r.leads ?? 0) / scans) * 10));
  }
  return out;
}

/**
 * Bắt đầu quét: dựng / tái dùng ô toàn cục, xếp hàng ô của chiến dịch. Ô còn mới (đã quét trong `cellFreshDays` ngày) ⇒
 * `SKIPPED_FRESH`, không tốn lượt gọi. Idempotent: bấm hai lần không nhân ô.
 */
export async function startCampaignCore(user: SessionUser, id: string, now = new Date()): Promise<CoreResult<{ queued: number; skippedFresh: number }>> {
  if (!can(user, "wholesale:scan")) return { error: FORBIDDEN_SCAN };
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  const camp = await db.query.wholesaleCampaigns.findFirst({ where: eq(c.id, id) });
  if (!camp) return { error: "Không tìm thấy chiến dịch." };
  if (camp.isTemplate) return { error: "Đây là MẪU — bấm «Dùng mẫu» để tạo chiến dịch từ mẫu rồi mới quét." };
  if (camp.status !== "DRAFT") return { error: `Chiến dịch đang «${camp.status}» — chỉ bắt đầu được chiến dịch nháp (tạm dừng thì bấm Tiếp tục).` };
  const plan = planForCampaign(camp);
  if (!plan.cells.length) return { error: "Chiến dịch không sinh ra truy vấn nào — kiểm tra tỉnh / khu vực / từ khoá." };
  const cfg = await getLeadHunterConfig();
  const s = schema.wholesaleSearchCells;
  for (let i = 0; i < plan.cells.length; i += 500) {
    await db
      .insert(s)
      .values(plan.cells.slice(i, i + 500).map((p) => ({ cellKey: p.cellKey, keyword: p.keyword, provinceKey: p.provinceKey, provinceLabel: p.provinceLabel, areaCode: p.areaCode, areaName: p.areaName, queryText: p.queryText, searchMode: p.searchMode })))
      .onConflictDoNothing({ target: s.cellKey });
  }
  const since = new Date(now.getTime() - cfg.cellFreshDays * 86_400_000);
  const prio = await keywordPriorities();
  let queued = 0;
  let skippedFresh = 0;
  for (let i = 0; i < plan.cells.length; i += 500) {
    const keys = plan.cells.slice(i, i + 500).map((p) => p.cellKey);
    const cells = await db.select().from(s).where(inArray(s.cellKey, keys));
    const rows = cells.map((cell) => {
      const fresh = cell.lastStatus === "DONE" && cell.lastScannedAt != null && cell.lastScannedAt >= since;
      if (fresh) skippedFresh++;
      else queued++;
      return { campaignId: camp.id, cellId: cell.id, status: fresh ? "SKIPPED_FRESH" : "PENDING", priority: prio.get(cell.keyword) ?? 0, finishedAt: fresh ? now : null };
    });
    if (rows.length) await db.insert(schema.wholesaleCampaignCells).values(rows).onConflictDoNothing({ target: [schema.wholesaleCampaignCells.campaignId, schema.wholesaleCampaignCells.cellId] });
  }
  const moved = await db
    .update(c)
    .set({ status: "RUNNING", startedAt: now, pauseReason: null, lastError: null, updatedAt: now })
    .where(and(eq(c.id, camp.id), eq(c.status, "DRAFT")))
    .returning({ id: c.id });
  if (!moved.length) return { error: "Chiến dịch vừa được người khác bắt đầu." };
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_SCAN_START", entity: "WHOLESALE_CAMPAIGN", entityId: camp.id, before: { status: "DRAFT" }, after: { status: "RUNNING", queued, skippedFresh, truncated: plan.truncated }, reason: "Bắt đầu quét" });
  return { ok: true, queued, skippedFresh };
}

const TRANSITIONS: Record<"pause" | "resume" | "stop", { from: CampaignStatus[]; to: CampaignStatus; action: string; reason: string }> = {
  pause: { from: ["RUNNING"], to: "PAUSED", action: "WHOLESALE_SCAN_PAUSE", reason: "Tạm dừng quét" },
  resume: { from: ["PAUSED"], to: "RUNNING", action: "WHOLESALE_SCAN_RESUME", reason: "Tiếp tục quét" },
  stop: { from: ["RUNNING", "PAUSED"], to: "STOPPED", action: "WHOLESALE_SCAN_STOP", reason: "Dừng hẳn chiến dịch" },
};

/** Tạm dừng / tiếp tục / dừng. Tiến độ không mất: ô và lead giữ nguyên trạng thái; dừng hẳn chỉ huỷ ô CHƯA quét. */
export async function changeCampaignStateCore(user: SessionUser, id: string, op: "pause" | "resume" | "stop", now = new Date()): Promise<CoreResult<{ status: CampaignStatus }>> {
  if (!can(user, "wholesale:scan")) return { error: FORBIDDEN_SCAN };
  const t = TRANSITIONS[op];
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  const camp = await db.query.wholesaleCampaigns.findFirst({ where: eq(c.id, id) });
  if (!camp) return { error: "Không tìm thấy chiến dịch." };
  if (!t.from.includes(camp.status as CampaignStatus)) return { error: `Không ${t.reason.toLowerCase()} được chiến dịch đang «${camp.status}».` };
  const patch =
    op === "pause"
      ? { status: t.to, pauseReason: "MANUAL", pausedAt: now }
      : op === "resume"
        ? { status: t.to, pauseReason: null, pausedAt: null, lastError: null }
        : { status: t.to, stoppedAt: now, pauseReason: null };
  const moved = await db
    .update(c)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(c.id, id), inArray(c.status, t.from)))
    .returning({ id: c.id });
  if (!moved.length) return { error: "Trạng thái chiến dịch vừa đổi — tải lại trang." };
  if (op === "stop") {
    await db
      .update(schema.wholesaleCampaignCells)
      .set({ status: "CANCELLED", lockedUntil: null, updatedAt: now })
      .where(and(eq(schema.wholesaleCampaignCells.campaignId, id), inArray(schema.wholesaleCampaignCells.status, ["PENDING", "RUNNING"])));
  }
  if (op === "resume") {
    // Ô bị kẹt RUNNING (lượt trước chết) trả về hàng đợi ngay, không chờ hết hạn thuê.
    await db
      .update(schema.wholesaleCampaignCells)
      .set({ status: "PENDING", lockedUntil: null, updatedAt: now })
      .where(and(eq(schema.wholesaleCampaignCells.campaignId, id), eq(schema.wholesaleCampaignCells.status, "RUNNING")));
  }
  await audit({ userId: user.id, userEmail: user.email, action: t.action, entity: "WHOLESALE_CAMPAIGN", entityId: id, before: { status: camp.status, pauseReason: camp.pauseReason }, after: { status: t.to }, reason: t.reason });
  return { ok: true, status: t.to };
}

export const HSLC_TEMPLATE_KEY = "hslc-wholesale-fnb";
export const HSLC_TEMPLATE_NAME = "HSLC – Wholesale F&B Prospects";

/** Mẫu chiến dịch đầu tiên cho HSLC (đặc tả mục 21). Mẫu KHÔNG tự chạy (luật 23) — người bấm «Dùng mẫu» mới có chiến dịch. */
export function hslcTemplateValues() {
  return {
    name: HSLC_TEMPLATE_NAME,
    productFocus: "Hải sản đóng gói cho nhà hàng / quán ăn / khách sạn",
    provinces: SEARCH_PROVINCES.map((p) => ({ ...p, areas: [...p.areas] })),
    keywordGroups: DEFAULT_KEYWORD_GROUPS.map((g) => ({ ...g, keywords: [...g.keywords] })),
    excludeKeywords: ["cà phê", "cafe", "trà sữa", "bánh mì", "chay"],
    targetSegments: [...DEFAULT_TARGET_SEGMENTS],
    maxLeads: 2000,
    minRating: null,
    minReviews: null,
    requirePhone: true,
    requireWebsite: false,
    searchMode: "TEXT" as const,
    discoveryTier: "PRO" as const,
    note: "Ưu tiên: có SĐT, đang hoạt động, điểm ≥ 65. Không tự gửi tin hàng loạt — lead đi Tìm thấy → Đủ điều kiện → Hàng đợi liên hệ.",
  };
}

/** Dựng mẫu nếu chưa có (gọi khi mở trang Săn khách sỉ). Idempotent theo `template_key`. */
export async function ensureTemplateCampaign(): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.wholesaleCampaigns)
    .values({ ...hslcTemplateValues(), status: "DRAFT", isTemplate: true, templateKey: HSLC_TEMPLATE_KEY, createdByName: "Mẫu hệ thống" })
    .onConflictDoNothing({ target: schema.wholesaleCampaigns.templateKey });
}

/** «Dùng mẫu»: chép mẫu thành một chiến dịch NHÁP mới — người xem lại rồi mới bấm Bắt đầu. */
export async function cloneCampaignCore(user: SessionUser, id: string): Promise<CoreResult<{ id: string }>> {
  if (!can(user, "wholesale:scan")) return { error: FORBIDDEN_SCAN };
  const db = await getDb();
  const src = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, id) });
  if (!src) return { error: "Không tìm thấy chiến dịch." };
  const stamp = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(schema.wholesaleCampaigns)
    .values({
      name: `${src.name.replace(/ · bản \d{4}-\d{2}-\d{2}$/, "")} · bản ${stamp}`.slice(0, 160),
      productFocus: src.productFocus,
      provinces: src.provinces,
      keywordGroups: src.keywordGroups,
      excludeKeywords: src.excludeKeywords,
      targetSegments: src.targetSegments,
      maxLeads: src.maxLeads,
      minRating: src.minRating,
      minReviews: src.minReviews,
      requirePhone: src.requirePhone,
      requireWebsite: src.requireWebsite,
      searchMode: src.searchMode,
      nearbyLat: src.nearbyLat,
      nearbyLng: src.nearbyLng,
      radiusM: src.radiusM,
      discoveryTier: src.discoveryTier,
      note: src.note,
      status: "DRAFT",
      createdByUserId: user.id,
      createdByName: user.name,
    })
    .returning({ id: schema.wholesaleCampaigns.id });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_CAMPAIGN_CREATE", entity: "WHOLESALE_CAMPAIGN", entityId: row!.id, after: { from: src.id, template: src.isTemplate }, reason: src.isTemplate ? "Tạo chiến dịch từ mẫu" : "Nhân bản chiến dịch" });
  return { ok: true, id: row!.id };
}
