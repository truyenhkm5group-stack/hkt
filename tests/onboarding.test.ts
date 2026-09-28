/**
 * PHASE 10 · TỰ PHỤC VỤ — `lib/onboarding/*`, `lib/entitlements/*`, `lib/branding/*`, `/start`.
 *
 * Ba lớp:
 *  1. THUẦN — cờ chế độ (lạ ⇒ off), chọn / bỏ module kéo theo phụ thuộc, cắt mẫu theo module, băm mã mời, nhận diện
 *     ảnh theo chữ ký byte, màu nhấn chỉ từ tập đóng.
 *  2. MÃ NGUỒN — `/start` công khai ở middleware + ngoài vùng module; trang chủ chỉ rẽ nhánh cho tổ chức KHÔNG phải nhà;
 *     các điểm tạo gọi `checkEntitlement`.
 *  3. TỔ CHỨC THẬT `ob-a` / `ob-b` / `ob-c` (CSDL riêng, tự dọn): off ⇒ không tạo gì; invite: mã sai / hết hạn / thu hồi
 *     / đã dùng ⇒ từ chối; mã đúng ⇒ `ob-a` từ mẫu bán sỉ BỎ Mua hàng ⇒ module đúng, quản trị đăng nhập VÀO ĐÚNG
 *     `ob-a`, trang của mẫu có; gửi lại ⇒ không nhân đôi; tiêm lỗi ⇒ `SETUP_FAILED` rồi chạy lại xong; người vận hành
 *     tạo hộ khi cờ TẮT; nhà không đổi (module, trang chủ, thương hiệu, không giới hạn); vượt gói ⇒ lỗi nghiệp vụ; A
 *     không đọc được logo / cài đặt của B; bảng platform_* mới rỗng trong CSDL tổ chức; trần đăng ký mở theo IP / ngày.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { GET as logoGET } from "@/app/api/branding/logo/route";
import { setRequestPathSourceForTests, signSession, type SessionSubject, type SessionUser } from "@/lib/auth/session";
import { resolvePermissions } from "@/lib/auth/permissions";
import { MODULE_FREE_PATH_PREFIXES, moduleOfPath } from "@/lib/constants/platform-modules";
import { accentCss, ACCENTS, BRANDING_SETTING_KEY, sanitizeBranding, sniffImageMime } from "@/lib/branding/accents";
import { setSettingJson } from "@/lib/settings";
import { getBranding, getOrgBrand, readLogo, saveBrandingCore, uploadLogoCore } from "@/lib/branding/service";
import { getGettingStarted } from "@/lib/onboarding/progress";
import { checkEntitlement, getPlanUsage } from "@/lib/entitlements/check";
import { overLimitMessage, parseLimits } from "@/lib/entitlements/kinds";
import { getPageBySlug } from "@/lib/pages/registry";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization, OrgContextError, setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { adminCreatePage } from "@/lib/platform-ui/page-admin";
import { blankPageMeta, normalizePageMeta } from "@/lib/platform-ui/page-admin-shared";
import { blankBlueprint, buildSignupBlueprint, tailorBlueprint } from "@/lib/onboarding/blueprint";
import { createInvite, hashInviteCode, lookupInvite, revokeInvite } from "@/lib/onboarding/invites";
import { checkSignupRate, hashIp, recordAttempt, SIGNUP_LIMITS } from "@/lib/onboarding/rate";
import {
  checkAdminStep,
  checkInviteStep,
  checkOrgStep,
  createOrganizationFromSignup,
  previewSignup,
  readOnboarding,
  retryOrganizationSetup,
  setOnboardingFaultForTests,
  signupMode,
  SIGNUP_CLOSED,
  type SignupActor,
} from "@/lib/onboarding/service";
import { closeUnderDependencies, CORE_MODULES, narrowerSignupMode, parseSignupMode, signupCeiling, SIGNUP_MODES, toggleModule, type SignupDraft, type SignupMode } from "@/lib/onboarding/shared";
import { invalidateSignupSetting, readSignupSetting, setSignupSetting, SIGNUP_MODE_CACHE_MS, SIGNUP_MODE_SETTING_KEY, signupModeState } from "@/lib/onboarding/signup-mode";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";

const ORGS = ["ob-a", "ob-b", "ob-c"] as const;
const IP = "10.77.0.1";
const PUBLIC: SignupActor = { kind: "public", ip: IP };
const NOTE = "ob-test";
const TIGHT_PLAN = "ob-tight";

function draft(over: Partial<SignupDraft> & { invite?: string | null } = {}): SignupDraft {
  return {
    invite: null,
    org: { name: "Bán sỉ Minh An", code: "ob-a" },
    admin: { name: "Anh Minh", email: "minh@ob-a.local", password: "MinhAn@2026!" },
    plan: { businessType: "wholesale", templateKey: "wholesale", modules: WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "purchasing" && !CORE_MODULES.includes(m)) },
    planKey: null,
    ...over,
  };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformSignupInvites).where(or(like(schema.platformSignupInvites.note, `${NOTE}%`), inArray(schema.platformSignupInvites.organizationCode, [...ORGS])));
  await pdb.delete(schema.platformSignupAttempts).where(or(inArray(schema.platformSignupAttempts.organizationCode, [...ORGS]), inArray(schema.platformSignupAttempts.ipHash, [hashIp(IP), hashIp("10.77.0.2"), hashIp("10.77.0.3")]), like(schema.platformSignupAttempts.reason, "ob-flood%")));
  await pdb.delete(schema.platformPlans).where(eq(schema.platformPlans.key, TIGHT_PLAN));
  invalidateOrganizations();
  invalidateCapabilities();
}

/**
 * Ghi THẲNG cài đặt control plane (`null` = xoá dòng ⇒ mặc định `off`) rồi xoá đệm — đầu vào của tình huống, không phải
 * đường ghi được kiểm (đường ghi thật `setSignupSetting` có bài riêng ở `testSignupModeGate`).
 */
