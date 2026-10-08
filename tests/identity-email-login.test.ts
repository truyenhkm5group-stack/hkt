/**
 * ═══════════ KHÁCH DO ADMIN TẠO ĐĂNG NHẬP BẰNG EMAIL + MẬT KHẨU (P0 `saas-identity-email-login`, 08/10/2026) ═══════════
 *
 * Lỗi đo thật (docs/saas/FINISH_LINE_2026-10-08.md blocker 1): người vận hành tạo khách ở `/platform/customers` → job cấp phát tạo
 * quản trị trong CSDL tổ chức → khách mở liên kết kích hoạt, đặt mật khẩu → `/login` báo «Email / số điện thoại hoặc mật khẩu không
 * đúng.» cho tới khi gõ «mã tổ chức». Gốc: chỉ mục danh tính (email ⇒ tổ chức) chỉ được ghi SAU lần đăng nhập thành công đầu tiên —
 * mà lần đầu ấy lại cần chỉ mục.
 *
 * Bài này đi ĐÚNG đường của request thật: `loginAction` / `logoutAction` (server action) chạy trong một phạm vi request dựng tay của
 * Next (work store + request store — như tests/tenant-attack.test.ts) để `headers()` / `cookies()` / `redirect()` chạy như trong ứng
 * dụng; phiên đọc lại qua `resolveCurrentUser` / `currentOrganization` bằng đúng cookie vừa ghi.
 *
 *  A. Admin tạo khách EXTERNAL mới (job) ⇒ chỉ mục có NGAY, chưa «đã dùng» (không mở đường Google / Facebook, không tính «đã đăng nhập»).
 *  B. Khách mở liên kết kích hoạt (chỉ tra, không tiêu mã).  C. Đặt mật khẩu ⇒ chỉ mục vẫn đúng một dòng, trạng thái «Đã kích hoạt».
 *  D. Đăng nhập EMAIL + MẬT KHẨU, KHÔNG mã tổ chức ⇒ vào thẳng vỏ khách.  E. Đúng workspace (claim + CSDL).
 *  F. Không vào được workspace khác (mã B · token giả `org = B` · CSDL B).  G. Đăng xuất rồi đăng nhập lại.
 *  H. Đặt lại mật khẩu ⇒ mật khẩu mới vào được, cũ hết, phiên cũ bị thu hồi, dấu «đã dùng» không mất.
 *  I. Chạy lại cấp phát (cùng khoá · chạy lại job · provisionOrganization lần hai · khoá mới trên workspace đã có) ⇒ không nhân đôi
 *     danh tính / tài khoản / thành viên, không phát liên kết kích hoạt cho người đã kích hoạt.
 *  + Gửi lại kích hoạt: chỉ người vận hành, lý do bắt buộc, thu hồi liên kết cũ, chỉ băm trong CSDL, nhật ký nền tảng; đặt xong ⇒ chỉ
 *    mục có lại kể cả khi đã mất. + Email trùng hai tổ chức ⇒ chọn cửa hàng TẤT ĐỊNH, mật khẩu sai không lộ tổ chức nào. + Người nhà /
 *    đường «mã tổ chức» không đổi. + Tạo hộ / nhận lời mời ⇒ chỉ mục có. + Đối chiếu dữ liệu cũ: chạy thử không ghi, ghi bù idempotent.
 *
 * Tổ chức THẬT `iel-*` (tự cấp, tự dọn); mốc thời gian theo đồng hồ thật (AGENTS 50 · 65) — chỗ duy nhất phải đợi là mốc thu hồi
 * phiên làm tròn LÊN giây kế tiếp sau mỗi lượt đặt mật khẩu (lib/constants/session-revocation.ts), đọc thẳng từ CSDL.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { RequestCookies, ResponseCookies } from "next/dist/server/web/spec-extension/cookies";
import { getDb, getPlatformDb, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import { loginAction, logoutAction } from "@/lib/actions/auth";
import { findIdentity } from "@/lib/auth/identities";
import { credentialsMatch, LOGIN_BAD_CREDENTIALS, loginCandidates } from "@/lib/auth/login";
import { hashPassword } from "@/lib/auth/password";
import { resolveCurrentUser, signSession, type SessionUser } from "@/lib/auth/session";
import { resolveSocial } from "@/lib/auth/social";
import { SALES_AGENT_INBOX_HREF } from "@/lib/constants/saas-nav";
import { SESSION_COOKIE } from "@/lib/constants/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization, setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { compareOrgIdentities, maskIdentity, planIdentityReconcile, runIdentityReconcile } from "@/lib/platform/identity-reconcile";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { activationStateOf, jobAdminEmail, loadWorkspaceActivation } from "@/lib/saas/activation";
import { createCustomerAsOperator, loadCustomerDetail, resendActivationAsOperator } from "@/lib/saas/console";
import { workspaceReach } from "@/lib/saas/customers";
import { retryJob } from "@/lib/saas/provisioning";
import { createUserCore } from "@/lib/users/create-user";
import { acceptUserInviteCore, createUserInviteCore } from "@/lib/users/invites";
import { completePasswordResetCore, createResetLinkAsOperator, hashResetToken, lookupResetToken } from "@/lib/users/password-reset";
import { PASSWORD_RESET_INVALID } from "@/lib/users/password-reset-shared";
import { parseReconcileArgs } from "@/scripts/identity-reconcile";

const A = "iel-shop-a";
const B = "iel-shop-b";
const C = "iel-shop-c";
const R = "iel-shop-r";
const ORGS = [A, B, C, R] as const;
const ADMIN_EMAIL = "chu@iel-shop-a.vn";
const B_ADMIN = "admin@iel-shop-b.vn";
const R_ADMIN = "chu@iel-shop-r.vn";
const HOME_EMAIL = "iel-nha@nha.local";
const PW1 = "KichHoat@2026a";
const PW2 = "DatLai@2026bcd";
const PW3 = "RiengC@2026xyz";
const LEGACY_PW = "TaiKhoanCu@2026";

let ipSeq = 0;
/** Mỗi lượt một IP riêng: bộ chặn dò đếm theo (email, IP) và theo IP — bài này không đo nó, chỉ không được vấp vào nó. */
const nextIp = () => `198.51.100.${(ipSeq += 1) + 100}`;
const tokenOf = (link: string) => decodeURIComponent(link.split("/").pop() ?? "");

// ─────────────────────────── một lượt server action «như request thật» ───────────────────────────

