import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import {
  VIDEO_ANGLE_VOCAB_VERSION,
  VIDEO_CLIP_DEADLINE_MS,
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_SCALE_HARD_LIMITS,
  clipCostUsd,
  normalizeVideoScaleConfig,
  outputSize,
  scriptTokens,
  type VideoScaleConfig,
  type VideoScript,
} from "@/lib/constants/video-scale";
import { readCreativeImage } from "@/lib/creative/images";
import { env } from "@/lib/env";
import { loadProductFacts } from "@/lib/video-scale/facts";
import { buildRenderArgs, frameArgs, probeFile, qcFrameTimes, runTool, type MediaProbe } from "@/lib/video-scale/ffmpeg";
import { planAngles } from "@/lib/video-scale/plan";
import { ProviderError, type VideoProvider } from "@/lib/video-scale/providers/types";
import { combineQc, technicalQc, type VisualQc } from "@/lib/video-scale/qc";
import { beginAttempt, blockJob, deferJob, enqueueJob, failOrRetryJob, settleJob, succeedJob, waitJob, type VideoJobRow } from "@/lib/video-scale/queue";
import { readAsset, storeAsset } from "@/lib/video-scale/storage";
import type { VideoScaleDeps } from "@/lib/video-scale/pipeline";

/**
 * ═══════════ MỘT HÀM XỬ LÝ CHO MỖI LOẠI VIỆC ═══════════
 *
 * Mỗi hàm nhận một việc ĐANG ĐƯỢC CẦM (`claimDueJobs`) và kết thúc bằng ĐÚNG MỘT lượt chốt (`succeed` · `wait` · `defer` ·
 * `block` · `failOrRetry`). Không hàm nào ném ra ngoài với một việc còn bị cầm — lỗi bất ngờ được `runJob` bắt và chốt là
 * `TRANSIENT`.
 *
 * TIỀN: trần ngày đọc CẤU HÌNH HIỆN TẠI (không phải ảnh chụp của lượt): người hạ trần / tắt module lúc 10 giờ thì việc
 * xếp hàng từ 9 giờ cũng dừng. Thông số KỸ THUẬT (model, độ phân giải, số giây) đọc ẢNH CHỤP: một lượt không đổi giữa
 * chừng.
 */

const R = schema.videoScaleRuns;
const V = schema.videoScaleVariants;
const J = schema.videoScaleJobs;
const S = schema.creativeSources;

export type HandlerCtx = { db: Db; now: Date; cfgNow: VideoScaleConfig; deps: Required<VideoScaleDeps> };

// ───────────────────────────── ĐỌC CHUNG ─────────────────────────────

async function loadRun(db: Db, runId: string | null) {
  if (!runId) return null;
  const [r] = await db.select().from(R).where(eq(R.id, runId)).limit(1);
  return r ?? null;
}

async function loadVariant(db: Db, variantId: string | null) {
  if (!variantId) return null;
  const [v] = await db.select().from(V).where(eq(V.id, variantId)).limit(1);
  return v ?? null;
}

/** Ảnh gốc: PHẢI là `PRODUCT_PHOTO` của đúng mã (ranh giới 1 — kiểm lại ở đây, không tin lượt tạo). */
export async function loadSourceImage(db: Db, sourceId: string, productId: string): Promise<{ bytes: Uint8Array; contentType: string } | string> {
  const [s] = await db.select({ kind: S.kind, productId: S.productId, imageId: S.imageId }).from(S).where(eq(S.id, sourceId)).limit(1);
  if (!s) return "Ảnh gốc không còn trong Nguồn ảnh.";
  if (s.kind !== "PRODUCT_PHOTO") return `Ảnh gốc loại ${s.kind} — chỉ ảnh sản phẩm thật được gửi sang máy sinh video.`;
  if (s.productId !== productId) return "Ảnh gốc không thuộc mã này.";
  if (!s.imageId) return "Ảnh gốc không có điểm ảnh.";
  const img = await readCreativeImage(db, s.imageId);
  if (!img) return "Điểm ảnh của ảnh gốc đã bị xoá.";
  return { bytes: new Uint8Array(img.bytes), contentType: img.contentType };
}

