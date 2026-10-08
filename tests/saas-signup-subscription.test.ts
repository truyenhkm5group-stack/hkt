/**
 * ═══════════ F-02 · CỬA HÀNG TỰ ĐĂNG KÝ CÓ THUÊ BAO SẢN PHẨM (kiểm vỏ khách 08/10/2026) ═══════════
 *
 * Nguyên nhân đã đo: `/start` cấp workspace với module LÕI ⇒ `openSubscriptionsForProductsInUse` (bước 6 của
 * `provisionOrganization`) không thấy sản phẩm nào; mẫu ngành bật `ai_sales` / module ERP SAU đó qua `setOrganizationModule` —
 * đường không mở thuê bao. Bài này chạy ĐÚNG lõi của `/start` (đăng ký nhanh + trình hướng dẫn) cho cả hai thương hiệu:
 *  1. THUẦN + MÃ NGUỒN — thương hiệu ⇒ sản phẩm chỉ để đối chiếu; bước thuê bao nằm SAU lượt cài mẫu; không luật mở thứ hai;
 *     script mặc định chạy thử.
 *  2. TÁI HIỆN — `chotdon` (đăng ký nhanh, AI bán hàng) ⇒ thuê bao `chotdon`; `vnx` (trình hướng dẫn, TMĐT) ⇒ `erp`; dòng giống
 *     luồng người vận hành (ACTIVE, theo gói workspace, nhật ký); tình trạng dùng thử đọc từ thu phí (không số ngày mới).
 *  3. IDEMPOTENT — gọi lại không đẻ dòng thứ hai.
 *  4. LỖI KHÔNG LÀM HỎNG ĐĂNG KÝ — tiêm lỗi ở bước thuê bao: khách vẫn vào được, vết ở trạng thái dựng + nhật ký nền tảng; lỗi
 *     thật (workspace mất tài khoản) ⇒ trả lỗi, không ném.
 *  5. TRANG GÓI — DTO + HTML của khách không mang nhãn nội bộ; trống ⇒ câu kinh doanh; dùng thử ⇒ «còn N ngày»; nhà giữ nguyên.
 *  6. SỬA BÙ — chạy thử KHÔNG ghi (băm bảng trước / sau); thiếu lý do ⇒ không ghi; `apply` đi qua đúng hàm, chạy lại không thêm.
 * Không ghim ngày (luật 50 · 65): mọi mốc dựng từ đồng hồ thật bằng CÙNG hàm mã nguồn dùng.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray, or, sql } from "drizzle-orm";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { billingNotice } from "@/lib/billing/rules";
import { BILLING_RECEIVER_KEY } from "@/lib/billing/service";
import { invalidateSubscriptions, orgBillingStanding } from "@/lib/billing/standing";
import { salesAgentShell } from "@/lib/constants/saas-nav";
import { quickSignup } from "@/lib/onboarding/quick";
import { createOrganizationFromSignup, readOnboarding, setOnboardingFaultForTests } from "@/lib/onboarding/service";
import { hashIp } from "@/lib/onboarding/rate";
import { invalidateSignupSetting, SIGNUP_MODE_SETTING_KEY } from "@/lib/onboarding/signup-mode";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { invalidatePriceBook } from "@/lib/pricing/price-book";
import { accountOfWorkspace, liveSubscriptions, openSubscriptionsForProductsInUse } from "@/lib/saas/accounts";
import { subscriptionStatusFor } from "@/lib/saas/entitlements";
import { loadMyProducts, type MyProducts } from "@/lib/saas/portal";
import { brandProductKey, openSignupSubscriptions, SIGNUP_SUBSCRIPTION_AUDIT_SUBJECT } from "@/lib/saas/signup-subscriptions";
import { planSubscriptionRepair, REPAIR_CONSEQUENCES } from "@/lib/saas/subscription-repair";
import { rowsOf } from "@/lib/sql-rows";
import { MY_PRODUCTS_CUSTOMER_EMPTY, MyProductsSection } from "@/components/saas/my-products";
import { internalKeyPaths, stringHits } from "./saas-hide-internal.test";

const CHOT = "ssu-chot-mot";
const VNX = "ssu-vnx-erp";
const FAIL = "ssu-chot-loi";
const ORGS = [CHOT, VNX, FAIL] as const;
const IPS = ["203.0.113.171", "203.0.113.172", "203.0.113.173"] as const;
const PW = "MatKhau@2026";

/** Nhãn của control plane mà khách không được đọc (loại tài khoản · cách lập chứng từ · «workspace» · «người vận hành»). */
const INTERNAL_LABEL = /Khách ngoài|Hoá đơn khách|Chargeback|Nội bộ|workspace|người vận hành/i;
const INTERNAL_DTO_KEY = /^(type|billing|accountType|billingMode|account_type|billing_mode)$/;

