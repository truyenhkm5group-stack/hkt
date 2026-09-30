/**
 * ═══════════ MỜI NGƯỜI DÙNG QUA LIÊN KẾT (gap «Invite User» — docs/platform/hslc-commercial-pilot-handoff.md mục 11) ═══════════
 *
 * Ba tổ chức THẬT (tự cấp, tự dọn): `ui-a` (gói standard, mẫu bán buôn), `ui-b` (đích của đòn chép mã chéo), `ui-t`
 * (gói trial — 3 người dùng). Cộng tổ chức NHÀ. Đi đúng luồng: quản trị (`users:manage`) tạo lời mời ⇒ liên kết
 * `/join/<tổ chức>/<mã>` ⇒ lượt công khai KHÔNG phiên tra + nhận trong `withOrganization(mã đường dẫn)` ⇒ tài khoản
 * đúng vai trò / vai trò tuỳ chỉnh ⇒ phiên THẬT (token ký) mang claim tổ chức đúng, quyền đúng.
 *
 * Đòn phải bị từ chối, và mọi lý do "liên kết không dùng được" ra CÙNG một câu: mã dùng lần hai · hết hạn · thu hồi ·
 * mã sai dạng · tổ chức không có · mã của A đem sang đường dẫn B (không tạo người ở B, không ở A, lời mời A còn nguyên).
 * Hai lượt nhận song song ⇒ đúng MỘT tài khoản. Thiếu `users:manage` ⇒ không tạo được lời mời. Vượt gói ⇒ từ chối (lúc
 * tạo — tính cả ghế đã hứa — VÀ lúc nhận). Bảng + nhật ký không chứa mã thô. Chặn dò theo IP.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { verifyLogin } from "@/lib/auth/login";
import { can, getCurrentUser, setRequestPathSourceForTests, signSession, type SessionSubject, type SessionUser } from "@/lib/auth/session";
import { saveAccessRoleCore } from "@/lib/auth/access-roles";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { MODULE_FREE_PATH_PREFIXES, moduleOfPath } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createUserCore } from "@/lib/users/create-user";
import { inviteLinkFor } from "@/lib/users/invite-link";
import { createUserInviteSchema, inviteChoiceToInput, USER_INVITE_INVALID, USER_INVITE_THROTTLED, userInviteStatus } from "@/lib/users/invite-shared";
import { acceptUserInviteCore, createUserInviteCore, generateUserInviteToken, hashUserInviteToken, listUserInvites, lookupUserInvite, revokeUserInviteCore } from "@/lib/users/invites";

const A = "ui-a";
const B = "ui-b";
const T = "ui-t";
const PW = "MoiNhanVien@2026";
const IP = "198.51.100.21";

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

/** Mã thô nằm ở đoạn cuối của liên kết — đúng thứ người được mời nhận. */
function tokenOf(link: string): string {
  return decodeURIComponent(link.split("/").pop() ?? "");
}

const accept = (org: string, token: string, input: unknown = { name: "Nhân viên mới", password: PW, confirmPassword: PW }, issue?: (s: SessionSubject) => Promise<void>) => acceptUserInviteCore(org, token, input, { ip: IP, issue });
const errOf = (r: { error: string } | { ok: true }) => ("error" in r ? r.error : "OK");

/** Người dùng THẬT của phiên (token ký bằng khoá của ứng dụng) — đi đúng đường `resolveCurrentUser`. */
async function sessionUserOf(subject: SessionSubject): Promise<SessionUser | null> {
  const token = await signSession(subject);
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => "/settings/profile");
  try {
    return await getCurrentUser();
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

async function usersWithEmail(org: string | null, email: string): Promise<number> {
  const run = async () => (await (await getDb()).select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))).length;
  return org ? withOrganization(org, run) : run();
}

// ─────────────────────────── Phần THUẦN + quét mã nguồn ───────────────────────────

