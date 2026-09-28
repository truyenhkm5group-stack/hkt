import { and, asc, eq, inArray, isNotNull, max, min, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import {
  VIDEO_ANGLE_VOCAB_VERSION,
  VIDEO_PROMPT_VERSION,
  VIDEO_SCALE_CONFIG_KEY,
  VIDEO_SCALE_HARD_LIMITS,
  clipCostUsd,
  fakeProviderAllowed,
  normalizeVideoScaleConfig,
  type VideoJobKind,
  type VideoProviderId,
  type VideoScaleConfig,
} from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { organizationStateKey } from "@/lib/platform/process-state";
import { CAMPAIGN_WIN_STATES } from "@/lib/constants/campaign-setup";
import { ffmpegVersion, resolveFontFile } from "@/lib/video-scale/ffmpeg";
import { enqueueCaptionJob, enqueueVariantProduction, handleClip, handleQc, handleRender, handleScript, handleTts, scriptOf, type HandlerCtx } from "@/lib/video-scale/handlers";
import { writeCaptions } from "@/lib/video-scale/caption";
import { FACEBOOK_REEL_API, handleCaption, handlePublishReel, type ReelApi } from "@/lib/video-scale/publish";
import { DEFAULT_ADS_DEPS, handleCreateAd, handlePauseAd, planVideoAd, type AdsDeps } from "@/lib/video-scale/ads";
import { angleStatsFor, lessonsFor } from "@/lib/video-scale/optimize";
import type { AngleStat } from "@/lib/video-scale/plan";
import { videoProviderFor } from "@/lib/video-scale/providers";
import type { VideoProvider } from "@/lib/video-scale/providers/types";
import { visualQc } from "@/lib/video-scale/qc";
import { claimDueJobs, enqueueJob, failOrRetryJob, resetJob, cancelJobs, type VideoJobRow } from "@/lib/video-scale/queue";
import { VEO_NEGATIVE_PROMPT, veoPrompt, writeScripts } from "@/lib/video-scale/script";
import { purgeAsset } from "@/lib/video-scale/storage";
import { synthesizeSpeech } from "@/lib/video-scale/tts";

/**
 * ═══════════ VIDEO SCALE — ĐIỀU PHỐI ═══════════
 *
 * Đặc tả: `docs/video-scale.md`. Mỗi bước tốn tiền / tốn máy là MỘT việc trong hàng đợi (`queue.ts`); tệp này chỉ:
 *  · tạo lượt (kiểm mã win, ảnh gốc, cấu hình) và xếp việc viết kịch bản;
 *  · chạy một lượt vòng: cầm việc đến hạn → hàm xử lý theo loại → đẩy biến thể / lượt sang bước kế;
 *  · các thao tác của NGƯỜI (duyệt, loại, làm lại, thử lại, huỷ).
 *
 * Mọi phụ thuộc bên ngoài (nhà cung cấp video, người viết kịch bản, giọng đọc, QC hình ảnh, ffmpeg) TIÊM được qua
 * `VideoScaleDeps` — kiểm thử chạy cả luồng trên bộ giả mà không gọi mạng.
 */

const R = schema.videoScaleRuns;
const V = schema.videoScaleVariants;
const J = schema.videoScaleJobs;
const A = schema.videoScaleAssets;

export type VideoScaleDeps = {
  provider?: (id: VideoProviderId) => VideoProvider;
  scriptWriter?: typeof writeScripts;
  tts?: typeof synthesizeSpeech;
  visual?: typeof visualQc;
  ffmpegVersion?: () => Promise<string | null>;
  /** Tệp phông có dấu tiếng Việt; `null` ⇒ hậu kỳ BỊ CHẶN (không ra video chữ vỡ dấu). */
  fontFile?: () => Promise<string | null>;
  veoPrompt?: (scenePrompt: string) => string;
  negativePrompt?: string;
  /** Sổ học theo góc + bài học (`optimize.ts`, từ phán quyết quảng cáo và lý do người loại video). */
  angleStats?: (db: Db, productId: string) => Promise<AngleStat[]>;
  lessons?: (db: Db, productId: string) => Promise<string[]>;
  captionWriter?: typeof writeCaptions;
  reel?: ReelApi;
  adsDeps?: AdsDeps;
  /** Reel vừa đăng xong ⇒ lập quảng cáo theo chế độ của mã (PR 3). Tiêm được để kiểm thử PR 2 không phụ thuộc quảng cáo. */
  onReelPublished?: (db: Db, variantId: string, cfg: VideoScaleConfig) => Promise<void>;
};

export function resolveDeps(d: VideoScaleDeps = {}): Required<VideoScaleDeps> {
  return {
    provider: d.provider ?? videoProviderFor,
    scriptWriter: d.scriptWriter ?? writeScripts,
    tts: d.tts ?? synthesizeSpeech,
    visual: d.visual ?? visualQc,
    ffmpegVersion: d.ffmpegVersion ?? ffmpegVersion,
    fontFile: d.fontFile ?? (() => resolveFontFile()),
    veoPrompt: d.veoPrompt ?? veoPrompt,
    negativePrompt: d.negativePrompt ?? VEO_NEGATIVE_PROMPT,
    angleStats: d.angleStats ?? angleStatsFor,
    lessons: d.lessons ?? lessonsFor,
    captionWriter: d.captionWriter ?? writeCaptions,
    reel: d.reel ?? FACEBOOK_REEL_API,
    adsDeps: d.adsDeps ?? DEFAULT_ADS_DEPS,
    onReelPublished: d.onReelPublished ?? (async (db, variantId, cfg) => void (await planVideoAd(db, variantId, cfg, null))),
  };
}

export async function readVideoScaleConfig(db: Db): Promise<VideoScaleConfig> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY)).limit(1);
  let raw: unknown = {};
  try {
    raw = row ? JSON.parse(row.value) : {};
  } catch {
    raw = {};
  }
  return normalizeVideoScaleConfig(raw);
}