async function putSignupSetting(mode: string | null) {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
  if (mode !== null) await pdb.insert(schema.platformSettings).values({ key: SIGNUP_MODE_SETTING_KEY, value: mode, updatedByEmail: "ob-test@local" });
  invalidateSignupSetting();
}

async function signupSettingNow(): Promise<string | null> {
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  return row ? String(row.value) : null;
}

/**
 * Dựng MỘT cửa vào của /start: trần môi trường `PLATFORM_SIGNUP_MODE` = `env` VÀ cài đặt control plane = `setting`
 * (mặc định: cùng giá trị với trần — "mở đúng chế độ này"). Trả lại nguyên trạng cả hai trong finally.
 */
async function withEnvMode<T>(env: string | undefined, fn: () => Promise<T>, setting: string | null = env ?? null): Promise<T> {
  const before = process.env.PLATFORM_SIGNUP_MODE;
  const settingBefore = await signupSettingNow();
  if (env === undefined) delete process.env.PLATFORM_SIGNUP_MODE;
  else process.env.PLATFORM_SIGNUP_MODE = env;
  try {
    await putSignupSetting(setting);
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PLATFORM_SIGNUP_MODE;
    else process.env.PLATFORM_SIGNUP_MODE = before;
    await putSignupSetting(settingBefore);
  }
}

async function adminOf(code: string, email: string): Promise<SessionUser> {
  return withOrganization(code, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
    assert.ok(u, `thiếu quản trị ${email} của ${code}`);
    const org = await findOrganization(code);
    return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: org?.name ?? code, isHome: false }, modules: [...(await getEnabledModules(code))] };
  });
}

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  for (const raw of [undefined, "", "OFF", "bat", " open-ish "]) assert.equal(parseSignupMode(raw), "off", `«${raw}» ⇒ off`);
  assert.equal(parseSignupMode(" Invite "), "invite");
  assert.equal(parseSignupMode("open"), "open");

  const on = toggleModule([], "orders", true);
  assert.deepEqual([...on.alsoOn].sort(), ["customers", "products"], "bật Đơn hàng ⇒ tự bật Khách + Sản phẩm, NÓI RA");
  const off = toggleModule(closeUnderDependencies(["purchasing", "orders", "customer_care"]).modules, "products", false);
  assert.ok(off.alsoOff.includes("orders") && off.alsoOff.includes("inventory") && off.alsoOff.includes("purchasing"), `tắt Sản phẩm ⇒ tắt luôn cái cần nó: ${off.alsoOff.join(",")}`);
  assert.ok(off.modules.includes("customers") && off.modules.includes("customer_care"));
  assert.ok(!closeUnderDependencies(["connector_pancake", "tech", "integrations"]).modules.length, "connector / Tech (credential của nhà) không chọn được");

  const cut = tailorBlueprint(WHOLESALE_BLUEPRINT, closeUnderDependencies(["customers"]).modules);
  assert.ok(!cut.bp.modules.includes("purchasing") && !cut.bp.modules.includes("orders"));
  assert.deepEqual(cut.bp.roles?.[0]?.permissions, ["customers:view"], "vai trò giữ quyền thuộc module bật, bỏ quyền của module không chọn (orders:read, bank:view)");
  assert.equal(cut.bp.pages?.length, 1, "trang công nợ thuộc Khách — vẫn giữ");
  const built = buildSignupBlueprint({ businessType: "wholesale", templateKey: "wholesale", modules: draft().plan.modules });
  assert.ok(!("error" in built) && !built.bp.modules.includes("purchasing") && built.bp.modules.includes("inventory"));
  assert.ok("error" in buildSignupBlueprint({ businessType: "blank", templateKey: "khong-co", modules: [] }), "mẫu lạ ⇒ lỗi, không đoán");
  assert.equal(blankBlueprint(["customers"]).key, "start-blank");

  assert.equal(hashInviteCode("abcde-fghjk"), hashInviteCode(" ABCDEFGHJK "), "mã mời chuẩn hoá trước khi băm");
  assert.match(hashInviteCode("x"), /^[0-9a-f]{64}$/);

  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("<html><script>alert(1)</script>")), null, "HTML đổi đuôi .png không qua được");
  assert.equal(sanitizeBranding({ accent: "red;}body{display:none", displayName: "  A  " }).accent, null, "màu ngoài tập đóng ⇒ không màu");
  assert.equal(accentCss(null), null);
  assert.ok(accentCss("teal")!.includes(ACCENTS.teal.light.primary));

  const { limits, undeclared } = parseLimits({ users: 3, pages: null, workflows: "5" });
  assert.equal(limits.users, 3);
  assert.equal(limits.pages, null);
  assert.ok(undeclared.includes("workflows") && undeclared.includes("storageMb"), "thiếu / sai kiểu ⇒ CHƯA KHAI, nói ra");
  assert.match(overLimitMessage("users", "Dùng thử", 3, 3), /Dùng thử.*3\/3/);
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