const read = (f: string) => readFileSync(f, "utf8");
/** Mã nguồn bỏ chú thích — một đoạn GIẢI THÍCH nhắc tên hàm không phải là lời gọi. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ─────────────────────────── 1 · THUẦN + MÃ NGUỒN ───────────────────────────

function testPureAndSource() {
  assert.equal(brandProductKey("chotdon"), "chotdon");
  assert.equal(brandProductKey("vnx"), "erp", "danh mục: ERP do thương hiệu vnx bán");
  assert.equal(brandProductKey(null), null);
  assert.equal(brandProductKey("la"), null, "thương hiệu lạ ⇒ không đoán");

  const svc = read("lib/onboarding/service.ts");
  const install = svc.indexOf("installBlueprint(input.built.bp, subject)");
  const step = svc.indexOf("await openSetupSubscriptions(input);");
  const finish = svc.indexOf('step.current = "FINISH";');
  assert.ok(install > 0 && step > install && finish > step, "bước thuê bao chạy SAU khi mẫu đã bật module và TRƯỚC FINISH");
  const lib = code("lib/saas/signup-subscriptions.ts");
  assert.ok(/openSubscriptionsForProductsInUse\(/.test(lib) && !/insertSubscription\(|platformProductSubscriptions/.test(lib), "không luật mở thuê bao thứ hai — dùng lại hàm có sẵn");
  assert.ok(!/initWorkspaceBilling|setOrgBilling|platformSubscriptions/.test(lib + code("lib/saas/subscription-repair.ts")), "bước thuê bao / sửa bù không đụng thu phí hay dùng thử");
  const script = read("scripts/saas-subscription-repair.ts");
  assert.match(script, /const apply = process\.argv\.includes\("--apply"\);/, "script chỉ ghi khi có --apply");
  assert.match(script, /planSubscriptionRepair\(\{ apply, reason: arg\("reason"\), orgCode: arg\("org"\) \}\)/);
  assert.ok(!read(".github/workflows/ops-vps.yml").includes("saas-subscription-repair"), "chưa khai vào ops-vps.yml (chủ shop quyết)");
  for (const k of ["KHÔNG ghi lùi", "KHÔNG khởi tạo / bật thu phí", "KHÔNG tạo khoá", "Hết hạn — chỉ xem", "bảng kê nháp", "không đẻ dòng thứ hai"]) assert.ok(REPAIR_CONSEQUENCES.some((l) => l.includes(k)), `hệ quả phải nói: «${k}»`);
}

// ─────────────────────────── 2–6 · VÒNG THẬT ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, code));
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  // Tài khoản do `ensureAccountForWorkspace` đặt mã theo mã workspace.
  await pdb.delete(schema.platformAccounts).where(inArray(schema.platformAccounts.code, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSignupAttempts).where(or(inArray(schema.platformSignupAttempts.organizationCode, [...ORGS]), inArray(schema.platformSignupAttempts.ipHash, IPS.map(hashIp))));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePriceBook();
}

async function adminOf(code: string): Promise<SessionUser> {
  const org = await findOrganization(code);
  return withOrganization(code, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.role, "ADMIN") });
    assert.ok(u, `thiếu quản trị của ${code}`);
    return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: org?.name ?? code, isHome: false, brand: org?.brand ?? null }, modules: [...(await getEnabledModules(code))] };
  });
}

/** Băm các bảng control plane mà lượt sửa bù có thể chạm — chạy thử phải để chúng y nguyên. */
async function snapshot(): Promise<string> {
  const pdb = await getPlatformDb();
  const out: string[] = [];
  for (const t of ["platform_product_subscriptions", "platform_audit_log", "platform_accounts", "platform_subscriptions", "platform_organizations", "platform_price_pins"]) {
    const [r] = rowsOf<{ n: number; h: string }>(await pdb.execute(sql.raw(`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from ${t} x`)));
    out.push(`${t}=${r.n}:${r.h}`);
  }
  return out.join(" | ");
}