/**
 * Những thứ còn THIẾU để sinh được video thật — màn hình in nguyên danh sách, không một câu "chưa sẵn sàng" chung chung.
 */
export async function videoScaleBlockers(cfg: VideoScaleConfig, ff: string | null): Promise<string[]> {
  const out: string[] = [];
  if (!cfg.enabled) out.push("Video Scale đang TẮT (tab Cấu hình → Bật).");
  if (cfg.provider !== "FAKE" && !env.gemini.apiKey) out.push("Máy chủ ERP chưa có GEMINI_API_KEY (GitHub Secret GEMINI_API_KEY → chạy lại deploy) — Veo và Omni dùng chung khoá này.");
  if (cfg.provider === "FAKE" && !fakeProviderAllowed(process.env.NODE_ENV, env.videoScale.fakeProviderFlag)) out.push("Bộ sinh GIẢ chỉ dùng ngoài production (VIDEO_PROVIDER_FAKE=1).");
  if (cfg.provider !== "FAKE" && cfg.dailyUsdCap === null) out.push("Chưa khai trần chi sinh video / ngày (USD).");
  if (cfg.provider !== "FAKE" && clipCostUsd(cfg.model, cfg.resolution, 1) === null) out.push(`Model ${cfg.model} ở ${cfg.resolution} chưa có trong bảng giá — không áp được trần tiền nên không sinh.`);
  if (!env.openaiRest.apiKey) out.push("Máy chủ ERP chưa có OPENAI_API_KEY (viết kịch bản + QC hình ảnh).");
  if (!ff) out.push("Máy chủ ERP chưa có ffmpeg (hậu kỳ).");
  return out;
}

// ───────────────────────────── TẠO LƯỢT ─────────────────────────────

/**
 * "Mã win" = mẫu người đã KHAI từ "Thắng test" trở đi (`CAMPAIGN_WIN_STATES`, cùng danh sách "Đăng camp" dùng). Đọc thẳng
 * vòng đời, KHÔNG qua `productWinCodes` — hàm ấy còn đòi mã đọc được trong tên chiến dịch, một điều kiện của việc đặt tên
 * camp chứ không phải của việc làm video.
 */
