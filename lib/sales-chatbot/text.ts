/**
 * Chữ của chatbot bán hàng — HÀM THUẦN, không đọc CSDL (client import được). Danh mục (`catalog.ts`) và câu trả lời mẫu
 * (`quick-replies-shared.ts`) dùng CHUNG một cách bỏ dấu, để «cha muc» khớp «Chả mực» ở cả hai nơi như nhau.
 */

/** Bỏ dấu tiếng Việt + chữ thường + gộp khoảng trắng — so khớp tên khách gõ ("cha muc") với tên sản phẩm ("Chả mực"). */
export function foldVi(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}