export function scriptOf(raw: Record<string, unknown>): VideoScript {
  return raw as unknown as VideoScript;
}

function snapshotOf(run: { configSnapshot: Record<string, unknown> }): VideoScaleConfig {
  return normalizeVideoScaleConfig(run.configSnapshot);
}

/** Nửa đêm giờ VN kế tiếp — lượt kiểm lại việc bị chặn vì hết trần NGÀY. */
export function nextVnMidnight(now: Date): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  vn.setUTCHours(24, 0, 30, 0);
  return new Date(vn.getTime() - 7 * 3_600_000);
}

/** Tiền đã GIỮ CHỖ trong trần của ngày (ước tính, gồm cả lượt hỏng — không biết nhà cung cấp có tính tiền hay không). */
export async function reservedUsdOnDay(db: Db, day: string, exceptJobId = ""): Promise<{ usd: number; clips: number }> {
  const [r] = await db
    .select({ usd: sql<string>`coalesce(sum(${J.reservedUsd}), 0)`, clips: sql<string>`count(*) filter (where ${J.reservedUsd} is not null)` })
    .from(J)
    .where(and(eq(J.kind, "CLIP"), eq(J.costDay, day), ne(J.id, exceptJobId)));
  return { usd: Number(r?.usd ?? 0), clips: Number(r?.clips ?? 0) };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "vs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function cancelIfVariantGone(ctx: HandlerCtx, job: VideoJobRow, variant: { status: string } | null): Promise<boolean> {
  if (variant && !["CANCELLED"].includes(variant.status)) return false;
  await settleJob(ctx.db, job, { status: "CANCELLED", finishedAt: ctx.now });
  return true;
}

// ───────────────────────────── SCRIPT ─────────────────────────────