export async function isDeclaredWin(db: Db, productId: string): Promise<boolean> {
  const M = schema.productModels;
  const [m] = await db.select({ state: M.lifecycleState }).from(M).where(and(eq(M.productId, productId), inArray(M.lifecycleState, [...CAMPAIGN_WIN_STATES]))).limit(1);
  return Boolean(m);
}

export type CreateRunInput = { productId: string; sourceIds: string[]; variants: number; angles: string[]; brief: string; musicId: string | null };

export async function createVideoRun(db: Db, input: CreateRunInput, actor: Actor): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const cfg = await readVideoScaleConfig(db);
  if (!cfg.enabled) return { ok: false, error: "Video Scale đang TẮT — bật ở tab Cấu hình trước." };
  if (cfg.provider === "FAKE" && !fakeProviderAllowed(process.env.NODE_ENV, env.videoScale.fakeProviderFlag)) return { ok: false, error: "Bộ sinh GIẢ không dùng được trên máy chủ này." };
  if (!(await isDeclaredWin(db, input.productId))) return { ok: false, error: "Mã này chưa được KHAI \"Thắng test\" ở trang Mẫu — Video Scale chỉ chạy cho mã win." };
  const ids = [...new Set(input.sourceIds.filter(Boolean))];
  if (!ids.length) return { ok: false, error: "Chọn ít nhất một ảnh sản phẩm làm ảnh gốc." };
  const S = schema.creativeSources;
  const src = await db.select({ id: S.id, kind: S.kind, productId: S.productId, active: S.active, imageId: S.imageId }).from(S).where(inArray(S.id, ids));
  const bad = ids.filter((id) => {
    const s = src.find((x) => x.id === id);
    return !s || s.kind !== "PRODUCT_PHOTO" || s.productId !== input.productId || !s.active || !s.imageId;
  });
  if (bad.length) return { ok: false, error: "Ảnh gốc phải là ẢNH SẢN PHẨM THẬT đang bật của đúng mã này (Nguồn ảnh → Ảnh sản phẩm)." };
  if (input.musicId) {
    const [m] = await db.select({ id: schema.videoScaleMusic.id }).from(schema.videoScaleMusic).where(and(eq(schema.videoScaleMusic.id, input.musicId), eq(schema.videoScaleMusic.active, true))).limit(1);
    if (!m) return { ok: false, error: "Bản nhạc đã chọn không còn trong thư viện nhạc có quyền." };
  }
  const variants = Math.max(1, Math.min(VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun, Math.floor(input.variants)));
  const isTest = cfg.provider === "FAKE";
  const runId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(schema.videoScaleSkus).values({ productId: input.productId, updatedByUserId: actor.id, updatedBy: actor.label }).onConflictDoNothing();
    await tx.insert(R).values({
      id: runId,
      productId: input.productId,
      sourceIds: ids,
      status: "SCRIPTING",
      promptVersion: VIDEO_PROMPT_VERSION,
      angleVocabVersion: VIDEO_ANGLE_VOCAB_VERSION,
      variantsRequested: variants,
      anglesRequested: input.angles.slice(0, variants),
      configSnapshot: cfg as unknown as Record<string, unknown>,
      musicId: input.musicId,
      brief: input.brief.trim().slice(0, 600),
      isTest,
      createdByUserId: actor.id,
      createdBy: actor.label,
    });
    await enqueueJob(tx as unknown as Db, { kind: "SCRIPT", key: `script:${runId}`, runId, variantId: null, isTest, createdByUserId: actor.id });
  });
  return { ok: true, runId };
}

// ───────────────────────────── MỘT LƯỢT VÒNG ─────────────────────────────

const HANDLERS: Record<VideoJobKind, (ctx: HandlerCtx, job: VideoJobRow) => Promise<void>> = {
  SCRIPT: handleScript,
  CLIP: handleClip,
  TTS: handleTts,
  RENDER: handleRender,
  QC: handleQc,
  CAPTION: handleCaption,
  PUBLISH_REEL: handlePublishReel,
  CREATE_AD: handleCreateAd,
  PAUSE_AD: handlePauseAd,
};

