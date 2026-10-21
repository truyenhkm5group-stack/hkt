/**
 * ═══════════ check-integrations --messenger: KHAI CÓ / KHÔNG, KHÔNG IN GIÁ TRỊ (M4 mục 5, 21/10/2026) ═══════════
 *
 * Người vận hành phải đọc được cấu hình Messenger trực tiếp mà không cần mở /platform; dòng ✓ / ✗ của thao tác ops ra log
 * CÔNG KHAI (kho PUBLIC). Khoá: mỗi biến khai CÓ / KHÔNG, nói app nào đang dùng, đếm số secret webhook — và KHÔNG một giá trị nào
 * (App ID, secret, Configuration ID, verify token) xuất hiện trong đầu ra. Chạy script thật bằng tiến trình con (script gọi
 * `main()` lúc nạp nên không import được).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FAKE = {
  FACEBOOK_LOGIN_APP_ID: "999111222333444",
  FACEBOOK_LOGIN_APP_SECRET: "gia-secret-dang-nhap-khong-duoc-in-0001",
  FACEBOOK_MESSENGER_APP_ID: "999555666777888",
  FACEBOOK_MESSENGER_APP_SECRET: "gia-secret-messenger-khong-duoc-in-0002",
  FACEBOOK_MESSENGER_LOGIN_CONFIG_ID: "998877665544332",
  AUTH_SECRET: "gia-auth-secret-kiem-thu-bao-cao-cau-hinh-messenger-0003",
};

function run(env: NodeJS.ProcessEnv): string {
  const cli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [cli, "--tsconfig", "tsconfig.json", path.join("scripts", "check-integrations.ts"), "--messenger"], { env, encoding: "utf8", shell: false, timeout: 120_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `check-integrations --messenger phải chạy xong: ${out.slice(0, 400)}`);
  return out;
}

export function testMessengerConfigReport() {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(FAKE)) delete base[k];

  const full = run({ ...base, ...FAKE });
  assert.match(full, /FACEBOOK_LOGIN_APP_ID CÓ · FACEBOOK_LOGIN_APP_SECRET CÓ/);
  assert.match(full, /FACEBOOK_MESSENGER_APP_ID CÓ · FACEBOOK_MESSENGER_APP_SECRET CÓ/);
  assert.match(full, /FACEBOOK_MESSENGER_LOGIN_CONFIG_ID CÓ/);
  assert.match(full, /Verify token webhook dựng được/);
  assert.match(full, /dùng: App Messenger riêng/, "đủ cặp app Messenger ⇒ nối page đi app Messenger");
  assert.match(full, /chữ ký của 2 app secret/);
  for (const [k, v] of Object.entries(FAKE)) assert.ok(!full.includes(v), `${k}: giá trị KHÔNG được xuất hiện trong đầu ra`);
  for (const line of full.split("\n").filter((l) => l.startsWith("[ops:tom-tat]"))) assert.doesNotMatch(line, /\d{12,}/, `dòng công khai không mang dãy số dài (App ID / page id): ${line}`);

  // Thiếu nửa cặp app Messenger ⇒ lùi về app đăng nhập, khai KHÔNG đúng biến thiếu.
  const half = run({ ...base, ...FAKE, FACEBOOK_MESSENGER_APP_SECRET: "", FACEBOOK_MESSENGER_LOGIN_CONFIG_ID: "" });
  assert.match(half, /FACEBOOK_MESSENGER_APP_ID CÓ · FACEBOOK_MESSENGER_APP_SECRET KHÔNG/);
  assert.match(half, /FACEBOOK_MESSENGER_LOGIN_CONFIG_ID KHÔNG/);
  assert.match(half, /dùng: App đăng nhập \(chưa khai đủ app Messenger\)/, "nửa cặp ⇒ không trộn ID app này với secret app kia");
  assert.match(half, /chữ ký của 1 app secret/);
  console.log("✓ check-integrations --messenger: khai CÓ / KHÔNG từng biến, app đang dùng, số secret webhook — không in giá trị nào");
}
