import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/webhooks/messenger/route";
import { messengerVerifyToken, verifyMessengerSignatureAny, webhookSecretsFrom } from "@/lib/integrations/messenger/graph";

/**
 * ═══════════ APP META RIÊNG CHO MESSENGER («ChotDonTuDong Messenger», 06/10/2026) — CẤU HÌNH THỬ, CHƯA CHUYỂN ═══════════
 *
 * Chủ nền tảng tạo app Meta mới cho Messenger / Instagram và khai webhook vào CÙNG URL. Ba điều phải đúng trước khi chuyển:
 *  1. bắt tay GET (`hub.challenge`) qua được bằng CÙNG mã xác minh hiện có (mã dẫn xuất, không gắn với app nào);
 *  2. gói POST ký bằng secret của app mới được nhận khi secret ấy đã khai — gói của app LẠ vẫn bị từ chối;
 *  3. secret mới đi đủ đường lên máy chủ (deploy → install → .env) mà không thay app đăng nhập đang chạy.
 * Không đọc biến môi trường của máy: secret là chuỗi BỊA truyền thẳng vào hàm thuần (luật 65).
 */

const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export async function testMessengerWebhookSecrets() {
  // 1 · Danh sách secret được chấp nhận.
  assert.deepEqual(webhookSecretsFrom("login-secret", null), ["login-secret"], "chưa khai app mới ⇒ chỉ app đăng nhập — hành vi cũ");
  assert.deepEqual(webhookSecretsFrom("login-secret", "messenger-secret"), ["login-secret", "messenger-secret"]);
  assert.deepEqual(webhookSecretsFrom("same", " same "), ["same"], "trùng ⇒ một");
  assert.deepEqual(webhookSecretsFrom("", "  "), [], "không secret nào ⇒ kênh chưa mở");

  // 2 · Chữ ký: app mới được nhận khi đã khai; app lạ / chưa khai ⇒ từ chối.
  const body = JSON.stringify({ object: "page", entry: [] });
  const both = webhookSecretsFrom("login-secret", "messenger-secret");
  assert.ok(verifyMessengerSignatureAny(body, sign(body, "messenger-secret"), both), "gói của app Messenger mới (đã khai secret) ⇒ nhận");
  assert.ok(verifyMessengerSignatureAny(body, sign(body, "login-secret"), both), "gói của app đăng nhập vẫn nhận như cũ");
  assert.ok(!verifyMessengerSignatureAny(body, sign(body, "messenger-secret"), webhookSecretsFrom("login-secret", null)), "chưa khai secret app mới ⇒ gói của nó bị từ chối");
  assert.ok(!verifyMessengerSignatureAny(body, sign(body, "app-la"), both), "app lạ ⇒ từ chối");
  assert.ok(!verifyMessengerSignatureAny(body, sign(`${body} `, "messenger-secret"), both), "thân bị sửa ⇒ từ chối");
  assert.ok(!verifyMessengerSignatureAny(body, sign(body, "messenger-secret"), []), "không secret nào ⇒ luôn từ chối");

  // 3 · Bắt tay GET của Meta qua đúng route: mã đúng ⇒ trả lại challenge (text/plain, 200); sai ⇒ 403.
  const url = (token: string) => `https://erp.example.test/api/webhooks/messenger?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
  const ok = await GET(new NextRequest(url(messengerVerifyToken())));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "1158201444", "Meta nhận lại đúng hub.challenge");
  assert.match(ok.headers.get("content-type") ?? "", /text\/plain/);
  const bad = await GET(new NextRequest(url("sai-ma")));
  assert.equal(bad.status, 403);

  // 4 · Secret mới đi đủ đường lên máy chủ; route xác thực bằng DANH SÁCH secret, không bằng một secret của messengerApp().
  const root = process.cwd();
  const route = readFileSync(path.join(root, "app/api/webhooks/messenger/route.ts"), "utf8");
  assert.ok(route.includes("messengerWebhookSecrets()") && route.includes("verifyMessengerSignatureAny("), "POST kiểm chữ ký theo danh sách secret");
  const deploy = readFileSync(path.join(root, ".github/workflows/deploy-vps.yml"), "utf8");
  assert.ok(deploy.includes("FACEBOOK_MESSENGER_APP_SECRET: ${{ secrets.FACEBOOK_MESSENGER_APP_SECRET }}"), "secret lấy từ GitHub Secrets (không Variables)");
  assert.ok(deploy.includes("FACEBOOK_MESSENGER_APP_ID: ${{ vars.FACEBOOK_MESSENGER_APP_ID }}"));
  assert.ok(/envs: [^\n]*,FACEBOOK_MESSENGER_APP_ID,FACEBOOK_MESSENGER_APP_SECRET,/.test(deploy), "truyền qua SSH (envs)");
  assert.ok(/export [^\n]* FACEBOOK_MESSENGER_APP_ID FACEBOOK_MESSENGER_APP_SECRET /.test(deploy), "export trong phiên SSH");
  const install = readFileSync(path.join(root, "scripts/install-vps.sh"), "utf8");
  assert.ok(install.includes('upsert_env FACEBOOK_MESSENGER_APP_SECRET "${FACEBOOK_MESSENGER_APP_SECRET}"'), "install ghi vào .env khi có giá trị");
  assert.ok(install.includes('[ -n "${FACEBOOK_LOGIN_APP_SECRET:-}" ] && upsert_env FACEBOOK_LOGIN_APP_SECRET'), "app đăng nhập giữ nguyên đường cũ");
  console.log("✓ App Meta riêng cho Messenger: cùng mã xác minh · bắt tay GET trả challenge · chữ ký app mới nhận khi đã khai, app lạ 401 · secret đi đủ đường deploy → .env");
}
