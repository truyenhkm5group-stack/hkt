import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════════ KHỐI DỌN ẢNH CỦA `install-vps.sh` PHẢI SỐNG ĐƯỢC KHI KHÔNG CÓ GÌ ĐỂ DỌN ═══════════
 *
 * SỰ CỐ THẬT (deploy #244, 12/09/2026) — và nó là một vòng tự giết mình khá đẹp:
 *
 * Ổ đĩa VPS đầy 100%, nên deploy #242/#243 đỏ. Bản sửa thêm một khối dọn ảnh cũ vào
 * `install-vps.sh`. Thao tác `docker-prune` dọn sạch máy chủ trước. Rồi deploy #244 chạy khối sửa
 * đó — và CHẾT, vì máy chủ đã sạch:
 *
 *     docker images ... | grep "^ghcr.io/...:" | while read ...
 *
 * `grep` không tìm thấy gì ⇒ trạng thái 1. Script có `set -euo pipefail` (dòng 6), nên `pipefail`
 * đẩy trạng thái 1 ra cả đường ống và `set -e` giết script ngay. **Bản sửa cho việc đĩa đầy tự
 * giết mình vì đĩa đã hết đầy.**
 *
 * VÌ SAO KHÔNG LÁ CHẮN NÀO THẤY: `bash -n` xanh (cú pháp hoàn toàn hợp lệ), `eslint`/`tsc` không
 * đọc shell, và `npm test` không chạy shell của deploy. Nó chỉ lộ ra trên máy chủ thật, ở lần
 * deploy thứ ba liên tiếp.
 *
 * Bài kiểm này TRÍCH đúng khối đó ra khỏi `install-vps.sh` rồi CHẠY THẬT dưới `bash -euo pipefail`
 * với một `docker` giả, ở CẢ HAI tình huống — máy sạch và máy bẩn. Không mô phỏng bằng lời.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/deploy-script.test.ts
 */

const MOC_DAU = 'if [ -n "${ERP_IMAGE:-}" ]; then\n  ERP_REPO=';
const MOC_CUOI = "# ═══ CỔNG Ổ ĐĨA";

function khoiDonAnh(): string {
  const src = readFileSync("scripts/install-vps.sh", "utf8");
  assert.match(src, /^set -euo pipefail$/m, "install-vps.sh phải chạy với `set -euo pipefail` — cả bài kiểm này dựa vào đó");
  const i = src.indexOf(MOC_DAU);
  assert.ok(i > 0, "không tìm thấy khối dọn ảnh trong install-vps.sh — đổi khối thì đổi luôn mốc ở đây");
  const j = src.indexOf(MOC_CUOI, i);
  assert.ok(j > i, "không tìm thấy mốc kết thúc khối dọn ảnh");
  return src.slice(i, j);
}

/** Chạy khối với một `docker` giả. Trả về mã thoát và danh sách tag đã bị gỡ. */
function chay(anhTrenMay: string[]): { ma: number; daGo: string[] } {
  const tmp = mkdtempSync(path.join(tmpdir(), "deploy-block-"));
  const log = path.join(tmp, "rm.log");
  const kich = path.join(tmp, "run.sh");
  writeFileSync(
    kich,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "say() { :; }",
      'ERP_IMAGE="ghcr.io/o/r:newsha"',
      `RM_LOG="${log}"`,
      ': > "$RM_LOG"',
      "docker() {",
      '  case "$1 ${2:-}" in',
      // `printf '%s\\n'` với từng tag là MỘT đối số riêng — phải là xuống dòng THẬT, không phải
      // hai ký tự `\n`. Bản đầu của bài kiểm này dùng JSON.stringify và mock trả về đúng một dòng,
      // nên `grep` không khớp gì và bài kiểm đỏ vì lỗi CỦA CHÍNH NÓ, không phải của script.
      `    "images --format") printf '%s\\n' ${anhTrenMay.map((a) => `'${a}'`).join(" ")} ;;`,
      '    "rmi "*) echo "$2" >> "$RM_LOG" ;;',
      "    *) : ;;",
      "  esac",
      "}",
      khoiDonAnh(),
      "",
    ].join("\n"),
  );
  let ma = 0;
  try {
    execFileSync("bash", [kich], { stdio: "pipe" });
  } catch (e) {
    ma = (e as { status?: number }).status ?? 1;
  }
  const daGo = readFileSync(log, "utf8").split("\n").filter(Boolean);
  rmSync(tmp, { recursive: true, force: true });
  return { ma, daGo };
}

export function testDeployScript() {
  /*
    TÌNH HUỐNG GIẾT DEPLOY #244: máy chủ đã sạch, không ảnh `ghcr.io/...` nào.
    `grep` trả 1, và nếu khối còn dùng đường ống thì `pipefail` + `set -e` giết script tại đây.
  */
  const sach = chay(["erp-app:local", "postgres:16-alpine", "caddy:2-alpine"]);
  assert.equal(sach.ma, 0, "KHÔNG CÓ ẢNH CŨ NÀO là trạng thái BÌNH THƯỜNG — khối dọn không được làm đổ script (đây đúng là lỗi deploy #244)");
  assert.deepEqual(sach.daGo, [], "máy sạch thì không gỡ gì cả");

  // Máy bẩn: gỡ đúng ảnh cũ, GIỮ ảnh sắp dùng và ảnh không tag (để `docker image prune` lo).
  const ban = chay(["erp-app:local", "ghcr.io/o/r:oldsha1", "ghcr.io/o/r:oldsha2", "ghcr.io/o/r:newsha", "ghcr.io/o/r:<none>", "postgres:16-alpine"]);
  assert.equal(ban.ma, 0, "máy bẩn: khối phải chạy trót lọt");
  assert.deepEqual(ban.daGo, ["ghcr.io/o/r:oldsha1", "ghcr.io/o/r:oldsha2"], "gỡ ĐÚNG hai ảnh cũ — không đụng ảnh sắp dùng, ảnh không tag, hay ảnh của dịch vụ khác");

  // Chỉ có đúng ảnh sắp dùng: cũng không được gỡ nó, và cũng không được chết.
  const chiMoi = chay(["erp-app:local", "ghcr.io/o/r:newsha"]);
  assert.equal(chiMoi.ma, 0);
  assert.deepEqual(chiMoi.daGo, [], "KHÔNG BAO GIỜ gỡ ảnh sắp được dùng — gỡ nó là tự phá bản deploy của chính mình");

  console.log("✓ Khối dọn ảnh của deploy: sống khi máy SẠCH (lỗi #244) · gỡ đúng 2 ảnh cũ khi máy bẩn · không bao giờ gỡ ảnh sắp dùng · chạy thật dưới bash -euo pipefail, không mô phỏng bằng lời");
}
