import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CAMPAIGN_WIN_STATES } from "@/lib/constants/campaign-setup";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { MODEL_STATE_LABELS, isModelState } from "@/lib/constants/model-lifecycle";
import { effectiveRender, normalizeRenderOptions, normalizeVideoScaleConfig, type EffectiveRender, type VideoQcVerdict, type VideoReviewMode, type VideoScript } from "@/lib/constants/video-scale";
import { unknownMetrics, variantMetrics, type VariantMetricsRow } from "@/lib/queries/creative-loop";

/**
 * ═══════════ ĐỌC CHO MÀN HÌNH VIDEO SCALE ═══════════
 *
 * Chỉ đọc. "Mã win" = mẫu người đã KHAI từ "Thắng test" trở đi (`CAMPAIGN_WIN_STATES`, cùng danh sách của "Đăng camp") —
 * máy không tự coi một mã là thắng.
 */

const tRun = schema.videoScaleRuns;
const tVar = schema.videoScaleVariants;
const tJob = schema.videoScaleJobs;

export type WinProductRow = {
  productId: string;
  name: string;
  code: string;
  image: string | null;
  stateLabel: string;
  photoCount: number;
  reviewMode: VideoReviewMode | null;
  /** Fanpage ĐƯỢC DUYỆT cho mã. `null` = chưa gán ⇒ không đăng được. */
  pageId: string | null;
  /** `null` = theo fanpage · `MANUAL_REVIEW` = mã luôn chờ người. */
  publishMode: string | null;
  pausedAt: Date | null;
  pausedReason: string;
  adAccountId: string | null;
  adsMode: string;
  dailyBudgetPerAdVnd: number | null;
  skuDailyCapVnd: number | null;
  autoScale: boolean;
  autoNextRound: boolean;
  adsModeBy: string;
  runs: number;
  inProduction: number;
  awaitingReview: number;
  approved: number;
};

export async function listWinProducts(db: Db): Promise<WinProductRow[]> {
  const tProd = schema.products;
  const tModel = schema.productModels;
  const tSrc = schema.creativeSources;
  const rows = await db
    .select({ productId: tProd.id, name: tProd.name, customId: tProd.customId, modelCode: tModel.code, image: tProd.image, state: tModel.lifecycleState })
    .from(tModel)
    .innerJoin(tProd, eq(tProd.id, tModel.productId))
    .where(inArray(tModel.lifecycleState, [...CAMPAIGN_WIN_STATES]))
    .orderBy(asc(tModel.code));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.productId);
  const [photos, skus, variantStats, runStats] = await Promise.all([
    db
      .select({ productId: tSrc.productId, n: sql<string>`count(*)` })
      .from(tSrc)
      .where(and(inArray(tSrc.productId, ids), eq(tSrc.kind, "PRODUCT_PHOTO"), eq(tSrc.active, true), isNotNull(tSrc.imageId)))
      .groupBy(tSrc.productId),
    db
      .select({
        productId: schema.videoScaleSkus.productId,
        reviewMode: schema.videoScaleSkus.reviewMode,
        pageId: schema.videoScaleSkus.pageId,
        publishMode: schema.videoScaleSkus.publishMode,
        pausedAt: schema.videoScaleSkus.automationPausedAt,
        pausedReason: schema.videoScaleSkus.automationPausedReason,
        adAccountId: schema.videoScaleSkus.adAccountId,
        adsMode: schema.videoScaleSkus.adsMode,
        dailyBudgetPerAdVnd: schema.videoScaleSkus.dailyBudgetPerAdVnd,
        skuDailyCapVnd: schema.videoScaleSkus.skuDailyCapVnd,
        autoScale: schema.videoScaleSkus.autoScale,
        autoNextRound: schema.videoScaleSkus.autoNextRound,
        adsModeBy: schema.videoScaleSkus.adsModeBy,
      })
      .from(schema.videoScaleSkus)
      .where(inArray(schema.videoScaleSkus.productId, ids)),
    db
      .select({
        productId: tVar.productId,
        prod: sql<string>`count(*) filter (where ${tVar.status} in ('SCRIPTED','GENERATING','RENDERING','QC'))`,
        review: sql<string>`count(*) filter (where ${tVar.status} = 'REVIEW')`,
        approved: sql<string>`count(*) filter (where ${tVar.status} = 'APPROVED')`,
      })
      .from(tVar)
      .where(inArray(tVar.productId, ids))
      .groupBy(tVar.productId),
    db.select({ productId: tRun.productId, n: sql<string>`count(*)` }).from(tRun).where(inArray(tRun.productId, ids)).groupBy(tRun.productId),
  ]);
  const photoBy = new Map(photos.map((p) => [p.productId, Number(p.n)]));
  const skuBy = new Map(skus.map((s) => [s.productId, s]));
  const vBy = new Map(variantStats.map((v) => [v.productId, v]));
  const rBy = new Map(runStats.map((r) => [r.productId, Number(r.n)]));
  return rows.map((r) => {
    const v = vBy.get(r.productId);
    return {
      productId: r.productId,
      name: r.name,
      code: r.modelCode || r.customId || "",
      image: r.image,
      stateLabel: r.state && isModelState(r.state) ? MODEL_STATE_LABELS[r.state] : "",
      photoCount: photoBy.get(r.productId) ?? 0,
      reviewMode: (skuBy.get(r.productId)?.reviewMode as VideoReviewMode | undefined) ?? null,
      pageId: skuBy.get(r.productId)?.pageId ?? null,
      publishMode: skuBy.get(r.productId)?.publishMode ?? null,
      pausedAt: skuBy.get(r.productId)?.pausedAt ?? null,
      pausedReason: skuBy.get(r.productId)?.pausedReason ?? "",
      adAccountId: skuBy.get(r.productId)?.adAccountId ?? null,
      adsMode: skuBy.get(r.productId)?.adsMode ?? "DRAFT",
      dailyBudgetPerAdVnd: skuBy.get(r.productId)?.dailyBudgetPerAdVnd ?? null,
      skuDailyCapVnd: skuBy.get(r.productId)?.skuDailyCapVnd ?? null,
      autoScale: skuBy.get(r.productId)?.autoScale ?? false,
      autoNextRound: skuBy.get(r.productId)?.autoNextRound ?? false,
      adsModeBy: skuBy.get(r.productId)?.adsModeBy ?? "",
      runs: rBy.get(r.productId) ?? 0,
      inProduction: Number(v?.prod ?? 0),
      awaitingReview: Number(v?.review ?? 0),
      approved: Number(v?.approved ?? 0),
    };
  });
}