export async function handleScript(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now } = ctx;
  const run = await loadRun(db, job.runId);
  if (!run || run.status === "CANCELLED") {
    await settleJob(db, job, { status: "CANCELLED", finishedAt: now });
    return;
  }
  const [already] = await db.select({ n: sql<string>`count(*)` }).from(V).where(eq(V.runId, run.id));
  if (Number(already?.n ?? 0) > 0) {
    await succeedJob(db, job, now, { result: { note: "kịch bản đã có từ lượt trước" } });
    return;
  }
  const snap = snapshotOf(run);
  const sourceIds = run.sourceIds;
  const facts = await loadProductFacts(db, run.productId, sourceIds[0] ?? null, snap.policyLines);
  if (!facts) {
    await failOrRetryJob(db, job, now, "Không đọc được sản phẩm.", "PERMANENT");
    await db.update(R).set({ status: "FAILED", error: "Không đọc được sản phẩm." }).where(eq(R.id, run.id));
    return;
  }
  const img = await loadSourceImage(db, sourceIds[0], run.productId);
  if (typeof img === "string") {
    await failOrRetryJob(db, job, now, img, "PERMANENT");
    await db.update(R).set({ status: "FAILED", error: img }).where(eq(R.id, run.id));
    return;
  }
  const prior = await db.select({ script: V.script, fingerprint: V.fingerprint }).from(V).where(eq(V.productId, run.productId)).orderBy(desc(V.createdAt)).limit(60);
  const existing = prior.map((p) => ({ hook: String((p.script as { hook?: unknown }).hook ?? ""), tokens: new Set(p.fingerprint.split(" ").filter(Boolean)) }));
  const [stats, lessons] = await Promise.all([ctx.deps.angleStats(db, run.productId), ctx.deps.lessons(db, run.productId)]);
  const plan = planAngles({ n: run.variantsRequested, requested: run.anglesRequested, stats, facts: { priceKnown: facts.priceVnd !== null, colorCount: facts.colors.length }, seed: run.id });
  if (plan.angles.length === 0) {
    const error = `Không có góc bán nào dùng được: ${plan.dropped.map((d) => `${d.angle} (${d.reason})`).join("; ") || "không rõ"}.`;
    await failOrRetryJob(db, job, now, error, "PERMANENT");
    await db.update(R).set({ status: "FAILED", error }).where(eq(R.id, run.id));
    return;
  }
  if (!(await beginAttempt(db, job))) return;
  const w = await ctx.deps.scriptWriter(db, {
    facts,
    angles: plan.angles,
    scenes: snap.scenesPerVariant,
    clipSeconds: snap.clipSeconds,
    brief: run.brief,
    existing,
    lessons,
    sourceImage: img,
    entityId: run.id,
  });
  if (!w.ok) {
    const blocked = /OPENAI_API_KEY|trần chi AI|trần AI/i.test(w.error);
    if (blocked) await blockJob(db, job, w.error, new Date(now.getTime() + 30 * 60_000));
    else {
      const st = await failOrRetryJob(db, job, now, w.error, "TRANSIENT");
      if (st === "FAILED") await db.update(R).set({ status: "FAILED", error: w.error, scriptModel: w.model, scriptCostUsd: w.costUsd }).where(eq(R.id, run.id));
    }
    return;
  }
  const dropped = [...plan.dropped.map((d) => `${d.angle}: ${d.reason}`), ...w.dropped.map((d) => `${d.angle}: ${d.reasons.join("; ")}`)];
  await db.transaction(async (tx) => {
    let seq = 0;
    for (const s of w.scripts) {
      seq += 1;
      const [v] = await tx
        .insert(V)
        .values({
          runId: run.id,
          productId: run.productId,
          seq,
          angle: s.angle,
          angleVocabVersion: VIDEO_ANGLE_VOCAB_VERSION,
          script: s as unknown as Record<string, unknown>,
          fingerprint: [...scriptTokens(s)].sort().join(" "),
          sourceId: sourceIds[(seq - 1) % sourceIds.length],
          status: "SCRIPTED",
          isTest: run.isTest,
        })
        .onConflictDoNothing()
        .returning({ id: V.id });
      if (v) await enqueueVariantProduction(tx as unknown as Db, { variantId: v.id, runId: run.id, script: s, voiceover: snap.voiceover, isTest: run.isTest, createdByUserId: run.createdByUserId });
    }
    await tx
      .update(R)
      .set({ status: w.scripts.length ? "PRODUCING" : "FAILED", scriptModel: w.model, scriptCostUsd: w.costUsd, error: w.scripts.length ? (dropped.length ? `Bỏ: ${dropped.join(" | ")}`.slice(0, 2000) : "") : `Không kịch bản nào qua kiểm: ${dropped.join(" | ")}`.slice(0, 2000) })
      .where(eq(R.id, run.id));
  });
  await succeedJob(db, job, now, { result: { kept: w.scripts.length, dropped }, costUsd: w.costUsd, costBasis: w.costUsd === null ? "" : "ESTIMATED", costDay: vnDay(now) });
}

/** Xếp việc sản xuất của một biến thể: mỗi cảnh một CLIP (+ một TTS khi bật giọng đọc). Khoá chống trùng theo (biến thể, cảnh). */
export async function enqueueVariantProduction(db: Db, v: { variantId: string; runId: string; script: VideoScript; voiceover: boolean; isTest: boolean; createdByUserId: string | null }) {
  for (let i = 0; i < v.script.scenes.length; i += 1) {
    await enqueueJob(db, { kind: "CLIP", key: `clip:${v.variantId}:${i}`, runId: v.runId, variantId: v.variantId, sceneIndex: i, isTest: v.isTest, createdByUserId: v.createdByUserId });
    if (v.voiceover && v.script.scenes[i].voiceover.trim()) {
      await enqueueJob(db, { kind: "TTS", key: `tts:${v.variantId}:${i}`, runId: v.runId, variantId: v.variantId, sceneIndex: i, isTest: v.isTest, createdByUserId: v.createdByUserId });
    }
  }
}

// ───────────────────────────── CLIP ─────────────────────────────

