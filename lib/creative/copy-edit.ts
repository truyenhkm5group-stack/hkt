import { and, eq, gt, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { parsePartialGenes } from "@/lib/constants/creative-loop";
import { CAPTION_FALLBACK_PREFIX, captionFromImage, type CaptionOption, type VariantCaptioner } from "@/lib/creative/caption";
import { readCreativeImage } from "@/lib/creative/images";
import { wrongPrices } from "@/lib/creative/writer";
import { formatVND } from "@/lib/format";
import { loadProductBrief, loadWinningExamples } from "@/lib/queries/creative-plan";
import type { VariantCopyInput } from "@/lib/validation/creative";

/**
 * ═══════════ SOẠN / SỬA CÂU CHỮ CỦA MỘT MẪU TRƯỚC KHI DUYỆT ═══════════
 *
 * Đường ghi DUY NHẤT của việc sửa câu chữ. Server action (`lib/actions/creative-copy.ts`) chỉ kiểm
 * quyền + lược đồ + ghi nhật ký rồi gọi vào đây, để bài kiểm chạy được luật mà không cần phiên đăng nhập.
 *
 * ─── SỬA ĐƯỢC KHI NÀO ───
 *
 * Mẫu `GENERATED` (máy sinh hoặc tự làm) của lô CHƯA DUYỆT (`PLANNED` / `PENDING_APPROVAL`) và CÒN
 * HẠN duyệt. Điều kiện ấy nằm TRONG câu `UPDATE` (lô con lọc theo trạng thái + hạn), không chỉ ở bước
 * đọc trước: lô được duyệt giữa lúc đọc và lúc ghi thì câu ghi không khớp dòng nào.
 *
 * ─── SỬA CÂU CHỮ ⇒ PHIẾU DUYỆT CŨ VÔ HIỆU — ĐÚNG Ý ĐỒ ───
 *
 * Câu chữ nằm trong `approvalDigest` (`lib/creative/approval.ts`). Người A mở hộp duyệt, người B sửa
 * một chữ, người A bấm duyệt ⇒ digest đã đổi ⇒ phiếu của A bị từ chối và A phải mở lại để thấy đúng
 * câu sẽ đăng. Nếu một ngày ai đó nới điều kiện cho sửa SAU khi duyệt, lượt đăng vẫn tính lại digest
 * và dừng ở `APPROVAL_MISMATCH` — hai lớp chặn độc lập.
 *
 * ─── GIÁ KHÁC GIÁ ERP: CẢNH BÁO, KHÔNG CHẶN ───
 *
 * Cùng luật với mẫu tự làm: câu chữ máy viết bị ÉP đúng giá, câu chữ người viết thì người tự chịu
 * (có thể đang chạy giá khuyến mãi) — nhưng phải được nói ra trước khi duyệt.
 */

export const COPY_EDITABLE_BATCH_STATUSES = ["PLANNED", "PENDING_APPROVAL"] as const;

/** Lý do KHÔNG sửa được câu chữ lúc này; `null` = sửa được. Hàm thuần. */
export function copyEditBlocker(x: { batchStatus: string; approvalDeadline: Date; variantStatus: string }, now: Date): string | null {
  if (!(COPY_EDITABLE_BATCH_STATUSES as readonly string[]).includes(x.batchStatus)) return `Lô đang ở trạng thái ${x.batchStatus} — chỉ sửa được câu chữ khi lô chưa duyệt.`;
  if (now.getTime() >= x.approvalDeadline.getTime()) return "Lô đã quá hạn duyệt — không sửa câu chữ được nữa.";
  if (x.variantStatus !== "GENERATED") return `Mẫu đang ở trạng thái ${x.variantStatus} — chỉ sửa được câu chữ của mẫu đã có ảnh, chưa bị gạt.`;
  return null;
}

/** Cảnh báo giá trên câu chữ NGƯỜI viết. Dùng chung cho mẫu tự làm và sửa câu chữ. */
export function priceWarnings(text: string, priceVnd: number | null): string[] {
  if (wrongPrices(text, priceVnd).length === 0) return [];
  return [
    priceVnd === null
      ? "Câu chữ có ghi giá nhưng mã hàng có nhiều giá (hoặc chưa có giá) trong ERP — kiểm lại giá trước khi duyệt lô."
      : `Câu chữ ghi giá khác giá ERP (${formatVND(priceVnd)}) — kiểm lại trước khi duyệt lô.`,
  ];
}

async function loadTarget(db: Db, variantId: string) {
  const [row] = await db
    .select({ v: schema.creativeVariants, batchStatus: schema.creativeBatches.status, approvalDeadline: schema.creativeBatches.approvalDeadline, batchDay: schema.creativeBatches.batchDay })
    .from(schema.creativeVariants)
    .innerJoin(schema.creativeBatches, eq(schema.creativeBatches.id, schema.creativeVariants.batchId))
    .where(eq(schema.creativeVariants.id, variantId))
    .limit(1);
  return row ?? null;
}

export type SaveCopyResult =
  | { ok: true; batchId: string; batchDay: string; before: { headline: string; primaryText: string }; after: { headline: string; primaryText: string }; changed: boolean; warnings: string[] }
  | { ok: false; error: string };

/** Ghi câu chữ người đã soạn. Không ném cho lỗi nghiệp vụ. */
export async function saveVariantCopyCore(db: Db, input: VariantCopyInput, now: Date): Promise<SaveCopyResult> {
  const t = await loadTarget(db, input.variantId);
  if (!t) return { ok: false, error: "Không tìm thấy mẫu." };
  const blocker = copyEditBlocker({ batchStatus: t.batchStatus, approvalDeadline: t.approvalDeadline, variantStatus: t.v.status }, now);
  if (blocker) return { ok: false, error: blocker };

  const before = { headline: t.v.headline, primaryText: t.v.primaryText };
  const after = { headline: input.headline, primaryText: input.primaryText };
  const product = t.v.productId ? await loadProductBrief(db, t.v.productId) : null;
  const warnings = priceWarnings(`${after.headline}\n${after.primaryText}`, product?.priceVnd ?? null);
  if (before.headline === after.headline && before.primaryText === after.primaryText) return { ok: true, batchId: t.v.batchId, batchDay: t.batchDay, before, after, changed: false, warnings };

  const b = schema.creativeBatches;
  const v = schema.creativeVariants;
  const openBatches = db
    .select({ id: b.id })
    .from(b)
    .where(and(inArray(b.status, [...COPY_EDITABLE_BATCH_STATUSES]), gt(b.approvalDeadline, now)));
  const rows = await db
    .update(v)
    .set({
      headline: after.headline,
      primaryText: after.primaryText,
      // Người đã soạn lại ⇒ ghi chú "đang dùng câu nháp" của đường sinh không còn đúng nữa.
      ...(t.v.genError.startsWith(CAPTION_FALLBACK_PREFIX) ? { genError: "" } : {}),
      updatedAt: now,
    })
    .where(and(eq(v.id, input.variantId), eq(v.status, "GENERATED"), inArray(v.batchId, openBatches)))
    .returning({ id: v.id });
  if (rows.length === 0) return { ok: false, error: "Lô hoặc mẫu vừa đổi trạng thái (đã duyệt / quá hạn / bị gạt) — tải lại để xem." };
  return { ok: true, batchId: t.v.batchId, batchDay: t.batchDay, before, after, changed: true, warnings };
}

export type SuggestCopyResult = { ok: true; options: CaptionOption[]; seen: string; model: string; costUsd: number | null; priceStripped: boolean } | { ok: false; error: string };

/**
 * 2–3 phương án câu chữ viết THEO ẢNH của mẫu. CHỈ ĐỌC + gọi mô hình — không ghi vào mẫu; người
 * chọn một phương án rồi tự bấm Lưu (`saveVariantCopyCore`).
 */
export async function suggestVariantCopyCore(db: Db, variantId: string, now: Date, deps: { caption?: VariantCaptioner; options?: number } = {}): Promise<SuggestCopyResult> {
  const t = await loadTarget(db, variantId);
  if (!t) return { ok: false, error: "Không tìm thấy mẫu." };
  const blocker = copyEditBlocker({ batchStatus: t.batchStatus, approvalDeadline: t.approvalDeadline, variantStatus: t.v.status }, now);
  if (blocker) return { ok: false, error: blocker };
  if (!t.v.productId) return { ok: false, error: "Mẫu không còn gắn mã hàng — không biết giá để viết câu chữ." };
  const product = await loadProductBrief(db, t.v.productId);
  if (!product) return { ok: false, error: "Không tìm thấy mã hàng của mẫu." };
  const img = t.v.imageId ? await readCreativeImage(db, t.v.imageId) : null;
  if (!img) return { ok: false, error: "Ảnh của mẫu đã mất hoặc đã bị xoá điểm ảnh." };

  const caption = deps.caption ?? captionFromImage;
  const r = await caption(
    db,
    {
      image: { bytes: new Uint8Array(img.bytes), contentType: img.contentType },
      product: { name: product.name, code: product.code, priceVnd: product.priceVnd },
      genes: parsePartialGenes(t.v.genes),
      draft: { headline: t.v.headline, primaryText: t.v.primaryText },
      winningExamples: await loadWinningExamples(db, t.v.productId),
      options: deps.options ?? 3,
    },
    { now, entityId: variantId },
  ).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, options: r.options, seen: r.seen, model: r.model, costUsd: r.costUsd, priceStripped: r.priceStripped };
}