function testSource() {
  const mw = readFileSync("middleware.ts", "utf8");
  const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("]", mw.indexOf("const PUBLIC_PREFIXES")));
  assert.ok(list.includes('"/start"'), "/start không cần phiên");
  assert.ok((MODULE_FREE_PATH_PREFIXES as readonly string[]).includes("/start") && moduleOfPath("/start") === null);
  assert.equal(moduleOfPath("/api/branding/logo"), "core");
  assert.equal(moduleOfPath("/settings/branding"), "core");
  const home = readFileSync("app/(dashboard)/page.tsx", "utf8");
  assert.ok(home.includes("if (user.organization && !user.organization.isHome) return <GettingStartedHome"), "trang chủ chỉ rẽ nhánh cho tổ chức KHÔNG phải nhà");
  const hooks: [string, string][] = [
    ["lib/actions/users.ts", 'checkEntitlement("users"'],
    ["lib/platform-ui/page-admin.ts", 'checkEntitlement("pages"'],
    ["lib/platform-ui/workflow-admin.ts", 'checkEntitlement("workflows"'],
    ["lib/actions/metadata-records.ts", 'checkEntitlement("storageMb"'],
    ["lib/branding/service.ts", 'checkEntitlement("storageMb"'],
  ];
  for (const [f, needle] of hooks) assert.ok(readFileSync(f, "utf8").includes(needle), `${f} phải gọi ${needle}`);
  const start = readFileSync("app/start/page.tsx", "utf8");
  assert.ok(!/VNX|vnx|Pancake|Viettel/.test(start), "/start không in gì của tổ chức nhà");
}

// ═══════════ 3 · TỔ CHỨC THẬT ═══════════

async function testOffMode() {
  // Production HÔM NAY: không khai trần (⇒ trần invite) và chưa ai đặt cài đặt (⇒ off) ⇒ TẮT.
  await withEnvMode(undefined, async () => {
    assert.equal(await signupMode(), "off", "không trần + không cài đặt ⇒ /start TẮT");
    assert.deepEqual(await checkInviteStep("x", PUBLIC), { error: SIGNUP_CLOSED });
    assert.deepEqual(await checkOrgStep({ name: "A", code: "ob-a" }, null, PUBLIC), { error: SIGNUP_CLOSED });
    assert.deepEqual(await previewSignup({ plan: draft().plan }, PUBLIC), { error: SIGNUP_CLOSED });
    const r = await createOrganizationFromSignup(draft(), PUBLIC);
    assert.ok("error" in r && r.error === SIGNUP_CLOSED);
    assert.equal(await findOrganization("ob-a"), null, "cờ tắt ⇒ không tạo gì");
  });
}

