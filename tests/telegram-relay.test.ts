/**
 * RELAY TELEGRAM (01/10/2026) — `TELEGRAM_API_BASE` + `deploy/telegram-relay-worker.js`. Máy chủ ở Việt Nam bị chặn
 * api.telegram.org từng lúc; đi qua relay của nền tảng. Không gọi mạng thật (luật 65).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TELEGRAM_API_DEFAULT, telegramApiBase, telegramApiHost } from "@/lib/connectors/telegram-api";
import { ORG_CONNECTION_CHAT_DISCOVERY, testTelegramBot } from "@/lib/connectors/testers";

const TOKEN = `123456789:${"A".repeat(35)}`;

export async function testTelegramRelay() {
  // Chỉ nhận https://<tên miền>[/đường]; mọi dạng khác ⇒ đi thẳng api.telegram.org (hỏng về phía an toàn).
  assert.equal(telegramApiBase(undefined), TELEGRAM_API_DEFAULT);
  assert.equal(telegramApiBase(""), TELEGRAM_API_DEFAULT);
  assert.equal(telegramApiBase("https://tg.vnxcommerce.com/"), "https://tg.vnxcommerce.com");
  assert.equal(telegramApiBase("https://erp-telegram-relay.vnx.workers.dev/tg"), "https://erp-telegram-relay.vnx.workers.dev/tg");
  for (const bad of ["http://tg.vnxcommerce.com", "https://1.2.3.4", "https://tg.vnxcommerce.com:8443", "https://tg.vnxcommerce.com?x=1", "https://u:p@tg.vnxcommerce.com", "javascript:alert(1)", "https://localhost"]) {
    assert.equal(telegramApiBase(bad), TELEGRAM_API_DEFAULT, `từ chối «${bad}»`);
  }
  assert.equal(telegramApiHost("https://tg.vnxcommerce.com"), "tg.vnxcommerce.com");

  // Kiểm tra kết nối + «Tìm chat» đi qua relay khi máy chủ đặt biến; token chỉ ở đường dẫn, không lộ trong câu lỗi.
  const prev = process.env.TELEGRAM_API_BASE;
  process.env.TELEGRAM_API_BASE = "https://tg.vnxcommerce.com";
  try {
    const urls: string[] = [];
    const ok = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true, result: String(input).includes("getUpdates") ? [] : { username: "don_hang_bot", message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    assert.ok((await testTelegramBot({ secrets: { botToken: TOKEN }, settings: { chatId: "-1001234567" }, orgName: "Shop" }, { fetch: ok })).ok);
    await ORG_CONNECTION_CHAT_DISCOVERY["telegram-bot"]({ botToken: TOKEN }, { fetch: ok });
    assert.ok(urls.length === 3 && urls.every((u) => u.startsWith(`https://tg.vnxcommerce.com/bot${TOKEN}/`)), urls.join(" | "));
    const down = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    }) as typeof fetch;
    const r = await testTelegramBot({ secrets: { botToken: TOKEN }, settings: { chatId: "-1001234567" }, orgName: "Shop" }, { fetch: down });
    assert.ok(!r.ok && r.message.includes("tg.vnxcommerce.com") && !r.message.includes(TOKEN), r.message);
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_API_BASE;
    else process.env.TELEGRAM_API_BASE = prev;
  }

  // Mọi đường gọi Telegram (kiểm tra, tìm chat, gửi tin nhóm, cảnh báo hệ thống) đọc gốc từ `telegramApiBase()` — không chỗ nào
  // gõ cứng api.telegram.org vào một lời gọi (sót một chỗ là chỗ đó vẫn ETIMEDOUT dù đã đặt relay).
  for (const f of ["lib/connectors/testers.ts", "lib/messaging/providers.ts", "lib/alerts/telegram.ts"]) {
    const code = readFileSync(f, "utf8");
    assert.ok(!/[`"']https:\/\/api\.telegram\.org/.test(code), `${f}: không gõ cứng api.telegram.org`);
    assert.ok(/\$\{telegramApiBase\(\)\}\/bot/.test(code), `${f}: gọi qua telegramApiBase()`);
  }

  // Worker relay: CHỈ chuyển tiếp getMe · getUpdates · sendMessage của một bot token hợp lệ.
  const src = readFileSync("deploy/telegram-relay-worker.js", "utf8");
  const m = /const ALLOWED = \/(.+)\/;/.exec(src);
  assert.ok(m, "worker khai ALLOWED");
  const allowed = new RegExp(m[1]);
  for (const p of ["getMe", "getUpdates", "sendMessage"]) assert.ok(allowed.test(`/bot${TOKEN}/${p}`), p);
  for (const p of [`/bot${TOKEN}/deleteWebhook`, `/bot${TOKEN}/setWebhook`, "/file/bot123/x", `/bot${TOKEN}/sendMessage/../getMe`, "/"]) assert.ok(!allowed.test(p), `chặn ${p}`);
  assert.ok(src.includes('fetch(`https://api.telegram.org${url.pathname}${url.search}`'), "worker chỉ gọi tới api.telegram.org");

  console.log("✓ Relay Telegram: TELEGRAM_API_BASE chỉ nhận https://tên-miền (sai dạng ⇒ đi thẳng) · kiểm tra + tìm chat đi qua relay · lỗi không lộ token · worker chỉ chuyển tiếp 3 lời gọi");
}