export type TickResult = { handled: number; byKind: Record<string, number>; errors: string[]; purged: number };

/** Xử lý việc đến hạn cho tới khi hết việc hoặc hết `budgetMs`. Lũy đẳng, chạy song song an toàn (cầm việc có điều kiện). */
export async function runVideoScaleTick(db: Db, opts: { budgetMs?: number; deps?: VideoScaleDeps; now?: () => Date } = {}): Promise<TickResult> {
  const deps = resolveDeps(opts.deps);
  const clock = opts.now ?? (() => new Date());
  const started = Date.now();
  const budget = opts.budgetMs ?? 4 * 60_000;
  const out: TickResult = { handled: 0, byKind: {}, errors: [], purged: 0 };
  while (Date.now() - started < budget) {
    const now = clock();
    const jobs = await claimDueJobs(db, now, { limit: 4 });
    if (!jobs.length) break;
    const cfgNow = await readVideoScaleConfig(db);
    for (const job of jobs) {
      const ctx: HandlerCtx = { db, now: clock(), cfgNow, deps };
      try {
        await HANDLERS[job.kind as VideoJobKind](ctx, job);
      } catch (e) {
        const msg = `Lỗi bất ngờ ở việc ${job.kind}: ${e instanceof Error ? e.message : String(e)}`;
        out.errors.push(msg);
        await failOrRetryJob(db, job, clock(), msg, "TRANSIENT").catch(() => undefined);
      }
      out.handled += 1;
      out.byKind[job.kind] = (out.byKind[job.kind] ?? 0) + 1;
      if (job.variantId) await advanceVariant(db, job.variantId);
      else if (job.runId) await refreshRunStatus(db, job.runId);
    }
  }
  out.purged = await purgeExpiredAssets(db, clock());
  return out;
}

/** Mốc đến hạn sớm nhất của việc còn sống (không tính `BLOCKED`) — để lượt `after()` biết nên chờ tới khi nào. */
export async function nextDueAt(db: Db): Promise<Date | null> {
  const [r] = await db.select({ at: min(J.nextRunAt) }).from(J).where(inArray(J.status, ["QUEUED", "WAITING", "RUNNING"]));
  return r?.at ?? null;
}

/** Tổ chức đang có vòng `after()` chạy hàng đợi trong tiến trình này — khoá theo MÃ TỔ CHỨC (một tổ chức không chặn tổ chức khác). */
const drainLock = globalThis as unknown as { __erpVideoScaleDrainByOrg?: Set<string> };
const drainingOrgs = (drainLock.__erpVideoScaleDrainByOrg ??= new Set<string>());

/**
 * Chạy liên tục sau cú bấm (trong `after()`): xử lý việc, ngủ tới mốc hỏi Veo kế tiếp, lặp — tới khi hết việc sống hoặc
 * hết `maxMs`. Một tiến trình chỉ một vòng như vậy (vòng đang chạy tự nhặt việc mới). Lượt vòng của bộ lập lịch là lưới
 * an toàn khi tiến trình chết.
 */
export async function drainVideoScale(db: Db, opts: { maxMs: number; deps?: VideoScaleDeps }): Promise<void> {
  const orgKey = await organizationStateKey();
  if (drainingOrgs.has(orgKey)) return;
  drainingOrgs.add(orgKey);
  const end = Date.now() + opts.maxMs;
  try {
    while (Date.now() < end) {
      await runVideoScaleTick(db, { budgetMs: Math.max(1000, end - Date.now()), deps: opts.deps });
      const next = await nextDueAt(db);
      if (!next) break;
      const wait = next.getTime() - Date.now();
      if (wait > end - Date.now()) break;
      await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(wait, 20_000))));
    }
  } finally {
    drainingOrgs.delete(orgKey);
  }
}

// ───────────────────────────── ĐẨY TRẠNG THÁI ─────────────────────────────