export async function handleClip(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now, cfgNow } = ctx;
  const variant = await loadVariant(db, job.variantId);
  if (await cancelIfVariantGone(ctx, job, variant)) return;
  const run = await loadRun(db, job.runId);
  if (!run || !variant) return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  const snap = snapshotOf(run);
  let provider: VideoProvider;
  try {
    provider = ctx.deps.provider(snap.provider);
  } catch (e) {
    return void (await failOrRetryJob(db, job, now, e instanceof Error ? e.message : String(e), "PERMANENT"));
  }

  // ─── ĐÃ GỬI: chỉ HỎI, không tạo lại ───
  if (job.providerRef) {
    let polled;
    try {
      polled = await provider.poll(job.providerRef);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job.deadlineAt && now > job.deadlineAt) return void (await failOrRetryJob(db, job, now, `Quá hạn chờ clip: ${msg}`, "PERMANENT"));
      return void (await waitJob(db, job, new Date(now.getTime() + VIDEO_POLL_INTERVAL_MS * 2), { error: msg.slice(0, 500) }));
    }
    if (polled.state === "RUNNING") {
      if (job.deadlineAt && now > job.deadlineAt) {
        return void (await failOrRetryJob(db, job, now, `Veo chưa xong sau ${VIDEO_CLIP_DEADLINE_MS / 60_000} phút — bỏ lượt này (tiền giữ chỗ vẫn tính vào trần).`, "PERMANENT"));
      }
      return void (await waitJob(db, job, new Date(now.getTime() + VIDEO_POLL_INTERVAL_MS)));
    }
    if (polled.state === "FAILED") {
      // Lượt tạo mới (nếu thử lại) là một thao tác KHÁC: xoá mã cũ; tiền giữ chỗ của lượt hỏng vẫn nằm trong trần.
      return void (await failOrRetryJob(db, job, now, polled.error, polled.kind, { providerRef: "" }));
    }
    let bytes: Uint8Array;
    try {
      bytes = await provider.download(polled.videoUri);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job.deadlineAt && now > job.deadlineAt) return void (await failOrRetryJob(db, job, now, `Không tải được clip trước hạn: ${msg}`, "PERMANENT"));
      return void (await waitJob(db, job, new Date(now.getTime() + VIDEO_POLL_INTERVAL_MS), { error: msg.slice(0, 500) }));
    }
    let probe: MediaProbe | null = null;
    try {
      probe = await withTemp(async (dir) => {
        const f = path.join(dir, "clip.mp4");
        await writeFile(f, bytes);
        return probeFile(f);
      });
    } catch {
      probe = null; // thiếu ffprobe: độ dài đo lại lúc hậu kỳ
    }
    const asset = await storeAsset(db, {
      kind: "SOURCE_CLIP",
      bytes,
      contentType: "video/mp4",
      runId: run.id,
      variantId: variant.id,
      isTest: run.isTest,
      durationMs: probe?.durationSec ? Math.round(probe.durationSec * 1000) : null,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
    });
    const cost = provider.id === "FAKE" ? 0 : clipCostUsd(snap.model, snap.resolution, snap.clipSeconds);
    await succeedJob(db, job, now, { outputAssetId: asset.id, costUsd: cost, costBasis: cost === null ? "" : "ESTIMATED", result: { bytes: asset.bytes, durationSec: probe?.durationSec ?? null } });
    return;
  }

  // ─── CHƯA GỬI ───
  if (job.providerPendingAt) {
    // Ranh giới 3: lượt trước đã bắt đầu lời gọi tạo mà không kịp lưu mã thao tác.
    return void (await failOrRetryJob(db, job, now, "Lượt trước đã gửi yêu cầu tạo clip nhưng không lưu được mã thao tác — có thể clip đã được tạo và tính tiền. Máy không tự gửi lại; bấm \"Thử lại\" nếu chấp nhận rủi ro trả tiền hai lần.", "AMBIGUOUS"));
  }
  if (!cfgNow.enabled) return void (await blockJob(db, job, "Video Scale đang TẮT ở Cấu hình — không bắt đầu clip mới.", new Date(now.getTime() + 15 * 60_000)));
  const est = provider.id === "FAKE" ? 0 : clipCostUsd(snap.model, snap.resolution, snap.clipSeconds);
  if (est === null) return void (await failOrRetryJob(db, job, now, `Model ${snap.model} chưa có trong bảng giá — không áp được trần tiền nên không sinh.`, "PERMANENT"));
  const day = vnDay(now);
  if (provider.id !== "FAKE") {
    if (cfgNow.dailyUsdCap === null) return void (await blockJob(db, job, "Chưa khai TRẦN CHI SINH VIDEO / NGÀY (USD) ở tab Cấu hình — máy không đoán ngân sách.", new Date(now.getTime() + 15 * 60_000)));
    const spent = await reservedUsdOnDay(db, day, job.id);
    if (spent.usd + est > cfgNow.dailyUsdCap + 1e-9) {
      return void (await blockJob(db, job, `Chạm trần chi sinh video hôm nay: đã giữ ${spent.usd.toFixed(2)} USD + clip này ${est.toFixed(2)} USD > trần ${cfgNow.dailyUsdCap.toFixed(2)} USD. Tự chạy lại sau 0 giờ.`, nextVnMidnight(now)));
    }
    if (spent.clips >= cfgNow.dailyClipCap) return void (await blockJob(db, job, `Chạm trần ${cfgNow.dailyClipCap} clip / ngày. Tự chạy lại sau 0 giờ.`, nextVnMidnight(now)));
  }
  const [flying] = await db
    .select({ n: sql<string>`count(*)` })
    .from(J)
    .where(and(eq(J.kind, "CLIP"), ne(J.id, job.id), or(eq(J.status, "WAITING"), isNotNull(J.providerPendingAt)), inArray(J.status, ["WAITING", "RUNNING"])));
  if (Number(flying?.n ?? 0) >= cfgNow.providerConcurrency) return void (await deferJob(db, job, new Date(now.getTime() + 30_000)));

  const img = await loadSourceImage(db, variant.sourceId, variant.productId);
  if (typeof img === "string") return void (await failOrRetryJob(db, job, now, img, "PERMANENT"));
  const script = scriptOf(variant.script);
  const scene = script.scenes[job.sceneIndex ?? 0];
  if (!scene) return void (await failOrRetryJob(db, job, now, "Kịch bản không có cảnh này.", "PERMANENT"));
  const prompt = ctx.deps.veoPrompt(scene.prompt);
  // Giữ chỗ tiền + dấu "đang gửi" TRƯỚC lời gọi tạo (ranh giới 3).
  const reserved = (job.reservedUsd ?? 0) + est;
  if (!(await beginAttempt(db, job, { providerPendingAt: now, reservedUsd: reserved, costDay: day, provider: provider.id, model: snap.model, request: { prompt, seconds: snap.clipSeconds, resolution: snap.resolution, model: snap.model } }))) return;
  if (variant.status === "SCRIPTED") await db.update(V).set({ status: "GENERATING" }).where(and(eq(V.id, variant.id), eq(V.status, "SCRIPTED")));
  try {
    const { ref } = await provider.start({
      model: snap.model,
      prompt,
      negativePrompt: ctx.deps.negativePrompt,
      image: { kind: "PRODUCT_PHOTO", bytes: img.bytes, contentType: img.contentType },
      seconds: snap.clipSeconds,
      resolution: snap.resolution,
    });
    await waitJob(db, job, new Date(now.getTime() + VIDEO_POLL_INTERVAL_MS), { providerRef: ref, providerPendingAt: null, deadlineAt: new Date(now.getTime() + VIDEO_CLIP_DEADLINE_MS), error: "" });
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), "AMBIGUOUS");
    if (pe.kind === "AMBIGUOUS") return void (await failOrRetryJob(db, job, now, pe.message, "AMBIGUOUS"));
    // Chắc chắn CHƯA tạo gì ⇒ trả chỗ trong trần.
    const release = { providerPendingAt: null, reservedUsd: job.reservedUsd && job.reservedUsd - est > 1e-9 ? job.reservedUsd - est : null };
    if (pe.kind === "BLOCKED") return void (await blockJob(db, job, pe.message, new Date(now.getTime() + 30 * 60_000), release));
    await failOrRetryJob(db, job, now, pe.message, pe.kind, release);
  }
}

