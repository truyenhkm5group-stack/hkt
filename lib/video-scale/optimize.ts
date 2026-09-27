import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { CREATIVE_VERDICT_LABEL, type CreativeVerdict } from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import {
  OPTIMIZE_EVERY_MS,
  OPTIMIZER_STATE_KEY,
  VIDEO_ANGLE_LABEL,
  VIDEO_ANGLE_VOCAB_VERSION,
  actionForVerdict,
  isVideoAngle,
  nextScaledBudget,
  type VideoAdActionTaken,
  type VideoAngle,
  type VideoScaleConfig,
} from "@/lib/constants/video-scale";
import { addDays } from "@/lib/format";
import { judgeVariant } from "@/lib/creative/judge";
import { facebookErrorText, readAdVideoInsights, readReelInsights, type AdVideoDay, type ReelInsights } from "@/lib/integrations/facebook/ads-write";
import { readCurrentCreativeConfig, variantMetrics, type VariantMetricsRow } from "@/lib/queries/creative-loop";
import { DEFAULT_ADS_DEPS, optimizerHeartbeat, pauseVideoAd, setVideoAdBudget, type AdsDeps } from "@/lib/video-scale/ads";
import type { AngleStat } from "@/lib/video-scale/plan";
import { readVideoAutomation } from "@/lib/video-scale/publish";

/**
 * ═══════════ VIDEO SCALE — ĐO LƯỜNG + VÒNG TỐI ƯU ═══════════
 *
 * Đặc tả: `docs/video-scale.md` §PR4. Một lượt (mỗi ~55 phút, trong job `video-scale`):
 *  1. kéo số đo VIDEO của Meta cho từng quảng cáo (xem, ThruPlay, 25–100%) và ảnh chụp số đo bài Reel;
 *  2. chấm từng quảng cáo đã từng bật bằng CHÍNH `judgeVariant` + `variantMetrics` của vòng mẫu ảnh — tiền từ `ad_spends`
 *     (một nguồn), đơn từ `ORDER_AD_ID` + `ORDER_OUTCOME` (một công thức), luật tắt / giữ từ cấu hình Thư viện Media;
 *  3. hành động: THUA / luật tắt ⇒ TẮT (chỉ giảm tiền); TỐT ⇒ tăng ngân sách CHỈ khi mã bật tự tăng + đã khai ngưỡng đơn +
 *     đủ đơn + số chi mới tới hôm qua, và lượt tăng vẫn đi qua cổng ba trần; thiếu một điều ⇒ chỉ ĐỀ NGHỊ;
 *  4. rút BÀI HỌC từ phán quyết cuối (và lý do người loại video) — thứ người viết kịch bản đọc ở vòng sau, thứ sổ góc đếm.
 *
 * Số của Meta (lượt xem) và số của ERP (đơn, doanh thu) đứng RIÊNG ở mọi chỗ; không số nào của Meta vào phán quyết.
 */

const Ads = schema.videoScaleAds;
const V = schema.videoScaleVariants;
const Ps = schema.videoScalePosts;
const SK = schema.videoScaleSkus;
const VD = schema.videoScaleVerdicts;
const AM = schema.videoScaleAdMetrics;
const RM = schema.videoScaleReelMetrics;
const LS = schema.videoScaleLessons;
const RUN = schema.videoScaleRuns;

export type InsightsApi = {
  adVideo: (fbAdId: string, since: string, until: string) => Promise<AdVideoDay[]>;
  reel: (pageId: string, videoId: string) => Promise<ReelInsights>;
};

export const FACEBOOK_INSIGHTS_API: InsightsApi = { adVideo: readAdVideoInsights, reel: readReelInsights };

export type OptimizeDeps = {
  insights: InsightsApi;
  adsDeps: AdsDeps;
  /** Tạo vòng biến thể mới (vòng tự động) — tiêm để tránh vòng phụ thuộc `pipeline.ts` ↔ tệp này. */
  createRun?: (db: Db, input: { productId: string; sourceIds: string[]; variants: number; angles: string[]; brief: string; musicId: string | null }, actor: Actor) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
};

export const DEFAULT_OPTIMIZE_DEPS: OptimizeDeps = { insights: FACEBOOK_INSIGHTS_API, adsDeps: DEFAULT_ADS_DEPS };