function render(view: MyProducts): string {
  // `tsx` biên dịch JSX của component theo runtime CỔ ĐIỂN (`tsconfig` để `jsx: preserve` cho Next) ⇒ cần `React` toàn cục khi dựng
  // ngoài Next. Chỉ trong tiến trình kiểm thử; component không đổi.
  (globalThis as { React?: typeof React }).React ??= React;
  return renderToStaticMarkup(createElement(MyProductsSection, { view }));
}

/** DTO + HTML của KHÁCH: không khoá / chữ nội bộ. */
function assertCustomerClean(view: MyProducts, html: string, label: string) {
  assert.equal(view.audience, "CUSTOMER", label);
  assert.equal(view.account, null, `${label}: khách không nhận loại tài khoản / cách lập chứng từ`);
  assert.deepEqual(internalKeyPaths(view, INTERNAL_DTO_KEY), [], `${label}: DTO không mang khoá nội bộ`);
  assert.deepEqual(stringHits(view, INTERNAL_LABEL), [], `${label}: DTO không mang nhãn nội bộ`);
  const text = html.replace(/<[^>]+>/g, " ");
  assert.ok(!INTERNAL_LABEL.test(text), `${label}: HTML không in nhãn nội bộ — ${text.slice(0, 300)}`);
}

async function withSignupEnv<T>(fn: () => Promise<T>): Promise<T> {
  const pdb = await getPlatformDb();
  const envBefore = process.env.PLATFORM_SIGNUP_MODE;
  const mode = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  const receiver = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
  process.env.PLATFORM_SIGNUP_MODE = "open";
  await pdb.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, [SIGNUP_MODE_SETTING_KEY, BILLING_RECEIVER_KEY]));
  await pdb.insert(schema.platformSettings).values({ key: SIGNUP_MODE_SETTING_KEY, value: "open", updatedByEmail: "ssu-test@local" });
  // Có tài khoản nhận tiền ⇒ cửa hàng tự đăng ký được bật thu phí + dùng thử (đường thật của production).
  await pdb.insert(schema.platformSettings).values({ key: BILLING_RECEIVER_KEY, value: { bin: "970422", accountNumber: "0123456789", accountName: "VNXCOMMERCE" }, updatedByEmail: "ssu-test@local" });
  invalidateSignupSetting();
  try {
    return await fn();
  } finally {
    if (envBefore === undefined) delete process.env.PLATFORM_SIGNUP_MODE;
    else process.env.PLATFORM_SIGNUP_MODE = envBefore;
    await pdb.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, [SIGNUP_MODE_SETTING_KEY, BILLING_RECEIVER_KEY]));
    for (const row of [mode, receiver]) if (row) await pdb.insert(schema.platformSettings).values({ key: row.key, value: row.value, updatedByEmail: row.updatedByEmail });
    invalidateSignupSetting();
  }
}