export type SourcePhoto = { id: string; imageId: string; title: string };

export async function listProductPhotos(db: Db, productId: string): Promise<SourcePhoto[]> {
  const tSrc = schema.creativeSources;
  const rows = await db
    .select({ id: tSrc.id, imageId: tSrc.imageId, title: tSrc.title })
    .from(tSrc)
    .where(and(eq(tSrc.productId, productId), eq(tSrc.kind, "PRODUCT_PHOTO"), eq(tSrc.active, true), isNotNull(tSrc.imageId)))
    .orderBy(desc(tSrc.createdAt))
    .limit(24);
  return rows.map((r) => ({ id: r.id, imageId: r.imageId as string, title: r.title }));
}

export type RunRow = {
  id: string;
  productId: string;
  productName: string;
  status: string;
  variantsRequested: number;
  variants: number;
  isTest: boolean;
  createdBy: string;
  createdAt: Date;
  error: string;
  /** Tiền ước tính theo bảng giá (clip đã xong + kịch bản + QC). `null` = CHƯA BIẾT. */
  costUsd: number | null;
  /** Tiền giữ chỗ trong trần (gồm lượt hỏng). */
  reservedUsd: number;
};

export async function listRuns(db: Db, limit = 30): Promise<RunRow[]> {
  const tProd = schema.products;
  const rows = await db
    .select({
      id: tRun.id,
      productId: tRun.productId,
      productName: tProd.name,
      status: tRun.status,
      variantsRequested: tRun.variantsRequested,
      isTest: tRun.isTest,
      createdBy: tRun.createdBy,
      createdAt: tRun.createdAt,
      error: tRun.error,
      // Câu con tương quan: viết TÊN BẢNG tường minh — `${tRun.id}` trong câu con có thể in thành "id" trần và so nhầm với
      // cột id của chính bảng con (sai im lặng, đã cắn một lần trong kho).
      variants: sql<string>`(select count(*) from "video_scale_variants" vv where vv."run_id" = "video_scale_runs"."id")`,
      cost: sql<string | null>`(select sum(jj."cost_usd") from "video_scale_jobs" jj where jj."run_id" = "video_scale_runs"."id")`,
      reserved: sql<string>`(select coalesce(sum(jj."reserved_usd"), 0) from "video_scale_jobs" jj where jj."run_id" = "video_scale_runs"."id")`,
    })
    .from(tRun)
    .innerJoin(tProd, eq(tProd.id, tRun.productId))
    .orderBy(desc(tRun.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, variants: Number(r.variants), costUsd: r.cost === null ? null : Number(r.cost), reservedUsd: Number(r.reserved) }));
}

export type VariantCard = {
  id: string;
  runId: string;
  productId: string;
  productName: string;
  seq: number;
  angle: string;
  status: string;
  script: VideoScript;
  sourceImageId: string | null;
  finalAssetId: string | null;
  thumbnailAssetId: string | null;
  durationMs: number | null;
  qcVerdict: VideoQcVerdict | null;
  qc: Record<string, unknown>;
  reviewedBy: string;
  reviewNote: string;
  autoApproved: boolean;
  isTest: boolean;
  error: string;
  createdAt: Date;
  captionOptions: Record<string, unknown>[];
  caption: string;
  captionState: string;
  captionBy: string;
  /** Tuỳ chọn dựng HIỆU LỰC (cấu hình lượt ⊕ tuỳ chọn riêng của video) — trình "Sửa video" mở từ đây. */
  render: EffectiveRender;
  renderRev: number;
  /** Có quảng cáo từ video này chưa (có thì không sửa đè). */
  hasAd: boolean;
  /** Bài Reel gần nhất của biến thể (nếu có). */
  post: { id: string; status: string; permalink: string; error: string; publishAt: Date | null; publishedAt: Date | null; auto: boolean } | null;
};