async function testInviteFlow(): Promise<SessionSubject> {
  return withEnvMode("invite", async () => {
    const good = await createInvite({ actor: null, note: `${NOTE} tốt`, planKey: "trial" });
    const expired = await createInvite({ actor: null, note: `${NOTE} hết hạn` });
    const revoked = await createInvite({ actor: null, note: `${NOTE} thu hồi` });
    const pdb = await getPlatformDb();
    await pdb.update(schema.platformSignupInvites).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.platformSignupInvites.id, expired.id));
    assert.deepEqual(await revokeInvite(revoked.id, null), { ok: true });
    const stored = await pdb.query.platformSignupInvites.findFirst({ where: eq(schema.platformSignupInvites.id, good.id) });
    assert.ok(stored && stored.codeHash !== good.code && !JSON.stringify(stored).includes(good.code.replace(/-/g, "")), "CSDL chỉ giữ băm, không giữ mã thô");

    // ── Mã sai / hết hạn / thu hồi ⇒ từ chối, không tạo gì ──
    assert.match((await checkInviteStep("SAI00-SAI00-SAI00", PUBLIC) as { error: string }).error, /không đúng/);
    assert.match((await checkInviteStep(expired.code, PUBLIC) as { error: string }).error, /hết hạn/);
    assert.match((await checkInviteStep(revoked.code, PUBLIC) as { error: string }).error, /thu hồi/);
    for (const bad of ["SAI00-SAI00-SAI00", expired.code, revoked.code]) {
      const r = await createOrganizationFromSignup(draft({ invite: bad }), PUBLIC);
      assert.ok("error" in r, `mã ${bad} phải bị từ chối`);
    }
    assert.equal(await findOrganization("ob-a"), null);
    assert.match((await checkOrgStep({ name: "Minh An", code: "ob-a" }, null, PUBLIC) as { error: string }).error, /mã mời/i, "không mã mời thì không dò được mã tổ chức");

    // ── Từng bước kiểm ở máy chủ ──
    assert.deepEqual(await checkInviteStep(good.code, PUBLIC), { ok: true });
    assert.deepEqual(await checkOrgStep({ name: "Minh An", code: "ob-a" }, good.code, PUBLIC), { ok: true });
    assert.ok("error" in (await checkOrgStep({ name: "Minh An", code: "vnx" }, good.code, PUBLIC)), "mã dành riêng");
    assert.ok("error" in (await checkOrgStep({ name: "Minh An", code: (await getHomeOrganization()).code }, good.code, PUBLIC)), "mã của tổ chức nhà");
    assert.ok("error" in checkAdminStep({ name: "A", email: "x@y.z", password: "ngan" }), "mật khẩu < 10");

    // ── Xem trước = kế hoạch, không ghi ──
    const pv = await previewSignup({ invite: good.code, orgCode: "ob-a", plan: draft().plan }, PUBLIC);
    assert.ok("ok" in pv && pv.preview.ok, JSON.stringify(pv));
    assert.ok(!pv.preview.modules.some((m) => m.key === "purchasing"), "bỏ Mua hàng ⇒ không trong kế hoạch");
    assert.ok(pv.preview.steps.some((s) => s.kind === "page" && s.key === "cong-no-khach-hang" && s.action === "CREATE"));
    assert.equal(await findOrganization("ob-a"), null, "xem trước không tạo gì");

    // ── Tạo ⇒ đăng nhập qua verifyLogin ──
    let subject: SessionSubject | null = null;
    const r = await createOrganizationFromSignup(draft({ invite: good.code }), PUBLIC, { issue: async (s) => void (subject = s) });
    assert.ok("ok" in r && r.created && r.loggedIn, JSON.stringify(r));
    assert.ok(subject, "phiên được phát");
    const s = subject as SessionSubject;
    assert.equal(s.orgCode, "ob-a", "phiên mang ĐÚNG tổ chức mới");
    const org = await findOrganization("ob-a");
    assert.ok(org && org.status === "ACTIVE" && org.plan === "trial" && !org.isHome && org.moduleDefault === "DISABLED");
    const expected = [...new Set([...CORE_MODULES, ...WHOLESALE_BLUEPRINT.modules])].filter((m) => m !== "purchasing").sort();
    assert.deepEqual([...(await getEnabledModules("ob-a"))].sort(), expected, "module = mẫu bán sỉ trừ Mua hàng (phụ thuộc đủ)");
    await withOrganization("ob-a", async () => {
      const page = await getPageBySlug("cong-no-khach-hang");
      assert.ok(page && page.page.publishedVersion > 0, "trang của mẫu có và đã xuất bản");
      const db = await getDb();
      for (const t of ["platform_plans", "platform_signup_invites", "platform_signup_attempts", "platform_settings"]) {
        const res = (await db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown as { rows: { n: number }[] };
        assert.equal(res.rows[0].n, 0, `${t} trong CSDL tổ chức phải rỗng`);
      }
    });
    const inv = await lookupInvite(good.code);
    assert.ok(!inv.ok && inv.reason === "USED", "mã đã dùng");
    const state = await readOnboarding("ob-a");
    assert.equal(state?.state, "DONE");
    assert.equal(state?.source, "INVITE");

    // Phiên thật: token ký cho subject ⇒ ngữ cảnh là ob-a.
    const token = await signSession(s);
    setSessionTokenSourceForTests(async () => token);
    try {
      assert.equal((await currentOrganization()).code, "ob-a", "quản trị đăng nhập VÀO ĐÚNG tổ chức");
    } finally {
      setSessionTokenSourceForTests(null);
    }

    // ── Gửi lại cùng mã tổ chức ⇒ không nhân đôi ──
    const countsBefore = await withOrganization("ob-a", async () => {
      const db = await getDb();
      return { users: (await db.select().from(schema.users)).length, installs: (await db.select().from(schema.blueprintInstalls)).length, pages: (await db.select().from(schema.metaPages)).length };
    });
    const again = await createOrganizationFromSignup(draft({ invite: good.code }), PUBLIC, { issue: async () => undefined });
    assert.ok("ok" in again && !again.created, JSON.stringify(again));
    const wrongPw = await createOrganizationFromSignup(draft({ invite: good.code, admin: { ...draft().admin, password: "SaiMatKhau123" } }), PUBLIC, { issue: async () => assert.fail("không được phát phiên khi sai mật khẩu") });
    assert.ok("error" in wrongPw, "gửi lại với mật khẩu khác ⇒ không phiên");
    const countsAfter = await withOrganization("ob-a", async () => {
      const db = await getDb();
      return { users: (await db.select().from(schema.users)).length, installs: (await db.select().from(schema.blueprintInstalls)).length, pages: (await db.select().from(schema.metaPages)).length };
    });
    assert.deepEqual(countsAfter, countsBefore, "chạy lại không thêm người / lượt cài / trang");
    // Một mã mời KHÁC (còn hạn) gửi đúng bản nháp của ob-a — kể cả đúng email + mật khẩu — không phải chủ ⇒ trùng mã.
    const stranger = await createInvite({ actor: null, note: `${NOTE} lạ` });
    const hijack = await createOrganizationFromSignup(draft({ invite: stranger.code }), PUBLIC, { issue: async () => assert.fail("người cầm mã mời khác không được phiên vào ob-a") });
    assert.ok("error" in hijack && /đã có người dùng/.test(hijack.error), JSON.stringify(hijack));
    assert.ok((await lookupInvite(stranger.code)).ok, "lượt bị từ chối không tiêu mã mời");
    // Mã mời đã dùng cho ob-a KHÔNG dựng được tổ chức khác.
    const other = await createOrganizationFromSignup(draft({ invite: good.code, org: { name: "Khác", code: "ob-c" } }), PUBLIC);
    assert.ok("error" in other && (await findOrganization("ob-c")) === null, "mã mời một lần");
    return s;
  });
}

