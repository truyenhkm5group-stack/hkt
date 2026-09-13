/**
 * ═══════════ CHUẨN UX BẢNG DÙNG CHUNG CHO TOÀN ERP ═══════════
 *
 * Đặt ở `lib/constants/*` chứ KHÔNG ở `components/ui/table.tsx`, vì tệp đó mang `"use client"`:
 * một giá trị đi qua ranh giới đó, nhìn từ phía máy chủ, là **proxy tham chiếu chứ không phải
 * chuỗi thật** — nối vào `className` sẽ ra rác chứ không ra CSS. `tests/client-boundary-exports.test.ts`
 * khoá đúng chỗ này. Ở đây thì cả Server Component lẫn Client Component cùng import được.
 *
 * ─── MỐC DÍNH PHỤ THUỘC AI ĐANG CUỘN ───
 *
 * `position: sticky` dính trong KHUNG CUỘN GẦN NHẤT, nên có đúng hai tình huống và hai mốc:
 *
 *   · bảng tự có khung cuộn dọc (chỗ gọi đặt trần chiều cao) ⇒ mốc `0`;
 *   · bảng cuộn theo CẢ TRANG ⇒ mốc `3.5rem`, đúng chiều cao thanh tiêu đề ứng dụng
 *     (`components/site-header.tsx`: `sticky top-0 h-14`). Để `0` ở đây thì tiêu đề cột trượt
 *     XUỐNG DƯỚI thanh đó rồi biến mất — đúng lỗi mà tính năng này sinh ra để sửa.
 *
 * Biến CSS `--table-head-top` do khung bao đặt; lớp dưới đây chỉ ĐỌC nó, nên không cần biết mình
 * đang nằm trong loại khung nào. Mặc định `3.5rem` là trường hợp phổ biến (danh sách toàn trang).
 *
 * `z-10` cố ý THẤP HƠN `z-20` của thanh tiêu đề ứng dụng: tiêu đề cột không bao giờ đè lên thanh
 * điều hướng. Dropdown/popover render ở portal nên nằm ở tầng khác hẳn, không va chạm.
 */
export const STICKY_HEAD =
  "[&_th]:sticky [&_th]:top-[var(--table-head-top,3.5rem)] [&_th]:z-10 [&_th]:bg-table-head [&_th]:after:absolute [&_th]:after:inset-x-0 [&_th]:after:bottom-0 [&_th]:after:h-px [&_th]:after:bg-border";

/** Chiều cao thanh tiêu đề ứng dụng — khai một lần để mốc dính và mốc khác không lệch nhau. */
export const APP_HEADER_OFFSET = "3.5rem";
