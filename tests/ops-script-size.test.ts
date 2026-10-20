/**
 * ═══════ KỊCH BẢN SSH CỦA ops-vps.yml PHẢI NẰM DƯỚI GIỚI HẠN CỦA LINUX ═══════
 *
 * `appleboy/ssh-action` nhận kịch bản qua MỘT biến môi trường (`INPUT_SCRIPT`). Linux giới hạn một
 * chuỗi môi trường ở 131.072 byte (`MAX_ARG_STRLEN`) — vượt ngưỡng là MỌI thao tác ops (db-query,
 * sao lưu tay, đối soát…) chết ngay ở runner với `/bin/bash: Argument list too long`, trước khi chạm
 * máy chủ. Sự cố thật 19/10/2026 (lượt 39177493276, sau #906): khối 127.883 byte hỏng, 126.630 byte
 * (lượt 39165959552) còn chạy. Trần 125.000 để lỗi lộ ra ở CI chứ không ở production.
 *
 * Gần trần thì CHUYỂN chú thích dài sang `docs/ops-vps-script-notes.md` (giữ nguyên văn), đừng nâng trần.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const OPS_SCRIPT_MAX_BYTES = 125_000;

export function opsScriptBytes(src: string): number {
  const s = src.split(/\r?\n/);
  const i = s.findIndex((l) => l.trim() === "script: |");
  assert.ok(i >= 0, "không tìm thấy khối `script: |` đầu tiên của ops-vps.yml");
  const ind = s[i + 1].length - s[i + 1].trimStart().length;
  let j = i + 1;
  while (j < s.length && (s[j].trim() === "" || s[j].length - s[j].trimStart().length >= ind)) j += 1;
  return Buffer.byteLength(s.slice(i + 1, j).map((l) => l.slice(ind)).join("\n"), "utf8");
}

export function testOpsScriptSize() {
  const bytes = opsScriptBytes(readFileSync(".github/workflows/ops-vps.yml", "utf8"));
  assert.ok(
    bytes <= OPS_SCRIPT_MAX_BYTES,
    `Kịch bản SSH của ops-vps.yml dài ${bytes.toLocaleString("vi-VN")} byte > trần ${OPS_SCRIPT_MAX_BYTES.toLocaleString("vi-VN")} — gần giới hạn 131.072 byte của một biến môi trường, vượt là MỌI thao tác ops chết ("Argument list too long"). Chuyển chú thích dài sang docs/ops-vps-script-notes.md.`,
  );
  // Mỗi dòng trỏ "Chú thích đầy đủ: … — mục `X`" phải có mục `X` trong tài liệu — chú thích chuyển đi KHÔNG được
  // mất (21/10/2026: 60 cụm chuyển sang docs/ops-vps-script-notes.md, khối 124.750 ⇒ 85.412 byte).
  const yml = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  const notes = readFileSync("docs/ops-vps-script-notes.md", "utf8");
  const tro = [...yml.matchAll(/Chú thích đầy đủ: docs\/ops-vps-script-notes\.md — mục `([^`]+)`/g)].map((m) => m[1]);
  const moCoi = tro.filter((ten) => !notes.includes(`\`${ten}\``));
  assert.deepEqual(moCoi, [], "dòng trỏ tới mục KHÔNG có trong docs/ops-vps-script-notes.md — chú thích đã chuyển đi đang bị mất");
  assert.equal(new Set(tro).size, tro.length, "hai dòng trỏ cùng một mục — mục phải có tên riêng");
  console.log(`✓ Kịch bản SSH ops-vps.yml: ${bytes.toLocaleString("vi-VN")} / ${OPS_SCRIPT_MAX_BYTES.toLocaleString("vi-VN")} byte (giới hạn Linux 131.072) · ${tro.length} mục chú thích đã chuyển đều có trong tài liệu`);
}