export async function listVariants(db: Db, filter: { statuses?: string[]; runId?: string; limit?: number }): Promise<VariantCard[]> {
  const tProd = schema.products;
  const tSrc = schema.creativeSources;
  const rows = await db
    .select({
      id: tVar.id,
      runId: tVar.runId,
      productId: tVar.productId,
      productName: tProd.name,
      seq: tVar.seq,
      angle: tVar.angle,
      status: tVar.status,
      script: tVar.script,
      sourceImageId: tSrc.imageId,
      finalAssetId: tVar.finalAssetId,
      thumbnailAssetId: tVar.thumbnailAssetId,
      durationMs: tVar.durationMs,
      qcVerdict: tVar.qcVerdict,
      qc: tVar.qc,
      reviewedBy: tVar.reviewedBy,
      reviewNote: tVar.reviewNote,
      autoApproved: tVar.autoApproved,
      isTest: tVar.isTest,
      error: tVar.error,
      createdAt: tVar.createdAt,
      captionOptions: tVar.captionOptions,
      caption: tVar.caption,
      captionState: tVar.captionState,
      captionBy: tVar.captionBy,
      renderOptions: tVar.renderOptions,
      renderRev: tVar.renderRev,
      runSnap: tRun.configSnapshot,
      runMusicId: tRun.musicId,
    })
    .from(tVar)
    .innerJoin(tProd, eq(tProd.id, tVar.productId))
    .innerJoin(tRun, eq(tRun.id, tVar.runId))
    .leftJoin(tSrc, eq(tSrc.id, tVar.sourceId))
    .where(and(filter.statuses?.length ? inArray(tVar.status, filter.statuses) : undefined, filter.runId ? eq(tVar.runId, filter.runId) : undefined))
    .orderBy(desc(tVar.createdAt), asc(tVar.seq))
    .limit(filter.limit ?? 60);
  const tPost = schema.videoScalePosts;
  const posts = rows.length
    ? await db
        .select({ variantId: tPost.variantId, id: tPost.id, status: tPost.status, permalink: tPost.permalink, error: tPost.error, publishAt: tPost.publishAt, publishedAt: tPost.publishedAt, auto: tPost.auto, updatedAt: tPost.updatedAt })
        .from(tPost)
        .where(inArray(tPost.variantId, rows.map((r) => r.id)))
        .orderBy(desc(tPost.updatedAt))
    : [];
  const postBy = new Map<string, (typeof posts)[number]>();
  for (const p of posts) if (!postBy.has(p.variantId)) postBy.set(p.variantId, p);
  const adRows = rows.length ? await db.select({ variantId: schema.videoScaleAds.variantId }).from(schema.videoScaleAds).where(inArray(schema.videoScaleAds.variantId, rows.map((r) => r.id))) : [];
  const withAd = new Set(adRows.map((a) => a.variantId));
  return rows.map(({ runSnap, runMusicId, renderOptions, ...r }) => {
    const p = postBy.get(r.id);
    const render = effectiveRender(normalizeVideoScaleConfig(runSnap), runMusicId, normalizeRenderOptions(renderOptions));
    return { ...r, render, hasAd: withAd.has(r.id), script: r.script as unknown as VideoScript, qcVerdict: r.qcVerdict as VideoQcVerdict | null, post: p ? { id: p.id, status: p.status, permalink: p.permalink, error: p.error, publishAt: p.publishAt, publishedAt: p.publishedAt, auto: p.auto } : null };
  });
}

export type JobRowView = {
  id: string;
  kind: string;
  status: string;
  runId: string | null;
  variantId: string | null;
  sceneIndex: number | null;
  productName: string | null;
  attempts: number;
  maxAttempts: number;
  error: string;
  errorKind: string;
  costUsd: number | null;
  reservedUsd: number | null;
  nextRunAt: Date;
  lockedUntil: Date | null;
  updatedAt: Date;
  isTest: boolean;
};

export async function listJobs(db: Db, opts: { active: boolean; limit?: number }): Promise<JobRowView[]> {
  const tProd = schema.products;
  const rows = await db
    .select({
      id: tJob.id,
      kind: tJob.kind,
      status: tJob.status,
      runId: tJob.runId,
      variantId: tJob.variantId,
      sceneIndex: tJob.sceneIndex,
      productName: tProd.name,
      attempts: tJob.attempts,
      maxAttempts: tJob.maxAttempts,
      error: tJob.error,
      errorKind: tJob.errorKind,
      costUsd: tJob.costUsd,
      reservedUsd: tJob.reservedUsd,
      nextRunAt: tJob.nextRunAt,
      lockedUntil: tJob.lockedUntil,
      updatedAt: tJob.updatedAt,
      isTest: tJob.isTest,
    })
    .from(tJob)
    .leftJoin(tRun, eq(tRun.id, tJob.runId))
    .leftJoin(tProd, eq(tProd.id, tRun.productId))
    .where(opts.active ? inArray(tJob.status, ["QUEUED", "RUNNING", "WAITING", "BLOCKED"]) : inArray(tJob.status, ["FAILED", "SUCCEEDED", "CANCELLED"]))
    .orderBy(opts.active ? asc(tJob.nextRunAt) : desc(tJob.updatedAt))
    .limit(opts.limit ?? 80);
  return rows;
}

export type SpendToday = { day: string; reservedUsd: number; estimatedUsd: number; clips: number };

