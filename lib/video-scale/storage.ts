import { createHash } from "node:crypto";
import { and, asc, between, eq, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { VIDEO_ASSET_CHUNK_BYTES, VIDEO_SCALE_HARD_LIMITS, type VideoAssetKind } from "@/lib/constants/video-scale";

/**
 * ═══════════ TỆP CỦA VIDEO SCALE — TRONG CSDL, CHIA KHÚC ═══════════
 *
 * Cùng lối với tệp topic sản xuất (`production_topic_files`): máy chủ không có ổ lưu tệp riêng được sao lưu, nên tệp đi
 * vào CSDL và vào bản sao lưu hằng ngày. Khúc `bytea` 2 MB để phát video theo `Range` chỉ đọc đúng khúc cần, không nạp cả
 * tệp vào RAM của một VPS ~2 GB.
 *
 * Trần: một tệp ≤ `maxAssetBytes`; tổng ≤ `maxTotalAssetBytes` (đếm cả tệp đang ghi dở, trừ tệp đã xoá nội dung).
 * Vượt ⇒ NÉM, không ghi một byte nào — việc gọi tới đây hỏng ở trạng thái có câu lỗi, không lặng lẽ mất tệp.
 */

const a = schema.videoScaleAssets;
const c = schema.videoScaleAssetChunks;

export type StoreAssetInput = {
  kind: VideoAssetKind;
  bytes: Uint8Array;
  contentType: string;
  runId?: string | null;
  variantId?: string | null;
  isTest?: boolean;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
};

export type StoredAsset = { id: string; bytes: number; sha256: string };

export class AssetLimitError extends Error {}

/** Khúc thứ nhất và khúc cuối chứa khoảng byte `start…end`. Hàm THUẦN. */
export function assetChunkSpan(start: number, end: number): { first: number; last: number } {
  return { first: Math.floor(start / VIDEO_ASSET_CHUNK_BYTES), last: Math.floor(end / VIDEO_ASSET_CHUNK_BYTES) };
}

export async function totalAssetBytes(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${a.bytes}), 0)::bigint` })
    .from(a)
    .where(ne(a.status, "PURGED"));
  return Number(r?.n ?? 0);
}

/** Ghi một tệp: dòng `UPLOADING` → các khúc → `READY`, trong MỘT giao dịch (hỏng giữa chừng thì không còn gì). */
export async function storeAsset(db: Db, input: StoreAssetInput): Promise<StoredAsset> {
  const size = input.bytes.byteLength;
  if (size <= 0) throw new AssetLimitError("Tệp rỗng — không lưu.");
  if (size > VIDEO_SCALE_HARD_LIMITS.maxAssetBytes) {
    throw new AssetLimitError(`Tệp ${(size / 1048576).toFixed(1)} MB vượt trần một tệp ${VIDEO_SCALE_HARD_LIMITS.maxAssetBytes / 1048576} MB.`);
  }
  const used = await totalAssetBytes(db);
  if (used + size > VIDEO_SCALE_HARD_LIMITS.maxTotalAssetBytes) {
    throw new AssetLimitError(
      `Kho tệp Video Scale đã dùng ${(used / 1073741824).toFixed(2)} GB — thêm tệp này vượt trần ${VIDEO_SCALE_HARD_LIMITS.maxTotalAssetBytes / 1073741824} GB. Xoá video không dùng (biến thể bị loại) trước.`,
    );
  }
  const buf = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const chunkCount = Math.ceil(size / VIDEO_ASSET_CHUNK_BYTES);
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(a).values({
      id,
      kind: input.kind,
      runId: input.runId ?? null,
      variantId: input.variantId ?? null,
      contentType: input.contentType,
      bytes: size,
      sha256,
      durationMs: input.durationMs ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      chunkCount,
      status: "UPLOADING",
      isTest: input.isTest ?? false,
    });
    for (let seq = 0; seq < chunkCount; seq += 1) {
      const part = buf.subarray(seq * VIDEO_ASSET_CHUNK_BYTES, Math.min(size, (seq + 1) * VIDEO_ASSET_CHUNK_BYTES));
      await tx.insert(c).values({ assetId: id, seq, data: Buffer.from(part) });
    }
    await tx.update(a).set({ status: "READY", completedAt: new Date() }).where(eq(a.id, id));
  });
  return { id, bytes: size, sha256 };
}

export type AssetMeta = { id: string; kind: string; contentType: string; bytes: number; sha256: string; durationMs: number | null; width: number | null; height: number | null; runId: string | null; variantId: string | null; isTest: boolean };

export async function getAssetMeta(db: Db, id: string): Promise<AssetMeta | null> {
  const [row] = await db
    .select({ id: a.id, kind: a.kind, contentType: a.contentType, bytes: a.bytes, sha256: a.sha256, durationMs: a.durationMs, width: a.width, height: a.height, runId: a.runId, variantId: a.variantId, isTest: a.isTest })
    .from(a)
    .where(and(eq(a.id, id), eq(a.status, "READY")))
    .limit(1);
  return row ?? null;
}

/** Byte `start…end` (bao gồm hai đầu) — chỉ đọc các khúc chứa khoảng ấy. */
export async function readAssetRange(db: Db, id: string, start: number, end: number): Promise<Buffer> {
  const { first, last } = assetChunkSpan(start, end);
  const rows = await db
    .select({ seq: c.seq, data: c.data })
    .from(c)
    .where(and(eq(c.assetId, id), between(c.seq, first, last)))
    .orderBy(asc(c.seq));
  const all = Buffer.concat(rows.map((r) => r.data));
  const offset = start - first * VIDEO_ASSET_CHUNK_BYTES;
  return all.subarray(offset, offset + (end - start + 1));
}

/** Cả tệp — kiểm lại độ dài và sha256 (tệp hỏng không được đi tiếp sang hậu kỳ / đăng). */
export async function readAsset(db: Db, id: string): Promise<{ meta: AssetMeta; bytes: Buffer } | null> {
  const meta = await getAssetMeta(db, id);
  if (!meta) return null;
  const bytes = await readAssetRange(db, id, 0, meta.bytes - 1);
  if (bytes.length !== meta.bytes) throw new Error(`Tệp ${id} thiếu khúc: đọc ${bytes.length}/${meta.bytes} byte.`);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== meta.sha256) throw new Error(`Tệp ${id} sai tổng kiểm — nội dung trong CSDL không khớp lúc ghi.`);
  return { meta, bytes };
}

/** Xoá NỘI DUNG (giữ dòng để lịch sử còn tra được). */
export async function purgeAsset(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(c).where(eq(c.assetId, id));
    await tx.update(a).set({ status: "PURGED", purgedAt: new Date() }).where(eq(a.id, id));
  });
}
