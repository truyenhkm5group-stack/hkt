"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════ LÀM MỚI SỐ LIỆU MÀ KHÔNG TẢI LẠI CẢ TRANG ═══════
 *
 * Bấm F5 thì trình duyệt dựng lại TOÀN BỘ ứng dụng: mất vị trí cuộn, đóng mọi hộp thoại đang mở,
 * tải lại khung sườn, thanh bên, phông chữ — trong khi thứ duy nhất người dùng muốn là mấy con số.
 * `router.refresh()` của Next chỉ lấy lại phần máy chủ dựng (Server Component) cho ĐÚNG địa chỉ
 * đang mở, giữ nguyên URL, bộ lọc, kỳ báo cáo và vị trí cuộn.
 *
 * ─── VÌ SAO PHẢI XOÁ ĐỆM TRƯỚC, KHÔNG CHỈ GỌI router.refresh() ───
 *
 * Báo cáo nặng đi qua `memo()` với TTL 60–120 giây. Chỉ dựng lại trang thì truy vấn vẫn TRÚNG đệm
 * và trả về ĐÚNG con số cũ — người dùng bấm "Làm mới", màn hình nháy một cái rồi vẫn y nguyên, và
 * họ kết luận nút không chạy. Một nút làm mới mà không làm mới là tệ hơn không có nút.
 *
 * ─── VÌ SAO XOÁ HẲN (clearMemo) CHỨ KHÔNG ĐÁNH DẤU CŨ (staleMemo) ───
 *
 * `staleMemo()` trả NGAY số cũ rồi tính lại phía sau — đúng cho JOB NỀN, vì không ai ngồi chờ job.
 * Ở đây thì có: một người vừa bấm và đang nhìn màn hình. Trả lại đúng số cũ cho chính cú bấm ấy là
 * trả lời sai câu hỏi họ vừa hỏi. `lib/cache.ts` đã khai sẵn ranh giới này: NGƯỜI bấm ⇒ xoá hẳn,
 * họ chấp nhận chờ vì chủ động yêu cầu.
 *
 * ─── VÌ SAO XOÁ TOÀN BỘ CHỨ KHÔNG RIÊNG BÁO CÁO CỦA TRANG ĐANG MỞ ───
 *
 * Xoá riêng thì phải có một bảng tra "trang nào dùng những khoá đệm nào". Bảng đó KHÔNG có cách nào
 * tự đúng: thêm một truy vấn `memo()` vào một trang mà quên khai là nút làm mới của trang đó lặng
 * lẽ bỏ sót đúng con số vừa thêm — hỏng theo kiểu không ai phát hiện ra. Xoá toàn bộ thì luôn đúng,
 * và giá phải trả là lượt đọc kế tiếp của các trang KHÁC bị tính nguội — đúng bằng cái giá mà mọi
 * thao tác ghi (qua `audit()`) vẫn trả hằng ngày.
 *
 * Không ghi `audit()`: đây là thao tác ĐỌC, không đổi một dòng dữ liệu nào. Ghi sổ mỗi cú bấm làm
 * mới chỉ nhấn chìm nhật ký kiểm toán bằng tiếng ồn. Cũng không `revalidatePath`: chính lượt
 * `router.refresh()` phía trình duyệt đã lấy lại đúng địa chỉ đang mở.
 */
export async function refreshReportData(): Promise<{ at: number } | { error: string }> {
  // Ai đăng nhập cũng được phép: mọi thao tác ghi của họ vốn đã xoá đệm qua `audit()`, nên nút này
  // không mở thêm một cánh cửa nào. Không đăng nhập thì nói thẳng lý do thay vì im lặng không đổi.
  const user = await getCurrentUser();
  if (!user) return { error: "Phiên đăng nhập đã hết hạn — đăng nhập lại để lấy số mới." };
  clearMemo();
  return { at: Date.now() };
}
