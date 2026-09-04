"use server";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { CodStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { vnStartOfDay } from "@/lib/format";

export type CodActionResult = { ok: true; count: number; message?: string } | { error: string };

const idsSchema = z.array(z.string().min(1).max(100)).min(1, "Chưa chọn vận đơn").max(500, "Tối đa 500 vận đơn mỗi lần");
const markSchema = z.object({ ids: idsSchema, note: z.string().trim().max(500).optional() });
const paidSchema = z.object({
  ids: idsSchema,
  reference: z.string().trim().min(1, "Nhập mã bảng kê / tham chiếu").max(120),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày nhận tiền không hợp lệ"),
  note: z.string().trim().max(500).optional(),
});

/** codCollected = codAmount nếu chưa ghi nhận số đã thu */
const collectedOrAmount = sql`case when ${schema.shipments.codCollected} = 0 then ${schema.shipments.codAmount} else ${schema.shipments.codCollected} end`;

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

function revalidate() {
  revalidatePath("/cod");
  revalidatePath("/shipments");
  revalidatePath("/");
}

async function authorize() {
  const user = await requireUser();
  if (!can(user.role, "cod:write")) return { user, error: "Bạn không có quyền đối soát COD" as const };
  return { user, error: null };
}

/** Đánh dấu ĐVVC đã đối soát: codStatus = RECONCILED, codReconciledAt = now */
export async function markCodReconciled(input: unknown): Promise<CodActionResult> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = markSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const db = await getDb();
  const now = new Date();
  const updated = await db
    .update(schema.shipments)
    .set({ codStatus: "RECONCILED", codReconciledAt: now, codCollected: collectedOrAmount, updatedAt: now })
    .where(and(inArray(schema.shipments.id, parsed.data.ids), inArray(schema.shipments.codStatus, ["PENDING", "COLLECTED", "DISPUTED"] satisfies CodStatus[])))
    .returning({ id: schema.shipments.id });
  if (!updated.length) return { error: "Không có vận đơn nào phù hợp (chỉ áp dụng cho vận đơn Chưa thu / Đã thu / Có chênh lệch)" };
  await audit({ userId: user.id, userEmail: user.email, action: "COD_RECONCILED", entity: "SHIPMENT", entityId: updated.length === 1 ? updated[0].id : "", detail: { shipmentIds: updated.map((u) => u.id), note: parsed.data.note ?? "" } });
  revalidate();
  return { ok: true, count: updated.length, message: `Đã đánh dấu ${updated.length} vận đơn ĐVVC đã đối soát` };
}

/** Tạo đợt nhận tiền và đánh dấu các vận đơn đã về ngân hàng */
export async function markCodPaidToBank(input: unknown): Promise<CodActionResult> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = paidSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { ids, reference, receivedAt, note } = parsed.data;
  const receivedDate = vnStartOfDay(receivedAt);
  if (Number.isNaN(receivedDate.getTime())) return { error: "Ngày nhận tiền không hợp lệ" };
  const db = await getDb();
  const eligible = await db
    .select({ id: schema.shipments.id, carrier: schema.shipments.carrier, codAmount: schema.shipments.codAmount, codCollected: schema.shipments.codCollected })
    .from(schema.shipments)
    .where(and(inArray(schema.shipments.id, ids), ne(schema.shipments.codStatus, "NOT_APPLICABLE"), ne(schema.shipments.codStatus, "PAID_TO_BANK")));
  if (!eligible.length) return { error: "Không có vận đơn nào phù hợp (đã về ngân hàng hoặc không thu hộ)" };
  const totalAmount = eligible.reduce((total, s) => total + (s.codCollected || s.codAmount), 0);
  const carrierCount = new Map<string, number>();
  for (const s of eligible) {
    const key = s.carrier || "Viettel Post";
    carrierCount.set(key, (carrierCount.get(key) ?? 0) + 1);
  }
  const carrier = [...carrierCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Viettel Post";
  const now = new Date();

  const batch = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.codBatches)
      .values({ reference, carrier, receivedAt: receivedDate, totalAmount, note: note ?? "", createdBy: user.email })
      .returning({ id: schema.codBatches.id });
    await tx
      .update(schema.shipments)
      .set({
        codStatus: "PAID_TO_BANK",
        codPaidToBankAt: receivedDate,
        codBatchId: created.id,
        codReconciledAt: sql`coalesce(${schema.shipments.codReconciledAt}, ${now})`,
        codCollected: collectedOrAmount,
        updatedAt: now,
      })
      .where(
        inArray(
          schema.shipments.id,
          eligible.map((s) => s.id),
        ),
      );
    return created;
  });

  await audit({ userId: user.id, userEmail: user.email, action: "COD_PAID_TO_BANK", entity: "COD_BATCH", entityId: batch.id, detail: { reference, receivedAt, totalAmount, count: eligible.length, shipmentIds: eligible.map((s) => s.id), note: note ?? "" } });
  revalidate();
  return { ok: true, count: eligible.length, message: `Đã tạo đợt ${reference}: ${eligible.length} vận đơn về ngân hàng` };
}

