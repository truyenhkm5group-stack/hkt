"use server";

import { z } from "zod";
import type { CopilotConfirmResult, CopilotResult, CopilotToolInfo } from "@/lib/ai/contracts";
import { confirmCopilotActions as confirmCore, runCopilot } from "@/lib/ai/copilot";
import { describeTools } from "@/lib/ai/tools/registry";
import { requireUser } from "@/lib/auth/session";
import { env } from "@/lib/env";

/**
 * Server Action của AI Copilot — lớp mỏng: xác thực phiên, zod, rồi giao cho `lib/ai/copilot.ts`.
 * Quyền theo TỪNG TOOL nằm trong sổ đăng ký (người không có quyền thì model không thấy tool đó);
 * hành động ghi chỉ chạy qua `confirmCopilotActions` sau khi người bấm xác nhận.
 */

const askSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  context: z.object({ route: z.string().max(200).default(""), entityType: z.enum(["shipment", "order", "customer", ""]).default(""), entityId: z.string().max(80).default("") }),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) })).max(12).optional(),
});

export async function askCopilot(input: z.input<typeof askSchema>): Promise<CopilotResult> {
  const user = await requireUser();
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) {
    return { interactionId: null, status: "ERROR", answer: "", toolCalls: [], pendingActions: [], warnings: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 0, rounds: 0, model: env.ai.model, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
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

/** Cho UI: copilot có bật không và người này dùng được tool nào. */
export async function copilotStatus(): Promise<{ enabled: boolean; model: string; tools: CopilotToolInfo[] }> {
  const user = await requireUser();
  return { enabled: env.ai.provider !== "off" && env.ai.configured, model: env.ai.model, tools: describeTools(user) };
}
