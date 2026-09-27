"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { executePageAction, type PageActionResult } from "@/lib/pages/actions";
import { getPageBySlug } from "@/lib/pages/registry";

/**
 * ═══════════ SERVER ACTION DUY NHẤT CỦA TRANG ĐỘNG (Phase 4 · G5) ═══════════
 *
 * Nút và kanban của `/p/[slug]` gọi đây với `(slug, blockId, input)` — trang máy chủ buộc sẵn `slug`
 * (`runPageAction.bind(null, slug)`), trình duyệt chỉ gửi `blockId` + đầu vào của lượt bấm. Người thao tác lấy từ
 * PHIÊN; cấu hình đọc lại từ bản ĐÃ XUẤT BẢN (`getPageBySlug`) theo `slug + blockId` — cấu hình phía client không
 * bao giờ được tin, và khối chỉ có trong bản nháp không tồn tại với lượt bấm này.
 *
 * Kết quả trả nguyên văn (`{ ok, error }`), không ném. Lượt thành công làm mới đúng trang đang mở để khối số liệu
 * đọc lại — KHÔNG `router.refresh()` phía client (dựng hai lần, PR #272).
 */
export async function runPageAction(slug: string, blockId: string, input: unknown): Promise<PageActionResult> {
  const user = await requireUser();
  const result = await executePageAction(slug, blockId, input, user, { loadPublished: getPageBySlug });
  if (result.ok && !result.redirectTo && typeof slug === "string" && /^[a-z][a-z0-9-]{1,60}$/.test(slug)) revalidatePath(`/p/${slug}`);
  return result;
}
