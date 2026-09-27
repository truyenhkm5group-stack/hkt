import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { OPTIMIZER_MAX_SILENCE_MS, OPTIMIZER_STATE_KEY, VIDEO_ADS_HARD_LIMITS, gateVideoAd, videoAdNames, type VideoAdAction, type VideoAdGate, type VideoAdsMode, type VideoScaleConfig } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { IntegrationError } from "@/lib/integrations/http";
import {
  activateTestCampaign,
  adsWriteDisabledReason,
  createAd,
  createAdCreative,
  createTestAdset,
  createTestCampaign,
  facebookErrorText,
  readAdAccountCurrency,
  readAdsetBudget,
  readAdVideoStatus,
  readTemplateAd,
  setScaleDailyBudget,
  setScaleStatus,
  uploadAdImage,
  uploadAdVideoFromUrl,
  vndToFbMinor,
  type TemplateAd,
  type TemplateAdset,
  type TemplateCampaign,
} from "@/lib/integrations/facebook/ads-write";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { adsetForPage, buildVideoStorySpec, signedAssetUrl } from "@/lib/video-scale/ad-spec";
import type { HandlerCtx } from "@/lib/video-scale/handlers";
import { readVideoAutomation } from "@/lib/video-scale/publish";
import { beginAttempt, blockJob, enqueueJob, failOrRetryJob, settleJob, succeedJob, waitJob, type VideoJobRow } from "@/lib/video-scale/queue";
import { readAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ QUẢNG CÁO META CHO VIDEO ĐÃ ĐĂNG ═══════════
 *
 * Đặc tả: `docs/video-scale.md` §PR3. Lời ghi Facebook: `lib/integrations/facebook/ads-write.ts` (cửa ghi duy nhất, chốt env
 * + công tắc khẩn cấp đọc lại ở TỪNG lời gọi). Tệp này quyết ĐƯỢC hay không (cổng thuần `gateVideoAd`) và giữ cho một
 * video không bao giờ thành hai quảng cáo trên một tài khoản.
 *
 *  · Một dòng `video_scale_ads` / (video, tài khoản) — ràng buộc duy nhất. Mỗi quảng cáo một CHIẾN DỊCH riêng dựng TẮT
 *    (ABO, ngân sách NGÀY ở nhóm), bật ở bước CUỐI — hỏng giữa chừng thì không có gì tiêu tiền.
 *  · `pending_step` ghi TRƯỚC lời gọi tạo chiến dịch / nhóm / quảng cáo; gặp lại dấu ấy mà không có id ⇒ KHÔNG gửi lại
 *    (có thể đã tạo) — hỏng kèm TÊN để người tìm trên Ads Manager. Tải video / ảnh / dựng bài gửi lại được (không tiêu tiền).
 *  · `AUTO_LAUNCH`: bật khi dựng xong VÀ cổng cho qua (video đã duyệt, Reel đã đăng, fanpage chưa đổi, có luật tắt, trong ba
 *    trần). Cổng chặn ⇒ quảng cáo nằm TẮT kèm lý do; không bao giờ bật bù sau này mà không qua cổng lần nữa.
 *  · Mọi lượt tạo / bật / tắt / đổi ngân sách vào sổ `video_scale_ad_actions`, kể cả lượt bị CHẶN.
 */

const Ads = schema.videoScaleAds;
const Act = schema.videoScaleAdActions;
const V = schema.videoScaleVariants;
const Ps = schema.videoScalePosts;
const SK = schema.videoScaleSkus;
const PG = schema.videoScalePages;

/** Cửa Facebook tiêm được — kiểm thử chạy cả luồng trên bộ giả. */
export type AdsApi = {
  readTemplate: (adId: string) => Promise<TemplateAd>;
  currency: (accountId: string) => Promise<string>;
  uploadVideo: (accountId: string, input: { fileUrl: string; name: string }) => Promise<string>;
  videoStatus: (videoId: string) => Promise<{ status: string; error: string | null }>;
  uploadImage: (accountId: string, base64: string) => Promise<string>;
  createCreative: (accountId: string, input: { name: string; objectStorySpec: Record<string, unknown> }) => Promise<{ id: string }>;
  createCampaign: (accountId: string, input: { name: string; template: TemplateCampaign }) => Promise<string>;
  createAdset: (accountId: string, input: { name: string; campaignId: string; startTime: Date; template: TemplateAdset; dailyBudgetMinor: number }) => Promise<string>;
  createAd: (accountId: string, input: { name: string; adsetId: string; creativeId: string }) => Promise<string>;
  activate: (campaignId: string) => Promise<void>;
  pause: (campaignId: string) => Promise<void>;
  setBudget: (adsetId: string, dailyBudgetMinor: number) => Promise<void>;
  readAdset: (adsetId: string, currency: string) => Promise<{ dailyBudgetVnd: number | null; status: string; effectiveStatus: string }>;
};

export const FACEBOOK_ADS_API: AdsApi = {
  readTemplate: readTemplateAd,
  currency: readAdAccountCurrency,
  uploadVideo: uploadAdVideoFromUrl,
  videoStatus: readAdVideoStatus,
  uploadImage: uploadAdImage,
  createCreative: createAdCreative,
  createCampaign: createTestCampaign,
  createAdset: (a, i) => createTestAdset(a, { name: i.name, campaignId: i.campaignId, startTime: i.startTime, template: i.template, dailyBudgetMinor: i.dailyBudgetMinor }),
  createAd,
  activate: activateTestCampaign,
  pause: (id) => setScaleStatus(id, "PAUSED"),
  setBudget: setScaleDailyBudget,
  readAdset: readAdsetBudget,
};

export type AdsDeps = { ads: AdsApi; adsWriteClosed: () => string | null; signUrl: (assetId: string, now: Date) => string };

export const DEFAULT_ADS_DEPS: AdsDeps = {
  ads: FACEBOOK_ADS_API,
  adsWriteClosed: adsWriteDisabledReason,
  signUrl: (assetId, now) => signedAssetUrl(env.appUrl, env.authSecret, assetId, now),
};

type AdRow = typeof Ads.$inferSelect;

// ───────────────────────────── SỔ ─────────────────────────────

export async function logAdAction(db: Db, row: { adId: string | null; action: VideoAdAction; outcome: "APPLIED" | "DENIED" | "FAILED"; denial?: string; detail?: string; before?: number | null; after?: number | null; actor: Actor | null; request?: Record<string, unknown> }) {
  await db.insert(Act).values({
    adId: row.adId,
    action: row.action,
    outcome: row.outcome,
    denial: row.denial ?? "",
    detail: (row.detail ?? "").slice(0, 1000),
    budgetBeforeVnd: row.before ?? null,
    budgetAfterVnd: row.after ?? null,
    actorUserId: row.actor?.id ?? null,
    actor: row.actor?.label ?? "Máy — Video Scale",
    request: row.request ?? {},
  });
}

// ───────────────────────────── ĐỌC CHO CỔNG ─────────────────────────────

/** Mẩu quảng cáo mẫu: cấu hình Video Scale → mẩu mẫu của Thư viện Media. Rỗng ⇒ `null` (không đoán). */
export async function templateAdIdFor(db: Db, cfg: VideoScaleConfig): Promise<string | null> {
  if (cfg.adTemplateAdId) return cfg.adTemplateAdId;
  const { config } = await readCurrentCreativeConfig(db);
  return config.templateAdId || null;
}

/** Mốc lượt tối ưu gần nhất (`settings` khoá `videoScale.optimizer`). Không đọc được ⇒ `null` (coi như IM LẶNG). */
export async function optimizerHeartbeat(db: Db): Promise<Date | null> {
  try {
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, OPTIMIZER_STATE_KEY)).limit(1);
    const t = Number((JSON.parse(row?.value ?? "{}") as { lastRunAt?: unknown }).lastRunAt);
    return Number.isFinite(t) && t > 0 ? new Date(t) : null;
  } catch {
    return null;
  }
}