async function testSetupFailed() {
  await withEnvMode("invite", async () => {
    const inv = await createInvite({ actor: null, note: `${NOTE} hỏng` });
    const d = draft({ invite: inv.code, org: { name: "Bán lẻ Hỏng", code: "ob-b" }, admin: { name: "Chị B", email: "b@ob-b.local", password: "ChiB@123456" }, plan: { businessType: "blank", templateKey: null, modules: ["customers"] } });
    setOnboardingFaultForTests((step) => {
      if (step === "INSTALL") throw new Error("lỗi tiêm ở bước cài");
    });
    let r;
    try {
      r = await createOrganizationFromSignup(d, PUBLIC, { issue: async () => assert.fail("hỏng thì không đăng nhập") });
    } finally {
      setOnboardingFaultForTests(null);
    }
    assert.ok("error" in r && r.setupFailed, JSON.stringify(r));
    const org = await findOrganization("ob-b");
    assert.equal(org?.status, "SETUP_FAILED", "hỏng giữa chừng ⇒ SETUP_FAILED");
    const st = await readOnboarding("ob-b");
    assert.equal(st?.state, "FAILED");
    assert.equal(st?.failedStep, "INSTALL");
    await assert.rejects(withOrganization("ob-b", async () => 1), (e) => e instanceof OrgContextError && e.code === "ORG_INACTIVE", "tổ chức dựng hỏng không vào được");
    const pdb = await getPlatformDb();
    const log = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, "ob-b"));
    assert.ok(log.some((l) => l.action === "ORG_STATUS"), "nhật ký nền tảng ghi lượt hỏng");

    // Chạy lại cùng mã mời + cùng mã tổ chức ⇒ đi tiếp, xong.
    const retry = await createOrganizationFromSignup(d, PUBLIC, { issue: async () => undefined });
    assert.ok("ok" in retry && !retry.created, JSON.stringify(retry));
    assert.equal((await findOrganization("ob-b"))?.status, "ACTIVE");
    assert.equal((await readOnboarding("ob-b"))?.runs, 2);
    const users = await withOrganization("ob-b", async () => (await (await getDb()).select().from(schema.users)).length);
    assert.equal(users, 1, "chạy lại không tạo quản trị thứ hai");
  });

  // Người vận hành: tạo hộ khi cờ TẮT, gói tự chọn; hỏng ⇒ chạy lại từ /platform.
  await withEnvMode("off", async () => {
    const home = await getHomeOrganization();
    const op: Extract<SignupActor, { kind: "operator" }> = { kind: "operator", ip: IP, actor: { orgCode: home.code, userId: "op-1", email: "op@nha.local" } };
    setOnboardingFaultForTests((step) => {
      if (step === "ADMIN") throw new Error("lỗi tiêm sau khi có quản trị");
    });
    let r;
    try {
      r = await createOrganizationFromSignup(draft({ org: { name: "Khách vận hành", code: "ob-c" }, admin: { name: "Chị C", email: "c@ob-c.local", password: "KhachC@12345" }, planKey: "standard", plan: { businessType: "blank", templateKey: null, modules: [] } }), op);
    } finally {
      setOnboardingFaultForTests(null);
    }
    assert.ok("error" in r && r.setupFailed, JSON.stringify(r));
    assert.equal((await findOrganization("ob-c"))?.status, "SETUP_FAILED");
    const again = await retryOrganizationSetup("ob-c", op);
    assert.ok("ok" in again, JSON.stringify(again));
    const org = await findOrganization("ob-c");
    assert.ok(org?.status === "ACTIVE" && org.plan === "standard");
    assert.equal((await readOnboarding("ob-c"))?.source, "OPERATOR");
  });
}

