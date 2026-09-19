/**
 * ═══════════ TÊN GIỮ CHỖ KHÔNG ĐƯỢC TRÔNG NHƯ MỘT CÁI TÊN ═══════════
 *
 * Pancake điền sẵn `"Khách hàng <số điện thoại>"` vào ô người mua khi đơn được tạo mà chưa ai hỏi
 * tên. Chuỗi đó đi thẳng vào `orders.bill_full_name`, rồi lên màn hình ở đúng chỗ dành cho tên
 * thật — và người trực đọc "Khách hàng 0984107775" như thể đó là tên khách đã biết.
 *
 * Hậu quả không nằm ở thẩm mỹ. Nó nằm ở chỗ ĐỘ PHỦ TÊN KHÁCH trông đầy trong khi thật ra rỗng:
 * không ai đi hỏi tên vì màn hình đã có "tên", và bưu tá gọi tới nơi không biết gọi ai.
 *
 * ─── HAI ĐIỀU HÀM NÀY CỐ Ý KHÔNG LÀM ───
 *
 *  1. KHÔNG ĐOÁN TÊN. Không suy từ tên tài khoản Facebook, không lấy tên người nhận của đơn khác
 *     cùng số điện thoại. Chưa biết thì in ra là chưa biết (luật 42: CHƯA BIẾT ≠ 0, và ở đây
 *     CHƯA BIẾT ≠ một cái tên).
 *  2. KHÔNG GHI ĐÈ DỮ LIỆU. Chuỗi gốc vẫn nguyên trong `orders`; đây chỉ là cách BÀY ra màn hình.
 *     Xoá nó đi là mất bằng chứng rằng Pancake đã điền gì.
 *
 * Hàm THUẦN, không đọc CSDL, nên cả máy chủ lẫn trình duyệt gọi được và kiểm thử được.
 */

/**
 * Các mẫu giữ chỗ ĐÃ QUAN SÁT ĐƯỢC. Danh sách này chỉ được nới ra khi nhìn thấy một mẫu thật trên
 * production — đoán thêm một mẫu là rủi ro giấu mất một cái tên có thật (một khách tên "Khách" là
 * chuyện hiếm, nhưng một khách tên "Chị Khách Hàng" thì không).
 */
const PLACEHOLDER_PREFIXES = ["khách hàng", "khach hang", "khách", "khach"] as const;

/** Chỉ còn chữ số — để so tên với số điện thoại mà không vướng dấu cách, dấu chấm, dấu ngoặc. */
function digitsOf(value: string): string {
  return value.replace(/\D+/g, "");
}

/**
 * Tên này có phải Pancake điền hộ không?
 *
 * ĐÚNG khi: tên rỗng · tên CHỈ là một dãy số · tên là "<tiền tố giữ chỗ> <dãy số>" và dãy số đó
 * chính là số điện thoại của đơn (hoặc, khi không truyền số điện thoại, là một dãy số đủ dài để
 * không thể là một phần của tên người).
 */
export function isPlaceholderCustomerName(name: string | null | undefined, phone?: string | null): boolean {
  const ten = (name ?? "").trim();
  if (!ten) return true;

  const soTrongTen = digitsOf(ten);
  const soDienThoai = digitsOf(phone ?? "");

  // "0984107775" đứng một mình ở ô tên: đó là số điện thoại bị chép nhầm chỗ, không phải tên.
  if (soTrongTen.length >= 9 && soTrongTen === digitsOf(ten.replace(/[\s.+()-]/g, ""))) {
    if (!/[a-zà-ỹ]/i.test(ten)) return true;
  }

  const thuong = ten.toLowerCase();
  const tienTo = PLACEHOLDER_PREFIXES.find((p) => thuong.startsWith(p));
  if (!tienTo) return false;

  // Phần còn lại sau tiền tố phải là MỘT DÃY SỐ. "Khách Hương" không phải giữ chỗ.
  const con = ten.slice(tienTo.length).trim();
  if (!con || !/^[\d\s.+()-]+$/.test(con)) return false;
  const soCon = digitsOf(con);
  if (!soCon) return false;
  return soDienThoai ? soCon === soDienThoai : soCon.length >= 9;
}

/** Nhãn in ra khi chưa biết tên — một câu, dùng ở mọi màn hình để không có hai cách nói. */
export const NO_CUSTOMER_NAME_LABEL = "Chưa có tên";

/**
 * Tên để HIỂN THỊ + cờ cho màn hình biết có nên bày nó như một cái tên hay không.
 *
 * Trả về cả `raw` để nơi cần vẫn tra được Pancake đã điền gì — giấu hẳn đi là làm người đọc không
 * đối chiếu được với màn hình Pancake đang mở bên cạnh.
 */
export function customerNameForDisplay(name: string | null | undefined, phone?: string | null): { text: string; isPlaceholder: boolean; raw: string } {
  const raw = (name ?? "").trim();
  return isPlaceholderCustomerName(raw, phone) ? { text: NO_CUSTOMER_NAME_LABEL, isPlaceholder: true, raw } : { text: raw, isPlaceholder: false, raw };
}