export async function killRuleCount(db: Db): Promise<number> {
  const { config } = await readCurrentCreativeConfig(db);
  return config.killRules.length;
}

/** Tổng ngân sách ngày của quảng cáo ĐANG CHẠY (không tính `exceptAdId`) — theo mã và toàn module. */
export async function activeBudgets(db: Db, productId: string, exceptAdId: string): Promise<{ sku: number; global: number }> {
  const [r] = await db
    .select({
      sku: sql<string>`coalesce(sum(${Ads.dailyBudgetVnd}) filter (where ${Ads.productId} = ${productId}), 0)`,
      global: sql<string>`coalesce(sum(${Ads.dailyBudgetVnd}), 0)`,
    })
    .from(Ads)
    .where(and(eq(Ads.status, "ACTIVE"), ne(Ads.id, exceptAdId)));
  return { sku: Number(r?.sku ?? 0), global: Number(r?.global ?? 0) };
}

export async function budgetChangesToday(db: Db, adId: string, now: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`count(*)` })
    .from(Act)
    .where(and(eq(Act.adId, adId), eq(Act.action, "SET_BUDGET"), eq(Act.outcome, "APPLIED"), sql`to_char(${Act.createdAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') = ${vnDay(now)}`));
  return Number(r?.n ?? 0);
}