/** Tiền sinh video hôm nay (giờ VN): giữ chỗ trong trần (gồm lượt hỏng) và ước tính của clip đã xong. */
export async function videoSpendOnDay(db: Db, now = new Date()): Promise<SpendToday> {
  const day = vnDay(now);
  const [r] = await db
    .select({
      reserved: sql<string>`coalesce(sum(${tJob.reservedUsd}), 0)`,
      est: sql<string>`coalesce(sum(${tJob.costUsd}), 0)`,
      clips: sql<string>`count(*) filter (where ${tJob.reservedUsd} is not null)`,
    })
    .from(tJob)
    .where(and(eq(tJob.kind, "CLIP"), eq(tJob.costDay, day)));
  return { day, reservedUsd: Number(r?.reserved ?? 0), estimatedUsd: Number(r?.est ?? 0), clips: Number(r?.clips ?? 0) };
}

export type MusicRow = { id: string; title: string; licenseNote: string; assetId: string; active: boolean; uploadedBy: string; createdAt: Date };

export async function listMusic(db: Db): Promise<MusicRow[]> {
  const tModel = schema.videoScaleMusic;
  return db.select({ id: tModel.id, title: tModel.title, licenseNote: tModel.licenseNote, assetId: tModel.assetId, active: tModel.active, uploadedBy: tModel.uploadedBy, createdAt: tModel.createdAt }).from(tModel).orderBy(desc(tModel.createdAt));
}

export type VideoScaleCounts = { review: number; activeJobs: number; blockedJobs: number; failedJobs24h: number };

export async function loadVideoScaleCounts(db: Db, now = new Date()): Promise<VideoScaleCounts> {
  const since = new Date(now.getTime() - 86_400_000);
  const [v, j] = await Promise.all([
    db.select({ n: sql<string>`count(*)` }).from(tVar).where(eq(tVar.status, "REVIEW")),
    db
      .select({
        active: sql<string>`count(*) filter (where ${tJob.status} in ('QUEUED','RUNNING','WAITING'))`,
        blocked: sql<string>`count(*) filter (where ${tJob.status} = 'BLOCKED')`,
        failed: sql<string>`count(*) filter (where ${tJob.status} = 'FAILED' and ${tJob.updatedAt} >= ${since})`,
      })
      .from(tJob),
  ]);
  return { review: Number(v[0]?.n ?? 0), activeJobs: Number(j[0]?.active ?? 0), blockedJobs: Number(j[0]?.blocked ?? 0), failedJobs24h: Number(j[0]?.failed ?? 0) };
}

// ───────────────────────────── PR 2 — ĐĂNG REEL ─────────────────────────────

export type PostRow = {
  id: string;
  variantId: string;
  productName: string;
  seq: number;
  pageId: string;
  pageName: string;
  status: string;
  caption: string;
  publishAt: Date | null;
  publishedAt: Date | null;
  permalink: string;
  fbVideoId: string;
  error: string;
  auto: boolean;
  authorizedBy: string;
  createdAt: Date;
};

export async function listPosts(db: Db, limit = 60): Promise<PostRow[]> {
  const tPost = schema.videoScalePosts;
  const tProd = schema.products;
  const tPage = schema.fanpages;
  const rows = await db
    .select({
      id: tPost.id,
      variantId: tPost.variantId,
      productName: tProd.name,
      seq: tVar.seq,
      pageId: tPost.pageId,
      pageName: sql<string>`coalesce(nullif(${tPage.alias}, ''), nullif(${tPage.name}, ''), ${tPost.pageId})`,
      status: tPost.status,
      caption: tPost.caption,
      publishAt: tPost.publishAt,
      publishedAt: tPost.publishedAt,
      permalink: tPost.permalink,
      fbVideoId: tPost.fbVideoId,
      error: tPost.error,
      auto: tPost.auto,
      authorizedBy: tPost.authorizedBy,
      createdAt: tPost.createdAt,
    })
    .from(tPost)
    .innerJoin(tVar, eq(tVar.id, tPost.variantId))
    .innerJoin(tProd, eq(tProd.id, tPost.productId))
    .leftJoin(tPage, eq(tPage.externalPageId, tPost.pageId))
    .orderBy(desc(tPost.createdAt))
    .limit(limit);
  return rows;
}

export type PageConfigRow = { pageId: string; name: string; orders30d: number; publishMode: string; maxPostsPerDay: number; pausedAt: Date | null; pausedReason: string; configured: boolean };

/** Fanpage ERP đã biết (xếp theo đơn 30 ngày) + cấu hình đăng. Fanpage chưa có dòng = chờ người duyệt (mặc định an toàn). */
export async function listPageConfigs(db: Db, pages: { id: string; name: string; orders30d: number }[]): Promise<PageConfigRow[]> {
  const tPageCfg = schema.videoScalePages;
  const cfg = await db.select().from(tPageCfg);
  const by = new Map(cfg.map((c) => [c.pageId, c]));
  return pages.map((p) => {
    const c = by.get(p.id);
    return { pageId: p.id, name: p.name, orders30d: p.orders30d, publishMode: c?.publishMode ?? "MANUAL_REVIEW", maxPostsPerDay: c?.maxPostsPerDay ?? 3, pausedAt: c?.pausedAt ?? null, pausedReason: c?.pausedReason ?? "", configured: Boolean(c) };
  });
}