/** Số chi của hôm qua (VN) phải có trước khi máy TỰ tăng tiền — số chi cũ hơn thì chỉ đề nghị. */
export const SCALE_NEEDS_SPEND_UNTIL_DAYS_AGO = 1;
/** Ảnh chụp số đo Reel: tối đa một lần / 6 giờ / bài, chỉ bài đăng trong 30 ngày. */
export const REEL_SNAPSHOT_EVERY_MS = 6 * 3_600_000;
export const MEASURE_LOOKBACK_DAYS = 30;

const MACHINE: Actor = { id: null, label: "Máy — vòng tối ưu Video Scale" };
const FINAL_VERDICTS: readonly CreativeVerdict[] = ["KILL", "LOSE", "PROMISING", "WIN"];

export type OptimizeResult = {
  judged: number;
  paused: number;
  scaled: number;
  recommended: number;
  adMetricRows: number;
  reelSnapshots: number;
  lessons: number;
  runsCreated: number;
  errors: string[];
};

type AdRow = typeof Ads.$inferSelect;

// ───────────────────────────── NHỊP ─────────────────────────────

/** Chạy một lượt nếu đã quá `OPTIMIZE_EVERY_MS` từ lượt trước. Mốc ghi TRƯỚC khi chạy — hai tiến trình không chạy chồng lâu. */
export async function maybeOptimize(db: Db, cfg: VideoScaleConfig, deps: OptimizeDeps = DEFAULT_OPTIMIZE_DEPS, now = new Date()): Promise<OptimizeResult | null> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, OPTIMIZER_STATE_KEY)).limit(1);
  let last = 0;
  try {
    last = Number((JSON.parse(row?.value ?? "{}") as { lastRunAt?: unknown }).lastRunAt ?? 0) || 0;
  } catch {
    last = 0;
  }
  if (now.getTime() - last < OPTIMIZE_EVERY_MS) return null;
  const value = JSON.stringify({ lastRunAt: now.getTime() });
  await db.insert(schema.settings).values({ key: OPTIMIZER_STATE_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  return runOptimize(db, cfg, deps, now);
}

export async function runOptimize(db: Db, cfg: VideoScaleConfig, deps: OptimizeDeps = DEFAULT_OPTIMIZE_DEPS, now = new Date()): Promise<OptimizeResult> {
  const out: OptimizeResult = { judged: 0, paused: 0, scaled: 0, recommended: 0, adMetricRows: 0, reelSnapshots: 0, lessons: 0, runsCreated: 0, errors: [] };
  const since = new Date(now.getTime() - MEASURE_LOOKBACK_DAYS * 86_400_000);
  const ads = await db
    .select()
    .from(Ads)
    .where(and(ne(Ads.fbAdId, ""), isNotNull(Ads.activatedAt), sql`(${Ads.status} = 'ACTIVE' or ${Ads.activatedAt} >= ${since})`));

  out.adMetricRows = await pullAdVideoMetrics(db, ads, deps, now, out.errors);
  out.reelSnapshots = await snapshotReels(db, deps, now, out.errors);
  const judged = await judgeAds(db, ads, cfg, deps, now, out);
  out.judged = judged;
  out.lessons = await refreshLessons(db, now);
  out.runsCreated = await autoNextRounds(db, cfg, deps, now, out.errors);
  return out;
}

// ───────────────────────────── SỐ ĐO META ─────────────────────────────

async function pullAdVideoMetrics(db: Db, ads: AdRow[], deps: OptimizeDeps, now: Date, errors: string[]): Promise<number> {
  const today = vnDay(now);
  let n = 0;
  for (const ad of ads) {
    const start = vnDay(ad.activatedAt as Date);
    const floor = addDays(today, -13);
    try {
      const days = await deps.insights.adVideo(ad.fbAdId, start > floor ? start : floor, today);
      for (const d of days) {
        const set = { videoPlays: d.videoPlays, thruplays: d.thruplays, p25: d.p25, p50: d.p50, p75: d.p75, p100: d.p100, fetchedAt: now };
        await db.insert(AM).values({ adId: ad.id, day: d.day, ...set }).onConflictDoUpdate({ target: [AM.adId, AM.day], set });
        n += 1;
      }
    } catch (e) {
      errors.push(`Số đo video của quảng cáo ${ad.adName}: ${facebookErrorText(e)}`);
    }
  }
  return n;
}

async function snapshotReels(db: Db, deps: OptimizeDeps, now: Date, errors: string[]): Promise<number> {
  const posts = await db
    .select({ id: Ps.id, pageId: Ps.pageId, fbVideoId: Ps.fbVideoId })
    .from(Ps)
    .where(and(eq(Ps.status, "PUBLISHED"), ne(Ps.fbVideoId, ""), gte(Ps.publishedAt, new Date(now.getTime() - MEASURE_LOOKBACK_DAYS * 86_400_000))));
  if (!posts.length) return 0;
  const recent = await db
    .select({ postId: RM.postId })
    .from(RM)
    .where(and(inArray(RM.postId, posts.map((p) => p.id)), gte(RM.capturedAt, new Date(now.getTime() - REEL_SNAPSHOT_EVERY_MS))));
  const fresh = new Set(recent.map((r) => r.postId));
  let n = 0;
  for (const p of posts) {
    if (fresh.has(p.id)) continue;
    try {
      const r = await deps.insights.reel(p.pageId, p.fbVideoId);
      await db.insert(RM).values({ postId: p.id, ...r, capturedAt: now });
    } catch (e) {
      const msg = facebookErrorText(e);
      await db.insert(RM).values({ postId: p.id, error: msg.slice(0, 500), capturedAt: now });
      errors.push(`Số đo Reel ${p.fbVideoId}: ${msg}`);
    }
    n += 1;
  }
  return n;
}

// ───────────────────────────── CHẤM + HÀNH ĐỘNG ─────────────────────────────

/** Bản tóm số đo lưu cạnh phán quyết — số ERP và số Meta tách hai nhóm, không trộn. */
export function verdictMetrics(m: VariantMetricsRow): Record<string, unknown> {
  return {
    spendVnd: m.spendVnd,
    impressions: m.impressions,
    clicks: m.clicks,
    messages: m.messages,
    bookedOrders: m.bookedOrders,
    deliveredOrders: m.deliveredOrders,
    returnedOrders: m.returnedOrders,
    killRuleOrders: m.killRuleOrders ?? null,
    bookedRevenueVnd: m.bookedRevenueVnd,
    deliveredRevenueVnd: m.deliveredRevenueVnd,
    lastSpendDate: m.lastSpendDate,
  };
}

/**
 * Hạ "tăng" xuống "đề nghị" khi số chi chưa mới tới hôm qua — hàm THUẦN. Quyết định tiêu thêm tiền trên số chi cũ là quyết
 * định trên dữ liệu thiếu (đồng bộ quảng cáo trễ ⇒ chi hôm qua CHƯA BIẾT, không phải 0).
 */
export function freshEnoughToScale(lastSpendDate: string | null, today: string): boolean {
  return lastSpendDate !== null && lastSpendDate >= addDays(today, -SCALE_NEEDS_SPEND_UNTIL_DAYS_AGO);
}

async function judgeAds(db: Db, ads: AdRow[], cfg: VideoScaleConfig, deps: OptimizeDeps, now: Date, out: OptimizeResult): Promise<number> {
  if (!ads.length) return 0;
  const { config } = await readCurrentCreativeConfig(db);
  const judgeCfg = { killRules: config.killRules, keepRules: config.keepRules, winOrdersAbove: config.winOrdersAbove, verdictSettleHours: config.verdictSettleHours };
  const metrics = await variantMetrics(
    db,
    ads.map((a) => ({ id: a.id, fbAdId: a.fbAdId, startAt: a.activatedAt })),
  );
  const skus = await db.select({ productId: SK.productId, autoScale: SK.autoScale }).from(SK).where(inArray(SK.productId, [...new Set(ads.map((a) => a.productId))]));
  const autoScaleOf = new Map(skus.map((s) => [s.productId, s.autoScale]));
  const automation = await readVideoAutomation(db);
  const today = vnDay(now);
  const existing = await db.select().from(VD).where(and(inArray(VD.adId, ads.map((a) => a.id)), eq(VD.day, today)));
  const existingOf = new Map(existing.map((r) => [r.adId, r]));
  let n = 0;
  for (const ad of ads) {
    const m = metrics.get(ad.id);
    if (!m || !ad.activatedAt) continue;
    const endAt = new Date(ad.activatedAt.getTime() + cfg.optimizeWindowDays * 86_400_000);
    const j = judgeVariant({ status: ad.status === "ACTIVE" ? "LIVE" : "PAUSED", startAt: ad.activatedAt, endAt, libraryAt: null, metrics: m }, judgeCfg, now);
    let action: VideoAdActionTaken = actionForVerdict({
      verdict: j.verdict,
      adActive: ad.status === "ACTIVE",
      autoScale: autoScaleOf.get(ad.productId) === true,
      minOrders: cfg.autoScaleMinOrders,
      bookedOrders: m.bookedOrders,
    });
    const reasons = [...j.reasons];
    if (action === "SCALE" && !freshEnoughToScale(m.lastSpendDate, today)) {
      action = "RECOMMEND_SCALE";
      reasons.push(`Số chi mới nhất là ngày ${m.lastSpendDate ?? "—"} — chưa tới hôm qua, máy chỉ đề nghị, không tự tăng.`);
    }
    if (action === "SCALE" && !cfg.enabled) {
      action = "RECOMMEND_SCALE";
      reasons.push("Video Scale đang TẮT — máy chỉ đề nghị.");
    }
    if (action === "SCALE" && automation.paused) {
      action = "RECOMMEND_SCALE";
      reasons.push("Video Scale đang dừng mọi tự động — máy chỉ đề nghị.");
    }
    const prev = existingOf.get(ad.id);
    let result = prev && prev.action === action ? prev.actionResult : "";
    const alreadyApplied = result.startsWith("APPLIED");
    if (!alreadyApplied) {
      if (action === "PAUSE") {
        const r = await pauseVideoAd(db, ad.id, null, `Vòng tối ưu: ${CREATIVE_VERDICT_LABEL[j.verdict]} — ${j.reasons.join(" ")}`.slice(0, 300), deps.adsDeps, now);
        result = r.ok ? `APPLIED: ${r.detail}` : `FAILED: ${r.error}`;
        if (r.ok) out.paused += 1;
      } else if (action === "SCALE") {
        const next = nextScaledBudget(ad.dailyBudgetVnd, cfg.scaleStepPct);
        if (next <= ad.dailyBudgetVnd) {
          action = "RECOMMEND_SCALE";
          result = "Ngân sách đã ở trần mỗi quảng cáo — không tăng được nữa.";
        } else {
          const r = await setVideoAdBudget(db, ad.id, next, null, cfg, deps.adsDeps, now);
          result = r.ok ? `APPLIED: ${ad.dailyBudgetVnd.toLocaleString("vi-VN")}đ → ${next.toLocaleString("vi-VN")}đ` : `DENIED: ${r.error}`;
          if (r.ok) out.scaled += 1;
        }
      } else if (action === "RECOMMEND_SCALE") {
        result = "Chờ người quyết tăng ngân sách (thẻ quảng cáo → Đổi ngân sách).";
      }
    }
    if (action === "RECOMMEND_SCALE") out.recommended += 1;
    const set = { verdict: j.verdict, reasons, metrics: verdictMetrics(m), action, actionResult: result.slice(0, 500), updatedAt: now };
    await db.insert(VD).values({ adId: ad.id, day: today, ...set }).onConflictDoUpdate({ target: [VD.adId, VD.day], set });
    n += 1;
  }
  return n;
}

// ───────────────────────────── BÀI HỌC ─────────────────────────────

type ScriptView = { hook: string };

function hookOf(script: unknown): string {
  const s = script as Partial<ScriptView> | null;
  return typeof s?.hook === "string" ? s.hook.slice(0, 160) : "";
}

const vndText = (n: number | null) => (n === null ? "—" : `${Math.round(n).toLocaleString("vi-VN")}đ`);

/** Câu bài học từ phán quyết — hàm THUẦN, chỉ in số đã đếm. */
export function lessonSummary(input: { angle: string; hook: string; verdict: CreativeVerdict; metrics: Record<string, unknown>; thruplays: number | null }): string {
  const m = input.metrics;
  const num = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : null);
  const spend = num("spendVnd");
  const booked = num("bookedOrders") ?? 0;
  const cpo = spend !== null && booked > 0 ? spend / booked : null;
  const angle = isVideoAngle(input.angle) ? VIDEO_ANGLE_LABEL[input.angle] : input.angle;
  const parts = [`chi ${vndText(spend)}`, `${booked} đơn chốt`, `${num("deliveredOrders") ?? 0} giao TC`, `chi/đơn ${vndText(cpo)}`];
  if (input.thruplays !== null) parts.push(`${input.thruplays.toLocaleString("vi-VN")} ThruPlay (Meta)`);
  return `Góc "${angle}", móc câu "${input.hook}": ${CREATIVE_VERDICT_LABEL[input.verdict]} — ${parts.join(", ")}.`;
}

