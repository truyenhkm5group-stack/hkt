/**
 * NỀN TẢNG ĐA TỔ CHỨC — PHIÊN, RBAC, CỔNG MODULE (docs/platform/shared-contracts.md mục 3, 7, 11, 12).
 *
 * Chạy trên PGlite với một tổ chức THẬT thứ hai (CSDL riêng, thư mục `<thư mục kiểm thử>-org-<mã>`),
 * cấp bằng đúng `provisionOrganization` của sản phẩm. Phiên giả bằng MÓC của ngữ cảnh
 * (`setSessionTokenSourceForTests`) — token vẫn đi qua ĐÚNG đường xác minh chữ ký như request thật —
 * và đường dẫn request giả bằng `setRequestPathSourceForTests` (header `x-erp-path` do middleware đặt).
 *
 * Những gì ĐO ĐƯỢC ngoài Next: middleware thật (header + gia hạn), `resolveCurrentUser()`,
 * `requireUser()` (lời gọi `redirect()` ném lỗi mang đích — đọc được), `can()`, `apiGuard()`,
 * `verifyLogin()` (lõi đăng nhập). CHƯA ĐO ĐƯỢC ở đây: `loginAction` đầu-cuối (cần `headers()` +
 * `cookies().set()` của một request thật) và trang `/login` dựng thật.
 *
 * Tự dọn: tổ chức mang tiền tố `pr-`, thư mục CSDL của nó xoá trước và sau; dòng người dùng / cấu hình
 * gieo vào CSDL nhà mang tiền tố `pr-` và bị xoá ở cuối.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { and, eq, like } from "drizzle-orm";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { middleware } from "@/middleware";
import { apiGuard } from "@/lib/auth/api-guard";
import { LOGIN_BAD_CREDENTIALS, loginOrgCode, verifyLogin } from "@/lib/auth/login";
import { loginAllowed, loginThrottleKeys, LOGIN_THROTTLE, recordLoginFailure, resetLoginThrottle } from "@/lib/auth/login-throttle";
import { hashPassword } from "@/lib/auth/password";
import { PERMISSIONS_ADDED_AFTER_SNAPSHOT, resolvePermissions, ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { can, requireUser, resolveCurrentUser, ROLE_PERMISSIONS_KEY, setRequestPathSourceForTests, signSession, type SessionSubject, type SessionUser } from "@/lib/auth/session";
import { ROLE_BUILDER_FORBIDDEN } from "@/lib/constants/access-scope";
import { ERP_PATH_HEADER, SESSION_COOKIE, SESSION_IDLE_DAYS, SESSION_ORG_CLAIM, renewalClaims } from "@/lib/constants/session";
import { DENY_REASON_MESSAGE, DENY_REASON_PARAM, loginShouldStay } from "@/lib/constants/session-revocation";
import { env } from "@/lib/env";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { setOrganizationModule } from "@/lib/platform/module-config";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const B = "pr-rbac";
const NGAY = 86_400;
const EMAIL_CHUNG = "trung@pr-rbac.local";
const MK_NHA = "Nha@pr-12345";
const MK_B = "Beta@pr-12345";
const HOME_ADMIN_ID = "pr-home-admin";
const HOME_TWIN_ID = "pr-home-twin";

function dirOf(code: string) {
  return organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, "");
}

const khoa = () => new TextEncoder().encode(env.authSecret);

/** Chạy `fn` như một request của phiên `token` tới đường dẫn `path`; luôn gỡ móc. */
async function asRequest<T>(token: string | null, path: string | null, fn: () => Promise<T>): Promise<T> {
  setSessionTokenSourceForTests(async () => token ?? undefined);
  setRequestPathSourceForTests(() => path);
  try {
    return await fn();
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

async function resolved(token: string | null, path: string | null) {
  return asRequest(token, path, () => resolveCurrentUser());
}

function userOf(ket: Awaited<ReturnType<typeof resolveCurrentUser>>): SessionUser {
  assert.ok("user" in ket, `phải ra người dùng, nhận ${JSON.stringify(ket)}`);
  return ket.user;
}

async function redirectTarget(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
    throw error;
  }
  return "";
}

async function bodyOf(res: Response) {
  return (await res.json()) as { ok?: boolean; error?: string; code?: string; module?: string };
}

export async function testPlatformRbac() {
  const dir = dirOf(B);
  rmSync(dir, { recursive: true, force: true });
  resetLoginThrottle();
  const home = await getHomeOrganization();
  const pdb = await getPlatformDb();
  let failure: unknown = null;

  try {
    // ── 0. Cấp tổ chức B (module: customers, products, orders) + người dùng hai phía ──
    const prov = await provisionOrganization({
      code: B,
      name: "RBAC thử nghiệm",
      modules: ["customers", "products", "orders"],
      admin: { email: "admin@pr-rbac.local", name: "Quản trị B", password: MK_B },
      source: "TEST",
      actor: null,
    });
    assert.equal(prov.created, true);
    const bAdmin = await withOrganization(B, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "admin@pr-rbac.local") }));
    assert.ok(bAdmin, "quản trị B nằm trong CSDL B");
    const bTwin = await withOrganization(B, async () => {
      const db = await getDb();
      const [row] = await db.insert(schema.users).values({ email: EMAIL_CHUNG, name: "Người trùng email (B)", passwordHash: await hashPassword(MK_B), role: "MARKETING" }).returning();
      return row;
    });
    const homeDb = await getDb();
    await homeDb.insert(schema.users).values([
      { id: HOME_ADMIN_ID, email: "admin@pr-home.local", name: "Quản trị nhà", passwordHash: "x", role: "ADMIN" },
      { id: HOME_TWIN_ID, email: EMAIL_CHUNG, name: "Người trùng email (nhà)", passwordHash: await hashPassword(MK_NHA), role: "MARKETING" },
    ]);

    const subjectB: SessionSubject = { id: bAdmin.id, email: bAdmin.email, name: bAdmin.name, role: "ADMIN", orgCode: B };
    const tokenB = await signSession(subjectB);
    const tokenHomeAdmin = await signSession({ id: HOME_ADMIN_ID, email: "admin@pr-home.local", name: "Quản trị nhà", role: "ADMIN", orgCode: home.code });

    // ═══════════ (a) CLAIM `org`: KÝ VÀO, VÀ GIA HẠN KHÔNG LÀM RƠI ═══════════
    const { payload: pB } = await jwtVerify(tokenB, khoa());
    assert.equal(pB[SESSION_ORG_CLAIM], B, "signSession ghi claim org = mã tổ chức");
    await assert.rejects(() => signSession({ ...subjectB, orgCode: "" }), /thiếu mã tổ chức/, "phiên mới không được ký mà không nói thuộc tổ chức nào");

    const now = Math.floor(Date.now() / 1000);
    const renewed = renewalClaims({ ...pB, iat: now - 5 * NGAY, exp: now + 2 * NGAY, nbf: now - 5 * NGAY }, 12345);
    assert.equal(renewed[SESSION_ORG_CLAIM], B, "hàm dựng claim gia hạn GIỮ org");
    assert.equal(renewed.email, pB.email);
    assert.equal(renewed.role, pB.role);
    assert.equal(renewed.lgn, 12345, "mốc đăng nhập gốc do phép quyết định gia hạn đặt");
    for (const k of ["iat", "exp", "nbf", "sub"]) assert.ok(!(k in renewed), `claim ${k} là của tờ giấy cũ — không được chép`);
    assert.ok(!(SESSION_ORG_CLAIM in renewalClaims({ email: "x", iat: 1, exp: 2 }, 1)), "token cũ không có org thì gia hạn KHÔNG bịa ra org");

    // Middleware THẬT: token của B qua nửa đời ⇒ cookie gia hạn vẫn mang org = B.
    const tokenBCu = await signSession(subjectB, { nowSec: now - 5 * NGAY });
    const resRenew = await middleware(new NextRequest("https://erp.test/orders", { headers: { cookie: `${SESSION_COOKIE}=${tokenBCu}` } }));
    const moi = resRenew.cookies.get(SESSION_COOKIE)?.value;
    assert.ok(moi, "token qua nửa đời phải được gia hạn");
    const pMoi = decodeJwt(moi);
    assert.equal(pMoi[SESSION_ORG_CLAIM], B, "gia hạn ở middleware GIỮ org — quên là đá người của B về tổ chức nhà (ISO-09)");
    assert.equal(pMoi.sub, bAdmin.id);
    assert.ok(Number(pMoi.exp) <= now + SESSION_IDLE_DAYS * NGAY + 5);

    // Header `x-erp-path`: middleware đặt cho MỌI request (kể cả đường công khai) và xoá `x-erp-*` client gửi.
    for (const [duong, cookie] of [["/production", `${SESSION_COOKIE}=${tokenB}`], ["/login", ""]] as const) {
      const res = await middleware(new NextRequest(`https://erp.test${duong}?q=1`, { headers: { cookie, [ERP_PATH_HEADER]: "/", "X-Erp-Gia-Mao": "1" } }));
      assert.equal(res.headers.get(`x-middleware-request-${ERP_PATH_HEADER}`), duong, `${duong}: x-erp-path là đường dẫn THẬT, không phải giá trị client gửi`);
      const override = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
      assert.ok(override.includes(ERP_PATH_HEADER), `${duong}: header phải được chuyển tiếp`);
      assert.ok(!override.some((h) => h.toLowerCase() === "x-erp-gia-mao"), `${duong}: mọi x-erp-* client gửi phải bị xoá`);
    }

    // ISO-02: mẫu quyền đệm THEO TỔ CHỨC. Chạy TRƯỚC mọi lượt đọc phiên của B: làm ấm đệm của nhà trước,
    // rồi đọc người MARKETING của B — một khoá đệm chung thì B nhận mẫu của nhà.
    await withOrganization(B, async () => {
      const db = await getDb();
      await db.insert(schema.settings).values({ key: ROLE_PERMISSIONS_KEY, value: JSON.stringify({ MARKETING: ["dashboard:view"] }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ MARKETING: ["dashboard:view"] }) } });
    });
    const tokenHomeTwin = await signSession({ id: HOME_TWIN_ID, email: EMAIL_CHUNG, name: "x", role: "MARKETING", orgCode: home.code });
    const uHomeTwin = userOf(await resolved(tokenHomeTwin, "/orders"));
    const tokenBTwin = await signSession({ id: bTwin.id, email: EMAIL_CHUNG, name: "x", role: "MARKETING", orgCode: B });
    const uBTwin = userOf(await resolved(tokenBTwin, "/orders"));
    assert.deepEqual(uBTwin.permissions, ["dashboard:view"], "người của B nhận mẫu quyền của B, KHÔNG phải mẫu của nhà vừa nằm trong đệm (ISO-02)");
    assert.notDeepEqual(uHomeTwin.permissions, uBTwin.permissions, "và ngược lại: mẫu của B không áp cho người của nhà");

    // ═══════════ (b) PHIÊN CỦA B ⇒ NGƯỜI CỦA B; CÙNG `sub` MANG org NHÀ ⇒ KHÔNG AI ═══════════
    const uB = userOf(await resolved(tokenB, "/orders"));
    assert.equal(uB.id, bAdmin.id);
    assert.equal(uB.organization?.code, B);
    assert.equal(uB.organization?.isHome, false);
    const expectB = [...(await getEnabledModules(B))].sort();
    assert.deepEqual([...(uB.modules ?? [])].sort(), expectB, "modules = đúng tập bật của B (cùng bộ phân giải với menu)");
    assert.ok(expectB.includes("orders") && !expectB.includes("production"));

    const tanCong = await signSession({ ...subjectB, orgCode: home.code });
    assert.deepEqual(await resolved(tanCong, "/orders"), { denied: "NOT_FOUND" }, "id người của B mang claim org nhà ⇒ tra CSDL nhà ⇒ không có ai (tấn công chéo tổ chức bằng id)");
    const legacy = await new SignJWT({ email: bAdmin.email, role: "ADMIN" }).setProtectedHeader({ alg: "HS256" }).setSubject(bAdmin.id).setIssuedAt(now).setExpirationTime(now + 600).sign(khoa());
    assert.deepEqual(await resolved(legacy, "/orders"), { denied: "NOT_FOUND" }, "token cũ không org ⇒ tổ chức nhà ⇒ người của B không tồn tại ở đó");

    const uHome = userOf(await resolved(tokenHomeAdmin, "/production"));
    assert.equal(uHome.organization?.isHome, true, "tổ chức nhà: module_default = BẬT ⇒ /production mở như trước nền tảng");

    // ═══════════ (c) CỔNG MODULE THEO ĐƯỜNG DẪN — BẬT LÀ CÓ NGAY, KHÔNG DEPLOY ═══════════
    assert.deepEqual(await resolved(tokenB, "/production"), { denied: "MODULE_DISABLED", module: "production" }, "/production khi module tắt ⇒ MODULE_DISABLED kèm khoá");
    assert.deepEqual(await resolved(tokenB, "/production/topics/abc"), { denied: "MODULE_DISABLED", module: "production" }, "trang con cũng bị chặn");
    assert.ok("user" in (await resolved(tokenB, "/orders")), "/orders (bật) ⇒ đi tiếp");
    assert.ok("user" in (await resolved(tokenB, null)), "không có đường dẫn (script, job) ⇒ không có cổng đường dẫn");
    assert.equal(await asRequest(tokenB, "/production", () => redirectTarget(() => requireUser())), "/module-disabled?m=production", "requireUser chuyển tới trang giải thích, KHÔNG về /login");

    // apiGuard: đúng mã cho từng tình huống.
    const g1 = await asRequest(tokenB, "/production", () => apiGuard());
    assert.ok(g1 instanceof Response && g1.status === 403, "đường dẫn thuộc module tắt ⇒ 403, không phải 401 (người dùng ĐÃ đăng nhập)");
    const b1 = await bodyOf(g1);
    assert.equal(b1.ok, false);
    assert.equal(b1.code, "MODULE_DISABLED");
    assert.equal(b1.module, "production");
    const g2 = await asRequest(tokenB, "/api/refresh", () => apiGuard("production:write"));
    assert.ok(g2 instanceof Response && g2.status === 403 && (await bodyOf(g2)).code === "MODULE_DISABLED", "khoá quyền thuộc module tắt ⇒ 403 MODULE_DISABLED, kể cả ADMIN");
    const g3 = await asRequest(tokenB, "/api/refresh", () => apiGuard("orders:read"));
    assert.ok(!(g3 instanceof Response) && g3.user.id === bAdmin.id, "module bật + có quyền ⇒ đi tiếp");
    const g4 = await asRequest("khong-phai-token", "/api/refresh", () => apiGuard());
    assert.ok(g4 instanceof Response && g4.status === 401 && (await bodyOf(g4)).code === "UNAUTHENTICATED");
    const g5 = await asRequest(tokenBTwin, "/api/refresh", () => apiGuard("orders:read", { format: "text", forbiddenMessage: "Không có quyền xem đơn" }));
    assert.ok(g5 instanceof Response && g5.status === 403 && (await g5.text()) === "Không có quyền xem đơn", "thiếu quyền ⇒ 403 FORBIDDEN, giữ câu riêng của route");

    // Ngoài mọi request (job nền, script) và không có móc: vẫn NÉM như trước — `decideScope()` dựa vào đó để
    // phân biệt "hệ thống tự chạy" (MỞ) với "người lạ trong request" (ĐÓNG).
    await assert.rejects(() => resolveCurrentUser(), "ngoài request thì resolveCurrentUser phải ném, không trả NOT_FOUND");

    // ═══════════ (d) can(): ADMIN KHÔNG VƯỢT CỔNG MODULE; platform:operate CHỈ TỔ CHỨC NHÀ ═══════════
    assert.equal(can(uB, "production:write"), false, "ADMIN của B với khoá của module tắt ⇒ false (P8)");
    assert.equal(can(uB, "orders:read"), true);
    assert.equal(can(uB, "platform:operate"), false, "ADMIN của tổ chức khác KHÔNG BAO GIỜ có platform:operate");
    assert.equal(can(uHome, "platform:operate"), true, "ADMIN của tổ chức nhà có");
    assert.equal(can({ ...uHome, organization: undefined }, "platform:operate"), false, "không mang thông tin tổ chức ⇒ phía hẹp");
    assert.equal(can("ADMIN", "production:write"), true, "can(vai trò) không có ngữ cảnh tổ chức ⇒ luật cũ");

    const r1 = await setOrganizationModule({ orgCode: B, moduleKey: "production", enabled: true, source: "TEST", actor: null });
    assert.equal(r1.ok, false, "bật production khi inventory tắt ⇒ chặn + giải thích phụ thuộc");
    assert.equal((await setOrganizationModule({ orgCode: B, moduleKey: "inventory", enabled: true, source: "TEST", actor: null })).ok, true);
    assert.equal((await setOrganizationModule({ orgCode: B, moduleKey: "production", enabled: true, source: "TEST", actor: null })).ok, true);
    const uBOn = userOf(await resolved(tokenB, "/production"));
    assert.ok(uBOn.modules?.includes("production"), "bật module ⇒ /production mở NGAY ở lần dựng kế tiếp, không deploy");
    assert.equal(can(uBOn, "production:write"), true, "module bật ⇒ ADMIN lại vượt mọi kiểm QUYỀN như cũ");
    assert.equal(can(uBOn, "platform:operate"), false, "bật module nào cũng không cho tổ chức khác quyền vận hành nền tảng");

    // Tổ chức bị đình chỉ ⇒ ORG_INACTIVE, không rơi về nhà; apiGuard 403 đúng mã.
    await pdb.update(schema.platformOrganizations).set({ status: "SUSPENDED" }).where(eq(schema.platformOrganizations.code, B));
    invalidateOrganizations();
    assert.deepEqual(await resolved(tokenB, "/orders"), { denied: "ORG_INACTIVE" });
    const g6 = await asRequest(tokenB, "/orders", () => apiGuard());
    assert.ok(g6 instanceof Response && g6.status === 403 && (await bodyOf(g6)).code === "ORG_INACTIVE");
    assert.equal(await asRequest(tokenB, "/orders", () => redirectTarget(() => requireUser())), `/login?reason=${DENY_REASON_PARAM.ORG_INACTIVE}`);
    assert.ok(loginShouldStay(DENY_REASON_PARAM.ORG_INACTIVE) && DENY_REASON_MESSAGE[DENY_REASON_PARAM.ORG_INACTIVE], "/login giữ người dùng lại và nói lý do");
    const khoaDinhChi = await verifyLogin({ email: EMAIL_CHUNG, password: MK_B, orgCode: B }, async () => assert.fail("không được cấp phiên cho tổ chức bị đình chỉ"));
    assert.deepEqual(khoaDinhChi, { ok: false, code: "BAD_CREDENTIALS", error: LOGIN_BAD_CREDENTIALS }, "đăng nhập vào tổ chức đình chỉ ⇒ cùng câu với sai mật khẩu");
    await pdb.update(schema.platformOrganizations).set({ status: "ACTIVE" }).where(eq(schema.platformOrganizations.code, B));
    invalidateOrganizations();
    assert.equal((await findOrganization(B))?.status, "ACTIVE");

    // ═══════════ (e) ĐĂNG NHẬP THEO TỔ CHỨC ═══════════
    assert.equal(await loginOrgCode(""), home.code, "bỏ trống mã tổ chức ⇒ tổ chức nhà");
    assert.equal(await loginOrgCode("  PR-RBAC "), B);
    const khongCap = async () => assert.fail("sai thông tin thì không được cấp phiên");
    const saiMk = await verifyLogin({ email: EMAIL_CHUNG, password: "sai-mat-khau", orgCode: B }, khongCap);
    const saiMa = await verifyLogin({ email: EMAIL_CHUNG, password: MK_B, orgCode: "pr-khong-ton-tai" }, khongCap);
    assert.equal(saiMk.ok, false);
    assert.deepEqual(saiMa, saiMk, "mã tổ chức sai và mật khẩu sai ra CÙNG một kết quả — không dò được mã tổ chức");

    let cap: SessionSubject | null = null;
    const vaoB = await verifyLogin({ email: EMAIL_CHUNG, password: MK_B, orgCode: B }, async (s) => {
      cap = s;
    });
    assert.ok(vaoB.ok && cap, "đúng mật khẩu của B ở mã B ⇒ vào");
    const capB = cap as SessionSubject;
    assert.equal(capB.orgCode, B);
    assert.equal(capB.id, bTwin.id, "sub là id của người trong CSDL B");
    assert.equal(decodeJwt(await signSession(capB))[SESSION_ORG_CLAIM], B, "token phát ra mang org = B");
    assert.equal((await verifyLogin({ email: EMAIL_CHUNG, password: MK_NHA, orgCode: B }, khongCap)).ok, false, "mật khẩu của nhà KHÔNG mở tài khoản trùng email ở B");
    assert.equal((await verifyLogin({ email: EMAIL_CHUNG, password: MK_B, orgCode: home.code }, khongCap)).ok, false, "mật khẩu của B KHÔNG mở tài khoản trùng email ở nhà");
    const vaoNha = await verifyLogin({ email: EMAIL_CHUNG, password: MK_NHA, orgCode: home.code }, async () => {});
    assert.ok(vaoNha.ok && vaoNha.subject.id === HOME_TWIN_ID && vaoNha.subject.orgCode === home.code, "mỗi mã tổ chức chỉ nhận mật khẩu của chính nó");

    // Nhật ký đăng nhập nằm trong CSDL của tổ chức được đăng nhập, không phải CSDL nhà.
    const logB = await withOrganization(B, async () => (await getDb()).select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "LOGIN"), eq(schema.auditLogs.entityId, bTwin.id))));
    assert.equal(logB.length, 1, "vết LOGIN của người B ghi vào CSDL B");
    const logNha = await homeDb.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "LOGIN"), eq(schema.auditLogs.entityId, bTwin.id)));
    assert.equal(logNha.length, 0, "CSDL nhà không có vết đăng nhập của người B");

    // ISO-19: dò ở tổ chức A không khoá cùng email ở tổ chức B; khoá IP vẫn toàn cục.
    resetLoginThrottle();
    const ip = "198.51.100.23";
    for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i++) recordLoginFailure(loginThrottleKeys(EMAIL_CHUNG, ip, home.code), 1_000 + i);
    assert.equal(loginAllowed(loginThrottleKeys(EMAIL_CHUNG, ip, home.code), 2_000).ok, false, "cặp ở nhà bị khoá");
    assert.equal(loginAllowed(loginThrottleKeys(EMAIL_CHUNG, ip, B), 2_000).ok, true, "cùng email, cùng IP ở tổ chức B vẫn đăng nhập được");
    assert.equal(loginThrottleKeys(EMAIL_CHUNG, ip, B)[1], loginThrottleKeys(EMAIL_CHUNG, ip, home.code)[1], "khoá ip: giữ toàn cục");
    resetLoginThrottle();

    // ═══════════ QUYỀN NỀN TẢNG KHÔNG TỰ CẤP CHO DANH SÁCH QUYỀN LƯU TỪ TRƯỚC ═══════════
    const platformKeys = ["modules:manage", "platform:operate"];
    for (const k of platformKeys) {
      assert.ok((ALL_PERMISSIONS as string[]).includes(k), `${k} là khoá quyền có thật`);
      assert.ok(!PERMISSIONS_ADDED_AFTER_SNAPSHOT.includes(k), `${k} không được tự cấp cho danh sách lưu trước ảnh chụp`);
      assert.ok(ROLE_BUILDER_FORBIDDEN.includes(k), `${k}: vai trò tuỳ chỉnh không cấp được`);
    }
    // Người có danh sách quyền riêng lưu TRƯỚC khi hai khoá tồn tại (có hoặc không có ảnh chụp), dưới
    // mẫu vai trò mặc định LẪN một bản ghi đè cũ trong `settings` (cũng lưu trước khi hai khoá tồn tại).
    const custom = ["dashboard:view", "orders:read"];
    const knownBefore = (ALL_PERMISSIONS as string[]).filter((p) => !platformKeys.includes(p));
    for (const role of ["MANAGER", "LEADER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"] as const) {
      for (const known of [null, knownBefore]) {
        for (const templates of [null, { [role]: knownBefore }]) {
          const perms = resolvePermissions(role, custom, templates, known);
          for (const k of platformKeys) assert.ok(!perms.includes(k), `${role} (ảnh chụp: ${known ? "có" : "không"}, ghi đè mẫu: ${templates ? "có" : "không"}): ${k} không được tự cấp`);
        }
      }
      for (const k of platformKeys) assert.ok(!resolvePermissions(role, null).includes(k), `${role}: mẫu mặc định không có ${k}`);
    }
  } catch (error) {
    failure = error;
  }
  // Dọn LUÔN chạy, nhưng lỗi dọn không được che lỗi thật của bài kiểm (nếu có).
  try {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    resetLoginThrottle();
    const homeDb = await getDb();
    await homeDb.delete(schema.auditLogs).where(like(schema.auditLogs.entityId, "pr-home-%"));
    await homeDb.delete(schema.users).where(like(schema.users.id, "pr-home-%"));
    await pdb.update(schema.platformOrganizations).set({ status: "ARCHIVED" }).where(eq(schema.platformOrganizations.code, B));
    invalidateOrganizations();
    rmSync(dir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[platform-rbac] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
  console.log("✓ Nền tảng · phiên & RBAC: claim org ký vào và sống qua gia hạn · id chéo tổ chức không đăng nhập được · cổng module theo đường dẫn + khoá quyền (ADMIN không vượt) · platform:operate chỉ tổ chức nhà · đăng nhập theo tổ chức, mã sai = mật khẩu sai");
}
