import { memo } from "@/lib/cache";
import { env } from "@/lib/env";
import { facebookErrorText, listTokenPages, type TokenPage } from "@/lib/integrations/facebook/ads-write";

/** Danh sách page của token + câu lỗi nếu không đọc được. `error = null` và `pages = []` khi môi trường không có token. */
export type TokenPagesRead = { pages: TokenPage[]; error: string | null };

/**
 * FANPAGE MÀ TOKEN ERP ĐƯỢC GIAO (`listTokenPages`), đệm 10 phút — danh sách giao page đổi theo giờ chứ không theo giây, và
 * mỗi lần mở hộp soạn bài / trang Video Scale không cần một lượt gọi Facebook. Lỗi KHÔNG làm hỏng trang: trả `error` để màn
 * hình nói ra, các ô chọn vẫn còn page của sổ fanpage. Lỗi không vào đệm (hàm ném thì `memo` không giữ).
 *
 * Nguồn thứ hai cạnh sổ `fanpages` (sổ chỉ có page TỪNG RA ĐƠN trên Pancake) — xem `mergeFanpageOptions`.
 */
export async function readTokenPages(): Promise<TokenPagesRead> {
  if (!env.facebook.accessToken) return { pages: [], error: null };
  try {
    return { pages: await memo("facebook:token-pages", 10 * 60_000, listTokenPages), error: null };
  } catch (e) {
    return { pages: [], error: facebookErrorText(e) };
  }
}

/** Tên Facebook của một page token ERP được giao; không có / không đọc được ⇒ `null`. */
export async function tokenPageName(pageId: string): Promise<string | null> {
  const id = pageId.trim();
  if (!id) return null;
  const hit = (await readTokenPages()).pages.find((p) => p.id === id);
  return hit?.name.trim() || null;
}