// ───────────────────────────── TTS ─────────────────────────────

export async function handleTts(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now } = ctx;
  const variant = await loadVariant(db, job.variantId);
  if (await cancelIfVariantGone(ctx, job, variant)) return;
  const run = await loadRun(db, job.runId);
  if (!run || !variant) return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  const scene = scriptOf(variant.script).scenes[job.sceneIndex ?? 0];
  if (!scene?.voiceover.trim()) return void (await succeedJob(db, job, now, { result: { note: "cảnh không có lời đọc" } }));
  if (!(await beginAttempt(db, job))) return;
  try {
    const bytes = await ctx.deps.tts(db, { text: scene.voiceover, voice: snapshotOf(run).voice, entityId: variant.id });
    const asset = await storeAsset(db, { kind: "VOICE", bytes, contentType: "audio/mpeg", runId: run.id, variantId: variant.id, isTest: run.isTest });
    await succeedJob(db, job, now, { outputAssetId: asset.id });
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), "TRANSIENT");
    if (pe.kind === "BLOCKED") return void (await blockJob(db, job, pe.message, new Date(now.getTime() + 30 * 60_000)));
    await failOrRetryJob(db, job, now, pe.message, pe.kind === "AMBIGUOUS" ? "TRANSIENT" : pe.kind);
  }
}

