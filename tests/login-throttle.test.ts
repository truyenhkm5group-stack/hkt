import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientIpFrom } from "@/lib/auth/client-ip";
import {
  LOGIN_THROTTLE,
  clearLoginFailures,
  loginAllowed,
  loginThrottleKeys,
  loginThrottleSize,
  recordLoginFailure,
  resetLoginThrottle,
} from "@/lib/auth/login-throttle";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { anySecretMatches, secretEquals } from "@/lib/auth/secret-compare";

/**
 * Chặn dò mật khẩu: khoá theo CẶP (email, IP) + trần theo IP; bộ nhớ có trần; đúng thì xoá CẶP.
 * Và hai hàng rào đi cùng màn đăng nhập: IP đọc đúng sau Caddy, đích chuyển hướng chỉ là đường nội bộ.
 */
export async function testLoginThrottle() {
  resetLoginThrottle();
  const t0 = 1_000_000;
  const nan = loginThrottleKeys("chu@shop.vn", "203.0.113.9"); // người thật
  const ke = loginThrottleKeys("chu@shop.vn", "198.51.100.7"); // kẻ biết email, ở máy khác

  assert.deepEqual(loginAllowed(nan, t0), { ok: true }, "chưa sai lần nào thì được thử");
  for (let i = 0; i < LOGIN_THROTTLE.maxFailures - 1; i++) recordLoginFailure(ke, t0 + i * 1000);
  assert.deepEqual(loginAllowed(ke, t0 + 5000), { ok: true }, "dưới ngưỡng vẫn được thử");
  recordLoginFailure(ke, t0 + 6000);
  const gate = loginAllowed(ke, t0 + 7000);
  assert.equal(gate.ok, false, "vượt ngưỡng thì chặn CẶP đang dò");
  assert.ok(!gate.ok && gate.retryAfterSec > 0 && gate.retryAfterSec <= LOGIN_THROTTLE.lockMs / 1000, "báo còn phải đợi bao lâu");
  // ĐÂY là lỗi cũ: khoá theo email trần ⇒ kẻ ở máy khác khoá được chủ shop.
  assert.deepEqual(loginAllowed(nan, t0 + 7000), { ok: true }, "kẻ dò ở IP khác KHÔNG được khoá người thật khỏi tài khoản của họ");
  assert.equal(loginAllowed(loginThrottleKeys("khac@shop.vn", "198.51.100.7"), t0 + 7000).ok, true, "dưới trần IP thì email khác từ cùng máy vẫn thử được");
  assert.equal(loginAllowed(ke, t0 + 6000 + LOGIN_THROTTLE.lockMs + 1).ok, true, "hết thời gian khoá thì mở lại");

  // Trần theo IP: quét nhiều tài khoản từ một máy (mỗi email một lần sai) vẫn bị chặn.
  resetLoginThrottle();
  const ipQuet = "192.0.2.50";
  for (let i = 0; i < LOGIN_THROTTLE.maxFailuresPerIp; i++) {
    const k = loginThrottleKeys(`nv${i}@shop.vn`, ipQuet);
    assert.equal(loginAllowed(k, t0 + i).ok, true, `lượt quét ${i} còn dưới trần IP`);
    recordLoginFailure(k, t0 + i);
  }
  assert.equal(loginAllowed(loginThrottleKeys("moi@shop.vn", ipQuet), t0 + 100).ok, false, "chạm trần IP ⇒ chặn mọi email từ IP đó");
  assert.equal(loginAllowed(loginThrottleKeys("moi@shop.vn", "192.0.2.51"), t0 + 100).ok, true, "IP khác không vạ lây");
  assert.ok(LOGIN_THROTTLE.maxFailuresPerIp > LOGIN_THROTTLE.maxFailures, "trần IP phải rộng hơn trần cặp — văn phòng dùng chung một IP");

  // Đăng nhập đúng chỉ xoá CẶP, không xoá IP: không "đặt lại" được bộ đếm IP bằng một tài khoản thật.
  resetLoginThrottle();
  const ipChung = "192.0.2.60";
  for (let i = 0; i < LOGIN_THROTTLE.maxFailuresPerIp - 1; i++) recordLoginFailure(loginThrottleKeys(`dò${i}@shop.vn`, ipChung), t0 + i);
  clearLoginFailures(loginThrottleKeys("that@shop.vn", ipChung));
  recordLoginFailure(loginThrottleKeys("dò-cuoi@shop.vn", ipChung), t0 + 200);
  assert.equal(loginAllowed(loginThrottleKeys("bat-ky@shop.vn", ipChung), t0 + 201).ok, false, "đăng nhập đúng xen giữa KHÔNG được xoá bộ đếm IP");
  const cap = loginThrottleKeys("a@shop.vn", "192.0.2.61");
  recordLoginFailure(cap, t0);
  clearLoginFailures(cap);
  for (let i = 0; i < LOGIN_THROTTLE.maxFailures - 1; i++) recordLoginFailure(cap, t0 + 1 + i);
  assert.equal(loginAllowed(cap, t0 + 100).ok, true, "đăng nhập đúng xoá lịch sử sai của CẶP");

  // Cửa sổ trượt: sai rải rác cách nhau hơn cửa sổ thì không cộng dồn.
  resetLoginThrottle();
  for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i++) recordLoginFailure(ke, t0 + i * (LOGIN_THROTTLE.windowMs + 1));
  assert.equal(loginAllowed(ke, t0 + LOGIN_THROTTLE.maxFailures * (LOGIN_THROTTLE.windowMs + 1)).ok, true, "lần sai ngoài cửa sổ không được tính");

  // Bộ nhớ có trần: đổ email rác từ nhiều IP không làm Map phình vô hạn, và không xả được khoá đang có.
  resetLoginThrottle();
  for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i++) recordLoginFailure(ke, t0 + i);
  assert.equal(loginAllowed(ke, t0 + 10).ok, false);
  for (let i = 0; i < LOGIN_THROTTLE.maxEntries + 500; i++) recordLoginFailure([`pair:rac${i}@x|10.0.${i >> 8}.${i & 255}`], t0 + 20);
  assert.ok(loginThrottleSize() <= LOGIN_THROTTLE.maxEntries, `bộ đếm phải có trần (${loginThrottleSize()} > ${LOGIN_THROTTLE.maxEntries})`);
  assert.equal(loginAllowed(ke, t0 + 30).ok, false, "đầy thì loại mục CHƯA khoá trước — kẻ dò không xả được khoá của chính mình bằng khoá rác");
  resetLoginThrottle();

  // ── IP sau Caddy: phần NGOÀI CÙNG BÊN PHẢI, không phải phần client tự khai ──
  assert.equal(clientIpFrom("203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpFrom("1.1.1.1, 203.0.113.9"), "203.0.113.9", "phần bên trái là client tự khai — đổi mỗi lần là né được trần IP");
  assert.equal(clientIpFrom("2001:DB8::1"), "2001:db8::1");
  assert.equal(clientIpFrom(null), "unknown");
  assert.equal(clientIpFrom(""), "unknown");
  assert.equal(clientIpFrom("1.2.3.4, <script>"), "unknown", "giá trị không giống IP không thành khoá của bộ đếm");
  const auth = readFileSync("lib/actions/auth.ts", "utf8");
  assert.ok(!auth.includes('"x-real-ip"'), "X-Real-IP đi thẳng từ client (Caddy không đặt nó) — không được đọc");
  assert.ok(auth.includes("loginThrottleKeys(") && !auth.includes("`email:"), "loginAction phải dùng khoá của bộ đếm, không tự dựng khoá theo email trần");

  // ── Đích chuyển hướng sau đăng nhập ──
  for (const tan of [
    "//evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "/\\/evil.com",
    "https://evil.com",
    "http:/evil.com",
    "javascript:alert(1)",
    "/\t/evil.com",
    "/\n/evil.com",
    "/..//evil.com",
    "/%2e%2e//evil.com",
    " /x",
    "evil.com",
    "",
  ]) {
    const r = safeNextPath(tan);
    assert.ok(r === "/" || (r.startsWith("/") && !r.startsWith("//") && !r.includes("\\")), `next=${JSON.stringify(tan)} ra ${JSON.stringify(r)}`);
    assert.equal(new URL(r, "https://erp.vnxcommerce.com").host, "erp.vnxcommerce.com", `next=${JSON.stringify(tan)} phải ở lại ERP`);
  }
  assert.equal(safeNextPath("/\\evil.com"), "/", "đúng ca đã báo: /\\evil.com");
  assert.equal(safeNextPath("/..//evil.com"), "/", "chuẩn hoá ra //evil.com ⇒ bị chặn SAU chuẩn hoá");
  assert.equal(safeNextPath(undefined), "/");
  assert.equal(safeNextPath("/orders?tab=cho&page=2#dong-3"), "/orders?tab=cho&page=2#dong-3", "đường nội bộ giữ nguyên query + hash");
  assert.equal(safeNextPath("/marketing/creatives"), "/marketing/creatives");
  const trang = readFileSync("app/login/page.tsx", "utf8");
  assert.ok(trang.includes("safeNextPath(") && !trang.includes('params.next.startsWith("/")'), "trang /login (đã đăng nhập) cũng phải đi qua safeNextPath");
  assert.ok(auth.includes("redirect(safeNextPath(next))"), "loginAction phải chuyển hướng qua safeNextPath");

  // so sánh bí mật hằng thời gian
  assert.equal(secretEquals("abc", "abc"), true);
  assert.equal(secretEquals("abc", "abd"), false);
  assert.equal(secretEquals("", "abc"), false, "rỗng không bao giờ khớp");
  assert.equal(secretEquals("abc", undefined), false, "chưa cấu hình thì không ai khớp được");
  assert.equal(anySecretMatches(["x", "abc"], "abc"), true);
  assert.equal(anySecretMatches(["x"], ""), false);
  console.log("✓ chặn dò mật khẩu theo cặp (email, IP) + trần IP + bộ nhớ có trần · IP đọc sau Caddy · next chỉ là đường nội bộ · so sánh bí mật hằng thời gian");
}
