import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import {
  REEL_LIMITS,
  VIDEO_AUTOMATION_KEY,
  VIDEO_SCALE_CONFIG_KEY,
  normalizeVideoScaleConfig,
  composeCaption,
  effectivePublishMode,
  parseVideoAutomation,
  scheduleProblem,
  type CaptionOption,
  type VideoAutomationState,
} from "@/lib/constants/video-scale";
import { IntegrationError } from "@/lib/integrations/http";
import { facebookErrorText, finishReel, readReelStatus, startReelUpload, uploadReelVideo, type ReelStatus } from "@/lib/integrations/facebook/ads-write";
import { finalCaptionProblems } from "@/lib/video-scale/caption";
import { loadProductFacts } from "@/lib/video-scale/facts";
import type { HandlerCtx } from "@/lib/video-scale/handlers";
import { nextVnMidnight, scriptOf } from "@/lib/video-scale/handlers";
import { beginAttempt, blockJob, enqueueJob, failOrRetryJob, settleJob, succeedJob, waitJob, type VideoJobRow } from "@/lib/video-scale/queue";
import { readAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ CONTENT + ĐĂNG FACEBOOK REEL ═══════════
 *
 * Đặc tả: `docs/video-scale.md` §PR2. Lời ghi Facebook nằm ở `lib/integrations/facebook/ads-write.ts` (cửa ghi duy nhất);
 * tệp này quyết ĐƯỢC đăng hay không và giữ cho một biến thể không bao giờ thành hai bài.
 *
 * ─── CỔNG ĐĂNG (đọc lại TRƯỚC MỖI lượt, không chỉ lúc bấm) ───
 *  · công tắc dừng mọi tự động của module (`videoScale.automation`, fail-closed) · dừng cấp mã · dừng cấp fanpage;
 *  · biến thể ĐÃ DUYỆT, không phải dữ liệu thử, QC không loại, có bản hoàn chỉnh dài 3–90 giây;
 *  · fanpage của bài = fanpage ĐƯỢC DUYỆT của mã lúc này (đổi mapping giữa chừng ⇒ không đăng lên fanpage cũ);
 *  · content qua cùng bộ kiểm khẳng định với kịch bản (giá, size, màu, chất liệu, khuyến mãi).
 * Chốt env `ADS_WRITE_ENABLED` và công tắc khẩn cấp quảng cáo nằm TRONG từng lời ghi (`graphPost`).
 *
 * ─── KHÔNG ĐĂNG TRÙNG ───
 *  · Một dòng `video_scale_posts` cho một (biến thể, fanpage) — ràng buộc duy nhất ở CSDL. Thử lại dùng lại dòng ấy.
 *  · Bước 1 (mở phiên) và 2 (tải byte) gửi lại an toàn: không bước nào tạo bài. Chỉ bước 3 (`finish`) ĐĂNG.
 *  · `pending_step = FINISH` ghi TRƯỚC bước 3. Lượt sau thấy dấu ấy ⇒ HỎI trạng thái video trước; Facebook đã nhận
 *    (đang / đã đăng / đã hẹn) ⇒ không gửi lại.
 */

const V = schema.videoScaleVariants;
const Ps = schema.videoScalePosts;
const SK = schema.videoScaleSkus;
const PG = schema.videoScalePages;
const J = schema.videoScaleJobs;

/** Cửa Facebook tiêm được — kiểm thử chạy cả luồng trên bộ giả, không gọi mạng. */
export type ReelApi = {
  start: (pageId: string) => Promise<{ videoId: string }>;
  upload: (pageId: string, videoId: string, bytes: Uint8Array) => Promise<void>;
  finish: (pageId: string, input: { videoId: string; description: string; publishAt: Date | null }) => Promise<void>;
  status: (pageId: string, videoId: string) => Promise<ReelStatus>;
};

export const FACEBOOK_REEL_API: ReelApi = { start: startReelUpload, upload: uploadReelVideo, finish: finishReel, status: readReelStatus };

/** Công tắc dừng mọi tự động — đọc THẲNG CSDL (không qua `getSettingJson`, hàm ấy biến lỗi thành "không có dòng" = mở). */
export async function readVideoAutomation(db: Db): Promise<VideoAutomationState> {
  try {
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, VIDEO_AUTOMATION_KEY)).limit(1);
    return parseVideoAutomation({ ok: true, value: row?.value ?? null });
  } catch (e) {
    return parseVideoAutomation({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export type PublishGate = { ok: true; pageId: string; autoMode: boolean; maxPostsPerDay: number } | { ok: false; reason: string; blocked: boolean };

/**
 * Cổng đăng — hàm đọc CSDL, không gọi Facebook. `blocked = true` ⇒ điều kiện có thể tự hết (dừng khẩn cấp, fanpage
 * tạm dừng) ⇒ việc đứng chờ; `false` ⇒ bài này không bao giờ đăng được như đang khai ⇒ hỏng có lý do.
 */
export async function publishGate(db: Db, variantId: string, pageId: string | null): Promise<PublishGate> {
  const [v] = await db.select().from(V).where(eq(V.id, variantId)).limit(1);
  if (!v) return { ok: false, reason: "Không tìm thấy biến thể.", blocked: false };
  const auto = await readVideoAutomation(db);
  if (auto.paused) return { ok: false, reason: `Video Scale đang DỪNG mọi tự động${auto.reason ? `: ${auto.reason}` : ""}.`, blocked: true };
  const [sku] = await db.select().from(SK).where(eq(SK.productId, v.productId)).limit(1);
  if (sku?.automationPausedAt) return { ok: false, reason: `Mã đang dừng khẩn cấp${sku.automationPausedReason ? `: ${sku.automationPausedReason}` : ""}.`, blocked: true };
  if (v.isTest) return { ok: false, reason: "Video là DỮ LIỆU THỬ (bộ sinh giả) — không bao giờ đăng.", blocked: false };
  if (v.status !== "APPROVED") return { ok: false, reason: "Chỉ đăng được video ĐÃ DUYỆT.", blocked: false };
  if (v.qcVerdict === "FAIL" || !v.finalAssetId) return { ok: false, reason: "Video bị QC loại hoặc chưa có bản hoàn chỉnh.", blocked: false };
  const sec = (v.durationMs ?? 0) / 1000;
  if (sec < REEL_LIMITS.minSeconds || sec > REEL_LIMITS.maxSeconds) return { ok: false, reason: `Video dài ${sec.toFixed(1)} giây — Reels nhận ${REEL_LIMITS.minSeconds}–${REEL_LIMITS.maxSeconds} giây.`, blocked: false };
  if (!sku?.pageId) return { ok: false, reason: "Mã chưa được gán FANPAGE được duyệt (tab Mã win).", blocked: false };
  if (pageId && sku.pageId !== pageId) return { ok: false, reason: `Fanpage của mã đã đổi (${sku.pageId}) — không đăng lên fanpage cũ ${pageId}.`, blocked: false };
  const [page] = await db.select().from(PG).where(eq(PG.pageId, sku.pageId)).limit(1);
  if (page?.pausedAt) return { ok: false, reason: `Fanpage đang dừng khẩn cấp${page.pausedReason ? `: ${page.pausedReason}` : ""}.`, blocked: true };
  return { ok: true, pageId: sku.pageId, autoMode: effectivePublishMode(page ?? null, sku) === "AUTO_PUBLISH", maxPostsPerDay: page?.maxPostsPerDay ?? 3 };
}

/** Bài TỰ ĐỘNG đã đăng / đang đăng hôm nay (giờ VN) trên một fanpage — trần bài / ngày của `AUTO_PUBLISH`. */
export async function autoPostsToday(db: Db, pageId: string, now: Date, exceptPostId = ""): Promise<number> {
  const day = vnDay(now);
  const [r] = await db
    .select({ n: count() })
    .from(Ps)
    .where(and(eq(Ps.pageId, pageId), eq(Ps.auto, true), notInArray(Ps.status, ["FAILED", "CANCELLED", "QUEUED"]), sql`to_char(${Ps.createdAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') = ${day}`, sql`${Ps.id} <> ${exceptPostId}`));
  return Number(r?.n ?? 0);
}

type Result = { ok: true; postId: string } | { ok: false; error: string };

/**
 * Xin đăng một video: người bấm (`actor.id` có) hoặc máy (`actor = null`, fanpage `AUTO_PUBLISH`). Kiểm cổng + content +
 * giờ hẹn TRƯỚC khi ghi. Dòng bài đã có cho (biến thể, fanpage): đang / đã đăng ⇒ từ chối; hỏng / huỷ ⇒ dùng lại dòng.
 */
export async function requestReelPost(db: Db, input: { variantId: string; caption: string; publishAt: Date | null }, actor: Actor | null, now = new Date()): Promise<Result> {
  const gate = await publishGate(db, input.variantId, null);
  if (!gate.ok) return { ok: false, error: gate.reason };
  if (!actor && !gate.autoMode) return { ok: false, error: "Fanpage chưa bật tự đăng — cần người bấm." };
  const [v] = await db.select({ productId: V.productId, runId: V.runId }).from(V).where(eq(V.id, input.variantId)).limit(1);
  const [cfgRow] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY)).limit(1);
  let rawCfg: unknown = {};
  try {
    rawCfg = cfgRow ? JSON.parse(cfgRow.value) : {};
  } catch {
    rawCfg = {};
  }
  const facts = await loadProductFacts(db, v.productId, null, normalizeVideoScaleConfig(rawCfg).policyLines);
  if (!facts) return { ok: false, error: "Không đọc được sản phẩm." };
  const problems = finalCaptionProblems(input.caption, facts);
  if (problems.length) return { ok: false, error: `Content chưa đăng được: ${problems.slice(0, 3).join("; ")}` };
  const sched = scheduleProblem(input.publishAt, now);
  if (sched) return { ok: false, error: sched };
  const caption = input.caption.trim();
  let postId = "";
  const err = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(Ps).where(and(eq(Ps.variantId, input.variantId), eq(Ps.pageId, gate.pageId))).limit(1);
    if (existing && !["FAILED", "CANCELLED"].includes(existing.status)) return `Video này đã có bài trên fanpage (trạng thái ${existing.status}) — không đăng lần hai.`;
    if (existing && existing.fbVideoId && existing.status === "FAILED" && existing.pendingStep === "FINISH") return "Lượt đăng trước có thể đã tới Facebook (không rõ) — kiểm tra fanpage rồi huỷ bài hỏng trước khi đăng lại.";
    const who = actor ? { authorizedByUserId: actor.id, authorizedBy: actor.label, auto: false } : { authorizedByUserId: null, authorizedBy: "Máy — fanpage bật tự đăng", auto: true };
    if (existing) {
      await tx
        .update(Ps)
        .set({ status: "QUEUED", caption, publishAt: input.publishAt, error: "", pendingStep: "", pendingAt: null, fbVideoId: "", uploadedAt: null, ...who })
        .where(eq(Ps.id, existing.id));
      postId = existing.id;
    } else {
      const [row] = await tx.insert(Ps).values({ variantId: input.variantId, productId: v.productId, pageId: gate.pageId, caption, publishAt: input.publishAt, status: "QUEUED", ...who }).returning({ id: Ps.id });
      postId = row.id;
    }
    await tx
      .update(V)
      .set({ caption, captionState: "READY", captionAt: now, ...(actor ? { captionByUserId: actor.id, captionBy: actor.label } : { captionByUserId: null, captionBy: "Máy — đăng tự động" }) })
      .where(eq(V.id, input.variantId));
    const [{ n }] = await tx.select({ n: count() }).from(J).where(eq(J.postId, postId));
    await enqueueJob(tx as unknown as Db, { kind: "PUBLISH_REEL", key: `reel:${postId}:${Number(n) + 1}`, runId: v.runId, variantId: input.variantId, postId, isTest: false, createdByUserId: actor?.id ?? null });
    return null;
  });
  if (err) return { ok: false, error: err };
  return { ok: true, postId };
}