/**
 * Một bài học / (biến thể, nguồn), lấy PHÁN QUYẾT CUỐI mới nhất của quảng cáo của biến thể (nhiều quảng cáo ⇒ quảng cáo có
 * nhiều đơn nhất). Lý do người loại video cũng thành bài học (`REVIEW`, `success = null` — không đếm vào sổ góc).
 */
async function refreshLessons(db: Db, now: Date): Promise<number> {
  let n = 0;
  const since = new Date(now.getTime() - MEASURE_LOOKBACK_DAYS * 86_400_000);
  const rows = await db
    .select({ adId: VD.adId, day: VD.day, verdict: VD.verdict, metrics: VD.metrics, variantId: Ads.variantId, productId: Ads.productId, angle: V.angle, vocab: V.angleVocabVersion, script: V.script })
    .from(VD)
    .innerJoin(Ads, eq(Ads.id, VD.adId))
    .innerJoin(V, eq(V.id, Ads.variantId))
    .where(and(inArray(VD.verdict, [...FINAL_VERDICTS]), gte(VD.updatedAt, since), eq(V.isTest, false)))
    .orderBy(desc(VD.day));
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.variantId);
    const orders = (x: (typeof rows)[number]) => Number((x.metrics as Record<string, unknown>).bookedOrders ?? 0);
    if (!cur || (r.day === cur.day ? orders(r) > orders(cur) : false)) best.set(r.variantId, r);
  }
  if (best.size) {
    const thru = await db
      .select({ adId: AM.adId, t: sql<string | null>`sum(${AM.thruplays})` })
      .from(AM)
      .where(inArray(AM.adId, [...best.values()].map((r) => r.adId)))
      .groupBy(AM.adId);
    const thruOf = new Map(thru.map((t) => [t.adId, t.t === null ? null : Number(t.t)]));
    for (const r of best.values()) {
      const verdict = r.verdict as CreativeVerdict;
      const hook = hookOf(r.script);
      const metrics = r.metrics as Record<string, unknown>;
      const set = {
        angle: r.angle,
        angleVocabVersion: r.vocab,
        hook,
        verdict,
        success: verdict === "PROMISING" || verdict === "WIN",
        summary: lessonSummary({ angle: r.angle, hook, verdict, metrics, thruplays: thruOf.get(r.adId) ?? null }),
        metrics,
      };
      await db.insert(LS).values({ variantId: r.variantId, productId: r.productId, source: "AD", ...set }).onConflictDoUpdate({ target: [LS.variantId, LS.source], set });
      n += 1;
    }
  }
  const rejected = await db
    .select({ id: V.id, productId: V.productId, angle: V.angle, vocab: V.angleVocabVersion, script: V.script, note: V.reviewNote })
    .from(V)
    .where(and(eq(V.status, "REJECTED"), ne(V.reviewNote, ""), eq(V.isTest, false), gte(V.updatedAt, since)));
  for (const r of rejected) {
    const hook = hookOf(r.script);
    const angle = isVideoAngle(r.angle) ? VIDEO_ANGLE_LABEL[r.angle] : r.angle;
    const set = { angle: r.angle, angleVocabVersion: r.vocab, hook, verdict: "REJECTED", success: null, summary: `Video góc "${angle}" bị người loại: ${r.note.slice(0, 240)}`, metrics: {} };
    await db.insert(LS).values({ variantId: r.id, productId: r.productId, source: "REVIEW", ...set }).onConflictDoUpdate({ target: [LS.variantId, LS.source], set });
    n += 1;
  }
  return n;
}