function testPure() {
  assert.equal(createUserInviteSchema.safeParse({ email: "a@b.vn" }).success, false, "phải chọn một vai trò");
  assert.equal(createUserInviteSchema.safeParse({ email: "a@b.vn", role: "CS", accessRoleCode: "X" }).success, false, "không được chọn cả hai");
  const ok = createUserInviteSchema.safeParse({ email: "  Nhan.Vien@Shop.VN ", role: "CS" });
  assert.ok(ok.success && ok.data.email === "nhan.vien@shop.vn", "email chuẩn hoá chữ thường, bỏ khoảng trắng");
  assert.equal(createUserInviteSchema.safeParse({ email: "khong-phai-email", role: "CS" }).success, false);
  assert.deepEqual(inviteChoiceToInput("role:WAREHOUSE"), { role: "WAREHOUSE" });
  assert.deepEqual(inviteChoiceToInput("access:KHO_A"), { accessRoleCode: "KHO_A" });
  assert.equal(inviteChoiceToInput("role:ROOT"), null);
  const now = new Date("2026-09-29T00:00:00Z");
  const later = new Date(now.getTime() + 1000);
  assert.equal(userInviteStatus({ acceptedAt: null, revokedAt: null, expiresAt: later }, now), "ACTIVE");
  assert.equal(userInviteStatus({ acceptedAt: null, revokedAt: null, expiresAt: now }, now), "EXPIRED", "đúng mốc hạn là HẾT hạn (khớp `expires_at > now()`)");
  assert.equal(userInviteStatus({ acceptedAt: now, revokedAt: now, expiresAt: later }, now), "REVOKED");
  assert.equal(userInviteStatus({ acceptedAt: now, revokedAt: null, expiresAt: now }, now), "ACCEPTED");

  const t = generateUserInviteToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/, "32 byte base64url");
  assert.notEqual(generateUserInviteToken(), t);
  assert.equal(hashUserInviteToken(t), hashUserInviteToken(t));
  assert.ok(!hashUserInviteToken(t).includes(t));
  assert.equal(inviteLinkFor("ui-a", t), `${env.appUrl}/join/ui-a/${t}`);

  // Cửa công khai: middleware mở đúng nhánh `/join/`, cổng module coi `/join` là vùng không-module.
  const mw = readFileSync("middleware.ts", "utf8");
  const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("]", mw.indexOf("const PUBLIC_PREFIXES")));
  assert.ok(list.includes('"/join/"'), "/join/ không cần phiên");
  assert.ok((MODULE_FREE_PATH_PREFIXES as readonly string[]).includes("/join") && moduleOfPath("/join/ui-a/abc") === null);
  assert.equal(moduleOfPath("/settings/users"), "core", "quản lý lời mời vẫn là màn lõi");

  // MỘT đường ghi tạo tài khoản: ngoài lõi tạo người dùng, chỉ còn hai đường dựng QUẢN TRỊ ĐẦU TIÊN đã có từ trước.
  const tracked = execFileSync("git", ["ls-files", "lib", "app"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
  const writers = tracked.filter((f) => /\.insert\(schema\.users\)/.test(readFileSync(f, "utf8"))).sort();
  assert.deepEqual(writers, ["lib/auth/bootstrap.ts", "lib/platform/provision.ts", "lib/users/create-user.ts"], "tạo người dùng phải đi qua lib/users/create-user.ts");
  // MỘT nơi dựng liên kết mời.
  const builders = tracked.filter((f) => f !== "lib/users/invite-link.ts" && /[`"']\/join\/\$\{|JOIN_PATH\}/.test(readFileSync(f, "utf8")));
  assert.deepEqual(builders, [], "liên kết /join/ chỉ dựng ở lib/users/invite-link.ts (inviteLinkFor)");
  const actions = readFileSync("lib/actions/user-invites.ts", "utf8");
  assert.ok(!/withOrganization\(|getPlatformDb\(/.test(actions), "server action không tự chọn CSDL");
}

// ─────────────────────────── Tổ chức A (standard) + B ───────────────────────────

async function testOrgFlow() {
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  await provisionOrganization({ code: A, name: "Mời người A", plan: "standard", modules, admin: { email: `admin@${A}.local`, name: "QT A", password: "QuanTriA@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: B, name: "Mời người B", plan: "standard", modules, admin: { email: `admin@${B}.local`, name: "QT B", password: "QuanTriB@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(A))];
  const orgA = { code: A, name: "Mời người A", isHome: false };

  // ── Quản trị A tạo lời mời (trong ngữ cảnh A, như phiên của họ) ──
  const made = await withOrganization(A, async () => {
    const db = await getDb();
    const adminRow = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) });
    assert.ok(adminRow);
    const admin = sessionOf(adminRow, { organization: orgA, modules: enabled });
    const warehouse = sessionOf(adminRow, { role: "WAREHOUSE", permissions: ["inventory:write"], organization: orgA, modules: enabled });

    // Thiếu users:manage ⇒ không tạo, không thu hồi, 0 dòng.
    assert.equal(errOf(await createUserInviteCore(warehouse, { email: "x@ui-a.local", role: "CS" })), "Không có quyền");
    assert.equal((await db.select().from(schema.userInvites)).length, 0);

    const role = await saveAccessRoleCore(admin, { code: "KHO_TUY_CHINH", name: "Kho tuỳ chỉnh", description: "", baseRole: "WAREHOUSE", permissions: ["products:view", "customers:view"], defaultScope: "ALL", active: true });
    assert.ok("ok" in role, JSON.stringify(role));

    const sys = await createUserInviteCore(admin, { email: "Kho@UI-A.local", role: "WAREHOUSE" });
    assert.ok("ok" in sys, JSON.stringify(sys));
    assert.ok(sys.link.startsWith(`${env.appUrl}/join/${A}/`), sys.link);
    assert.equal(sys.email, "kho@ui-a.local");
    assert.ok(Math.abs(sys.expiresAt.getTime() - (Date.now() + 7 * 86_400_000)) < 60_000, "hạn 7 ngày");
    const custom = await createUserInviteCore(admin, { email: "tuychinh@ui-a.local", accessRoleCode: "KHO_TUY_CHINH" });
    assert.ok("ok" in custom, JSON.stringify(custom));

    assert.match(errOf(await createUserInviteCore(admin, { email: `admin@${A}.local`, role: "CS" })), /đã có tài khoản/, "email đã là tài khoản ⇒ lỗi rõ");
    assert.match(errOf(await createUserInviteCore(admin, { email: "kho@ui-a.local", role: "CS" })), /lời mời còn hạn/, "một email một lời mời còn hạn");
    assert.match(errOf(await createUserInviteCore(admin, { email: "y@ui-a.local", accessRoleCode: "KHONG_CO" })), /không tồn tại/);

    const race = await createUserInviteCore(admin, { email: "race@ui-a.local", role: "CS" });
    const late = await createUserInviteCore(admin, { email: "late@ui-a.local", role: "CS" });
    const gone = await createUserInviteCore(admin, { email: "gone@ui-a.local", role: "CS" });
    const cross = await createUserInviteCore(admin, { email: "cross@ui-a.local", role: "CS" });
    for (const r of [race, late, gone, cross]) assert.ok("ok" in r, JSON.stringify(r));
    if (!("ok" in race && "ok" in late && "ok" in gone && "ok" in cross)) throw new Error("unreachable");

    // Hết hạn: đẩy mốc hạn về quá khứ. Thu hồi: đúng lõi thu hồi, thiếu quyền thì không được.
    await db.update(schema.userInvites).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.userInvites.id, late.id));
    assert.equal(errOf(await revokeUserInviteCore(warehouse, gone.id)), "Không có quyền");
    assert.ok("ok" in (await revokeUserInviteCore(admin, gone.id)));
    assert.match(errOf(await revokeUserInviteCore(admin, gone.id)), /không còn thu hồi được/);

    return { sys: tokenOf(sys.link), custom: tokenOf(custom.link), race: tokenOf(race.link), late: tokenOf(late.link), gone: tokenOf(gone.link), cross: tokenOf(cross.link), roleId: "ok" in role ? role.id : "" };
  });

  // ── Bảng + nhật ký KHÔNG chứa mã thô ──
  await withOrganization(A, async () => {
    const db = await getDb();
    const dump = JSON.stringify([await db.select().from(schema.userInvites), await db.select().from(schema.auditLogs)]);
    for (const tok of Object.values(made).filter((v) => v.length === 43)) {
      assert.ok(!dump.includes(tok), "mã thô không được nằm trong CSDL");
      assert.ok(dump.includes(hashUserInviteToken(tok)), "CSDL giữ băm");
    }
  });

  // ── Lượt công khai (KHÔNG phiên): tra rồi nhận ──
  const look = await lookupUserInvite(A, made.sys, { ip: IP });
  assert.ok(look.ok, JSON.stringify(look));
  assert.equal(look.orgName, "Mời người A");
  assert.equal(look.email, "kho@ui-a.local");
  assert.equal(look.roleLabel, "Kho");

  const short = await accept(A, made.sys, { name: "NV", password: "ngan", confirmPassword: "ngan" });
  assert.match(errOf(short), /ít nhất 10 ký tự/, "mật khẩu ≥ 10 ký tự như /start");
  assert.match(errOf(await accept(A, made.sys, { name: "NV Kho", password: PW, confirmPassword: `${PW}x` })), /không khớp/);

  let subject: SessionSubject | null = null;
  const ok = await accept(A, made.sys, { name: "Nhân viên kho", password: PW, confirmPassword: PW }, async (s) => {
    subject = s;
  });
  assert.ok("ok" in ok && ok.loggedIn && ok.orgCode === A, JSON.stringify(ok));
  const sub = subject as SessionSubject | null;
  assert.ok(sub && sub.orgCode === A && sub.email === "kho@ui-a.local" && sub.role === "WAREHOUSE", "phiên mang claim tổ chức A");
  const kho = await sessionUserOf(sub!);
  assert.ok(kho, "phiên thật dựng được người dùng");
  assert.equal(kho.organization?.code, A);
  assert.equal(can(kho, "users:manage"), false, "người mời vai trò Kho KHÔNG có users:manage");
  assert.equal(can(kho, "inventory:write"), true, "mẫu quyền Kho có hiệu lực");
  assert.ok((await verifyLogin({ email: "kho@ui-a.local", password: PW, orgCode: A }, async () => undefined)).ok, "đăng nhập lại được bằng mật khẩu tự đặt");
  assert.equal((await verifyLogin({ email: "kho@ui-a.local", password: PW, orgCode: B }, async () => undefined)).ok, false, "không có tài khoản ở B");

  await withOrganization(A, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, "kho@ui-a.local") });
    assert.ok(u && u.role === "WAREHOUSE" && u.accessRoleId === null && u.dataScope === "ALL" && u.active && u.name === "Nhân viên kho");
    assert.notEqual(u.passwordHash, PW, "mật khẩu đã băm");
    const inv = await db.query.userInvites.findFirst({ where: eq(schema.userInvites.tokenHash, hashUserInviteToken(made.sys)) });
    assert.ok(inv?.acceptedAt && inv.acceptedUserId === u.id, "lời mời đánh dấu đã nhận, trỏ đúng tài khoản");
    const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "USER"), eq(schema.auditLogs.entityId, u.id), eq(schema.auditLogs.action, "USER_CREATE")));
    assert.equal(logs.length, 1, "một dòng USER_CREATE");
    assert.equal((logs[0].detail as { via?: string }).via, "INVITE");
  });

  // Dùng lần hai ⇒ câu chung, không thêm tài khoản.
  assert.equal(errOf(await accept(A, made.sys)), USER_INVITE_INVALID, "mã đã dùng ⇒ từ chối");
  assert.equal((await lookupUserInvite(A, made.sys, { ip: IP })).ok, false);
  assert.equal(await usersWithEmail(A, "kho@ui-a.local"), 1);

  // Vai trò tuỳ chỉnh ⇒ vai trò nền + access_role_id; quyền đúng bó đã khai.
  let subCustom: SessionSubject | null = null;
  const okCustom = await accept(A, made.custom, undefined, async (s) => {
    subCustom = s;
  });
  assert.ok("ok" in okCustom, JSON.stringify(okCustom));
  await withOrganization(A, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "tuychinh@ui-a.local") });
    assert.ok(u && u.role === "WAREHOUSE" && u.accessRoleId === made.roleId, "vai trò tuỳ chỉnh gán đúng");
  });
  const tc = await sessionUserOf(subCustom!);
  assert.ok(tc);
  assert.equal(can(tc, "customers:view"), true, "bó quyền tuỳ chỉnh có hiệu lực");
  assert.equal(can(tc, "inventory:write"), false, "không mang mẫu quyền Kho — chỉ bó tuỳ chỉnh");
  assert.equal(can(tc, "users:manage"), false);

  // Hai lượt nhận SONG SONG ⇒ đúng một tài khoản.
  const both = await Promise.all([accept(A, made.race), accept(A, made.race)]);
  assert.equal(both.filter((r) => "ok" in r).length, 1, `đúng một lượt thắng: ${JSON.stringify(both)}`);
  assert.equal(await usersWithEmail(A, "race@ui-a.local"), 1);

  // Hết hạn / thu hồi / sai dạng / tổ chức không có ⇒ CÙNG một câu.
  assert.equal(errOf(await accept(A, made.late)), USER_INVITE_INVALID, "hết hạn");
  assert.equal(errOf(await accept(A, made.gone)), USER_INVITE_INVALID, "thu hồi");
  assert.equal(errOf(await accept(A, "khong-phai-ma")), USER_INVITE_INVALID, "sai dạng");
  assert.equal(errOf(await accept("khong-co-to-chuc", made.cross)), USER_INVITE_INVALID, "tổ chức không có");
  assert.equal(errOf(await accept("../ui-a", made.cross)), USER_INVITE_INVALID, "mã tổ chức sai dạng");
  const lookLate = await lookupUserInvite(A, made.late, { ip: IP });
  assert.ok(!lookLate.ok && lookLate.error === USER_INVITE_INVALID);
  assert.equal(await usersWithEmail(A, "late@ui-a.local"), 0);
  assert.equal(await usersWithEmail(A, "gone@ui-a.local"), 0);

  // Mã của A đem sang đường dẫn B ⇒ từ chối, không người ở B, không người ở A, lời mời A còn nguyên.
  const lookCross = await lookupUserInvite(B, made.cross, { ip: IP });
  assert.ok(!lookCross.ok && lookCross.error === USER_INVITE_INVALID, "tra chéo ⇒ câu chung");
  assert.equal(errOf(await accept(B, made.cross)), USER_INVITE_INVALID, "nhận chéo ⇒ câu chung");
  assert.equal(await usersWithEmail(B, "cross@ui-a.local"), 0, "không tạo người ở B");
  assert.equal(await usersWithEmail(A, "cross@ui-a.local"), 0, "không tạo người ở A");
  assert.equal(await usersWithEmail(null, "cross@ui-a.local"), 0, "không rơi về tổ chức nhà");
  await withOrganization(B, async () => assert.equal((await (await getDb()).select().from(schema.userInvites)).length, 0, "B không có lời mời nào"));

  // Danh sách: đủ bốn trạng thái, không có cột băm.
  await withOrganization(A, async () => {
    const list = await listUserInvites();
    const by = (e: string) => list.find((r) => r.email === e)?.status;
    assert.equal(by("kho@ui-a.local"), "ACCEPTED");
    assert.equal(by("late@ui-a.local"), "EXPIRED");
    assert.equal(by("gone@ui-a.local"), "REVOKED");
    assert.equal(by("cross@ui-a.local"), "ACTIVE", "đòn chép chéo không tiêu lời mời của A");
    assert.ok(list.every((r) => !("tokenHash" in r)), "danh sách không trả băm");
  });
}

// ─────────────────────────── Gói trial: hạn mức lúc tạo VÀ lúc nhận ───────────────────────────

async function testPlanLimit() {
  await provisionOrganization({ code: T, name: "Mời người dùng thử", plan: "trial", modules: [], admin: { email: `admin@${T}.local`, name: "QT T", password: "QuanTriT@12345" }, source: "TEST", actor: null });
  const tokens = await withOrganization(T, async () => {
    const db = await getDb();
    const adminRow = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${T}.local`) });
    assert.ok(adminRow);
    const admin = sessionOf(adminRow, { organization: { code: T, name: "Mời người dùng thử", isHome: false } });
    const i1 = await createUserInviteCore(admin, { email: "mot@ui-t.local", role: "CS" });
    const i2 = await createUserInviteCore(admin, { email: "hai@ui-t.local", role: "CS" });
    assert.ok("ok" in i1 && "ok" in i2, JSON.stringify([i1, i2]));
    // 1 người + 2 ghế đã hứa = 3/3 ⇒ lời mời thứ ba và cả tạo hộ đều bị chặn.
    const over = errOf(await createUserInviteCore(admin, { email: "ba@ui-t.local", role: "CS" }));
    assert.match(over, /hạn mức/, "lời mời thứ ba vượt gói trial");
    assert.match(over, /2 lời mời còn hạn/, "câu lỗi nói rõ ghế đã hứa");
    assert.match(errOf(await createUserCore(admin, { name: "Tạo hộ", email: "taoho@ui-t.local", password: "TaoHo@2026", role: "CS" })), /hạn mức/, "tạo hộ cũng tính ghế đã hứa");
    // Một tài khoản chen vào bằng đường khác (dữ liệu có sẵn) ⇒ lúc NHẬN phải kiểm lại trần cứng.
    await db.insert(schema.users).values({ email: "chen@ui-t.local", name: "Chen", passwordHash: "x", role: "VIEWER" });
    return { i1: tokenOf("ok" in i1 ? i1.link : ""), i2: tokenOf("ok" in i2 ? i2.link : "") };
  });
  assert.ok("ok" in (await accept(T, tokens.i1)), "3/3 ⇒ vẫn nhận được");
  assert.match(errOf(await accept(T, tokens.i2)), /hạn mức/, "lúc nhận: 4 > 3 ⇒ từ chối");
  await withOrganization(T, async () => {
    const db = await getDb();
    assert.equal(await usersWithEmail(null, "hai@ui-t.local"), 0);
    const inv = await db.query.userInvites.findFirst({ where: eq(schema.userInvites.email, "hai@ui-t.local") });
    assert.ok(inv && !inv.acceptedAt, "bị chặn vì gói ⇒ lời mời KHÔNG bị tiêu");
  });
}

