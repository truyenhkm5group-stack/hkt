"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { bindOrganization } from "@/lib/platform/background";
import { runReplay, startReplay } from "@/lib/sales-chatbot/replay";

/**
 * Vỏ của màn «Phát lại hội thoại cũ» (lib/sales-chatbot/replay.ts): phiên → lõi (kiểm module + ai_sales:manage lần nữa) →
 * việc nặng SAU phản hồi trong đúng ngữ cảnh tổ chức của PHIÊN (không nhận mã tổ chức từ client).
 */
export async function startReplayAction(input: { points: number; days: number }): Promise<{ ok: true; message: string; runId: string } | { error: string }> {
  const user = await requireUser();
  const r = await startReplay(user, { points: input?.points, days: input?.days });
  if ("error" in r) return r;
  after(await bindOrganization(async () => void (await runReplay(r.runId, { id: user.id }))));
  revalidatePath("/ai/sales-chatbot/replay");
  return { ok: true, runId: r.runId, message: "Đang phát lại — mỗi điểm là một lượt AI (vài giây / điểm); bấm «Làm mới» để xem." };
}
