/**
 * SAAS CONTROL PLANE (0224 · docs/saas/README.md).
 *
 *  1. THUẦN — danh mục (không miền nào hai chủ, mọi module có đúng một nhà), suy sản phẩm từ module, tình trạng thuê bao
 *     hiệu lực, phân bổ chi phí (tổng phân bổ BẰNG ĐÚNG số khai, chưa khai ⇒ null), bộ máy bảng kê (dùng thử = 0 thật, gói
 *     không giá ⇒ chưa biết, chargeback cộng chi phí thật, vượt hạn mức có / không đơn giá).
 *  2. MÃ NGUỒN — không chỗ nào ngoài `lib/saas/policy.ts` + bộ máy bảng kê so loại tài khoản / cách lập chứng từ (khách nội
 *     bộ không có nhánh mã riêng); danh sách module trong backfill SQL = sổ module.
 *  3. MIGRATION — VNXCommerce là tài khoản INTERNAL / chargeback với thuê bao ERP + Chốt Đơn; luật backfill SQL và
 *     `productsFromModules` cho CÙNG kết quả trên cùng dữ liệu (kể cả runtime bot cũ bật / tắt).
 *  4. CUSTOMER03 — tạo khách CHỈ qua job cấp phát (không sửa CSDL tay): tài khoản → workspace → thuê bao → module → quản trị
 *     → liên kết kích hoạt; gửi lại cùng khoá không chạy lại; thuê thêm ERP; huỷ Chốt Đơn thu hồi module; job hỏng chạy lại.
 *  5. PRODUCT03 — một danh mục thử có sản phẩm thứ ba: sổ dùng, đọc dùng, suy sản phẩm, cấp phát, bảng kê chạy KHÔNG đổi
 *     một dòng mã lõi.
 *  6. CÔ LẬP — người của workspace khách (kể cả khi tài khoản của họ bị đặt INTERNAL, kể cả khi được gán `platform:operate`)
 *     không mở được console; người nhà không có quyền vận hành cũng không; cổng khách chỉ thấy workspace của phiên; SDK lấy
 *     workspace từ ngữ cảnh máy chủ; sổ dùng gắn tài khoản do máy chủ tra.
 *  7. CHỐT BẢNG KÊ — chỉ kỳ đã qua, một lần, bất biến.
 *
 * Mốc thời gian: kỳ dựng từ đồng hồ thật (`currentPeriodMonth(new Date())`), không ghim ngày (AGENTS mục 50 · 65).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { MODULE_KEYS } from "@/lib/constants/platform-modules";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { accountMergeCandidates, accountOfWorkspace, ensureAccountForWorkspace, liveSubscriptions, productsInUse, updateAccount } from "@/lib/saas/accounts";
import { allocateCosts, splitInteger } from "@/lib/saas/allocation";
import { finalizeStatement } from "@/lib/saas/billing";
import { PRODUCTS, SHARED_COMMERCE_CORE, domainOwnershipConflicts, modulesToProvision, productsFromModules, type ProductDef } from "@/lib/saas/catalog";
import { createCustomerAsOperator, loadCustomerDetail, loadCustomersConsole, loadProductsConsole } from "@/lib/saas/console";
import { loadCommercialSnapshot } from "@/lib/saas/customers";
import { productEntitlement } from "@/lib/saas/entitlements";
import { addCostEntry, currentPeriodMonth, readProductUsage, recordUsage } from "@/lib/saas/ledger";
import { effectiveSubscriptionStatus } from "@/lib/saas/policy";
import { loadMyProducts } from "@/lib/saas/portal";
import { requestProvisioning, retryJob } from "@/lib/saas/provisioning";
import { currentWorkspace, productContext } from "@/lib/saas/sdk";
import { buildStatement, type StatementWorkspace } from "@/lib/saas/statement";

const PREFIX = "sp-";
const C3 = "sp-c3";
const ORGS = ["sp-ai", "sp-erp", "sp-both", "sp-core", "sp-legacy", "sp-c3", "sp-noacct", "sp-p3"] as const;

function user(over: Partial<SessionUser>): SessionUser {
  return { id: "sp-user", email: "sp@local", name: "SP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformCostEntries).where(like(schema.platformCostEntries.description, "sp-test%"));
  await pdb.delete(schema.platformProvisioningJobs).where(like(schema.platformProvisioningJobs.idempotencyKey, "sp-%"));
  const accts = await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts).where(like(schema.platformAccounts.code, `${PREFIX}%`));
  if (accts.length) await pdb.delete(schema.platformBillingStatements).where(inArray(schema.platformBillingStatements.accountId, accts.map((a) => a.id)));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, code));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  if (accts.length) await pdb.delete(schema.platformAccounts).where(inArray(schema.platformAccounts.id, accts.map((a) => a.id)));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
}

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function testPure() {
  // Danh mục: không miền nào hai chủ; mỗi module thuộc lõi chung HOẶC đúng một sản phẩm.
  assert.deepEqual(domainOwnershipConflicts(), [], "một miền dữ liệu chỉ có MỘT sản phẩm làm nguồn sự thật");
  for (const m of MODULE_KEYS) {
    const owners = PRODUCTS.filter((p) => p.exclusiveModules.includes(m)).length + (SHARED_COMMERCE_CORE.includes(m) ? 1 : 0);
    assert.equal(owners, 1, `module ${m} phải thuộc đúng một nhà (lõi chung hoặc một sản phẩm)`);
  }
  for (const p of PRODUCTS) for (const c of p.capabilities) for (const m of c.modules) assert.ok((MODULE_KEYS as readonly string[]).includes(m), `${p.key}.${c.key}: module lạ ${m}`);

  // Suy sản phẩm từ module.
  const set = (...m: string[]) => new Set(m);
  assert.deepEqual(productsFromModules(set("core", "work", "customers", "products", "orders", "inventory", "ai_sales")), ["chotdon"], "shop «Chỉ cần AI bán hàng» KHÔNG là khách ERP");
  assert.deepEqual(productsFromModules(set("core", "customers", "products", "orders", "logistics")), ["erp"]);
  assert.deepEqual(productsFromModules(set("core", "orders", "ai_sales", "finance")).sort(), ["chotdon", "erp"]);
  assert.deepEqual(productsFromModules(set("core", "work")), []);
  assert.deepEqual(productsFromModules(set("core", "orders", "connector_pancake"), { legacyChatbotOn: true }).sort(), ["chotdon", "erp"], "bot nhà = runtime cũ của Chốt Đơn");
  assert.deepEqual(productsFromModules(set("core", "orders", "connector_pancake"), { legacyChatbotOn: false }), ["erp"]);
  assert.ok(modulesToProvision(PRODUCTS.find((p) => p.key === "chotdon")!).includes("inventory"), "Chốt Đơn cấp kèm lõi thương mại (hỏi tồn, tạo đơn)");

  // Tình trạng thuê bao hiệu lực — bảng chân lý.
  const st = (state: "ACTIVE" | "PAUSED" | "CANCELED", billingMode: "INTERNAL_CHARGEBACK" | "EXTERNAL_INVOICE", standing: "NOT_BILLED" | "ACTIVE" | "DUE_SOON" | "OVERDUE" | "LOCKED", hasPaidInvoice = false) => effectiveSubscriptionStatus({ state, billingMode, standing, hasPaidInvoice });
  assert.equal(st("CANCELED", "EXTERNAL_INVOICE", "ACTIVE", true), "CANCELED");
  assert.equal(st("PAUSED", "INTERNAL_CHARGEBACK", "NOT_BILLED"), "PAUSED");
  assert.equal(st("ACTIVE", "INTERNAL_CHARGEBACK", "LOCKED"), "ACTIVE", "chargeback nội bộ không có hạn trả tiền");
  assert.equal(st("ACTIVE", "EXTERNAL_INVOICE", "LOCKED", true), "EXPIRED");
  assert.equal(st("ACTIVE", "EXTERNAL_INVOICE", "OVERDUE", true), "PAST_DUE");
  assert.equal(st("ACTIVE", "EXTERNAL_INVOICE", "DUE_SOON", false), "TRIAL", "thu phí bật mà chưa trả lần nào = dùng thử");
  assert.equal(st("ACTIVE", "EXTERNAL_INVOICE", "ACTIVE", true), "ACTIVE");
  assert.equal(st("ACTIVE", "EXTERNAL_INVOICE", "NOT_BILLED"), "ACTIVE");

  // Chia số nguyên: tổng bằng đúng; trọng số 0 ⇒ không chia.
  assert.deepEqual(splitInteger(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(splitInteger(1_000_003, [2, 5, 3])!.reduce((a, b) => a + b, 0), 1_000_003);
  assert.equal(splitInteger(10, [0, 0]), null);

  // Phân bổ: khai nền chia đều workspace đang chạy (KỂ CẢ nhà); chưa khai ⇒ null; AI share theo tỷ trọng; trực tiếp đúng chỗ.
  const ws = [
    { orgCode: "home", accountId: "a-int", active: true, products: ["erp", "chotdon"], aiCostVnd: 300 },
    { orgCode: "x", accountId: "a-x", active: true, products: ["chotdon"], aiCostVnd: 100 },
    { orgCode: "dead", accountId: "a-x", active: false, products: ["chotdon"], aiCostVnd: 999 },
  ];
  const al = allocateCosts({
    workspaces: ws,
    declared: { infraMonthlyVnd: 1_000_001, supportMonthlyVnd: null },
    entries: [
      { id: "e1", label: "Zalo ZNS", category: "MESSAGING", scope: "PRODUCT", productKey: "chotdon", accountId: null, orgCode: null, basis: "AI_COST_SHARE", amountVnd: 400 },
      { id: "e2", label: "API riêng", category: "EXTERNAL_API", scope: "WORKSPACE", productKey: "erp", accountId: "a-x", orgCode: "x", basis: "DIRECT", amountVnd: 50 },
      { id: "e3", label: "Hợp đồng riêng", category: "OTHER", scope: "ACCOUNT", productKey: null, accountId: "a-x", orgCode: null, basis: "DIRECT", amountVnd: 70 },
    ],
  });
  const infra = (c: string) => al.byWorkspace.get(c)!.find((l) => l.entryId === "declared:infra")!.amountVnd;
  assert.equal(infra("home")! + infra("x")!, 1_000_001, "tổng phân bổ bằng đúng số khai");
  assert.equal(al.byWorkspace.get("dead"), undefined, "workspace không chạy không gánh chi phí");
  assert.equal(al.byWorkspace.get("home")!.find((l) => l.entryId === "declared:support")!.amountVnd, null, "chưa khai ⇒ CHƯA BIẾT, không phải 0");
  assert.equal(al.byWorkspace.get("home")!.find((l) => l.entryId === "e1")!.amountVnd, 300);
  assert.equal(al.byWorkspace.get("x")!.find((l) => l.entryId === "e1")!.amountVnd, 100);
  assert.equal(al.byWorkspace.get("x")!.find((l) => l.entryId === "e2")!.amountVnd, 50);
  assert.equal(al.byAccount.get("a-x")![0].amountVnd, 70);
  const noAi = allocateCosts({ workspaces: [{ ...ws[1], aiCostVnd: 0 }], declared: { infraMonthlyVnd: null, supportMonthlyVnd: null }, entries: [{ id: "e9", label: "x", category: "OTHER", scope: "PLATFORM", productKey: null, accountId: null, orgCode: null, basis: "AI_COST_SHARE", amountVnd: 10 }] });
  assert.equal(noAi.unallocated.length, 1, "không có căn cứ chia ⇒ để riêng, không chia đều lặng lẽ");

  // Bảng kê — cùng hàm cho hai cách lập chứng từ.
  const base: StatementWorkspace = { orgCode: "w", name: "W", plan: { key: "growth", name: "Tăng trưởng", priceVnd: 999_000 }, addon: { ok: true, vnd: 79_000 }, subscriptions: [{ productKey: "chotdon", ownPlan: null, status: "ACTIVE" }, { productKey: "erp", ownPlan: null, status: "ACTIVE" }], overage: [], aiCost: [{ productKey: "chotdon", vnd: 26_000, unpricedCalls: 0 }], allocated: [{ entryId: "declared:infra", label: "Hạ tầng", category: "INFRA", basis: "EQUAL_ACTIVE_WORKSPACES", productKey: null, amountVnd: 40_000, note: null }] };
  const ext = buildStatement({ billingMode: "EXTERNAL_INVOICE", periodMonth: "2026-10-01", workspaces: [base] });
  assert.equal(ext.lines.filter((l) => l.kind === "PLAN").length, 1, "gói gộp tính MỘT lần cho workspace dù thuê hai sản phẩm");
  assert.equal(ext.totalKnownVnd, 1_078_000);
  assert.equal(ext.lines.some((l) => l.kind === "AI_COST"), false, "hoá đơn khách không mang chi phí nội bộ");
  const trial = buildStatement({ billingMode: "EXTERNAL_INVOICE", periodMonth: "2026-10-01", workspaces: [{ ...base, subscriptions: base.subscriptions.map((s) => ({ ...s, status: "TRIAL" as const })) }] });
  assert.equal(trial.lines[0].amountVnd, 0);
  assert.equal(trial.unknownLines, 0, "dùng thử là 0 THẬT");
  const internal = buildStatement({ billingMode: "INTERNAL_CHARGEBACK", periodMonth: "2026-10-01", workspaces: [{ ...base, plan: { key: "internal", name: "Nội bộ", priceVnd: null }, addon: { ok: true, vnd: 0 } }] });
  assert.equal(internal.lines.find((l) => l.kind === "PLAN")!.amountVnd, null, "gói nội bộ chưa khai giá ⇒ chưa biết");
  assert.equal(internal.costKnownVnd, 66_000, "chargeback cộng chi phí biến đổi thật");
  assert.equal(internal.unknownLines, 1);
  const over = buildStatement({ billingMode: "EXTERNAL_INVOICE", periodMonth: "2026-10-01", workspaces: [{ ...base, overage: [{ productKey: "chotdon", label: "Hội thoại AI", included: 950, used: 1_000, unitPriceVnd: 500 }, { productKey: "chotdon", label: "Tin AI", included: 10, used: 20, unitPriceVnd: null }] }] });
  assert.equal(over.lines.find((l) => l.label === "Hội thoại AI")!.amountVnd, 25_000);
  assert.equal(over.lines.find((l) => l.label === "Tin AI")!.amountVnd, null, "vượt mà chưa khai đơn giá ⇒ chưa biết, không phải 0");
  const paused = buildStatement({ billingMode: "EXTERNAL_INVOICE", periodMonth: "2026-10-01", workspaces: [{ ...base, subscriptions: [{ productKey: "chotdon", ownPlan: null, status: "PAUSED" }] }] });
  assert.equal(paused.lines.length, 0, "thuê bao tạm dừng không sinh dòng tính tiền");

  // Gợi ý gộp: theo từ đầu của tên, chỉ khách ngoài, KHÔNG tự gộp.
  const cand = accountMergeCandidates([
    { id: "1", code: "hslc-vgcnj", name: "HSLC Shop", accountType: "EXTERNAL" },
    { id: "2", code: "hslc-hmt", name: "HSLC_HMT", accountType: "EXTERNAL" },
    { id: "3", code: "vnxcommerce", name: "VNXCommerce", accountType: "INTERNAL" },
  ]);
  assert.deepEqual(cand, [{ stem: "hslc", accounts: ["hslc-vgcnj", "hslc-hmt"] }]);
}

// ─────────────────────────── 2 · MÃ NGUỒN ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

function testSource() {
  // Khách nội bộ không có nhánh mã riêng: chỉ chính sách + bộ máy bảng kê được hỏi loại tài khoản / cách lập chứng từ.
  const ALLOWED = new Set(["lib/saas/policy.ts", "lib/saas/statement.ts"]);
  const bad: string[] = [];
  for (const f of [...walk("lib"), ...walk("app"), ...walk("components")]) {
    if (ALLOWED.has(f)) continue;
    const src = readFileSync(f, "utf8");
    if (/(accountType|billingMode|account_type|billing_mode)\s*[!=]==?\s*["'`]/.test(src) || /["'`](INTERNAL|INTERNAL_CHARGEBACK)["'`]\s*[!=]==/.test(src)) bad.push(f);
  }
  assert.deepEqual(bad, [], "so loại tài khoản / cách lập chứng từ ngoài lib/saas/policy.ts — khách nội bộ phải đi đúng đường khách ngoài");

  // Backfill SQL dùng ĐÚNG sổ module + ĐÚNG lõi chung.
  const mig = readFileSync("drizzle/0224_saas_control_plane.sql", "utf8");
  const values = [...mig.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(values)].sort(), [...MODULE_KEYS].sort(), "danh sách module trong backfill SQL phải bằng MODULE_KEYS");
  const notIn = mig.match(/module_key NOT IN \(([^)]+)\)/)![1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(notIn.sort(), [...SHARED_COMMERCE_CORE, ...PRODUCTS.find((p) => p.key === "chotdon")!.exclusiveModules].sort(), "luật ERP trong SQL = lõi chung + module độc quyền của Chốt Đơn");

  // Runtime sản phẩm không biết giá: không tệp nào ngoài lib/saas, lib/billing, lib/pricing, màn giá đọc price_vnd.
  const priceReaders = walk("lib/sales-chatbot").filter((f) => /priceVnd|price_vnd|unitPricesVnd/.test(readFileSync(f, "utf8")));
  assert.deepEqual(priceReaders, [], "runtime AI bán hàng không được đọc giá thuê bao");
}

// ─────────────────────────── 3 · MIGRATION ───────────────────────────

async function testMigration(home: { code: string }) {
  const pdb = await getPlatformDb();
  const acct = await accountOfWorkspace(home.code);
  assert.ok(acct, "workspace nhà có tài khoản sau 0224");
  assert.equal(acct.code, "vnxcommerce");
  assert.equal(acct.name, "VNXCommerce");
  assert.equal(acct.accountType, "INTERNAL");
  assert.equal(acct.billingMode, "INTERNAL_CHARGEBACK");
  const subs = (await liveSubscriptions(home.code)).map((s) => s.productKey).sort();
  assert.deepEqual(subs, ["chotdon", "erp"], "VNXCommerce thuê ERP + Chốt Đơn như khách");
  assert.deepEqual((await productsInUse(home.code)).sort(), subs, "TS và backfill SQL đồng ý cho workspace nhà");

  // Parity SQL ↔ TS trên các bộ module khác nhau. Bộ module ĐÓNG dưới phụ thuộc như mọi dữ liệu thật (mọi lượt ghi module đi
  // qua `validateModuleChange`); bộ hở thì TS bỏ module thiếu phụ thuộc còn SQL đọc dòng thô — không có trên production.
  const sets: Record<string, string[]> = {
    "sp-ai": ["core", "work", "customers", "products", "orders", "inventory", "ai_sales"],
    "sp-erp": ["core", "work", "customers", "products", "orders", "logistics"],
    "sp-both": ["core", "work", "customers", "products", "orders", "inventory", "ai_sales", "finance"],
    "sp-core": ["core", "work"],
    "sp-legacy": ["core", "work", "customers", "products", "orders", "connector_pancake"],
  };
  for (const [code, modules] of Object.entries(sets)) await provisionOrganization({ code, name: code.toUpperCase(), modules, source: "TEST", actor: null });
  const backfill = readFileSync("drizzle/0224_saas_control_plane.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .find((s) => s.includes("WITH mods AS"))!;
  const check = async (label: string) => {
    await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, Object.keys(sets)));
    await pdb.execute(sql.raw(backfill));
    for (const code of Object.keys(sets)) {
      const sqlSide = (await liveSubscriptions(code)).map((s) => s.productKey).sort();
      invalidateCapabilities(code);
      const tsSide = (await productsInUse(code)).sort();
      assert.deepEqual(sqlSide, tsSide, `${label} · ${code}: SQL ${JSON.stringify(sqlSide)} ≠ TS ${JSON.stringify(tsSide)}`);
    }
  };
  await check("runtime cũ bật");
  const legacy = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, "sp-legacy") });
  await pdb.update(schema.platformOrganizationModules).set({ features: { "connector_pancake.chatbot": false } }).where(sql`${schema.platformOrganizationModules.organizationId} = ${legacy!.id} and ${schema.platformOrganizationModules.moduleKey} = 'connector_pancake'`);
  invalidateCapabilities("sp-legacy");
  await check("runtime cũ tắt");
  assert.deepEqual((await liveSubscriptions("sp-legacy")).map((s) => s.productKey), ["erp"]);
  assert.deepEqual((await liveSubscriptions("sp-ai")).map((s) => s.productKey), ["chotdon"]);
}

// ─────────────────────────── 4 · CUSTOMER03 ───────────────────────────

async function testCustomer03(op: SessionUser) {
  const period = currentPeriodMonth(new Date());
  const r = await createCustomerAsOperator(op, {
    account: { code: "sp-customer03", name: "Customer 03", accountType: "EXTERNAL" },
    workspace: { code: C3, name: "Customer 03 Shop", planKey: "starter", brand: "chotdon" },
    products: ["chotdon"],
    admin: { email: "owner@c3.local", name: "Chủ C3" },
    idempotencyKey: "sp-c3-create",
    reason: "Bài kiểm Customer03",
  });
  assert.ok("ok" in r, JSON.stringify(r));
  assert.equal(r.status, "SUCCEEDED");
  assert.ok(r.activationLink && r.activationLink.includes("/reset"), "quản trị nhận liên kết kích hoạt dùng một lần (không mật khẩu nào lộ ra)");
  const acct = await accountOfWorkspace(C3);
  assert.equal(acct?.code, "sp-customer03");
  assert.equal(acct?.billingMode, "EXTERNAL_INVOICE");
  assert.deepEqual((await liveSubscriptions(C3)).map((s) => s.productKey), ["chotdon"], "chỉ thuê Chốt Đơn — lõi thương mại không biến khách thành khách ERP");
  const admin = await withOrganization(C3, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "owner@c3.local") }));
  assert.equal(admin?.role, "ADMIN");
  const pdb = await getPlatformDb();
  const job = await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.idempotencyKey, "sp-c3-create") });
  assert.ok(!JSON.stringify(job).toLowerCase().includes("password"), "job không mang mật khẩu");
  assert.deepEqual((job!.steps as { key: string }[]).map((s) => s.key), ["ACCOUNT", "WORKSPACE", "ADMIN", "SUBSCRIPTIONS", "BILLING"]);

  // Gửi lại cùng khoá ⇒ cùng job, không chạy lại.
  const again = await createCustomerAsOperator(op, { account: { code: "sp-customer03", name: "Customer 03", accountType: "EXTERNAL" }, workspace: { code: C3, name: "Customer 03 Shop", planKey: "starter", brand: "chotdon" }, products: ["chotdon"], admin: { email: "owner@c3.local", name: "Chủ C3" }, idempotencyKey: "sp-c3-create", reason: "Bấm hai lần" });
  assert.ok("ok" in again && again.jobId === r.jobId);
  assert.equal((await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.id, r.jobId) }))!.attempts, 1);

  // Entitlement: thuê bao cho dùng ∧ module bật ∧ tính năng theo gói Khởi đầu (không có cross_sell).
  const ent = await productEntitlement(C3, "chotdon");
  assert.equal(ent.status, "ACTIVE");
  assert.ok(ent.capabilities.find((c) => c.key === "ai_sales")!.modulesOn);
  assert.equal(ent.features.find((f) => f.key === "ai_sales")!.effective, true);
  assert.equal(ent.features.find((f) => f.key === "cross_sell")!.effective, false, "tính năng ngoài gói bị chặn bằng entitlement, không bằng tên gói");

  // Thuê thêm ERP qua job; huỷ Chốt Đơn thu hồi module.
  const sub = await requestProvisioning({ kind: "SUBSCRIBE_PRODUCT", orgCode: C3, productKey: "erp" }, { actor: null, email: null, source: "TEST", idempotencyKey: "sp-c3-erp" });
  assert.ok("job" in sub && sub.job.status === "SUCCEEDED", JSON.stringify(sub));
  assert.deepEqual((await liveSubscriptions(C3)).map((s) => s.productKey).sort(), ["chotdon", "erp"]);
  const cd = (await liveSubscriptions(C3)).find((s) => s.productKey === "chotdon")!;
  const cancel = await requestProvisioning({ kind: "CANCEL_SUBSCRIPTION", subscriptionId: cd.id, reason: "Khách thôi dùng AI" }, { actor: null, email: null, source: "TEST", idempotencyKey: "sp-c3-cancel" });
  assert.ok("job" in cancel && cancel.job.status === "SUCCEEDED", JSON.stringify(cancel));
  invalidateCapabilities(C3);
  const after = await productEntitlement(C3, "chotdon");
  assert.equal(after.status, null);
  assert.equal(after.capabilities.find((c) => c.key === "ai_sales")!.modulesOn, false, "huỷ = thu hồi module độc quyền");
  assert.ok(after.features.every((f) => !f.effective));
  assert.ok((await productEntitlement(C3, "erp")).capabilities.find((c) => c.key === "commerce_core")!.modulesOn, "lõi thương mại ERP còn cần thì không bị tắt");

  // Job hỏng → sửa nguyên nhân → chạy lại thành công.
  await pdb.insert(schema.platformOrganizations).values({ code: "sp-noacct", name: "No account", status: "ACTIVE", isHome: false, moduleDefault: "DISABLED" });
  invalidateOrganizations();
  const failed = await requestProvisioning({ kind: "SUBSCRIBE_PRODUCT", orgCode: "sp-noacct", productKey: "chotdon" }, { actor: null, email: null, source: "TEST", idempotencyKey: "sp-noacct-sub" });
  assert.ok("job" in failed && failed.job.status === "FAILED" && /chưa gắn tài khoản/.test(failed.job.lastError ?? ""), JSON.stringify(failed));
  await ensureAccountForWorkspace("sp-noacct", { accountId: acct!.id, source: "TEST", actor: null });
  const retried = await retryJob(failed.job.id, { actor: null, email: null, source: "TEST" });
  assert.ok(!("error" in retried) && retried.status === "SUCCEEDED" && retried.attempts === 2, JSON.stringify(retried));

  // Một tài khoản, hai workspace — tài khoản là đơn vị của bảng kê.
  const snap = await loadCommercialSnapshot({ periodMonth: period });
  const c = snap.customers.find((x) => x.account.code === "sp-customer03")!;
  assert.deepEqual(c.workspaces.map((w) => w.code).sort(), ["sp-c3", "sp-noacct"]);
  assert.equal(c.statement.billingMode, "EXTERNAL_INVOICE");
  assert.equal(c.economics.marginApplicable, true);
}

// ─────────────────────────── 5 · PRODUCT03 ───────────────────────────

async function testProduct03() {
  const erp = PRODUCTS.find((p) => p.key === "erp")!;
  const p3: ProductDef = {
    key: "leadhunt",
    name: "Lead Hunter",
    brand: "vnx",
    description: "Sản phẩm thứ ba thử nghiệm",
    capabilities: [{ key: "scan", label: "Quét khách sỉ", modules: ["stays"], features: [] }],
    exclusiveModules: ["stays"],
    provisionModules: ["stays"],
    needsCommerceCore: false,
    aiFeatures: ["lead_hunter_v2"],
    metrics: [{ key: "leads_found", label: "Lead tìm được", unit: "lead", source: "EVENT_LEDGER", emitterLive: true, billable: true }],
    ownedDomains: ["wholesale_lead"],
  };
  const catalog: ProductDef[] = [{ ...erp, exclusiveModules: erp.exclusiveModules.filter((m) => m !== "stays") }, ...PRODUCTS.filter((p) => p.key !== "erp"), p3];
  assert.deepEqual(domainOwnershipConflicts(catalog), []);

  await provisionOrganization({ code: "sp-p3", name: "P3", modules: ["core"], source: "TEST", actor: null });
  const job = await requestProvisioning({ kind: "SUBSCRIBE_PRODUCT", orgCode: "sp-p3", productKey: "leadhunt" }, { actor: null, email: null, source: "TEST", idempotencyKey: "sp-p3-sub", catalog });
  assert.ok("job" in job && job.job.status === "SUCCEEDED", JSON.stringify(job));
  invalidateCapabilities("sp-p3");
  assert.ok((await liveSubscriptions("sp-p3")).some((s) => s.productKey === "leadhunt"));

  const period = currentPeriodMonth(new Date());
  const r1 = await recordUsage({ orgCode: "sp-p3", productKey: "leadhunt", metric: "leads_found", quantity: 7, eventKey: "scan:1", source: "test" }, catalog);
  const r2 = await recordUsage({ orgCode: "sp-p3", productKey: "leadhunt", metric: "leads_found", quantity: 7, eventKey: "scan:1", source: "test-retry" }, catalog);
  await recordUsage({ orgCode: "sp-p3", productKey: "leadhunt", metric: "leads_found", quantity: 3, eventKey: "scan:2", source: "test" }, catalog);
  assert.deepEqual([r1.recorded, r2.recorded], [true, false], "gửi lại cùng khoá không đếm hai lần");
  const usage = (await readProductUsage(period, catalog)).get("sp-p3")!;
  assert.equal(usage.find((u) => u.productKey === "leadhunt" && u.metric === "leads_found")!.value, 10);
  await assert.rejects(() => recordUsage({ orgCode: "sp-p3", productKey: "chotdon", metric: "ai_calls", quantity: 1, eventKey: "x", source: "t" }), /AI_LEDGER/, "chỉ số AI không ghi lần hai vào sổ chung");
  const pdb = await getPlatformDb();
  const ev = await pdb.query.platformUsageEvents.findFirst({ where: eq(schema.platformUsageEvents.eventKey, "scan:1") });
  assert.equal(ev!.accountId, (await accountOfWorkspace("sp-p3"))!.id, "tài khoản do MÁY CHỦ tra từ workspace");

  const st = buildStatement({ billingMode: "EXTERNAL_INVOICE", periodMonth: period, workspaces: [{ orgCode: "sp-p3", name: "P3", plan: { key: "trial", name: "Dùng thử", priceVnd: null }, addon: { ok: true, vnd: 0 }, subscriptions: [{ productKey: "leadhunt", ownPlan: { key: "lh-basic", name: "Lead Hunter cơ bản", priceVnd: 300_000 }, status: "ACTIVE" }], overage: [{ productKey: "leadhunt", label: "Lead vượt", included: 5, used: 10, unitPriceVnd: 2_000 }], aiCost: [], allocated: [] }] });
  assert.equal(st.totalKnownVnd, 310_000, "bảng kê tính sản phẩm thứ ba bằng đúng bộ máy cũ");
}

// ─────────────────────────── 6 · CÔ LẬP ───────────────────────────

async function testIsolation(op: SessionUser, home: { code: string; name: string }) {
  const tenantAdmin = user({ id: "sp-tenant", email: "admin@c3.local", permissions: ["platform:operate"], organization: { code: C3, name: "C3", isHome: false } });
  for (const fn of [() => loadCustomersConsole(tenantAdmin), () => loadCustomerDetail(tenantAdmin, "vnxcommerce"), () => loadProductsConsole(tenantAdmin)]) {
    const r = await fn();
    assert.ok(r && "error" in r, "ADMIN workspace khách (kể cả được gán platform:operate) không mở console");
  }
  // Đặt tài khoản của C3 là INTERNAL: vẫn không nhìn được khách khác.
  const acct = (await accountOfWorkspace(C3))!;
  await updateAccount(acct.id, { accountType: "INTERNAL", billingMode: "INTERNAL_CHARGEBACK" }, { actor: null, source: "TEST", reason: "thử leo quyền" });
  const r = await loadCustomersConsole(tenantAdmin);
  assert.ok("error" in r, "INTERNAL không mặc nhiên có quyền xuyên tenant");
  const w = await createCustomerAsOperator(tenantAdmin, { account: { name: "Ăn cắp", accountType: "EXTERNAL" }, workspace: { code: "sp-evil", name: "x", planKey: "trial" }, products: ["chotdon"], admin: { email: "a@b.cc", name: "x" }, idempotencyKey: "sp-evil-1", reason: "leo quyền" });
  assert.ok("error" in w);
  await updateAccount(acct.id, { accountType: "EXTERNAL", billingMode: "EXTERNAL_INVOICE" }, { actor: null, source: "TEST", reason: "trả lại" });
  // Người nhà KHÔNG có quyền vận hành.
  const homeCs = user({ id: "sp-cs", role: "CS", organization: { code: home.code, name: home.name, isHome: true } });
  assert.ok("error" in (await loadCustomersConsole(homeCs)), "người workspace nhà không có platform:operate cũng bị từ chối");
  // Người vận hành nhìn được.
  const ok = await loadCustomersConsole(op);
  assert.ok(!("error" in ok));

  // Cổng khách: chỉ workspace của phiên; không tham số nào đổi được workspace.
  const mine = await loadMyProducts(tenantAdmin);
  assert.ok(!("error" in mine));
  assert.equal(mine.workspace.code, C3);
  assert.equal(loadMyProducts.length, 1, "loadMyProducts chỉ nhận phiên");
  assert.ok(!JSON.stringify(mine).includes("costUsd") && !JSON.stringify(mine).includes("vnxcommerce"), "cổng khách không mang chi phí nền tảng hay khách khác");

  // SDK: workspace từ ngữ cảnh máy chủ.
  const ctx = await withOrganization(C3, () => currentWorkspace());
  assert.equal(ctx.orgCode, C3);
  const pc = await withOrganization("sp-ai", () => productContext("chotdon"));
  assert.equal(pc.workspace.orgCode, "sp-ai");
}

// ─────────────────────────── 7 · VNX NỘI BỘ · BẢNG KÊ ───────────────────────────

async function testInternalAndStatements(op: SessionUser, home: { code: string }) {
  const period = currentPeriodMonth(new Date());
  await addCostEntry({ periodMonth: period, category: "MESSAGING", scope: "PRODUCT", productKey: "chotdon", basis: "EQUAL_ACTIVE_WORKSPACES", amountVnd: 90_000, description: "sp-test Zalo ZNS" }, { actor: null, email: null, reason: "bài kiểm", source: "TEST" });
  const dup = await addCostEntry({ periodMonth: period, category: "MESSAGING", scope: "PRODUCT", productKey: "chotdon", basis: "EQUAL_ACTIVE_WORKSPACES", amountVnd: 90_000, description: "sp-test Zalo ZNS" }, { actor: null, email: null, reason: "bấm lại", source: "TEST" });
  assert.equal(dup.created, false, "cùng khoản chi không ghi hai lần");

  const list = await loadCustomersConsole(op);
  assert.ok(!("error" in list));
  const vnx = list.customers.find((c) => c.workspaces.some((w) => w.code === home.code))!;
  assert.equal(vnx.account.code, "vnxcommerce");
  assert.equal(vnx.account.accountType, "INTERNAL");
  assert.deepEqual(vnx.products.sort(), ["chotdon", "erp"]);
  assert.ok(vnx.workspaces[0].subscriptions.every((s) => s.status === "ACTIVE"));
  assert.equal(vnx.statement.billingMode, "INTERNAL_CHARGEBACK");
  assert.equal(vnx.economics.marginApplicable, false);
  assert.equal(vnx.economics.revenueVnd, null, "chargeback nội bộ không phải doanh thu thị trường — N/A, không bịa");
  assert.ok(vnx.statement.lines.some((l) => l.kind === "ALLOCATED_COST" && l.label.includes("Zalo")), "khách nội bộ gánh phần chi phí chung như khách ngoài");
  // Cùng cấu trúc cho khách ngoài.
  const ext = list.customers.find((c) => c.account.code === "sp-customer03")!;
  assert.deepEqual(Object.keys(ext).sort(), Object.keys(vnx).sort());

  const detail = await loadCustomerDetail(op, "vnxcommerce");
  assert.ok(detail && !("error" in detail));
  assert.ok(detail.entitlements[home.code].length === 2);

  // Chốt bảng kê: kỳ đang chạy bị từ chối; kỳ trước chốt được đúng một lần.
  const now = new Date();
  assert.ok("error" in (await finalizeStatement("sp-customer03", period, { actor: null, email: null, reason: "chốt sớm", source: "TEST" })));
  const [y, m] = period.split("-").map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`;
  const f1 = await finalizeStatement("sp-customer03", prev, { actor: null, email: null, reason: "chốt kỳ trước", source: "TEST", now });
  assert.ok("ok" in f1, JSON.stringify(f1));
  const f2 = await finalizeStatement("sp-customer03", prev, { actor: null, email: null, reason: "chốt lại", source: "TEST", now });
  assert.ok("error" in f2, "bảng kê đã chốt bất biến");
}

export async function testSaasPlatform() {
  await cleanup();
  try {
    testPure();
    testSource();
    const home = await getHomeOrganization();
    const op = user({ id: "sp-op", email: "op@sp.local", organization: { code: home.code, name: home.name, isHome: true } });
    await testMigration(home);
    await testCustomer03(op);
    await testProduct03();
    await testIsolation(op, home);
    await testInternalAndStatements(op, home);
    console.log("✓ SaaS Control Plane: danh mục · chính sách · phân bổ · bảng kê · backfill SQL = TS · Customer03 qua job (idempotent, huỷ, chạy lại) · Product03 không đổi lõi · cô lập console/cổng khách/SDK · VNXCommerce nội bộ cùng đường khách ngoài · chốt kỳ bất biến");
  } finally {
    await cleanup();
  }
}
