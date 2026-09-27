"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { VIDEO_SCALE_CONFIG_KEY, normalizeVideoScaleConfig } from "@/lib/constants/video-scale";
import { bindOrganization } from "@/lib/platform/background";
import { listProductPhotos, type SourcePhoto } from "@/lib/queries/video-scale";
import { approveVideoVariant, cancelVideoRun, createVideoRun, drainVideoScale, readVideoScaleConfig, rejectVideoVariant, remakeVideoVariant, retryVideoJob } from "@/lib/video-scale/pipeline";
import { storeAsset } from "@/lib/video-scale/storage";
import { videoCaptionSchema, videoConfigSchema, videoIdSchema, videoMusicUploadSchema, videoPageConfigSchema, videoPauseSchema, videoPublishSchema, videoReviewSchema, videoRunCreateSchema, videoSkuModeSchema, videoSkuPublishingSchema } from "@/lib/validation/video-scale";
import { VIDEO_AUTOMATION_KEY } from "@/lib/constants/video-scale";
import { finalCaptionProblems } from "@/lib/video-scale/caption";
import { loadProductFacts } from "@/lib/video-scale/facts";
import { cancelReelPost, readVideoAutomation, requestReelPost } from "@/lib/video-scale/publish";
import { activateVideoAd, pauseVideoAd, queueCreateAd, queuePauseAds, setVideoAdBudget } from "@/lib/video-scale/ads";
import { listAdAccountOptions } from "@/lib/queries/creative-manual-gen";
import { videoAdBudgetSchema, videoAdCreateSchema, videoAdIdSchema, videoAdPauseSchema, videoSkuAdsSchema } from "@/lib/validation/video-scale";
import { enqueueJob } from "@/lib/video-scale/queue";
import { DEFAULT_OPTIMIZE_DEPS, runOptimize } from "@/lib/video-scale/optimize";

/**
 * ═══════════ VIDEO SCALE — SERVER ACTIONS ═══════════
 *
 * Luật nằm ở `lib/video-scale/*`. Tệp này: quyền → lược đồ → tên người thao tác đọc ở MÁY CHỦ (AGENTS.md mục 34) → gọi →
 * nhật ký → làm mới màn hình.
 *
 * Quyền:
 *  · Tạo lượt (tiêu tiền sinh video) — `ideas:write` VÀ `expenses:write` (cùng cặp với "Đăng camp").
 *  · Duyệt / loại / làm lại / huỷ / tải nhạc — `ideas:write` (biên tập nội dung).
 *  · "Thử lại" việc `AMBIGUOUS` (có thể trả tiền hai lần) — thêm `expenses:write`.
 *  · Cấu hình (trần tiền, model) — `settings:manage`. Chế độ tự duyệt theo mã — `settings:manage` hoặc `expenses:write`.
 *
 * Sinh video KHÔNG chạy trong action: ghi việc vào hàng đợi rồi trả lời ngay; `after()` chạy hàng đợi (tối đa 15 phút) sau
 * phản hồi, lượt vòng của bộ lập lịch (`VIDEO_SCALE_EVERY_MINUTES`) là lưới an toàn khi tiến trình chết.
 */

const PATH = "/marketing/video-scale";
type Fail = { error: string };

async function actorOf(userId: string, fallback: string) {
  const db = await getDb();
  const who = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { name: true, email: true } });
  return { id: userId, label: who?.name?.trim() || who?.email || fallback };
}

async function drainAfterResponse() {
  after(
    await bindOrganization(async () => {
      try {
        await drainVideoScale(await getDb(), { maxMs: 15 * 60_000 });
      } catch {
        // Lượt vòng của bộ lập lịch làm nốt; việc không mất vì nằm trong hàng đợi.
      }
    }),
  );
}

