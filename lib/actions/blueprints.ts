"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { installTemplate, previewTemplate } from "@/lib/blueprints/admin";
import { installBlueprintFile, previewBlueprintFile } from "@/lib/blueprints/import-file";
import type { ApplyResult, BlueprintIssue, BlueprintPlan } from "@/lib/blueprints/types";

/**
 * ═══════════ SERVER ACTION CỦA MÀN MẪU CẤU HÌNH (Phase 7) ═══════════
 *
 * Đọc phiên (`requirePermission("metadata:manage")`) → lõi `lib/blueprints/admin.ts` (kiểm quyền LẦN HAI, lập lại kế
 * hoạch lúc cài, so `planHash` với bản người đã xem) → `revalidatePath`. Người thao tác lấy từ PHIÊN (luật 34).
 * Không `router.refresh()` phía client — hai cơ chế là dựng hai lần (PR #272).
 *
 * Cài xong làm mới cả bố cục: module vừa bật và trang vừa xuất bản lên menu của mọi người.
 */

/** Xem trước lại với lựa chọn ghi đè từng mục (SKIP_CUSTOMIZED / CONFLICT). Chỉ đọc. */
export async function previewTemplateAction(key: string, resolutions: Record<string, string>): Promise<{ ok: true; plan: BlueprintPlan } | { ok: false; errors: BlueprintIssue[] }> {
  const user = await requirePermission("metadata:manage");
  const r = await previewTemplate(user, key, resolutions as Record<string, "overwrite" | "skip">);
  return r.ok ? { ok: true, plan: r.value.plan } : r;
}

export async function installTemplateAction(key: string, input: { planHash: string; resolutions: Record<string, string> }): Promise<ApplyResult> {
  const user = await requirePermission("metadata:manage");
  const result = await installTemplate(user, key, input);
  if (result.installId) {
    revalidatePath("/settings/templates");
    revalidatePath(`/settings/templates/${encodeURIComponent(key)}`);
    revalidatePath("/", "layout");
  }
  return result;
}

/**
 * CÀI TỪ TỆP JSON (Phase 11 · H3) — đường khôi phục cấu hình. Tệp đi qua CÙNG bộ kiểm / bộ lập kế hoạch / bộ cài như
 * mẫu ngành (`lib/blueprints/import-file.ts`); nội dung tệp là dữ liệu của client nên máy chủ kiểm lại ở MỖI lượt.
 */
export async function previewBlueprintFileAction(text: string, resolutions: Record<string, string>): Promise<{ ok: true; plan: BlueprintPlan } | { ok: false; errors: BlueprintIssue[] }> {
  const user = await requirePermission("metadata:manage");
  const r = await previewBlueprintFile(user, text, resolutions);
  return r.ok ? { ok: true, plan: r.value.plan } : r;
}

export async function installBlueprintFileAction(text: string, input: { planHash: string; resolutions: Record<string, string> }): Promise<ApplyResult> {
  const user = await requirePermission("metadata:manage");
  const result = await installBlueprintFile(user, text, input);
  if (result.installId) {
    revalidatePath("/settings/templates");
    revalidatePath("/", "layout");
  }
  return result;
}
