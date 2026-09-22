"use server";

import { bacChoLuotHoi } from "@/lib/constants/ai-budget";
import { z } from "zod";
import type { CopilotConfirmResult, CopilotResult, CopilotToolInfo } from "@/lib/ai/contracts";
import { confirmCopilotActions as confirmCore, runCopilot } from "@/lib/ai/copilot";
import { describeTools } from "@/lib/ai/tools/registry";
import { requireUser } from "@/lib/auth/session";
import { aiDisabledReason, modelFor, resolveProviderName } from "@/lib/ai/router";

/**
 * Server Action của AI Copilot — lớp mỏng: xác thực phiên, zod, rồi giao cho `lib/ai/copilot.ts`.
 * Quyền theo TỪNG TOOL nằm trong sổ đăng ký (người không có quyền thì model không thấy tool đó);
 * hành động ghi chỉ chạy qua `confirmCopilotActions` sau khi người bấm xác nhận.
 */

const askSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  context: z.object({ route: z.string().max(200).default(""), entityType: z.enum(["shipment", "order", "customer", ""]).default(""), entityId: z.string().max(80).default("") }),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) })).max(12).optional(),
  /** Người hỏi bấm "Hỏi kỹ" — nâng bậc model cho riêng lượt này. Đường nâng bậc DUY NHẤT. */
  sauHon: z.boolean().optional(),
});

export async function askCopilot(input: z.input<typeof askSchema>): Promise<CopilotResult> {
  const user = await requireUser();
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) {
    return { interactionId: null, status: "ERROR", answer: "", toolCalls: [], pendingActions: [], warnings: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: null, latencyMs: 0, rounds: 0, model: "", error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  }
  return runCopilot({ user, ...parsed.data });
}

const confirmSchema = z.object({ interactionId: z.string().min(1), tokens: z.array(z.string().min(8).max(64)).min(1).max(5) });

export async function confirmCopilotActions(input: z.input<typeof confirmSchema>): Promise<CopilotConfirmResult> {
  const user = await requireUser();
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  return confirmCore({ user, ...parsed.data });
}

/**
 * Cho UI: copilot có bật không, dùng model nào, và người này dùng được tool nào.
 *
 * ─── NHÃN PHẢI NÓI ĐÚNG MODEL SẼ TRẢ LỜI ───
 *
 * ĐÃ CẮN THẬT 22/09/2026. Chủ shop mở Copilot ở `/shipments`, nhãn góc trên ghi `claude-opus-5`.
 * Sổ `ai_interactions` của chính câu hỏi ấy ghi:
 *
 *     03:14:51 | claude-haiku-4-5-20251001 | $0,018574 | OK
 *
 * Nhãn lấy `modelFor(name, "copilot")` — một hằng số TĨNH của bậc `copilot`, trong khi lượt hỏi
 * thật đi bằng bậc mặc định (`routine`). Hai nơi nói hai điều, và cái người dùng nhìn thấy là
 * cái SAI.
 *
 * Một con số trên màn hình không khớp thứ thật sự xảy ra thì tệ hơn không hiện gì: người đọc dùng
 * nó để quyết định. Nhãn nay dựng từ CÙNG hàm mà lượt hỏi dùng (`bacChoLuotHoi`), nên hai nơi
 * không thể trôi xa nhau.
 */
export async function copilotStatus(): Promise<{ enabled: boolean; provider: string; model: string; modelSauHon: string; reason: string | null; tools: CopilotToolInfo[] }> {
  const user = await requireUser();
  const name = resolveProviderName();
  const bac = bacChoLuotHoi({});
  return {
    enabled: Boolean(name),
    provider: name ?? "",
    model: name ? modelFor(name, bac) : "",
    /** Model khi người hỏi bấm "hỏi kỹ" — để UI nói được cái nút ấy đổi sang gì. */
    modelSauHon: name ? modelFor(name, bacChoLuotHoi({ sauHon: true })) : "",
    reason: aiDisabledReason(),
    tools: describeTools(user),
  };
}
