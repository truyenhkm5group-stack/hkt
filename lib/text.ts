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

/** Bỏ thẻ HTML và giải mã vài thực thể phổ biến (tin nhắn Pancake có thể bọc trong <div>) */
export function stripHtml(text: string) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
