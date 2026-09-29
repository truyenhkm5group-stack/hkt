"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { attachableAdVideo, finishAdVideoUpload, putAdVideoChunk, startAdVideoUpload } from "@/lib/creative/ad-video";
import { AD_VIDEO_UPLOAD } from "@/lib/constants/ad-video";
import { addUploadedDraft, writeCopyOptions } from "@/lib/creative/manual-gen";
import { priceWarnings } from "@/lib/creative/copy-edit";
import { loadProductBrief } from "@/lib/queries/creative-plan";
import { adVideoStartSchema, manualCreativeInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — TẢI MẪU TỰ LÀM VÀO LÔ ═══════════
 *
 * Mọi luật nằm ở `lib/creative/manual.ts` (đường ghi duy nhất). Tệp này chỉ: kiểm quyền → lược đồ →
 * đọc tên người thao tác từ MÁY CHỦ (AGENTS.md mục 34) → gọi đường ghi → nhật ký.
 *
 * Quyền `ideas:write` — cùng quyền tải ảnh nguồn. Tải mẫu KHÔNG phải đăng: từ 26/09/2026 (chủ shop bỏ lô hằng ngày)
 * mẫu tự làm vào THẲNG hàng đợi đăng camp (`addUploadedDraft`); đăng vẫn cần bấm Đăng camp (thêm `expenses:write`).
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

export async function addManualCreative(input: unknown): Promise<Result<{ imageId: string; warnings: string[]; aiError: string | null }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền tải mẫu vào vòng mẫu" };
  const parsed = manualCreativeInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const product = await loadProductBrief(db, d.productId);
  if (!product) return { error: "Không tìm thấy mã hàng đã chọn — tải lại trang rồi chọn lại." };

  const who = await db.query.users.findFirst({ where: eq(schema.users.id, user.id), columns: { name: true, email: true } });
  const name = who?.name?.trim() || who?.email || user.email;
  // Mẫu VIDEO: chỉ gắn được video CHÍNH người này vừa tải xong và chưa gắn vào mẫu nào (mục 34).
  if (d.videoAssetId) {
    const ok = await attachableAdVideo(db, d.videoAssetId, user.id);
    if (!ok.ok) return { error: ok.error };
  }

  const r = await addUploadedDraft(
    db,
    { productId: d.productId, genes: d.genes, primaryText: d.primaryText, headline: d.headline, note: d.note, imageBytes: new Uint8Array(Buffer.from(d.imageBase64, "base64")), videoAssetId: d.videoAssetId ?? null },
    { id: user.id, name },
    new Date(),
  );
  if (!r.ok) return { error: r.error };

  // AI viết content theo ảnh (không ghi giá) — hỏng thì mẫu VẪN vào hàng đợi, người gõ tay trong hộp soạn bài.
  let aiError: string | null = null;
  if (d.aiWrite) {
    const w = await writeCopyOptions(db, r.imageId, { formulas: d.aiFormulas, noPrice: true, persistFirst: true }, new Date());
    if (!w.ok) aiError = w.error;
  }

  // Giá trong câu chữ khác giá ERP: KHÔNG chặn (người viết có thể đang chạy giá khuyến mãi) nhưng
  // phải nói ra — câu chữ máy viết thì bị ép đúng giá, câu chữ người viết thì người tự chịu.
  const warnings = priceWarnings(`${d.headline}\n${d.primaryText}`, product.priceVnd);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_ADD",
    entity: "CREATIVE_MANUAL_GEN_IMAGE",
    entityId: r.imageId,
    after: { genId: r.genId, productId: d.productId, genes: d.genes, queued: true, warnings, aiWrite: d.aiWrite, aiFormulas: d.aiFormulas, aiError, videoAssetId: d.videoAssetId ?? null },
  });
  revalidatePath("/marketing/creatives");
  return { ok: true, imageId: r.imageId, warnings, aiError };
}

// ───────────────────────────── VIDEO MẪU TỰ LÀM — TẢI THEO KHÚC ─────────────────────────────
// Ba bước vì một video tới 60 MB không đi được trong một Server Action (trần 8 MB). Gửi khúc KHÔNG audit (hàng chục lượt cho
// một video) — lượt tạo mẫu (`addManualCreative`) mới là sự việc người đọc cần thấy, và nó ghi `videoAssetId`.

export async function startAdVideoUploadAction(input: unknown): Promise<Result<{ assetId: string; chunkCount: number; chunkBytes: number }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền tải mẫu vào vòng mẫu" };
  const parsed = adVideoStartSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await startAdVideoUpload(await getDb(), { ...parsed.data, userId: user.id, now: new Date() });
  return r.ok ? { ok: true, assetId: r.assetId, chunkCount: r.chunkCount, chunkBytes: r.chunkBytes } : { error: r.error };
}

/** `FormData`: `assetId`, `seq`, `chunk` (Blob ≤ 2 MB). */
export async function uploadAdVideoChunkAction(form: FormData): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền tải mẫu vào vòng mẫu" };
  const assetId = String(form.get("assetId") ?? "");
  const seq = Number(form.get("seq"));
  const chunk = form.get("chunk");
  if (!assetId || !(chunk instanceof Blob)) return { error: "Thiếu khúc video" };
  if (chunk.size > AD_VIDEO_UPLOAD.chunkBytes) return { error: "Khúc video quá lớn" };
  const r = await putAdVideoChunk(await getDb(), { assetId, seq, data: Buffer.from(await chunk.arrayBuffer()), userId: user.id });
  return r.ok ? { ok: true } : { error: r.error };
}

export async function finishAdVideoUploadAction(assetId: unknown): Promise<Result<{ assetId: string }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền tải mẫu vào vòng mẫu" };
  if (typeof assetId !== "string" || !assetId) return { error: "Thiếu mã video" };
  const r = await finishAdVideoUpload(await getDb(), { assetId, userId: user.id, now: new Date() });
  return r.ok ? { ok: true, assetId: r.assetId } : { error: r.error };
}
