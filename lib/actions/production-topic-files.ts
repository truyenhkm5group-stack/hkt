"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { TOPIC_FILE_CHUNK_BYTES } from "@/lib/constants/production-files";
import { finishTopicFileCore, putTopicFileChunkCore, removeTopicFileCore, startTopicFileCore } from "@/lib/production/topic-files";

/**
 * ═══════════ SERVER ACTION: ẢNH / VIDEO ĐÍNH KÈM TOPIC SẢN XUẤT ═══════════
 *
 * `requireUser` → `can("production:write")` → zod → lõi (`lib/production/topic-files.ts`) → `audit()` →
 * `revalidatePath`. Gửi khúc KHÔNG audit / không làm mới trang (mười mấy lượt cho một video) — chỉ lượt
 * HOÀN TẤT và lượt GỠ mới là sự việc người đọc cần thấy.
 */
type Result<T = object> = ({ ok: true } & T) | { error: string };

function actorOf(user: { id: string; name: string | null; email: string }): Actor {
  return { id: user.id, label: user.name || user.email };
}

async function nguoiGhi(): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { ok: false, error: "Không có quyền đính kèm tệp vào topic sản xuất" };
  return { ok: true, user };
}

const startSchema = z.object({
  topicId: z.string().min(1),
  fileName: z.string().max(500).default(""),
  contentType: z.string().trim().min(1, "Không rõ kiểu tệp").max(100),
  bytes: z.number().int().positive("Tệp rỗng"),
});

export async function startTopicFileUpload(input: unknown): Promise<Result<{ fileId: string; chunkCount: number; chunkBytes: number }>> {
  const g = await nguoiGhi();
  if (!g.ok) return { error: g.error };
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await startTopicFileCore(db, { ...parsed.data, actor: actorOf(g.user) });
  if ("error" in r) return r;
  return { ok: true, fileId: r.fileId, chunkCount: r.chunkCount, chunkBytes: r.chunkBytes };
}

/** `FormData`: `fileId`, `seq`, `chunk` (Blob ≤ 2 MB). */
export async function uploadTopicFileChunk(form: FormData): Promise<Result> {
  const g = await nguoiGhi();
  if (!g.ok) return { error: g.error };
  const fileId = String(form.get("fileId") ?? "");
  const seq = Number(form.get("seq"));
  const chunk = form.get("chunk");
  if (!fileId || !(chunk instanceof Blob)) return { error: "Thiếu khúc tệp" };
  if (chunk.size > TOPIC_FILE_CHUNK_BYTES) return { error: "Khúc tệp quá lớn" };
  const db = await getDb();
  return putTopicFileChunkCore(db, { fileId, seq, data: Buffer.from(await chunk.arrayBuffer()), actor: actorOf(g.user) });
}

export async function finishTopicFileUpload(fileId: string): Promise<Result> {
  const g = await nguoiGhi();
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const r = await finishTopicFileCore(db, { fileId, actor: actorOf(g.user) });
  if ("error" in r) return r;
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "PRODUCTION_TOPIC_FILE_ADD", entity: "PRODUCTION_TOPIC", entityId: r.topicId, after: { fileId, kind: r.kind, fileName: r.fileName, bytes: r.bytes } });
  revalidatePath(`/production/topics/${r.topicId}`);
  return { ok: true };
}

export async function removeTopicFile(fileId: string): Promise<Result> {
  const g = await nguoiGhi();
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const r = await removeTopicFileCore(db, { fileId, actor: actorOf(g.user) });
  if ("error" in r) return r;
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "PRODUCTION_TOPIC_FILE_REMOVE", entity: "PRODUCTION_TOPIC", entityId: r.topicId, before: { fileId, kind: r.kind, fileName: r.fileName, uploadedBy: r.uploadedBy } });
  revalidatePath(`/production/topics/${r.topicId}`);
  return { ok: true };
}
