/**
 * THÔNG BÁO ĐẨY (0213 · lib/push/*). Không gọi mạng (luật 65): máy chủ đẩy là hàm GIẢ.
 *
 *  1. THUẦN — mã hoá RFC 8291 khớp ĐÚNG véc-tơ mẫu của RFC (Phụ lục A); JWT VAPID kiểm được bằng khoá công khai, `aud` là
 *     gốc của endpoint; khoá VAPID dẫn xuất ổn định từ bí mật; chỉ nhận máy chủ đẩy đã biết (chặn SSRF); nhiều tin cùng người
 *     ⇒ một thông báo.
 *  2. CSDL THẬT — lưu đăng ký (endpoint lạ ⇒ từ chối; cùng máy người khác bật ⇒ chuyển chủ); gửi ⇒ đúng máy của đúng người,
 *     nội dung mã hoá aes128gcm + VAPID; 410 ⇒ xoá đăng ký; lỗi tạm ⇒ giữ, ghi lỗi; tin vào HỘP THƯ ⇒ tự đẩy, tin trùng không
 *     đẩy lại; tắt chỉ xoá đăng ký của chính người bấm.
 */
import assert from "node:assert/strict";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { sendInboxMessages } from "@/lib/inbox/send";
import { groupPushItems, pushToUsers, removePushSubscription, savePushSubscription, setPushFetchForTests } from "@/lib/push/service";
import { allowedPushEndpoint, encryptPushPayload, vapidAuthorization, vapidKeysFrom } from "@/lib/push/web-push";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function testPure() {
  // RFC 8291 Phụ lục A.
  const out = encryptPushPayload(Buffer.from("When I grow up, I want to be a watermelon"), "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg", {
    salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
    asPrivate: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
  });
  assert.equal(
    b64u(out),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    "mã hoá aes128gcm khớp véc-tơ RFC 8291",
  );

  const keys = vapidKeysFrom("bi-mat-thu-nghiem-0123456789");
  assert.equal(keys.publicKey, vapidKeysFrom("bi-mat-thu-nghiem-0123456789").publicKey, "cùng bí mật ⇒ cùng khoá");
  assert.notEqual(keys.publicKey, vapidKeysFrom("bi-mat-khac-0123456789").publicKey);
  assert.equal(keys.publicRaw.length, 65);
  const now = new Date("2026-10-05T00:00:00Z");
  const auth = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:x@y.vn", now);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m, auth);
  assert.equal(m[4], keys.publicKey);
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(keys.publicRaw.subarray(1, 33)), y: b64u(keys.publicRaw.subarray(33, 65)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")), "chữ ký ES256 kiểm được bằng khoá công khai");
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString()) as { aud: string; exp: number; sub: string };
  assert.deepEqual([claims.aud, claims.sub, claims.exp - now.getTime() / 1000], ["https://fcm.googleapis.com", "mailto:x@y.vn", 12 * 3600]);

  for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/Q", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.ok(allowedPushEndpoint(ok), ok);
  for (const bad of ["http://fcm.googleapis.com/x", "https://evil.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x", "https://127.0.0.1/x", "https://u:p@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "không-phải-url"])
    assert.equal(allowedPushEndpoint(bad), false, bad);

  const grouped = groupPushItems([
    { userId: "a", title: "T1", body: "B1", href: "/x", tag: "1" },
    { userId: "b", title: "T2", body: "B2", href: "/y" },
    { userId: "a", title: "T3", body: "B3", href: "/z" },
  ]);
  assert.deepEqual(
    grouped.map((g) => [g.userId, g.title, g.body, g.href]),
    [
      ["a", "T1", "B1 — và 1 tin khác trong hộp thư ERP", "/x"],
      ["b", "T2", "B2", "/y"],
    ],
    "một người một thông báo mỗi lượt",
  );
}

type Call = { url: string; init: RequestInit };
function fakePushServer(statusFor: (url: string) => number) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    return new Response(null, { status: statusFor(url) });
  }) as typeof fetch;
  return { calls, fetch: f };
}

function browserKeys() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) };
}