// ───────────────────────────── RENDER ─────────────────────────────

const renderSlots = { busy: 0 };

export async function handleRender(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now } = ctx;
  const variant = await loadVariant(db, job.variantId);
  if (await cancelIfVariantGone(ctx, job, variant)) return;
  const run = await loadRun(db, job.runId);
  if (!run || !variant) return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  const version = await ctx.deps.ffmpegVersion();
  if (!version) return void (await blockJob(db, job, "Máy chủ ERP không có ffmpeg — hậu kỳ không chạy được. Image Docker phải cài `apk add ffmpeg font-dejavu`.", new Date(now.getTime() + 30 * 60_000)));
  const [others] = await db
    .select({ n: sql<string>`count(*)` })
    .from(J)
    .where(and(eq(J.kind, "RENDER"), eq(J.status, "RUNNING"), ne(J.id, job.id), gt(J.lockedUntil, now)));
  if (renderSlots.busy >= VIDEO_SCALE_HARD_LIMITS.maxRenderConcurrency || Number(others?.n ?? 0) >= VIDEO_SCALE_HARD_LIMITS.maxRenderConcurrency) {
    return void (await deferJob(db, job, new Date(now.getTime() + 60_000)));
  }
  const snap = snapshotOf(run);
  const script = scriptOf(variant.script);
  const inputs = await db
    .select({ kind: J.kind, sceneIndex: J.sceneIndex, assetId: J.outputAssetId })
    .from(J)
    .where(and(eq(J.variantId, variant.id), inArray(J.kind, ["CLIP", "TTS"]), eq(J.status, "SUCCEEDED")))
    .orderBy(asc(J.sceneIndex));
  const clips = inputs.filter((x) => x.kind === "CLIP" && x.assetId);
  if (clips.length !== script.scenes.length) return void (await failOrRetryJob(db, job, now, `Thiếu clip: có ${clips.length}/${script.scenes.length} cảnh.`, "PERMANENT"));
  if (!(await beginAttempt(db, job))) return;
  renderSlots.busy += 1;
  try {
    const size = outputSize(snap.outputHeight);
    const result = await withTemp(async (dir) => {
      const clipFiles: { file: string; durationSec: number; hasAudio: boolean }[] = [];
      for (const c of clips) {
        const a = await readAsset(db, c.assetId as string);
        if (!a) throw new ProviderError(`Clip cảnh ${(c.sceneIndex ?? 0) + 1} không còn trong kho (đã xoá sau hạn giữ?).`, "PERMANENT");
        const f = path.join(dir, `c${c.sceneIndex}.mp4`);
        await writeFile(f, a.bytes);
        const p = await probeFile(f);
        clipFiles.push({ file: f, durationSec: p.durationSec ?? snap.clipSeconds, hasAudio: p.hasAudio });
      }
      const voices = new Map<number, { file: string; durationSec: number }>();
      for (const t of inputs.filter((x) => x.kind === "TTS" && x.assetId)) {
        const a = await readAsset(db, t.assetId as string);
        if (!a) continue;
        const f = path.join(dir, `v${t.sceneIndex}.mp3`);
        await writeFile(f, a.bytes);
        const p = await probeFile(f);
        if (p.durationSec) voices.set(t.sceneIndex ?? 0, { file: f, durationSec: p.durationSec });
      }
      let music: { file: string; volume: number } | null = null;
      if (run.musicId) {
        const [m] = await db.select({ assetId: schema.videoScaleMusic.assetId }).from(schema.videoScaleMusic).where(and(eq(schema.videoScaleMusic.id, run.musicId), eq(schema.videoScaleMusic.active, true))).limit(1);
        const a = m ? await readAsset(db, m.assetId) : null;
        if (a) {
          const f = path.join(dir, "music.bin");
          await writeFile(f, a.bytes);
          music = { file: f, volume: 0.18 };
        }
      }
      const plan = buildRenderArgs({
        clips: clipFiles,
        scenes: script.scenes.map((s, i) => ({ overlay: s.overlay, subtitle: s.voiceover, voice: voices.get(i) ?? null })),
        hook: script.hook,
        cta: script.cta,
        music,
        keepNativeAudio: snap.keepNativeAudio,
        burnSubtitles: snap.burnSubtitles,
        width: size.width,
        height: size.height,
        fontFile: env.videoScale.fontFile,
        output: "final.mp4",
      });
      for (const t of plan.textFiles) await writeFile(path.join(dir, t.name), t.content, "utf8");
      const r = await runTool(env.videoScale.ffmpegPath, plan.args, { cwd: dir, timeoutMs: 6 * 60_000 });
      if (r.code !== 0) throw new ProviderError(`ffmpeg hỏng (mã ${r.code}): ${r.stderr.slice(-600)}`, "TRANSIENT");
      const out = path.join(dir, "final.mp4");
      const probe = await probeFile(out);
      const bytes = await readFile(out);
      const t2 = await runTool(env.videoScale.ffmpegPath, frameArgs(out, Math.min(1.2, (probe.durationSec ?? 2) / 2), path.join(dir, "thumb.jpg")), { timeoutMs: 60_000 });
      const thumb = t2.code === 0 ? await readFile(path.join(dir, "thumb.jpg")) : null;
      return { bytes, probe, thumb };
    });
    const finalAsset = await storeAsset(db, {
      kind: "FINAL",
      bytes: result.bytes,
      contentType: "video/mp4",
      runId: run.id,
      variantId: variant.id,
      isTest: run.isTest,
      durationMs: result.probe.durationSec ? Math.round(result.probe.durationSec * 1000) : null,
      width: result.probe.width,
      height: result.probe.height,
    });
    const thumbAsset = result.thumb ? await storeAsset(db, { kind: "THUMBNAIL", bytes: result.thumb, contentType: "image/jpeg", runId: run.id, variantId: variant.id, isTest: run.isTest }) : null;
    await db
      .update(V)
      .set({ status: "QC", finalAssetId: finalAsset.id, thumbnailAssetId: thumbAsset?.id ?? null, durationMs: result.probe.durationSec ? Math.round(result.probe.durationSec * 1000) : null, error: "" })
      .where(eq(V.id, variant.id));
    await enqueueJob(db, { kind: "QC", key: `qc:${variant.id}:${finalAsset.id}`, runId: run.id, variantId: variant.id, isTest: run.isTest });
    await succeedJob(db, job, now, { outputAssetId: finalAsset.id, result: { ffmpeg: version, bytes: finalAsset.bytes, durationSec: result.probe.durationSec } });
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), "TRANSIENT");
    await failOrRetryJob(db, job, now, pe.message, pe.kind === "AMBIGUOUS" ? "TRANSIENT" : pe.kind);
  } finally {
    renderSlots.busy -= 1;
  }
}

