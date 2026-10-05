/**
 * XÁC MINH SĐT KHI ĐĂNG KÝ QUA ZALO ZNS (0214 · lib/onboarding/phone-otp.ts). Không gọi mạng (luật 65): Zalo là hàm GIẢ.
 *
 *  1. ZNS — đúng địa chỉ, `access_token` ở tiêu đề, thân {phone, template_id, template_data}; lỗi phía SỐ (-118 …) tách khỏi
 *     lỗi phía nền tảng; token và mã không lọt vào câu lỗi.
 *  2. CÀI ĐẶT — mặc định TẮT; bật cần mẫu ZNS + OA nhà đã nối; mẫu sai khuôn ⇒ từ chối.
 *  3. GỬI / KIỂM — mã chỉ lưu băm; chờ giữa hai lần gửi; trần theo SĐT, theo IP; sai mã đếm lùi rồi khoá; mã hết hạn / đã
 *     dùng ⇒ phải xin mã mới; đăng ký nhanh thiếu / sai mã ⇒ `needOtp`, không tạo gì; người vận hành không cần mã.
 */
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { zaloSendZnsTemplate, ZALO_ZNS_TEMPLATE_URL } from "@/lib/integrations/zalo/oa";
import { consumeSignupOtp, otpHash, PHONE_OTP_LIMITS, PHONE_OTP_SETTING_KEY, phoneOtpRequired, readPhoneOtpSetting, sendSignupOtp, sendTestOtp, setPhoneOtpSetting, verifySignupOtp, type OtpSender } from "@/lib/onboarding/phone-otp";
import { quickSignup } from "@/lib/onboarding/quick";
import { hashIp } from "@/lib/onboarding/rate";
import { invalidateSignupSetting, SIGNUP_MODE_SETTING_KEY } from "@/lib/onboarding/signup-mode";

const ACTOR = { orgCode: "home", userId: "u-op", email: "op@vnx.test" };
const IP = "203.0.113.77";
const IP2 = "203.0.113.78";
const PHONES = ["84912000111", "84912000222", "84912000333", "84912000444", "84912000555"];

async function testZns() {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let next: unknown = { error: 0, message: "Success", data: { msg_id: "zns-1" } };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(next);
  }) as typeof globalThis.fetch;
  const TOKEN = "zalo-oa-access-token-0123456789abcdef";
  const ok = await zaloSendZnsTemplate({ accessToken: TOKEN, phone: "84912000111", templateId: "312345", data: { otp: "482913" }, trackingId: "otp-x" }, { fetch });
  assert.deepEqual(ok, { ok: true, messageId: "zns-1" });
  assert.equal(calls[0].url, ZALO_ZNS_TEMPLATE_URL);
  assert.equal(new Headers(calls[0].init.headers).get("access_token"), TOKEN);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { phone: "84912000111", template_id: "312345", template_data: { otp: "482913" }, tracking_id: "otp-x" });
  next = { error: -118, message: `Zalo account not existed ${TOKEN} 482913` };
  const phoneSide = await zaloSendZnsTemplate({ accessToken: TOKEN, phone: "84912000111", templateId: "312345", data: { otp: "482913" }, trackingId: "otp-y" }, { fetch });
  assert.ok(!phoneSide.ok && phoneSide.phoneSide, "số không dùng Zalo ⇒ lỗi phía SỐ");
  assert.ok(!phoneSide.ok && !phoneSide.error.includes(TOKEN) && !phoneSide.error.includes("482913"), "token và mã không lọt vào câu lỗi");
  next = { error: -124, message: "Access token invalid" };
  const platformSide = await zaloSendZnsTemplate({ accessToken: TOKEN, phone: "84912000111", templateId: "312345", data: { otp: "1" }, trackingId: "otp-z" }, { fetch });
  assert.ok(!platformSide.ok && !platformSide.phoneSide, "token hỏng ⇒ lỗi phía nền tảng");
}

