/**
 * ═══════════ MÀN HÌNH NÀO PHỤ THUỘC VÀO SỰ THẬT TỔ CHỨC ═══════════
 *
 * Đổi phòng ban / trưởng phòng / vai trò / chức danh / phạm vi của một người là đổi câu trả lời
 * của TẤT CẢ các màn dưới đây. Danh sách này là một hằng số dùng chung, không phải một mảng chép
 * đi chép lại trong từng server action.
 *
 * ─── VÌ SAO PHẢI LÀ MỘT DANH SÁCH DUY NHẤT ───
 *
 * Trước đó hai tệp server action mỗi tệp giữ một mảng riêng, và chúng đã lệch: cả hai đều quên
 * `/work/okr` và `/work/review`. Hậu quả không phải một lỗi — nó là một câu nói dối: chủ shop xếp
 * người vào phòng, mở màn Mục tiêu ra vẫn thấy tổ chức cũ, và kết luận rằng thao tác của mình đã
 * trượt. Rồi họ làm lại. Đúng cái vòng lặp đã sinh ra sự cố 12/09.
 *
 * `tests/org-membership.test.ts` khoá: mọi server action ghi sự thật tổ chức phải làm mới qua
 * hằng số này, không được tự liệt kê.
 */
export const ORG_DEPENDENT_PATHS = [
  "/work",
  "/work/today",
  "/work/department",
  "/work/all",
  "/work/performance",
  "/work/okr",
  "/work/review",
  "/work/settings",
  "/settings/users",
] as const;