// ─────────────────────────── Tổ chức NHÀ: dùng y hệt ───────────────────────────

async function testHome() {
  const home = await getHomeOrganization();
  const email = "ui-home-invite@nha.local";
  const db = await getDb();
  // Người mời phải là tài khoản THẬT của nhà: nhật ký trỏ `user_id` vào `users`.
  const [adminRow] = await db.insert(schema.users).values({ email: "ui-home-admin@nha.local", name: "QT nhà thử mời", passwordHash: "x", role: "ADMIN" }).returning({ id: schema.users.id, email: schema.users.email });
  try {
    const admin = sessionOf(adminRow, { organization: { code: home.code, name: home.name, isHome: true } });
    const made = await createUserInviteCore(admin, { email, role: "CS" });
    assert.ok("ok" in made, JSON.stringify(made));
    assert.ok(made.link.startsWith(`${env.appUrl}/join/${home.code}/`));
    const tok = tokenOf(made.link);
    assert.equal(errOf(await accept(A, tok)), USER_INVITE_INVALID, "mã của nhà đem sang tổ chức khác ⇒ câu chung");
    const look = await lookupUserInvite(home.code, tok, { ip: IP });
    assert.ok(look.ok && look.roleLabel === "CSKH");
    let sub: SessionSubject | null = null;
    const ok = await accept(home.code, tok, undefined, async (s) => {
      sub = s;
    });
    assert.ok("ok" in ok && ok.loggedIn, JSON.stringify(ok));
    assert.equal((sub as SessionSubject | null)?.orgCode, home.code, "phiên mang claim tổ chức nhà");
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
    assert.ok(u && u.role === "CS", "tài khoản ở CSDL nhà");
    assert.equal(await usersWithEmail(A, email), 0);
    assert.equal(errOf(await accept(home.code, tok)), USER_INVITE_INVALID);
  } finally {
    await db.delete(schema.userInvites).where(eq(schema.userInvites.email, email));
    await db.delete(schema.users).where(eq(schema.users.email, email));
    await db.delete(schema.users).where(eq(schema.users.id, adminRow.id));
  }
}

