"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { applyDraft, createDraft, discardDraft, previewDraft } from "@/lib/ai-builder/service";
import type { AiBuilderResult, AiDraftView } from "@/lib/ai-builder/types";
import type { ApplyResult, BlueprintPlan } from "@/lib/blueprints/types";

/**
 * ═══════════ SERVER ACTION CỦA MÀN AI BUILDER (Phase 8) ═══════════
 *
 * Đọc phiên (`requirePermission("metadata:manage")`) → lõi `lib/ai-builder/service.ts` (kiểm quyền LẦN HAI, tổ chức
 * của phiên phải trùng ngữ cảnh) → `revalidatePath`. Người thao tác lấy từ PHIÊN (luật 34). Client chỉ gửi mã nháp,
 * danh sách khoá bỏ chọn, lựa chọn ghi đè và `planHash` — không bao giờ gửi gói cấu hình.
 */

const PATH = "/settings/ai-builder";

export async function createAiDraftAction(input: { mode: string; prompt: string }): Promise<AiBuilderResult<AiDraftView>> {
  const user = await requirePermission("metadata:manage");
  const r = await createDraft(user, input);
  revalidatePath(PATH);
  return r;
}

/** Xem trước = kế hoạch Phase 7 trên gói đã lọc theo mục người giữ lại. Chỉ đọc. */
export async function previewAiDraftAction(id: string, input: { excludedKeys: string[]; resolutions: Record<string, string> }): Promise<AiBuilderResult<{ plan: BlueprintPlan; excludedKeys: string[] }>> {
  const user = await requirePermission("metadata:manage");
  return previewDraft(user, id, input);
}

export async function applyAiDraftAction(id: string, input: { planHash: string; excludedKeys: string[]; resolutions: Record<string, string> }): Promise<ApplyResult> {
  const user = await requirePermission("metadata:manage");
  const result = await applyDraft(user, id, input);
  if (result.installId) {
    revalidatePath(PATH);
    revalidatePath("/", "layout");
  }
  return result;
}

export async function discardAiDraftAction(id: string): Promise<AiBuilderResult<AiDraftView>> {
  const user = await requirePermission("metadata:manage");
  const r = await discardDraft(user, id);
  revalidatePath(PATH);
  return r;
}