async function withOpen<T>(fn: () => Promise<T>): Promise<T> {
  const pdb = await getPlatformDb();
  const envBefore = process.env.PLATFORM_SIGNUP_MODE;
  const mode = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  process.env.PLATFORM_SIGNUP_MODE = "open";
  await pdb.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, [SIGNUP_MODE_SETTING_KEY, PHONE_OTP_SETTING_KEY]));
  await pdb.insert(schema.platformSettings).values({ key: SIGNUP_MODE_SETTING_KEY, value: "open", updatedByEmail: "otp-test@local" });
  invalidateSignupSetting();
  try {
    return await fn();
  } finally {
    if (envBefore === undefined) delete process.env.PLATFORM_SIGNUP_MODE;
    else process.env.PLATFORM_SIGNUP_MODE = envBefore;
    await pdb.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, [SIGNUP_MODE_SETTING_KEY, PHONE_OTP_SETTING_KEY]));
    if (mode) await pdb.insert(schema.platformSettings).values({ key: mode.key, value: mode.value, updatedByEmail: mode.updatedByEmail });
    invalidateSignupSetting();
    await readPhoneOtpSetting({ fresh: true });
    await pdb.delete(schema.platformPhoneOtps).where(inArray(schema.platformPhoneOtps.phone, PHONES));
  }
}