// ───────────────────────────── PR 3 — QUẢNG CÁO ─────────────────────────────

export type AdRowView = {
  id: string;
  productName: string;
  seq: number;
  angle: string;
  pageId: string;
  adAccountId: string;
  mode: string;
  status: string;
  dailyBudgetVnd: number;
  campaignName: string;
  fbCampaignId: string;
  fbAdId: string;
  error: string;
  authorizedBy: string;
  activatedBy: string;
  activatedAt: Date | null;
  stopReason: string;
  createdAt: Date;
};

export async function listAds(db: Db, limit = 80): Promise<AdRowView[]> {
  const tAd = schema.videoScaleAds;
  const tProd = schema.products;
  return db
    .select({
      id: tAd.id,
      productName: tProd.name,
      seq: tVar.seq,
      angle: tVar.angle,
      pageId: tAd.pageId,
      adAccountId: tAd.adAccountId,
      mode: tAd.mode,
      status: tAd.status,
      dailyBudgetVnd: tAd.dailyBudgetVnd,
      campaignName: tAd.campaignName,
      fbCampaignId: tAd.fbCampaignId,
      fbAdId: tAd.fbAdId,
      error: tAd.error,
      authorizedBy: tAd.authorizedBy,
      activatedBy: tAd.activatedBy,
      activatedAt: tAd.activatedAt,
      stopReason: tAd.stopReason,
      createdAt: tAd.createdAt,
    })
    .from(tAd)
    .innerJoin(tVar, eq(tVar.id, tAd.variantId))
    .innerJoin(tProd, eq(tProd.id, tAd.productId))
    .orderBy(desc(tAd.createdAt))
    .limit(limit);
}

export type AdActionView = { id: string; adId: string | null; action: string; outcome: string; denial: string; detail: string; before: number | null; after: number | null; actor: string; createdAt: Date };

export async function listAdActions(db: Db, limit = 40): Promise<AdActionView[]> {
  const tAct = schema.videoScaleAdActions;
  return db
    .select({ id: tAct.id, adId: tAct.adId, action: tAct.action, outcome: tAct.outcome, denial: tAct.denial, detail: tAct.detail, before: tAct.budgetBeforeVnd, after: tAct.budgetAfterVnd, actor: tAct.actor, createdAt: tAct.createdAt })
    .from(tAct)
    .orderBy(desc(tAct.createdAt))
    .limit(limit);
}

/** Tổng ngân sách ngày quảng cáo Video Scale ĐANG CHẠY (VND). */
export async function activeAdsDailyVnd(db: Db): Promise<number> {
  const tAd = schema.videoScaleAds;
  const [r] = await db.select({ n: sql<string>`coalesce(sum(${tAd.dailyBudgetVnd}), 0)` }).from(tAd).where(eq(tAd.status, "ACTIVE"));
  return Number(r?.n ?? 0);
}

// ───────────────────────────── BÁO CÁO: MÃ → VIDEO → REEL → QUẢNG CÁO (PR 4) ─────────────────────────────

export type ReportAd = {
  id: string;
  adName: string;
  status: string;
  dailyBudgetVnd: number;
  activatedAt: Date | null;
  fbAdId: string;
  /** Số ERP — `variantMetrics` (tiền: `ad_spends`; đơn: `ORDER_AD_ID` + `ORDER_OUTCOME`). `null` = CHƯA BIẾT. */
  erp: VariantMetricsRow;
  /** Số của META (không phải tiền, không vào phán quyết). `null` = Meta chưa trả. */
  meta: { videoPlays: number | null; thruplays: number | null; p100: number | null };
  verdict: { day: string; verdict: string; action: string; actionResult: string; reasons: string[] } | null;
};

export type ReportPost = {
  id: string;
  pageId: string;
  status: string;
  permalink: string;
  publishedAt: Date | null;
  snapshot: { plays: number | null; reach: number | null; reactions: number | null; comments: number | null; shares: number | null; error: string; capturedAt: Date } | null;
};

export type ReportVariant = {
  id: string;
  runId: string;
  seq: number;
  angle: string;
  hook: string;
  status: string;
  qcVerdict: string | null;
  isTest: boolean;
  sourceId: string;
  /** Tiền AI ƯỚC TÍNH theo bảng giá (clip + giọng đọc + QC + content) của riêng biến thể. `null` = chưa việc nào ghi tiền. */
  aiUsd: number | null;
  createdAt: Date;
  posts: ReportPost[];
  ads: ReportAd[];
  lesson: string | null;
};

export type ReportSku = {
  productId: string;
  name: string;
  code: string;
  runs: number;
  /** Tiền AI của cả mã: biến thể + việc cấp lượt (viết kịch bản). */
  aiUsd: number | null;
  variants: ReportVariant[];
};