export async function cancelReelPost(db: Db, postId: string, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await db.update(Ps).set({ status: "CANCELLED" }).where(and(eq(Ps.id, postId), inArray(Ps.status, ["QUEUED", "FAILED"]))).returning({ id: Ps.id });
  if (!rows[0]) return { ok: false, error: "Chỉ huỷ được bài CHỜ ĐĂNG hoặc LỖI (bài đã gửi Facebook phải gỡ trên fanpage)." };
  await db.update(J).set({ status: "CANCELLED", finishedAt: now, lockedUntil: null, lockToken: "" }).where(and(eq(J.postId, postId), inArray(J.status, ["QUEUED", "WAITING", "BLOCKED", "RUNNING"])));
  return { ok: true };
}

// ───────────────────────────── VIỆC: VIẾT CONTENT ─────────────────────────────

export async function handleCaption(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now, cfgNow } = ctx;
  const [v] = job.variantId ? await db.select().from(V).where(eq(V.id, job.variantId)).limit(1) : [];
  if (!v || v.status !== "APPROVED") return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now, error: "Video không còn ở trạng thái đã duyệt." }));
  const facts = await loadProductFacts(db, v.productId, v.sourceId, cfgNow.policyLines);
  if (!facts) return void (await failOrRetryJob(db, job, now, "Không đọc được sản phẩm.", "PERMANENT"));
  if (!(await beginAttempt(db, job))) return;
  const w = await ctx.deps.captionWriter(db, { facts, script: scriptOf(v.script), entityId: v.id });
  if (!w.ok) {
    if (/OPENAI_API_KEY|trần chi AI|trần AI/i.test(w.error)) return void (await blockJob(db, job, w.error, new Date(now.getTime() + 30 * 60_000)));
    return void (await failOrRetryJob(db, job, now, w.error, "TRANSIENT"));
  }
  const first = composeCaption(w.options[0]);
  await db
    .update(V)
    .set({
      captionOptions: w.options as unknown as Record<string, unknown>[],
      captionModel: w.model,
      captionCostUsd: w.costUsd,
      // Người đã chốt content thì máy không viết đè — chỉ thêm phương án mới.
      ...(v.captionState === "READY" ? {} : { caption: first, captionState: "DRAFTED" }),
    })
    .where(eq(V.id, v.id));
  let auto = "";
  const gate = await publishGate(db, v.id, null);
  if (gate.ok && gate.autoMode && v.captionState !== "READY") {
    const r = await requestReelPost(db, { variantId: v.id, caption: first, publishAt: null }, null, now);
    auto = r.ok ? `tự đăng: ${r.postId}` : `không tự đăng được: ${r.error}`;
  }
  await succeedJob(db, job, now, { costUsd: w.costUsd, costBasis: w.costUsd === null ? "" : "ESTIMATED", result: { options: w.options.length, dropped: w.dropped, auto } });
}