// ───────────────────────────── QC ─────────────────────────────

export async function handleQc(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now } = ctx;
  const variant = await loadVariant(db, job.variantId);
  if (await cancelIfVariantGone(ctx, job, variant)) return;
  const run = await loadRun(db, job.runId);
  if (!run || !variant || !variant.finalAssetId) return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  if (!(await ctx.deps.ffmpegVersion())) return void (await blockJob(db, job, "Máy chủ ERP không có ffmpeg/ffprobe — không kiểm được video.", new Date(now.getTime() + 30 * 60_000)));
  if (!(await beginAttempt(db, job))) return;
  const snap = snapshotOf(run);
  const script = scriptOf(variant.script);
  try {
    const final = await readAsset(db, variant.finalAssetId);
    if (!final) throw new ProviderError("Bản hoàn chỉnh không còn trong kho.", "PERMANENT");
    const { probe, frames } = await withTemp(async (dir) => {
      const f = path.join(dir, "final.mp4");
      await writeFile(f, final.bytes);
      const p = await probeFile(f);
      const out: Uint8Array[] = [];
      for (const [i, t] of qcFrameTimes(p.durationSec ?? 0).entries()) {
        const fr = path.join(dir, `f${i}.jpg`);
        const r = await runTool(env.videoScale.ffmpegPath, frameArgs(f, t, fr, 640), { timeoutMs: 60_000 });
        if (r.code === 0) out.push(new Uint8Array(await readFile(fr)));
      }
      return { probe: p, frames: out };
    });
    const size = outputSize(snap.outputHeight);
    const clipSec = await db
      .select({ d: sql<string>`coalesce(sum((${J.result}->>'durationSec')::float8), 0)`, n: sql<string>`count(*)` })
      .from(J)
      .where(and(eq(J.variantId, variant.id), eq(J.kind, "CLIP"), eq(J.status, "SUCCEEDED")));
    const measured = Number(clipSec[0]?.d ?? 0);
    const expectSec = measured > 0 && Number(clipSec[0]?.n ?? 0) === script.scenes.length ? measured : script.scenes.length * snap.clipSeconds;
    const tech = technicalQc(probe, { width: size.width, height: size.height, durationSec: expectSec, bytes: final.meta.bytes });
    let visual: VisualQc;
    if (run.isTest) visual = { ran: false, reason: "Dữ liệu THỬ (bộ sinh giả) — không chạy QC hình ảnh." };
    else if (tech.verdict === "FAIL") visual = { ran: false, reason: "Kỹ thuật đã loại — không tốn lượt QC hình ảnh." };
    else {
      const src = await loadSourceImage(db, variant.sourceId, variant.productId);
      visual = typeof src === "string" ? { ran: false, reason: src } : await ctx.deps.visual(db, { source: src, frames, entityId: variant.id });
    }
    const verdict = combineQc(tech, visual);
    const [sku] = await db.select({ reviewMode: schema.videoScaleSkus.reviewMode }).from(schema.videoScaleSkus).where(eq(schema.videoScaleSkus.productId, variant.productId)).limit(1);
    const auto = verdict === "PASS" && !run.isTest && sku?.reviewMode === "AUTO_ON_PASS";
    await db
      .update(V)
      .set({
        qcVerdict: verdict,
        qc: { technical: { verdict: tech.verdict, problems: tech.problems, probe: tech.probe }, visual, ffmpeg: await ctx.deps.ffmpegVersion() } as unknown as Record<string, unknown>,
        qcAt: now,
        status: verdict === "FAIL" ? "QC_FAILED" : auto ? "APPROVED" : "REVIEW",
        ...(auto ? { autoApproved: true, reviewedAt: now, reviewedBy: "Máy — tự duyệt khi QC đạt", reviewedByUserId: null } : {}),
      })
      .where(and(eq(V.id, variant.id), eq(V.status, "QC")));
    await succeedJob(db, job, now, { result: { verdict, auto }, costUsd: visual.ran ? visual.costUsd : null, costBasis: visual.ran && visual.costUsd !== null ? "ESTIMATED" : "" });
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), "TRANSIENT");
    await failOrRetryJob(db, job, now, pe.message, pe.kind === "AMBIGUOUS" ? "TRANSIENT" : pe.kind);
  }
}
