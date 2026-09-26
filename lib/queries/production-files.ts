import { and, asc, between, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { chunkSpan, TOPIC_FILE_CHUNK_BYTES, type TopicFileKind } from "@/lib/constants/production-files";

/**
 * ═══════════ ĐỌC: ẢNH / VIDEO ĐÍNH KÈM TOPIC SẢN XUẤT ═══════════
 *
 * Chỉ tệp `READY` hiện ra — lượt tải dở không phải một tệp. Nội dung đọc theo KHÚC: phát video theo
 * `Range` chỉ lấy đúng khúc chứa khoảng byte được xin.
 */
const f = schema.productionTopicFiles;
const c = schema.productionTopicFileChunks;

export type TopicFileItem = { id: string; kind: TopicFileKind; fileName: string; contentType: string; bytes: number; uploadedBy: string; uploadedByUserId: string | null; createdAt: Date };

export async function listTopicFiles(topicId: string): Promise<TopicFileItem[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: f.id, kind: f.kind, fileName: f.fileName, contentType: f.contentType, bytes: f.bytes, uploadedBy: f.uploadedBy, uploadedByUserId: f.uploadedByUserId, createdAt: f.createdAt })
    .from(f)
    .where(and(eq(f.topicId, topicId), eq(f.status, "READY")))
    .orderBy(desc(f.createdAt), asc(f.id));
  return rows.map((r) => ({ ...r, kind: r.kind as TopicFileKind }));
}

export async function getTopicFileMeta(fileId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: f.id, topicId: f.topicId, kind: f.kind, fileName: f.fileName, contentType: f.contentType, bytes: f.bytes, chunkCount: f.chunkCount })
    .from(f)
    .where(and(eq(f.id, fileId), eq(f.status, "READY")))
    .limit(1);
  return row ?? null;
}

/** Byte `start`…`end` (bao gồm hai đầu) của một tệp — chỉ đọc các khúc chứa khoảng ấy. */
export async function readTopicFileRange(fileId: string, start: number, end: number): Promise<Buffer> {
  const db = await getDb();
  const { first, last } = chunkSpan(start, end);
  const rows = await db
    .select({ seq: c.seq, data: c.data })
    .from(c)
    .where(and(eq(c.fileId, fileId), between(c.seq, first, last)))
    .orderBy(asc(c.seq));
  const all = Buffer.concat(rows.map((r) => r.data));
  const offset = start - first * TOPIC_FILE_CHUNK_BYTES;
  return all.subarray(offset, offset + (end - start + 1));
}
