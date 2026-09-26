import { and, eq, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { checkTopicFileUpload, TOPIC_FILE_CHUNK_BYTES, TOPIC_FILE_STALE_UPLOAD_HOURS, type TopicFileKind } from "@/lib/constants/production-files";

/**
 * ═══════════ LÕI DỊCH VỤ: ẢNH / VIDEO ĐÍNH KÈM TOPIC SẢN XUẤT ═══════════
 *
 * KHÔNG "use server": server action (`lib/actions/production-topic-files.ts`) và kiểm thử cùng gọi vào đây.
 *
 * Tải lên theo BA bước vì một video 50 MB không đi được trong một Server Action (trần 8 MB):
 *   1. `startTopicFileCore`  — xin chỗ: kiểm kiểu + cỡ, tạo dòng `UPLOADING`, trả số khúc.
 *   2. `putTopicFileChunkCore` — gửi từng khúc ≤ 2 MB. Gửi lại cùng khúc (mạng chập chờn) GHI ĐÈ khúc
 *      ấy, không đẻ khúc thứ hai (khoá UNIQUE (file_id, seq)).
 *   3. `finishTopicFileCore` — kiểm ĐỦ khúc và ĐÚNG tổng số byte rồi mới `READY`. Tệp thiếu một khúc mà
 *      hiện ra thì video phát tới giữa chừng là đứng — người xem tưởng xưởng gửi video hỏng.
 *
 * Chỉ NGƯỜI đã xin chỗ mới gửi khúc / hoàn tất được lượt tải ấy (mục 34: khoá tài khoản, không phải tên).
 */
const f = schema.productionTopicFiles;
const c = schema.productionTopicFileChunks;

function humanError(actor: Actor): string | null {
  return actor.id ? null : "Tải tệp lên topic phải mang khoá tài khoản ERP (AGENTS.md mục 34)";
}

/** Tên tệp chỉ để người đọc — cắt độ dài và bỏ ký tự điều khiển / đường dẫn. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 160);
}

export async function startTopicFileCore(
  db: Db,
  input: { topicId: string; fileName: string; contentType: string; bytes: number; actor: Actor; now?: Date },
): Promise<{ ok: true; fileId: string; kind: TopicFileKind; chunkCount: number; chunkBytes: number } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const now = input.now ?? new Date();
  const [t] = await db.select({ id: schema.productionTopics.id }).from(schema.productionTopics).where(eq(schema.productionTopics.id, input.topicId)).limit(1);
  if (!t) return { error: "Không tìm thấy topic" };

  // Dọn lượt tải dở đã bỏ (đóng tab giữa chừng) — chúng không hiện ở đâu nên không ai khác dọn. Khúc đi theo (cascade).
  await db.delete(f).where(and(eq(f.status, "UPLOADING"), lt(f.createdAt, new Date(now.getTime() - TOPIC_FILE_STALE_UPLOAD_HOURS * 3_600_000))));

  const [dem] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(f)
    .where(and(eq(f.topicId, t.id), eq(f.status, "READY")));
  const kiem = checkTopicFileUpload({ contentType: input.contentType, bytes: input.bytes, readyCount: Number(dem?.n ?? 0) });
  if (!kiem.ok) return { error: kiem.error };

  const [row] = await db
    .insert(f)
    .values({
      topicId: t.id,
      kind: kiem.kind,
      fileName: cleanFileName(input.fileName),
      contentType: input.contentType.toLowerCase(),
      bytes: input.bytes,
      chunkCount: kiem.chunkCount,
      status: "UPLOADING",
      uploadedByUserId: input.actor.id,
      uploadedBy: input.actor.label,
    })
    .returning({ id: f.id });
  return { ok: true, fileId: row.id, kind: kiem.kind, chunkCount: kiem.chunkCount, chunkBytes: TOPIC_FILE_CHUNK_BYTES };
}

/** Cỡ ĐÚNG của khúc `seq` — mọi khúc đủ 2 MB trừ khúc cuối. */
export function expectedChunkBytes(fileBytes: number, chunkCount: number, seq: number): number {
  return seq < chunkCount - 1 ? TOPIC_FILE_CHUNK_BYTES : fileBytes - TOPIC_FILE_CHUNK_BYTES * (chunkCount - 1);
}

type UploadRow = { id: string; topicId: string; status: string; bytes: number; chunkCount: number; uploadedByUserId: string | null; kind: string; fileName: string };

async function ownUpload(db: Db, fileId: string, actor: Actor): Promise<{ ok: true; row: UploadRow } | { ok: false; error: string }> {
  const [row] = await db
    .select({ id: f.id, topicId: f.topicId, status: f.status, bytes: f.bytes, chunkCount: f.chunkCount, uploadedByUserId: f.uploadedByUserId, kind: f.kind, fileName: f.fileName })
    .from(f)
    .where(eq(f.id, fileId))
    .limit(1);
  if (!row) return { ok: false, error: "Không tìm thấy lượt tải lên (có thể đã quá hạn và bị dọn) — chọn tệp lại" };
  if (row.uploadedByUserId !== actor.id) return { ok: false, error: "Lượt tải này của người khác" };
  return { ok: true, row };
}

export async function putTopicFileChunkCore(db: Db, input: { fileId: string; seq: number; data: Buffer; actor: Actor }): Promise<{ ok: true } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const r = await ownUpload(db, input.fileId, input.actor);
  if (!r.ok) return { error: r.error };
  const { row } = r;
  if (row.status !== "UPLOADING") return { error: "Tệp đã tải xong — không nhận thêm khúc" };
  if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq >= row.chunkCount) return { error: `Khúc ${input.seq} ngoài phạm vi 0…${row.chunkCount - 1}` };
  const can = expectedChunkBytes(row.bytes, row.chunkCount, input.seq);
  if (input.data.length !== can) return { error: `Khúc ${input.seq} dài ${input.data.length} byte, phải là ${can}` };
  await db
    .insert(c)
    .values({ fileId: row.id, seq: input.seq, data: input.data })
    .onConflictDoUpdate({ target: [c.fileId, c.seq], set: { data: input.data } });
  return { ok: true };
}

