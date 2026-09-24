// Kiem tra cu phap JavaScript trong admin/index.html (chay truoc khi sua giao dien)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const html = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
const f = path.join(os.tmpdir(), "admin_check.mjs");
fs.writeFileSync(f, js);
try {
  execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  console.log("admin/index.html: JS OK");
} catch (e) {
  console.error(String(e.stderr));
  process.exit(1);
}