const NEXT_STORES = [workAsyncStorage, workUnitAsyncStorage] as unknown as Record<string, unknown>[];
const ALS_METHODS = ["run", "getStore", "exit", "enterWith", "disable"] as const;
function installRealStores() {
  for (const store of NEXT_STORES) {
    if (store instanceof AsyncLocalStorage || Object.prototype.hasOwnProperty.call(store, "run")) continue;
    const real = new AsyncLocalStorage<unknown>() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ALS_METHODS) store[m] = real[m].bind(real);
  }
}
function removeRealStores() {
  for (const store of NEXT_STORES) if (!(store instanceof AsyncLocalStorage)) for (const m of ALS_METHODS) delete store[m];
}

type Ran = { value: unknown; redirectTo: string | null; cookie: string | undefined };

/** Chạy một server action trong phạm vi request: cookie phiên (nếu có) ở hũ cookie của lượt action, kết quả + chuyển hướng + cookie sau. */
async function asAction(fn: () => Promise<unknown>, opts: { cookie?: string } = {}): Promise<Ran> {
  const jar = new ResponseCookies(new Headers());
  if (opts.cookie) jar.set(SESSION_COOKIE, opts.cookie);
  const workStore = { route: "/login", page: "/login", incrementalCache: {}, isStaticGeneration: false, forceStatic: false, dynamicShouldError: false, pendingRevalidatedTags: [] as string[] };
  const requestStore = {
    type: "request",
    phase: "action",
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    url: { pathname: "/login", search: "" },
    headers: new Headers({ "x-forwarded-for": nextIp() }),
    cookies: new RequestCookies(new Headers()),
    mutableCookies: new ResponseCookies(new Headers()),
    userspaceMutableCookies: jar,
    draftMode: { isEnabled: false },
  };
  setSessionTokenSourceForTests(null);
  try {
    const value = await workAsyncStorage.run(workStore as unknown as Parameters<typeof workAsyncStorage.run>[0], () =>
      workUnitAsyncStorage.run(requestStore as unknown as Parameters<typeof workUnitAsyncStorage.run>[0], fn),
    );
    return { value, redirectTo: null, cookie: jar.get(SESSION_COOKIE)?.value };
  } catch (error) {
    const digest = error && typeof error === "object" && "digest" in error ? String((error as { digest: unknown }).digest) : "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw error;
    return { value: undefined, redirectTo: digest.split(";")[2] ?? null, cookie: jar.get(SESSION_COOKIE)?.value };
  }
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** Đăng nhập ở màn chung: KHÔNG có ô `org` trừ khi truyền (đường phụ «mã tổ chức» / bước chọn cửa hàng). */
const login = (email: string, password: string, org?: string) => asAction(() => loginAction(undefined, form({ email, password, next: "/", ...(org ? { org } : {}) })));

/** Người + tổ chức của một token — qua ĐÚNG đường dựng phiên của request thật. */
async function whoIs(token: string | undefined): Promise<{ denied: string | null; userId: string | null; orgCode: string | null; ctx: string | null }> {
  assert.ok(token, "phải có cookie phiên");
  setSessionTokenSourceForTests(async () => token);
  try {
    const ket = await resolveCurrentUser();
    if (!("user" in ket)) return { denied: ket.denied, userId: null, orgCode: null, ctx: null };
    return { denied: null, userId: ket.user.id, orgCode: ket.user.organization?.code ?? null, ctx: (await currentOrganization()).code };
  } finally {
    setSessionTokenSourceForTests(null);
  }
}

/** Mốc thu hồi phiên làm tròn LÊN giây kế tiếp: đăng nhập trong cùng giây với lượt đặt mật khẩu thì phiên mới sinh ra đã chết. */
async function waitPastRevocation(orgCode: string, email: string) {
  const row = await withOrganization(orgCode, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, email), columns: { sessionInvalidBefore: true } }));
  const wait = (row?.sessionInvalidBefore?.getTime() ?? 0) - Date.now() + 30;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function identityRows(orgCode: string, value?: string) {
  const pdb = await getPlatformDb();
  const t = schema.platformIdentities;
  return pdb.select().from(t).where(value ? and(eq(t.orgCode, orgCode), eq(t.value, value)) : eq(t.orgCode, orgCode));
}

async function userOf(orgCode: string, email: string) {
  return withOrganization(orgCode, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, email) }));
}

const reset = (org: string, token: string, password: string) => completePasswordResetCore(org, token, { password, confirmPassword: password }, { ip: nextIp() });

