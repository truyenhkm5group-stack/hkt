/**
 * ═══════════ CÁCH BÀY HÀNH TRÌNH ĐVVC — TRÌNH BÀY, KHÔNG PHẢI PHÉP ĐO ═══════════
 *
 * Hai hàm ở đây chỉ quyết định MÀU CHỮ và có vẽ được nút gọi bưu tá hay không. Không hàm nào tham
 * gia vào một phép tính nghiệp vụ, không hàm nào ghi gì, và không hàm nào được dùng để KẾT LUẬN một
 * kiện đã giao hay đã hoàn — kết luận đó chỉ có một chỗ (`ORDER_OUTCOME`), và luật 47 cấm trộn lời
 * khai của ĐVVC với kết luận của ERP.
 *
 * Tách khỏi component vì hai lý do: kiểm thử gọi thẳng được (không phải dựng React), và ranh giới
 * client/server không bị một tệp "use client" kéo vào bài kiểm chạy bằng `tsx`.
 */

/**
 * BƯU TÁ ĐỌC RA TỪ CÂU CHỮ, KHÔNG PHẢI MỘT CỘT DỮ LIỆU.
 *
 * Viettel Post nhét tên và số bưu tá vào giữa câu trạng thái ("Phân công phát - Bưu tá: Nguyễn
 * Thanh Phong - 0394154474"). ERP KHÔNG tách nó thành cột: làm vậy là biến một câu chữ tự do thành
 * một trường dữ liệu mà không ai bảo đảm định dạng, và lần ĐVVC đổi cách viết là cột đó im lặng
 * rỗng — một ô trống trông y hệt "kiện này không có bưu tá".
 *
 * Ở đây chỉ là TRÌNH BÀY: nhận ra một số điện thoại trong câu để bấm gọi được. Không nhận ra thì
 * câu vẫn hiện nguyên văn và không có nút gọi — không mất gì, và không bịa ra một cái tên rỗng.
 */
export function parseCourier(text: string): { name: string; phone: string } | null {
  const m = /Bưu tá:\s*([^-–]+?)\s*[-–]\s*(0\d{8,10})/.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  return { name, phone: m[2] };
}

/**
 * Sự kiện nào đáng dừng mắt lại. Dò trên CÂU CHỮ vì đây là dòng chữ ĐVVC gửi tới — và đúng dòng chữ
 * đó là thứ người trực đang đọc. Không dò ra thì không tô màu, KHÔNG đoán: một hành trình bị tô
 * lung tung là hành trình người ta thôi không đọc màu nữa.
 */
export function journeyTone(status: string): string {
  const t = status.toLowerCase();
  if (t.includes("không thành công") || t.includes("thất bại") || t.includes("không liên lạc") || t.includes("từ chối")) return "text-rose-700 dark:text-rose-300";
  if (t.includes("thành công")) return "text-emerald-700 dark:text-emerald-300";
  if (t.includes("hoàn") || t.includes("huỷ") || t.includes("hủy") || t.includes("tiêu huỷ")) return "text-orange-700 dark:text-orange-300";
  if (t.includes("hẹn") || t.includes("phát lại")) return "text-amber-700 dark:text-amber-300";
  return "";
}