export async function createVideoRunAction(raw: unknown): Promise<{ ok: true; runId: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write") || !can(user, "expenses:write")) return { error: "Tạo chiến dịch media tiêu tiền sinh video — cần quyền ý tưởng: sửa VÀ chi phí: sửa." };
  const parsed = videoRunCreateSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const r = await createVideoRun(db, { productId: d.productId, sourceIds: d.sourceIds, variants: d.variants, angles: d.angles, brief: d.brief, musicId: d.musicId || null }, actor);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_RUN_CREATE", entity: "VIDEO_SCALE_RUN", entityId: r.runId, after: d });
  await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true, runId: r.runId };
}

export async function reviewVideoVariantAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền duyệt video" };
  const parsed = videoReviewSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const r = parsed.data.decision === "APPROVE" ? await approveVideoVariant(db, parsed.data.variantId, actor, parsed.data.note) : await rejectVideoVariant(db, parsed.data.variantId, actor, parsed.data.note);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: parsed.data.decision === "APPROVE" ? "VIDEO_SCALE_VARIANT_APPROVE" : "VIDEO_SCALE_VARIANT_REJECT", entity: "VIDEO_SCALE_VARIANT", entityId: parsed.data.variantId, after: { note: parsed.data.note } });
  revalidatePath(PATH);
  return { ok: true };
}

export async function remakeVideoVariantAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write") || !can(user, "expenses:write")) return { error: "Làm lại sinh clip mới (tốn tiền) — cần quyền ý tưởng: sửa VÀ chi phí: sửa." };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu biến thể" };
  const db = await getDb();
  const r = await remakeVideoVariant(db, parsed.data.id, await actorOf(user.id, user.email));
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_VARIANT_REMAKE", entity: "VIDEO_SCALE_VARIANT", entityId: parsed.data.id, after: { newVariantId: r.variantId } });
  await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true };
}

export async function retryVideoJobAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền thao tác hàng đợi video" };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu việc" };
  const db = await getDb();
  const [job] = await db.select({ errorKind: schema.videoScaleJobs.errorKind, error: schema.videoScaleJobs.error, kind: schema.videoScaleJobs.kind }).from(schema.videoScaleJobs).where(eq(schema.videoScaleJobs.id, parsed.data.id)).limit(1);
  if (!job) return { error: "Không tìm thấy việc" };
  if (job.errorKind === "AMBIGUOUS" && !can(user, "expenses:write")) return { error: "Việc này có thể đã được tính tiền — chỉ người có quyền chi phí: sửa mới được thử lại." };
  const r = await retryVideoJob(db, parsed.data.id);
  if (!r.ok) return { error: r.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "VIDEO_SCALE_JOB_RETRY",
    entity: "VIDEO_SCALE_JOB",
    entityId: parsed.data.id,
    before: { kind: job.kind, errorKind: job.errorKind, error: job.error },
    reason: job.errorKind === "AMBIGUOUS" ? "Người bấm chấp nhận rủi ro nhà cung cấp tính tiền hai lần." : undefined,
  });
  await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true };
}

export async function cancelVideoRunAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền huỷ lượt video" };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu lượt" };
  const r = await cancelVideoRun(await getDb(), parsed.data.id);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_RUN_CANCEL", entity: "VIDEO_SCALE_RUN", entityId: parsed.data.id });
  revalidatePath(PATH);
  return { ok: true };
}

export async function saveVideoScaleConfigAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) return { error: "Chỉ người có quyền cấu hình hệ thống sửa được cấu hình Video Scale (trần tiền)." };
  const parsed = videoConfigSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const before = await readVideoScaleConfig(db);
  // Giữ nhà cung cấp đang khai (bộ sinh giả không chọn được từ màn hình production).
  const next = normalizeVideoScaleConfig({
    ...parsed.data,
    // Người chọn được VEO / OMNI; bộ sinh GIẢ đang khai (máy thử) thì giữ nguyên — màn hình không bật / tắt được nó.
    provider: before.provider === "FAKE" ? "FAKE" : (parsed.data.provider ?? before.provider),
    dailyUsdCap: parsed.data.dailyUsdCap === "" ? null : parsed.data.dailyUsdCap,
    adsGlobalDailyCapVnd: parsed.data.adsGlobalDailyCapVnd === "" ? null : parsed.data.adsGlobalDailyCapVnd,
    autoScaleMinOrders: parsed.data.autoScaleMinOrders === "" ? null : parsed.data.autoScaleMinOrders,
  });
  const text = JSON.stringify(next);
  await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_CONFIG_SAVE", entity: "SETTINGS", entityId: VIDEO_SCALE_CONFIG_KEY, before, after: next });
  revalidatePath(PATH);
  return { ok: true };
}

export async function setVideoSkuReviewModeAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "settings:manage") && !can(user, "expenses:write")) return { error: "Bật tự duyệt là quyết định của quản lý (cấu hình hệ thống hoặc chi phí: sửa)." };
  const parsed = videoSkuModeSchema.safeParse(raw);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const T = schema.videoScaleSkus;
  const [before] = await db.select({ reviewMode: T.reviewMode }).from(T).where(eq(T.productId, parsed.data.productId)).limit(1);
  await db
    .insert(T)
    .values({ productId: parsed.data.productId, reviewMode: parsed.data.reviewMode, updatedByUserId: actor.id, updatedBy: actor.label })
    .onConflictDoUpdate({ target: T.productId, set: { reviewMode: parsed.data.reviewMode, updatedByUserId: actor.id, updatedBy: actor.label, updatedAt: new Date() } });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_SKU_REVIEW_MODE", entity: "VIDEO_SCALE_SKU", entityId: parsed.data.productId, before: before ?? null, after: { reviewMode: parsed.data.reviewMode } });
  revalidatePath(PATH);
  return { ok: true };
}

export async function uploadVideoMusicAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền tải nhạc" };
  const parsed = videoMusicUploadSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const bytes = new Uint8Array(Buffer.from(d.base64, "base64"));
  if (bytes.byteLength > 7 * 1024 * 1024) return { error: "Tệp nhạc tối đa 7 MB." };
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  let assetId: string;
  try {
    assetId = (await storeAsset(db, { kind: "MUSIC", bytes, contentType: d.contentType })).id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const [m] = await db.insert(schema.videoScaleMusic).values({ title: d.title, licenseNote: d.licenseNote, assetId, uploadedByUserId: actor.id, uploadedBy: actor.label }).returning({ id: schema.videoScaleMusic.id });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_MUSIC_UPLOAD", entity: "VIDEO_SCALE_MUSIC", entityId: m.id, after: { title: d.title, licenseNote: d.licenseNote, bytes: bytes.byteLength } });
  revalidatePath(PATH);
  return { ok: true };
}

export async function toggleVideoMusicAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền sửa thư viện nhạc" };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu bản nhạc" };
  const db = await getDb();
  const M = schema.videoScaleMusic;
  const [m] = await db.select({ active: M.active }).from(M).where(eq(M.id, parsed.data.id)).limit(1);
  if (!m) return { error: "Không tìm thấy bản nhạc" };
  await db.update(M).set({ active: !m.active }).where(eq(M.id, parsed.data.id));
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_MUSIC_TOGGLE", entity: "VIDEO_SCALE_MUSIC", entityId: parsed.data.id, before: { active: m.active }, after: { active: !m.active } });
  revalidatePath(PATH);
  return { ok: true };
}

/** Ảnh sản phẩm thật (đang bật) của một mã — cho hộp "Tạo chiến dịch media". */
export async function loadVideoPhotosAction(raw: unknown): Promise<{ ok: true; photos: SourcePhoto[] } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:view")) return { error: "Bạn không có quyền xem ảnh" };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu mã" };
  return { ok: true, photos: await listProductPhotos(await getDb(), parsed.data.id) };
}

/** "Chạy hàng đợi ngay" — cho người trực khi bộ lập lịch chưa bật. */
export async function kickVideoQueueAction(): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền chạy hàng đợi video" };
  await drainAfterResponse();
  return { ok: true };
}