function operatorOf(home: { code: string; name: string }): SessionUser {
  return { id: "iel-op", email: "iel-op@nha.local", name: "Vận hành IEL", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const codes = [...ORGS];
  await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, codes));
  await pdb.delete(schema.platformProvisioningJobs).where(like(schema.platformProvisioningJobs.idempotencyKey, "iel-%"));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, codes));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, codes));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, codes));
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, codes));
  for (const code of codes) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, code));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    await releaseOrganizationDb(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  const accts = (await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts).where(like(schema.platformAccounts.code, "iel-acct-%"))).map((a) => a.id);
  if (accts.length) {
    await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.accountId, accts));
    await pdb.delete(schema.platformAccounts).where(inArray(schema.platformAccounts.id, accts));
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, codes));
  // Người nhà của bài này (đăng nhập không mã ở nhà): dòng users + chỉ mục + nhật ký đăng nhập.
  const db = await getDb();
  const homeUser = await db.query.users.findFirst({ where: eq(schema.users.email, HOME_EMAIL), columns: { id: true } });
  if (homeUser) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, homeUser.id));
    await db.delete(schema.users).where(eq(schema.users.id, homeUser.id));
  }
  await pdb.delete(schema.platformIdentities).where(eq(schema.platformIdentities.value, HOME_EMAIL));
  invalidateOrganizations();
  invalidateCapabilities();
}

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  const t = (iso: string) => new Date(iso);
  const now = t("2026-10-08T10:00:00Z");
  const tok = (created: string, expires: string, used: string | null = null, revoked: string | null = null) => ({ createdAt: t(created), expiresAt: t(expires), usedAt: used ? t(used) : null, revokedAt: revoked ? t(revoked) : null });
  const on = { active: true, lastLoginAt: null };
  assert.equal(activationStateOf(null, [], now).state, "NO_ADMIN");
  assert.equal(activationStateOf({ active: false, lastLoginAt: null }, [tok("2026-10-08T09:00:00Z", "2026-10-09T09:00:00Z")], now).state, "DISABLED", "khoá thắng mọi thứ — đăng nhập không mở được");
  assert.equal(activationStateOf(on, [], now).state, "NO_LINK");
  const pending = activationStateOf(on, [tok("2026-10-08T09:00:00Z", "2026-10-09T09:00:00Z")], now);
  assert.equal(pending.state, "PENDING");
  assert.equal(pending.linkExpiresAt, "2026-10-09T09:00:00.000Z");
  assert.equal(activationStateOf(on, [tok("2026-10-06T09:00:00Z", "2026-10-07T09:00:00Z")], now).state, "EXPIRED");
  assert.equal(activationStateOf(on, [tok("2026-10-07T09:00:00Z", "2026-10-08T09:00:00Z", null, "2026-10-07T10:00:00Z")], now).state, "NO_LINK", "liên kết mới nhất đã bị thu hồi ⇒ không còn liên kết dùng được");
  // Liên kết MỚI NHẤT quyết định (phát mới thu hồi cũ) — thứ tự trong mảng không quan trọng.
  assert.equal(activationStateOf(on, [tok("2026-10-08T09:00:00Z", "2026-10-09T09:00:00Z"), tok("2026-10-05T09:00:00Z", "2026-10-06T09:00:00Z", null, "2026-10-08T09:00:00Z")], now).state, "PENDING");
  const used = activationStateOf(on, [tok("2026-10-07T09:00:00Z", "2026-10-08T09:00:00Z", "2026-10-07T09:30:00Z"), tok("2026-10-08T09:00:00Z", "2026-10-09T09:00:00Z")], now);
  assert.equal(used.state, "ACTIVATED", "đã dùng một liên kết ⇒ đã kích hoạt, kể cả khi có liên kết mới hơn chưa dùng");
  assert.equal(used.activatedAt, "2026-10-07T09:30:00.000Z");
  assert.equal(activationStateOf({ active: true, lastLoginAt: t("2026-10-01T00:00:00Z") }, [], now).state, "ACTIVATED", "đã đăng nhập ⇒ vào được");

  // Quản trị theo job: job SỚM NHẤT có bước ADMIN xong; lượt «Tạo khách» sau trên workspace đã có bị từ chối trước bước ADMIN.
  const job = (email: string, created: string, steps: { key: string; status: string }[]) => ({ orgCode: "x", input: { admin: { email } }, steps, createdAt: t(created) });
  const creator = job("Chu@X.vn ", "2026-10-01T00:00:00Z", [{ key: "WORKSPACE", status: "DONE" }, { key: "ADMIN", status: "DONE" }]);
  const hijack = job("la@x.vn", "2026-10-02T00:00:00Z", [{ key: "WORKSPACE", status: "FAILED" }]);
  assert.deepEqual(jobAdminEmail([hijack, creator], "x"), { created: "chu@x.vn", fallback: "chu@x.vn" });
  assert.deepEqual(jobAdminEmail([hijack], "x"), { created: null, fallback: "la@x.vn" }, "không job nào tạo quản trị ⇒ tra quản trị đầu tiên trong CSDL; email job chỉ để hiện");
  assert.deepEqual(jobAdminEmail([creator], "y"), { created: null, fallback: null });

  // Đối chiếu một tổ chức (thuần): đủ điều kiện / thiếu / lệch / mồ côi / bỏ qua.
  const HASH = `$2a$10$${"a".repeat(53)}`;
  const users = [
    { id: "u1", email: "a@x.vn", phone: "84912345678", active: true, passwordHash: HASH },
    { id: "u2", email: "b@x.vn", phone: null, active: true, passwordHash: HASH },
    { id: "u3", email: "c@x.vn", phone: null, active: false, passwordHash: HASH },
    { id: "u4", email: "d@x.vn", phone: null, active: true, passwordHash: "x" },
    { id: "u5", email: "E@x.vn", phone: null, active: true, passwordHash: HASH },
  ];
  const index = [
    { kind: "EMAIL", value: "a@x.vn", userId: "u1" },
    { kind: "EMAIL", value: "b@x.vn", userId: "u9" },
    { kind: "EMAIL", value: "z@x.vn", userId: "u8" },
  ];
  const r = compareOrgIdentities({ code: "x", status: "ACTIVE", isHome: false }, users, index);
  assert.equal(r.eligible, 2);
  assert.deepEqual(r.skipped, { inactive: 1, noPassword: 1, emailNotNormalized: 1 });
  assert.equal(r.ok, 1);
  assert.deepEqual(r.gaps.map((g) => `${g.kind}:${g.value}:${g.userId}:${g.state}`).sort(), ["EMAIL:b@x.vn:u2:STALE", "PHONE:84912345678:u1:MISSING"]);
  assert.equal(r.orphans, 2, "dòng trỏ tài khoản không còn (u8, u9) chỉ ĐẾM");
  assert.equal(maskIdentity("EMAIL", "chu@iel-shop-a.vn"), "c***@iel-shop-a.vn");
  assert.equal(maskIdentity("PHONE", "84912345678"), "8491****78");

  // Ô arg của ops: rỗng / mã / --apply; cờ lạ, thừa, mã sai dạng ⇒ lỗi cách dùng (không đoán).
  assert.deepEqual(parseReconcileArgs([]), { ok: true, apply: false, orgCode: null });
  assert.deepEqual(parseReconcileArgs(["--apply"]), { ok: true, apply: true, orgCode: null });
  assert.deepEqual(parseReconcileArgs(["hslc-hmt-shop"]), { ok: true, apply: false, orgCode: "hslc-hmt-shop" });
  assert.deepEqual(parseReconcileArgs(["hslc-hmt-shop", "--apply"]), { ok: true, apply: true, orgCode: "hslc-hmt-shop" });
  for (const bad of [["--force"], ["--apply", "--apply"], ["a-1", "b-2"], ["HSLC"], ["--apply=1"]]) assert.equal(parseReconcileArgs(bad).ok, false, JSON.stringify(bad));
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

