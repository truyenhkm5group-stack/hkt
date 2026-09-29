/**
 * ═══════════ LIÊN KẾT MỜI — NƠI DUY NHẤT DỰNG NÓ ═══════════
 *
 * Mọi chỗ cần liên kết `/join/<mã tổ chức>/<mã mời>` gọi `inviteLinkFor()`; không nơi nào tự nối chuỗi. Ngày liên kết
 * chuyển sang tên miền con của tổ chức (`<domain_slug>.<tên miền nền tảng>`), chỉ tệp này đổi.
 *
 * Mã tổ chức nằm trong ĐƯỜNG DẪN vì trang nhận lời mời chạy KHÔNG có phiên: không có nó thì máy chủ phải đoán CSDL nào
 * — và đoán về tổ chức nhà là mặc định nguy hiểm nhất (lib/platform/context.ts). Mã thô chỉ đi trong liên kết này, chỉ
 * hiện một lần; CSDL giữ băm của nó.
 */
import { env } from "@/lib/env";

export const JOIN_PATH = "/join";

/**
 * `baseUrl` = gốc URL của tổ chức (0180): tên miền con khi tổ chức ĐÃ XUẤT BẢN (`organizationBaseUrl`), còn lại `APP_URL`.
 * Người được mời mở đúng ERP của tổ chức — trên tên miền con phiên bị gắn với host đó (lib/platform/host-org.ts).
 */
export function inviteLinkFor(orgCode: string, token: string, baseUrl: string = env.appUrl): string {
  return `${baseUrl.replace(/\/+$/, "")}${JOIN_PATH}/${encodeURIComponent(orgCode)}/${encodeURIComponent(token)}`;
}