/**
 * Sổ góc cho bộ chọn góc (Thompson): đếm bài học `AD` cùng phiên bản từ vựng. Mã có ≥ 3 bài học của CHÍNH nó ⇒ dùng của
 * nó; ít hơn ⇒ dùng của cả shop (góc bán hiệu quả với cùng tệp khách thường giống nhau giữa các mã).
 */
export async function angleStatsFor(db: Db, productId: string): Promise<AngleStat[]> {
  const base = and(eq(LS.source, "AD"), eq(LS.angleVocabVersion, VIDEO_ANGLE_VOCAB_VERSION), isNotNull(LS.success));
  const count = (where: ReturnType<typeof and>) =>
    db
      .select({ angle: LS.angle, tried: sql<string>`count(*)`, success: sql<string>`count(*) filter (where ${LS.success})` })
      .from(LS)
      .where(where)
      .groupBy(LS.angle);
  let rows = await count(and(base, eq(LS.productId, productId)));
  if (rows.reduce((s, r) => s + Number(r.tried), 0) < 3) rows = await count(base);
  return rows.filter((r) => isVideoAngle(r.angle)).map((r) => ({ angle: r.angle as VideoAngle, tried: Number(r.tried), success: Number(r.success) }));
}

/** Tối đa 8 câu bài học cho người viết kịch bản: của mã trước (mới nhất), rồi các video THẮNG của cả shop. */
export async function lessonsFor(db: Db, productId: string): Promise<string[]> {
  const own = await db.select({ s: LS.summary }).from(LS).where(eq(LS.productId, productId)).orderBy(desc(LS.createdAt)).limit(6);
  const wins = await db
    .select({ s: LS.summary })
    .from(LS)
    .where(and(ne(LS.productId, productId), eq(LS.source, "AD"), eq(LS.success, true)))
    .orderBy(desc(LS.createdAt))
    .limit(8 - own.length);
  return [...own, ...wins].map((r) => r.s);
}

