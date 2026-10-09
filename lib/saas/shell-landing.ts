import { safeNextPath } from "@/lib/auth/safe-redirect";
import { resolveCurrentUser } from "@/lib/auth/session";
import { isSalesAgentUser, SALES_AGENT_INBOX_HREF, salesAgentHomeOfRedirect, salesAgentPathAllowed } from "@/lib/constants/saas-nav";
import { shellLandingFor } from "@/lib/saas/shell-setup";

/**
 * ═══════════ ĐÍCH SAU ĐĂNG NHẬP / ĐĂNG KÝ — MỘT BƯỚC, TỚI TRANG DỰNG ĐƯỢC ═══════════
 *
 * F-01 (docs/saas/SHELL_AUDIT_2026-10-08.md): người thuộc vỏ Chốt Đơn đăng nhập / đăng ký xong thấy TRANG TRẮNG, trình duyệt
 * `history.replaceState` cùng một URL hàng nghìn lần. Cơ chế (đã truy trong Next 15.5.25 và đo bằng trình duyệt):
 *
 *  1. Server action `redirect(X)` ⇒ máy chủ tự xin RSC của X ngay trong lượt POST (`createRedirectRenderResult`) và XOÁ header
 *     `Next-Router-State-Tree` ⇒ X được dựng TỪ GỐC, kể cả layout `(dashboard)`.
 *  2. X = `/` mà người dùng thuộc vỏ ⇒ chính LAYOUT `(dashboard)` (`requireUser()` → `SHELL_RESTRICTED`) ném
 *     `redirect(hộp thư)`. Phản hồi action mang lỗi `NEXT_REDIRECT;replace;/ai/sales-chatbot/inbox` ở ĐÚNG nút cache của layout.
 *  3. `RedirectBoundary` của client bắt lỗi ⇒ `router.replace(hộp thư)`. Hộp thư dùng CHUNG layout `(dashboard)` nên client chỉ
 *     xin phần DƯỚI layout; máy chủ không dựng lại layout ⇒ nút layout hỏng được giữ nguyên, dựng lại lại ném đúng lỗi đó ⇒
 *     `router.replace` lần nữa — lấy từ cache điều hướng (`staleTimes.dynamic`), không request nào ⇒ vòng lặp chỉ còn
 *     `replaceState`, màn trắng vì ranh giới vẽ `null` thay cho cả layout.
 *
 * Nên đích cuối phải được tính NGAY TRONG ACTION: người thuộc vỏ đi thẳng tới trang nhà của vỏ (hoặc `next` mà vỏ mở được),
 * không bao giờ qua một trang mà LAYOUT sẽ chuyển hướng. Không có luật thứ hai: an toàn đường dẫn = `safeNextPath`, «thuộc vỏ»
 * và «trang nhà» = câu trả lời của chính cổng vỏ (`resolveCurrentUser`), trang mở được = `salesAgentPathAllowed`.
 *
 * Cổng module của layout không cần hỏi lại ở đây: `ai_sales` phụ thuộc đủ bốn module lõi thương mại (khách · sản phẩm · đơn ·
 * kho), nên workspace còn là vỏ thì mọi trang vỏ mở được đều thuộc module đang bật (tests/shell-login-landing.test.ts khoá).
 */

/**
 * THUẦN. `shellHome = null` (không thuộc vỏ) ⇒ ĐÚNG `safeNextPath(next)` như trước bản này. Người thuộc vỏ: `next` giữ nguyên
 * khi vỏ mở được trang đó, còn lại (`/`, trang ERP, đường ngoài miền đã thành `/`) về trang nhà của vỏ. Kiểm vỏ trên chuỗi ĐÃ
 * chuẩn hoá: kiểm chuỗi thô thì `/ai/../cockpit` lọt tiền tố `/ai` rồi trình duyệt đi tới `/cockpit`.
 */
export function landingPath(rawNext: unknown, shellHome: string | null): string {
  const next = safeNextPath(rawNext);
  if (shellHome === null) return next;
  return salesAgentPathAllowed(next) ? next : shellHome;
}

/**
 * Trang nhà của vỏ cho PHIÊN VỪA MỞ, hoặc `null` = không thuộc vỏ. Gọi SAU `createSession`: trong server action, `cookies()`
 * đọc lại đúng cookie vừa ghi. Hỏi CHÍNH cổng vỏ, không tính quyền lần thứ hai: lượt POST tới `/login` · `/start` không phải
 * trang của vỏ nên người thuộc vỏ nhận `SHELL_RESTRICTED` kèm trang nhà của ĐÚNG người ấy và dấu «ngoài gói» — bỏ dấu, vì
 * đăng nhập không bị từ chối khỏi trang nào. Lý do từ chối khác (khoá, thu hồi, lệch host, khoá thu phí…) ⇒ `null` ⇒ hành vi
 * cũ, trang đích tự nói lý do của nó.
 */
export async function shellHomeOfSession(): Promise<string | null> {
  const ket = await resolveCurrentUser();
  // Cửa hàng chưa thiết lập xong ⇒ «Tổng quan» có danh sách thiết lập (chủ shop 10/10/2026, lib/saas/shell-setup.ts).
  if ("user" in ket) return isSalesAgentUser(ket.user) ? shellLandingFor(ket.user) : null;
  if (ket.denied !== "SHELL_RESTRICTED") return null;
  return ket.shellUser ? shellLandingFor(ket.shellUser) : salesAgentHomeOfRedirect(ket.home ?? SALES_AGENT_INBOX_HREF);
}

/** Đích chuyển hướng sau đăng nhập / đăng ký. Đọc vỏ hỏng ⇒ đi đích cũ (`safeNextPath`) — không bao giờ làm hỏng lượt đăng nhập. */
export async function landingAfterSignIn(rawNext: unknown): Promise<string> {
  let shellHome: string | null = null;
  try {
    shellHome = await shellHomeOfSession();
  } catch (error) {
    console.warn(`[dang-nhap] không đọc được vỏ của phiên vừa mở — đi đích cũ: ${error instanceof Error ? error.message : String(error)}`);
  }
  return landingPath(rawNext, shellHome);
}
