/**
 * ═══════════ LIÊN KẾT ĐẶT LẠI MẬT KHẨU DÙNG MỘT LẦN (0191 · docs/platform/password-reset.md) ═══════════
 *
 * Hai tổ chức THẬT (tự cấp, tự dọn; mã KHÔNG trùng bài khác — `pr-a` đã là của workflow-recovery, trùng thì PGlite đệm của bài trước bị xoá thư mục dưới chân): `rs-a` (đích), `rs-b` (đích của đòn chép mã chéo). Cộng tổ chức NHÀ làm người vận
 * hành. Đi đúng luồng: quản trị tổ chức (`users:manage`) HOẶC người vận hành nền tảng tạo liên kết ⇒ `/reset/<tổ
 * chức>/<mã>` ⇒ lượt công khai KHÔNG phiên tra (không tiêu mã) rồi đặt ⇒ mật khẩu mới đăng nhập được, mật khẩu cũ
 * không, mọi phiên cũ bị thu hồi.
 *
 * Đòn phải bị từ chối, mọi lý do ra CÙNG một câu: dùng lần hai · hết hạn · bị liên kết mới thay · sai dạng · tổ chức không
 * có · mã của A đem sang B. Hai lượt đặt song song ⇒ đúng MỘT thắng. Thiếu quyền ⇒ không tạo được. Người vận hành: phải
 * là nhà + `platform:operate`, bắt buộc lý do, không đặt hộ tài khoản nhà, nhật ký nền tảng có dòng. Bảng + nhật ký
 * không chứa mã thô. Chặn dò theo IP.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { verifyLogin } from "@/lib/auth/login";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { MODULE_FREE_PATH_PREFIXES, moduleOfPath } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { completePasswordResetCore, createResetLinkAsOperator, createResetLinkCore, generateResetToken, hashResetToken, lookupResetToken, resetLinkFor } from "@/lib/users/password-reset";
import { completeResetSchema, PASSWORD_RESET_INVALID, PASSWORD_RESET_THROTTLED } from "@/lib/users/password-reset-shared";

const A = "rs-a";
const B = "rs-b";
const OLD_PW = "MatKhauCu@2026";
const NEW_PW = "MatKhauMoi@2026";
const IP = "198.51.100.41";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const tokenOf = (link: string) => decodeURIComponent(link.split("/").pop() ?? "");
const errOf = (r: { error: string } | { ok: true }) => ("error" in r ? r.error : "OK");
const reset = (org: string, token: string, pw = NEW_PW, ip = IP) => completePasswordResetCore(org, token, { password: pw, confirmPassword: pw }, { ip });
const canLogin = async (org: string, email: string, password: string) => (await verifyLogin({ email, password, orgCode: org }, async () => undefined)).ok;

function testPure() {
  assert.equal(completeResetSchema.safeParse({ password: "ngan", confirmPassword: "ngan" }).success, false, "mật khẩu ≥ 10 ký tự");
  assert.equal(completeResetSchema.safeParse({ password: NEW_PW, confirmPassword: `${NEW_PW}x` }).success, false, "nhập lại phải khớp");
  assert.ok(completeResetSchema.safeParse({ password: NEW_PW, confirmPassword: NEW_PW }).success);
  const t = generateResetToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/, "32 byte base64url");
  assert.notEqual(generateResetToken(), t);
  assert.ok(!hashResetToken(t).includes(t));
  assert.equal(resetLinkFor("rs-a", t, "https://x.vn/"), `https://x.vn/reset/rs-a/${t}`);

  // Cửa công khai: middleware mở `/reset/`, cổng module coi `/reset` là vùng không-module.
  const mw = readFileSync("middleware.ts", "utf8");
  const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("]", mw.indexOf("const PUBLIC_PREFIXES")));
  assert.ok(list.includes('"/reset/"'), "/reset/ không cần phiên");
  assert.ok((MODULE_FREE_PATH_PREFIXES as readonly string[]).includes("/reset") && moduleOfPath("/reset/rs-a/abc") === null);
  const actions = readFileSync("lib/actions/password-reset.ts", "utf8");
  assert.ok(!/withOrganization\(|getPlatformDb\(/.test(actions), "server action không tự chọn CSDL");
  // Trang chỉ ĐỌC: bot xem trước liên kết (Zalo / Messenger) mở trang không được tiêu mã.
  const page = readFileSync("app/reset/[org]/[token]/page.tsx", "utf8");
  assert.ok(page.includes("lookupResetToken(") && !page.includes("completePasswordReset"), "trang chỉ tra, không đặt");
}

async function testOrgAdminFlow() {
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  for (const code of [A, B]) await provisionOrganization({ code, name: `Đặt lại ${code}`, plan: "standard", modules, admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "QuanTri@12345" }, source: "TEST", actor: null });
  const orgA = { code: A, name: `Đặt lại ${A}`, isHome: false };

  const made = await withOrganization(A, async () => {
    const db = await getDb();
    const adminRow = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) });
    assert.ok(adminRow);
    const [nv] = await db.insert(schema.users).values({ email: "nv@rs-a.local", name: "Nhân viên", passwordHash: "x", role: "CS" }).returning();
    const [locked] = await db.insert(schema.users).values({ email: "khoa@rs-a.local", name: "Bị khoá", passwordHash: "x", role: "CS", active: false }).returning();
    // Mật khẩu cũ THẬT để chứng minh nó hết dùng được.
    const { hashPassword } = await import("@/lib/auth/password");
    await db.update(schema.users).set({ passwordHash: await hashPassword(OLD_PW) }).where(eq(schema.users.id, nv.id));
    const admin = sessionOf(adminRow, { organization: orgA });
    const cs = sessionOf(adminRow, { role: "CS", organization: orgA });

    assert.match(errOf(await createResetLinkCore(cs, nv.id)), /users:manage/, "thiếu quyền ⇒ không tạo");
    assert.match(errOf(await createResetLinkCore(admin, locked.id)), /đang khoá/);
    assert.match(errOf(await createResetLinkCore(admin, "khong-co")), /Không có tài khoản/);
    assert.equal((await db.select().from(schema.passwordResetTokens)).length, 0, "lượt bị chặn không ghi dòng nào");

    const first = await createResetLinkCore(admin, nv.id);
    assert.ok("ok" in first, JSON.stringify(first));
    assert.ok(first.link.includes(`/reset/${A}/`), first.link);
    assert.ok(Math.abs(first.expiresAt.getTime() - (Date.now() + 24 * 3_600_000)) < 60_000, "hạn 24 giờ");
    const second = await createResetLinkCore(admin, nv.id);
    assert.ok("ok" in second);
    const race = await createResetLinkCore(admin, adminRow.id);
    assert.ok("ok" in race);
    return { nvId: nv.id, first: tokenOf(first.link), second: tokenOf(second.link), race: tokenOf(race.link) };
  });

  // Bảng + nhật ký KHÔNG chứa mã thô.
  await withOrganization(A, async () => {
    const db = await getDb();
    const dump = JSON.stringify([await db.select().from(schema.passwordResetTokens), await db.select().from(schema.auditLogs)]);
    for (const tok of [made.first, made.second, made.race]) {
      assert.ok(!dump.includes(tok), "mã thô không nằm trong CSDL");
      assert.ok(dump.includes(hashResetToken(tok)), "CSDL giữ băm");
    }
  });

  // Liên kết mới THAY liên kết cũ.
  assert.equal(errOf(await reset(A, made.first)), PASSWORD_RESET_INVALID, "liên kết cũ đã bị thay");

  // Tra (KHÔNG phiên, không tiêu mã) — tra hai lần vẫn còn dùng được.
  for (let i = 0; i < 2; i++) {
    const look = await lookupResetToken(A, made.second, { ip: IP });
    assert.ok(look.ok && look.email === "nv@rs-a.local" && look.orgCode === A, JSON.stringify(look));
  }

  // Mã của A đem sang đường dẫn B ⇒ câu chung, mã A còn nguyên.
  assert.equal(errOf(await reset(B, made.second)), PASSWORD_RESET_INVALID, "chép chéo ⇒ câu chung");
  assert.equal(errOf(await reset("khong-co-to-chuc", made.second)), PASSWORD_RESET_INVALID);
  assert.equal(errOf(await reset("../rs-a", made.second)), PASSWORD_RESET_INVALID);
  assert.equal(errOf(await reset(A, "khong-phai-ma")), PASSWORD_RESET_INVALID);
  assert.match(errOf(await reset(A, made.second, "ngan")), /ít nhất 10 ký tự/, "lược đồ kiểm trước, không tiêu mã");

  assert.ok(await canLogin(A, "nv@rs-a.local", OLD_PW), "trước khi đặt: mật khẩu cũ còn dùng");
  const ok = await reset(A, made.second);
  assert.ok("ok" in ok && ok.orgCode === A && ok.email === "nv@rs-a.local", JSON.stringify(ok));
  assert.ok(await canLogin(A, "nv@rs-a.local", NEW_PW), "mật khẩu mới đăng nhập được");
  assert.equal(await canLogin(A, "nv@rs-a.local", OLD_PW), false, "mật khẩu cũ hết dùng");
  assert.equal(errOf(await reset(A, made.second, "LanThuHai@2026")), PASSWORD_RESET_INVALID, "dùng lần hai ⇒ câu chung");
  assert.ok(await canLogin(A, "nv@rs-a.local", NEW_PW), "lượt thứ hai không đổi gì");

  await withOrganization(A, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, made.nvId) });
    assert.ok(u?.sessionInvalidBefore, "mọi phiên cũ bị thu hồi");
    const done = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, made.nvId), eq(schema.auditLogs.action, "PASSWORD_RESET_COMPLETE")));
    assert.equal(done.length, 1, "một dòng nhật ký hoàn tất");
    const links = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, made.nvId), eq(schema.auditLogs.action, "PASSWORD_RESET_LINK")));
    assert.equal(links.length, 2, "mỗi lần tạo liên kết một dòng");
    const rows = await db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, made.nvId));
    assert.equal(rows.filter((r) => r.usedAt).length, 1);
    assert.equal(rows.filter((r) => r.revokedAt).length, 1);
    assert.ok(rows.every((r) => r.createdVia === "ORG_ADMIN"));
  });

  // Hai lượt đặt SONG SONG ⇒ đúng một thắng.
  const both = await Promise.all([reset(A, made.race, "SongSongMot@2026"), reset(A, made.race, "SongSongHai@2026")]);
  assert.equal(both.filter((r) => "ok" in r).length, 1, `đúng một lượt thắng: ${JSON.stringify(both)}`);

  // Hết hạn ⇒ câu chung.
  const late = await withOrganization(A, async () => {
    const db = await getDb();
    const adminRow = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) });
    const r = await createResetLinkCore(sessionOf(adminRow!, { organization: orgA }), made.nvId);
    assert.ok("ok" in r);
    await db.update(schema.passwordResetTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.passwordResetTokens.tokenHash, hashResetToken(tokenOf(r.link))));
    return tokenOf(r.link);
  });
  assert.equal(errOf(await reset(A, late)), PASSWORD_RESET_INVALID, "hết hạn");
  const lookLate = await lookupResetToken(A, late, { ip: IP });
  assert.ok(!lookLate.ok && lookLate.error === PASSWORD_RESET_INVALID);
  await withOrganization(B, async () => assert.equal((await (await getDb()).select().from(schema.passwordResetTokens)).length, 0, "B không có dòng nào"));
}

async function testOperator() {
  const home = await getHomeOrganization();
  const db = await getDb();
  const [opRow] = await db.insert(schema.users).values({ email: "pr-operator@nha.local", name: "Vận hành thử", passwordHash: "x", role: "ADMIN" }).returning({ id: schema.users.id, email: schema.users.email });
  try {
    const homeOrg = { code: home.code, name: home.name, isHome: true };
    const op = sessionOf(opRow, { organization: homeOrg });
    const notHome = sessionOf(opRow, { organization: { code: A, name: "x", isHome: false } });
    const noPerm = sessionOf(opRow, { role: "CS", organization: homeOrg });

    assert.match(errOf(await createResetLinkAsOperator(notHome, { orgCode: B, email: `admin@${B}.local`, reason: "Khách quên mật khẩu" })), /tổ chức nhà/);
    assert.match(errOf(await createResetLinkAsOperator(noPerm, { orgCode: B, email: `admin@${B}.local`, reason: "Khách quên mật khẩu" })), /không có quyền/);
    assert.match(errOf(await createResetLinkAsOperator(op, { orgCode: B, email: `admin@${B}.local`, reason: "x" })), /lý do/);
    assert.match(errOf(await createResetLinkAsOperator(op, { orgCode: home.code, email: opRow.email, reason: "Khách quên mật khẩu" })), /tổ chức khách/, "không đặt hộ tài khoản nhà");
    assert.match(errOf(await createResetLinkAsOperator(op, { orgCode: B, email: "khong-co@rs-b.local", reason: "Khách quên mật khẩu" })), /không có tài khoản/);

    const made = await createResetLinkAsOperator(op, { orgCode: B, email: ` ADMIN@${B.toUpperCase()}.local `, reason: "Chủ shop gọi báo quên mật khẩu" });
    assert.ok("ok" in made, JSON.stringify(made));
    assert.equal(made.email, `admin@${B}.local`);
    const tok = tokenOf(made.link);
    assert.equal(errOf(await reset(A, tok)), PASSWORD_RESET_INVALID, "mã của B đem sang A ⇒ câu chung");
    assert.ok("ok" in (await reset(B, tok)));
    assert.ok(await canLogin(B, `admin@${B}.local`, NEW_PW), "quản trị khách đăng nhập lại được");

    const pdb = await getPlatformDb();
    const logs = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, B), eq(schema.platformAuditLog.action, "PASSWORD_RESET_LINK")));
    assert.equal(logs.length, 1, "nhật ký nền tảng một dòng");
    assert.equal(logs[0].reason, "Chủ shop gọi báo quên mật khẩu");
    assert.equal(logs[0].actorEmail, opRow.email);
    assert.ok(!JSON.stringify(logs).includes(tok), "nhật ký nền tảng không chứa mã thô");
    await withOrganization(B, async () => {
      const rows = await (await getDb()).select().from(schema.passwordResetTokens);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].createdVia, "PLATFORM");
      assert.equal(rows[0].createdByEmail, `platform:${opRow.email}`);
    });
    await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, B));
  } finally {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, opRow.id));
    await db.delete(schema.users).where(eq(schema.users.id, opRow.id));
  }
}

async function testThrottle() {
  const ip = "198.51.100.199";
  const good = await withOrganization(A, async () => {
    const db = await getDb();
    const adminRow = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) });
    const r = await createResetLinkCore(sessionOf(adminRow!, { organization: { code: A, name: "x", isHome: false } }), adminRow!.id);
    assert.ok("ok" in r);
    return tokenOf(r.link);
  });
  for (let i = 0; i < 30; i++) await lookupResetToken(A, `${"x".repeat(42)}${i % 10}`, { ip });
  const blocked = await lookupResetToken(A, good, { ip });
  assert.ok(!blocked.ok && blocked.error === PASSWORD_RESET_THROTTLED, "30 lượt sai từ một máy ⇒ chặn, kể cả mã đúng");
  assert.equal(errOf(await reset(A, good, NEW_PW, ip)), PASSWORD_RESET_THROTTLED);
  assert.ok((await lookupResetToken(A, good, { ip: "198.51.100.200" })).ok, "máy khác không bị vạ lây");
}

export async function testPasswordReset() {
  testPure();
  assert.ok(env.appUrl, "cần APP_URL để dựng liên kết");
  for (const c of [A, B]) await cleanupOrg(c);
  try {
    await testOrgAdminFlow();
    await testOperator();
    await testThrottle();
  } finally {
    for (const c of [A, B]) await cleanupOrg(c);
  }
  console.log("  ✓ liên kết đặt lại mật khẩu: quản trị tổ chức + người vận hành (nhà, quyền, lý do, nhật ký nền tảng) tạo; trang tra không tiêu mã; đặt xong mật khẩu cũ hết dùng + thu hồi phiên; dùng lại / hết hạn / bị thay / chép chéo ⇒ một câu chung; song song ⇒ một thắng; không mã thô trong CSDL; chặn dò theo IP");
}