// ───────────────────────────── VIỆC: ĐĂNG REEL ─────────────────────────────

/** Phân loại lỗi của một lời gọi Facebook. Hàm THUẦN. */
export function reelErrorKind(e: unknown): "BLOCKED" | "TRANSIENT" | "PERMANENT" {
  if (e instanceof IntegrationError) {
    if (e.status === 403 && /đường ghi quảng cáo đang đóng/.test(e.message)) return "BLOCKED";
    if (e.retryable || e.status >= 500 || e.status === 429) return "TRANSIENT";
    return "PERMANENT";
  }
  return "TRANSIENT";
}

/** Facebook đã NHẬN bước đăng chưa (đang / đã đăng, hoặc đã hẹn)? Hàm THUẦN. */
export function reelFinishAccepted(s: ReelStatus): boolean {
  const p = s.publishing.toLowerCase();
  const ps = s.publishStatus.toLowerCase();
  return ps === "published" || ps === "scheduled" || (p !== "" && p !== "not_started");
}

export async function handlePublishReel(ctx: HandlerCtx, job: VideoJobRow): Promise<void> {
  const { db, now } = ctx;
  const api = ctx.deps.reel;
  const [post] = job.postId ? await db.select().from(Ps).where(eq(Ps.id, job.postId)).limit(1) : [];
  if (!post || post.status === "CANCELLED") return void (await settleJob(db, job, { status: "CANCELLED", finishedAt: now }));
  if (post.status === "PUBLISHED") return void (await succeedJob(db, job, now, { result: { note: "đã đăng từ lượt trước" } }));
  const setPost = (patch: Partial<typeof Ps.$inferInsert>) => db.update(Ps).set(patch).where(eq(Ps.id, post.id));

  // Cổng đọc lại MỖI lượt — chỉ trước khi Facebook nhận bước đăng (sau đó chỉ còn HỎI trạng thái).
  const accepted = post.status === "PROCESSING" || post.status === "SCHEDULED";
  if (!accepted) {
    const gate = await publishGate(db, post.variantId, post.pageId);
    if (!gate.ok) {
      if (gate.blocked) return void (await blockJob(db, job, gate.reason, new Date(now.getTime() + 15 * 60_000)));
      await setPost({ status: "FAILED", error: gate.reason });
      return void (await failOrRetryJob(db, job, now, gate.reason, "PERMANENT"));
    }
    if (post.auto && (await autoPostsToday(db, post.pageId, now, post.id)) >= gate.maxPostsPerDay) {
      return void (await blockJob(db, job, `Fanpage đã đủ ${gate.maxPostsPerDay} bài tự đăng hôm nay — bài này đăng sau 0 giờ.`, nextVnMidnight(now)));
    }
  }

  try {
    let videoId = post.fbVideoId;
    if (!videoId) {
      if (!(await beginAttempt(db, job))) return;
      await setPost({ status: "UPLOADING", error: "" });
      videoId = (await api.start(post.pageId)).videoId;
      await setPost({ fbVideoId: videoId });
    }
    if (!post.uploadedAt) {
      const [v] = await db.select({ finalAssetId: V.finalAssetId }).from(V).where(eq(V.id, post.variantId)).limit(1);
      const file = v?.finalAssetId ? await readAsset(db, v.finalAssetId) : null;
      if (!file) throw new IntegrationError("Bản hoàn chỉnh không còn trong kho.", 400);
      await api.upload(post.pageId, videoId, file.bytes);
      await setPost({ uploadedAt: now });
    }
    if (!accepted) {
      let alreadyAccepted = false;
      if (post.pendingStep === "FINISH") {
        // Lượt trước đã gửi bước ĐĂNG mà không chắc tới đâu ⇒ HỎI trước, không gửi lại mù.
        alreadyAccepted = reelFinishAccepted(await api.status(post.pageId, videoId));
      }
      if (!alreadyAccepted) {
        await setPost({ pendingStep: "FINISH", pendingAt: now });
        await api.finish(post.pageId, { videoId, description: post.caption, publishAt: post.publishAt });
      }
      await setPost({ pendingStep: "", pendingAt: null, status: post.publishAt ? "SCHEDULED" : "PROCESSING" });
      return void (await waitJob(db, job, new Date(now.getTime() + REEL_LIMITS.pollMs), { deadlineAt: new Date((post.publishAt ?? now).getTime() + REEL_LIMITS.processingDeadlineMs) }));
    }
    // Đã gửi đăng: HỎI trạng thái.
    const st = await api.status(post.pageId, videoId);
    if (st.error) {
      await setPost({ status: "FAILED", error: st.error });
      return void (await failOrRetryJob(db, job, now, `Facebook báo lỗi Reel: ${st.error}`, "PERMANENT"));
    }
    if (st.publishStatus.toLowerCase() === "published" || st.publishing.toLowerCase() === "complete") {
      const publishedAt = st.publishTime ? new Date(st.publishTime) : now;
      await setPost({ status: "PUBLISHED", publishedAt: Number.isFinite(publishedAt.getTime()) ? publishedAt : now, permalink: st.permalink || `https://www.facebook.com/reel/${videoId}`, error: "" });
      return void (await succeedJob(db, job, now, { result: { videoId, permalink: st.permalink } }));
    }
    if (job.deadlineAt && now > job.deadlineAt) {
      const msg = `Facebook chưa đăng xong sau ${REEL_LIMITS.processingDeadlineMs / 60_000} phút (xử lý: ${st.processing || "?"}, đăng: ${st.publishing || "?"}). Kiểm tra trên fanpage.`;
      await setPost({ status: "FAILED", error: msg });
      return void (await failOrRetryJob(db, job, now, msg, "PERMANENT"));
    }
    const next = post.status === "SCHEDULED" && post.publishAt && post.publishAt > now ? new Date(post.publishAt.getTime() + 60_000) : new Date(now.getTime() + REEL_LIMITS.pollMs);
    return void (await waitJob(db, job, next));
  } catch (e) {
    const kind = reelErrorKind(e);
    const msg = facebookErrorText(e);
    if (kind === "BLOCKED") return void (await blockJob(db, job, msg, new Date(now.getTime() + 15 * 60_000)));
    // Dấu FINISH còn lại ⇒ lượt sau HỎI trước (không đăng trùng) — nên lỗi mạng ở bước đăng vẫn thử lại được an toàn.
    // Hết lượt thử ⇒ bài HỎNG nhưng GIỮ dấu: không ai biết Facebook đã nhận chưa, `requestReelPost` sẽ không đăng lại mù.
    if (kind === "TRANSIENT") {
      if ((await failOrRetryJob(db, job, now, msg, "TRANSIENT")) === "FAILED") await setPost({ status: "FAILED", error: msg.slice(0, 1000) });
      return;
    }
    // Facebook TRẢ LỜI từ chối ⇒ chắc chắn chưa đăng ⇒ xoá dấu, đăng lại được sau khi sửa.
    await setPost({ status: "FAILED", error: msg.slice(0, 1000), pendingStep: "", pendingAt: null });
    await failOrRetryJob(db, job, now, msg, "PERMANENT");
  }
}

/** Phương án content đọc từ cột JSON — bỏ phần tử hỏng. Hàm THUẦN. */
export function captionOptionsOf(raw: unknown): CaptionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) => {
    const r = o as Partial<CaptionOption>;
    return typeof r?.hook === "string" && typeof r.body === "string" && typeof r.cta === "string" && Array.isArray(r.hashtags) ? [{ hook: r.hook, body: r.body, cta: r.cta, hashtags: r.hashtags.filter((h): h is string => typeof h === "string") }] : [];
  });
}
