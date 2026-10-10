/**
 * ═══════════ «QUÊN MẬT KHẨU» TỰ PHỤC VỤ (PUB-07 · lib/users/forgot-password.ts) ═══════════
 *
 * Hai tổ chức THẬT (tự cấp, tự dọn; mã không trùng bài khác): `fq-a`, `fq-b`. Zalo là hàm GIẢ (luật 65 — không gọi mạng).
 *
 *  1. Lối vào: `/login` có liên kết «Quên mật khẩu?» tới `/forgot`; `/forgot` không cần phiên, không thuộc module nào; vỏ action không
 *     tự chọn CSDL.
 *  2. OTP TẮT (mặc định): gửi yêu cầu ⇒ ĐÚNG MỘT yêu cầu hỗ trợ (chuông của tổ chức + nhật ký tổ chức + nhật ký nền tảng), bấm lại
 *     trong ngày không đẻ thêm; KHÔNG phiếu đặt lại nào; bước nhập mã bị từ chối.
 *  3. OTP BẬT: mã đúng ⇒ phiếu dùng được ở `/reset` (tra được, đặt được, mật khẩu mới đăng nhập được), nhật ký người thao tác = chính
 *     người dùng, phiếu sống 30 phút; mã sai / hết hạn / quá số lần / đã dùng ⇒ từ chối bằng MỘT câu; tài khoản không SĐT ⇒ yêu cầu
 *     hỗ trợ; một SĐT ở hai cửa hàng ⇒ chọn cửa hàng sau khi mã đúng.
 *  4. Chống dò: câu trả lời GIỐNG HỆT cho tài khoản có / không tồn tại (cả hai chế độ); quá số lượt ⇒ chặn.
 *  5. Không mã OTP, không phiếu nào lọt vào log hay vào nhật ký / chuông.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { indexAccountIdentities } from "@/lib/auth/identities";
import { verifyLogin } from "@/lib/auth/login";
import { hashPassword } from "@/lib/auth/password";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { MODULE_FREE_PATH_PREFIXES, moduleOfPath } from "@/lib/constants/platform-modules";
import { vnDateKey } from "@/lib/format";
import { PHONE_OTP_SETTING_KEY, readPhoneOtpSetting, setPhoneOtpSetting, type OtpSender } from "@/lib/onboarding/phone-otp";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { FORGOT_REQUESTER_LABEL, requestPasswordHelp, verifyPasswordOtp } from "@/lib/users/forgot-password";
import { FORGOT_CODE_INVALID, FORGOT_OTP_OFF, FORGOT_SENT_OTP, FORGOT_SENT_SUPPORT, FORGOT_THROTTLED } from "@/lib/users/forgot-password-shared";
import { completePasswordResetCore, hashResetToken, lookupResetToken, SELF_PHONE_OTP_ISSUER } from "@/lib/users/password-reset";

const A = "fq-a";
const B = "fq-b";
const NEW_PW = "MatKhauMoi@2026";
const PHONE_NV = "84987650111";
const PHONE_BOTH = "84987650222";
const PHONE_NOBODY = "84987650999";
const PHONES = [PHONE_NV, PHONE_BOTH, PHONE_NOBODY];
const ACTOR = { orgCode: "home", userId: "u-op", email: "op@vnx.test" };
let ipSeq = 10;
const nextIp = () => `198.51.100.${ipSeq++}`;
const local = (p: string) => `0${p.slice(2)}`;

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [A, B]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [A, B]));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, [A, B]));
  await pdb.delete(schema.platformPhoneOtps).where(inArray(schema.platformPhoneOtps.phone, PHONES));
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, PHONE_OTP_SETTING_KEY));
  await readPhoneOtpSetting({ fresh: true });
  invalidateOrganizations();
  invalidateCapabilities();
}

type Users = { nv: { id: string; email: string }; nophone: { id: string; email: string }; bothA: { id: string }; bothB: { id: string } };

async function seed(): Promise<Users> {
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  for (const code of [A, B]) await provisionOrganization({ code, name: `Quên MK ${code}`, plan: "standard", modules, admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "QuanTri@12345" }, source: "TEST", actor: null });
  const passwordHash = await hashPassword("MatKhauCu@2026");
  const inA = await withOrganization(A, async () => {
    const db = await getDb();
    const [nv] = await db.insert(schema.users).values({ email: "nv@fq-a.local", name: "Nhân viên", passwordHash, role: "CS", phone: PHONE_NV }).returning();
    const [nophone] = await db.insert(schema.users).values({ email: "khongso@fq-a.local", name: "Không số", passwordHash, role: "CS" }).returning();
    const [both] = await db.insert(schema.users).values({ email: "hai@fq-a.local", name: "Hai nơi", passwordHash, role: "CS", phone: PHONE_BOTH }).returning();
    return { nv, nophone, both };
  });
  const bothB = await withOrganization(B, async () => {
    const db = await getDb();
    const [both] = await db.insert(schema.users).values({ email: "hai@fq-b.local", name: "Hai nơi", passwordHash, role: "CS", phone: PHONE_BOTH }).returning();
    return both;
  });
  // Chỉ mục danh tính: SĐT ⇒ hai cửa hàng (trang chung không mã tự tìm, như màn đăng nhập).
  await indexAccountIdentities(A, inA.both);
  await indexAccountIdentities(B, bothB);
  return { nv: inA.nv, nophone: inA.nophone, bothA: inA.both, bothB };
}

function testEntry() {
  const form = readFileSync("app/login/login-form.tsx", "utf8");
  assert.ok(/href="\/forgot"[^>]*>\s*Quên mật khẩu\?/.test(form), "trang đăng nhập có lối «Quên mật khẩu?» tới /forgot");
  const mw = readFileSync("middleware.ts", "utf8");
  const exact = mw.slice(mw.indexOf("const PUBLIC_EXACT"), mw.indexOf("]", mw.indexOf("const PUBLIC_EXACT")));
  assert.ok(exact.includes('"/forgot"'), "/forgot không cần phiên");
  assert.ok((MODULE_FREE_PATH_PREFIXES as readonly string[]).includes("/forgot") && moduleOfPath("/forgot") === null);
  const page = readFileSync("app/forgot/page.tsx", "utf8");
  assert.ok(page.includes("<ForgotForm") && page.includes("hostBrand()") && page.includes("hostOrganization()"), "trang chọn thương hiệu theo host như /login");
  const action = readFileSync("lib/actions/forgot-password.ts", "utf8");
  assert.ok(!/withOrganization\(|getPlatformDb\(/.test(action), "server action không tự chọn CSDL");
  const core = readFileSync("lib/users/forgot-password.ts", "utf8");
  assert.ok(core.includes("issuePhoneOtp(") && core.includes("verifySignupOtp(") && core.includes("issueSelfResetAfterPhoneOtp("), "dùng lại lõi phone-otp + password-reset");
  assert.ok(!/passwordResetTokens|passwordHash/.test(core), "không có đường ghi phiếu / mật khẩu thứ hai");
}

async function notificationsFor(org: string, userId: string) {
  return withOrganization(org, async () => {
    const db = await getDb();
    return db.select().from(schema.notifications).where(and(eq(schema.notifications.entityType, "USER"), eq(schema.notifications.entityId, userId)));
  });
}

async function tokensOf(org: string, userId: string) {
  return withOrganization(org, async () => (await getDb()).select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, userId)));
}

async function platformRequests(org: string) {
  const pdb = await getPlatformDb();
  return pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, org), eq(schema.platformAuditLog.action, "PASSWORD_RESET_REQUEST")));
}

async function testOtpOff(u: Users) {
  assert.equal((await readPhoneOtpSetting({ fresh: true })).enabled, false, "mặc định TẮT");
  const ip = nextIp();
  const ctx = { ip, hostOrgCode: null };
  const real = await requestPasswordHelp({ identifier: u.nv.email, orgCode: A }, ctx);
  const ghost = await requestPasswordHelp({ identifier: "khong-ai@fq-a.local", orgCode: A }, ctx);
  const ghostOrg = await requestPasswordHelp({ identifier: u.nv.email, orgCode: "khong-co-cua-hang" }, ctx);
  assert.deepEqual(real, { ok: true, otp: false, message: FORGOT_SENT_SUPPORT });
  assert.deepEqual(ghost, real, "tài khoản không tồn tại ⇒ CÙNG câu");
  assert.deepEqual(ghostOrg, real, "cửa hàng không tồn tại ⇒ CÙNG câu");

  const bell = await notificationsFor(A, u.nv.id);
  assert.equal(bell.length, 1, "đúng một yêu cầu hỗ trợ");
  assert.ok(bell[0].href === "/settings/users" && bell[0].title.includes(u.nv.email) && bell[0].kind === "SYSTEM", JSON.stringify(bell[0]));
  const plat = await platformRequests(A);
  assert.equal(plat.length, 1, "nhật ký nền tảng có một dòng — người vận hành thấy ở /platform/customers/<mã>");
  assert.ok(plat[0].subject === `user:${u.nv.email}` && plat[0].actorUserId === null && plat[0].source === "UI");
  const orgAudit = await withOrganization(A, async () => (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "PASSWORD_RESET_REQUEST")));
  assert.equal(orgAudit.length, 1);
  assert.ok(orgAudit[0].userId === null && orgAudit[0].userEmail === FORGOT_REQUESTER_LABEL, "người gửi CHƯA xác minh ⇒ không quy cho tài khoản nào");
  assert.equal((await tokensOf(A, u.nv.id)).length, 0, "OTP tắt ⇒ không phát phiếu");

  // Bấm lại trong ngày (máy khác): vẫn một yêu cầu.
  await requestPasswordHelp({ identifier: u.nv.email, orgCode: A }, { ip: nextIp(), hostOrgCode: null });
  assert.equal((await notificationsFor(A, u.nv.id)).length, 1, "một yêu cầu mỗi tài khoản mỗi ngày");
  assert.equal((await platformRequests(A)).length, 1);

  // Bước nhập mã khi OTP tắt ⇒ từ chối, không phiếu.
  assert.deepEqual(await verifyPasswordOtp({ identifier: u.nv.email, orgCode: A, code: "123456" }, { ip: nextIp(), hostOrgCode: null }), { error: FORGOT_OTP_OFF });
  assert.equal((await tokensOf(A, u.nv.id)).length, 0);
}

async function testOtpOn(u: Users, sent: { phone: string; code: string }[], send: OtpSender) {
  const on = await setPhoneOtpSetting(ACTOR, { enabled: true, templateId: "312345", param: "otp" }, { zaloConnected: async () => true });
  assert.ok("ok" in on, JSON.stringify(on));
  const codeFor = (phone: string) => [...sent].reverse().find((s) => s.phone === phone)?.code ?? "";
  const wrongOf = (c: string) => (c === "000000" ? "111111" : "000000");

  // Chống dò: có / không tài khoản ⇒ cùng câu; chỉ tài khoản thật nhận mã.
  const ipMain = nextIp();
  const ctxMain = { ip: ipMain, hostOrgCode: null };
  const before = sent.length;
  const real = await requestPasswordHelp({ identifier: local(PHONE_NV), orgCode: A }, ctxMain, { send });
  const ghost = await requestPasswordHelp({ identifier: local(PHONE_NOBODY), orgCode: A }, ctxMain, { send });
  assert.deepEqual(real, { ok: true, otp: true, message: FORGOT_SENT_OTP });
  assert.deepEqual(ghost, real, "SĐT không có tài khoản ⇒ CÙNG câu (và cùng hiện ô nhập mã)");
  assert.equal(sent.length, before + 1, "chỉ gửi mã cho tài khoản thật");
  assert.equal(sent.at(-1)?.phone, PHONE_NV);
  const code = codeFor(PHONE_NV);
  assert.match(code, /^\d{6}$/);
  assert.equal((await notificationsFor(A, u.nv.id)).length, 1, "gửi được mã ⇒ không đẻ yêu cầu hỗ trợ mới");

  // Mã sai · không có tài khoản ⇒ MỘT câu.
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code: wrongOf(code) }, ctxMain), { error: FORGOT_CODE_INVALID });
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NOBODY), orgCode: A, code }, ctxMain), { error: FORGOT_CODE_INVALID }, "không có tài khoản ⇒ cùng câu với mã sai");
  assert.equal((await tokensOf(A, u.nv.id)).length, 0, "mã sai ⇒ không phiếu");

  // Mã đúng (kèm email thay cho SĐT cũng được — cùng tài khoản) ⇒ phiếu dùng được ở /reset.
  const ok = await verifyPasswordOtp({ identifier: u.nv.email, orgCode: A, code: ` ${code.slice(0, 3)} ${code.slice(3)} ` }, ctxMain);
  assert.ok("ok" in ok, JSON.stringify(ok));
  const m = ok.resetPath.match(/^\/reset\/fq-a\/([A-Za-z0-9_-]{43})$/);
  assert.ok(m, ok.resetPath);
  const token = m[1];
  const rows = await tokensOf(A, u.nv.id);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].createdVia === "PLATFORM" && rows[0].createdByEmail === SELF_PHONE_OTP_ISSUER && rows[0].createdByUserId === u.nv.id, JSON.stringify(rows[0]));
  assert.ok(Math.abs(rows[0].expiresAt.getTime() - (Date.now() + 30 * 60_000)) < 60_000, "phiếu tự phục vụ sống 30 phút");
  assert.equal(rows[0].tokenHash, hashResetToken(token), "CSDL chỉ giữ băm");
  const linkAudit = await withOrganization(A, async () => (await getDb()).select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "PASSWORD_RESET_LINK"), eq(schema.auditLogs.entityId, u.nv.id))));
  assert.equal(linkAudit.length, 1);
  assert.equal(linkAudit[0].userId, u.nv.id, "nhật ký: người thao tác = chính người dùng");
  assert.ok(JSON.stringify(linkAudit[0].detail).includes("SELF_PHONE_OTP"), JSON.stringify(linkAudit[0].detail));

  const look = await lookupResetToken(A, token, { ip: ipMain });
  assert.ok(look.ok && look.email === u.nv.email, JSON.stringify(look));
  const done = await completePasswordResetCore(A, token, { password: NEW_PW, confirmPassword: NEW_PW }, { ip: ipMain });
  assert.ok("ok" in done, JSON.stringify(done));
  assert.ok((await verifyLogin({ email: u.nv.email, password: NEW_PW, orgCode: A }, async () => undefined)).ok, "mật khẩu mới đăng nhập được");

  // Mã đã dùng ⇒ hết hiệu lực.
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code }, { ip: nextIp(), hostOrgCode: null }), { error: FORGOT_CODE_INVALID }, "mã đã tiêu");

  // Hết hạn: mã gửi lúc T+2 phút, nhập lúc T+9 phút (mã sống 5 phút).
  const t0 = Date.now();
  const ipExp = nextIp();
  await requestPasswordHelp({ identifier: local(PHONE_NV), orgCode: A }, { ip: ipExp, hostOrgCode: null }, { send, now: new Date(t0 + 2 * 60_000) });
  const codeExp = codeFor(PHONE_NV);
  assert.notEqual(codeExp, code, "mã mới");
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code: codeExp }, { ip: ipExp, hostOrgCode: null }, { now: new Date(t0 + 9 * 60_000) }), { error: FORGOT_CODE_INVALID }, "mã hết hạn");

  // Quá số lần: mã gửi lúc T+4 phút; 4 lần sai ở máy 1 (lượt thứ 5 bị bộ chặn dò khoá), 1 lần sai ở máy 2 ⇒ mã chết, nhập đúng vẫn bị từ chối.
  const ip1 = nextIp();
  const ip2 = nextIp();
  const at = new Date(t0 + 4 * 60_000);
  await requestPasswordHelp({ identifier: local(PHONE_NV), orgCode: A }, { ip: ip1, hostOrgCode: null }, { send, now: at });
  const codeMax = codeFor(PHONE_NV);
  const bad = wrongOf(codeMax);
  for (let i = 0; i < 4; i++) assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code: bad }, { ip: ip1, hostOrgCode: null }, { now: at }), { error: FORGOT_CODE_INVALID });
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code: codeMax }, { ip: ip1, hostOrgCode: null }, { now: at }), { error: FORGOT_THROTTLED }, "5 lượt / (định danh, máy) ⇒ chặn dò");
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code: bad }, { ip: ip2, hostOrgCode: null }, { now: at }), { error: FORGOT_CODE_INVALID });
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_NV), orgCode: A, code: codeMax }, { ip: ip2, hostOrgCode: null }, { now: at }), { error: FORGOT_CODE_INVALID }, "sai quá 5 lần ⇒ mã chết, kể cả nhập đúng");
  assert.equal((await tokensOf(A, u.nv.id)).filter((r) => !r.usedAt).length, 0, "không phiếu mới nào sau các lượt bị từ chối");

  // Đủ 3 mã / giờ cho số này ⇒ lượt sau không gửi được ⇒ chuyển thành yêu cầu hỗ trợ (đã có hôm nay ⇒ không thêm), câu vẫn y hệt.
  const cappedAt = new Date(t0 + 6 * 60_000);
  const capped = await requestPasswordHelp({ identifier: local(PHONE_NV), orgCode: A }, { ip: nextIp(), hostOrgCode: null }, { send, now: cappedAt });
  assert.deepEqual(capped, real, "chạm trần gửi mã ⇒ vẫn cùng câu");
  // Khoá theo NGÀY của chính lượt gửi (luật 50 — không giả định cả bài chạy trong cùng một ngày VN).
  const dayKey = `password-help:${u.nv.id}:${vnDateKey(cappedAt)}`;
  assert.equal((await notificationsFor(A, u.nv.id)).filter((r) => r.dedupeKey === dayKey).length, 1, "chạm trần ⇒ có yêu cầu hỗ trợ, và không quá một mỗi ngày");

  // Tài khoản không có SĐT ⇒ yêu cầu hỗ trợ, câu vẫn y hệt.
  const noPhone = await requestPasswordHelp({ identifier: u.nophone.email, orgCode: A }, { ip: nextIp(), hostOrgCode: null }, { send });
  assert.deepEqual(noPhone, real, "không SĐT ⇒ cùng câu");
  assert.equal((await notificationsFor(A, u.nophone.id)).length, 1, "không SĐT ⇒ một yêu cầu hỗ trợ");
  assert.equal((await tokensOf(A, u.nophone.id)).length, 0);

  // «Không nhận được mã» ⇒ yêu cầu hỗ trợ, không gửi mã.
  const n = sent.length;
  const asked = await requestPasswordHelp({ identifier: local(PHONE_BOTH), orgCode: A, channel: "SUPPORT" }, { ip: nextIp(), hostOrgCode: null }, { send });
  assert.deepEqual(asked, { ok: true, otp: false, message: FORGOT_SENT_SUPPORT });
  assert.equal(sent.length, n, "bấm hỗ trợ ⇒ không gửi mã");
  assert.equal((await notificationsFor(A, u.bothA.id)).length, 1);

  // Một SĐT ở hai cửa hàng, trang chung không mã ⇒ một mã; đúng mã mới hỏi chọn cửa hàng; chọn B ⇒ phiếu của B.
  const ipBoth = nextIp();
  const both = await requestPasswordHelp({ identifier: local(PHONE_BOTH) }, { ip: ipBoth, hostOrgCode: null }, { send });
  assert.deepEqual(both, real);
  assert.equal(sent.length, n + 1, "một mã cho một SĐT dù có hai tài khoản");
  const codeBoth = codeFor(PHONE_BOTH);
  assert.deepEqual(await verifyPasswordOtp({ identifier: local(PHONE_BOTH), code: wrongOf(codeBoth) }, { ip: ipBoth, hostOrgCode: null }), { error: FORGOT_CODE_INVALID }, "mã sai ⇒ không lộ danh sách cửa hàng");
  const choose = await verifyPasswordOtp({ identifier: local(PHONE_BOTH), code: codeBoth }, { ip: ipBoth, hostOrgCode: null });
  assert.ok("choose" in choose && choose.choose.map((c) => c.code).sort().join(",") === `${A},${B}`, JSON.stringify(choose));
  const picked = await verifyPasswordOtp({ identifier: local(PHONE_BOTH), code: codeBoth, pick: B }, { ip: ipBoth, hostOrgCode: null });
  assert.ok("ok" in picked && picked.resetPath.startsWith(`/reset/${B}/`), JSON.stringify(picked));
  assert.equal((await tokensOf(B, u.bothB.id)).length, 1);
  assert.equal((await tokensOf(A, u.bothA.id)).length, 0, "chỉ cửa hàng được chọn có phiếu");

  // Tên miền con gắn cứng tổ chức: ô mã gõ tay bị bỏ qua.
  const hostCtx = { ip: nextIp(), hostOrgCode: B };
  assert.deepEqual(await requestPasswordHelp({ identifier: "hai@fq-a.local", orgCode: A }, hostCtx, { send }), real, "host B ⇒ không tra A");

  // Chặn dò ở bước 1: 5 lượt / (định danh, máy) ⇒ lượt 6 bị chặn, có tài khoản hay không.
  const ipFlood = nextIp();
  for (let i = 0; i < 5; i++) await requestPasswordHelp({ identifier: "do-tim@fq-a.local", orgCode: A }, { ip: ipFlood, hostOrgCode: null }, { send });
  assert.deepEqual(await requestPasswordHelp({ identifier: "do-tim@fq-a.local", orgCode: A }, { ip: ipFlood, hostOrgCode: null }, { send }), { error: FORGOT_THROTTLED });

  return { codes: sent.map((s) => s.code), tokens: [token, ("ok" in picked ? picked.resetPath.split("/").pop() : "") ?? ""] };
}

export async function testForgotPassword() {
  testEntry();
  await cleanup();
  const logs: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const grab =
    (k: keyof typeof orig) =>
    (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (k === "error" || k === "warn") return;
      orig[k](...args);
    };
  const sent: { phone: string; code: string }[] = [];
  const send: OtpSender = async (i) => {
    sent.push({ phone: i.phone, code: i.code });
    return { ok: true };
  };
  try {
    const u = await seed();
    console.log = grab("log");
    console.info = grab("info");
    console.warn = grab("warn");
    console.error = grab("error");
    let secrets: { codes: string[]; tokens: string[] };
    try {
      await testOtpOff(u);
      secrets = await testOtpOn(u, sent, send);
    } finally {
      Object.assign(console, orig);
    }
    // Không mã OTP, không phiếu nào trong log, nhật ký, chuông.
    const dumps: string[] = [logs.join("\n")];
    for (const org of [A, B]) {
      dumps.push(
        await withOrganization(org, async () => {
          const db = await getDb();
          return JSON.stringify([await db.select().from(schema.auditLogs), await db.select().from(schema.notifications), await db.select().from(schema.passwordResetTokens)]);
        }),
      );
    }
    const pdb = await getPlatformDb();
    dumps.push(JSON.stringify(await pdb.select().from(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [A, B]))));
    dumps.push(JSON.stringify(await pdb.select().from(schema.platformPhoneOtps).where(inArray(schema.platformPhoneOtps.phone, PHONES))));
    const all = dumps.join("\n");
    for (const c of secrets.codes) assert.ok(!new RegExp(`(^|\\D)${c}(\\D|$)`).test(all), `mã OTP ${c.slice(0, 2)}**** lọt vào log / CSDL`);
    for (const t of secrets.tokens.filter(Boolean)) assert.ok(!all.includes(t), "phiếu đặt lại lọt vào log / CSDL");
  } finally {
    Object.assign(console, orig);
    await cleanup();
  }
  console.log("  ✓ quên mật khẩu: lối vào ở /login; OTP tắt ⇒ đúng một yêu cầu hỗ trợ (chuông + nhật ký tổ chức + nhật ký nền tảng), không phiếu; OTP bật ⇒ mã đúng phát phiếu 30 phút dùng được ở /reset (người thao tác = chính người dùng), mã sai / hết hạn / đã dùng / quá số lần ⇒ một câu; không SĐT / chạm trần / «không nhận được mã» ⇒ yêu cầu hỗ trợ; một SĐT hai cửa hàng ⇒ chọn sau khi mã đúng; câu trả lời như nhau cho tài khoản có / không tồn tại; chặn dò; không mã / phiếu trong log và CSDL");
}
