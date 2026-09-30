import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  LIVE_BOARD_DEFAULT_PERIOD,
  LIVE_BOARD_PAGE_SIZE,
  LIVE_BOARD_PARAMS,
  LIVE_DEFAULT_SORT,
  LIVE_SORTABLE,
  LIVE_STATES,
  adsManagerUrl,
  filterLiveRows,
  liveStateOf,
  resolveLiveNames,
  sortLiveRows,
  summarizeLive,
  type FbNameSnapshot,
  type LiveBoardFilter,
  type LiveBoardRow,
  type LiveBoardSummary,
  type LiveState,
} from "@/lib/constants/creative-live-board";
import { CREATIVE_VERDICTS, SLOT_MODES, type CreativeVerdict, type SlotMode } from "@/lib/constants/creative-loop";
import { costPerOrderOf, describeRule, metricValue } from "@/lib/creative/judge";
import { listLiveVariants, unknownMetrics, variantMetrics, type JudgedVariant, type MetricsWindow, type VariantMetricsRow } from "@/lib/queries/creative-loop";
import { paramList, parseListParams, type Period, type SearchParams } from "@/lib/search-params";

/**
 * ═══════════ TAB ④ ĐANG CHẠY — MỘT LẦN ĐỌC CHO CẢ BẢNG ═══════════
 *
 * CHỈ ĐỌC. Ghép bốn nguồn, không nguồn nào tự tính lại thứ của nguồn khác:
 *  · camp + phán quyết SỐNG trên số đo TOÀN ĐỜI — `listLiveVariants` (cùng hàm lượt chấm dùng);
 *  · số đo TRONG KỲ — `variantMetrics(…, window)`, cùng công thức, chỉ thêm cửa sổ ngày;
 *  · tên chiến dịch / nhóm / quảng cáo trên Facebook — `fb_ads` + `fb_adsets` (lượt đồng bộ chi tiêu ghi lại mỗi lần);
 *  · độ tươi — lượt đồng bộ chi tiêu Facebook THÀNH CÔNG gần nhất (`sync_runs`).
 * Lọc · tìm · sắp xếp là hàm thuần ở `lib/constants/creative-live-board.ts`.
 */

export type LiveBoardQuery = LiveBoardFilter & { period: Period; sort: string; dir: "asc" | "desc"; page: number; pageSize: number };

export type FacetCount = { value: string; label: string; count: number };

export type LiveBoardData = {
  /** Dòng của TRANG đang xem. */
  rows: LiveBoardRow[];
  /** Bản đầy đủ của các dòng trên — máy chủ dựng hộp "Đăng lại camp" từ đây, không đi qua trình duyệt. */
  judged: Map<string, JudgedVariant>;
  /** Số camp sau lọc. */
  total: number;
  pageCount: number;
  /** Tổng hợp của TẬP ĐÃ LỌC (mọi trang). */
  summary: LiveBoardSummary;
  /** Số camp của kỳ trước khi lọc — để nói "N / M camp". */
  periodTotal: number;
  facets: { states: Record<LiveState, number>; verdicts: Partial<Record<CreativeVerdict, number>>; modes: Partial<Record<SlotMode, number>>; products: FacetCount[] };
  /** Lượt đồng bộ chi tiêu Facebook thành công gần nhất (ISO) — `null` = chưa có lượt nào. */
  fbSyncedAt: string | null;
  /** `false` = kỳ "Toàn bộ": số đo trong bảng là toàn đời camp. */
  windowed: boolean;
};

/** Tên Facebook của từng mẩu, khoá theo `ad_id`. Mẩu chưa vào sổ (chưa tiêu đồng nào) ⇒ không có mục. */
async function fbNamesOf(db: Db, adIds: string[]): Promise<Map<string, FbNameSnapshot & { accountId: string | null }>> {
  const out = new Map<string, FbNameSnapshot & { accountId: string | null }>();
  if (adIds.length === 0) return out;
  const fa = schema.fbAds;
  const fs = schema.fbAdsets;
  const rows = await db
    .select({ id: fa.id, ad: fa.name, campaign: fa.campaignName, adset: fs.name, accountId: fa.accountId, updatedAt: fa.updatedAt })
    .from(fa)
    .leftJoin(fs, eq(fs.id, fa.adsetId))
    .where(inArray(fa.id, adIds));
  for (const r of rows) {
    out.set(r.id, {
      campaign: r.campaign ?? "",
      adset: r.adset ?? "",
      ad: r.ad ?? "",
      syncedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      accountId: (r.accountId ?? "").replace(/^act_/, "").trim() || null,
    });
  }
  return out;
}

