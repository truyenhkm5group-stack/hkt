import { createHash } from "node:crypto";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { AD_VIDEO_UPLOAD, adVideoChunkBytes, checkAdVideo } from "@/lib/constants/ad-video";
import { VIDEO_SCALE_HARD_LIMITS } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { readAdVideoStatus, uploadAdVideoFromUrl } from "@/lib/integrations/facebook/ads-write";
import { signedAssetUrl } from "@/lib/video-scale/ad-spec";

/**
 * ═══════════ LÕI: VIDEO TỰ TẢI LÊN CHO "ĐĂNG CAMP" ═══════════
 *
 * KHÔNG "use server": server action (`lib/actions/creative-manual.ts`) và kiểm thử cùng gọi vào đây.
 *
 * Tải lên theo BA bước (cùng lối tệp topic sản xuất) vì một video 60 MB không đi được trong một Server Action (trần 8 MB):
 *   1. `startAdVideoUpload`  — kiểm kiểu + cỡ + trần tổng của kho, tạo dòng `UPLOADING`, trả số khúc.
 *   2. `putAdVideoChunk`     — từng khúc 2 MB; gửi lại cùng khúc GHI ĐÈ (khoá UNIQUE (asset_id, seq)).
 *   3. `finishAdVideoUpload` — ĐỦ khúc, ĐÚNG tổng byte ⇒ băm sha256 (đọc từng khúc, không nạp cả tệp) ⇒ `READY`.
 * Chỉ NGƯỜI đã xin chỗ mới gửi khúc / hoàn tất / gắn video vào mẫu được (mục 34: khoá tài khoản, không phải tên).
 *
 * Lên Facebook (`ensureAdVideo`): video tải vào thư viện của TKQC bằng LINK KÝ TÊN sống ≤ 2 giờ (cùng đường Video Scale),
 * nhớ id theo TKQC ở `creative_manual_gen_images.fb_videos` — bấm lại không tải lại, đăng sang TKQC khác thì tải thêm một lần.
 */
const A = schema.videoScaleAssets;
const C = schema.videoScaleAssetChunks;
const G = schema.creativeManualGenImages;

type Fail = { ok: false; error: string };

export async function startAdVideoUpload(
  db: Db,
  input: { contentType: string; bytes: number; durationMs: number | null; width: number | null; height: number | null; userId: string; now: Date },
): Promise<{ ok: true; assetId: string; chunkCount: number; chunkBytes: number } | Fail> {
  const kiem = checkAdVideo(input);
  if (!kiem.ok) return kiem;
  // Dọn lượt tải dở đã bỏ — chúng không hiện ở đâu nên không ai khác dọn; khúc đi theo (cascade).
  await db.delete(A).where(and(eq(A.kind, "AD_UPLOAD"), eq(A.status, "UPLOADING"), lt(A.createdAt, new Date(input.now.getTime() - AD_VIDEO_UPLOAD.staleHours * 3_600_000))));
  const [tong] = await db
    .select({ n: sql<string>`coalesce(sum(${A.bytes}), 0)::bigint` })
    .from(A)
    .where(ne(A.status, "PURGED"));
  const used = Number(tong?.n ?? 0);
  if (used + input.bytes > VIDEO_SCALE_HARD_LIMITS.maxTotalAssetBytes) {
    return { ok: false, error: `Kho video đã dùng ${(used / 1073741824).toFixed(2)} GB — thêm video này vượt trần ${VIDEO_SCALE_HARD_LIMITS.maxTotalAssetBytes / 1073741824} GB. Xoá video không dùng ở Video Scale trước.` };
  }
  const dim = (x: number | null) => (x !== null && Number.isInteger(x) && x > 0 ? x : null);
  const [row] = await db
    .insert(A)
    .values({
      kind: "AD_UPLOAD",
      contentType: input.contentType.toLowerCase(),
      bytes: input.bytes,
      sha256: "",
      durationMs: dim(input.durationMs),
      width: dim(input.width),
      height: dim(input.height),
      chunkCount: kiem.chunkCount,
      status: "UPLOADING",
      uploadedByUserId: input.userId,
    })
    .returning({ id: A.id });
  return { ok: true, assetId: row.id, chunkCount: kiem.chunkCount, chunkBytes: AD_VIDEO_UPLOAD.chunkBytes };
}

type UploadRow = { id: string; status: string; bytes: number; chunkCount: number };

