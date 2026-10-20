/**
 * Dọn thư mục CSDL PGlite dùng-một-lần của bộ kiểm thử (`data/pglite-test-<pid>` và `…-<pid>-org-<mã>`).
 * HÀM THUẦN trên một thư mục gốc + một cách hỏi "PID còn sống không" — để bài kiểm chạy trên thư mục tạm
 * với PID giả. `tests/setup-env.ts` gọi nó lúc khởi động (tiến trình đã chết) và lúc thoát (chính mình).
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const MAU = /^pglite-test-(\d+)(?:-org-.+)?$/;

/** PID chủ của một thư mục CSDL kiểm thử; `null` = không phải thư mục của bộ kiểm thử (không bao giờ đụng). */
export function pidCuaThuMuc(ten: string): number | null {
  const m = MAU.exec(ten);
  return m ? Number(m[1]) : null;
}

/** Hỏi hệ điều hành PID còn sống không. EPERM = có tồn tại nhưng không phải của mình ⇒ coi là còn sống. */
export function pidConSong(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Xoá thư mục CSDL kiểm thử dưới `goc` mà `nenXoa(pid)` trả `true`. Lỗi xoá (thư mục đang bị khoá trên
 * Windows) ⇒ bỏ qua, lượt sau dọn. Trả về tên các thư mục đã xoá.
 */
export function donThuMucKiemThu(goc: string, nenXoa: (pid: number) => boolean): string[] {
  if (!existsSync(goc)) return [];
  const xoa: string[] = [];
  for (const ten of readdirSync(goc)) {
    const pid = pidCuaThuMuc(ten);
    if (pid === null || !nenXoa(pid)) continue;
    try {
      rmSync(path.join(goc, ten), { recursive: true, force: true });
      xoa.push(ten);
    } catch {
      // đang bị khoá ⇒ lượt khởi động sau dọn (PID ấy khi đó đã chết)
    }
  }
  return xoa;
}