/** Dựng đầu vào cổng cho một quảng cáo + một hành động — đọc CSDL, không gọi Facebook. */
export async function adGateFor(db: Db, ad: AdRow, action: VideoAdAction, budgetVnd: number | null, cfg: VideoScaleConfig, deps: Pick<AdsDeps, "adsWriteClosed">, extra: { currentBudgetVnd?: number | null; now: Date }): Promise<VideoAdGate> {
  const [v] = await db.select().from(V).where(eq(V.id, ad.variantId)).limit(1);
  const [post] = ad.postId ? await db.select().from(Ps).where(eq(Ps.id, ad.postId)).limit(1) : [];
  const [sku] = await db.select().from(SK).where(eq(SK.productId, ad.productId)).limit(1);
  const [page] = await db.select().from(PG).where(eq(PG.pageId, ad.pageId)).limit(1);
  const [auto, kill, active, changes, template, beat] = await Promise.all([
    readVideoAutomation(db),
    killRuleCount(db),
    activeBudgets(db, ad.productId, ad.id),
    budgetChangesToday(db, ad.id, extra.now),
    templateAdIdFor(db, cfg),
    optimizerHeartbeat(db),
  ]);
  return gateVideoAd({
    action,
    writeClosed: deps.adsWriteClosed(),
    automationPaused: auto.paused,
    skuPaused: Boolean(sku?.automationPausedAt),
    pagePaused: Boolean(page?.pausedAt),
    variant: { approved: v?.status === "APPROVED", isTest: Boolean(v?.isTest), qcFailed: v?.qcVerdict === "FAIL" },
    reelPublished: post?.status === "PUBLISHED",
    mappingOk: Boolean(sku?.pageId) && sku?.pageId === ad.pageId,
    adAccountId: sku?.adAccountId ?? null,
    templateAdId: ad.templateAdId || template,
    killRules: kill,
    optimizerSilent: beat === null || extra.now.getTime() - beat.getTime() > OPTIMIZER_MAX_SILENCE_MS,
    onFacebook: Boolean(ad.fbCampaignId),
    budgetVnd,
    currentBudgetVnd: extra.currentBudgetVnd ?? null,
    budgetChangesToday: changes,
    // Ngân sách ngày của mã là mức KHỞI ĐIỂM mỗi quảng cáo; trần MỖI quảng cáo khi tăng là trần cứng — tổng vẫn chịu trần mã.
    caps: { perAdVnd: sku?.dailyBudgetPerAdVnd ? VIDEO_ADS_HARD_LIMITS.maxDailyBudgetPerAdVnd : null, skuVnd: sku?.skuDailyCapVnd ?? null, globalVnd: cfg.adsGlobalDailyCapVnd },
    activeSkuVnd: active.sku,
    activeGlobalVnd: active.global,
  });
}

// ───────────────────────────── LẬP QUẢNG CÁO SAU KHI REEL LÊN ─────────────────────────────

/**
 * Reel đã đăng ⇒ lập quảng cáo theo chế độ của mã. `DRAFT` ⇒ chỉ dòng nháp. `PUBLISH_PAUSED` / `AUTO_LAUNCH` ⇒ xếp việc
 * dựng. Mã chưa có tài khoản / ngân sách ⇒ không lập (nói lý do), không đoán. Lũy đẳng theo (video, tài khoản).
 */