function testSource() {
  // Phép khớp EMAIL của Google / Facebook chỉ nhận dòng ĐÃ dùng để đăng nhập — chỉ mục ghi lúc cấp phát không mở đường vào không mật khẩu.
  assert.match(readFileSync("lib/auth/social.ts", "utf8"), /findIdentity\("EMAIL", profile\.email, \{ usedOnly: true \}\)/);
  // Mọi đường chèn `users` trong mã ứng dụng ghi chỉ mục qua MỘT hàm — hoặc khai miễn trừ kèm lý do.
  const MIEN_TRU: Record<string, string> = {
    "lib/auth/bootstrap.ts": "Quản trị đầu tiên của tổ chức NHÀ lúc khởi động — nhà luôn là ứng viên của trang đăng nhập chung (`loginCandidates`), không cần chỉ mục.",
  };
  const files = execFileSync("git", ["ls-files", "lib", "app"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
  const pham: string[] = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/\.insert\(schema\.users\)|\binsertUserAccount\(/.test(src)) continue;
    seen += 1;
    if (MIEN_TRU[f]) continue;
    if (!/\b(indexAccountIdentities|indexNewUserAccount|indexAccountInCurrentOrganization)\(/.test(src)) pham.push(f);
  }
  assert.deepEqual(pham, [], "tệp tạo tài khoản mà không ghi chỉ mục đăng nhập ⇒ người mới chỉ vào được khi gõ «mã tổ chức» (P0 08/10/2026)");
  assert.ok(seen >= 4, `phải thấy các đường tạo tài khoản đã biết (cấp phát, tạo hộ, lời mời, khởi động) — mới thấy ${seen}`);
  // Trang khách thêm ĐÚNG một dòng; component là client, chỉ nhập KIỂU từ lõi máy chủ.
  const page = readFileSync("app/(dashboard)/platform/customers/[code]/page.tsx", "utf8");
  assert.equal(page.match(/<ResendActivation\b/g)?.length, 1);
  const comp = readFileSync("components/platform/resend-activation.tsx", "utf8");
  assert.ok(comp.startsWith('"use client"'));
  assert.ok(/import type \{[^}]*\} from "@\/lib\/saas\/activation"/.test(comp) && !/import \{[^}]*\} from "@\/lib\/saas\/activation"/.test(comp), "client chỉ nhập kiểu từ lib/saas/activation");
  // Ops: chạy thử mặc định, kết quả mã hoá, cùng lớp đọc nặng; `--apply` tự sang lớp GHI.
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bidentity-reconcile\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bidentity-reconcile\b/);
  assert.match(ops, /ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/identity-reconcile\.ts/);
}

// ═══════════ 3 · CSDL THẬT ═══════════