async function testHomeUntouched(homeModulesBefore: string[]) {
  const home = await getHomeOrganization();
  assert.deepEqual([...(await getEnabledModules(home.code))].sort(), homeModulesBefore, "module của nhà không đổi");
  const homeUser: SessionUser = { id: "nha", email: "nha@local", name: "Nhà", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  assert.equal(await getOrgBrand(homeUser), null, "nhà giữ nhận diện hiện tại");
  assert.ok("error" in (await saveBrandingCore(homeUser, { displayName: "X", accent: "teal" })), "không đặt thương hiệu cho nhà");
  assert.equal((await getBranding()).displayName, null, "cài đặt của nhà không có org.branding");
  const ent = await checkEntitlement("users", 1_000_000);
  assert.ok(ent.ok && ent.limit === null && ent.used === null, "nhà = nội bộ, không giới hạn, không đếm");
}

async function testEntitlementsAndIsolation(s: SessionSubject) {
  const pdb = await getPlatformDb();
  // Gói siết: 1 trang, 2 người, 1 MB — ob-a đã có 1 trang (của mẫu) và 1 người.
  await pdb.insert(schema.platformPlans).values({ key: TIGHT_PLAN, name: "Siết thử", limits: { users: 2, pages: 1, objects: null, records: null, workflows: 50, aiDraftsPerDay: null, storageMb: 1 } });
  await pdb.update(schema.platformOrganizations).set({ plan: TIGHT_PLAN }).where(eq(schema.platformOrganizations.code, "ob-a"));
  invalidateOrganizations();
  const adminA = await adminOf("ob-a", s.email);
  await withOrganization("ob-a", async () => {
    const page = await adminCreatePage(adminA, normalizePageMeta({ ...blankPageMeta(), name: "Trang thêm", slug: "trang-them", moduleKey: "customers", nav: { enabled: false, label: "", zone: null, order: 1 } }));
    assert.ok(!page.ok && /hạn mức của gói «Siết thử»/.test(page.errors[0].message), `vượt gói ⇒ lỗi nghiệp vụ: ${JSON.stringify(page)}`);
    assert.ok((await checkEntitlement("users", 1)).ok, "người thứ 2 còn chỗ");
    const db = await getDb();
    await db.insert(schema.users).values({ email: "nv2@ob-a.local", name: "NV2", passwordHash: "x", role: "VIEWER" });
    const u = await checkEntitlement("users", 1);
    assert.ok(!u.ok && u.used === 2 && u.limit === 2, "đếm THẬT, không đợi đệm 60 giây khi sát trần");
    const obj = await checkEntitlement("objects", 5);
    assert.ok(obj.ok && obj.used === null, "loại chưa có bộ đếm ⇒ không chặn, chưa biết ≠ 0");
    const usage = await getPlanUsage();
    assert.equal(usage.rows.find((r) => r.kind === "users")?.used, 2);
    assert.equal(typeof usage.rows.find((r) => r.kind === "objects")?.used, "number", "đối tượng đã có bộ đếm (Phase 11 · H4) ⇒ số thật, không còn «chưa biết»");

    // Thương hiệu + logo của A.
    const saved = await saveBrandingCore(adminA, { displayName: "Minh An Sỉ", accent: "teal" });
    assert.ok("ok" in saved);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
    assert.ok("error" in (await uploadLogoCore(adminA, { data: Buffer.from("<svg onload=alert(1)>") })), "không phải ảnh raster ⇒ từ chối");
    assert.ok("error" in (await uploadLogoCore(adminA, { data: Buffer.concat([png, Buffer.alloc(600 * 1024)]) })), "> 512 KB ⇒ từ chối");
    // Cài đặt trỏ sang một tệp KHÔNG phải logo (tệp field của khách) ⇒ route logo không trả nó ra.
    const [foreign] = await db.insert(schema.customFiles).values({ objectKey: "customer", recordId: "c-1", fieldKey: "giay_to", filename: "cccd.png", mime: "image/png", size: png.length, data: png }).returning({ id: schema.customFiles.id });
    await setSettingJson(BRANDING_SETTING_KEY, { displayName: "Minh An Sỉ", accent: "teal", logoFileId: foreign.id });
    assert.equal(await readLogo(), null, "logoFileId trỏ tệp của đối tượng khác ⇒ không đọc được");
    await db.delete(schema.customFiles).where(eq(schema.customFiles.id, foreign.id));
    const up = await uploadLogoCore(adminA, { data: png });
    assert.ok("ok" in up, JSON.stringify(up));
    assert.equal((await readLogo())?.mime, "image/png");
    const brand = await getOrgBrand(adminA);
    assert.ok(brand?.name === "Minh An Sỉ" && brand.logoUrl && brand.accentCss?.includes(ACCENTS.teal.light.primary));

    // Thẻ «Bắt đầu»: đo từ dữ liệu thật; bước không đo được không tính vào tiến độ.
    const gs = await getGettingStarted(adminA);
    const byKey = Object.fromEntries(gs.steps.map((x) => [x.key, x.done]));
    assert.equal(byKey.branding, true, "đã đặt thương hiệu ⇒ bước xong");
    assert.equal(byKey.people, true, "có người thứ hai ⇒ bước xong");
    assert.equal(byKey.customers, false, "chưa có khách ⇒ chưa xong");
    assert.equal(byKey.pages, null, "lượt mở trang tuỳ biến không đo được ⇒ không tính");
    assert.ok(!("purchasing" in byKey) && gs.pages.some((p) => p.slug === "cong-no-khach-hang"));
    assert.equal(gs.measurable, gs.steps.filter((x) => x.done !== null).length);
  });

  // B không đọc được cài đặt / logo của A — kể cả qua route tải.
  await withOrganization("ob-b", async () => {
    assert.equal((await getBranding()).displayName, null, "cài đặt của A không lọt sang B");
    assert.equal(await readLogo(), null, "logo của A không lọt sang B");
  });
  const adminB = await adminOf("ob-b", "b@ob-b.local");
  const get = async (subject: SessionSubject) => {
    const token = await signSession(subject);
    setSessionTokenSourceForTests(async () => token);
    setRequestPathSourceForTests(() => "/api/branding/logo");
    try {
      return await logoGET();
    } finally {
      setSessionTokenSourceForTests(null);
      setRequestPathSourceForTests(null);
    }
  };
  const resA = await get(s);
  assert.equal(resA.status, 200);
  assert.equal(resA.headers.get("content-type"), "image/png");
  assert.equal(resA.headers.get("x-content-type-options"), "nosniff");
  const resB = await get({ id: adminB.id, email: adminB.email, name: adminB.name, role: "ADMIN", orgCode: "ob-b" });
  assert.equal(resB.status, 404, "phiên của B chỉ thấy logo của B (không có)");
}

async function testOpenRate() {
  await withEnvMode("open", async () => {
    const ip2 = hashIp("10.77.0.2");
    for (let i = 0; i < SIGNUP_LIMITS.createsPerIpPerHour; i++) await recordAttempt({ mode: "open", ipHash: ip2, orgCode: null, outcome: "CREATED", reason: "ob-flood" });
    const capped = await createOrganizationFromSignup(draft({ org: { name: "Tràn", code: "ob-c" } }), { kind: "public", ip: "10.77.0.2" });
    assert.ok("error" in capped && /một giờ/.test(capped.error), "trần tạo theo IP / giờ");
    const pdb = await getPlatformDb();
    await pdb.insert(schema.platformSignupAttempts).values(Array.from({ length: SIGNUP_LIMITS.openCreatesPerDay }, (_, i) => ({ mode: "open", ipHash: hashIp(`10.88.${i}.1`), outcome: "CREATED", reason: "ob-flood-day" })));
    const day = await checkSignupRate("open", hashIp("10.77.0.3"), { creating: true });
    assert.ok(!day.ok && /hôm nay/.test(day.error), "trần toàn nền tảng / ngày");
    assert.ok((await checkSignupRate("operator", ip2, { creating: true })).ok, "người vận hành không bị trần");
  });
}

// ═══════════ 4 · CỔNG MỞ BÁN B — min(trần môi trường, cài đặt control plane) ═══════════

function testSignupTruthTable() {
  // Trần: không đặt ⇒ invite · off / invite / open ⇒ đúng nó · lạ ⇒ off. Cài đặt: off / invite / open. 6 × 3 = 18 ô.
  const ceilings: [string | undefined, SignupMode][] = [
    [undefined, "invite"],
    ["", "invite"],
    ["off", "off"],
    [" Invite ", "invite"],
    ["open", "open"],
    ["mo-het", "off"],
  ];
  const expected: Record<SignupMode, Record<SignupMode, SignupMode>> = {
    off: { off: "off", invite: "off", open: "off" },
    invite: { off: "off", invite: "invite", open: "invite" },
    open: { off: "off", invite: "invite", open: "open" },
  };
  for (const [raw, ceilingMode] of ceilings) {
    const c = signupCeiling(raw);
    assert.equal(c.mode, ceilingMode, `trần «${raw}» ⇒ ${ceilingMode}`);
    for (const setting of SIGNUP_MODES) assert.equal(narrowerSignupMode(c.mode, setting), expected[ceilingMode][setting], `trần «${raw}» × cài đặt ${setting}`);
  }
  assert.equal(signupCeiling(undefined).source, "ENV_UNSET");
  assert.equal(signupCeiling("mo-het").source, "ENV_INVALID", "giá trị lạ ⇒ tắt cứng, và nói ra là lạ");
  assert.ok(SIGNUP_MODE_CACHE_MS <= 30_000, `đệm cờ ${SIGNUP_MODE_CACHE_MS} ms > 30 giây — bật / tắt phải có hiệu lực gần như ngay`);
  const start = readFileSync("app/start/page.tsx", "utf8");
  assert.ok(start.includes("await signupMode()") && start.includes('export const dynamic = "force-dynamic"'), "/start đọc cờ ở MỖI lượt dựng (không đóng băng lúc build / khởi động)");
}

async function testSignupModeGate() {
  const home = await getHomeOrganization();
  const operator: SessionUser = { id: "ob-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  const homeViewer: SessionUser = { ...operator, id: "ob-viewer", email: "xem@nha.local", role: "VIEWER", permissions: ["dashboard:view"] };
  const otherOrgAdmin: SessionUser = { ...operator, id: "ob-khac", email: "qt@khac.local", permissions: ["platform:operate"], organization: { code: "ob-a", name: "Khác", isHome: false } };
  const pdb = await getPlatformDb();
  const signupAudits = async () =>
    pdb
      .select()
      .from(schema.platformAuditLog)
      .where(and(eq(schema.platformAuditLog.action, "SIGNUP_MODE_SET"), eq(schema.platformAuditLog.subject, SIGNUP_MODE_SETTING_KEY)))
      .orderBy(schema.platformAuditLog.at);

  await withEnvMode(
    undefined,
    async () => {
      // Mặc định: TẮT, và lõi của /start nói "chưa mở".
      assert.equal((await signupModeState()).setting.stored, false, "chưa ai đặt ⇒ không có dòng");
      assert.deepEqual(await checkInviteStep("SAI00-SAI00-SAI00", PUBLIC), { error: SIGNUP_CLOSED });

      // Không phải người vận hành / tổ chức khác ⇒ không đổi được, không dòng nào, không nhật ký.
      const n0 = (await signupAudits()).length;
      for (const [who, label] of [
        [homeViewer, "người nhà không có platform:operate"],
        [otherOrgAdmin, "quản trị tổ chức khác (kể cả mang khoá platform:operate)"],
      ] as const) {
        const r = await setSignupSetting(who, { mode: "invite", reason: "thử mở hộ" });
        assert.ok("error" in r, `${label} ⇒ từ chối`);
      }
      assert.equal(await signupSettingNow(), null, "lượt bị từ chối không ghi cài đặt");
      assert.equal((await signupAudits()).length, n0, "lượt bị từ chối không ghi nhật ký");

      // Đầu vào: thiếu lý do / chế độ lạ / vượt trần ⇒ từ chối.
      assert.ok("error" in (await setSignupSetting(operator, { mode: "invite", reason: "ngắn" })), "lý do < 5 ký tự ⇒ từ chối");
      assert.ok("error" in (await setSignupSetting(operator, { mode: "mo-het", reason: "chế độ lạ" })), "chế độ lạ ⇒ từ chối");
      const over = await setSignupSetting(operator, { mode: "open", reason: "mở hẳn cho mọi người" });
      assert.ok("error" in over && /PLATFORM_SIGNUP_MODE=open/.test(over.error), "không khai trần ⇒ trần invite ⇒ đặt open bị từ chối, nói cách mở");
      assert.equal(await signupSettingNow(), null);

      // Người vận hành bật invite ⇒ có hiệu lực NGAY (không khởi động lại), nhật ký có dòng.
      const on = await setSignupSetting(operator, { mode: "invite", reason: "mở cho khách thử đợt 1" });
      assert.ok("ok" in on && on.changed && on.state.effective === "invite", JSON.stringify(on));
      assert.equal(await signupMode(), "invite", "/start phản ánh ngay sau khi đổi — không deploy, không khởi động lại");
      assert.match(((await checkInviteStep("SAI00-SAI00-SAI00", PUBLIC)) as { error: string }).error, /không đúng/, "cửa đã mở: mã sai bị từ chối vì SAI, không còn vì «chưa mở»");
      const all = await signupAudits();
      assert.equal(all.length, n0 + 1, "đúng MỘT dòng nhật ký cho lượt đổi");
      const log = all[all.length - 1];
      assert.ok(log.actorEmail === operator.email && log.actorOrgCode === home.code && log.targetOrgCode === home.code && log.source === "UI", `nhật ký nền tảng mang người + tổ chức: ${JSON.stringify(log)}`);
      assert.deepEqual(log.before, { setting: null, effective: "off" });
      assert.equal((log.after as { setting: string; effective: string }).setting, "invite");
      assert.equal((log.after as { setting: string; effective: string }).effective, "invite");
      assert.equal(log.reason, "mở cho khách thử đợt 1");
      const same = await setSignupSetting(operator, { mode: "invite", reason: "bấm lại lần hai" });
      assert.ok("ok" in same && !same.changed, "đặt lại đúng giá trị ⇒ không đổi");
      assert.equal((await signupAudits()).length, n0 + 1, "không đổi ⇒ không thêm nhật ký");

      // Tắt bằng cài đặt ⇒ đóng NGAY.
      const off = await setSignupSetting(operator, { mode: "off", reason: "tắt khẩn cấp từ /platform" });
      assert.ok("ok" in off && off.changed && off.state.effective === "off");
      assert.deepEqual(await checkInviteStep("SAI00-SAI00-SAI00", PUBLIC), { error: SIGNUP_CLOSED }, "tắt ở /platform ⇒ /start đóng ngay");

      // Tiến trình KHÁC ghi (không qua xoá đệm của tiến trình này): trễ tối đa bằng đệm, rồi thấy.
      await pdb.update(schema.platformSettings).set({ value: "invite" }).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
      assert.equal((await readSignupSetting()).mode, "off", "trong hạn đệm vẫn là giá trị đã đệm (tiền đề của phép đo tiếp theo)");
      assert.equal((await readSignupSetting({ now: Date.now() + SIGNUP_MODE_CACHE_MS + 1 })).mode, "invite", "qua hạn đệm (≤ 30 s) ⇒ đọc lại từ CSDL, không cần khởi động lại");

      // CSDL tự chặn giá trị ngoài tập đóng.
      await assert.rejects(pdb.update(schema.platformSettings).set({ value: "mo-het" }).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY)), "CHECK platform_settings_signup_mode_check");
    },
    null,
  );

  // Trần `off` (công tắc khẩn cấp) THẮNG mọi cài đặt, kể cả open.
  await withEnvMode(
    "off",
    async () => {
      assert.equal(await signupMode(), "off", "env off + cài đặt open ⇒ TẮT");
      assert.deepEqual(await checkInviteStep("SAI00-SAI00-SAI00", PUBLIC), { error: SIGNUP_CLOSED });
      assert.deepEqual(await checkOrgStep({ name: "A", code: "ob-a" }, null, PUBLIC), { error: SIGNUP_CLOSED });
      const r = await setSignupSetting(operator, { mode: "invite", reason: "cố mở khi đang tắt cứng" });
      assert.ok("error" in r && /TẮT CỨNG/.test(r.error), "đang tắt cứng ⇒ cài đặt không mở được, và nói vì sao");
    },
    "open",
  );
  // Giá trị lạ ở trần ⇒ cũng tắt cứng.
  await withEnvMode("mo-het", async () => assert.equal(await signupMode(), "off", "trần lạ ⇒ TẮT"), "open");
  // Trần open + cài đặt open ⇒ mở; người vận hành vẫn thu hẹp được về invite.
  await withEnvMode("open", async () => {
    assert.equal(await signupMode(), "open");
    const r = await setSignupSetting(operator, { mode: "invite", reason: "thu hẹp về mã mời" });
    assert.ok("ok" in r && r.state.effective === "invite");
    assert.equal(await signupMode(), "invite");
  });
}