export async function planVideoAd(db: Db, variantId: string, cfg: VideoScaleConfig, actor: Actor | null): Promise<{ adId: string | null; note: string }> {
  const [v] = await db.select().from(V).where(eq(V.id, variantId)).limit(1);
  if (!v || v.isTest) return { adId: null, note: "video thử — không quảng cáo" };
  const [sku] = await db.select().from(SK).where(eq(SK.productId, v.productId)).limit(1);
  if (!sku?.adAccountId) return { adId: null, note: "mã chưa gán tài khoản quảng cáo" };
  if (!sku.dailyBudgetPerAdVnd) return { adId: null, note: "mã chưa khai ngân sách ngày mỗi quảng cáo" };
  const [post] = await db.select().from(Ps).where(and(eq(Ps.variantId, variantId), eq(Ps.status, "PUBLISHED"))).limit(1);
  if (!post) return { adId: null, note: "Reel chưa đăng" };
  const template = await templateAdIdFor(db, cfg);
  if (!template) return { adId: null, note: "chưa khai mẩu quảng cáo mẫu" };
  const [prod] = await db.select({ code: schema.products.customId, modelCode: schema.productModels.code }).from(schema.products).leftJoin(schema.productModels, eq(schema.productModels.productId, schema.products.id)).where(eq(schema.products.id, v.productId)).limit(1);
  const [fp] = await db.select({ name: schema.fanpages.name, alias: schema.fanpages.alias }).from(schema.fanpages).where(eq(schema.fanpages.externalPageId, post.pageId)).limit(1);
  const names = videoAdNames({ code: prod?.modelCode || prod?.code || "MA", day: vnDay(new Date()), pageLabel: fp?.alias || fp?.name || post.pageId, seq: v.seq, angle: v.angle });
  const mode = sku.adsMode as VideoAdsMode;
  const [row] = await db
    .insert(Ads)
    .values({
      variantId,
      productId: v.productId,
      postId: post.id,
      pageId: post.pageId,
      adAccountId: sku.adAccountId,
      mode,
      status: mode === "DRAFT" ? "DRAFT" : "QUEUED",
      dailyBudgetVnd: sku.dailyBudgetPerAdVnd,
      campaignName: names.campaign,
      adsetName: names.adset,
      adName: names.ad,
      message: post.caption,
      templateAdId: template,
      authorizedByUserId: actor?.id ?? null,
      authorizedBy: actor?.label ?? (mode === "AUTO_LAUNCH" ? `Máy — tự bật (bật bởi ${sku.adsModeBy})` : "Máy — theo chế độ của mã"),
    })
    .onConflictDoNothing()
    .returning({ id: Ads.id });
  if (!row) return { adId: null, note: "video đã có quảng cáo trên tài khoản này" };
  if (mode !== "DRAFT") await enqueueJob(db, { kind: "CREATE_AD", key: `ad:${row.id}:1`, runId: v.runId, variantId, adId: row.id, isTest: false, request: { activate: mode === "AUTO_LAUNCH" } });
  return { adId: row.id, note: mode === "DRAFT" ? "đã lập nháp" : "đã xếp dựng quảng cáo" };
}

/** Người bấm "Dựng trên Facebook" (tắt) hoặc "Dựng và bật" cho một quảng cáo nháp / hỏng. */
export async function queueCreateAd(db: Db, adId: string, activate: boolean, actor: Actor): Promise<{ ok: true } | { ok: false; error: string }> {
  const [ad] = await db.select().from(Ads).where(eq(Ads.id, adId)).limit(1);
  if (!ad || !["DRAFT", "FAILED"].includes(ad.status)) return { ok: false, error: "Chỉ dựng được quảng cáo NHÁP hoặc HỎNG." };
  if (ad.status === "FAILED" && ad.pendingStep && ["CAMPAIGN", "ADSET", "AD"].includes(ad.pendingStep)) {
    return { ok: false, error: `Lượt dựng trước dừng giữa bước ${ad.pendingStep} mà không rõ Facebook đã tạo chưa — tìm "${ad.campaignName}" trên Ads Manager, xoá nếu có, rồi mới dựng lại.` };
  }
  const [v] = await db.select({ runId: V.runId }).from(V).where(eq(V.id, ad.variantId)).limit(1);
  const [{ n }] = await db.select({ n: sql<string>`count(*)` }).from(schema.videoScaleJobs).where(eq(schema.videoScaleJobs.adId, adId));
  await db.update(Ads).set({ status: "QUEUED", error: "", pendingStep: "", pendingAt: null, authorizedByUserId: actor.id, authorizedBy: actor.label }).where(eq(Ads.id, adId));
  await enqueueJob(db, { kind: "CREATE_AD", key: `ad:${adId}:${Number(n) + 1}`, runId: v?.runId ?? null, variantId: ad.variantId, adId, isTest: false, createdByUserId: actor.id, request: { activate } });
  return { ok: true };
}