async function testLive() {
  const pdb = await getPlatformDb();
  const issue = async () => undefined;

  // ── 2 · TÁI HIỆN: thương hiệu Chốt Đơn, đăng ký nhanh «Chỉ cần AI bán hàng».
  const a = await quickSignup({ storeName: "SSU Chot Mot", businessType: "ai_sales", phone: "0912 345 711", email: "chu@ssu-a.vn", password: PW }, { kind: "public", ip: IPS[0] }, { issue, brand: "chotdon" });
  assert.ok("ok" in a && a.orgCode === CHOT && a.loggedIn, JSON.stringify(a));
  const subsA = await liveSubscriptions(CHOT);
  assert.deepEqual(subsA.map((s) => s.productKey), ["chotdon"], "cửa hàng tự đăng ký host Chốt Đơn có thuê bao Chốt Đơn (trước bản vá: 0 thuê bao)");
  const accountA = await accountOfWorkspace(CHOT);
  const rowA = subsA[0];
  assert.ok(accountA && rowA.accountId === accountA.id, "thuê bao thuộc đúng tài khoản của workspace");
  assert.ok(rowA.state === "ACTIVE" && rowA.planKey === null && rowA.source === "SIGNUP" && rowA.endedAt === null, `như luồng người vận hành: ACTIVE, theo gói workspace — ${JSON.stringify(rowA)}`);
  const orgA = await findOrganization(CHOT);
  assert.equal(salesAgentShell(orgA, [...(await getEnabledModules(CHOT))]), true, "thuê bao và vỏ app nói cùng một điều: khách Chốt Đơn");
  const logA = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, CHOT));
  assert.ok(logA.some((l) => l.action === "PRODUCT_SUBSCRIBE" && l.subject === "product:chotdon" && /\/start/.test(l.reason ?? "")), "có nhật ký PRODUCT_SUBSCRIBE mang lý do");
  const stA = (await readOnboarding(CHOT))?.subscriptions;
  assert.deepEqual(stA && { opened: stA.opened, inUse: stA.inUse, error: stA.error }, { opened: ["chotdon"], inUse: ["chotdon"], error: null }, "vết bước thuê bao trong trạng thái dựng");
  // Dùng thử: đọc từ thu phí đã chụp lúc đăng ký (không số ngày mới).
  assert.equal((await subscriptionStatusFor(CHOT, "chotdon")).status, "TRIAL", "tự đăng ký + đã khai tài khoản nhận tiền ⇒ «Dùng thử»");

  // ── 5 · TRANG GÓI của khách (dùng thử).
  const adminA = await adminOf(CHOT);
  const mine = await loadMyProducts(adminA);
  assert.ok(!("error" in mine));
  const expectedTrial = billingNotice(await orgBillingStanding({ code: CHOT, isHome: false }), true)?.text ?? null;
  assert.ok(expectedTrial && /còn \d+ ngày/.test(expectedTrial), String(expectedTrial));
  assert.equal(mine.products[0]?.trialNote, expectedTrial, "«còn N ngày» là đúng câu của dải nhắc dùng thử");
  const htmlA = render(mine);
  assertCustomerClean(mine, htmlA, "khách dùng thử");
  assert.ok(htmlA.includes(expectedTrial) && htmlA.includes("Chốt Đơn Tự Động") && htmlA.includes("Dùng thử"), htmlA.slice(0, 400));
  // Nhà: giữ nhãn nội bộ (người vận hành cần đọc).
  const home = await getHomeOrganization();
  const homeView = await loadMyProducts({ id: "ssu-op", email: "op@ssu.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } });
  assert.ok(!("error" in homeView) && homeView.audience === "HOME" && homeView.account !== null && /·/.test(render(homeView)), "nhà vẫn thấy loại tài khoản / chứng từ");

  // ── 2 · TÁI HIỆN: thương hiệu vnx, trình hướng dẫn đầy đủ, mẫu TMĐT (giao vận + tài chính) ⇒ khách ERP.
  const b = await createOrganizationFromSignup(
    { invite: null, org: { name: "SSU Vnx Erp", code: VNX }, admin: { name: "Chủ B", email: "chu@ssu-b.vn", password: PW }, plan: { businessType: "ecommerce", templateKey: "general-ecommerce", modules: ["customers", "products", "orders", "inventory", "logistics", "finance"] }, planKey: null },
    { kind: "public", ip: IPS[1] },
    { issue, brand: "vnx" },
  );
  assert.ok("ok" in b && b.created, JSON.stringify(b));
  assert.equal((await findOrganization(VNX))?.brand, "vnx");
  assert.deepEqual((await liveSubscriptions(VNX)).map((s) => s.productKey), ["erp"], "host VNX + mẫu ERP ⇒ thuê bao ERP (trước bản vá: 0 thuê bao)");

  // ── 3 · IDEMPOTENT.
  const again = await openSignupSubscriptions(CHOT, { actor: null, reason: "ssu kiểm idempotent", auditSource: "TEST" });
  assert.deepEqual(again, { ok: true, opened: [], inUse: ["chotdon"] });
  assert.deepEqual(await openSubscriptionsForProductsInUse(VNX, { actor: null, source: "TEST", reason: "ssu kiểm idempotent" }), []);
  const allRows = await pdb.select().from(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, [CHOT, VNX]));
  assert.equal(allRows.length, 2, "gọi lại không đẻ dòng thứ hai");

  // ── 4 · LỖI THẬT: workspace mất tài khoản ⇒ trả lỗi, KHÔNG ném, có vết.
  const accountB = await accountOfWorkspace(VNX);
  await pdb.update(schema.platformOrganizations).set({ accountId: null }).where(eq(schema.platformOrganizations.code, VNX));
  invalidateOrganizations();
  const broken = await openSignupSubscriptions(VNX, { actor: null, reason: "ssu kiểm lỗi thật", auditSource: "TEST" });
  assert.ok(!broken.ok && /chưa gắn tài khoản/.test(broken.error), JSON.stringify(broken));
  const brokenLog = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, VNX));
  assert.ok(brokenLog.some((l) => l.action === "ORG_SETUP" && l.subject === SIGNUP_SUBSCRIPTION_AUDIT_SUBJECT && /chưa gắn tài khoản/.test(l.reason ?? "")), "lỗi để lại dòng nhật ký nền tảng");
  await pdb.update(schema.platformOrganizations).set({ accountId: accountB!.id }).where(eq(schema.platformOrganizations.code, VNX));
  invalidateOrganizations();
  assert.deepEqual((await liveSubscriptions(VNX)).map((s) => s.productKey), ["erp"], "lỗi không xoá / không thêm thuê bao nào");

  // ── 4 · LỖI TIÊM ở bước thuê bao của /start: đăng ký vẫn xong, khách vẫn vào, vết đọc được.
  setOnboardingFaultForTests((s) => {
    if (s === "SUBSCRIPTIONS") throw new Error("ssu lỗi tiêm ở bước mở thuê bao");
  });
  let c;
  try {
    c = await quickSignup({ storeName: "SSU Chot Loi", businessType: "ai_sales", phone: "0912 345 713", email: "chu@ssu-c.vn", password: PW }, { kind: "public", ip: IPS[2] }, { issue, brand: "chotdon" });
  } finally {
    setOnboardingFaultForTests(null);
  }
  assert.ok("ok" in c && c.orgCode === FAIL && c.loggedIn, `lỗi mở thuê bao KHÔNG làm hỏng lượt đăng ký — ${JSON.stringify(c)}`);
  assert.equal((await findOrganization(FAIL))?.status, "ACTIVE");
  const stC = await readOnboarding(FAIL);
  assert.ok(stC?.state === "DONE" && stC.subscriptions?.error?.includes("ssu lỗi tiêm") && stC.subscriptions.opened.length === 0, `vết trong trạng thái dựng — ${JSON.stringify(stC?.subscriptions)}`);
  const logC = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, FAIL));
  assert.ok(logC.some((l) => l.action === "ORG_SETUP" && l.subject === SIGNUP_SUBSCRIPTION_AUDIT_SUBJECT && (l.after as { outcome?: string } | null)?.outcome === "FAILED" && /ssu lỗi tiêm/.test(l.reason ?? "")), "vết trong nhật ký nền tảng");
  assert.deepEqual(await liveSubscriptions(FAIL), []);
  const emptyView = await loadMyProducts(await adminOf(FAIL));
  assert.ok(!("error" in emptyView) && emptyView.products.length === 0);
  const emptyHtml = render(emptyView);
  assertCustomerClean(emptyView, emptyHtml, "khách chưa có thuê bao");
  assert.ok(emptyHtml.includes(MY_PRODUCTS_CUSTOMER_EMPTY) && !emptyHtml.includes("liên hệ người vận hành"), "trống ⇒ câu kinh doanh cho khách");

  // ── 6 · SỬA BÙ: chạy thử KHÔNG ghi gì.
  const before = await snapshot();
  const dry = await planSubscriptionRepair({});
  assert.equal(await snapshot(), before, "chạy thử không ghi một dòng nào");
  const mineDry = dry.candidates.filter((x) => (ORGS as readonly string[]).includes(x.orgCode));
  assert.deepEqual(mineDry.map((x) => x.orgCode), [FAIL], "chỉ workspace có thương hiệu đang thiếu thuê bao là đối tượng");
  const cand = mineDry[0];
  assert.ok(cand.action === "OPEN" && cand.toOpen.join() === "chotdon" && cand.brandProduct === "chotdon" && cand.onboardingSource === "OPEN" && cand.accountCode === FAIL, JSON.stringify(cand));
  assert.ok(cand.statusAfterOpen === "TRIAL" && cand.billing.terms === "ON" && cand.billing.trialEndsAt !== null && /còn \d+ ngày/.test(cand.billing.note), `báo trước tình trạng + mốc dùng thử — ${JSON.stringify(cand.billing)}`);
  // Ghi mà thiếu lý do ⇒ từ chối, không ghi.
  const noReason = await planSubscriptionRepair({ apply: true, reason: " ", orgCode: FAIL });
  assert.ok(noReason.error && noReason.results.length === 0 && (await snapshot()) === before, "thiếu lý do ⇒ không ghi");
  // Ghi thật — đi qua đúng hàm của /start; chạy lại không thêm.
  const applied = await planSubscriptionRepair({ apply: true, reason: "ssu kiểm sửa bù", orgCode: FAIL });
  assert.equal(applied.results.length, 1);
  assert.ok(applied.results[0].outcome.ok && applied.results[0].liveAfter.join() === "chotdon", JSON.stringify(applied.results));
  const repairedRow = (await liveSubscriptions(FAIL))[0];
  assert.ok(repairedRow?.source === "SIGNUP" && repairedRow.state === "ACTIVE" && repairedRow.planKey === null, "sửa bù mở đúng dòng như /start");
  const repairLog = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, FAIL));
  assert.ok(repairLog.some((l) => l.action === "PRODUCT_SUBSCRIBE" && /Sửa bù F-02/.test(l.reason ?? "") && /ssu kiểm sửa bù/.test(l.reason ?? "")), "nhật ký mang lý do sửa bù");
  const second = await planSubscriptionRepair({ apply: true, reason: "ssu kiểm sửa bù lần hai", orgCode: FAIL });
  assert.equal(second.candidates.length, 0, "đã đủ thuê bao ⇒ không còn là đối tượng");
  assert.equal((await pdb.select().from(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, FAIL))).length, 1, "chạy lại không thêm dòng");
}

export async function testSaasSignupSubscription() {
  testPureAndSource();
  await cleanup();
  try {
    await withSignupEnv(testLive);
  } finally {
    setOnboardingFaultForTests(null);
    await cleanup();
  }
  console.log("✓ F-02 · cửa hàng tự đăng ký có thuê bao: chotdon (đăng ký nhanh) ⇒ Chốt Đơn, vnx (mẫu TMĐT) ⇒ ERP, như luồng người vận hành (ACTIVE · gói workspace · nhật ký), dùng thử đọc từ thu phí; gọi lại không thêm dòng; lỗi mở thuê bao không làm hỏng đăng ký mà để vết (trạng thái dựng + nhật ký); trang Gói của khách không in nhãn nội bộ, trống ⇒ câu kinh doanh, dùng thử ⇒ «còn N ngày»; sửa bù chạy thử không ghi, thiếu lý do không ghi, ghi qua đúng hàm và chạy lại không thêm");
}
