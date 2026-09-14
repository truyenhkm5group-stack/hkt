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

/**
 * ═══════════ DÒNG BUNG RA VÀ DÒNG ĐANG CHỌN — MỘT HỢP ĐỒNG, MỌI BẢNG DÙNG CHUNG ═══════════
 *
 * ─── LỖI ĐÃ ĐO ĐƯỢC ───
 *
 * Khối bung của bảng gom (CSKH theo khách, care theo kiện) dùng `bg-muted/30`. Ở CHẾ ĐỘ TỐI, nền
 * thẻ là `oklch(0.192 …)` còn `muted` ở 30% alpha gần như trùng với nó: người đọc không phân biệt
 * được đâu là dòng cha, đâu là danh sách con, và một bảng gom mà không thấy ranh giới gom thì
 * không hơn gì một bảng phẳng.
 *
 * ─── BỐN THỨ LÀM NÊN RANH GIỚI, KHÔNG PHẢI MỘT ───
 *
 *   1. NỀN khác hẳn (`--row-nested`, khai tường minh cho cả hai chế độ ở `app/globals.css`);
 *   2. THỤT VÀO + một đường dọc ở mép trái — mắt bắt được cấu trúc trước khi đọc chữ;
 *   3. ĐƯỜNG KẺ giữa các dòng con, nhạt hơn viền bao;
 *   4. TRẠNG THÁI DI CHUỘT riêng cho dòng con, khác dòng cha.
 *
 * Chỉ đổi nền là chưa đủ: một khối nền khác nhưng không thụt vào vẫn đọc như một dòng ngang hàng.
 */
export const ROW_EXPANDED = "bg-row-nested border-l-2 border-l-primary/40";

/** Một dòng CON bên trong khối bung. Đường kẻ dùng `border-t` để dòng đầu không có kẻ thừa. */
export const NESTED_ROW = "border-t border-[color:var(--hairline)] first:border-t-0 transition-colors hover:bg-row-hover";

/** Dòng đang được chọn (bấm hàng loạt). Màu riêng, KHÔNG dùng lại màu di chuột — chọn và rê chuột là hai trạng thái khác nhau. */
export const ROW_SELECTED = "bg-row-selected";

/** Dòng CHA của một nhóm bung được. Con trỏ tay + trạng thái di chuột, để người dùng biết bấm được. */
export const ROW_PARENT = "cursor-pointer transition-colors hover:bg-row-hover";

/**
 * ═══════════ CỘT HÀNH ĐỘNG GHIM Ở MÉP PHẢI ═══════════
 *
 * Một bảng HÀNG ĐỢI tồn tại để người ta bấm nút trên nó. Nếu cột nút trôi ra ngoài khung nhìn khi
 * màn hình hẹp — hoặc khi người dùng phóng to 110% để đọc cho đỡ mỏi mắt — thì thao tác nào cũng
 * tốn thêm một lần cuộn ngang, và người dùng quay lại làm bằng cách mở từng case.
 *
 * Đo được ở QA trình duyệt: ở mức phóng 110% (khung nhìn hiệu dụng ~1309px) cột hành động bị cắt
 * mất nút cuối. Thu hẹp các cột khác chỉ đẩy vấn đề sang mức phóng cao hơn — ghim mới là sửa.
 *
 * NỀN PHẢI ĐẶC. Ô ghim vẽ đè lên phần bảng đang trượt bên dưới nó; nền trong suốt thì chữ của cột
 * khác chạy xuyên qua nút. Và vì nền đặc che mất màu di chuột của dòng, ô ghim phải tự nhận màu đó
 * qua `group-hover` — nếu không, rê chuột lên dòng sẽ thấy một mảng lệch màu ở mép phải.
 *
 * `z-[5]` THẤP HƠN `z-10` của tiêu đề cột (tiêu đề không bị nút che khi cuộn dọc) và thấp hơn mọi
 * portal (dropdown, popover ở z-50).
 */
export const STICKY_ACTIONS = "sticky right-0 z-[5] bg-card group-hover:bg-row-hover shadow-[inset_1px_0_0_0_var(--color-border)]";

/** Bản cho ô tiêu đề của chính cột đó: nền của tiêu đề, không phải nền của dòng. */
export const STICKY_ACTIONS_HEAD = "sticky right-0 bg-table-head shadow-[inset_1px_0_0_0_var(--color-border)]";

/** Dòng đang chọn: ô ghim phải mang màu chọn, nếu không mép phải lệch màu với phần còn lại của dòng. */
export const STICKY_ACTIONS_SELECTED = "bg-row-selected group-hover:bg-row-selected";
