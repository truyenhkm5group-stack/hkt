/**
 * ═══════ "KHOẢN CHI NÀY ĐÃ CÓ TIỀN THẬT NỐI VÀO CHƯA" — MỘT MỆNH ĐỀ, HAI MÀN HÌNH ═══════
 *
 * Hàng đợi tác vụ tài chính (`finance-ops.ts`) và Tổng quan tài chính (`finance-overview.ts`) cùng
 * hỏi câu này, và trước đây mỗi bên tự viết một truy vấn con. Hai bản giống nhau HÔM NAY, nhưng chỉ
 * cần một bên đổi sang đọc `linked_type/linked_id` (ảnh chụp mối nối lớn nhất) là hai màn hình đếm
 * ra hai con số cho cùng một hàng đợi — đúng loại lệch mà không bài kiểm nào của từng màn hình thấy.
 *
 * Mệnh đề ĐỌC BẢNG NỐI (`bank_transaction_links`), KHÔNG đọc ảnh chụp: một chuyển khoản 30 triệu
 * trả hai hoá đơn 20 + 10 chỉ chụp được hoá đơn 20; hoá đơn 10 sẽ hiện "chưa có tiền" dù đã trả xong.
 *
 * Mỗi màn hình vẫn tự chọn PHẠM VI (mọi khoản chi / chỉ khoản gõ tay trong kỳ) — đó là câu hỏi
 * khác nhau thật; chỉ phần "chưa nối" là phải chung.
 */
import { sql, type SQL } from "drizzle-orm";

/** Khoản chi (bí danh `e` trong câu SQL gọi nó) chưa có mối nối tiền nào. */
export function expenseUnpaidCond(alias = "e"): SQL {
  const a = sql.raw(alias);
  return sql`not exists (select 1 from bank_transaction_links tl where tl.target_type = 'EXPENSE' and tl.target_id = ${a}.id)`;
}