async function testCustomerFlow(op: SessionUser, home: { code: string }) {
  // ── A · Admin tạo khách EXTERNAL mới qua job ──
  const created = await createCustomerAsOperator(op, {
    account: { code: "iel-acct-a", name: "Khách IEL A", accountType: "EXTERNAL" },
    workspace: { code: A, name: "Shop IEL A", planKey: "starter", brand: "chotdon" },
    products: ["chotdon"],
    admin: { email: "Chu@IEL-Shop-A.vn", name: "Chủ A" },
    idempotencyKey: "iel-create-a",
    reason: "Bài kiểm đăng nhập bằng email",
  });
  assert.ok("ok" in created && created.status === "SUCCEEDED", JSON.stringify(created));
  assert.ok(created.activationLink?.includes(`/reset/${A}/`), "quản trị nhận liên kết kích hoạt dùng một lần");
  const admin = await userOf(A, ADMIN_EMAIL);
  assert.ok(admin && admin.role === "ADMIN", "quản trị nằm trong CSDL của CHÍNH workspace");
  const rowsA = await identityRows(A, ADMIN_EMAIL);
  assert.equal(rowsA.length, 1, "cấp phát ghi chỉ mục NGAY — không đợi lần đăng nhập đầu");
  assert.equal(rowsA[0].userId, admin.id);
  assert.equal(rowsA[0].kind, "EMAIL");
  assert.equal(rowsA[0].lastUsedAt, null, "chưa ai đăng nhập ⇒ chưa có mốc dùng");
  assert.deepEqual(await loginCandidates("Chu@IEL-shop-a.vn"), [A, home.code], "trang chung tìm ra workspace từ email");
  assert.equal((await workspaceReach([A])).get(A)?.identities, 0, "«Người đã đăng nhập» không đếm quản trị chưa kích hoạt");
  assert.deepEqual(await resolveSocial({ provider: "google", subject: "g-iel-1", email: ADMIN_EMAIL, name: null }), { kind: "SIGNUP" }, "email do người vận hành gõ KHÔNG mở đường Google vào tài khoản chưa ai dùng");
  const detail = await loadCustomerDetail(op, "iel-acct-a");
  assert.ok(detail && !("error" in detail));
  const act0 = detail.activation[A];
  assert.ok(act0 && act0.state === "PENDING" && act0.email === ADMIN_EMAIL && act0.source === "JOB" && act0.canResend, JSON.stringify(act0));

  // ── B · Khách mở liên kết (chỉ tra, không tiêu mã) ──
  const token1 = tokenOf(created.activationLink!);
  for (let i = 0; i < 2; i++) {
    const look = await lookupResetToken(A, token1, { ip: nextIp() });
    assert.ok(look.ok && look.email === ADMIN_EMAIL && look.orgCode === A, JSON.stringify(look));
  }

  // ── C · Khách đặt mật khẩu ──
  assert.ok("ok" in (await reset(A, token1, PW1)));
  const rowsC = await identityRows(A, ADMIN_EMAIL);
  assert.equal(rowsC.length, 1, "đặt mật khẩu bảo đảm chỉ mục — idempotent, vẫn MỘT dòng");
  assert.equal(rowsC[0].lastUsedAt, null, "đặt mật khẩu không phải một lượt đăng nhập");
  const act1 = await loadWorkspaceActivation(A);
  assert.ok(act1?.state === "ACTIVATED" && !act1.canResend, JSON.stringify(act1));

  // ── D · Đăng nhập EMAIL + MẬT KHẨU, KHÔNG mã tổ chức ──
  await waitPastRevocation(A, ADMIN_EMAIL);
  const d = await login("Chu@IEL-Shop-A.vn", PW1);
  assert.equal(d.value, undefined, `đăng nhập không mã tổ chức phải vào được — nhận ${JSON.stringify(d.value)}`);
  assert.equal(d.redirectTo, SALES_AGENT_INBOX_HREF, "khách Chốt Đơn vào thẳng vỏ khách");
  assert.ok(d.cookie, "cookie phiên được ghi");
  const usedRow = (await identityRows(A, ADMIN_EMAIL))[0];
  assert.ok(usedRow.lastUsedAt, "đăng nhập ghi mốc dùng");
  assert.equal((await workspaceReach([A])).get(A)?.identities, 1, "giờ mới tính là «đã đăng nhập»");
  const viaGoogle = await resolveSocial({ provider: "google", subject: "g-iel-1", email: ADMIN_EMAIL, name: null });
  assert.ok(viaGoogle.kind === "LOGIN" && viaGoogle.hit.orgCode === A, "đã từng vào bằng mật khẩu ⇒ phạm vi Google như trước bản vá");

  // ── E · Đúng workspace ──
  const e = await whoIs(d.cookie);
  assert.equal(e.denied, null);
  assert.equal(e.orgCode, A);
  assert.equal(e.ctx, A, "CSDL của phiên = CSDL của workspace khách");
  assert.equal(e.userId, admin.id);
  assert.ok((await userOf(A, ADMIN_EMAIL))?.lastLoginAt, "lần đăng nhập ghi vào CSDL của workspace");

  // ── F · Không vào được workspace khác ──
  const intoB = await login(ADMIN_EMAIL, PW1, B);
  assert.deepEqual(intoB.value, { error: LOGIN_BAD_CREDENTIALS }, "gõ mã B bằng tài khoản của A ⇒ đúng câu sai mật khẩu");
  assert.equal(intoB.cookie, undefined, "không cookie nào được ghi");
  const forged = await signSession({ id: admin.id, email: ADMIN_EMAIL, name: admin.name, role: "ADMIN", orgCode: B });
  assert.equal((await whoIs(forged)).denied, "NOT_FOUND", "token ký đúng nhưng org = B ⇒ tài khoản của A không tồn tại ở B");
  assert.ok(!(await loginCandidates(ADMIN_EMAIL)).includes(B));
  assert.equal(await userOf(B, ADMIN_EMAIL), undefined);
  setSessionTokenSourceForTests(async () => d.cookie);
  try {
    assert.equal(await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, B_ADMIN) }), undefined, "phiên của A chỉ thấy CSDL của A");
  } finally {
    setSessionTokenSourceForTests(null);
  }

  // ── G · Đăng xuất, đăng nhập lại ──
  const out = await asAction(() => logoutAction(), { cookie: d.cookie });
  assert.equal(out.redirectTo, "/login");
  assert.equal(out.cookie, "", "cookie phiên bị xoá");
  const g = await login(ADMIN_EMAIL, PW1);
  assert.ok(g.redirectTo && g.cookie, JSON.stringify(g.value));
  assert.equal((await whoIs(g.cookie)).orgCode, A);

  // ── H · Đặt lại mật khẩu ──
  const relink = await createResetLinkAsOperator(op, { orgCode: A, email: ADMIN_EMAIL, reason: "Khách gọi báo quên mật khẩu (bài kiểm)" });
  assert.ok("ok" in relink, JSON.stringify(relink));
  assert.ok("ok" in (await reset(A, tokenOf(relink.link), PW2)));
  const rowH = await identityRows(A, ADMIN_EMAIL);
  assert.equal(rowH.length, 1);
  assert.ok(rowH[0].lastUsedAt, "đặt lại (chỉ ghi chỉ mục) KHÔNG xoá dấu «đã đăng nhập» của cùng tài khoản");
  await waitPastRevocation(A, ADMIN_EMAIL);
  assert.equal((await whoIs(g.cookie)).denied, "REVOKED", "đặt lại thu hồi phiên cũ");
  const h = await login(ADMIN_EMAIL, PW2);
  assert.ok(h.redirectTo && h.cookie, `mật khẩu mới vào được — ${JSON.stringify(h.value)}`);
  assert.equal((await whoIs(h.cookie)).orgCode, A);
  assert.deepEqual((await login(ADMIN_EMAIL, PW1)).value, { error: LOGIN_BAD_CREDENTIALS }, "mật khẩu cũ hết dùng");

  // ── I · Chạy lại cấp phát không nhân đôi gì ──
  const again = await createCustomerAsOperator(op, {
    account: { code: "iel-acct-a", name: "Khách IEL A", accountType: "EXTERNAL" },
    workspace: { code: A, name: "Shop IEL A", planKey: "starter", brand: "chotdon" },
    products: ["chotdon"],
    admin: { email: ADMIN_EMAIL, name: "Chủ A" },
    idempotencyKey: "iel-create-a",
    reason: "Bấm gửi lại form",
  });
  assert.ok("ok" in again && again.jobId === created.jobId, "cùng khoá ⇒ cùng job");
  assert.equal(again.activationLink, null, "quản trị đã kích hoạt ⇒ gửi lại form KHÔNG phát liên kết (đó sẽ là liên kết đặt lại mật khẩu)");
  assert.match(again.message, /đã kích hoạt/);
  const retried = await retryJob(created.jobId, { actor: null, email: null, source: "TEST" });
  assert.ok("error" in retried && /đã xong/.test(retried.error), "job đã xong không chạy lại");
  const hijack = await createCustomerAsOperator(op, { account: { code: "iel-acct-a", name: "Khách IEL A", accountType: "EXTERNAL" }, workspace: { code: A, name: "Shop IEL A", planKey: "starter", brand: "chotdon" }, products: ["chotdon"], admin: { email: "la@iel-shop-a.vn", name: "Người lạ" }, idempotencyKey: "iel-create-a-2", reason: "Khoá mới trên workspace đã có" });
  assert.ok(!("ok" in hijack) || hijack.status !== "SUCCEEDED");
  assert.equal(await userOf(A, "la@iel-shop-a.vn"), undefined);
  assert.equal((await findIdentity("EMAIL", "la@iel-shop-a.vn")).length, 0);
  const rerun = await provisionOrganization({ code: A, name: "Shop IEL A", modules: ["customers"], admin: { email: ADMIN_EMAIL, name: "Chủ A lần hai", password: "KhacHan@2026xy" }, source: "TEST", actor: null });
  assert.equal(rerun.created, false);
  assert.equal(rerun.adminCreated, false);
  assert.equal(await credentialsMatch({ email: ADMIN_EMAIL, password: PW2, orgCode: A }), true, "chạy lại không đổi mật khẩu khách đã đặt");
  assert.equal(await credentialsMatch({ email: ADMIN_EMAIL, password: "KhacHan@2026xy", orgCode: A }), false);
  const users = await withOrganization(A, async () => (await getDb()).select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, ADMIN_EMAIL)));
  assert.equal(users.length, 1, "một tài khoản");
  const rowI = await identityRows(A, ADMIN_EMAIL);
  assert.equal(rowI.length, 1, "một dòng chỉ mục");
  assert.ok(rowI[0].lastUsedAt, "chạy lại cấp phát giữ dấu «đã đăng nhập»");
  const pdb = await getPlatformDb();
  assert.equal((await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, A))).length, 1, "một workspace");
  assert.equal((await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts).where(eq(schema.platformAccounts.code, "iel-acct-a"))).length, 1, "một tài khoản khách");
  assert.equal((await pdb.select({ id: schema.platformProvisioningJobs.id }).from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, "iel-create-a"))).length, 1, "một job");
  return { adminId: admin.id };
}

