"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import {
  adminArchiveField,
  adminCreateField,
  adminMoveField,
  adminPublishForm,
  adminPublishList,
  adminSaveFormDraft,
  adminSaveListDraft,
  adminSaveStatusOverrides,
  adminUpdateField,
} from "@/lib/platform-ui/metadata-admin";
import type { AdminWriteResult } from "@/lib/platform-ui/metadata-admin-shared";

/**
 * ═══════════ SERVER ACTION CỦA BỐN MÀN HÌNH QUẢN TRỊ METADATA ═══════════
 *
 * Mỗi action chỉ: đọc phiên (`requirePermission("metadata:manage")`) → lõi ở
 * `lib/platform-ui/metadata-admin.ts` (kiểm quyền lần hai, đối tượng + module, gọi dịch vụ) →
 * `revalidatePath`. KHÔNG `router.refresh()` phía client — hai cơ chế là dựng hai lần (PR #272).
 *
 * Đây là lớp action CẤU HÌNH DUY NHẤT: `lib/actions/metadata.ts` chỉ còn action ghi GIÁ TRỊ custom.
 *
 * Xuất bản có hiệu lực ở lần tải kế tiếp của mọi người mà không cần xoá đệm nào: metadata không đệm
 * trong tiến trình (M13). `revalidatePath` ở đây để màn hình cấu hình và trang đang mở trong trình duyệt
 * của chính người bấm (bộ đệm tuyến phía client) thấy bản mới ngay.
 */

const ADMIN_PATHS = ["/settings/data-model", "/settings/forms", "/settings/lists", "/settings/statuses"] as const;

/**
 * `runtime`: lượt ghi đổi thứ NGƯỜI DÙNG thấy (field, bản xuất bản, nhãn trạng thái) ⇒ dựng lại cả trang chạy
 * thật của đối tượng (danh sách + chi tiết, đọc từ sổ — không nhận đường dẫn từ client). Lưu NHÁP thì không:
 * người dùng chưa thấy gì.
 */
function refresh(result: AdminWriteResult, objectKey: string, runtime: boolean): AdminWriteResult {
  if (!result.ok) return result;
  for (const p of ADMIN_PATHS) revalidatePath(p);
  if (runtime) {
    for (const list of objectDef(objectKey)?.lists ?? []) {
      revalidatePath(list.route);
      revalidatePath(`${list.route}/[id]`, "page");
    }
  }
  return result;
}

export async function createFieldAction(objectKey: string, input: unknown): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminCreateField(user, objectKey, input), objectKey, true);
}

export async function updateFieldAction(objectKey: string, fieldKey: string, patch: unknown): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminUpdateField(user, objectKey, fieldKey, patch), objectKey, true);
}

export async function archiveFieldAction(objectKey: string, fieldKey: string): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminArchiveField(user, objectKey, fieldKey), objectKey, true);
}

export async function moveFieldAction(objectKey: string, fieldKey: string, delta: -1 | 1): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminMoveField(user, objectKey, fieldKey, delta), objectKey, true);
}

export async function saveFormDraftAdminAction(objectKey: string, formKey: string, schema: unknown): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminSaveFormDraft(user, objectKey, formKey, schema), objectKey, false);
}

export async function publishFormAdminAction(objectKey: string, formKey: string): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminPublishForm(user, objectKey, formKey), objectKey, true);
}

export async function saveListDraftAdminAction(objectKey: string, viewKey: string, schema: unknown): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminSaveListDraft(user, objectKey, viewKey, schema), objectKey, false);
}

export async function publishListAdminAction(objectKey: string, viewKey: string): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminPublishList(user, objectKey, viewKey), objectKey, true);
}

export async function saveStatusOverridesAdminAction(objectKey: string, fieldKey: string, rows: unknown): Promise<AdminWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminSaveStatusOverrides(user, objectKey, fieldKey, rows), objectKey, true);
}
