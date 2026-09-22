/**
 * ═══════════ KHE ĐĂNG KÝ BÀI KIỂM DO AGENT VIẾT ═══════════
 *
 * Đây là tệp DUY NHẤT trong `tests/` mà agent được ghi để bài kiểm của nó thật sự CHẠY. Bộ chạy
 * chính (`tests/sync-fixtures.test.ts`) gọi hàm bên dưới đúng một lần; tệp ấy agent không ghi được.
 *
 * Lý do cho cách chia này nằm ở `lib/constants/agent-test-registry.ts` — đọc trước khi sửa.
 *
 * ─── LUẬT CỦA TỆP NÀY, NGẮN VÀ ĐÓNG ───
 *
 *  · Chỉ có `import` từ các tệp `./*.test` và các LỜI GỌI trong hàm dưới. Không logic, không
 *    khẳng định, không dựng dữ liệu — mọi thứ đó thuộc về chính bài kiểm.
 *  · **Không xoá dòng của lượt trước.** Số lời gọi ở đây không được giảm; có bộ gác đếm
 *    (`tests/dang-ky-bai-kiem.test.ts`) và sàn nằm ở một hằng số agent không ghi được.
 *  · Bài kiểm tự dọn dữ liệu của mình. Khe này không dọn hộ ai.
 */

import { testNhanhAgentVeToiViec } from "./agent-branch-claim-ingest.test";

export async function chayBaiKiemAgentTuDangKy(): Promise<void> {
  /*
    Agent thêm lời gọi của mình vào đây, mỗi bài một dòng, và thêm `import` tương ứng ở đầu tệp.

    Ví dụ:
        import { testNhanhAgentVeToiViec } from "./agent-branch-claim-ingest.test";
        …
        await testNhanhAgentVeToiViec();
  */
  await testNhanhAgentVeToiViec();
}
