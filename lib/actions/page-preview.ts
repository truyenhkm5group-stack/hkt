"use server";

import { requirePermission } from "@/lib/auth/session";
import { previewBlock, type PreviewBlockResult } from "@/lib/pages/preview";

/**
 * ═══════════ XEM TRƯỚC MỘT KHỐI CỦA TRÌNH KÉO-THẢ (Phase 5 §3) ═══════════
 *
 * `metadata:manage` ở cửa (phiên), rồi lõi `previewBlock` kiểm lại lần hai + trang thuộc tổ chức hiện hành + kiểm
 * khối + phân giải theo người soạn. Không ghi, không `revalidatePath`: xem trước không đổi gì.
 */
export async function previewPageBlock(pageId: string, block: unknown): Promise<PreviewBlockResult> {
  const user = await requirePermission("metadata:manage");
  return previewBlock(pageId, block, user);
}