// ───────────────────────────── VÒNG TIẾP THEO TỰ ĐỘNG ─────────────────────────────

const LIVE_RUN = ["SCRIPTING", "PRODUCING", "REVIEW"];

/**
 * Mã bật `auto_next_round` ⇒ mỗi ngày tối đa MỘT vòng mới, dùng lại ảnh gốc / số biến thể / ý tưởng / nhạc của vòng gần
 * nhất và để bộ chọn góc (đã đọc sổ học) chọn góc. Không tạo khi: Video Scale tắt · dừng tự động (module / mã) · mã còn vòng
 * đang chạy · hôm nay đã có vòng · mã chưa có bài học quảng cáo nào (chưa học được gì thì vòng mới chỉ là tiêu tiền lặp lại).
 * Trần USD / ngày vẫn chặn ở từng clip.
 */
async function autoNextRounds(db: Db, cfg: VideoScaleConfig, deps: OptimizeDeps, now: Date, errors: string[]): Promise<number> {
  if (!cfg.enabled || !deps.createRun) return 0;
  const automation = await readVideoAutomation(db);
  if (automation.paused) return 0;
  const skus = await db.select({ productId: SK.productId }).from(SK).where(and(eq(SK.autoNextRound, true), sql`${SK.automationPausedAt} is null`));
  let n = 0;
  const today = vnDay(now);
  for (const s of skus) {
    const [live] = await db.select({ id: RUN.id }).from(RUN).where(and(eq(RUN.productId, s.productId), inArray(RUN.status, LIVE_RUN))).limit(1);
    if (live) continue;
    const [last] = await db.select().from(RUN).where(and(eq(RUN.productId, s.productId), eq(RUN.isTest, false))).orderBy(desc(RUN.createdAt)).limit(1);
    if (!last || vnDay(last.createdAt) === today) continue;
    const [lesson] = await db.select({ id: LS.id }).from(LS).where(and(eq(LS.productId, s.productId), eq(LS.source, "AD"))).limit(1);
    if (!lesson) continue;
    const r = await deps.createRun(db, { productId: s.productId, sourceIds: last.sourceIds, variants: last.variantsRequested, angles: [], brief: last.brief, musicId: last.musicId }, MACHINE);
    if (r.ok) n += 1;
    else errors.push(`Vòng tự động cho mã ${s.productId}: ${r.error}`);
  }
  return n;
}

/** Lượt tối ưu gần nhất (cho màn hình) — cùng nhịp tim mà cổng bật quảng cáo đọc. */
export const lastOptimizeAt = optimizerHeartbeat;

