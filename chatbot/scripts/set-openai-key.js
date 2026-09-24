// Ghi OPENAI_API_KEY vao .env va chuyen AI_PROVIDER=openai.
// Chay: node scripts/set-openai-key.js sk-...   (khong co key = chi doi AI_PROVIDER)
// Doi lai Gemini: node scripts/set-openai-key.js --gemini
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
const arg = (process.argv[2] || "").trim();
let s = fs.readFileSync(envPath, "utf8");

function setLine(key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  s = re.test(s) ? s.replace(re, `${key}=${value}`) : s.replace(/\n*$/, `\n${key}=${value}\n`);
}

if (arg === "--gemini") {
  setLine("AI_PROVIDER", "gemini");
  fs.writeFileSync(envPath, s);
  console.log("Da chuyen AI_PROVIDER=gemini. Khoi dong lai app de ap dung.");
  process.exit(0);
}
if (arg) {
  if (!/^sk-/.test(arg)) {
    console.error("Key khong hop le (phai bat dau bang sk-). Nhan duoc:", arg.slice(0, 8) + "...");
    process.exit(1);
  }
  setLine("OPENAI_API_KEY", arg);
}
setLine("AI_PROVIDER", "openai");
fs.writeFileSync(envPath, s);
const hasKey = /^OPENAI_API_KEY=sk-/m.test(s);
console.log(`Da ghi .env: AI_PROVIDER=openai, OPENAI_API_KEY=${hasKey ? "sk-..." + s.match(/^OPENAI_API_KEY=(.*)$/m)[1].slice(-4) : "(TRONG)"}`);
console.log("Tiep theo: node scripts/test-openai.js");
