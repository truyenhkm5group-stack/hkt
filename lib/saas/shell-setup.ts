import type { SessionUser } from "@/lib/auth/session";
import { memo } from "@/lib/cache";
import { salesAgentHomeFor } from "@/lib/constants/saas-nav";
import { withOrganization } from "@/lib/platform/context";

/**
 * ═══════════ TRANG NHÀ CỦA VỎ CHỐT ĐƠN KHI CỬA HÀNG CHƯA THIẾT LẬP XONG — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop 10/10/2026: «một khách low-tech sau đăng nhập phải thấy đúng một danh sách thiết lập». Tech Lead chốt: danh sách «giá
 * trị đầu tiên» CHƯA đủ 9/9 ⇒ người vỏ về «Tổng quan» (nơi đứng danh sách); đủ ⇒ hộp thư như #638.
 *
 * Câu hỏi «đã xong chưa» dùng ĐÚNG `loadFirstValue` (lib/onboarding/go-live.ts) — không định nghĩa thứ hai — và chỉ được hỏi ở
 * HAI cửa vào: sau đăng nhập / đăng ký (`landingAfterSignIn`) và khi mở `/` (`requireUser`, lượt cổng vỏ chuyển hướng). Điều hướng
 * thường không bao giờ đi qua đây. Đệm 60 giây theo người dùng: bấm thương hiệu liên tục không chạy lại mười mấy câu đếm.
 *
 * HỎNG VỀ PHÍA CŨ: đọc lỗi ⇒ `false` ⇒ hộp thư (hành vi trước bản này), không bao giờ làm hỏng lượt đăng nhập. Người không thấy
 * danh sách (không nối kênh được, không cấu hình bot được) ⇒ `show = false` ⇒ hộp thư.
 *
 * `loadFirstValue` nạp ĐỘNG: go-live.ts kéo lib/auth/session.ts, mà session.ts gọi tệp này lúc chuyển hướng — nạp tĩnh là vòng.
 */
export const SHELL_SETUP_CACHE_MS = 60_000;

/** Danh sách đang mở (người xem thấy nó và chưa xong) — điều kiện duy nhất để về «Tổng quan». HÀM THUẦN. */
export function firstValueSetupOpen(v: { show: boolean; allDone: boolean } | null): boolean {
  return Boolean(v?.show && !v.allDone);
}

export async function shellSetupOpen(user: SessionUser, opts: { cacheMs?: number } = {}): Promise<boolean> {
  const code = user.organization?.code;
  if (!code || user.organization?.isHome) return false;
  const cacheMs = opts.cacheMs ?? SHELL_SETUP_CACHE_MS;
  try {
    const read = async () => {
      const { loadFirstValue } = await import("@/lib/onboarding/go-live");
      return firstValueSetupOpen(await loadFirstValue(user));
    };
    return await withOrganization(code, () => (cacheMs > 0 ? memo(`shell-setup-open:${user.id}`, cacheMs, read) : read()));
  } catch (error) {
    console.warn(`[vo-chot-don] không đọc được trạng thái thiết lập — về hộp thư như cũ: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Trang nhà của người vỏ ở hai cửa vào (sau đăng nhập · mở `/`). Người gọi đảm bảo `user` thuộc vỏ. */
export async function shellLandingFor(user: SessionUser, opts: { cacheMs?: number } = {}): Promise<string> {
  return salesAgentHomeFor(user, { setupOpen: await shellSetupOpen(user, opts) });
}
