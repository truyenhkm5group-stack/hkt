"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, type SessionUser } from "@/lib/auth/session";
import { applyDraft, createDraft, discardDraft, previewDraft } from "@/lib/ai-builder/service";
import type { AiBuilderResult, AiDraftView } from "@/lib/ai-builder/types";
import type { ApplyResult, BlueprintPlan } from "@/lib/blueprints/types";
import { CUSTOMER_AI_DRAFT_FAILED, CUSTOMER_AI_NOT_READY_LABEL, customerAiDraft, customerFacing, customerSafeAiError, type CustomerAiDraftView } from "@/lib/saas/visibility";

/**
 * ═══════════ SERVER ACTION CỦA MÀN AI BUILDER (Phase 8) ═══════════
 *
 * Đọc phiên (`requirePermission("metadata:manage")`) → lõi `lib/ai-builder/service.ts` (kiểm quyền LẦN HAI, tổ chức
 * của phiên phải trùng ngữ cảnh) → `revalidatePath`. Người thao tác lấy từ PHIÊN (luật 34). Client chỉ gửi mã nháp,
 * danh sách khoá bỏ chọn, lựa chọn ghi đè và `planHash` — không bao giờ gửi gói cấu hình.
 *
 * Workspace KHÁCH (lib/saas/visibility.ts): bản nháp trả về KHÔNG có nguồn AI / nhà cung cấp / model / token / USD; câu lỗi
 * (nguồn AI chưa mở được, hạn mức tính bằng USD, lỗi gọi AI) qua danh sách cho phép. Lõi giữ nguyên câu gốc cho nhà.
 */

const PATH = "/settings/ai-builder";

type DraftResult = AiBuilderResult<AiDraftView | CustomerAiDraftView>;

function forViewer(user: SessionUser, r: AiBuilderResult<AiDraftView>, fallback: string): DraftResult {
  if (!customerFacing(user.organization)) return r;
  return r.ok ? { ok: true, value: customerAiDraft(r.value) } : { ok: false, error: customerSafeAiError(r.error, fallback) };
}

/** Lượt tạo hỏng ở khách: câu lạ còn lại là nguồn AI chưa mở được ⇒ «chưa sẵn sàng»; hạn mức ⇒ câu của trang gói. */
export async function createAiDraftAction(input: { mode: string; prompt: string }): Promise<DraftResult> {
  const user = await requirePermission("metadata:manage");
  const r = await createDraft(user, input);
  revalidatePath(PATH);
  return forViewer(user, r, CUSTOMER_AI_NOT_READY_LABEL);
}

/** Xem trước = kế hoạch Phase 7 trên gói đã lọc theo mục người giữ lại. Chỉ đọc. */
export async function previewAiDraftAction(id: string, input: { excludedKeys: string[]; resolutions: Record<string, string> }): Promise<AiBuilderResult<{ plan: BlueprintPlan; excludedKeys: string[] }>> {
  const user = await requirePermission("metadata:manage");
  const r = await previewDraft(user, id, input);
  return r.ok || !customerFacing(user.organization) ? r : { ok: false, error: customerSafeAiError(r.error, CUSTOMER_AI_DRAFT_FAILED) };
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

export async function discardAiDraftAction(id: string): Promise<DraftResult> {
  const user = await requirePermission("metadata:manage");
  const r = await discardDraft(user, id);
  revalidatePath(PATH);
  return forViewer(user, r, CUSTOMER_AI_DRAFT_FAILED);
}
