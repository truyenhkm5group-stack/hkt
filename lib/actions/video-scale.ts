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
import { videoConfigSchema, videoIdSchema, videoMusicUploadSchema, videoReviewSchema, videoRunCreateSchema, videoSkuModeSchema } from "@/lib/validation/video-scale";

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
  const next = normalizeVideoScaleConfig({ ...parsed.data, provider: before.provider, dailyUsdCap: parsed.data.dailyUsdCap === "" ? null : parsed.data.dailyUsdCap });
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