async function testResend(op: SessionUser, home: { code: string; name: string }) {
  // Khách NỘI BỘ (INTERNAL) đi cùng đường với khách ngoài — chỉ khác nhãn tài khoản.
  const created = await createCustomerAsOperator(op, {
    account: { code: "iel-acct-r", name: "Khách IEL R", accountType: "INTERNAL" },
    workspace: { code: R, name: "Shop IEL R", planKey: "starter" },
    products: ["chotdon"],
    admin: { email: R_ADMIN, name: "Chủ R" },
    idempotencyKey: "iel-create-r",
    reason: "Bài kiểm gửi lại kích hoạt",
  });
  assert.ok("ok" in created && created.activationLink, JSON.stringify(created));
  const t1 = tokenOf(created.activationLink!);
  const why = "Khách báo chưa nhận được liên kết";
  const rAdmin = await userOf(R, R_ADMIN);
  assert.ok(rAdmin);
  const errOf = (r: { error: string } | { ok: true }) => ("error" in r ? r.error : "OK");
  assert.match(errOf(await resendActivationAsOperator({ ...op, organization: { code: R, name: "R", isHome: false } }, { orgCode: R, reason: why })), /tổ chức nhà/, "quản trị của khách không tự gửi kích hoạt xuyên nền tảng");
  assert.match(errOf(await resendActivationAsOperator({ ...op, role: "CS" }, { orgCode: R, reason: why })), /không có quyền/);
  assert.match(errOf(await resendActivationAsOperator(op, { orgCode: R, reason: "x" })), /lý do/);
  assert.match(errOf(await resendActivationAsOperator(op, { orgCode: home.code, reason: why })), /workspace khách/, "không gửi kích hoạt cho người nhà");
  assert.match(errOf(await resendActivationAsOperator(op, { orgCode: "iel-khong-co", reason: why })), /workspace khách/);

  const first = await resendActivationAsOperator(op, { orgCode: R, reason: why, email: "ke-gian@evil.vn" } as unknown);
  assert.ok("ok" in first, JSON.stringify(first));
  assert.equal(first.email, R_ADMIN, "người nhận do máy chủ tra — ô email lạ từ trình duyệt bị bỏ qua");
  const t2 = tokenOf(first.link);
  assert.notEqual(t2, t1);
  assert.equal(errOf(await reset(R, t1, PW1)), PASSWORD_RESET_INVALID, "liên kết cũ hết hiệu lực ngay");
  assert.ok((await lookupResetToken(R, t2, { ip: nextIp() })).ok);
  const pdb = await getPlatformDb();
  const logs = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, R), eq(schema.platformAuditLog.action, "PASSWORD_RESET_LINK")));
  assert.equal(logs.length, 2, "kích hoạt ban đầu + gửi lại — mỗi lượt một dòng nhật ký nền tảng");
  const resent = logs.find((l) => l.reason?.startsWith("Gửi lại liên kết kích hoạt"));
  assert.ok(resent && resent.actorEmail === op.email && (resent.after as { purpose?: string })?.purpose === "ACTIVATION", JSON.stringify(logs));
  assert.ok(!JSON.stringify(logs).includes(t1) && !JSON.stringify(logs).includes(t2), "nhật ký không chứa mã thô");
  await withOrganization(R, async () => {
    const rows = await (await getDb()).select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, rAdmin.id));
    assert.ok(!JSON.stringify(rows).includes(t2) && rows.some((r) => r.tokenHash === hashResetToken(t2)), "CSDL chỉ giữ băm");
    assert.equal(rows.filter((r) => r.revokedAt).length, 1);
    // Liên kết đang chờ hết hạn ⇒ trạng thái «hết hạn», gửi lại được.
    await (await getDb()).update(schema.passwordResetTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.passwordResetTokens.tokenHash, hashResetToken(t2)));
  });
  assert.equal((await loadWorkspaceActivation(R))?.state, "EXPIRED");
  const second = await resendActivationAsOperator(op, { orgCode: R, reason: "Liên kết đã hết hạn" });
  assert.ok("ok" in second);
  // Dòng chỉ mục MẤT (dữ liệu trước bản vá) ⇒ đặt mật khẩu qua liên kết ghi lại.
  await pdb.delete(schema.platformIdentities).where(eq(schema.platformIdentities.orgCode, R));
  assert.ok("ok" in (await reset(R, tokenOf(second.link), PW1)));
  assert.equal((await identityRows(R, R_ADMIN)).length, 1, "kích hoạt xong ⇒ chỉ mục có lại");
  assert.equal((await loadWorkspaceActivation(R))?.state, "ACTIVATED");
  assert.match(errOf(await resendActivationAsOperator(op, { orgCode: R, reason: why })), /đã kích hoạt/, "người đã vào được ⇒ đi đường đặt lại mật khẩu");
  await waitPastRevocation(R, R_ADMIN);
  const r = await login(R_ADMIN, PW1);
  assert.equal(r.redirectTo, "/", "workspace không thuộc vỏ Chốt Đơn ⇒ đích cũ");
  assert.equal((await whoIs(r.cookie)).orgCode, R);
}