// ─────────────────────────── Chặn dò theo IP ───────────────────────────

async function testThrottle() {
  const ip = "198.51.100.99";
  const good = await withOrganization(A, async () => {
    const db = await getDb();
    const adminRow = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) });
    const r = await createUserInviteCore(sessionOf(adminRow!, { organization: { code: A, name: "Mời người A", isHome: false } }), { email: "throttle@ui-a.local", role: "VIEWER" });
    assert.ok("ok" in r);
    return tokenOf(r.link);
  });
  for (let i = 0; i < 30; i++) await lookupUserInvite(A, `${"x".repeat(42)}${i % 10}`, { ip });
  const blocked = await lookupUserInvite(A, good, { ip });
  assert.ok(!blocked.ok && blocked.error === USER_INVITE_THROTTLED, "30 lượt sai từ một máy ⇒ chặn, kể cả mã đúng");
  assert.equal(errOf(await acceptUserInviteCore(A, good, { name: "NV", password: PW, confirmPassword: PW }, { ip })), USER_INVITE_THROTTLED);
  assert.ok((await lookupUserInvite(A, good, { ip: "198.51.100.100" })).ok, "máy khác không bị vạ lây");
  assert.equal(await usersWithEmail(A, "throttle@ui-a.local"), 0);
  // Lượt đếm không ghi gì vào CSDL.
  await withOrganization(A, async () => {
    const [r] = await (await getDb()).select({ n: sql<number>`count(*)` }).from(schema.userInvites).where(eq(schema.userInvites.email, "throttle@ui-a.local"));
    assert.equal(Number(r.n), 1);
  });
}

export async function testUserInvites() {
  testPure();
  for (const c of [A, B, T]) await cleanupOrg(c);
  try {
    await testOrgFlow();
    await testPlanLimit();
    await testHome();
    await testThrottle();
  } finally {
    for (const c of [A, B, T]) await cleanupOrg(c);
  }
  console.log("  ✓ mời người dùng qua liên kết: vai trò hệ thống + tuỳ chỉnh ⇒ tài khoản đúng tổ chức, phiên đúng claim, quyền đúng; dùng lại / hết hạn / thu hồi / chép chéo tổ chức ⇒ một câu chung; song song ⇒ một tài khoản; hạn mức gói lúc tạo và lúc nhận; nhà dùng y hệt; bảng không chứa mã thô; chặn dò theo IP");
}
