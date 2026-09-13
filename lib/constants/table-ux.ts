/**
 * ═══════════ CHUẨN UX BẢNG DÙNG CHUNG CHO TOÀN ERP ═══════════
 *
 * Đặt ở `lib/constants/*` chứ KHÔNG ở `components/ui/table.tsx`, vì tệp đó mang `"use client"`:
 * một giá trị đi qua ranh giới đó, nhìn từ phía máy chủ, là **proxy tham chiếu chứ không phải
 * chuỗi thật** — nối vào `className` sẽ ra rác chứ không ra CSS. `tests/client-boundary-exports.test.ts`
 * khoá đúng chỗ này. Ở đây thì cả Server Component lẫn Client Component cùng import được.
 *
 * ─── HỢP ĐỒNG TIÊU ĐỀ CỘT DÍNH (13/09/2026) ───
 *
 * `position: sticky` dính vào KHUNG CUỘN GẦN NHẤT. Khung bao bảng nào cũng phải cuộn ngang được
 * (`overflow-x: auto`), và theo đặc tả CSS thì một khung đã cuộn ngang sẽ TỰ ĐỘNG thành khung cuộn
 * dọc (`overflow-y` không thể là `visible` nữa). Hệ quả đo được bằng Chromium:
 *
 *   · `th { top: 3.5rem }` trong khung `overflow-x-auto` KHÔNG dính theo trang, mà bị đẩy XUỐNG
 *     3.5rem ngay từ lúc tải — tiêu đề đè lên hai dòng dữ liệu đầu tiên (lỗi thấy ở /shipments,
 *     /reports/returns và mọi bảng ngắn);
 *   · cuộn trang thì tiêu đề trôi mất cùng bảng, vì trang không phải scrollport của nó.
 *
 * Nên chỉ có MỘT mô hình đúng: **khung bao bảng là khung cuộn hai chiều có trần chiều cao**, và
 * tiêu đề dính ở mốc `0` của chính khung đó. Không có "mốc theo thanh tiêu đề ứng dụng" — mốc ấy
 * chỉ đúng khi bảng không có khung cuộn ngang, mà bảng ERP thì luôn cần.
 *
 * Ba biến CSS khai ở `app/globals.css` (`:root`) — không hard-code rem ở từng trang:
 *   `--app-header-height`  chiều cao thanh tiêu đề ứng dụng (site-header đọc nó);
 *   `--table-max-height`   trần chiều cao khung bảng: một khung nhìn trừ thanh tiêu đề ứng dụng và
 *                          chỗ cho thanh phân trang. Trang vẫn cuộn được nên người dùng luôn kéo
 *                          được đỉnh bảng lên sát thanh tiêu đề — lúc đó cả bảng lẫn phân trang vừa
 *                          khít một màn hình. Sàn 20rem để màn hình thấp vẫn dùng được;
 *   `--table-head-top`     mốc dính của `th` trong khung — mặc định `0px`; chỗ gọi có thanh công cụ
 *                          dính BÊN TRONG cùng khung cuộn mới cần đổi.
 *
 * `z-10` cố ý THẤP HƠN `z-20` của thanh tiêu đề ứng dụng và thấp hơn mọi portal (dropdown, popover,
 * dialog ở z-50): tiêu đề cột không bao giờ che thanh điều hướng lẫn menu đang mở.
 *
 * Nền `bg-table-head` là màu ĐẶC (không alpha, không backdrop-blur) — chữ của dòng dưới không được
 * xuyên qua tiêu đề. Đường kẻ dưới dùng `box-shadow` thay cho `border-bottom`: với `border-collapse`
 * viền của ô dính bị bỏ lại phía sau khi cuộn, còn bóng thì đi cùng ô.
 */
export const STICKY_HEAD =
  "[&_th]:sticky [&_th]:top-[var(--table-head-top,0px)] [&_th]:z-10 [&_th]:bg-table-head [&_th]:shadow-[inset_0_-1px_0_0_var(--color-border)]";

/**
 * Khung cuộn bao quanh bảng — cuộn cả hai chiều, trần chiều cao theo biến chung. Bảng ngắn hơn
 * trần thì không thấy thanh cuộn và trang cuộn bình thường; bảng dài thì tự cuộn bên trong và tiêu
 * đề dính ở mép trên. Cố ý KHÔNG đặt `overscroll-contain`: tới đáy bảng thì con lăn phải tiếp tục
 * cuộn trang (báo cáo có 4–6 bảng xếp dọc, nếu mỗi bảng "nuốt" con lăn thì đọc rất khổ).
 */
export const TABLE_SCROLL = "relative w-full overflow-auto max-h-[var(--table-max-height)]";

/** Khung chỉ cuộn NGANG, không có trần chiều cao — cho bảng in / bảng lồng trong ô. Tiêu đề không dính. */
export const TABLE_FLOW = "relative w-full overflow-x-auto";

/** Chiều cao thanh tiêu đề ứng dụng — biến CSS khai ở globals.css; mọi thứ dính "ngay dưới thanh" phải đọc nó. */
export const APP_HEADER_OFFSET = "var(--app-header-height)";

/**
 * Lớp cho THANH CÔNG CỤ / THANH HÀNH ĐỘNG HÀNG LOẠT dính ngay dưới thanh tiêu đề ứng dụng (cuộn theo
 * trang, không nằm trong khung bảng). `z-10` THẤP HƠN thanh tiêu đề (`z-20`) và đứng sau `th` trong
 * DOM nên vẽ đè lên tiêu đề cột; dropdown/popover là portal ở `z-50` nên không cần nâng nữa.
 */
export const STICKY_TOOLBAR = "sticky top-[var(--app-header-height)] z-10";