/** Đẩy một biến thể sang bước kế theo trạng thái các việc của nó. Lũy đẳng. */
export async function advanceVariant(db: Db, variantId: string): Promise<void> {
  const [v] = await db.select().from(V).where(eq(V.id, variantId)).limit(1);
  if (!v) return;
  const jobs = await db.select({ kind: J.kind, status: J.status, error: J.error, attempts: J.attempts, providerRef: J.providerRef }).from(J).where(eq(J.variantId, variantId));
  const failed = jobs.find((x) => x.status === "FAILED");
  if (["SCRIPTED", "GENERATING", "RENDERING", "QC"].includes(v.status) && failed) {
    await db.update(V).set({ status: "FAILED", error: `${failed.kind}: ${failed.error}`.slice(0, 1000) }).where(and(eq(V.id, variantId), eq(V.status, v.status)));
  } else if (v.status === "SCRIPTED" || v.status === "GENERATING") {
    const production = jobs.filter((x) => x.kind === "CLIP" || x.kind === "TTS");
    const scenes = scriptOf(v.script).scenes.length;
    const clipsDone = jobs.filter((x) => x.kind === "CLIP" && x.status === "SUCCEEDED").length;
    if (production.length > 0 && clipsDone === scenes && production.every((x) => x.status === "SUCCEEDED")) {
      const [run] = await db.select({ isTest: R.isTest, createdByUserId: R.createdByUserId }).from(R).where(eq(R.id, v.runId)).limit(1);
      await db.update(V).set({ status: "RENDERING" }).where(and(eq(V.id, variantId), eq(V.status, v.status)));
      await enqueueJob(db, { kind: "RENDER", key: `render:${variantId}`, runId: v.runId, variantId, isTest: run?.isTest ?? v.isTest, createdByUserId: run?.createdByUserId ?? null });
    } else if (v.status === "SCRIPTED" && production.some((x) => x.attempts > 0 || x.providerRef)) {
      await db.update(V).set({ status: "GENERATING" }).where(and(eq(V.id, variantId), eq(V.status, "SCRIPTED")));
    }
  }
  await refreshRunStatus(db, v.runId);
}

const IN_PRODUCTION = ["SCRIPTED", "GENERATING", "RENDERING", "QC"];

/** Trạng thái lượt suy ra từ các biến thể. Lượt đã HUỶ / hỏng ở bước kịch bản giữ nguyên. */
export async function refreshRunStatus(db: Db, runId: string): Promise<void> {
  const [run] = await db.select({ status: R.status }).from(R).where(eq(R.id, runId)).limit(1);
  if (!run || run.status === "CANCELLED" || run.status === "SCRIPTING") return;
  const vs = await db.select({ status: V.status }).from(V).where(eq(V.runId, runId));
  if (!vs.length) return;
  const st = vs.map((x) => x.status);
  const next = st.some((s) => IN_PRODUCTION.includes(s))
    ? "PRODUCING"
    : st.includes("REVIEW")
      ? "REVIEW"
      : st.some((s) => s === "APPROVED" || s === "REJECTED")
        ? "DONE"
        : "FAILED";
  if (next !== run.status) await db.update(R).set({ status: next }).where(eq(R.id, runId));
}

// ───────────────────────────── THAO TÁC CỦA NGƯỜI ─────────────────────────────

type Result = { ok: true } | { ok: false; error: string };

export async function approveVideoVariant(db: Db, variantId: string, actor: Actor, note: string, now = new Date()): Promise<Result> {
  if (!actor.id) return { ok: false, error: "Duyệt video phải là một tài khoản ERP." };
  const rows = await db
    .update(V)
    .set({ status: "APPROVED", reviewedByUserId: actor.id, reviewedBy: actor.label, reviewedAt: now, reviewNote: note.trim().slice(0, 500), autoApproved: false })
    .where(and(eq(V.id, variantId), eq(V.status, "REVIEW"), inArray(V.qcVerdict, ["PASS", "FLAG"]), isNotNull(V.finalAssetId)))
    .returning({ runId: V.runId, isTest: V.isTest });
  if (!rows[0]) return { ok: false, error: "Chỉ duyệt được video đang CHỜ DUYỆT và không bị QC loại." };
  // Video thật vừa được duyệt ⇒ máy viết content ngay (dữ liệu thử không bao giờ đăng nên không tốn lượt viết).
  if (!rows[0].isTest) await enqueueCaptionJob(db, { id: variantId, runId: rows[0].runId }, actor.id);
  await refreshRunStatus(db, rows[0].runId);
  return { ok: true };
}