/** Cây báo cáo. Số quảng cáo tính TỪ LÚC BẬT tới nay (không theo kỳ) — mỗi quảng cáo có một đời riêng. */
export async function getVideoScaleReport(db: Db, opts: { includeTest: boolean; limitVariants?: number }): Promise<ReportSku[]> {
  const tAd = schema.videoScaleAds;
  const tPost = schema.videoScalePosts;
  const tProd = schema.products;
  const tModel = schema.productModels;
  const tVerdict = schema.videoScaleVerdicts;
  const tMetric = schema.videoScaleAdMetrics;
  const tReel = schema.videoScaleReelMetrics;
  const tLesson = schema.videoScaleLessons;

  const variants = await db
    .select({ id: tVar.id, runId: tVar.runId, productId: tVar.productId, seq: tVar.seq, angle: tVar.angle, script: tVar.script, status: tVar.status, qcVerdict: tVar.qcVerdict, isTest: tVar.isTest, sourceId: tVar.sourceId, createdAt: tVar.createdAt })
    .from(tVar)
    .where(opts.includeTest ? undefined : eq(tVar.isTest, false))
    .orderBy(desc(tVar.createdAt))
    .limit(opts.limitVariants ?? 200);
  if (!variants.length) return [];
  const vIds = variants.map((v) => v.id);
  const pIds = [...new Set(variants.map((v) => v.productId))];
  const rIds = [...new Set(variants.map((v) => v.runId))];

  const [prods, codes, varCost, runCost, runCount, posts, ads, lessons] = await Promise.all([
    db.select({ id: tProd.id, name: tProd.name, customId: tProd.customId }).from(tProd).where(inArray(tProd.id, pIds)),
    db.select({ productId: tModel.productId, code: tModel.code }).from(tModel).where(inArray(tModel.productId, pIds)),
    db.select({ variantId: tJob.variantId, usd: sql<string | null>`sum(${tJob.costUsd})` }).from(tJob).where(inArray(tJob.variantId, vIds)).groupBy(tJob.variantId),
    db
      .select({ runId: tJob.runId, usd: sql<string | null>`sum(${tJob.costUsd})` })
      .from(tJob)
      .where(and(inArray(tJob.runId, rIds), sql`${tJob.variantId} is null`))
      .groupBy(tJob.runId),
    db.select({ productId: tRun.productId, n: sql<string>`count(*)` }).from(tRun).where(inArray(tRun.productId, pIds)).groupBy(tRun.productId),
    db.select().from(tPost).where(inArray(tPost.variantId, vIds)),
    db.select().from(tAd).where(inArray(tAd.variantId, vIds)),
    db.select({ variantId: tLesson.variantId, source: tLesson.source, summary: tLesson.summary }).from(tLesson).where(inArray(tLesson.variantId, vIds)),
  ]);

  const postIds = posts.map((p) => p.id);
  const adIds = ads.map((a) => a.id);
  const [snaps, metaRows, verdicts, erp] = await Promise.all([
    postIds.length
      ? db
          .selectDistinctOn([tReel.postId], { postId: tReel.postId, plays: tReel.plays, reach: tReel.reach, reactions: tReel.reactions, comments: tReel.comments, shares: tReel.shares, error: tReel.error, capturedAt: tReel.capturedAt })
          .from(tReel)
          .where(inArray(tReel.postId, postIds))
          .orderBy(tReel.postId, desc(tReel.capturedAt))
      : Promise.resolve([]),
    adIds.length
      ? db
          .select({ adId: tMetric.adId, plays: sql<string | null>`sum(${tMetric.videoPlays})`, thru: sql<string | null>`sum(${tMetric.thruplays})`, p100: sql<string | null>`sum(${tMetric.p100})` })
          .from(tMetric)
          .where(inArray(tMetric.adId, adIds))
          .groupBy(tMetric.adId)
      : Promise.resolve([]),
    adIds.length
      ? db
          .selectDistinctOn([tVerdict.adId], { adId: tVerdict.adId, day: tVerdict.day, verdict: tVerdict.verdict, action: tVerdict.action, actionResult: tVerdict.actionResult, reasons: tVerdict.reasons })
          .from(tVerdict)
          .where(inArray(tVerdict.adId, adIds))
          .orderBy(tVerdict.adId, desc(tVerdict.day))
      : Promise.resolve([]),
    variantMetrics(
      db,
      ads.filter((a) => a.fbAdId && a.activatedAt).map((a) => ({ id: a.id, fbAdId: a.fbAdId, startAt: a.activatedAt })),
    ),
  ]);

  const num = (x: string | null | undefined) => (x === null || x === undefined ? null : Number(x));
  const snapOf = new Map(snaps.map((s) => [s.postId, s]));
  const metaOf = new Map(metaRows.map((m) => [m.adId, m]));
  const verdictOf = new Map(verdicts.map((v) => [v.adId, v]));
  const varCostOf = new Map(varCost.map((c) => [c.variantId, num(c.usd)]));
  const runCostOf = new Map(runCost.map((c) => [c.runId, num(c.usd)]));

  const vRows = variants.map((v) => {
    const script = v.script as { hook?: unknown };
    const lessonRows = lessons.filter((l) => l.variantId === v.id);
    const row: ReportVariant = {
      id: v.id,
      runId: v.runId,
      seq: v.seq,
      angle: v.angle,
      hook: typeof script.hook === "string" ? script.hook : "",
      status: v.status,
      qcVerdict: v.qcVerdict,
      isTest: v.isTest,
      sourceId: v.sourceId,
      aiUsd: varCostOf.get(v.id) ?? null,
      createdAt: v.createdAt,
      posts: posts
        .filter((p) => p.variantId === v.id)
        .map((p) => ({ id: p.id, pageId: p.pageId, status: p.status, permalink: p.permalink, publishedAt: p.publishedAt, snapshot: snapOf.get(p.id) ?? null })),
      ads: ads
        .filter((a) => a.variantId === v.id)
        .map((a) => {
          const m = metaOf.get(a.id);
          const vd = verdictOf.get(a.id);
          return {
            id: a.id,
            adName: a.adName,
            status: a.status,
            dailyBudgetVnd: a.dailyBudgetVnd,
            activatedAt: a.activatedAt,
            fbAdId: a.fbAdId,
            erp: erp.get(a.id) ?? unknownMetrics(),
            meta: { videoPlays: num(m?.plays), thruplays: num(m?.thru), p100: num(m?.p100) },
            verdict: vd ? { day: vd.day, verdict: vd.verdict, action: vd.action, actionResult: vd.actionResult, reasons: vd.reasons } : null,
          };
        }),
      lesson: (lessonRows.find((l) => l.source === "AD") ?? lessonRows[0])?.summary ?? null,
    };
    return { productId: v.productId, row };
  });

  const nameOf = new Map(prods.map((p) => [p.id, p]));
  const codeOf = new Map(codes.map((c) => [c.productId, c.code]));
  const runsOf = new Map(runCount.map((r) => [r.productId, Number(r.n)]));
  return pIds.map((pid) => {
    const vs = vRows.filter((v) => v.productId === pid).map((v) => v.row);
    const runCosts = [...new Set(vs.map((v) => v.runId))].map((r) => runCostOf.get(r) ?? null);
    const parts = [...vs.map((v) => v.aiUsd), ...runCosts].filter((x): x is number => x !== null);
    return {
      productId: pid,
      name: nameOf.get(pid)?.name ?? pid,
      code: codeOf.get(pid) ?? nameOf.get(pid)?.customId ?? "",
      runs: runsOf.get(pid) ?? 0,
      aiUsd: parts.length ? parts.reduce((a, b) => a + b, 0) : null,
      variants: vs,
    };
  });
}

