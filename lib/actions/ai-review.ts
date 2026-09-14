"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";

export type ActionResult = { ok: true } | { error: string };

/**
 * CHẤM TAY một lượt chạy ở nấc chạy ngầm.
 *
 * Đây là đường DUY NHẤT ghi vào `sales_review_labels`, và nó luôn đi kèm khoá tài khoản người
 * chấm. Không job nào, không dây chuyền nào được ghi vào bảng này: máy tự chấm chính nó thì con
 * số đẹp lên mà không ai biết nó có đúng không.
 *
 * `null` ở mỗi ô nghĩa là CHƯA CHẤM / KHÔNG ÁP DỤNG — khác hẳn `false` (đã xem và thấy sai).
 */
const labelSchema = z.object({
  suggestionId: z.string().min(1),
  productOk: z.boolean().nullable().optional(),
  colorOk: z.boolean().nullable().optional(),
  sizeOk: z.boolean().nullable().optional(),
  phoneOk: z.boolean().nullable().optional(),
  addressOk: z.boolean().nullable().optional(),
  intentOk: z.boolean().nullable().optional(),
  purchaseIntentOk: z.boolean().nullable().optional(),
  confirmationOk: z.boolean().nullable().optional(),
  replyUsable: z.boolean().nullable().optional(),
  nextActionQuality: z.enum(["GOOD", "ACCEPTABLE", "WRONG"]).nullable().optional(),
  hallucination: z.boolean().nullable().optional(),
  hallucinationNote: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(2000).optional(),
});

export async function saveShadowLabel(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền soát nhân sự AI" };
  const parsed = labelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const data = parsed.data;

  const db = await getDb();
  const suggestion = await db.query.salesSuggestions.findFirst({
    where: eq(schema.salesSuggestions.id, data.suggestionId),
    columns: { id: true, conversationId: true },
  });
  if (!suggestion) return { error: "Không tìm thấy lượt cần chấm" };

  const existing = await db.query.salesReviewLabels.findFirst({ where: eq(schema.salesReviewLabels.suggestionId, data.suggestionId) });
  const values = {
    suggestionId: data.suggestionId,
    conversationId: suggestion.conversationId,
    productOk: data.productOk ?? null,
    colorOk: data.colorOk ?? null,
    sizeOk: data.sizeOk ?? null,
    phoneOk: data.phoneOk ?? null,
    addressOk: data.addressOk ?? null,
    intentOk: data.intentOk ?? null,
    purchaseIntentOk: data.purchaseIntentOk ?? null,
    confirmationOk: data.confirmationOk ?? null,
    replyUsable: data.replyUsable ?? null,
    nextActionQuality: data.nextActionQuality ?? null,
    hallucination: data.hallucination ?? null,
    hallucinationNote: data.hallucinationNote ?? "",
    note: data.note ?? "",
    reviewerUserId: user.id,
    reviewedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.salesReviewLabels).set({ ...values, updatedAt: new Date() }).where(eq(schema.salesReviewLabels.id, existing.id));
  } else {
    await db.insert(schema.salesReviewLabels).values(values);
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: existing ? "ai.review.update" : "ai.review.create",
    entity: "sales_review_labels",
    entityId: data.suggestionId,
    before: existing ?? undefined,
    after: values,
    reason: "Chấm tay lượt chạy nhân sự AI ở nấc chạy ngầm",
  });
  revalidatePath("/ai/review");
  return { ok: true };
}