export async function rejectVideoVariant(db: Db, variantId: string, actor: Actor, reason: string, now = new Date()): Promise<Result> {
  if (reason.trim().length < 3) return { ok: false, error: "Ghi lý do loại (ít nhất 3 ký tự) — máy học từ lý do này." };
  const rows = await db
    .update(V)
    .set({ status: "REJECTED", reviewedByUserId: actor.id, reviewedBy: actor.label, reviewedAt: now, reviewNote: reason.trim().slice(0, 500), autoApproved: false })
    .where(and(eq(V.id, variantId), inArray(V.status, ["REVIEW", "APPROVED"])))
    .returning({ runId: V.runId });
  if (!rows[0]) return { ok: false, error: "Chỉ loại được video đang chờ duyệt hoặc đã duyệt (chưa đăng)." };
  await refreshRunStatus(db, rows[0].runId);
  return { ok: true };
}

/** Làm lại MỘT biến thể hỏng / bị loại: biến thể MỚI cùng kịch bản, sinh clip lại từ đầu. Biến thể cũ giữ nguyên để học. */
export async function remakeVideoVariant(db: Db, variantId: string, actor: Actor): Promise<{ ok: true; variantId: string } | { ok: false; error: string }> {
  const [v] = await db.select().from(V).where(eq(V.id, variantId)).limit(1);
  if (!v || !["FAILED", "QC_FAILED", "REJECTED"].includes(v.status)) return { ok: false, error: "Chỉ làm lại được biến thể hỏng, bị QC loại hoặc bị loại." };
  const [run] = await db.select().from(R).where(eq(R.id, v.runId)).limit(1);
  if (!run || run.status === "CANCELLED") return { ok: false, error: "Lượt đã huỷ." };
  const snap = normalizeVideoScaleConfig(run.configSnapshot);
  const newId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    const [m] = await tx.select({ seq: max(V.seq) }).from(V).where(eq(V.runId, run.id));
    await tx.insert(V).values({
      id: newId,
      runId: run.id,
      productId: v.productId,
      seq: (m?.seq ?? 0) + 1,
      angle: v.angle,
      angleVocabVersion: v.angleVocabVersion,
      script: v.script,
      fingerprint: v.fingerprint,
      sourceId: v.sourceId,
      status: "SCRIPTED",
      isTest: v.isTest,
    });
    await enqueueVariantProduction(tx as unknown as Db, { variantId: newId, runId: run.id, script: scriptOf(v.script), voiceover: snap.voiceover, isTest: v.isTest, createdByUserId: actor.id });
    await tx.update(R).set({ status: "PRODUCING" }).where(eq(R.id, run.id));
  });
  return { ok: true, variantId: newId };
}

/** Người bấm "Thử lại" một việc hỏng / bị chặn. Biến thể hỏng vì việc ấy quay về bước tương ứng. */
export async function retryVideoJob(db: Db, jobId: string, now = new Date()): Promise<Result> {
  const [job] = await db.select({ kind: J.kind, variantId: J.variantId, runId: J.runId }).from(J).where(eq(J.id, jobId)).limit(1);
  if (!job) return { ok: false, error: "Không tìm thấy việc." };
  if (!(await resetJob(db, jobId, now))) return { ok: false, error: "Chỉ thử lại được việc HỎNG hoặc BỊ CHẶN mà không ai đang chạy." };
  if (job.variantId) {
    const back = job.kind === "RENDER" ? "RENDERING" : job.kind === "QC" ? "QC" : "GENERATING";
    await db.update(V).set({ status: back, error: "" }).where(and(eq(V.id, job.variantId), eq(V.status, "FAILED")));
  }
  if (job.kind === "SCRIPT" && job.runId) await db.update(R).set({ status: "SCRIPTING", error: "" }).where(and(eq(R.id, job.runId), eq(R.status, "FAILED")));
  if (job.runId) await refreshRunStatus(db, job.runId);
  return { ok: true };
}

