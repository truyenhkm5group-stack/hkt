import { z } from "zod";
import { DEPARTMENT_CODES } from "@/lib/constants/departments";
import { WORK_SOURCES } from "@/lib/constants/work-sources";
import { WIP_MAX, WIP_MIN } from "@/lib/constants/workforce";

/**
 * Lược đồ cấu hình nhân lực — để RIÊNG khỏi `lib/actions/workforce.ts`.
 *
 * Tệp Server Action mang chỉ thị `"use server"`, và Next bắt buộc MỌI export của tệp đó phải là
 * hàm bất đồng bộ. Một hằng số lược đồ xuất từ đó sẽ làm hỏng bản dựng — `tests/use-server-exports.test.ts`
 * khoá đúng điều này. Để ở đây thì kiểm thử gọi thẳng được mà không cần phiên đăng nhập.
 */
/*
  `partialRecord`, KHÔNG PHẢI `record` — và đây là một lỗi đã bắt được ở QA trình duyệt.

  Trong Zod 4, `z.record(z.enum([...]), v)` bắt buộc CÓ ĐỦ MỌI KHOÁ của enum. Màn hình này gửi
  đúng MỘT mảnh mỗi lần bấm (`{ departmentWip: { SALES: 2 } }`), nên mọi lượt sửa trần việc / bật
  tắt phân việc / bật tắt leo thang đều bị từ chối — im lặng với người đọc mã, vì `tsc` xanh và
  bài kiểm thuần cũng xanh. Chỉ có người bấm nút mới thấy: trần đặt xong mà máy phân việc vẫn
  chạy theo số cũ.

  `z.partialRecord` cho phép gửi một phần, đúng hình dạng mà "sửa một ô" cần.
*/
export const staffingSchema = z.object({
  departmentWip: z.partialRecord(z.enum(DEPARTMENT_CODES), z.number().int().min(WIP_MIN).max(WIP_MAX)).optional(),
  userWip: z.record(z.string(), z.number().int().min(WIP_MIN).max(WIP_MAX)).optional(),
  skills: z.record(z.string(), z.array(z.enum(WORK_SOURCES))).optional(),
  away: z.record(z.string(), z.object({ until: z.string(), reason: z.string().max(200) })).optional(),
  autoAssign: z.partialRecord(z.enum(DEPARTMENT_CODES), z.boolean()).optional(),
  escalationOff: z.partialRecord(z.enum(DEPARTMENT_CODES), z.boolean()).optional(),
});