// ───────────────────────────── PR 2 — CONTENT + ĐĂNG REEL ─────────────────────────────
//
// Quyền: sửa / chốt content · đăng / hẹn · huỷ bài — `ideas:write` (biên tập, không tiêu tiền quảng cáo). Gán fanpage cho mã và
// bật TỰ ĐĂNG cho fanpage — `expenses:write` hoặc `settings:manage` (quyết định để máy đăng thay người). Dừng khẩn cấp: KÉO
// — `ideas:write` hoặc `expenses:write` (ai thấy sai cũng dừng được); NHẢ — `expenses:write` hoặc `settings:manage`.

async function captionFacts(variantId: string) {
  const db = await getDb();
  const [v] = await db.select({ productId: schema.videoScaleVariants.productId }).from(schema.videoScaleVariants).where(eq(schema.videoScaleVariants.id, variantId)).limit(1);
  if (!v) return null;
  const cfg = await readVideoScaleConfig(db);
  return loadProductFacts(db, v.productId, null, cfg.policyLines);
}

export async function saveVideoCaptionAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền sửa content" };
  const parsed = videoCaptionSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const facts = await captionFacts(parsed.data.variantId);
  if (!facts) return { error: "Không tìm thấy video" };
  const problems = finalCaptionProblems(parsed.data.caption, facts);
  if (problems.length) return { error: `Content chưa lưu được: ${problems.slice(0, 3).join("; ")}` };
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const V = schema.videoScaleVariants;
  const [before] = await db.select({ caption: V.caption, captionState: V.captionState }).from(V).where(eq(V.id, parsed.data.variantId)).limit(1);
  await db.update(V).set({ caption: parsed.data.caption.trim(), captionState: "READY", captionByUserId: actor.id, captionBy: actor.label, captionAt: new Date() }).where(eq(V.id, parsed.data.variantId));
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_CAPTION_SAVE", entity: "VIDEO_SCALE_VARIANT", entityId: parsed.data.variantId, before, after: { caption: parsed.data.caption.trim() } });
  revalidatePath(PATH);
  return { ok: true };
}

export async function regenerateVideoCaptionAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền viết content" };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu video" };
  const db = await getDb();
  const V = schema.videoScaleVariants;
  const [v] = await db.select({ id: V.id, runId: V.runId, status: V.status, isTest: V.isTest }).from(V).where(eq(V.id, parsed.data.id)).limit(1);
  if (!v || v.status !== "APPROVED") return { error: "Chỉ viết content cho video ĐÃ DUYỆT." };
  await enqueueJob(db, { kind: "CAPTION", key: `caption:${v.id}:${Date.now()}`, runId: v.runId, variantId: v.id, isTest: v.isTest, createdByUserId: user.id });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_CAPTION_REGENERATE", entity: "VIDEO_SCALE_VARIANT", entityId: v.id });
  await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true };
}

export async function publishVideoReelAction(raw: unknown): Promise<{ ok: true; postId: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền đăng Reel" };
  const parsed = videoPublishSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  let publishAt: Date | null = null;
  if (parsed.data.publishAt) {
    publishAt = new Date(parsed.data.publishAt);
    if (!Number.isFinite(publishAt.getTime())) return { error: "Giờ hẹn không hợp lệ." };
  }
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const r = await requestReelPost(db, { variantId: parsed.data.variantId, caption: parsed.data.caption, publishAt }, actor);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: publishAt ? "VIDEO_SCALE_REEL_SCHEDULE" : "VIDEO_SCALE_REEL_PUBLISH", entity: "VIDEO_SCALE_POST", entityId: r.postId, after: { variantId: parsed.data.variantId, publishAt: publishAt?.toISOString() ?? null, caption: parsed.data.caption } });
  await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true, postId: r.postId };
}

export async function cancelVideoPostAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền huỷ bài" };
  const parsed = videoIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu bài" };
  const r = await cancelReelPost(await getDb(), parsed.data.id);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_REEL_CANCEL", entity: "VIDEO_SCALE_POST", entityId: parsed.data.id });
  revalidatePath(PATH);
  return { ok: true };
}