// ───────────────────────────── VIỆC: DỰNG QUẢNG CÁO ─────────────────────────────

function kindOf(e: unknown): "BLOCKED" | "TRANSIENT" | "PERMANENT" {
  if (e instanceof IntegrationError) {
    if (e.status === 403 && /đường ghi quảng cáo đang đóng/.test(e.message)) return "BLOCKED";
    if (e.retryable || e.status >= 500 || e.status === 429) return "TRANSIENT";
    return "PERMANENT";
  }
  return "TRANSIENT";
}

export async function handleCreateAd(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now, cfgNow } = ctx;
  const deps = ctx.deps.adsDeps;
  const api = deps.ads;
  const [ad] = job.adId ? await db.select().from(Ads).where(eq(Ads.id, job.adId)).limit(1) : [];
  if (!ad || ad.status === "STOPPED") return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  if (ad.status === "ACTIVE" || (ad.status === "PAUSED" && !(job.request as { activate?: boolean }).activate)) return void (await succeedJob(db, job, now, { result: { note: "đã dựng từ lượt trước" } }));
  const setAd = (patch: Partial<typeof Ads.$inferInsert>) => db.update(Ads).set(patch).where(eq(Ads.id, ad.id));
  const failAd = async (msg: string, kind: "PERMANENT" | "TRANSIENT", keepPending = false) => {
    if ((await failOrRetryJob(db, job, now, msg, kind)) === "FAILED") {
      await setAd({ status: "FAILED", error: msg.slice(0, 1000), ...(keepPending ? {} : { pendingStep: "", pendingAt: null }) });
      await logAdAction(db, { adId: ad.id, action: "CREATE", outcome: "FAILED", detail: msg, actor: null });
    }
  };

  if (!ad.fbAdId) {
    const gate = await adGateFor(db, ad, "CREATE", ad.dailyBudgetVnd, cfgNow, deps, { now });
    if (!gate.allow) {
      await logAdAction(db, { adId: ad.id, action: "CREATE", outcome: "DENIED", denial: gate.denial, detail: gate.reason, actor: null });
      const temporary = ["WRITE_CLOSED", "AUTOMATION_PAUSED", "SKU_PAUSED", "PAGE_PAUSED"].includes(gate.denial);
      if (temporary) return void (await blockJob(db, job, gate.reason, new Date(now.getTime() + 15 * 60_000)));
      await setAd({ status: "FAILED", error: gate.reason });
      return void (await failOrRetryJob(db, job, now, gate.reason, "PERMANENT"));
    }
    if (["CAMPAIGN", "ADSET", "AD"].includes(ad.pendingStep)) {
      return void (await failAd(`Lượt trước dừng giữa bước ${ad.pendingStep} mà không lưu được id — có thể Facebook đã tạo "${ad.campaignName}" (đang TẮT). Máy không gửi lại; tìm trên Ads Manager.`, "PERMANENT", true));
    }
  }
  if (!(await beginAttempt(db, job))) return;
  await setAd({ status: ad.fbAdId ? ad.status : "CREATING", error: "" });
  try {
    const template = await api.readTemplate(ad.templateAdId);
    if (!template.campaign) throw new IntegrationError("Không đọc được chiến dịch chứa mẩu mẫu — máy không tự chọn mục tiêu.", 400);
    const currency = await api.currency(ad.adAccountId);
    // 1) Video lên thư viện tài khoản (link ký tên) — gửi lại vô hại.
    let videoId = ad.fbVideoId;
    if (!videoId) {
      const [v] = await db.select({ finalAssetId: V.finalAssetId }).from(V).where(eq(V.id, ad.variantId)).limit(1);
      if (!v?.finalAssetId) throw new IntegrationError("Video không còn bản hoàn chỉnh.", 400);
      videoId = await api.uploadVideo(ad.adAccountId, { fileUrl: deps.signUrl(v.finalAssetId, now), name: ad.adName });
      await setAd({ fbVideoId: videoId });
    }
    const vs = await api.videoStatus(videoId);
    if (vs.error) throw new IntegrationError(`Facebook không xử lý được video: ${vs.error}`, 400);
    if (vs.status !== "ready") return void (await waitJob(db, job, new Date(now.getTime() + 30_000), { attempts: Math.max(0, job.attempts - 1) }));
    // 2) Ảnh bìa — gửi lại vô hại.
    let imageHash = ad.fbImageHash;
    if (!imageHash) {
      const [v] = await db.select({ thumb: V.thumbnailAssetId }).from(V).where(eq(V.id, ad.variantId)).limit(1);
      const t = v?.thumb ? await readAsset(db, v.thumb) : null;
      if (!t) throw new IntegrationError("Video không có ảnh bìa.", 400);
      imageHash = await api.uploadImage(ad.adAccountId, t.bytes.toString("base64"));
      await setAd({ fbImageHash: imageHash });
    }
    // 3) Bài quảng cáo — chép nút kêu gọi từ mẩu mẫu, fanpage của mã. Dựng lại vô hại (bài không tiêu tiền).
    let creativeId = ad.fbCreativeId;
    if (!creativeId) {
      const spec = buildVideoStorySpec(template, { pageId: ad.pageId, videoId, imageHash, message: ad.message, title: ad.message.split("\n")[0] ?? "" });
      if (!spec.ok) throw new IntegrationError(spec.error, 400);
      creativeId = (await api.createCreative(ad.adAccountId, { name: ad.adName, objectStorySpec: spec.spec })).id;
      await setAd({ fbCreativeId: creativeId });
    }
    // 4) Chiến dịch (TẮT) → nhóm (ngân sách NGÀY) → quảng cáo. Dấu "đang gửi" trước từng bước.
    let campaignId = ad.fbCampaignId;
    if (!campaignId) {
      await setAd({ pendingStep: "CAMPAIGN", pendingAt: now });
      campaignId = await api.createCampaign(ad.adAccountId, { name: ad.campaignName, template: template.campaign });
      await setAd({ fbCampaignId: campaignId, pendingStep: "", pendingAt: null });
    }
    let adsetId = ad.fbAdsetId;
    if (!adsetId) {
      await setAd({ pendingStep: "ADSET", pendingAt: now });
      adsetId = await api.createAdset(ad.adAccountId, { name: ad.adsetName, campaignId, startTime: now, template: adsetForPage(template.adset, ad.pageId), dailyBudgetMinor: vndToFbMinor(ad.dailyBudgetVnd, currency) });
      await setAd({ fbAdsetId: adsetId, pendingStep: "", pendingAt: null });
    }
    let fbAdId = ad.fbAdId;
    if (!fbAdId) {
      await setAd({ pendingStep: "AD", pendingAt: now });
      fbAdId = await api.createAd(ad.adAccountId, { name: ad.adName, adsetId, creativeId });
      await setAd({ fbAdId, status: "PAUSED", pendingStep: "", pendingAt: null });
      await logAdAction(db, { adId: ad.id, action: "CREATE", outcome: "APPLIED", after: ad.dailyBudgetVnd, detail: `chiến dịch ${campaignId} (TẮT) · nhóm ${adsetId} · quảng cáo ${fbAdId}`, actor: null, request: { currency, templateAdId: ad.templateAdId } });
    }
    // 5) Bật — chỉ khi được yêu cầu (AUTO_LAUNCH / người bấm "Dựng và bật") VÀ cổng cho qua lúc này.
    if ((job.request as { activate?: boolean }).activate) {
      const [fresh] = await db.select().from(Ads).where(eq(Ads.id, ad.id)).limit(1);
      const gate = await adGateFor(db, fresh, "ACTIVATE", fresh.dailyBudgetVnd, cfgNow, deps, { now });
      if (!gate.allow) {
        await logAdAction(db, { adId: ad.id, action: "ACTIVATE", outcome: "DENIED", denial: gate.denial, detail: gate.reason, actor: null });
        await setAd({ error: `Đã dựng, chưa bật: ${gate.reason}` });
      } else {
        await api.activate(campaignId);
        await setAd({ status: "ACTIVE", activatedAt: now, activatedBy: fresh.authorizedBy || "Máy — AUTO_LAUNCH" });
        await logAdAction(db, { adId: ad.id, action: "ACTIVATE", outcome: "APPLIED", after: fresh.dailyBudgetVnd, actor: fresh.authorizedByUserId ? { id: fresh.authorizedByUserId, label: fresh.authorizedBy } : null });
      }
    }
    await succeedJob(db, job, now, { result: { campaignId, adsetId, fbAdId } });
  } catch (e) {
    const kind = kindOf(e);
    const msg = facebookErrorText(e);
    if (kind === "BLOCKED") return void (await blockJob(db, job, msg, new Date(now.getTime() + 15 * 60_000)));
    // Lời gọi tạo có phản hồi LỖI ⇒ chắc chưa tạo ⇒ xoá dấu; lỗi mạng (TRANSIENT) giữ dấu ⇒ lượt sau không gửi lại mù.
    if (kind === "PERMANENT") await setAd({ pendingStep: "", pendingAt: null });
    await failAd(msg, kind, kind === "TRANSIENT");
  }
}