async function waitFor(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

async function testDb() {
  const db = await getDb();
  const u = schema.users;
  const [alice, bob] = await db
    .insert(u)
    .values([
      { email: "push-alice@test.vn", name: "Alice", passwordHash: "x", role: "ADMIN" },
      { email: "push-bob@test.vn", name: "Bob", passwordHash: "x", role: "VIEWER" },
    ])
    .returning({ id: u.id });
  const t = schema.pushSubscriptions;
  try {
    const EP_PHONE = "https://fcm.googleapis.com/fcm/send/phone-1";
    const EP_OLD = "https://updates.push.services.mozilla.com/wpush/v2/old-1";
    const EP_FLAKY = "https://web.push.apple.com/flaky-1";
    assert.deepEqual(await savePushSubscription(alice.id, { endpoint: "https://evil.example/push", ...browserKeys() }), { error: "Trình duyệt này dùng máy chủ thông báo ERP không hỗ trợ." }, "endpoint lạ ⇒ từ chối");
    for (const ep of [EP_PHONE, EP_OLD, EP_FLAKY]) assert.deepEqual(await savePushSubscription(alice.id, { endpoint: ep, ...browserKeys(), userAgent: "Thử" }), { ok: true });
    // Cùng máy, Bob đăng nhập rồi bật ⇒ đăng ký chuyển sang Bob; bật lại lần hai không nhân đôi.
    await savePushSubscription(bob.id, { endpoint: EP_FLAKY, ...browserKeys() });
    await savePushSubscription(bob.id, { endpoint: EP_FLAKY, ...browserKeys() });
    const rows = await db.select({ userId: t.userId, endpoint: t.endpoint }).from(t).where(inArray(t.userId, [alice.id, bob.id]));
    assert.deepEqual(rows.map((r) => `${r.userId === alice.id ? "A" : "B"}:${r.endpoint}`).sort(), [`A:${EP_OLD}`, `A:${EP_PHONE}`, `B:${EP_FLAKY}`].sort());

    const server = fakePushServer((url) => (url === EP_OLD ? 410 : url === EP_FLAKY ? 503 : 201));
    const r = await pushToUsers(
      [
        { userId: alice.id, title: "Khách cần người", body: "Chị Mai hỏi size", href: "/ai/sales-chatbot/inbox?c=1" },
        { userId: bob.id, title: "Lương chờ duyệt", body: "", href: "/payroll" },
      ],
      { fetch: server.fetch },
    );
    assert.deepEqual(r, { sent: 1, failed: 1, removed: 1 });
    assert.deepEqual(server.calls.map((c) => c.url).sort(), [EP_FLAKY, EP_OLD, EP_PHONE].sort(), "đúng máy của đúng người");
    const phone = server.calls.find((c) => c.url === EP_PHONE);
    const h = new Headers(phone?.init.headers);
    assert.equal(h.get("content-encoding"), "aes128gcm");
    assert.match(h.get("authorization") ?? "", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    const body = Buffer.from(phone?.init.body as Uint8Array);
    assert.ok(body.length > 86 && !body.includes(Buffer.from("Chị Mai")), "nội dung đã mã hoá, không đi dạng chữ");
    const after = await db.select({ endpoint: t.endpoint, lastOkAt: t.lastOkAt, lastError: t.lastError }).from(t).where(inArray(t.userId, [alice.id, bob.id]));
    assert.deepEqual(
      after.map((a) => [a.endpoint, Boolean(a.lastOkAt), a.lastError]).sort(),
      [
        [EP_FLAKY, false, "Máy chủ đẩy trả HTTP 503"],
        [EP_PHONE, true, null],
      ].sort(),
      "410 ⇒ xoá; 503 ⇒ giữ + ghi lỗi; 201 ⇒ ghi mốc",
    );

    // Tin vào HỘP THƯ ⇒ tự đẩy (không chờ), tin trùng không đẩy lại.
    const hook = fakePushServer(() => 201);
    setPushFetchForTests(hook.fetch);
    const msg = { userId: alice.id, kind: "TEST_PUSH", title: "Chatbot chuyển khách", body: "Khách cần người", href: "/ai/sales-chatbot/inbox", dedupeKey: "push-test:1" };
    assert.equal(await sendInboxMessages([msg]), 1);
    await waitFor(() => hook.calls.length >= 1);
    assert.deepEqual(hook.calls.map((c) => c.url), [EP_PHONE], "tin hộp thư ⇒ một thông báo tới máy của người nhận");
    assert.equal(await sendInboxMessages([msg]), 0);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(hook.calls.length, 1, "tin trùng không đẩy lại");

    // Tắt: chỉ xoá đăng ký của chính người bấm.
    assert.equal(await removePushSubscription(bob.id, EP_PHONE), 0, "Bob không tắt được máy của Alice");
    assert.equal(await removePushSubscription(alice.id, EP_PHONE), 1);
  } finally {
    setPushFetchForTests(null);
    await db.delete(schema.userMessages).where(inArray(schema.userMessages.userId, [alice.id, bob.id]));
    await db.delete(u).where(inArray(u.id, [alice.id, bob.id]));
    assert.equal((await db.select({ id: t.id }).from(t).where(eq(t.userId, bob.id))).length, 0, "xoá tài khoản ⇒ đăng ký đi theo");
  }
}

export async function testPush() {
  testPure();
  await testDb();
  console.log("✓ thông báo đẩy: RFC 8291 + VAPID, chỉ máy chủ đẩy đã biết, gửi đúng máy đúng người, 410 ⇒ xoá, tin hộp thư tự đẩy");
}