export async function setVideoSkuPublishingAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write") && !can(user, "settings:manage")) return { error: "Gán fanpage cho mã là quyết định của quản lý (chi phí: sửa hoặc cấu hình hệ thống)." };
  const parsed = videoSkuPublishingSchema.safeParse(raw);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  if (d.pageId) {
    // Chỉ nhận fanpage ERP ĐÃ BIẾT (đồng bộ từ Pancake) — không nhận một mã gõ tay.
    const [f] = await db.select({ id: schema.fanpages.externalPageId }).from(schema.fanpages).where(eq(schema.fanpages.externalPageId, d.pageId)).limit(1);
    if (!f) return { error: "Fanpage này không có trong danh sách fanpage của ERP." };
  }
  const actor = await actorOf(user.id, user.email);
  const T = schema.videoScaleSkus;
  const [before] = await db.select({ pageId: T.pageId, publishMode: T.publishMode }).from(T).where(eq(T.productId, d.productId)).limit(1);
  const set = { pageId: d.pageId || null, publishMode: d.publishMode || null, updatedByUserId: actor.id, updatedBy: actor.label };
  await db.insert(T).values({ productId: d.productId, ...set }).onConflictDoUpdate({ target: T.productId, set: { ...set, updatedAt: new Date() } });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_SKU_PUBLISHING", entity: "VIDEO_SCALE_SKU", entityId: d.productId, before: before ?? null, after: set });
  revalidatePath(PATH);
  return { ok: true };
}

export async function setVideoPageConfigAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write") && !can(user, "settings:manage")) return { error: "Bật tự đăng cho fanpage là quyết định của quản lý (chi phí: sửa hoặc cấu hình hệ thống)." };
  const parsed = videoPageConfigSchema.safeParse(raw);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const T = schema.videoScalePages;
  const [before] = await db.select({ publishMode: T.publishMode, maxPostsPerDay: T.maxPostsPerDay }).from(T).where(eq(T.pageId, d.pageId)).limit(1);
  const set = { publishMode: d.publishMode, maxPostsPerDay: d.maxPostsPerDay, updatedByUserId: actor.id, updatedBy: actor.label };
  await db.insert(T).values({ pageId: d.pageId, ...set }).onConflictDoUpdate({ target: T.pageId, set: { ...set, updatedAt: new Date() } });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_PAGE_CONFIG", entity: "VIDEO_SCALE_PAGE", entityId: d.pageId, before: before ?? null, after: set });
  revalidatePath(PATH);
  return { ok: true };
}

/** DỪNG KHẨN CẤP cấp mã / fanpage / toàn module. Có hiệu lực ở lượt việc KẾ TIẾP (cổng đọc lại trước mỗi lượt). */
export async function setVideoPauseAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  const parsed = videoPauseSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (d.paused && !can(user, "ideas:write") && !can(user, "expenses:write")) return { error: "Bạn không có quyền dừng Video Scale" };
  if (!d.paused && !can(user, "expenses:write") && !can(user, "settings:manage")) return { error: "Mở lại tự động là quyết định của quản lý (chi phí: sửa hoặc cấu hình hệ thống)." };
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const now = new Date();
  let before: unknown = null;
  if (d.scope === "ALL") {
    before = await readVideoAutomation(db);
    const value = JSON.stringify({ paused: d.paused, reason: d.reason, by: actor.label, at: now.toISOString() });
    await db.insert(schema.settings).values({ key: VIDEO_AUTOMATION_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } });
  } else if (d.scope === "SKU") {
    const T = schema.videoScaleSkus;
    const set = { automationPausedAt: d.paused ? now : null, automationPausedReason: d.paused ? d.reason : "", updatedByUserId: actor.id, updatedBy: actor.label };
    await db.insert(T).values({ productId: d.id, ...set }).onConflictDoUpdate({ target: T.productId, set: { ...set, updatedAt: now } });
  } else {
    const T = schema.videoScalePages;
    const set = { pausedAt: d.paused ? now : null, pausedReason: d.paused ? d.reason : "", updatedByUserId: actor.id, updatedBy: actor.label };
    await db.insert(T).values({ pageId: d.id, ...set }).onConflictDoUpdate({ target: T.pageId, set: { ...set, updatedAt: now } });
  }
  // Dừng = tiền phải NGỪNG CHẢY: xếp việc TẮT mọi quảng cáo đang chạy trong phạm vi (tắt đi qua được công tắc khẩn cấp).
  const paused = d.paused ? await queuePauseAds(db, d.scope === "SKU" ? { productId: d.id } : d.scope === "PAGE" ? { pageId: d.id } : {}, `Dừng khẩn cấp (${d.scope}): ${d.reason}`) : 0;
  await audit({ userId: user.id, userEmail: user.email, action: d.paused ? "VIDEO_SCALE_PAUSE" : "VIDEO_SCALE_RESUME", entity: `VIDEO_SCALE_${d.scope}`, entityId: d.id || VIDEO_AUTOMATION_KEY, before, after: { paused: d.paused, adsQueuedToPause: paused }, reason: d.reason });
  if (paused) await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true };
}

