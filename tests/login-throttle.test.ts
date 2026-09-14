import assert from "node:assert/strict";
import { LOGIN_THROTTLE, clearLoginFailures, loginAllowed, recordLoginFailure, resetLoginThrottle } from "@/lib/auth/login-throttle";
import { anySecretMatches, secretEquals } from "@/lib/auth/secret-compare";

/** Chặn dò mật khẩu: 5 lần sai trong 15 phút ⇒ khoá 15 phút, theo email VÀ theo IP; đúng thì xoá. */
export async function testLoginThrottle() {
  resetLoginThrottle();
  const t0 = 1_000_000;
  const keys = ["email:a@shop.vn", "ip:1.2.3.4"];
  assert.deepEqual(loginAllowed(keys, t0), { ok: true }, "chưa sai lần nào thì được thử");
  for (let i = 0; i < LOGIN_THROTTLE.maxFailures - 1; i++) recordLoginFailure(keys, t0 + i * 1000);
  assert.deepEqual(loginAllowed(keys, t0 + 5000), { ok: true }, "dưới ngưỡng vẫn được thử");
  recordLoginFailure(keys, t0 + 6000);
  const gate = loginAllowed(["email:a@shop.vn"], t0 + 7000);
  assert.equal(gate.ok, false, "vượt ngưỡng thì chặn theo email");
  assert.ok(!gate.ok && gate.retryAfterSec > 0 && gate.retryAfterSec <= LOGIN_THROTTLE.lockMs / 1000, "báo còn phải đợi bao lâu");
  assert.equal(loginAllowed(["ip:1.2.3.4"], t0 + 7000).ok, false, "và chặn theo IP — quét nhiều tài khoản từ một máy cũng bị chặn");
  assert.equal(loginAllowed(["email:b@shop.vn", "ip:9.9.9.9"], t0 + 7000).ok, true, "tài khoản khác, máy khác không bị vạ lây");
  assert.equal(loginAllowed(keys, t0 + 6000 + LOGIN_THROTTLE.lockMs + 1).ok, true, "hết thời gian khoá thì mở lại");
  // cửa sổ trượt: sai rải rác cách nhau hơn cửa sổ thì không cộng dồn
  resetLoginThrottle();
  for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i++) recordLoginFailure(keys, t0 + i * (LOGIN_THROTTLE.windowMs + 1));
  assert.equal(loginAllowed(keys, t0 + LOGIN_THROTTLE.maxFailures * (LOGIN_THROTTLE.windowMs + 1)).ok, true, "lần sai ngoài cửa sổ không được tính");
  recordLoginFailure(keys, t0);
  clearLoginFailures(keys);
  assert.equal(loginAllowed(keys, t0).ok, true, "đăng nhập đúng xoá lịch sử sai");

  // so sánh bí mật hằng thời gian
  assert.equal(secretEquals("abc", "abc"), true);
  assert.equal(secretEquals("abc", "abd"), false);
  assert.equal(secretEquals("", "abc"), false, "rỗng không bao giờ khớp");
  assert.equal(secretEquals("abc", undefined), false, "chưa cấu hình thì không ai khớp được");
  assert.equal(anySecretMatches(["x", "abc"], "abc"), true);
  assert.equal(anySecretMatches(["x"], ""), false);
  console.log("✓ chặn dò mật khẩu + so sánh bí mật hằng thời gian");
}