async function testFlow() {
  const pdb = await getPlatformDb();
  const t = schema.platformPhoneOtps;
  const who = { kind: "public" as const, ip: IP };
  const sent: { phone: string; code: string; templateId: string; param: string }[] = [];
  const send: OtpSender = async (i) => {
    sent.push(i);
    return { ok: true };
  };
  const lastCode = () => sent.at(-1)?.code ?? "";

  // Cài đặt: mặc định TẮT; bật cần mẫu + OA nhà.
  assert.equal(await phoneOtpRequired(), false, "mặc định tắt");
  assert.deepEqual(await sendSignupOtp("0912000111", who, { send }), { error: "Đăng ký hiện không cần mã xác minh." });
  assert.ok("error" in (await setPhoneOtpSetting(ACTOR, { enabled: true, templateId: "" }, { zaloConnected: async () => true })), "bật mà thiếu mẫu ⇒ từ chối");
  assert.ok("error" in (await setPhoneOtpSetting(ACTOR, { enabled: true, templateId: "abc" }, { zaloConnected: async () => true })), "mẫu sai khuôn");
  assert.ok("error" in (await setPhoneOtpSetting(ACTOR, { enabled: true, templateId: "312345" }, { zaloConnected: async () => false })), "OA nhà chưa nối ⇒ từ chối");
  const on = await setPhoneOtpSetting(ACTOR, { enabled: true, templateId: "312345", param: "otp" }, { zaloConnected: async () => true });
  assert.ok("ok" in on && on.setting.enabled, JSON.stringify(on));
  assert.equal(await phoneOtpRequired(), true);

  // Gửi: mã 6 số tới đúng số, đúng mẫu; CSDL chỉ giữ băm.
  const now = new Date();
  const r1 = await sendSignupOtp("0912 000 111", who, { send, now });
  assert.ok("ok" in r1 && r1.sentTo === "0912 000 111", JSON.stringify(r1));
  assert.match(lastCode(), /^\d{6}$/);
  assert.deepEqual([sent[0].phone, sent[0].templateId, sent[0].param], ["84912000111", "312345", "otp"]);
  const [row] = await pdb.select().from(t).where(eq(t.phone, "84912000111"));
  assert.ok(row.codeHash === otpHash("84912000111", lastCode()) && !JSON.stringify(row).includes(`"${lastCode()}"`) && row.ipHash === hashIp(IP), "mã và IP chỉ lưu băm");
  // Chờ giữa hai lần gửi.
  const again = await sendSignupOtp("0912000111", who, { send, now: new Date(now.getTime() + 10_000) });
  assert.ok("error" in again && again.retryAfterSeconds === 50, JSON.stringify(again));

  // Kiểm: sai ⇒ đếm lùi; đúng ⇒ qua nhưng CHƯA tiêu (tạo hỏng thì dùng lại được); tiêu rồi ⇒ phải xin mã mới.
  const wrong = lastCode() === "000000" ? "111111" : "000000";
  assert.deepEqual(await verifySignupOtp("84912000111", wrong), { error: `Mã không đúng — còn ${PHONE_OTP_LIMITS.maxAttempts - 1} lần thử.` });
  const good = await verifySignupOtp("84912000111", lastCode());
  assert.ok("ok" in good && good.id === row.id);
  assert.ok("ok" in (await verifySignupOtp("84912000111", lastCode())), "chưa tiêu ⇒ kiểm lại vẫn qua");
  assert.ok("error" in (await verifySignupOtp("84912000111", lastCode(), new Date(now.getTime() + 6 * 60_000))), "quá 5 phút ⇒ hết hạn");
  await consumeSignupOtp(row.id);
  assert.ok("error" in (await verifySignupOtp("84912000111", lastCode())), "đã dùng ⇒ hết hiệu lực");

  // Sai quá trần ⇒ khoá mã đó, kể cả khi sau đó nhập đúng.
  await sendSignupOtp("0912000222", who, { send });
  const code2 = lastCode();
  const bad2 = code2 === "999999" ? "888888" : "999999";
  for (let i = 0; i < PHONE_OTP_LIMITS.maxAttempts; i++) await verifySignupOtp("84912000222", bad2);
  assert.deepEqual(await verifySignupOtp("84912000222", code2), { error: "Nhập sai quá nhiều lần — gửi mã mới." });

  // Trần theo SĐT (3/giờ) và theo IP (5/giờ) — đếm từ bảng.
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  assert.ok("ok" in (await sendSignupOtp("0912000333", { kind: "public", ip: IP2 }, { send, now: later(2) })));
  assert.ok("ok" in (await sendSignupOtp("0912000333", { kind: "public", ip: IP2 }, { send, now: later(4) })));
  assert.ok("ok" in (await sendSignupOtp("0912000333", { kind: "public", ip: IP2 }, { send, now: later(6) })));
  assert.deepEqual(await sendSignupOtp("0912000333", { kind: "public", ip: IP2 }, { send, now: later(8) }), { error: "Số này đã nhận đủ số mã cho một giờ — thử lại sau." });
  assert.ok("ok" in (await sendSignupOtp("0912000444", who, { send, now: later(2) })));
  assert.ok("ok" in (await sendSignupOtp("0912000444", who, { send, now: later(4) })));
  assert.ok("ok" in (await sendSignupOtp("0912000444", who, { send, now: later(6) })));
  assert.deepEqual(await sendSignupOtp("0912000444", who, { send, now: later(8) }), { error: "Số này đã nhận đủ số mã cho một giờ — thử lại sau." });
  assert.deepEqual(await sendSignupOtp("0912000555", who, { send, now: later(8) }), { error: "Máy này đã xin quá nhiều mã trong một giờ — thử lại sau." }, "IP 1 đã xin 5 mã (111, 222, 444 × 3)");

  // Zalo từ chối số ⇒ câu cho khách; vẫn tính vào trần (dòng FAILED).
  const fail: OtpSender = async () => ({ ok: false, error: "Zalo từ chối (-118)", phoneSide: true });
  await pdb.delete(t).where(eq(t.ipHash, hashIp(IP2)));
  const f = await sendSignupOtp("0912000333", { kind: "public", ip: IP2 }, { send: fail, now: later(70) });
  assert.ok("error" in f && f.error.includes("số có dùng Zalo"), JSON.stringify(f));

  // Người vận hành không cần mã; gửi thử không ghi bảng mã.
  const op = { kind: "operator" as const, ip: IP, actor: ACTOR };
  assert.ok("error" in (await sendSignupOtp("0912000111", op, { send })));
  const before = (await pdb.select({ id: t.id }).from(t).where(inArray(t.phone, PHONES))).length;
  assert.ok("ok" in (await sendTestOtp({ phone: "0912000111", templateId: "312345", param: "otp" }, { send })));
  assert.equal((await pdb.select({ id: t.id }).from(t).where(inArray(t.phone, PHONES))).length, before, "gửi thử không ghi bảng mã");

  // Đăng ký nhanh: thiếu / sai mã ⇒ `needOtp`, KHÔNG tạo gì (bước mã đứng trước mọi việc dựng).
  const orgsBefore = (await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations)).length;
  const noCode = await quickSignup({ storeName: "OTP Thiếu Mã", businessType: "food", phone: "0912000111", email: "otp@thieu.vn", password: "mat-khau-dai-123" }, who);
  assert.ok("error" in noCode && noCode.needOtp === true, JSON.stringify(noCode));
  assert.equal((await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations)).length, orgsBefore, "không tạo tổ chức");
}

export async function testPhoneOtp() {
  await testZns();
  await withOpen(testFlow);
  console.log("✓ OTP Zalo khi đăng ký: mặc định tắt, mã chỉ lưu băm, trần gửi theo SĐT / IP, sai mã khoá, thiếu mã không tạo cửa hàng");
}