// ───────────────────────────── THAO TÁC: BẬT · TẮT · ĐỔI NGÂN SÁCH ─────────────────────────────

type Result = { ok: true; detail: string } | { ok: false; error: string };

export async function activateVideoAd(db: Db, adId: string, actor: Actor, cfg: VideoScaleConfig, deps: AdsDeps = DEFAULT_ADS_DEPS, now = new Date()): Promise<Result> {
  const [ad] = await db.select().from(Ads).where(eq(Ads.id, adId)).limit(1);
  if (!ad || ad.status !== "PAUSED") return { ok: false, error: "Chỉ bật được quảng cáo ĐÃ DỰNG đang TẮT." };
  const gate = await adGateFor(db, ad, "ACTIVATE", ad.dailyBudgetVnd, cfg, deps, { now });
  if (!gate.allow) {
    await logAdAction(db, { adId, action: "ACTIVATE", outcome: "DENIED", denial: gate.denial, detail: gate.reason, actor });
    return { ok: false, error: gate.reason };
  }
  try {
    await deps.ads.activate(ad.fbCampaignId);
  } catch (e) {
    await logAdAction(db, { adId, action: "ACTIVATE", outcome: "FAILED", detail: facebookErrorText(e), actor });
    return { ok: false, error: facebookErrorText(e) };
  }
  await db.update(Ads).set({ status: "ACTIVE", activatedAt: now, activatedBy: actor.label, error: "" }).where(eq(Ads.id, adId));
  await logAdAction(db, { adId, action: "ACTIVATE", outcome: "APPLIED", after: ad.dailyBudgetVnd, actor });
  return { ok: true, detail: "Đã bật quảng cáo." };
}

