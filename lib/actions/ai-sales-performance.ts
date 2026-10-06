"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { loadPerformanceSettings, savePerformanceSettings } from "@/lib/sales-chatbot/performance";
import { reviewQualityFindingCore } from "@/lib/sales-chatbot/quality";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";

/**
 * Chủ shop khai «chi phí một hội thoại do người làm» — đầu vào DUY NHẤT của «tiết kiệm nhân sự (ước tính)» ở màn Hiệu quả AI
 * bán hàng. Không có giá trị mặc định (luật 38); `null` = gỡ khai báo.
 */
export async function saveHumanCostAction(input: { humanCostPerConversationVnd: number | null; reason: string }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const before = await loadPerformanceSettings();
  const value = input?.humanCostPerConversationVnd ?? null;
  const r = await savePerformanceSettings(user, { humanCostPerConversationVnd: typeof value === "number" ? value : null, reason: String(input?.reason ?? "") });
  if ("error" in r) return r;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "AI_SALES_HUMAN_COST",
    entity: "SETTING",
    entityId: "ai.salesPerformance",
    before: { humanCostPerConversationVnd: before.humanCostPerConversationVnd },
    after: { humanCostPerConversationVnd: value },
    reason: String(input?.reason ?? "").slice(0, 300) || "Gỡ khai báo",
  });
  revalidatePath("/ai/sales-chatbot/performance");
  return { ok: true, message: value === null ? "Đã gỡ khai báo chi phí người" : "Đã lưu chi phí một hội thoại do người làm" };
}

/** Rà một phát hiện lỗi AI: «đúng là lỗi» / «không phải lỗi» (+ ghi chú). Lõi kiểm quyền + kiểm phát hiện còn tồn tại. */
export async function reviewAiFindingAction(input: { conversationId: string; seq: number; kind: string; status: string; note?: string }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await reviewQualityFindingCore(user, { conversationId: input?.conversationId, seq: input?.seq, kind: input?.kind, status: input?.status, note: input?.note ?? "" });
  if ("error" in r) return r;
  revalidatePath("/ai/sales-chatbot/quality");
  return { ok: true, message: input.status === "CONFIRMED" ? "Đã ghi: đúng là lỗi" : "Đã ghi: không phải lỗi" };
}
