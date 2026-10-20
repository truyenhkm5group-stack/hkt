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

/**
 * Câu của một đoạn chữ bot — cắt ở «.» «!» «?» và xuống dòng, NHƯNG dấu chấm đứng TRƯỚC một chữ số không phải ranh giới câu (ngăn nghìn
 * «480.000 ₫», số lẻ «0.5kg»). Review giu-gio-ngoac-quy-cach (20/10/2026): cách cắt cũ (theo MỌI dấu chấm) tách «Tổng tiền 480.000 ₫»
 * thành «…480.» + «000 ₫», rồi nơi ghép lại (câu giữ đơn · bỏ câu hỏi lại SĐT / địa chỉ) gửi khách «480. 000». MỘT hàm cho mọi nơi tách
 * rồi GHÉP LẠI chữ gửi khách. Trả câu đã trim, bỏ câu rỗng. HÀM THUẦN.
 */
export function sentencesOf(text: string): string[] {
  return (text.match(/(?:[^.!?\n]|\.(?=\d))+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** Số chữ cái / chữ số TỐI THIỂU của một lời trích sau khi gấp dấu — dưới mức này lời trích không chứng minh được gì. */
export const QUOTE_MIN_ALNUM = 2;

/**
 * Lời model TRÍCH (`customer_confirmation`) có thật sự là NGUYÊN VĂN một đoạn trong câu của khách không — MỘT hàm cho chốt đơn,
 * đặt lịch và dùng địa chỉ cũ (review độc lập #664). Hai điều kiện, đo SAU khi chuẩn hoá NFC + gấp dấu:
 *  · còn ≥ `QUOTE_MIN_ALNUM` chữ cái / chữ số — «??», «...», emoji gấp ra chuỗi RỖNG, mà chuỗi rỗng thì luôn «nằm trong» mọi câu;
 *    «ừ» viết dạng tổ hợp (NFD) dài 3 ký tự thô nhưng chỉ còn 1 chữ;
 *  · khớp theo RANH GIỚI TỪ, không theo chuỗi con: «on» không khớp «không», «ok» không khớp «okie».
 * HÀM THUẦN.
 */
export function quotedInText(quote: string, text: string): boolean {
  const q = foldVi(quote.normalize("NFC"));
  if (q.replace(/[^a-z0-9]/g, "").length < QUOTE_MIN_ALNUM) return false;
  return ` ${foldVi(text.normalize("NFC"))} `.includes(` ${q} `);
}