/** Đánh dấu có chênh lệch cần đối chiếu (ghi chú chỉ lưu trong nhật ký hệ thống) */
export async function markCodDisputed(input: unknown): Promise<CodActionResult> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = markSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const db = await getDb();
  const updated = await db
    .update(schema.shipments)
    .set({ codStatus: "DISPUTED", updatedAt: new Date() })
    .where(and(inArray(schema.shipments.id, parsed.data.ids), ne(schema.shipments.codStatus, "NOT_APPLICABLE"), ne(schema.shipments.codStatus, "DISPUTED")))
    .returning({ id: schema.shipments.id });
  if (!updated.length) return { error: "Không có vận đơn nào phù hợp" };
  await audit({ userId: user.id, userEmail: user.email, action: "COD_DISPUTED", entity: "SHIPMENT", entityId: updated.length === 1 ? updated[0].id : "", detail: { shipmentIds: updated.map((u) => u.id), note: parsed.data.note ?? "" } });
  revalidate();
  return { ok: true, count: updated.length, message: `Đã đánh dấu ${updated.length} vận đơn có chênh lệch` };
}

/** Quay về trạng thái Đã thu (huỷ đối soát / huỷ ghi nhận tiền về); tổng tiền đợt nhận tiền liên quan được tính lại */
export async function revertCodToCollected(input: unknown): Promise<CodActionResult> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = markSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const db = await getDb();
  const affected = await db
    .select({ id: schema.shipments.id, codBatchId: schema.shipments.codBatchId })
    .from(schema.shipments)
    .where(and(inArray(schema.shipments.id, parsed.data.ids), inArray(schema.shipments.codStatus, ["RECONCILED", "PAID_TO_BANK", "DISPUTED"] satisfies CodStatus[])));
  if (!affected.length) return { error: "Không có vận đơn nào phù hợp (chỉ áp dụng cho vận đơn đã đối soát / đã về ngân hàng / có chênh lệch)" };
  const batchIds = [...new Set(affected.map((a) => a.codBatchId).filter((id): id is string => Boolean(id)))];
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(schema.shipments)
      .set({ codStatus: "COLLECTED", codReconciledAt: null, codPaidToBankAt: null, codBatchId: null, codCollected: collectedOrAmount, updatedAt: now })
      .where(
        inArray(
          schema.shipments.id,
          affected.map((a) => a.id),
        ),
      );
    for (const batchId of batchIds) {
      await tx
        .update(schema.codBatches)
        .set({ totalAmount: sql`coalesce((select sum(${schema.shipments.codCollected}) from ${schema.shipments} where ${schema.shipments.codBatchId} = ${schema.codBatches.id}), 0)` })
        .where(eq(schema.codBatches.id, batchId));
    }
  });
  await audit({ userId: user.id, userEmail: user.email, action: "COD_REVERTED", entity: "SHIPMENT", entityId: affected.length === 1 ? affected[0].id : "", detail: { shipmentIds: affected.map((a) => a.id), batchIds, note: parsed.data.note ?? "" } });
  revalidate();
  return { ok: true, count: affected.length, message: `Đã đưa ${affected.length} vận đơn về trạng thái Đã thu` };
}
