import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/webhooks/messenger/route";
import { META_CONNECT_SCOPES, auditRequestedScopes, messengerAppFrom, messengerConnectUrl, messengerVerifyToken, scopesOfConnectUrl, verifyMessengerSignatureAny, webhookSecretsFrom } from "@/lib/integrations/messenger/graph";

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
  // 5 · CHUYỂN APP cho đường nối page: app Messenger khi ĐỦ cặp, không thì app đăng nhập; nửa cặp không bao giờ được trộn.
  const login = { id: "111", secret: "login-secret" };
  assert.deepEqual(messengerAppFrom(login, { id: "222", secret: "messenger-secret" }), { appId: "222", appSecret: "messenger-secret", source: "MESSENGER_APP" });
  assert.deepEqual(messengerAppFrom(login, { id: "", secret: "" }), { appId: "111", appSecret: "login-secret", source: "LOGIN_APP" }, "chưa khai app mới ⇒ hành vi cũ");
  assert.equal(messengerAppFrom(login, { id: "222", secret: "" })?.source, "LOGIN_APP", "thiếu secret app mới ⇒ KHÔNG dùng ID của nó với secret app kia");
  assert.equal(messengerAppFrom(login, { id: "", secret: "messenger-secret" })?.source, "LOGIN_APP");
  assert.equal(messengerAppFrom({ id: "", secret: "" }, { id: "", secret: "" }), null);
  const app = { appId: "222", appSecret: "messenger-secret" };
  const viaScope = new URL(messengerConnectUrl(app, "https://erp.example.test/api/connect/messenger/callback", "st"));
  assert.equal(viaScope.searchParams.get("client_id"), "222", "hộp thoại đi bằng app Messenger");
  assert.ok(viaScope.searchParams.get("scope")?.includes("pages_messaging") && !viaScope.searchParams.has("config_id"), "không Configuration ID ⇒ xin quyền bằng scope");
  // 07/10/2026 «Invalid Scopes»: hộp thoại Messenger CHỈ xin quyền Facebook Page — không quyền Instagram, không quyền nào ngoài bộ.
  const xin = scopesOfConnectUrl(viaScope.toString()) ?? [];
  assert.ok(!xin.includes("instagram_basic"), "Messenger KHÔNG xin instagram_basic");
  assert.ok(!xin.includes("instagram_manage_messages"), "Messenger KHÔNG xin instagram_manage_messages");
  assert.ok(!xin.some((p) => p.startsWith("instagram_")), "Messenger không xin bất kỳ quyền instagram_* nào");
  assert.deepEqual([...xin].sort(), ["pages_manage_metadata", "pages_messaging", "pages_read_engagement", "pages_show_list", "public_profile"], "đúng NĂM quyền Facebook Page, không hơn không kém");
  const kiem = auditRequestedScopes(xin, "FACEBOOK_MESSENGER");
  assert.deepEqual([kiem.missing, kiem.excess, kiem.foreign], [[], [], []], "bộ quyền hộp thoại khớp đúng khả năng FACEBOOK_MESSENGER");
  // Bộ chẩn đoán bắt được đúng lỗi cũ: quyền Instagram lẫn vào luồng Messenger là «của luồng khác», thiếu quyền Page là «thiếu».
  const cu = auditRequestedScopes(["pages_show_list", "pages_messaging", "business_management", "instagram_basic", "instagram_manage_messages"], "FACEBOOK_MESSENGER");
  assert.deepEqual(cu.foreign, ["instagram_basic", "instagram_manage_messages"], "chẩn đoán gọi tên quyền Instagram lạc vào Messenger");
  assert.deepEqual(cu.excess, ["business_management", "instagram_basic", "instagram_manage_messages"]);
  assert.deepEqual(cu.missing, ["public_profile", "pages_manage_metadata", "pages_read_engagement"]);
  // Instagram là khả năng RIÊNG (luồng kết nối sau này) — hai bộ không giao nhau, không gộp vào một danh sách cứng.
  assert.ok(META_CONNECT_SCOPES.INSTAGRAM_MESSAGING.every((p) => !(META_CONNECT_SCOPES.FACEBOOK_MESSENGER as readonly string[]).includes(p)), "bộ Instagram tách khỏi bộ Messenger");
  assert.equal(scopesOfConnectUrl(new URL(messengerConnectUrl(app, "https://x/cb", "st", "987654")).toString()), null, "đi bằng config_id ⇒ bộ quyền do Meta quyết, không có scope");
  const nutKetNoi = readFileSync(path.join(root, "app/api/connect/messenger/start/route.ts"), "utf8");
  assert.ok(nutKetNoi.includes("messengerConnectUrl(") && !/instagram_/.test(nutKetNoi), "nút «Kết nối Facebook Page» đi đúng hàm dựng hộp thoại Facebook, không tự ghép quyền Instagram");
  const viaConfig = new URL(messengerConnectUrl(app, "https://erp.example.test/api/connect/messenger/callback", "st", " 987654 "));
  assert.equal(viaConfig.searchParams.get("config_id"), "987654", "Login for Business ⇒ config_id");
  assert.ok(!viaConfig.searchParams.has("scope"), "có config_id thì không gửi scope (Meta bỏ qua scope ở app Doanh nghiệp)");
  assert.equal(viaConfig.searchParams.get("response_type"), "code");
  assert.equal(viaConfig.searchParams.get("override_default_response_type"), "true", "vẫn nhận MÃ để đổi token phía máy chủ");
  assert.ok(!messengerConnectUrl(app, "https://x/cb", "st").includes("messenger-secret"), "secret không bao giờ nằm trong URL hộp thoại");
  const msgSrc = readFileSync(path.join(root, "lib/sales-chatbot/messenger.ts"), "utf8");
  assert.ok(msgSrc.includes("messengerBotAppIds().includes(ev.appId)"), "tiếng vọng của app Messenger LẪN app đăng nhập đều là tin của bot — không thì bot tự nhường cho chính mình");
  const start = readFileSync(path.join(root, "app/api/connect/messenger/start/route.ts"), "utf8");
  assert.ok(start.includes("env.oauth.facebookMessengerLoginConfigId"), "nút kết nối truyền Configuration ID (nếu khai)");
  assert.ok(deploy.includes("FACEBOOK_MESSENGER_LOGIN_CONFIG_ID: ${{ vars.FACEBOOK_MESSENGER_LOGIN_CONFIG_ID }}") && install.includes("upsert_env FACEBOOK_MESSENGER_LOGIN_CONFIG_ID"), "Configuration ID đi đủ đường lên máy chủ");

  console.log("✓ Chuyển app cho đường nối page: app Messenger khi đủ cặp, không trộn nửa cặp · scope hoặc config_id · tiếng vọng của cả hai app là bot");
  console.log("✓ App Meta riêng cho Messenger: cùng mã xác minh · bắt tay GET trả challenge · chữ ký app mới nhận khi đã khai, app lạ 401 · secret đi đủ đường deploy → .env");
}
