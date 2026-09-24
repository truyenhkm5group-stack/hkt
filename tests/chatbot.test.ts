/**
 * ═══════════ BOT CHAT TRÊN VPS: KHO PUBLIC KHÔNG BAO GIỜ MANG KHOÁ CỦA BOT ═══════════
 *
 * Mã bot (`chatbot/`) vào kho public; khoá Gemini, token 10 fanpage, khoá POS thì KHÔNG. Token page
 * lộ trên GitHub là bot quét lộ khoá lấy được trong vài phút — người lạ nhắn tin, xoá tin trên cả
 * 10 page. Nên bài kiểm này khoá ba điều ở mức mã nguồn:
 *   1. `chatbot/` không có tệp `.env` / `data/` nào vào kho, và không chuỗi nào trông như khoá thật.
 *   2. Container bot không mở cổng ra Internet; trang quản trị chỉ tới được qua cửa ERP có kiểm quyền.
 *   3. Nạp cấu hình chỉ nhận đúng danh sách tên tệp, và nạp xong LUÔN về "chỉ log, không gửi" —
 *      bot trên máy Windows còn chạy thì hai bot cùng gửi là khách nhận hai câu trả lời.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/chatbot.test.ts
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_PATTERNS = [/\bEAA[A-Za-z0-9]{40,}/, /AIza[0-9A-Za-z_-]{20,}/, /sk-[A-Za-z0-9_-]{20,}/];

function chatbotFiles(): string[] {
  // Tệp ĐÃ vào kho + tệp mới chưa bị .gitignore chặn: đúng tập sẽ đi lên GitHub ở lần commit tới.
  return execSync("git ls-files --cached --others --exclude-standard chatbot", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function testChatbotNoSecretsInRepo() {
  const files = chatbotFiles();
  assert.ok(files.includes("chatbot/src/bot.js"), "thiếu mã bot chatbot/src/bot.js");
  for (const f of files) {
    const base = path.posix.basename(f);
    assert.ok(!/(^|\/)data\//.test(f.slice("chatbot/".length)), `${f}: dữ liệu vận hành của bot không được vào kho`);
    assert.ok(base === ".env.example" || !/(^\.env$|\.env$)/.test(base), `${f}: tệp .env không được vào kho`);
    const text = readFileSync(f, "utf8");
    for (const re of KEY_PATTERNS) assert.ok(!re.test(text), `${f}: có chuỗi trông như khoá thật (${re})`);
  }
  // .env.example chỉ được mang TÊN biến bí mật, giá trị để trống.
  for (const line of readFileSync("chatbot/.env.example", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]*(?:API_KEY|_TOKEN|SECRET|PASSWORD|PAGES_JSON))=(.*)$/);
    if (m) assert.equal(m[2].trim(), "", `.env.example: ${m[1]} phải để trống`);
  }
  const ignore = readFileSync("chatbot/.gitignore", "utf8");
  for (const must of [".env", "data/"]) assert.ok(ignore.split(/\r?\n/).includes(must), `chatbot/.gitignore phải chặn ${must}`);
  console.log(`✓ Bot chat: ${files.length} tệp trong chatbot/, không .env, không data/, không chuỗi giống khoá`);
}

export function testChatbotDeployShape() {
  const compose = readFileSync("docker-compose.prod.yml", "utf8");
  const start = compose.indexOf("\n  chatbot:");
  assert.ok(start > 0, "docker-compose.prod.yml phải có dịch vụ chatbot");
  const end = compose.indexOf("\n  caddy:", start);
  const block = compose.slice(start, end > start ? end : undefined);
  assert.ok(!/\n\s+ports:/.test(block), "container bot KHÔNG được mở cổng ra Internet — chỉ `expose` trong mạng Docker");
  assert.ok(block.includes("./chatbot:/app:ro"), "mã bot gắn chỉ-đọc");
  assert.ok(block.includes("BOT_ENV_FILE: /data/bot.env"), "khoá bot nằm ở volume dữ liệu, không trong mã nguồn");
  assert.ok(block.includes("${CHATBOT_ADMIN_TOKEN:-}"), "khoá nội bộ đọc từ .env của máy chủ");
  assert.ok(/restart:\s+unless-stopped/.test(block), "bot phải tự dựng lại khi chết (từng chết âm thầm 3 tiếng trên máy Windows)");

  const install = readFileSync("scripts/install-vps.sh", "utf8");
  assert.ok(/grep -qE "\^CHATBOT_ADMIN_TOKEN=" \.env \|\|/.test(install), "install-vps.sh sinh CHATBOT_ADMIN_TOKEN MỘT lần, không ghi đè khoá đang chạy");

  const route = readFileSync("app/api/chatbot/[...path]/route.ts", "utf8");
  assert.ok(route.includes('can(user, "cs:config")'), "cửa /api/chatbot phải kiểm quyền cs:config");
  assert.ok(route.includes('query.delete("token")'), "khoá do máy chủ gắn, không nhận từ trình duyệt");
  const auditCall = route.slice(route.indexOf("await audit("), route.indexOf("}).catch", route.indexOf("await audit(")));
  assert.ok(!/\bbody\b/.test(auditCall), "nhật ký KHÔNG ghi thân yêu cầu (mang khoá khi nạp tệp, mang tin khách khi chat)");
  console.log("✓ Bot chat: không mở cổng, mã chỉ-đọc, khoá ở volume, cửa ERP kiểm quyền và không ghi thân yêu cầu vào nhật ký");
}

export async function testChatbotImportGuards() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chatbot-import-"));
  const saved = { DATA_DIR: process.env.DATA_DIR, BOT_ENV_FILE: process.env.BOT_ENV_FILE, SYSTEM_PROMPT_FILE: process.env.SYSTEM_PROMPT_FILE };
  process.env.DATA_DIR = dir;
  process.env.BOT_ENV_FILE = path.join(dir, "bot.env");
  process.env.SYSTEM_PROMPT_FILE = path.join(dir, "system.md");
  try {
    const mod = (await import(path.resolve("chatbot/src/erp-import.js"))) as {
      importFiles: (files: Record<string, string>) => string[];
    };
    assert.throws(() => mod.importFiles({ "../../etc/passwd": "x" }), /Khong nhan tep/, "tên lạ (kể cả đường dẫn đi ngược) bị từ chối");
    assert.throws(() => mod.importFiles({ "pages.json": "{hỏng" }), /JSON/, "JSON hỏng bị từ chối");
    assert.throws(() => mod.importFiles({ "bot.env": "POLL_ENABLED=true\n" }), /GEMINI_API_KEY/, ".env thiếu khoá AI bị từ chối");
    assert.throws(() => mod.importFiles({ "bot.env": "GEMINI_API_KEY=x\n", "pages.json": "{hỏng" }), /JSON/);
    assert.throws(() => readFileSync(path.join(dir, "bot.env")), "một tệp hỏng ⇒ KHÔNG tệp nào được ghi");

    const written = mod.importFiles({ "bot.env": "GEMINI_API_KEY=gia\n", "global.json": JSON.stringify({ dryRun: false }) });
    assert.deepEqual(written, ["bot.env", "global.json"]);
    const global = JSON.parse(readFileSync(path.join(dir, "global.json"), "utf8")) as { dryRun: boolean };
    assert.equal(global.dryRun, true, "nạp xong LUÔN về chỉ log, kể cả khi tệp tải lên nói gửi thật");
    console.log("✓ Bot chat: nạp cấu hình chỉ nhận 6 tên tệp, tệp hỏng không ghi gì, nạp xong luôn về chế độ chỉ log");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("chatbot.test.ts")) {
  testChatbotNoSecretsInRepo();
  testChatbotDeployShape();
  void testChatbotImportGuards();
}
