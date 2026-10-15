/**
 * MÔI TRƯỜNG CHO MỌI LƯỢT GỌI SHELL TRONG BÀI KIỂM — GHIM THỨ TỰ VĂN BẢN (AGENTS §65).
 *
 * `sort`, `ls` và mọi lệnh xếp chữ của shell đi theo COLLATION của máy đang chạy, không theo mã
 * nguồn. Cùng một danh sách tệp cho hai thứ tự khác nhau:
 *
 *   · CI (Linux, `C.UTF-8`) so theo BYTE ⇒ `./orgs-last-hourly.json` đứng TRƯỚC
 *     `./orgs/erp_org_alpha/last-hourly.json`, vì `-` (0x2D) nhỏ hơn `/` (0x2F).
 *   · Máy dev Windows (Git Bash, `en_US.UTF-8`) BỎ QUA dấu khi so ⇒ xếp NGƯỢC LẠI.
 *
 * Đo thật 13/10/2026: `tests/backup.test.ts` đỏ trên Windows ở khẳng định danh sách tệp trạng thái
 * của lượt sao lưu theo giờ, xanh ở CI — cùng một commit. Một bài kiểm cho hai kết luận trên hai
 * máy thì nó KHÔNG đo mã nguồn, nó đo cái máy; và người ta sẽ đi sửa con số kỳ vọng thay vì đọc
 * thông điệp của nó. Cấm đúng như kết thúc dòng và dấu phân cách đường dẫn đã bị cấm.
 *
 * Nên thứ tự được ghim TẠI ĐÂY, TRONG MÃ, chứ không trông vào biến môi trường của người chạy
 * (`LC_ALL=C npm test` chỉ đúng cho người nhớ gõ nó). Ghim HẸP NHẤT có thể: chỉ `LC_COLLATE` —
 * phần còn lại của locale giữ nguyên để chữ tiếng Việt trong đầu ra không đổi cách mã hoá.
 * `LC_ALL` bị GỠ vì nếu người chạy có đặt nó thì nó đè `LC_COLLATE` và phép ghim thành vô nghĩa.
 */
export function moiTruongShell(them?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...them, LC_COLLATE: "C" };
  delete env.LC_ALL;
  return env;
}