async function productLabelsOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const p = schema.products;
  const rows = await db.select({ id: p.id, name: p.name, code: p.customId }).from(p).where(inArray(p.id, ids));
  return new Map(rows.map((r) => [r.id, [r.code, r.name].filter((x) => x && x.trim()).join(" · ") || r.id]));
}

async function lastFbSync(db: Db): Promise<string | null> {
  const sr = schema.syncRuns;
  const [row] = await db
    .select({ at: sr.finishedAt })
    .from(sr)
    .where(and(eq(sr.source, "FACEBOOK"), eq(sr.job, "ads_insights"), eq(sr.status, "SUCCESS")))
    .orderBy(desc(sr.finishedAt))
    .limit(1);
  return row?.at ? new Date(row.at).toISOString() : null;
}

const round = (v: number | null) => (v === null ? null : Math.round(v));

export function toLiveRow(v: JudgedVariant, m: VariantMetricsRow, now: Date, fb: (FbNameSnapshot & { accountId: string | null }) | null, productLabel: string | null): LiveBoardRow {
  const adAccountId = fb?.accountId ?? v.adAccountId;
  const hasAd = !!(v.fbAdId ?? "").trim();
  return {
    id: v.id,
    batchId: v.batchId,
    slot: v.slot,
    headline: v.headline,
    imageId: v.imageId,
    imageAvailable: v.imageAvailable,
    productId: v.productId,
    productLabel: productLabel ?? v.productName ?? v.productId,
    mode: v.mode,
    status: v.status,
    state: liveStateOf(v.status, v.startAt, now),
    batchDay: v.batchDay,
    startAt: v.startAt,
    endAt: v.endAt,
    pausedAt: v.pausedAt,
    pauseReason: v.pauseReason,
    dailyBudget: v.dailyBudget,
    committedBudgetVnd: v.committedBudgetVnd,
    names: resolveLiveNames(fb, { campaign: v.campaignName, adset: v.adsetName, ad: v.adName }),
    fbCampaignId: v.fbCampaignId,
    fbAdsetId: v.fbAdsetId,
    fbAdId: v.fbAdId,
    adAccountId,
    adsManagerUrl: adsManagerUrl({ adAccountId, fbCampaignId: v.fbCampaignId, fbAdId: v.fbAdId }),
    spendVnd: m.spendVnd,
    impressions: m.impressions,
    clicks: m.clicks,
    messages: m.messages,
    // Đơn là số ĐẾM THẬT khi mẫu có mẩu QC (0 là 0); chưa có mẩu ⇒ CHƯA BIẾT.
    bookedOrders: hasAd ? m.bookedOrders : null,
    deliveredOrders: hasAd ? m.deliveredOrders : null,
    returnedOrders: hasAd ? m.returnedOrders : null,
    ordersDirect: m.attribution.direct.booked,
    ordersViaPost: m.attribution.viaPost.booked,
    bookedRevenueVnd: m.bookedRevenueVnd,
    cpm: round(metricValue(m, "cpm")),
    ctr: metricValue(m, "ctr"),
    cpc: round(metricValue(m, "cpc")),
    costPerMessage: round(metricValue(m, "costPerMessage")),
    costPerOrder: costPerOrderOf(m),
    lastSpendDate: m.lastSpendDate,
    verdict: v.verdict,
    reasons: v.reasons,
    keepChecks: v.keepChecks.map((c) => ({ text: describeRule(c.rule), pass: c.pass, value: c.value })),
    lifetimeSpendVnd: v.metrics.spendVnd,
    lifetimeOrders: v.metrics.bookedOrders,
  };
}

