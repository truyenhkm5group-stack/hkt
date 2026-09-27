"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { adminArchivePage, adminCreatePage, adminCreatePageFromTemplate, adminPublishPage, adminSavePageDraft, adminUpdatePageMeta } from "@/lib/platform-ui/page-admin";
import type { PageWriteResult } from "@/lib/platform-ui/page-admin-shared";

/**
 * ═══════════ SERVER ACTION CỦA TRÌNH SOẠN TRANG TUỲ BIẾN (Phase 4) ═══════════
 *
 * MỘT lớp action duy nhất cho `/settings/pages` (cùng quyết định với metadata Phase 2 và luật tự động Phase 3):
 * mỗi action chỉ đọc phiên (`requirePermission("metadata:manage")`) → lõi `lib/platform-ui/page-admin.ts` (kiểm
 * quyền LẦN HAI, phiên phải mang tổ chức, rồi mới gọi `lib/pages/*` — nơi DUY NHẤT ghi `meta_pages`) →
 * `revalidatePath`. Người thao tác lấy từ PHIÊN (luật 34). Lỗi nghiệp vụ trả `{ ok: false, errors }`, không ném.
 * KHÔNG `router.refresh()` phía client — hai cơ chế là dựng hai lần (PR #272).
 *
 * `runtime`: lượt ghi đổi thứ NGƯỜI DÙNG thấy (xuất bản, lưu trữ, thông tin trang — tên, menu) ⇒ dựng lại trang
 * `/p/[slug]` và bố cục (menu động, G12). Lưu NHÁP thì không: người dùng chưa thấy gì.
 */

const LIST_PATH = "/settings/pages";

function refresh(result: PageWriteResult, runtime: boolean): PageWriteResult {
  if (!result.ok) return result;
  revalidatePath(LIST_PATH);
  revalidatePath(`${LIST_PATH}/${encodeURIComponent(result.id)}`);
  if (runtime) {
    revalidatePath("/p/[slug]", "page");
    revalidatePath("/", "layout");
  }
  return result;
}

/** Tạo trang trống — sinh ở NHÁP. */
export async function createPageAction(input: unknown): Promise<PageWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminCreatePage(user, input), false);
}

/** Tạo trang từ mẫu — chỉ khi người bấm (luật 23), sinh ở NHÁP. */
export async function createPageFromTemplateAction(templateKey: string): Promise<PageWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminCreatePageFromTemplate(user, templateKey), false);
}

/** Tên, đường dẫn (khoá sau lần xuất bản đầu), module chủ, quyền xem, menu. */
export async function updatePageMetaAction(id: string, input: unknown): Promise<PageWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminUpdatePageMeta(user, id, input), true);
}

/** Lưu NHÁP nội dung (section → khối). */
export async function savePageDraftAction(id: string, schema: unknown): Promise<PageWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminSavePageDraft(user, id, schema), false);
}

/** Xuất bản bản nháp ĐÃ LƯU — người dùng thấy ở lần tải kế tiếp, không deploy. */
export async function publishPageAction(id: string): Promise<PageWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminPublishPage(user, id), true);
}

/** Lưu trữ — trang rời menu và không mở được ở `/p/<slug>`. */
export async function archivePageAction(id: string): Promise<PageWriteResult> {
  const user = await requirePermission("metadata:manage");
  return refresh(await adminArchivePage(user, id), true);
}
