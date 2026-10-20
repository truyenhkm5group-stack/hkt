/** Ép kiểm thử dùng CSDL PGlite tạm (không đụng vào DB trong .env). */
import { rmSync } from "node:fs";
import { donThuMucKiemThu, pidConSong } from "./pglite-test-dirs";

// Mỗi tiến trình có CSDL riêng để các lượt kiểm thử song song không xoá dữ liệu của nhau.
const dir = `./data/pglite-test-${process.pid}`;
rmSync(dir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dir}`;

/*
  ═══════════ CSDL DÙNG-MỘT-LẦN PHẢI ĐƯỢC VỨT ĐI ═══════════

  Trước bản này thư mục `data/pglite-test-<pid>` (và `…-<pid>-org-<mã>` của các bài nhiều tổ chức) không
  bao giờ bị xoá: mỗi lượt `npm test` để lại vài trăm MB. Đo thật 20/10/2026: 441 thư mục · 34,8 GB làm ĐẦY
  ổ C, và PGlite chết «cannot drop active portal» / errno 51 trông như lỗi mã (21/10: 1.027 thư mục sót
  trong các cây làm việc của máy dev). Hai lớp dọn:
   · lúc THOÁT: xoá thư mục của chính tiến trình này, kể cả khi kiểm thử đỏ — `TEST_GIU_CSDL=1` để giữ lại
     soi lỗi. Chỉ xoá đồng bộ được (handler `exit` không chờ lời hứa), lỗi xoá thì bỏ qua: thoát vẫn phải
     giữ đúng mã thoát của bộ kiểm thử;
   · lúc KHỞI ĐỘNG: xoá thư mục của tiến trình ĐÃ CHẾT (PID không còn) — gỡ cả các lượt bị giết giữa chừng
     mà `exit` không chạy. PID còn sống ⇒ không đụng: một lượt song song khác đang dùng nó.
*/
const gocDuLieu = "./data";
// Khởi động: thư mục của tiến trình ĐÃ CHẾT (gồm lượt bị giết giữa chừng). PID còn sống ⇒ không đụng.
donThuMucKiemThu(gocDuLieu, (pid) => pid !== process.pid && !pidConSong(pid));
// Thoát (kể cả khi đỏ): thư mục của CHÍNH tiến trình này. `TEST_GIU_CSDL=1` ⇒ giữ lại để soi lỗi.
if (process.env.TEST_GIU_CSDL !== "1") process.on("exit", () => donThuMucKiemThu(gocDuLieu, (pid) => pid === process.pid));

/*
  ═══════════ CSDL NÀY LÀ CỦA CHÍNH BỘ KIỂM THỬ, NÊN NÓ PHẢI GHI ĐƯỢC ═══════════

  `ERP_READ_ONLY=1` đẩy mọi kết nối sang giao dịch CHỈ ĐỌC (`db/index.ts`). Đó là đúng khi cờ ấy
  bảo vệ một CSDL CÓ THẬT khỏi một tiến trình không được phép ghi — `scripts/payroll-reconcile.ts`
  bật nó vì đúng lý do đó.

  Nhưng các dòng đầu tệp vừa TỰ DỰNG một CSDL dùng-một-lần, trong một thư mục vừa bị xoá sạch, riêng
  cho tiến trình này. Ép nó chỉ-đọc thì `migrate()` chết ngay ở câu đầu tiên:

      cannot execute CREATE SCHEMA in a read-only transaction   (SQLSTATE 25006)

  ĐÃ ĐO THẬT (18/09/2026): `sandboxEnv()` của runner agent đặt `ERP_READ_ONLY=1` cho tiến trình
  con, nên cổng `npm test` trong cây làm việc của agent ĐỎ 100% — không phải vì mã sai, mà vì bộ
  kiểm thử không tạo nổi lược đồ của chính nó. Một cổng KHÔNG BAO GIỜ xanh được là một cổng nói
  dối: nó biến "agent chưa chạy được bài kiểm" thành "agent làm hỏng bài kiểm".

  Nên bộ kiểm thử KHAI RÕ ở đây rằng CSDL sắp dùng là của nó và vứt đi được. Phạm vi hẹp đúng một
  tiến trình: production, scheduler, script vận hành và `payroll-reconcile` không đi qua tệp này
  nên không đổi một chút nào. Và agent KHÔNG sửa được tệp này — vai tài liệu chỉ ghi được trong
  `docs/` (`checkWritePath`), nên đây không phải một cửa hậu mở cho tiến trình con.
*/
delete process.env.ERP_READ_ONLY;