async function testSharedEmail(op: SessionUser) {
  // Cùng email quản trị ở workspace thứ hai (khách thuê hai workspace) — kích hoạt bằng CÙNG mật khẩu với A.
  const created = await createCustomerAsOperator(op, {
    account: { code: "iel-acct-c", name: "Khách IEL C", accountType: "EXTERNAL" },
    workspace: { code: C, name: "Shop IEL C", planKey: "starter", brand: "chotdon" },
    products: ["chotdon"],
    admin: { email: ADMIN_EMAIL, name: "Chủ C" },
    idempotencyKey: "iel-create-c",
    reason: "Bài kiểm email trùng",
  });
  assert.ok("ok" in created && created.activationLink, JSON.stringify(created));
  assert.ok("ok" in (await reset(C, tokenOf(created.activationLink!), PW2)));
  await waitPastRevocation(C, ADMIN_EMAIL);
  const cAdmin = await userOf(C, ADMIN_EMAIL);
  assert.ok(cAdmin);

  const pick1 = await login(ADMIN_EMAIL, PW2);
  const pick2 = await login(ADMIN_EMAIL, PW2);
  assert.deepEqual(pick1.value, { choose: [{ code: A, name: "Shop IEL A" }, { code: C, name: "Shop IEL C" }] }, "mật khẩu khớp ở hai nơi ⇒ hỏi chọn; nơi đã dùng trước");
  assert.deepEqual(pick2.value, pick1.value, "thứ tự TẤT ĐỊNH giữa hai lượt");
  assert.equal(pick1.cookie, undefined, "chưa chọn ⇒ chưa mở phiên nào");
  const wrong = await login(ADMIN_EMAIL, "SaiMatKhau@2026");
  assert.deepEqual(wrong.value, { error: LOGIN_BAD_CREDENTIALS });
  const leak = JSON.stringify(wrong.value);
  for (const s of [A, C, "Shop IEL A", "Shop IEL C"]) assert.ok(!leak.includes(s), `mật khẩu sai không được lộ «${s}»`);

  const intoC = await login(ADMIN_EMAIL, PW2, C);
  assert.ok(intoC.redirectTo && intoC.cookie, "bấm chọn ⇒ vào đúng workspace");
  const who = await whoIs(intoC.cookie);
  assert.equal(who.orgCode, C);
  assert.equal(who.userId, cAdmin.id, "đúng tài khoản của workspace C — không phải tài khoản cùng email ở A");
  assert.deepEqual(await loginCandidates(ADMIN_EMAIL), [C, A, (await getHomeOrganization()).code], "mới dùng nhất trước — vẫn tất định");

  // Mật khẩu khác nhau ⇒ mật khẩu quyết định, không hỏi chọn.
  const relink = await createResetLinkAsOperator(op, { orgCode: C, email: ADMIN_EMAIL, reason: "Tách mật khẩu hai workspace (bài kiểm)" });
  assert.ok("ok" in relink);
  assert.ok("ok" in (await reset(C, tokenOf(relink.link), PW3)));
  await waitPastRevocation(C, ADMIN_EMAIL);
  const onlyA = await login(ADMIN_EMAIL, PW2);
  assert.equal((await whoIs(onlyA.cookie)).orgCode, A, "mật khẩu chỉ khớp A ⇒ vào thẳng A");
  const onlyC = await login(ADMIN_EMAIL, PW3);
  assert.equal((await whoIs(onlyC.cookie)).orgCode, C, "mật khẩu chỉ khớp C ⇒ vào thẳng C");
}

async function testOldPaths(home: { code: string }) {
  // Người NHÀ: đăng nhập không mã như trước (nhà luôn là ứng viên).
  const db = await getDb();
  await db.insert(schema.users).values({ email: HOME_EMAIL, name: "Người nhà IEL", passwordHash: await hashPassword("NguoiNha@2026"), role: "VIEWER" });
  const h = await login(HOME_EMAIL, "NguoiNha@2026");
  assert.ok(h.redirectTo && h.cookie, JSON.stringify(h.value));
  assert.equal((await whoIs(h.cookie)).orgCode, home.code);
  // Đường phụ «mã tổ chức» vẫn chạy.
  const viaCode = await login(ADMIN_EMAIL, PW2, A);
  assert.equal((await whoIs(viaCode.cookie)).orgCode, A);
}

async function testCreatedAndInvited() {
  const bAdmin = await userOf(B, B_ADMIN);
  assert.ok(bAdmin);
  const actor: SessionUser = { id: bAdmin.id, email: B_ADMIN, name: "QT B", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: B, name: "Shop IEL B", isHome: false } };
  // Quản trị tạo hộ ở /settings/users.
  const made = await withOrganization(B, () => createUserCore(actor, { name: "Nhân viên B", email: "NV@iel-shop-b.vn", password: "NhanVien@2026", role: "VIEWER" }));
  assert.ok("ok" in made, JSON.stringify(made));
  const nvRow = await identityRows(B, "nv@iel-shop-b.vn");
  assert.ok(nvRow.length === 1 && nvRow[0].userId === made.id && nvRow[0].lastUsedAt === null, "tạo hộ ⇒ chỉ mục có ngay");
  const nv = await login("nv@iel-shop-b.vn", "NhanVien@2026");
  assert.equal((await whoIs(nv.cookie)).orgCode, B, "nhân viên tạo hộ đăng nhập không cần mã tổ chức");
  // Nhận lời mời KHÔNG đăng nhập ngay (không `issue`) ⇒ vẫn có chỉ mục.
  const inv = await withOrganization(B, () => createUserInviteCore(actor, { email: "moi@iel-shop-b.vn", role: "VIEWER" }));
  assert.ok("ok" in inv, JSON.stringify(inv));
  const accepted = await acceptUserInviteCore(B, tokenOf(inv.link), { name: "Người được mời", password: "NguoiMoi@2026", confirmPassword: "NguoiMoi@2026" }, { ip: nextIp() });
  assert.ok("ok" in accepted && !accepted.loggedIn, JSON.stringify(accepted));
  assert.equal((await identityRows(B, "moi@iel-shop-b.vn"))[0]?.userId, accepted.userId, "nhận lời mời ⇒ chỉ mục có, kể cả khi chưa đăng nhập");
  const moi = await login("moi@iel-shop-b.vn", "NguoiMoi@2026");
  assert.equal((await whoIs(moi.cookie)).orgCode, B);
}

