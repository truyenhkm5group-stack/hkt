// Kiem tra cu phap JavaScript trong admin/index.html (chay truoc khi sua giao dien)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const html = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
// MOI khoi <script> (khoi dau la dong bo mau voi ERP; khoi chinh nam sau) — kiem rieng tung khoi
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length < 2) {
  console.error("admin/index.html: thieu khoi <script> (can khoi dong bo mau + khoi chinh)");
  process.exit(1);
}
const js = blocks.join("\n;\n");
const f = path.join(os.tmpdir(), "admin_check.mjs");
fs.writeFileSync(f, js);
try {
  execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  console.log("admin/index.html: JS OK");
} catch (e) {
  console.error(String(e.stderr));
  process.exit(1);
}
