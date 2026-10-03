/**
 * ═══════════ MÃ TỔ CHỨC CỦA BÀI KIỂM KHÔNG ĐƯỢC TRÙNG ═══════════
 *
 * Mọi bài cấp tổ chức thật chạy CHUNG một tiến trình trong `npm test`, và CSDL PGlite của tổ chức được đệm theo MÃ. Hai bài
 * cùng dùng `pr-a`: bài sau dọn thư mục của mã đó trong khi kết nối đệm của bài trước còn mở ⇒ "could not open file
 * base/5/…" ở CI (03/10/2026, `password-reset` va `workflow-recovery`). Trên Windows lỗi không lộ khi chạy riêng từng bài.
 *
 * Luật: một mã tổ chức (`const X = "<chữ>-<chữ>"` trong tệp có gọi `provisionOrganization(`) chỉ thuộc MỘT tệp kiểm thử.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function testTestOrgCodes() {
  const files = execFileSync("git", ["ls-files", "tests"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.test\.ts$/.test(f));
  const owners = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("provisionOrganization(")) continue;
    for (const m of src.matchAll(/^const [A-Z][A-Z0-9_]* = "([a-z0-9]+-[a-z0-9-]+)";$/gm)) {
      const set = owners.get(m[1]) ?? new Set<string>();
      set.add(f);
      owners.set(m[1], set);
    }
  }
  const clashes = [...owners].filter(([, s]) => s.size > 1).map(([code, s]) => `${code}: ${[...s].join(", ")}`);
  assert.deepEqual(clashes, [], "mã tổ chức của bài kiểm bị trùng giữa các tệp — đổi mã ở tệp mới hơn");
  assert.ok(owners.size > 10, "bộ quét phải thấy các mã đang có — không thấy là quét hỏng chứ không phải sạch");
  console.log(`  ✓ mã tổ chức của bài kiểm: ${owners.size} mã, mỗi mã đúng một tệp`);
}
