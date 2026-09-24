import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema, type Db } from "@/db";

/**
 * ═══════════ TÍCH CHỌN BÀI TRONG LÔ CHỜ DUYỆT — LOẠI / GIỮ NHIỀU BÀI MỘT LẦN (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Hai cú bấm trên thanh chọn của tab Duyệt lô:
 *  · "Loại các bài đã chọn" — bài chọn `GENERATED` ⇒ `REJECTED`: không đăng, không tiêu tiền.
 *  · "Giữ các bài đã chọn"  — bài chọn giữ lại (bài đã loại có ảnh thì KHÔI PHỤC về `GENERATED`), MỌI bài
 *                              `GENERATED` còn lại của lô ⇒ `REJECTED`.
 *
 * Phiếu duyệt lô chỉ khoá mẫu `GENERATED` (`batchApprovalContent`), nên tập bài được giữ CHÍNH LÀ tập bài
 * trong digest: loại / khôi phục một bài ⇒ digest đổi ⇒ phiếu đã phát tự vô hiệu, người duyệt mở lại.
 *
 * Chỉ khi lô `PENDING_APPROVAL` và còn hạn duyệt — điều kiện nằm TRONG câu `UPDATE`, không chỉ ở bước đọc.
 * Khôi phục chỉ nhận bài có ảnh chưa bị xoá điểm ảnh: bài sinh lỗi bị gạt không có gì để khôi phục.
 */

export type SelectionMode = "REJECT_SELECTED" | "KEEP_SELECTED";

export type SelectionPlan = { reject: string[]; restore: string[] };

/** Kế hoạch thuần: bài nào bị loại, bài nào được khôi phục. Bài không thuộc lô bị bỏ qua. */
export function planSelection(variants: readonly { id: string; status: string; restorable: boolean }[], selected: readonly string[], mode: SelectionMode): SelectionPlan {
  const pick = new Set(selected);
  if (mode === "REJECT_SELECTED") return { reject: variants.filter((v) => pick.has(v.id) && v.status === "GENERATED").map((v) => v.id), restore: [] };
  return {
    reject: variants.filter((v) => !pick.has(v.id) && v.status === "GENERATED").map((v) => v.id),
    restore: variants.filter((v) => pick.has(v.id) && v.status === "REJECTED" && v.restorable).map((v) => v.id),
  };
}

export type SelectionResult = { ok: true; batchDay: string; rejected: string[]; restored: string[]; kept: number } | { ok: false; error: string };

export async function applyVariantSelectionCore(db: Db, input: { batchId: string; variantIds: string[]; mode: SelectionMode; reason: string }, actor: { id: string }, now: Date): Promise<SelectionResult> {
  const b = schema.creativeBatches;
  const v = schema.creativeVariants;
  const img = schema.creativeImages;
  const [batch] = await db.select().from(b).where(eq(b.id, input.batchId)).limit(1);
  if (!batch) return { ok: false, error: "Không tìm thấy lô." };
  if (batch.status !== "PENDING_APPROVAL") return { ok: false, error: "Chỉ chọn / loại bài khi lô đang chờ duyệt." };
  if (now >= batch.approvalDeadline) return { ok: false, error: "Lô đã quá hạn duyệt." };
  if (input.variantIds.length === 0) return { ok: false, error: "Chưa chọn bài nào." };

  const rows = await db
    .select({ id: v.id, status: v.status, imageId: v.imageId, imageRow: img.id, purgedAt: img.purgedAt })
    .from(v)
    .leftJoin(img, eq(img.id, v.imageId))
    .where(eq(v.batchId, batch.id));
  const unknown = input.variantIds.filter((id) => !rows.some((r) => r.id === id));
  if (unknown.length) return { ok: false, error: `${unknown.length} bài đã chọn không thuộc lô này — tải lại trang.` };
  const plan = planSelection(
    rows.map((r) => ({ id: r.id, status: r.status, restorable: r.imageId !== null && r.imageRow !== null && r.purgedAt === null })),
    input.variantIds,
    input.mode,
  );
  const openBatch = db
    .select({ id: b.id })
    .from(b)
    .where(and(eq(b.id, batch.id), eq(b.status, "PENDING_APPROVAL"), gt(b.approvalDeadline, now)));

  const done = await db.transaction(async (tx) => {
    const rejected = plan.reject.length
      ? await tx
          .update(v)
          .set({ status: "REJECTED", rejectReason: input.reason, rejectedByUserId: actor.id, updatedAt: now })
          .where(and(inArray(v.id, plan.reject), eq(v.status, "GENERATED"), inArray(v.batchId, openBatch)))
          .returning({ id: v.id })
      : [];
    const restored = plan.restore.length
      ? await tx
          .update(v)
          .set({ status: "GENERATED", rejectReason: "", rejectedByUserId: null, updatedAt: now })
          .where(and(inArray(v.id, plan.restore), eq(v.status, "REJECTED"), isNotNull(v.imageId), isNull(v.fbAdsetId), inArray(v.batchId, openBatch)))
          .returning({ id: v.id })
      : [];
    return { rejected: rejected.map((r) => r.id), restored: restored.map((r) => r.id) };
  });
  const kept = (await db.select({ id: v.id }).from(v).where(and(eq(v.batchId, batch.id), eq(v.status, "GENERATED")))).length;
  return { ok: true, batchDay: batch.batchDay, rejected: done.rejected, restored: done.restored, kept };
}