export async function loadLiveBoard(db: Db, now: Date, q: LiveBoardQuery): Promise<LiveBoardData> {
  const windowed = q.period.key !== "all" && (q.period.from !== null || q.period.to !== null);
  const range: MetricsWindow = windowed ? { from: q.period.from, to: q.period.to } : { from: null, to: null };
  const [judgedAll, fbSyncedAt] = await Promise.all([listLiveVariants(db, now, range), lastFbSync(db)]);

  const adIds = [...new Set(judgedAll.map((v) => (v.fbAdId ?? "").trim()).filter(Boolean))];
  const productIds = [...new Set(judgedAll.map((v) => v.productId).filter((x): x is string => !!x))];
  const [periodMetrics, fbNames, products] = await Promise.all([
    windowed
      ? variantMetrics(
          db,
          judgedAll.map((v) => ({ id: v.id, fbAdId: v.fbAdId, startAt: new Date(v.startAt) })),
          range,
        )
      : Promise.resolve(null),
    fbNamesOf(db, adIds),
    productLabelsOf(db, productIds),
  ]);

  const all = judgedAll.map((v) =>
    toLiveRow(v, periodMetrics ? (periodMetrics.get(v.id) ?? unknownMetrics()) : v.metrics, now, fbNames.get((v.fbAdId ?? "").trim()) ?? null, v.productId ? (products.get(v.productId) ?? null) : null),
  );

  const states = Object.fromEntries(LIVE_STATES.map((s) => [s, 0])) as Record<LiveState, number>;
  const verdicts: Partial<Record<CreativeVerdict, number>> = {};
  const modes: Partial<Record<SlotMode, number>> = {};
  const byProduct = new Map<string, FacetCount>();
  for (const r of all) {
    states[r.state] += 1;
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    modes[r.mode] = (modes[r.mode] ?? 0) + 1;
    if (r.productId) {
      const f = byProduct.get(r.productId) ?? { value: r.productId, label: r.productLabel ?? r.productId, count: 0 };
      f.count += 1;
      byProduct.set(r.productId, f);
    }
  }
  // Giữ thứ tự khai báo của hằng số — ô lọc không nhảy chỗ theo số đếm.
  const orderedVerdicts = Object.fromEntries(CREATIVE_VERDICTS.filter((v) => verdicts[v]).map((v) => [v, verdicts[v]])) as Partial<Record<CreativeVerdict, number>>;
  const orderedModes = Object.fromEntries(SLOT_MODES.filter((m) => modes[m]).map((m) => [m, modes[m]])) as Partial<Record<SlotMode, number>>;

  const filtered = sortLiveRows(filterLiveRows(all, q), q.sort, q.dir);
  const pageCount = Math.max(1, Math.ceil(filtered.length / q.pageSize));
  const page = Math.min(Math.max(1, q.page), pageCount);
  const rows = filtered.slice((page - 1) * q.pageSize, page * q.pageSize);
  const judgedById = new Map(judgedAll.map((v) => [v.id, v]));

  return {
    rows,
    judged: new Map(rows.flatMap((r) => (judgedById.has(r.id) ? [[r.id, judgedById.get(r.id) as JudgedVariant] as const] : []))),
    total: filtered.length,
    pageCount,
    summary: summarizeLive(filtered),
    periodTotal: all.length,
    facets: { states, verdicts: orderedVerdicts, modes: orderedModes, products: [...byProduct.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "vi")) },
    fbSyncedAt,
    windowed,
  };
}

/** Đọc bộ lọc từ URL — dùng chung cho trang và API xuất CSV, để hai nơi không hiểu URL theo hai cách. */
export function parseLiveBoardQuery(raw: SearchParams): LiveBoardQuery {
  const lp = parseListParams(raw, { defaultSort: LIVE_DEFAULT_SORT, defaultDir: "desc", defaultPageSize: LIVE_BOARD_PAGE_SIZE, defaultPeriod: LIVE_BOARD_DEFAULT_PERIOD, sortable: [...LIVE_SORTABLE] });
  return {
    q: lp.q,
    states: paramList(raw, LIVE_BOARD_PARAMS.state),
    verdicts: paramList(raw, LIVE_BOARD_PARAMS.verdict),
    products: paramList(raw, LIVE_BOARD_PARAMS.product),
    modes: paramList(raw, LIVE_BOARD_PARAMS.mode),
    period: lp.period,
    sort: lp.sort || LIVE_DEFAULT_SORT,
    dir: lp.dir,
    page: lp.page,
    pageSize: lp.pageSize,
  };
}