async function testReconcile() {
  // Tài khoản «trước bản vá»: chèn thẳng vào CSDL B, không qua đường tạo tài khoản ⇒ không có chỉ mục.
  const pdb = await getPlatformDb();
  const legacyHash = await hashPassword(LEGACY_PW);
  const ids = await withOrganization(B, async () => {
    const db = await getDb();
    const ins = async (email: string, extra: Partial<typeof schema.users.$inferInsert> = {}) =>
      (await db.insert(schema.users).values({ email, name: email, passwordHash: legacyHash, role: "VIEWER", ...extra }).returning({ id: schema.users.id }))[0].id;
    return {
      cu: await ins("cu@iel-shop-b.vn", { phone: "84987650001" }),
      lech: await ins("lech@iel-shop-b.vn"),
      khoa: await ins("khoa@iel-shop-b.vn", { active: false }),
      khongMk: await ins("khong-mk@iel-shop-b.vn", { passwordHash: "x" }),
      hoa: await ins("Hoa@IEL-shop-b.vn"),
    };
  });
  await pdb.insert(schema.platformIdentities).values([
    { kind: "EMAIL", value: "lech@iel-shop-b.vn", orgCode: B, userId: "khong-phai-ai", lastUsedAt: new Date() },
    { kind: "EMAIL", value: "da-xoa@iel-shop-b.vn", orgCode: B, userId: "nguoi-da-xoa" },
  ]);
  assert.deepEqual((await login("cu@iel-shop-b.vn", LEGACY_PW)).value, { error: LOGIN_BAD_CREDENTIALS }, "TRƯỚC đối chiếu: tài khoản cũ chỉ vào được khi gõ mã tổ chức (đúng lỗi P0)");
  assert.ok((await login("cu@iel-shop-b.vn", LEGACY_PW, B)).redirectTo, "…còn đường mã tổ chức thì vào được");
  // Lượt đăng nhập bằng mã ở trên đã ghi chỉ mục cho `cu` — xoá lại để đối chiếu thấy đúng dữ liệu cũ.
  await pdb.delete(schema.platformIdentities).where(and(eq(schema.platformIdentities.orgCode, B), eq(schema.platformIdentities.userId, ids.cu)));

  const snapshot = async () => JSON.stringify((await identityRows(B)).map((r) => [r.kind, r.value, r.userId, r.lastUsedAt?.toISOString() ?? null]).sort());
  const auditCount = async () => (await pdb.select({ id: schema.platformAuditLog.id }).from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, B), eq(schema.platformAuditLog.action, "IDENTITY_RECONCILE")))).length;
  const before = await snapshot();
  const plan = await planIdentityReconcile({ orgCode: B });
  assert.equal(plan.orgs.length, 1);
  const b = plan.orgs[0];
  assert.equal(b.error, null);
  assert.deepEqual(b.gaps.map((g) => `${g.kind}:${g.value}:${g.state}`).sort(), ["EMAIL:cu@iel-shop-b.vn:MISSING", "EMAIL:lech@iel-shop-b.vn:STALE", "PHONE:84987650001:MISSING"]);
  assert.ok(b.gaps.every((g) => g.userId === (g.value === "lech@iel-shop-b.vn" ? ids.lech : ids.cu)), "mỗi chỗ thiếu trỏ ĐÚNG tài khoản mang email đó trong CSDL B");
  assert.deepEqual(b.skipped, { inactive: 1, noPassword: 1, emailNotNormalized: 1 }, "khoá · không mật khẩu · email lệch dạng ⇒ bỏ qua, không đoán");
  assert.equal(b.orphans, 2, "dòng trỏ tài khoản không còn ⇒ chỉ đếm");
  const dry = await runIdentityReconcile({ orgCode: B, apply: false });
  assert.equal(dry.after, null);
  assert.equal(dry.written, 0);
  assert.equal(await snapshot(), before, "CHẠY THỬ không ghi một dòng chỉ mục nào");
  assert.equal(await auditCount(), 0, "chạy thử không ghi nhật ký");

  const applied = await runIdentityReconcile({ orgCode: B, apply: true, source: "TEST" });
  assert.equal(applied.written, 3);
  assert.equal(applied.failed, 0);
  assert.ok(applied.after && applied.after.totals.missing === 0 && applied.after.totals.stale === 0, JSON.stringify(applied.after?.totals));
  assert.equal(applied.after?.orgs[0]?.orphans, 1, "dòng mồ côi KHÔNG bị xoá");
  const lech = await identityRows(B, "lech@iel-shop-b.vn");
  assert.ok(lech.length === 1 && lech[0].userId === ids.lech && lech[0].lastUsedAt === null, "dòng lệch trỏ lại đúng tài khoản; «đã dùng» của chủ cũ không truyền sang");
  const log = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, B), eq(schema.platformAuditLog.action, "IDENTITY_RECONCILE")));
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].after, { written: 3, failed: 0 });
  assert.ok(!JSON.stringify(log).includes("iel-shop-b.vn") && !JSON.stringify(log).includes("84987650001"), "nhật ký chỉ số đếm — không email / SĐT");
  const once = await snapshot();
  const twice = await runIdentityReconcile({ orgCode: B, apply: true, source: "TEST" });
  assert.equal(twice.written, 0, "chạy lại không ghi gì");
  assert.equal(await snapshot(), once, "idempotent — không dòng thứ hai");
  assert.equal(await auditCount(), 1, "không có gì để ghi ⇒ không thêm nhật ký");
  assert.equal((await identityRows(B, "khoa@iel-shop-b.vn")).length, 0, "tài khoản khoá không được ghi");
  assert.equal((await identityRows(B, "hoa@iel-shop-b.vn")).length, 0, "email lệch dạng không được chuẩn hoá hộ");

  const cu = await login("cu@iel-shop-b.vn", LEGACY_PW);
  assert.equal((await whoIs(cu.cookie)).orgCode, B, "SAU đối chiếu: tài khoản cũ đăng nhập không cần mã tổ chức");
  const byPhone = await login("0987 650 001", LEGACY_PW);
  assert.equal((await whoIs(byPhone.cookie)).orgCode, B, "…và bằng SĐT");
}

export async function testIdentityEmailLogin() {
  testPure();
  testSource();
  await cleanup();
  installRealStores();
  const home = await getHomeOrganization();
  const op = operatorOf(home);
  try {
    // Workspace B: cấp thẳng (như /platform «Tạo tổ chức» / script) — đích của đòn F và nhà của dữ liệu cũ khi đối chiếu.
    await provisionOrganization({ code: B, name: "Shop IEL B", plan: "starter", modules: ["customers"], admin: { email: B_ADMIN, name: "QT B", password: "QuanTriB@2026" }, source: "TEST", actor: null });
    assert.equal((await identityRows(B, B_ADMIN)).length, 1, "mọi đường cấp phát đều ghi chỉ mục — không chỉ job «Tạo khách»");
    await testCustomerFlow(op, home);
    await testResend(op, home);
    await testSharedEmail(op);
    await testOldPaths(home);
    await testCreatedAndInvited();
    await testReconcile();
  } finally {
    setSessionTokenSourceForTests(null);
    removeRealStores();
    await cleanup();
  }
  console.log("✓ Đăng nhập email + mật khẩu cho khách do admin tạo: cấp phát / tạo hộ / lời mời / đặt mật khẩu ghi chỉ mục ngay (chưa «đã dùng» — không mở Google theo email gõ tay, không tính «đã đăng nhập»); kích hoạt → đăng nhập KHÔNG mã tổ chức → đúng workspace + vỏ khách; không vào workspace khác; đăng xuất / đặt lại vẫn vào; chạy lại cấp phát không nhân đôi; gửi lại kích hoạt (người vận hành · lý do · thu hồi liên kết cũ · chỉ băm · nhật ký); email trùng hai workspace ⇒ chọn tất định, mật khẩu sai không lộ; người nhà / mã tổ chức không đổi; đối chiếu dữ liệu cũ chạy thử không ghi, ghi bù idempotent");
}