// ───────────────────────────── PR 3 — QUẢNG CÁO META ─────────────────────────────
//
// Quyền: mọi việc làm TĂNG hoặc CAM KẾT tiền (gán tài khoản, chế độ, ngân sách, dựng, bật, đổi ngân sách) — `expenses:write`.
// TẮT một quảng cáo — `ideas:write` hoặc `expenses:write` (tắt chỉ làm giảm tiền, ai thấy sai cũng tắt được).

export async function setVideoSkuAdsAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Cấu hình quảng cáo của mã là quyết định chi tiền — cần quyền chi phí: sửa." };
  const parsed = videoSkuAdsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  if (d.adAccountId) {
    // Chỉ tài khoản ERP ĐÃ BIẾT (có chi tiêu đồng bộ) — không nhận một số gõ tay.
    const known = await listAdAccountOptions(db, new Date(), "");
    if (!known.some((a) => a.id === d.adAccountId)) return { error: "Tài khoản quảng cáo này chưa có trong dữ liệu chi tiêu ERP đã đồng bộ." };
  }
  const budget = d.dailyBudgetPerAdVnd === "" ? null : d.dailyBudgetPerAdVnd;
  const cap = d.skuDailyCapVnd === "" ? null : d.skuDailyCapVnd;
  if (d.adsMode === "AUTO_LAUNCH" && (!d.adAccountId || !budget || !cap)) return { error: "Tự bật quảng cáo cần ĐỦ tài khoản, ngân sách ngày mỗi quảng cáo và trần mã / ngày — máy không đoán ngân sách." };
  if (budget && cap && budget > cap) return { error: "Ngân sách mỗi quảng cáo không được lớn hơn trần của mã." };
  const actor = await actorOf(user.id, user.email);
  const T = schema.videoScaleSkus;
  const [before] = await db.select({ adAccountId: T.adAccountId, adsMode: T.adsMode, dailyBudgetPerAdVnd: T.dailyBudgetPerAdVnd, skuDailyCapVnd: T.skuDailyCapVnd, autoScale: T.autoScale, autoNextRound: T.autoNextRound }).from(T).where(eq(T.productId, d.productId)).limit(1);
  const set = {
    adAccountId: d.adAccountId || null,
    adsMode: d.adsMode,
    dailyBudgetPerAdVnd: budget,
    skuDailyCapVnd: cap,
    autoScale: d.autoScale,
    autoNextRound: d.autoNextRound,
    adsModeByUserId: actor.id,
    adsModeBy: actor.label,
    adsModeAt: new Date(),
    updatedByUserId: actor.id,
    updatedBy: actor.label,
  };
  await db.insert(T).values({ productId: d.productId, ...set }).onConflictDoUpdate({ target: T.productId, set: { ...set, updatedAt: new Date() } });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_SKU_ADS", entity: "VIDEO_SCALE_SKU", entityId: d.productId, before: before ?? null, after: set, reason: d.adsMode === "AUTO_LAUNCH" ? "Người bật TỰ BẬT QUẢNG CÁO trong phong bì tiền đã khai." : undefined });
  revalidatePath(PATH);
  return { ok: true };
}