/** Tắt một quảng cáo (tắt CHIẾN DỊCH riêng của nó). Luôn được — tắt chỉ làm GIẢM tiền. `actor = null` = máy (dừng khẩn cấp / luật tắt). */
export async function pauseVideoAd(db: Db, adId: string, actor: Actor | null, reason: string, deps: AdsDeps = DEFAULT_ADS_DEPS, now = new Date()): Promise<Result> {
  const [ad] = await db.select().from(Ads).where(eq(Ads.id, adId)).limit(1);
  if (!ad || !ad.fbCampaignId) return { ok: false, error: "Quảng cáo chưa lên Facebook." };
  if (ad.status !== "ACTIVE") return { ok: true, detail: "Quảng cáo đã tắt." };
  try {
    await deps.ads.pause(ad.fbCampaignId);
  } catch (e) {
    await logAdAction(db, { adId, action: "PAUSE", outcome: "FAILED", detail: facebookErrorText(e), actor });
    return { ok: false, error: facebookErrorText(e) };
  }
  await db.update(Ads).set({ status: "PAUSED", stoppedAt: now, stopReason: reason.slice(0, 300) }).where(eq(Ads.id, adId));
  await logAdAction(db, { adId, action: "PAUSE", outcome: "APPLIED", detail: reason, before: ad.dailyBudgetVnd, actor });
  return { ok: true, detail: "Đã tắt quảng cáo." };
}

