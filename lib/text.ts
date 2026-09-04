/** Chuẩn hoá chuỗi để so khớp: chữ thường, bỏ dấu tiếng Việt, đ→d, ký tự khác → khoảng trắng, bọc bởi khoảng trắng để so khớp trọn từ */
export function normalize(text: string) {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}
