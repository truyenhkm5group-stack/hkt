"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { applyBulkReturnToAi, previewBulkReturnToAi, type BulkReturnApplied, type BulkReturnPreview } from "@/lib/sales-chatbot/bulk-return-ai";
import { canControlConversation, NO_CONTROL_PERMISSION } from "@/lib/sales-chatbot/conversation-control";

/**
 * ═══════════ SERVER ACTION: «TRẢ TẤT CẢ CHO AI» (chủ shop 10/10/2026, mục D) ═══════════
 *
 * Mỏng: phiên → quyền (CÙNG cổng với nút trả một hội thoại — `canControlConversation`) → zod → lõi `bulk-return-ai.ts` (cách ly
 * tenant, phân loại, ghi qua đường trả một hội thoại, sự kiện + nhật ký mang người bấm) → `revalidatePath`. Lỗi nghiệp vụ trả
 * `{ error }`, không ném. Xem trước KHÔNG ghi gì nên không làm mới trang.
 */

const PATH = "/ai/sales-chatbot/inbox";
const applyZ = z.object({ confirm: z.literal(true) }).strict();

export async function previewBulkReturnToAiAction(): Promise<{ ok: true; preview: BulkReturnPreview } | { error: string }> {
  const user = await requireUser();
  if (!canControlConversation(user)) return { error: NO_CONTROL_PERMISSION };
  const r = await previewBulkReturnToAi(user);
  return r.ok ? r : { error: r.error };
}

export async function applyBulkReturnToAiAction(input: unknown): Promise<({ ok: true } & BulkReturnApplied) | { error: string }> {
  const user = await requireUser();
  if (!canControlConversation(user)) return { error: NO_CONTROL_PERMISSION };
  if (!applyZ.safeParse(input).success) return { error: "Thiếu xác nhận — bấm lại «Trả tất cả cho AI»." };
  const r = await applyBulkReturnToAi(user);
  if (!r.ok) return { error: r.error };
  if (r.resumed > 0) {
    revalidatePath(PATH);
    revalidatePath("/ai/sales-chatbot");
  }
  return r;
}
