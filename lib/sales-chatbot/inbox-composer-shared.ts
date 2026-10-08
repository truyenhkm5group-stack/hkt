/**
 * ═══════════ CÔNG CỤ Ô SOẠN HỘP THƯ — PHẦN THUẦN (client import được) ═══════════
 *
 * Trần từ khoá + phép chèn chữ vào ô soạn. Máy chủ (`inbox-composer.ts`) và trang (`composer-tools.tsx`, `thread-view.tsx`) dùng
 * CHUNG tệp này — không gõ lại con số ở hai nơi, và bài kiểm không phải import một module "use client". Không đọc CSDL.
 */

export const COMPOSER_QUERY = {
  /**
   * Từ khoá tìm SẢN PHẨM tối thiểu (sau khi bỏ khoảng trắng hai đầu). Mỗi lượt tìm đọc cả danh mục bán được của bot; một ký tự
   * là gần như cả danh mục, và Next xếp hàng server action tuần tự nên lượt tìm thừa làm chậm cả nút «Gửi».
   */
  productMin: 2,
  /** Trần từ khoá — cùng trần với công cụ `search_products` của bot. */
  max: 200,
} as const;

/**
 * Chèn một đoạn vào chữ đang soạn — HÀM THUẦN. Đoạn thay vùng đang chọn (`start..end`; con trỏ khi hai số bằng nhau) và đứng trên
 * DÒNG RIÊNG: chữ liền trước / liền sau không phải dấu xuống dòng thì thêm một dấu — câu mẫu hay dòng sản phẩm không dính vào giữa
 * câu đang gõ. Vị trí vượt độ dài thì kẹp về cuối. Trả chữ mới + vị trí con trỏ ngay sau đoạn vừa chèn.
 */
export function insertIntoDraft(text: string, start: number, end: number, snippet: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const before = text.slice(0, s);
  const after = text.slice(e);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after && !after.startsWith("\n") ? "\n" : "";
  return { text: `${before}${lead}${snippet}${trail}${after}`, caret: before.length + lead.length + snippet.length };
}