/** Đổi ngân sách NGÀY của một quảng cáo đã dựng. Đọc ngân sách hiện tại TỪ FACEBOOK (ai sửa trên Ads Manager thì cổng thấy). */
export async function setVideoAdBudget(db: Db, adId: string, nextVnd: number, actor: Actor | null, cfg: VideoScaleConfig, deps: AdsDeps = DEFAULT_ADS_DEPS, now = new Date()): Promise<Result> {
  const [ad] = await db.select().from(Ads).where(eq(Ads.id, adId)).limit(1);
  if (!ad || !ad.fbAdsetId) return { ok: false, error: "Quảng cáo chưa lên Facebook." };
  let currency: string;
  let current: number | null;
  try {
    currency = await deps.ads.currency(ad.adAccountId);
    current = (await deps.ads.readAdset(ad.fbAdsetId, currency)).dailyBudgetVnd;
  } catch (e) {
    return { ok: false, error: `Không đọc được ngân sách hiện tại: ${facebookErrorText(e)}` };
  }
  const gate = await adGateFor(db, ad, "SET_BUDGET", nextVnd, cfg, deps, { currentBudgetVnd: current, now });
  if (!gate.allow) {
    await logAdAction(db, { adId, action: "SET_BUDGET", outcome: "DENIED", denial: gate.denial, detail: gate.reason, before: current, after: nextVnd, actor });
    return { ok: false, error: gate.reason };
  }
  try {
    await deps.ads.setBudget(ad.fbAdsetId, vndToFbMinor(nextVnd, currency));
  } catch (e) {
    await logAdAction(db, { adId, action: "SET_BUDGET", outcome: "FAILED", detail: facebookErrorText(e), before: current, after: nextVnd, actor });
    return { ok: false, error: facebookErrorText(e) };
  }
  await db.update(Ads).set({ dailyBudgetVnd: nextVnd }).where(eq(Ads.id, adId));
  await logAdAction(db, { adId, action: "SET_BUDGET", outcome: "APPLIED", before: current, after: nextVnd, actor });
  return { ok: true, detail: "Đã đổi ngân sách ngày." };
}

// ───────────────────────────── DỪNG KHẨN CẤP THEO PHẠM VI ─────────────────────────────

/** Xếp việc TẮT mọi quảng cáo ĐANG CHẠY trong phạm vi (mã / fanpage / toàn module). Việc tắt đi qua được công tắc khẩn cấp. */
export async function queuePauseAds(db: Db, scope: { productId?: string; pageId?: string }, reason: string, now = new Date()): Promise<number> {
  const rows = await db
    .select({ id: Ads.id, variantId: Ads.variantId })
    .from(Ads)
    .where(and(eq(Ads.status, "ACTIVE"), scope.productId ? eq(Ads.productId, scope.productId) : undefined, scope.pageId ? eq(Ads.pageId, scope.pageId) : undefined));
  for (const r of rows) await enqueueJob(db, { kind: "PAUSE_AD", key: `pause:${r.id}:${now.getTime()}`, runId: null, variantId: r.variantId, adId: r.id, isTest: false, request: { reason } });
  return rows.length;
}

export async function handlePauseAd(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now } = ctx;
  if (!job.adId) return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  if (!(await beginAttempt(db, job))) return;
  const r = await pauseVideoAd(db, job.adId, null, String((job.request as { reason?: unknown }).reason ?? "Dừng khẩn cấp"), ctx.deps.adsDeps, now);
  if (r.ok) return void (await succeedJob(db, job, now, { result: { detail: r.detail } }));
  await failOrRetryJob(db, job, now, r.error, "TRANSIENT");
}

export async function adsOfVariants(db: Db, variantIds: string[]): Promise<AdRow[]> {
  if (!variantIds.length) return [];
  return db.select().from(Ads).where(inArray(Ads.variantId, variantIds));
}
