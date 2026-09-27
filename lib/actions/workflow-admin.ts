"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import {
  adminPreviewWorkflowRule,
  adminRunWorkflowsNow,
  adminSaveWorkflowRule,
  adminSetWorkflowMode,
  adminSetWorkflowStatus,
  type WorkflowPreviewResult,
  type WorkflowRunNowResult,
  type WorkflowWriteResult,
} from "@/lib/platform-ui/workflow-admin";

/**
 * ═══════════ SERVER ACTION CỦA MÀN HÌNH LUẬT TỰ ĐỘNG (Phase 3) ═══════════
 *
 * MỘT lớp action duy nhất cho luật tự động (cùng quyết định với metadata Phase 2): mỗi action chỉ đọc phiên
 * (`requirePermission("workflow:manage")`) → lõi `lib/platform-ui/workflow-admin.ts` (kiểm quyền LẦN HAI, phiên
 * phải mang tổ chức, rồi mới gọi `lib/workflow/*` — nơi DUY NHẤT ghi `workflow_rules`) → `revalidatePath`.
 * Người thao tác lấy từ PHIÊN (luật 34). Lỗi nghiệp vụ trả `{ ok: false, errors }`, không ném.
 * KHÔNG `router.refresh()` phía client — hai cơ chế là dựng hai lần (PR #272).
 */

const LIST_PATH = "/settings/workflows";

function refresh<T extends { ok: boolean }>(result: T, id?: string | null): T {
  if (!result.ok) return result;
  revalidatePath(LIST_PATH);
  if (id) revalidatePath(`${LIST_PATH}/${encodeURIComponent(id)}`);
  return result;
}

/** Tạo (`id = null`) / sửa luật. Luôn lưu về NHÁP + CHẠY THỬ. */
export async function saveWorkflowRuleAction(id: string | null, input: unknown): Promise<WorkflowWriteResult> {
  const user = await requirePermission("workflow:manage");
  const r = await adminSaveWorkflowRule(user, id, input);
  return refresh(r, r.ok ? r.id : null);
}

/** Bật / tạm dừng / lưu trữ. */
export async function setWorkflowRuleStatusAction(id: string, status: "ACTIVE" | "PAUSED" | "ARCHIVED"): Promise<WorkflowWriteResult> {
  const user = await requirePermission("workflow:manage");
  return refresh(await adminSetWorkflowStatus(user, id, status), id);
}

/** Chạy thử ⇄ chạy thật. `LIVE` chỉ khi luật đang bật (lõi chặn, dịch vụ chặn lại). */
export async function setWorkflowRuleModeAction(id: string, mode: "DRY_RUN" | "LIVE"): Promise<WorkflowWriteResult> {
  const user = await requirePermission("workflow:manage");
  return refresh(await adminSetWorkflowMode(user, id, mode), id);
}

/** Chạy thử luật ĐÃ LƯU trên một bản ghi — không ghi gì, không revalidate. */
export async function previewWorkflowRuleAction(id: string, subject: { objectKey: string; recordId: string }): Promise<WorkflowPreviewResult> {
  const user = await requirePermission("workflow:manage");
  return adminPreviewWorkflowRule(user, id, subject);
}

/** Một lượt kiểm tra luật NGAY cho tổ chức của người bấm (tổ chức không có job `alerts` vẫn chạy được luật). */
export async function runWorkflowsNowAction(): Promise<WorkflowRunNowResult> {
  const user = await requirePermission("workflow:manage");
  const r = await adminRunWorkflowsNow(user);
  if (r.ok) revalidatePath(`${LIST_PATH}/[id]`, "page");
  return refresh(r);
}