// ───────────────────────────── SO SÁNH MODEL SINH VIDEO ─────────────────────────────

export type ModelComparisonRow = {
  model: string;
  /** Biến thể đã đi hết sinh + hậu kỳ + QC (không tính dữ liệu thử). */
  videos: number;
  qcPass: number;
  qcFlag: number;
  qcFail: number;
  approved: number;
  rejected: number;
  /** Tiền AI ƯỚC TÍNH (clip + giọng đọc + QC + content) của các biến thể trên. `null` = chưa việc nào ghi tiền. */
  aiUsd: number | null;
  /** Tiền AI / video ĐƯỢC DUYỆT — con số để chọn model. `null` khi chưa video nào được duyệt (không chia cho 0). */
  usdPerApproved: number | null;
};

/**
 * Mỗi model một dòng, đọc model từ ẢNH CHỤP cấu hình của lượt (`video_scale_runs.config_snapshot`) — không phải cấu hình
 * hiện tại, vì đổi model hôm nay không được đổi lịch sử hôm qua. Chỉ biến thể đã QC xong mới được đếm.
 */
export async function modelComparison(db: Db): Promise<ModelComparisonRow[]> {
  const cost = db
    .select({ variantId: tJob.variantId, usd: sql<number | null>`sum(${tJob.costUsd})`.as("vs_cmp_usd") })
    .from(tJob)
    .where(sql`${tJob.variantId} is not null`)
    .groupBy(tJob.variantId)
    .as("vs_cmp_cost");
  const rows = await db
    .select({
      model: sql<string>`coalesce(${tRun.configSnapshot}->>'model', '')`,
      videos: sql<string>`count(*)`,
      qcPass: sql<string>`count(*) filter (where ${tVar.qcVerdict} = 'PASS')`,
      qcFlag: sql<string>`count(*) filter (where ${tVar.qcVerdict} = 'FLAG')`,
      qcFail: sql<string>`count(*) filter (where ${tVar.qcVerdict} = 'FAIL')`,
      approved: sql<string>`count(*) filter (where ${tVar.status} = 'APPROVED')`,
      rejected: sql<string>`count(*) filter (where ${tVar.status} = 'REJECTED')`,
      aiUsd: sql<string | null>`sum(${cost.usd})`,
    })
    .from(tVar)
    .innerJoin(tRun, eq(tRun.id, tVar.runId))
    .leftJoin(cost, eq(cost.variantId, tVar.id))
    .where(and(eq(tVar.isTest, false), isNotNull(tVar.qcVerdict)))
    .groupBy(sql`coalesce(${tRun.configSnapshot}->>'model', '')`);
  return rows
    .map((r) => {
      const approved = Number(r.approved);
      const aiUsd = r.aiUsd === null ? null : Number(r.aiUsd);
      return {
        model: r.model || "(không rõ)",
        videos: Number(r.videos),
        qcPass: Number(r.qcPass),
        qcFlag: Number(r.qcFlag),
        qcFail: Number(r.qcFail),
        approved,
        rejected: Number(r.rejected),
        aiUsd,
        usdPerApproved: aiUsd !== null && approved > 0 ? aiUsd / approved : null,
      };
    })
    .sort((a, b) => b.videos - a.videos);
}