export async function finishTopicFileCore(db: Db, input: { fileId: string; actor: Actor; now?: Date }): Promise<{ ok: true; topicId: string; kind: TopicFileKind; fileName: string; bytes: number } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const r = await ownUpload(db, input.fileId, input.actor);
  if (!r.ok) return { error: r.error };
  const { row } = r;
  const ketQua = { ok: true as const, topicId: row.topicId, kind: row.kind as TopicFileKind, fileName: row.fileName, bytes: row.bytes };
  if (row.status === "READY") return ketQua;
  const [tong] = await db
    .select({ n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(octet_length(${c.data})), 0)::bigint` })
    .from(c)
    .where(eq(c.fileId, row.id));
  const n = Number(tong?.n ?? 0);
  const bytes = Number(tong?.bytes ?? 0);
  if (n !== row.chunkCount) return { error: `Mới nhận ${n}/${row.chunkCount} khúc — tải lại tệp` };
  if (bytes !== row.bytes) return { error: `Tổng ${bytes} byte khác cỡ khai ${row.bytes} — tải lại tệp` };
  await db
    .update(f)
    .set({ status: "READY", completedAt: input.now ?? new Date() })
    .where(and(eq(f.id, row.id), eq(f.status, "UPLOADING")));
  return ketQua;
}

/** Gỡ một tệp đã tải (khúc đi theo). Trả thông tin cho audit — ai gỡ gì của ai. */
export async function removeTopicFileCore(db: Db, input: { fileId: string; actor: Actor }): Promise<{ ok: true; topicId: string; fileName: string; kind: string; uploadedBy: string } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const [row] = await db.select({ id: f.id, topicId: f.topicId, fileName: f.fileName, kind: f.kind, uploadedBy: f.uploadedBy }).from(f).where(eq(f.id, input.fileId)).limit(1);
  if (!row) return { error: "Tệp không còn — có thể người khác vừa gỡ" };
  await db.delete(f).where(eq(f.id, row.id));
  return { ok: true, topicId: row.topicId, fileName: row.fileName, kind: row.kind, uploadedBy: row.uploadedBy };
}