export async function queueCreateVideoAdAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Dựng quảng cáo cần quyền chi phí: sửa." };
  const parsed = videoAdCreateSchema.safeParse(raw);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await queueCreateAd(db, parsed.data.adId, parsed.data.activate, await actorOf(user.id, user.email));
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: parsed.data.activate ? "VIDEO_SCALE_AD_CREATE_ACTIVATE" : "VIDEO_SCALE_AD_CREATE_PAUSED", entity: "VIDEO_SCALE_AD", entityId: parsed.data.adId });
  await drainAfterResponse();
  revalidatePath(PATH);
  return { ok: true };
}

export async function activateVideoAdAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Bật quảng cáo cần quyền chi phí: sửa." };
  const parsed = videoAdIdSchema.safeParse(raw);
  if (!parsed.success) return { error: "Thiếu quảng cáo" };
  const db = await getDb();
  const r = await activateVideoAd(db, parsed.data.adId, await actorOf(user.id, user.email), await readVideoScaleConfig(db));
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_AD_ACTIVATE", entity: "VIDEO_SCALE_AD", entityId: parsed.data.adId, after: r });
  revalidatePath(PATH);
  return r.ok ? { ok: true } : { error: r.error };
}

export async function pauseVideoAdAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write") && !can(user, "expenses:write")) return { error: "Bạn không có quyền tắt quảng cáo" };
  const parsed = videoAdPauseSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await pauseVideoAd(await getDb(), parsed.data.adId, await actorOf(user.id, user.email), parsed.data.reason);
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_AD_PAUSE", entity: "VIDEO_SCALE_AD", entityId: parsed.data.adId, after: r, reason: parsed.data.reason });
  revalidatePath(PATH);
  return r.ok ? { ok: true } : { error: r.error };
}

export async function setVideoAdBudgetAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Đổi ngân sách cần quyền chi phí: sửa." };
  const parsed = videoAdBudgetSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await setVideoAdBudget(db, parsed.data.adId, parsed.data.budgetVnd, await actorOf(user.id, user.email), await readVideoScaleConfig(db));
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_AD_BUDGET", entity: "VIDEO_SCALE_AD", entityId: parsed.data.adId, after: { budgetVnd: parsed.data.budgetVnd, result: r } });
  revalidatePath(PATH);
  return r.ok ? { ok: true } : { error: r.error };
}

/**
 * Chạy MỘT lượt vòng tối ưu ngay (số đo Meta, chấm, tắt quảng cáo thua, đề nghị / tự tăng trong trần, bài học). KHÔNG ghi
 * nhịp tim: nhịp tim chứng minh BỘ LẬP LỊCH còn sống, một cú bấm tay thì không.
 */
export async function runVideoOptimizeNowAction(): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write") && !can(user, "settings:manage")) return { error: "Chạy vòng tối ưu (có thể tắt / tăng quảng cáo) cần quyền chi phí: sửa." };
  const db = await getDb();
  const o = await runOptimize(db, await readVideoScaleConfig(db), { ...DEFAULT_OPTIMIZE_DEPS, createRun: createVideoRun });
  await audit({ userId: user.id, userEmail: user.email, action: "VIDEO_SCALE_OPTIMIZE_NOW", entity: "SETTINGS", entityId: "videoScale.optimizer", after: { ...o, errors: o.errors.slice(0, 5) } });
  revalidatePath(PATH);
  const detail = `Chấm ${o.judged} · tắt ${o.paused} · tăng ${o.scaled} · đề nghị ${o.recommended} · bài học ${o.lessons} · vòng mới ${o.runsCreated}${o.errors.length ? ` · ${o.errors.length} lỗi: ${o.errors[0]}` : ""}`;
  return { ok: true, detail };
}