export async function testOnboarding() {
  testPure();
  testSource();
  testSignupTruthTable();
  await cleanup();
  for (const code of ORGS) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  const home = await getHomeOrganization();
  const homeModulesBefore = [...(await getEnabledModules(home.code))].sort();
  try {
    await testOffMode();
    await testSignupModeGate();
    const subject = await testInviteFlow();
    await testSetupFailed();
    await testEntitlementsAndIsolation(subject);
    await testOpenRate();
    await testHomeUntouched(homeModulesBefore);
  } finally {
    setOnboardingFaultForTests(null);
    await cleanup();
  }
  console.log(
    "✓ Phase 10 · tự phục vụ: cờ off ⇒ không tạo gì; mã mời sai / hết hạn / thu hồi / đã dùng ⇒ từ chối, CSDL chỉ giữ băm; ob-a từ mẫu bán sỉ bỏ Mua hàng ⇒ module đúng (phụ thuộc đủ), trang của mẫu xuất bản, quản trị đăng nhập VÀO ĐÚNG ob-a, gửi lại không nhân đôi, sai mật khẩu không phiên; tiêm lỗi ⇒ SETUP_FAILED rồi chạy lại xong (khách cùng mã mời · người vận hành khi cờ tắt); vượt gói ⇒ lỗi nghiệp vụ, đếm tươi sát trần; A không đọc được logo / cài đặt của B (kể cả qua route); trần mở theo IP / ngày; nhà không đổi",
  );
}