async function ownUpload(db: Db, assetId: string, userId: string): Promise<{ ok: true; row: UploadRow } | Fail> {
  const [row] = await db
    .select({ id: A.id, status: A.status, bytes: A.bytes, chunkCount: A.chunkCount, kind: A.kind, uploadedByUserId: A.uploadedByUserId })
    .from(A)
    .where(eq(A.id, assetId))
    .limit(1);
  if (!row || row.kind !== "AD_UPLOAD") return { ok: false, error: "Không tìm thấy lượt tải video (có thể đã quá hạn và bị dọn) — chọn tệp lại." };
  if (row.uploadedByUserId !== userId) return { ok: false, error: "Lượt tải video này của người khác." };
  return { ok: true, row };
}

export async function putAdVideoChunk(db: Db, input: { assetId: string; seq: number; data: Buffer; userId: string }): Promise<{ ok: true } | Fail> {
  const r = await ownUpload(db, input.assetId, input.userId);
  if (!r.ok) return r;
  const { row } = r;
  if (row.status !== "UPLOADING") return { ok: false, error: "Video đã tải xong — không nhận thêm khúc." };
  if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq >= row.chunkCount) return { ok: false, error: `Khúc ${input.seq} ngoài phạm vi 0…${row.chunkCount - 1}.` };
  const can = adVideoChunkBytes(row.bytes, row.chunkCount, input.seq);
  if (input.data.length !== can) return { ok: false, error: `Khúc ${input.seq} dài ${input.data.length} byte, phải là ${can}.` };
  await db
    .insert(C)
    .values({ assetId: row.id, seq: input.seq, data: input.data })
    .onConflictDoUpdate({ target: [C.assetId, C.seq], set: { data: input.data } });
  return { ok: true };
}