// ───────────────────────────── TIẾN TRÌNH TỪNG LƯỢT ─────────────────────────────

export type ProgressJob = {
  id: string;
  kind: string;
  sceneIndex: number | null;
  status: string;
  error: string;
  errorKind: string;
  attempts: number;
  maxAttempts: number;
  provider: string;
  providerRef: string;
  outputAssetId: string | null;
  costUsd: number | null;
  reservedUsd: number | null;
  nextRunAt: Date;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProgressVariant = {
  id: string;
  seq: number;
  angle: string;
  hook: string;
  status: string;
  error: string;
  qcVerdict: string | null;
  finalAssetId: string | null;
  scenes: number;
  jobs: ProgressJob[];
};

export type ProgressRun = {
  id: string;
  productName: string;
  status: string;
  error: string;
  isTest: boolean;
  createdBy: string;
  createdAt: Date;
  provider: string;
  model: string;
  aiScenes: number | null;
  scenesPerVariant: number;
  costUsd: number | null;
  reservedUsd: number;
  scriptJob: ProgressJob | null;
  variants: ProgressVariant[];
};

/** Các lượt gần nhất, mỗi lượt kèm biến thể và TỪNG việc — màn hình tiến trình vẽ từ đây, không tự suy trạng thái. */
export async function listRunProgress(db: Db, limit = 6): Promise<ProgressRun[]> {
  const tProd = schema.products;
  const runs = await db
    .select({ id: tRun.id, productName: tProd.name, status: tRun.status, error: tRun.error, isTest: tRun.isTest, createdBy: tRun.createdBy, createdAt: tRun.createdAt, snap: tRun.configSnapshot })
    .from(tRun)
    .innerJoin(tProd, eq(tProd.id, tRun.productId))
    .orderBy(desc(tRun.createdAt))
    .limit(limit);
  if (!runs.length) return [];
  const ids = runs.map((r) => r.id);
  const [variants, jobs] = await Promise.all([
    db
      .select({ id: tVar.id, runId: tVar.runId, seq: tVar.seq, angle: tVar.angle, script: tVar.script, status: tVar.status, error: tVar.error, qcVerdict: tVar.qcVerdict, finalAssetId: tVar.finalAssetId })
      .from(tVar)
      .where(inArray(tVar.runId, ids))
      .orderBy(asc(tVar.seq)),
    db
      .select({
        id: tJob.id,
        runId: tJob.runId,
        variantId: tJob.variantId,
        kind: tJob.kind,
        sceneIndex: tJob.sceneIndex,
        status: tJob.status,
        error: tJob.error,
        errorKind: tJob.errorKind,
        attempts: tJob.attempts,
        maxAttempts: tJob.maxAttempts,
        provider: tJob.provider,
        providerRef: tJob.providerRef,
        outputAssetId: tJob.outputAssetId,
        costUsd: tJob.costUsd,
        reservedUsd: tJob.reservedUsd,
        nextRunAt: tJob.nextRunAt,
        lockedUntil: tJob.lockedUntil,
        createdAt: tJob.createdAt,
        updatedAt: tJob.updatedAt,
      })
      .from(tJob)
      .where(inArray(tJob.runId, ids))
      .orderBy(asc(tJob.createdAt)),
  ]);
  const strip = (j: (typeof jobs)[number]): ProgressJob => {
    const { runId, variantId, ...rest } = j;
    void runId;
    void variantId;
    return rest;
  };
  return runs.map((r) => {
    const snap = (r.snap ?? {}) as Record<string, unknown>;
    const runJobs = jobs.filter((j) => j.runId === r.id);
    const vs = variants.filter((v) => v.runId === r.id);
    const cost = runJobs.map((j) => j.costUsd).filter((x): x is number => x !== null);
    return {
      id: r.id,
      productName: r.productName,
      status: r.status,
      error: r.error,
      isTest: r.isTest,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      provider: typeof snap.provider === "string" ? snap.provider : "VEO",
      model: typeof snap.model === "string" ? snap.model : "",
      aiScenes: typeof snap.aiScenes === "number" ? snap.aiScenes : null,
      scenesPerVariant: typeof snap.scenesPerVariant === "number" ? snap.scenesPerVariant : 0,
      costUsd: cost.length ? cost.reduce((a, b) => a + b, 0) : null,
      // Tiền giữ chỗ của việc CHƯA chốt tiền (đang tạo / hỏng giữa chừng).
      reservedUsd: runJobs.filter((j) => j.costUsd === null).reduce((a, j) => a + (j.reservedUsd ?? 0), 0),
      scriptJob: (() => {
        const sj = runJobs.filter((j) => j.kind === "SCRIPT").pop();
        return sj ? strip(sj) : null;
      })(),
      variants: vs.map((v) => {
        const script = (v.script ?? {}) as { hook?: unknown; scenes?: unknown };
        return {
          id: v.id,
          seq: v.seq,
          angle: v.angle,
          hook: typeof script.hook === "string" ? script.hook : "",
          status: v.status,
          error: v.error,
          qcVerdict: v.qcVerdict,
          finalAssetId: v.finalAssetId,
          scenes: Array.isArray(script.scenes) ? script.scenes.length : 0,
          jobs: runJobs.filter((j) => j.variantId === v.id).map(strip),
        };
      }),
    };
  });
}

