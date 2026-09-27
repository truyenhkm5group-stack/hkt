/**
 * HỒI QUY 27/09/2026: sau khi Phase 1 lên `main`, cầu nối mở PR trên GitHub Actions hỏng cho MỌI phiên —
 * `assertHomeCredentials()` của client GitHub hỏi sổ tổ chức, sổ cần CSDL, máy Actions không có
 * `DATABASE_URL`. Bài này chạy lại đúng môi trường đó trong một tiến trình con (không `shell`, gọi thẳng
 * `tsx` bằng `process.execPath` — AGENTS.md luật 65) và khẳng định hai chiều:
 *   · không phiên, không ngữ cảnh ⇒ vẫn là nhà, KHÔNG cần CSDL;
 *   · phiên mang claim tổ chức khác mà không đọc được sổ ⇒ vẫn bị CHẶN (không rơi về nhà).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function testPlatformNoDb() {
  const cli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const envCon: NodeJS.ProcessEnv = { ...process.env };
  delete envCon.DATABASE_URL;
  const r = spawnSync(process.execPath, [cli, "--tsconfig", "tsconfig.json", path.join("tests", "platform-no-db-probe.ts")], { env: envCon, encoding: "utf8", shell: false, timeout: 120_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `tiến trình không CSDL phải chạy xong: ${out.slice(0, 400)}`);
  assert.match(r.stdout, /NHA_OK/, "không phiên + không CSDL ⇒ vẫn phân giải được tổ chức nhà (cầu nối mở PR trên Actions)");
  assert.match(r.stdout, /KHAC_CHAN/, "claim tổ chức khác mà không đọc được sổ ⇒ vẫn CHẶN, không rơi về nhà");
  console.log("✓ Nền tảng · không CSDL: script trên Actions vẫn là tổ chức nhà; phiên tổ chức khác vẫn bị chặn");
}
