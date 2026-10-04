/**
 * GIA NHẬP NHANH (0193 · docs/platform/quick-start.md).
 *
 *  1. THUẦN — SĐT di động VN (mọi cách gõ ⇒ `84…`, số bàn / nước ngoài ⇒ null), ô đăng nhập email-hoặc-SĐT, mã tổ chức
 *     từ tên cửa hàng (bỏ dấu, chữ đầu, mã dành riêng), module của ngành hàng LUÔN có «AI bán hàng» + phụ thuộc.
 *  2. OAUTH (nhà cung cấp GIẢ — luật 65, không gọi mạng): URL mang `state` + PKCE đúng; cookie ký không dùng chéo được giữa
 *     hai luồng; Google: sai `aud` / `iss` / hết hạn ⇒ từ chối, email chưa xác minh ⇒ không dùng email; Facebook: gửi
 *     `appsecret_proof`, đọc mã người dùng + email.
 *  3. CSDL THẬT: đăng ký nhanh tạo tổ chức qua ĐÚNG lõi tạo tổ chức, đăng nhập ngay, ghi SĐT + chỉ mục danh tính; bấm lại ⇒
 *     không đẻ cửa hàng thứ hai; đăng nhập bằng SĐT ở trang chung không cần mã tổ chức; đăng ký bằng Google ⇒ mật khẩu
 *     ngẫu nhiên + danh tính GOOGLE, lần sau Google vào thẳng; email ở hai tổ chức ⇒ phải chọn.
 *  4. DÙNG THỬ 14 NGÀY: nền tảng chưa khai tài khoản nhận tiền ⇒ KHÔNG bật thu phí (không khoá oan); đã khai ⇒ cửa hàng
 *     tự đăng ký có `paid_through` = hôm nay + 13, ân hạn 3 ngày, dải nhắc «Dùng thử»; tổ chức không qua cửa mở ⇒ không đụng.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray, or } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { findIdentity } from "@/lib/auth/identities";
import { displayPhone, normalizePhone, parseLoginIdentifier } from "@/lib/auth/identity-shared";
import { completeProviderLogin, credentialsMatch, loginCandidates, verifyLogin } from "@/lib/auth/login";
import { beginOAuth, exchangeCode, readOAuthToken, signOAuthToken } from "@/lib/auth/oauth";
import type { SessionSubject } from "@/lib/auth/session";
import { resolveSocial } from "@/lib/auth/social";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { billingNotice, billingStanding, TRIAL_GRACE_DAYS, trialPaidThrough, vnDate } from "@/lib/billing/rules";
import { BILLING_RECEIVER_KEY } from "@/lib/billing/service";
import { invalidateSubscriptions, readSubscriptionTerms } from "@/lib/billing/standing";
import { invalidateAiControl } from "@/lib/ai-usage/control";
import { PLATFORM_GEMINI_DEFAULT_MODEL, platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { DEFAULT_SALES_CHATBOT_CONFIG, salesBotBillingSource } from "@/lib/sales-chatbot/config";
import { quickModules, quickSignup } from "@/lib/onboarding/quick";
import { orgCodeBase, orgCodeCandidates } from "@/lib/onboarding/quick-shared";
import { hashIp } from "@/lib/onboarding/rate";
import { invalidateSignupSetting, SIGNUP_MODE_SETTING_KEY } from "@/lib/onboarding/signup-mode";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const QS_A = "qs-banh-mi-mot";
const QS_B = "qs-hai-san-hai";
const QS_C = "qs-ba";
const ORGS = [QS_A, `${QS_A}-2`, QS_B, `${QS_B}-2`, QS_C] as const;
const IP = "203.0.113.91";
const PW = "MatKhau@2026";

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  for (const raw of ["0912345678", "0912 345 678", "0912.345.678", "+84 912 345 678", "84912345678", "(+84) 912-345-678"]) assert.equal(normalizePhone(raw), "84912345678", raw);
  for (const raw of ["0243 123 4567", "091234567", "+1 415 555 0100", "0612345678", "abc", "", "84 91 2+345678"]) assert.equal(normalizePhone(raw), null, `«${raw}» không phải di động VN`);
  assert.equal(normalizePhone("0387 654 321"), "84387654321", "đầu số 03 mới");
  assert.equal(displayPhone("84912345678"), "0912 345 678");
  assert.deepEqual(parseLoginIdentifier(" Ban@Shop.VN "), { kind: "EMAIL", value: "ban@shop.vn" });
  assert.deepEqual(parseLoginIdentifier("0912 345 678"), { kind: "PHONE", value: "84912345678" });
  assert.equal(parseLoginIdentifier("ban@"), null);
  assert.equal(parseLoginIdentifier("chu-shop"), null);

  assert.equal(orgCodeBase("Hải Sản Làng Chài"), "hai-san-lang-chai");
  assert.equal(orgCodeBase("Đặc sản Đà Lạt!!"), "dac-san-da-lat");
  assert.equal(orgCodeBase("123 Shop"), "shop-123-shop", "mã phải bắt đầu bằng chữ");
  assert.equal(orgCodeBase("Admin"), "admin-shop", "không cấp mã dành riêng");
  assert.equal(orgCodeBase("!!!"), "shop");
  assert.ok(orgCodeBase("Một tên cửa hàng rất rất dài hơn hai mươi tư ký tự").length <= 24);
  assert.deepEqual(orgCodeCandidates("abc").slice(0, 3), ["abc", "abc-2", "abc-3"]);
  for (const t of ["ai_sales", "food", "seafood", "fashion", "spa", "restaurant", "ecommerce"] as const) {
    const m = quickModules(t).modules;
    for (const k of ["ai_sales", "customers", "products", "orders", "inventory"]) assert.ok(m.includes(k), `${t}: thiếu ${k} — đăng ký nhanh là để vào việc với Fanpage ngay`);
  }
}

// ═══════════ 2 · OAUTH (nhà cung cấp giả) ═══════════

function fakeJwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(payload)}.chu-ky-gia`;
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function testOAuth() {
  const cfg = { clientId: "gid.apps.googleusercontent.com", clientSecret: "g-secret" };
  const g = beginOAuth("google", cfg);
  const url = new URL(g.url);
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("state"), g.state);
  assert.equal(url.searchParams.get("client_id"), cfg.clientId);
  assert.ok(url.searchParams.get("redirect_uri")?.endsWith("/login/oauth/google/callback"));
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(g.verifier).digest("base64url"), "PKCE S256");
  assert.notEqual(beginOAuth("google", cfg).state, g.state, "state ngẫu nhiên mỗi lượt");
  const f = new URL(beginOAuth("facebook", { clientId: "fb-app", clientSecret: "fb-secret" }).url);
  assert.equal(f.hostname, "www.facebook.com");
  assert.equal(f.searchParams.get("scope"), "email,public_profile", "chỉ xin email + hồ sơ — không cần App Review");

  const tok = await signOAuthToken("erp-oauth-state", { state: "s1" }, 60);
  assert.deepEqual((await readOAuthToken<{ state: string }>("erp-oauth-state", tok))?.state, "s1");
  assert.equal(await readOAuthToken("erp-social-signup", tok), null, "cookie của luồng này không dùng được cho luồng kia");
  assert.equal(await readOAuthToken("erp-oauth-state", `${tok}x`), null, "chữ ký sai ⇒ bỏ");

  const now = new Date("2026-10-03T08:00:00Z");
  const exp = Math.floor(now.getTime() / 1000) + 600;
  const google = (claims: Record<string, unknown>, status = 200) => async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("code_verifier"), "ver-1", "gửi kèm PKCE verifier");
    assert.equal(body.get("client_secret"), cfg.clientSecret);
    return jsonRes(status, { id_token: fakeJwt(claims) });
  };
  const okClaims = { iss: "https://accounts.google.com", aud: cfg.clientId, exp, sub: "g-123", email: "Chu@Gmail.com", email_verified: true, name: "Chủ Shop" };
  assert.deepEqual(await exchangeCode("google", "c", "ver-1", cfg, google(okClaims) as typeof fetch, now), { provider: "google", subject: "g-123", email: "chu@gmail.com", name: "Chủ Shop" });
  const unverified = await exchangeCode("google", "c", "ver-1", cfg, google({ ...okClaims, email_verified: false }) as typeof fetch, now);
  assert.ok(!("error" in unverified) && unverified.email === null && unverified.subject === "g-123", "email chưa xác minh ⇒ không dùng email, vẫn có mã người dùng");
  for (const bad of [{ ...okClaims, aud: "ung-dung-khac" }, { ...okClaims, iss: "https://evil.example" }, { ...okClaims, exp: Math.floor(now.getTime() / 1000) - 1 }, { ...okClaims, sub: "" }]) {
    assert.ok("error" in (await exchangeCode("google", "c", "ver-1", cfg, google(bad) as typeof fetch, now)), JSON.stringify(bad));
  }
  assert.ok("error" in (await exchangeCode("google", "c", "ver-1", cfg, google(okClaims, 400) as typeof fetch, now)));

  const fbCfg = { clientId: "fb-app", clientSecret: "fb-secret" };
  const fb = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) return jsonRes(200, { access_token: "fb-tok" });
    assert.equal(u.searchParams.get("appsecret_proof"), createHmac("sha256", fbCfg.clientSecret).update("fb-tok").digest("hex"), "gọi Graph kèm appsecret_proof");
    return jsonRes(200, { id: "fb-9", name: "Chủ FB", email: "chu@fb.vn" });
  }) as typeof fetch;
  assert.deepEqual(await exchangeCode("facebook", "c", "", fbCfg, fb, now), { provider: "facebook", subject: "fb-9", email: "chu@fb.vn", name: "Chủ FB" });
}

// ═══════════ 2b · AI DÙNG CHUNG CỦA NỀN TẢNG (chatbot không cần khoá riêng) ═══════════

const envOf = (o: Record<string, string>) => (name: string) => o[name];

function testPlatformAiPure() {
  const KEY = "plat-key-123";
  const g = platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: KEY, PLATFORM_AI_PROVIDER: "gemini" }));
  assert.ok(g.ready && g.provider === "gemini" && g.model === PLATFORM_GEMINI_DEFAULT_MODEL, JSON.stringify(g));
  const a = platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: KEY }));
  assert.ok(a.ready && a.provider === "anthropic", "không khai nhà cung cấp ⇒ anthropic như trước");
  assert.ok(!platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: KEY, PLATFORM_AI_PROVIDER: "deepseek" })).ready, "nhà cung cấp lạ ⇒ tắt, không đoán");
  assert.ok(!platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: KEY, PLATFORM_AI_PROVIDER: "gemini", GEMINI_API_KEY: KEY })).ready, "khoá nền tảng trùng khoá Gemini của nhà ⇒ từ chối");
  assert.equal(DEFAULT_SALES_CHATBOT_CONFIG.connectorKey, "platform", "shop mới mặc định dùng AI dùng chung — không phải đi mua khoá");
  assert.equal(salesBotBillingSource("platform"), "PLATFORM");
  assert.equal(salesBotBillingSource("gemini-byok"), "BYOK");

  // Đường deploy (launch-gates mục D3): workflow chở đủ bốn biến; install-vps ghi khoá CHỈ khi khác rỗng, không in giá trị.
  const deploy = readFileSync(".github/workflows/deploy-vps.yml", "utf8");
  const install = readFileSync("scripts/install-vps.sh", "utf8");
  for (const v of ["PLATFORM_AI_API_KEY", "PLATFORM_AI_ENABLED", "PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET"]) {
    assert.ok(deploy.includes(`${v}: \${{`), `workflow phải đọc ${v}`);
    assert.equal((deploy.match(new RegExp(`[ ,]${v}(?=[ ,\n])`, "g")) ?? []).length, 2, `${v} phải có trong envs và export của bước SSH`);
  }
  assert.ok(deploy.includes("PLATFORM_AI_API_KEY: ${{ secrets.PLATFORM_AI_API_KEY }}") && deploy.includes("GOOGLE_OAUTH_CLIENT_SECRET: ${{ secrets.") && deploy.includes("FACEBOOK_LOGIN_APP_SECRET: ${{ secrets."), "khoá bí mật đi bằng secrets, không bằng vars");
  assert.ok(install.includes('if [ -n "${PLATFORM_AI_API_KEY:-}" ]; then'), "khoá AI nền tảng CHỈ ghi khi khác rỗng");
  for (const line of install.split("\n")) {
    if (/\$\{?(PLATFORM_AI_API_KEY|GOOGLE_OAUTH_CLIENT_SECRET|FACEBOOK_LOGIN_APP_SECRET)\b/.test(line)) assert.ok(!/\b(say|warn|echo|printf)\b/.test(line), `không in giá trị khoá: ${line.trim()}`);
  }
}

// ═══════════ 3 · CSDL THẬT ═══════════

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSignupAttempts).where(or(inArray(schema.platformSignupAttempts.organizationCode, [...ORGS]), eq(schema.platformSignupAttempts.ipHash, hashIp(IP))));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
}

async function withOpenSignup<T>(fn: () => Promise<T>): Promise<T> {
  const pdb = await getPlatformDb();
  const envBefore = process.env.PLATFORM_SIGNUP_MODE;
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  process.env.PLATFORM_SIGNUP_MODE = "open";
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
  await pdb.insert(schema.platformSettings).values({ key: SIGNUP_MODE_SETTING_KEY, value: "open", updatedByEmail: "qs-test@local" });
  invalidateSignupSetting();
  try {
    return await fn();
  } finally {
    if (envBefore === undefined) delete process.env.PLATFORM_SIGNUP_MODE;
    else process.env.PLATFORM_SIGNUP_MODE = envBefore;
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
    if (row) await pdb.insert(schema.platformSettings).values({ key: row.key, value: row.value, updatedByEmail: row.updatedByEmail });
    invalidateSignupSetting();
  }
}

async function testQuickSignupFlow() {
  const who = { kind: "public" as const, ip: IP };
  const issued: SessionSubject[] = [];
  const issue = async (s: SessionSubject) => void issued.push(s);

  // Lỗi đầu vào: trả câu cho người dùng, không tạo gì.
  assert.ok("error" in (await quickSignup({ storeName: "QS Bánh Mì Một", businessType: "food", phone: "024 3123 4567", email: "a@qs.vn", password: PW }, who, { issue })), "số bàn không đăng ký được");
  assert.ok("error" in (await quickSignup({ storeName: "QS Bánh Mì Một", businessType: "food", phone: "0912345601", email: "a@qs.vn", password: "ngan" }, who, { issue })), "mật khẩu quá ngắn");
  assert.ok("error" in (await quickSignup({ storeName: "QS Bánh Mì Một", businessType: "xe-may", phone: "0912345601", email: "a@qs.vn", password: PW }, who, { issue })), "ngành lạ");

  // Chưa khai tài khoản nhận tiền ⇒ cửa hàng A KHÔNG bị bật thu phí (không có đường trả tiền thì không được khoá).
  const pdb0 = await getPlatformDb();
  await pdb0.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  const t0 = Date.now();
  const a = await quickSignup({ storeName: "QS Bánh Mì Một", businessType: "food", phone: "0912 345 601", email: "Chu@QS-A.vn", password: PW }, who, { issue });
  const ms = Date.now() - t0;
  assert.ok("ok" in a, JSON.stringify(a));
  assert.equal(a.orgCode, QS_A, "mã tổ chức tự sinh từ tên cửa hàng");
  assert.ok(a.loggedIn && issued.at(-1)?.orgCode === QS_A, "vào thẳng ERP mới sau khi tạo");
  console.log(`  · đăng ký nhanh dựng xong một cửa hàng (PGlite) trong ${(ms / 1000).toFixed(1)} giây`);
  const admin = await withOrganization(QS_A, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@qs-a.vn") }));
  assert.equal(admin?.phone, "84912345601", "SĐT chuẩn hoá lưu trên tài khoản quản trị");
  assert.equal(admin?.role, "ADMIN");
  assert.deepEqual((await findIdentity("PHONE", "84912345601")).map((h) => h.orgCode), [QS_A]);
  assert.deepEqual((await findIdentity("EMAIL", "chu@qs-a.vn")).map((h) => h.orgCode), [QS_A]);
  assert.equal(await readSubscriptionTerms(QS_A, { fresh: true }), null, "chưa khai tài khoản nhận tiền ⇒ không bật dùng thử có hạn");

  // Bấm lại / trình duyệt gửi lại ⇒ không đẻ cửa hàng thứ hai với mã khác.
  const again = await quickSignup({ storeName: "QS Bánh Mì Một", businessType: "food", phone: "0912 345 601", email: "chu@qs-a.vn", password: PW }, who, { issue });
  assert.ok("error" in again && again.error.includes("đã có cửa hàng"), JSON.stringify(again));

  // Đăng nhập ở trang CHUNG bằng SĐT, không mã tổ chức.
  const home = (await getHomeOrganization()).code;
  assert.deepEqual(await loginCandidates("0912345601"), [QS_A, home], "chỉ mục tìm ra tổ chức, nhà luôn ở cuối");
  assert.equal(await credentialsMatch({ email: "0912 345 601", password: PW, orgCode: QS_A }), true);
  assert.equal(await credentialsMatch({ email: "0912 345 601", password: "sai-mat-khau", orgCode: QS_A }), false);
  assert.equal(await credentialsMatch({ email: "0912 345 601", password: PW, orgCode: home }), false, "tài khoản không có ở nhà");
  const viaPhone = await verifyLogin({ email: "+84 912 345 601", password: PW, orgCode: QS_A }, issue);
  assert.ok(viaPhone.ok && viaPhone.subject.email === "chu@qs-a.vn", "đăng nhập bằng SĐT");

  // Đăng ký bằng Google: không mật khẩu, danh tính GOOGLE; lần sau Google vào thẳng.
  const profile = { provider: "google" as const, subject: "g-qs-777", email: "chu@qs-b.vn", name: "Chủ Hải Sản" };
  assert.deepEqual(await resolveSocial(profile), { kind: "SIGNUP" }, "người mới ⇒ sang đăng ký");
  await pdb0.insert(schema.platformSettings).values({ key: BILLING_RECEIVER_KEY, value: { bin: "970422", accountNumber: "0123456789", accountName: "VNXCOMMERCE" }, updatedByEmail: "qs-test@local" });
  const dayBefore = vnDate(new Date());
  const b = await quickSignup({ storeName: "QS Hải Sản Hai", businessType: "seafood", phone: "0987 654 302" }, who, { issue, social: profile });
  assert.ok("ok" in b && b.orgCode === QS_B && b.loggedIn, JSON.stringify(b));
  const adminB = await withOrganization(QS_B, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@qs-b.vn") }));
  assert.equal(adminB?.name, "Chủ Hải Sản", "tên lấy từ hồ sơ Google");
  // Đã khai tài khoản nhận tiền ⇒ dùng thử 14 ngày (tính cả hôm nay), ân hạn 3 ngày, rồi chỉ xem.
  const trial = await readSubscriptionTerms(QS_B, { fresh: true });
  const dayAfter = vnDate(new Date());
  assert.ok(trial?.billingEnabled && [trialPaidThrough(dayBefore), trialPaidThrough(dayAfter)].includes(trial.paidThrough ?? ""), JSON.stringify(trial));
  assert.equal(trial?.graceDays, TRIAL_GRACE_DAYS);
  const notice = billingNotice(billingStanding(trial, dayAfter), true);
  assert.ok(notice?.tone === "info" && notice.text.includes("còn 14 ngày") && notice.cta === "Chọn gói", JSON.stringify(notice));
  const found = await resolveSocial(profile);
  assert.ok(found.kind === "LOGIN" && found.hit.orgCode === QS_B && found.hit.userId === adminB?.id, JSON.stringify(found));
  const viaGoogle = await completeProviderLogin({ orgCode: QS_B, userId: adminB!.id, provider: "GOOGLE", subject: profile.subject }, issue);
  assert.ok(viaGoogle.ok && issued.at(-1)?.orgCode === QS_B);
  assert.equal((await completeProviderLogin({ orgCode: QS_A, userId: adminB!.id, provider: "GOOGLE", subject: profile.subject }, issue)).ok, false, "mã người dùng của tổ chức khác ⇒ không mở phiên");
  // Facebook cùng email đã xác minh ⇒ khớp đúng tài khoản ấy (không đẻ tài khoản mới).
  const byEmail = await resolveSocial({ provider: "facebook", subject: "fb-qs-1", email: "chu@qs-b.vn", name: null });
  assert.ok(byEmail.kind === "LOGIN" && byEmail.hit.orgCode === QS_B);

  // Cùng email ở HAI tổ chức ⇒ phải chọn; khoá tài khoản ⇒ không mở phiên.
  await provisionOrganization({ code: QS_C, name: "QS Ba", modules: ["customers"], admin: { email: "chu@qs-b.vn", name: "Chủ C", password: PW }, source: "TEST", actor: null });
  assert.ok((await verifyLogin({ email: "chu@qs-b.vn", password: PW, orgCode: QS_C }, issue)).ok);
  assert.equal(await readSubscriptionTerms(QS_C, { fresh: true }), null, "tổ chức không qua cửa đăng ký mở ⇒ dùng thử không đụng tới");
  const pick = await resolveSocial({ provider: "facebook", subject: "fb-qs-1", email: "chu@qs-b.vn", name: null });
  assert.ok(pick.kind === "PICK" && pick.hits.map((h) => h.orgCode).sort().join() === [QS_B, QS_C].sort().join(), JSON.stringify(pick));
  await withOrganization(QS_C, async () => (await getDb()).update(schema.users).set({ active: false }).where(eq(schema.users.email, "chu@qs-b.vn")));
  const cUser = await withOrganization(QS_C, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@qs-b.vn") }));
  const locked = await completeProviderLogin({ orgCode: QS_C, userId: cUser!.id, provider: "FACEBOOK", subject: "fb-qs-1" }, issue);
  assert.ok(!locked.ok && locked.code === "DISABLED");

  // Chatbot dùng AI của nền tảng: ĐỦ ba điều (nền tảng bật · gói có credit · còn credit) mới chạy.
  const ready = envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: "plat-key-qs", PLATFORM_AI_PROVIDER: "gemini" });
  const off = await platformChatAi(QS_A, { env: envOf({}) });
  assert.ok(!off.ok && off.reason.includes("chưa bật"), JSON.stringify(off));
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, QS_A) });
  const setCredit = async (usd: number) => {
    await pdb.update(schema.platformOrganizations).set({ settings: { ...(row?.settings as Record<string, unknown>), ai: { disabled: false, limits: { platformCreditUsdPerMonth: usd } } } }).where(eq(schema.platformOrganizations.code, QS_A));
    invalidateAiControl();
  };
  await setCredit(0);
  const noCredit = await platformChatAi(QS_A, { env: ready });
  assert.ok(!noCredit.ok && noCredit.reason.includes("chưa có AI dùng chung"), "tổ chức credit 0 ⇒ chưa có AI dùng chung");
  await setCredit(2);
  const on = await platformChatAi(QS_A, { env: ready });
  assert.ok(on.ok && on.provider.name === "gemini-platform" && on.provider.model === PLATFORM_GEMINI_DEFAULT_MODEL, JSON.stringify(on.ok ? on.provider.name : on.reason));
}

export async function testQuickStart() {
  testPure();
  testPlatformAiPure();
  await testOAuth();
  await cleanup();
  for (const code of ORGS) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  const pdb = await getPlatformDb();
  const receiver = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
  try {
    await withOpenSignup(testQuickSignupFlow);
  } finally {
    await cleanup();
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
    if (receiver) await pdb.insert(schema.platformSettings).values({ key: receiver.key, value: receiver.value, updatedByEmail: receiver.updatedByEmail });
  }
  console.log("✓ Gia nhập nhanh: SĐT VN mọi cách gõ, mã tổ chức từ tên cửa hàng, ngành nào cũng có AI bán hàng; OAuth state + PKCE, cookie ký không dùng chéo, Google sai aud/iss/hạn ⇒ từ chối, email chưa xác minh không dùng, Facebook có appsecret_proof; đăng ký một màn hình qua đúng lõi tạo tổ chức rồi vào thẳng, bấm lại không đẻ cửa hàng thứ hai, đăng nhập bằng SĐT ở trang chung không cần mã, đăng ký bằng Google rồi vào lại bằng Google, email ở hai tổ chức ⇒ phải chọn, tài khoản khoá ⇒ không vào; dùng thử 14 ngày chỉ bật khi nền tảng đã khai tài khoản nhận tiền, chỉ cho cửa đăng ký mở");
}