/**
 * Đổi MỘT cảnh sang ẢNH ĐỘNG (miễn phí) — lối ra khi AI bị bộ lọc nội dung chặn hoặc hỏng hẳn. Chỉ việc sinh clip đã HỎNG /
 * BỊ CHẶN: clip đang tạo dở trên nhà cung cấp có thể đã tính tiền, không cắt ngang nó.
 */
export async function switchSceneToPhoto(db: Db, jobId: string, now = new Date()): Promise<Result> {
  const [job] = await db.select({ kind: J.kind, status: J.status, variantId: J.variantId, runId: J.runId }).from(J).where(eq(J.id, jobId)).limit(1);
  if (!job || job.kind !== "CLIP") return { ok: false, error: "Chỉ đổi được việc SINH CLIP." };
  if (!["FAILED", "BLOCKED"].includes(job.status)) return { ok: false, error: "Chỉ đổi được cảnh đã HỎNG hoặc BỊ CHẶN (clip đang tạo có thể đã tính tiền)." };
  await db.update(J).set({ request: { mode: "PHOTO" } }).where(and(eq(J.id, jobId), inArray(J.status, ["FAILED", "BLOCKED"])));
  if (!(await resetJob(db, jobId, now))) return { ok: false, error: "Việc đang được chạy — thử lại sau ít giây." };
  if (job.variantId) await db.update(V).set({ status: "GENERATING", error: "" }).where(and(eq(V.id, job.variantId), eq(V.status, "FAILED")));
  if (job.runId) await refreshRunStatus(db, job.runId);
  return { ok: true };
}

export async function cancelVideoRun(db: Db, runId: string, now = new Date()): Promise<Result> {
  const [run] = await db.select({ status: R.status }).from(R).where(eq(R.id, runId)).limit(1);
  if (!run) return { ok: false, error: "Không tìm thấy lượt." };
  if (["CANCELLED", "DONE"].includes(run.status)) return { ok: false, error: "Lượt đã kết thúc." };
  await cancelJobs(db, { runId }, now);
  await db.update(V).set({ status: "CANCELLED" }).where(and(eq(V.runId, runId), inArray(V.status, IN_PRODUCTION)));
  await db.update(R).set({ status: "CANCELLED" }).where(eq(R.id, runId));
  return { ok: true };
}

// ───────────────────────────── GIỮ / XOÁ TỆP ─────────────────────────────

/** Clip nguồn + giọng đọc giữ 3 ngày sau khi biến thể kết thúc; bản hoàn chỉnh của biến thể KHÔNG dùng giữ 14 ngày. */
export const ASSET_RETENTION = { sourceDays: 3, unusedFinalDays: 14 } as const;
const ENDED = ["APPROVED", "REJECTED", "QC_FAILED", "FAILED", "CANCELLED"];
const UNUSED = ["REJECTED", "QC_FAILED", "FAILED", "CANCELLED"];

export async function purgeExpiredAssets(db: Db, now: Date): Promise<number> {
  const day = 86_400_000;
  const stale = await db
    .select({ id: A.id })
    .from(A)
    .innerJoin(V, eq(V.id, A.variantId))
    .where(
      and(
        eq(A.status, "READY"),
        sql`(
          (${A.kind} IN ('SOURCE_CLIP', 'VOICE') AND ${V.status} IN (${sql.join(ENDED.map((s) => sql`${s}`), sql`, `)}) AND ${V.updatedAt} < ${new Date(now.getTime() - ASSET_RETENTION.sourceDays * day)})
          OR (${A.kind} IN ('FINAL', 'THUMBNAIL') AND ${V.status} IN (${sql.join(UNUSED.map((s) => sql`${s}`), sql`, `)}) AND ${V.updatedAt} < ${new Date(now.getTime() - ASSET_RETENTION.unusedFinalDays * day)})
        )`,
      ),
    )
    .orderBy(asc(A.createdAt))
    .limit(50);
  for (const s of stale) await purgeAsset(db, s.id);
  return stale.length;
}