export async function finishAdVideoUpload(db: Db, input: { assetId: string; userId: string; now: Date }): Promise<{ ok: true; assetId: string; bytes: number; sha256: string } | Fail> {
  const r = await ownUpload(db, input.assetId, input.userId);
  if (!r.ok) return r;
  const { row } = r;
  if (row.status === "READY") {
    const [m] = await db.select({ sha256: A.sha256 }).from(A).where(eq(A.id, row.id)).limit(1);
    return { ok: true, assetId: row.id, bytes: row.bytes, sha256: m?.sha256 ?? "" };
  }
  if (row.status !== "UPLOADING") return { ok: false, error: "Video không còn nội dung — chọn tệp lại." };
  const [tong] = await db
    .select({ n: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(octet_length(${C.data})), 0)::bigint` })
    .from(C)
    .where(eq(C.assetId, row.id));
  const n = Number(tong?.n ?? 0);
  const bytes = Number(tong?.bytes ?? 0);
  if (n !== row.chunkCount) return { ok: false, error: `Mới nhận ${n}/${row.chunkCount} khúc — tải lại video.` };
  if (bytes !== row.bytes) return { ok: false, error: `Tổng ${bytes} byte khác cỡ khai ${row.bytes} — tải lại video.` };
  // Băm từng khúc theo thứ tự — không nạp cả 60 MB vào RAM của VPS.
  const h = createHash("sha256");
  for (let seq = 0; seq < row.chunkCount; seq += 1) {
    const [k] = await db
      .select({ data: C.data })
      .from(C)
      .where(and(eq(C.assetId, row.id), eq(C.seq, seq)))
      .limit(1);
    if (!k) return { ok: false, error: `Thiếu khúc ${seq} — tải lại video.` };
    h.update(k.data);
  }
  const sha256 = h.digest("hex");
  await db
    .update(A)
    .set({ status: "READY", sha256, completedAt: input.now })
    .where(and(eq(A.id, row.id), eq(A.status, "UPLOADING")));
  return { ok: true, assetId: row.id, bytes: row.bytes, sha256 };
}

/** Video người này vừa tải xong, chưa gắn vào mẫu nào — điều kiện để gắn vào một mẫu tự làm. */
export async function attachableAdVideo(db: Db, assetId: string, userId: string): Promise<{ ok: true } | Fail> {
  const [row] = await db
    .select({ kind: A.kind, status: A.status, uploadedByUserId: A.uploadedByUserId })
    .from(A)
    .where(eq(A.id, assetId))
    .limit(1);
  if (!row || row.kind !== "AD_UPLOAD" || row.uploadedByUserId !== userId) return { ok: false, error: "Không tìm thấy video vừa tải — chọn tệp lại." };
  if (row.status !== "READY") return { ok: false, error: "Video chưa tải xong." };
  const [used] = await db.select({ id: G.id }).from(G).where(eq(G.videoAssetId, assetId)).limit(1);
  if (used) return { ok: false, error: "Video này đã gắn vào một mẫu khác." };
  return { ok: true };
}

/**
 * LINK KÝ TÊN có được mở cho tệp `AD_UPLOAD` này không: chỉ khi nó là video của một mẫu ĐÃ DUYỆT (người tải lên chính là
 * người chọn nó) hoặc đã đăng. Tệp tải dở / chưa gắn mẫu / mẫu bị gạt ⇒ không.
 */
export async function adUploadPublishable(db: Db, assetId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: G.id })
    .from(G)
    .where(and(eq(G.videoAssetId, assetId), inArray(G.status, ["APPROVED", "PROMOTED"])))
    .limit(1);
  return Boolean(row);
}

export type AdVideoApi = {
  upload: (accountId: string, input: { fileUrl: string; name: string }) => Promise<string>;
  status: (videoId: string) => Promise<{ status: string; error: string | null }>;
  signUrl: (assetId: string, now: Date) => string;
  sleep: (ms: number) => Promise<void>;
};

export const REAL_AD_VIDEO_API: AdVideoApi = {
  upload: uploadAdVideoFromUrl,
  status: readAdVideoStatus,
  signUrl: (assetId, now) => signedAssetUrl(env.appUrl, env.authSecret, assetId, now),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
};

export type EnsureAdVideoResult = { ok: true; videoId: string } | { ok: false; pending: boolean; error: string };

/**
 * Video của MẪU `rowId` đã nằm trong thư viện TKQC `account` và Facebook đã xử lý xong chưa — chưa có thì tải lên (một lần
 * cho mỗi TKQC, id nhớ ở `fb_videos`), rồi chờ tối đa `waitTries × waitMs`. `pending` = Facebook còn đang xử lý: bấm lại
 * sau ít phút, KHÔNG tải lại. Lỗi xử lý của Facebook ⇒ xoá id đã nhớ để lượt sau tải lại bản mới.
 */
export async function ensureAdVideo(db: Db, input: { rowId: string; account: string; name: string; now: Date }, api: AdVideoApi = REAL_AD_VIDEO_API): Promise<EnsureAdVideoResult> {
  const [row] = await db.select({ videoAssetId: G.videoAssetId, fbVideos: G.fbVideos }).from(G).where(eq(G.id, input.rowId)).limit(1);
  if (!row?.videoAssetId) return { ok: false, pending: false, error: "Mẫu không có video." };
  const account = input.account.replace(/^act_/, "");
  const map = { ...(row.fbVideos ?? {}) };
  let videoId = map[account] ?? "";
  if (!videoId) {
    try {
      videoId = await api.upload(account, { fileUrl: api.signUrl(row.videoAssetId, input.now), name: input.name.slice(0, 200) });
    } catch (e) {
      return { ok: false, pending: false, error: `Không tải được video lên TKQC ${account}: ${e instanceof Error ? e.message : String(e)}` };
    }
    await db
      .update(G)
      .set({ fbVideos: sql`coalesce(${G.fbVideos}, '{}'::jsonb) || ${JSON.stringify({ [account]: videoId })}::jsonb`, updatedAt: input.now })
      .where(eq(G.id, input.rowId));
  }
  for (let i = 0; i < AD_VIDEO_UPLOAD.waitTries; i += 1) {
    let st: { status: string; error: string | null };
    try {
      st = await api.status(videoId);
    } catch (e) {
      return { ok: false, pending: true, error: `Chưa đọc được trạng thái video ${videoId} trên Facebook: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (st.error) {
      await db
        .update(G)
        .set({ fbVideos: sql`coalesce(${G.fbVideos}, '{}'::jsonb) - ${account}::text`, updatedAt: input.now })
        .where(eq(G.id, input.rowId));
      return { ok: false, pending: false, error: `Facebook không xử lý được video: ${st.error} Bấm lại để tải bản mới.` };
    }
    if (st.status === "ready") return { ok: true, videoId };
    if (i < AD_VIDEO_UPLOAD.waitTries - 1) await api.sleep(AD_VIDEO_UPLOAD.waitMs);
  }
  return { ok: false, pending: true, error: `Video đã lên TKQC ${account}, Facebook đang xử lý — bấm "Đăng camp" lại sau 1–2 phút (video không tải lại, chưa có camp nào được tạo).` };
}

/** Băm của video — phiếu duyệt khoá nó như khoá băm ảnh. `""` = không đọc được (tệp đã xoá). */
export async function adVideoSha(db: Db, assetId: string): Promise<string> {
  const [m] = await db.select({ sha256: A.sha256 }).from(A).where(and(eq(A.id, assetId), eq(A.status, "READY"))).limit(1);
  return m?.sha256 ?? "";
}
