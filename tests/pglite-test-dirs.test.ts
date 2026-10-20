/**
 * Dọn thư mục CSDL kiểm thử (`tests/pglite-test-dirs.ts` + `tests/setup-env.ts`): chỉ đúng thư mục của bộ
 * kiểm thử, chỉ đúng PID được chọn (gồm `-org-<mã>`), không đụng thư mục khác; PID còn sống không bị xoá.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { donThuMucKiemThu, pidConSong, pidCuaThuMuc } from "./pglite-test-dirs";

export function testPgliteTestDirs() {
  assert.equal(pidCuaThuMuc("pglite-test-123"), 123);
  assert.equal(pidCuaThuMuc("pglite-test-123-org-hslc"), 123, "CSDL tổ chức của cùng tiến trình");
  for (const la of ["pglite", "pglite-test", "pglite-test-abc", "pglite-test-12x", "x-pglite-test-1", "pglite-test-1-orgx"]) assert.equal(pidCuaThuMuc(la), null, `${la}: không phải thư mục kiểm thử ⇒ không bao giờ đụng`);

  const goc = mkdtempSync(path.join(os.tmpdir(), "pglite-don-"));
  try {
    for (const ten of ["pglite-test-111", "pglite-test-111-org-a", "pglite-test-222", "pglite", "pglite-test-abc"]) {
      mkdirSync(path.join(goc, ten));
      writeFileSync(path.join(goc, ten, "PG_VERSION"), "16");
    }
    writeFileSync(path.join(goc, "pglite-test-333"), "một TỆP, không phải thư mục — vẫn là của PID 333");
    const xoa = donThuMucKiemThu(goc, (pid) => pid === 111 || pid === 333);
    assert.deepEqual(xoa.sort(), ["pglite-test-111", "pglite-test-111-org-a", "pglite-test-333"], "xoá đúng PID được chọn, gồm CSDL tổ chức của nó");
    for (const con of ["pglite-test-222", "pglite", "pglite-test-abc"]) assert.ok(existsSync(path.join(goc, con)), `${con}: KHÔNG bị đụng`);
    assert.deepEqual(donThuMucKiemThu(path.join(goc, "khong-co"), () => true), [], "thư mục gốc chưa có ⇒ không làm gì");
  } finally {
    rmSync(goc, { recursive: true, force: true });
  }

  assert.equal(pidConSong(process.pid), true, "chính tiến trình này còn sống");
  const chet = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(chet && !pidConSong(chet), "tiến trình con đã thoát ⇒ không còn sống");

  const env = readFileSync("tests/setup-env.ts", "utf8");
  assert.match(env, /donThuMucKiemThu\(gocDuLieu, \(pid\) => pid !== process\.pid && !pidConSong\(pid\)\)/, "khởi động: chỉ dọn PID ĐÃ CHẾT, không bao giờ chính mình hay lượt song song đang chạy");
  assert.match(env, /process\.on\("exit", \(\) => donThuMucKiemThu\(gocDuLieu, \(pid\) => pid === process\.pid\)\)/, "thoát: dọn đúng thư mục của CHÍNH tiến trình (kể cả khi đỏ)");
  assert.match(env, /TEST_GIU_CSDL !== "1"/, "có lối giữ CSDL lại để soi lỗi");
  console.log("✓ CSDL kiểm thử tự dọn: thoát ⇒ xoá thư mục của chính tiến trình (gồm -org-*) · khởi động ⇒ xoá của PID đã chết · PID còn sống / thư mục lạ không bị đụng");
}
