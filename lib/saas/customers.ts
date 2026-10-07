/**
 * ═══════════ KHÁCH HÀNG 360 — READ MODEL CỦA OPERATOR CONSOLE (docs/saas/README.md §6) ═══════════
 *
 * MỘT hàm dựng toàn cảnh thương mại cho MỌI tài khoản — VNXCommerce đi đúng đường của Hải Sản Làng Chài, không component,
 * không nhánh riêng. Đọc mặt phẳng điều khiển (vài câu SQL gộp), không mở CSDL workspace nào; số dùng sâu trong CSDL
 * workspace (hạn mức kỳ) chỉ đọc ở trang chi tiết qua `lib/platform/usage-meter.ts`.
 *
 * Người gọi kiểm `platformOperatorDenial` TRƯỚC (console.ts) — hàm này nhìn xuyên mọi tài khoản.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { addonMonthlyVnd, parseAddonPrices, parseAddonUnits } from "@/lib/billing/addons";
import { billingStanding, vnDate, type BillingStandingKind } from "@/lib/billing/rules";
import { planKeyOf } from "@/lib/entitlements/check";
import { readEverPaidOrgs } from "@/lib/platform/saas-ledger";
import { readCommercialRegistry, type AccountRow, type SubscriptionRow, type WorkspaceRow } from "@/lib/saas/accounts";
import { allocateCosts, type AllocatedLine } from "@/lib/saas/allocation";
import { PRODUCTS, productDef, type ProductDef } from "@/lib/saas/catalog";
import { costInputs, currentPeriodMonth, readAiByWorkspaceProduct, readProductUsage, usdToVnd, type MetricReading } from "@/lib/saas/ledger";
import { effectiveSubscriptionStatus, marginApplicable, subscriptionGrantsUse, type BillingMode, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";
import { buildStatement, type PlanRef, type Statement, type StatementWorkspace } from "@/lib/saas/statement";
import { getPlanUsage } from "@/lib/entitlements/check";
import { readAiCustomerUsage, type AiCustomerReading } from "@/lib/pricing/ai-customer";
import { loadPriceBook } from "@/lib/pricing/price-book";
import { computeOverage, currentCatalogVersion, fairUseVerdict, priceOf, resolveOrgVersion, yearlyAmountVnd, type FairUseVerdict, type OverageResult, type PlanPrice, type PriceBook } from "@/lib/pricing/versions";
import { periodRange } from "@/lib/saas/ledger";

export type PlanInfo = PlanRef & { addonPrices: unknown; productKeys: string[] | null; commercial: unknown };

export type SubscriptionView = SubscriptionRow & { status: EffectiveSubscriptionStatus; planName: string; planSource: "WORKSPACE" | "OWN" };

/** Giá của workspace theo phiên bản giá ĐÃ GHIM (0228) + phần vượt / fair-use của kỳ. */
export type WorkspacePricing = {
  versionKey: string | null;
  versionLabel: string | null;
  pinned: boolean;
  price: PlanPrice | null;
  yearlyVnd: number | null;
  aiCustomers: AiCustomerReading | null;
  overage: OverageResult | null;
  fairUse: FairUseVerdict | null;
};

export type WorkspaceView = WorkspaceRow & {
  planKey: string;
  pricing: WorkspacePricing;
  standing: BillingStandingKind;
  subscriptions: SubscriptionView[];
  endedSubscriptions: SubscriptionRow[];
  aiCost: { productKey: string | null; platformVnd: number; byokUsd: number; requests: number; unpricedCalls: number }[];
  allocated: AllocatedLine[];
  usage: MetricReading[];
};

export type HealthFlag = "LOSING_MONEY" | "PAST_DUE" | "EXPIRED" | "PROVISIONING_FAILED" | "UNKNOWN_COST" | "NO_ACCOUNT_WORKSPACE" | "MODULE_DRIFT";

export const HEALTH_FLAG_LABEL: Record<HealthFlag, string> = {
  LOSING_MONEY: "Đang lỗ gộp",
  PAST_DUE: "Quá hạn thanh toán",
  EXPIRED: "Hết hạn — chỉ xem",
  PROVISIONING_FAILED: "Cấp phát hỏng",
  UNKNOWN_COST: "Có chi phí chưa biết",
  NO_ACCOUNT_WORKSPACE: "Workspace chưa gắn tài khoản",
  MODULE_DRIFT: "Module lệch thuê bao",
};

export type CustomerView = {
  account: AccountRow;
  workspaces: WorkspaceView[];
  products: string[];
  statement: Statement;
  economics: { revenueVnd: number | null; costVnd: number; grossProfitVnd: number | null; marginPct: number | null; marginApplicable: boolean; byokUsd: number };
  flags: HealthFlag[];
  failedJobs: number;
};

export type CommercialSnapshot = { periodMonth: string; customers: CustomerView[]; orphanWorkspaces: WorkspaceRow[]; plans: PlanInfo[]; usdToVnd: number };

/**
 * Gói cho màn người vận hành, giá theo BẢNG GIÁ ĐANG NIÊM YẾT (0228) — gói không còn trong bảng giá hiện hành hiện giá
 * legacy của nó. Giá RIÊNG của từng workspace (theo phiên bản đã ghim) nằm ở `WorkspaceView.pricing`.
 */
export async function readPlans(now: Date = new Date()): Promise<PlanInfo[]> {
  const pdb = await getPlatformDb();
  const [rows, book] = await Promise.all([pdb.select().from(schema.platformPlans).orderBy(schema.platformPlans.position), loadPriceBook()]);
  const catalog = currentCatalogVersion(book, now);
  return rows.map((r) => {
    const hit = priceOf(book, catalog?.key ?? null, r.key);
    const price = hit && !hit.price.contactSales ? hit.price.monthlyVnd : null;
    return { key: r.key, name: hit?.source === "VERSION" ? hit.price.name : r.name, priceVnd: price, addonPrices: hit?.price.addonPrices ?? {}, productKeys: r.productKeys ?? null, commercial: r.commercial ?? {} };
  });
}

function planRef(plans: readonly PlanInfo[], key: string): PlanRef {
  const p = plans.find((x) => x.key === key);
  return p ? { key: p.key, name: p.name, priceVnd: p.priceVnd } : { key, name: `${key} (không có trong bảng gói)`, priceVnd: null };
}

/** Gói theo PHIÊN BẢN GIÁ của workspace (0228): tên + giá tháng của phiên bản đã ghim; gói cũ theo dòng legacy. */
function versionedPlanRef(book: PriceBook, versionKey: string | null, plans: readonly PlanInfo[], key: string): { ref: PlanRef; price: PlanPrice | null } {
  const hit = priceOf(book, versionKey, key);
  if (!hit) return { ref: { ...planRef(plans, key), priceVnd: null }, price: null };
  return { ref: { key, name: hit.source === "LEGACY_FALLBACK" ? `${hit.price.name} (giá cũ)` : hit.price.name, priceVnd: hit.price.contactSales ? null : hit.price.monthlyVnd }, price: hit.price };
}

/** Toàn cảnh thương mại của kỳ. `periodMonth` mặc định tháng hiện tại (giờ VN). */
export async function loadCommercialSnapshot(opts: { periodMonth?: string; now?: Date; catalog?: readonly ProductDef[] } = {}): Promise<CommercialSnapshot> {
  const now = opts.now ?? new Date();
  const periodMonth = opts.periodMonth ?? currentPeriodMonth(now);
  const catalog = opts.catalog ?? PRODUCTS;
  const pdb = await getPlatformDb();
  const [registry, plans, terms, everPaid, ai, usage, costs, failed, book, pins] = await Promise.all([
    readCommercialRegistry(),
    readPlans(),
    pdb.select().from(schema.platformSubscriptions),
    readEverPaidOrgs(),
    readAiByWorkspaceProduct(periodMonth, catalog),
    readProductUsage(periodMonth, catalog),
    costInputs(periodMonth),
    pdb
      .select({ accountId: schema.platformProvisioningJobs.accountId, orgCode: schema.platformProvisioningJobs.orgCode, n: sql<number>`count(*)::int` })
      .from(schema.platformProvisioningJobs)
      .where(eq(schema.platformProvisioningJobs.status, "FAILED"))
      .groupBy(schema.platformProvisioningJobs.accountId, schema.platformProvisioningJobs.orgCode),
    loadPriceBook(),
    pdb
      .select({ orgCode: schema.platformPricePins.orgCode, versionKey: schema.platformPricePins.versionKey })
      // Lỗi đọc ghim ⇒ NÉM (không lập / không chốt bảng kê): ghim rỗng sẽ tính mọi workspace theo bảng giá hiện hành và chốt
      // vĩnh viễn giá mới cho khách giá cũ.
      .from(schema.platformPricePins),
  ]);
  const pinBy = new Map(pins.map((p) => [p.orgCode, p.versionKey]));
  // Khách AI (đồng hồ thu chính) kèm độ phủ, cho mọi workspace — đọc sổ dùng chung ở mặt phẳng điều khiển.
  const range = periodRange(periodMonth);
  const aiCustomers = await readAiCustomerUsage(
    registry.workspaces.map((w) => w.code),
    range,
    now,
  ).catch(() => new Map<string, AiCustomerReading>());
  const today = vnDate(now);
  const termsBy = new Map(terms.map((t) => [t.orgCode, t]));
  const accountById = new Map(registry.accounts.map((a) => [a.id, a]));

  // Phân bổ chi phí trên MỌI workspace đang chạy (cả nhà): chi phí AI nền tảng trả là trọng số của AI_COST_SHARE.
  const liveSubs = registry.subscriptions.filter((s) => !s.endedAt);
  const aiPlatformVnd = (code: string) => [...(ai.get(code)?.values() ?? [])].reduce((a, c) => a + usdToVnd(c.platform.costUsd), 0);
  const allocation = allocateCosts({
    workspaces: registry.workspaces.map((w) => ({ orgCode: w.code, accountId: w.accountId, active: w.status === "ACTIVE", products: liveSubs.filter((s) => s.orgCode === w.code).map((s) => s.productKey), aiCostVnd: aiPlatformVnd(w.code) })),
    declared: costs.declared,
    entries: costs.entries,
  });

  const workspaceView = async (w: WorkspaceRow, mode: BillingMode): Promise<WorkspaceView> => {
    const planKey = planKeyOf({ isHome: w.isHome, plan: w.plan });
    const t = termsBy.get(w.code);
    const standing = billingStanding(t ? { billingEnabled: t.billingEnabled, paidThrough: t.paidThrough, graceDays: t.graceDays } : null, today).kind;
    const subs = registry.subscriptions.filter((s) => s.orgCode === w.code);
    const live = subs.filter((s) => !s.endedAt);
    const version = resolveOrgVersion(book, pinBy.get(w.code) ?? null, now);
    // Gói RIÊNG của thuê bao Chốt Đơn (0224 `plan_key`) thắng gói workspace khi tính phần vượt khách AI — đường gán gói thường
    // cho khách nội bộ (`lib/pricing/internal-fit.ts`) ghi ở đây, không đụng nhánh gói của workspace nhà.
    const chotdonOwn = live.find((s) => s.productKey === "chotdon" && s.planKey)?.planKey ?? null;
    const price = (chotdonOwn ? versionedPlanRef(book, version.version?.key ?? null, plans, chotdonOwn).price : null) ?? versionedPlanRef(book, version.version?.key ?? null, plans, planKey).price;
    const ac = aiCustomers.get(w.code) ?? null;
    const wsUsage = usage.get(w.code) ?? [];
    // Phần vượt chỉ khi phiên bản của workspace có luật vượt THẬT (giá cũ ⇒ không có) — số người dùng / fanpage chỉ đọc khi cần.
    let overage: OverageResult | null = null;
    let fairUse: FairUseVerdict | null = null;
    if (price && price.overage.mode === "BILLED") {
      const usersUsed = await getPlanUsage(w.code)
        .then((u) => u.rows.find((r) => r.kind === "users")?.used ?? null)
        .catch(() => null);
      const fanpages = await latestFanpages(w.code, range.fromDay, range.toDay);
      const conv = wsUsage.find((u) => u.productKey === "chotdon" && u.metric === "conversations_started")?.value ?? null;
      const replies = wsUsage.find((u) => u.productKey === "chotdon" && u.metric === "bot_messages")?.value ?? null;
      overage = computeOverage(price, { aiCustomers: ac?.value ?? null, aiCustomersCoverage: ac?.coverage ?? "NOT_MEASURED", fanpages, users: usersUsed, aiConversations: conv, aiReplies: replies });
      fairUse = fairUseVerdict({ aiConversations: conv, aiReplies: replies }, price.included, version.version?.alerts);
    }
    return {
      ...w,
      planKey,
      pricing: { versionKey: version.version?.key ?? null, versionLabel: version.version?.label ?? null, pinned: version.pinned, price, yearlyVnd: price ? yearlyAmountVnd(price) : null, aiCustomers: ac, overage, fairUse },
      standing,
      subscriptions: live.map((s) => ({
        ...s,
        status: effectiveSubscriptionStatus({ state: s.state as "ACTIVE" | "PAUSED" | "CANCELED", billingMode: mode, standing, hasPaidInvoice: everPaid.has(w.code) }),
        planName: planRef(plans, s.planKey ?? planKey).name,
        planSource: s.planKey ? "OWN" : "WORKSPACE",
      })),
      endedSubscriptions: subs.filter((s) => s.endedAt),
      aiCost: [...(ai.get(w.code)?.entries() ?? [])].map(([productKey, c]) => ({ productKey, platformVnd: usdToVnd(c.platform.costUsd), byokUsd: c.byok.costUsd, requests: c.platform.requests + c.byok.requests, unpricedCalls: c.platform.unpriced })),
      allocated: allocation.byWorkspace.get(w.code) ?? [],
      // Chỉ số khách AI đọc KÈM độ phủ (runtime cũ chưa ghi ⇒ `null`, không phải 0 của sổ trống).
      usage: wsUsage.map((u) => (u.productKey === "chotdon" && u.metric === "ai_customers" ? { ...u, value: ac?.value ?? null, note: ac?.note ?? u.note } : u)),
    };
  };

  const customers: CustomerView[] = [];
  for (const account of registry.accounts) {
    const mode = account.billingMode as BillingMode;
    const workspaces: WorkspaceView[] = [];
    for (const w of registry.workspaces.filter((x) => x.accountId === account.id)) workspaces.push(await workspaceView(w, mode));
    const stWorkspaces: StatementWorkspace[] = workspaces.map((w) => {
      const t = termsBy.get(w.code);
      const vk = w.pricing.versionKey;
      const wsPlan = versionedPlanRef(book, vk, plans, w.planKey);
      return {
        orgCode: w.code,
        name: w.name,
        // Giá gói + mua thêm theo PHIÊN BẢN đã ghim (0228) — khách nội bộ và khách ngoài cùng một phép tính.
        plan: wsPlan.ref,
        addon: addonMonthlyVnd(parseAddonUnits(t?.addons), parseAddonPrices(wsPlan.price?.addonPrices)),
        subscriptions: w.subscriptions.map((s) => ({ productKey: s.productKey, ownPlan: s.planKey ? versionedPlanRef(book, vk, plans, s.planKey).ref : null, status: s.status })),
        overage: [],
        billedOverage: (w.pricing.overage?.lines ?? []).map((l) => ({ productKey: l.key === "aiCustomers" ? "chotdon" : null, label: l.label, quantity: l.blocks ?? l.overUnits, unitPriceVnd: l.unitVnd, amountVnd: l.amountVnd, note: l.note })),
        aiCost: w.aiCost.map((c) => ({ productKey: c.productKey, vnd: c.platformVnd, unpricedCalls: c.unpricedCalls })),
        allocated: w.allocated,
      };
    });
    const statement = buildStatement({ billingMode: mode, periodMonth, workspaces: stWorkspaces, accountCosts: allocation.byAccount.get(account.id) ?? [] });
    // Kinh tế: doanh thu = phần khách trả (gói · mua thêm · vượt); chi phí = AI nền tảng trả + phân bổ + trực tiếp.
    const aiVnd = workspaces.reduce((a, w) => a + w.aiCost.reduce((b, c) => b + c.platformVnd, 0), 0);
    const allocKnown = [...workspaces.flatMap((w) => w.allocated), ...(allocation.byAccount.get(account.id) ?? [])].reduce((a, l) => a + (l.amountVnd ?? 0), 0);
    const costVnd = aiVnd + allocKnown;
    const applicable = marginApplicable(mode);
    const revenueLines = statement.lines.filter((l) => l.kind === "PLAN" || l.kind === "PRODUCT_PLAN" || l.kind === "ADDON" || l.kind === "OVERAGE");
    const revenueKnown = revenueLines.every((l) => l.amountVnd !== null);
    const revenueVnd = applicable ? (revenueKnown ? statement.revenueKnownVnd : null) : null;
    const grossProfitVnd = revenueVnd === null ? null : revenueVnd - costVnd;
    const marginPct = revenueVnd && grossProfitVnd !== null ? Math.round((grossProfitVnd / revenueVnd) * 1000) / 10 : null;
    const unknownCost = workspaces.some((w) => w.aiCost.some((c) => c.unpricedCalls > 0) || w.allocated.some((l) => l.amountVnd === null));
    const failedJobs = failed.filter((f) => f.accountId === account.id || workspaces.some((w) => w.code === f.orgCode)).reduce((a, f) => a + Number(f.n), 0);
    const statuses = workspaces.flatMap((w) => w.subscriptions.map((s) => s.status));
    const flags: HealthFlag[] = [];
    if (grossProfitVnd !== null && grossProfitVnd < 0) flags.push("LOSING_MONEY");
    if (statuses.includes("PAST_DUE")) flags.push("PAST_DUE");
    if (statuses.includes("EXPIRED")) flags.push("EXPIRED");
    if (failedJobs) flags.push("PROVISIONING_FAILED");
    if (unknownCost) flags.push("UNKNOWN_COST");
    customers.push({
      account,
      workspaces,
      products: [...new Set(workspaces.flatMap((w) => w.subscriptions.filter((s) => subscriptionGrantsUse(s.status)).map((s) => s.productKey)))],
      statement,
      economics: { revenueVnd, costVnd, grossProfitVnd, marginPct, marginApplicable: applicable, byokUsd: workspaces.reduce((a, w) => a + w.aiCost.reduce((b, c) => b + c.byokUsd, 0), 0) },
      flags,
      failedJobs,
    });
  }
  return { periodMonth, customers, orphanWorkspaces: registry.workspaces.filter((w) => !w.accountId || !accountById.has(w.accountId)), plans, usdToVnd: usdToVnd(1) };
}

/** Fanpage đang chạy ở ảnh chụp MỚI NHẤT trong kỳ (sổ dùng theo ngày 0204). `null` = chưa chụp / chưa đo được — không phải 0. */
async function latestFanpages(orgCode: string, fromDay: string, toDay: string): Promise<number | null> {
  try {
    const pdb = await getPlatformDb();
    const u = schema.platformTenantUsageDaily;
    const [r] = await pdb
      .select({ n: u.fanpagesActive })
      .from(u)
      .where(sql`${u.orgCode} = ${orgCode} and ${u.day} >= ${fromDay} and ${u.day} <= ${toDay}`)
      .orderBy(desc(u.day))
      .limit(1);
    return r?.n ?? null;
  } catch {
    return null;
  }
}

/** Kinh tế theo SẢN PHẨM: khách, thuê bao, doanh thu gói phân về sản phẩm, chi phí AI của sản phẩm. */
export type ProductEconomics = { product: ProductDef; customers: number; liveSubscriptions: number; byStatus: Partial<Record<EffectiveSubscriptionStatus, number>>; aiCostVnd: number; directCostVnd: number; revenueVnd: number | null; revenueNote: string | null; usage: { metric: string; label: string; unit: string; total: number | null }[] };

/**
 * Doanh thu gói GỘP không chia được về sản phẩm một cách trung thực (giá gộp là một con số) — nên doanh thu sản phẩm chỉ
 * cộng dòng gói RIÊNG của sản phẩm (PRODUCT_PLAN) + vượt hạn mức của sản phẩm; phần gói gộp in riêng và nói rõ là gộp.
 */
export function productEconomics(snap: CommercialSnapshot, catalog: readonly ProductDef[] = PRODUCTS): ProductEconomics[] {
  return catalog.map((product) => {
    const subs = snap.customers.flatMap((c) => c.workspaces.flatMap((w) => w.subscriptions.filter((s) => s.productKey === product.key)));
    const byStatus: Partial<Record<EffectiveSubscriptionStatus, number>> = {};
    for (const s of subs) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const customers = snap.customers.filter((c) => c.workspaces.some((w) => w.subscriptions.some((s) => s.productKey === product.key))).length;
    const aiCostVnd = snap.customers.reduce((a, c) => a + c.workspaces.reduce((b, w) => b + w.aiCost.filter((x) => x.productKey === product.key).reduce((d, x) => d + x.platformVnd, 0), 0), 0);
    const directCostVnd = snap.customers.reduce((a, c) => a + c.workspaces.reduce((b, w) => b + w.allocated.filter((l) => l.productKey === product.key).reduce((d, l) => d + (l.amountVnd ?? 0), 0), 0), 0);
    const ext = snap.customers.filter((c) => c.economics.marginApplicable);
    const own = ext.flatMap((c) => c.statement.lines.filter((l) => (l.kind === "PRODUCT_PLAN" || l.kind === "OVERAGE") && l.productKey === product.key));
    const bundled = ext.flatMap((c) => c.statement.lines.filter((l) => l.kind === "PLAN")).length;
    const unknown = own.some((l) => l.amountVnd === null);
    const usage = product.metrics.map((m) => {
      const vals = snap.customers.flatMap((c) => c.workspaces.flatMap((w) => w.usage.filter((u) => u.productKey === product.key && u.metric === m.key).map((u) => u.value)));
      const known = vals.filter((v): v is number => v !== null);
      return { metric: m.key, label: m.label, unit: m.unit, total: known.length ? known.reduce((a, b) => a + b, 0) : null };
    });
    return {
      product,
      customers,
      liveSubscriptions: subs.length,
      byStatus,
      aiCostVnd,
      directCostVnd,
      revenueVnd: unknown ? null : own.reduce((a, l) => a + (l.amountVnd ?? 0), 0),
      revenueNote: bundled ? `${bundled} workspace trả theo gói GỘP — doanh thu gộp không chia về từng sản phẩm` : null,
      usage,
    };
  });
}

/** Nhật ký nền tảng của một tài khoản: dòng cấp tài khoản + dòng của mọi workspace thuộc nó. */
export async function accountAuditTrail(account: AccountRow, orgCodes: readonly string[], limit = 50) {
  const pdb = await getPlatformDb();
  const l = schema.platformAuditLog;
  const where = orgCodes.length ? sql`(${l.targetAccountId} = ${account.id} OR ${inArray(l.targetOrgCode, [...orgCodes])})` : eq(l.targetAccountId, account.id);
  return pdb.select().from(l).where(where).orderBy(desc(l.at)).limit(limit);
}

export async function accountProvisioningJobs(account: AccountRow, orgCodes: readonly string[], limit = 20) {
  const pdb = await getPlatformDb();
  const j = schema.platformProvisioningJobs;
  const where = orgCodes.length ? sql`(${j.accountId} = ${account.id} OR ${inArray(j.orgCode, [...orgCodes])})` : eq(j.accountId, account.id);
  return pdb.select().from(j).where(where).orderBy(desc(j.createdAt)).limit(limit);
}

/** Kênh / người đã đăng nhập theo workspace — từ chỉ mục ở mặt phẳng điều khiển, không mở CSDL workspace. */
export async function workspaceReach(orgCodes: readonly string[]): Promise<Map<string, { identities: number; lastLoginAt: Date | null; messengerPages: number }>> {
  const out = new Map<string, { identities: number; lastLoginAt: Date | null; messengerPages: number }>();
  if (!orgCodes.length) return out;
  const pdb = await getPlatformDb();
  const i = schema.platformIdentities;
  const p = schema.platformMessengerPages;
  const [ids, pages] = await Promise.all([
    pdb.select({ orgCode: i.orgCode, n: sql<number>`count(distinct ${i.userId})::int`, last: sql<Date | string | null>`max(${i.lastUsedAt})` }).from(i).where(inArray(i.orgCode, [...orgCodes])).groupBy(i.orgCode),
    pdb.select({ orgCode: p.orgCode, n: sql<number>`count(*)::int` }).from(p).where(inArray(p.orgCode, [...orgCodes])).groupBy(p.orgCode),
  ]);
  for (const c of orgCodes) out.set(c, { identities: 0, lastLoginAt: null, messengerPages: 0 });
  for (const r of ids) out.set(r.orgCode, { ...out.get(r.orgCode)!, identities: Number(r.n), lastLoginAt: r.last ? new Date(r.last) : null });
  for (const r of pages) out.set(r.orgCode, { ...out.get(r.orgCode)!, messengerPages: Number(r.n) });
  return out;
}

/** Bảng kê đã chốt của tài khoản (mới nhất trước). */
export async function finalizedStatements(accountId: string) {
  const pdb = await getPlatformDb();
  const b = schema.platformBillingStatements;
  return pdb.select().from(b).where(eq(b.accountId, accountId)).orderBy(desc(b.periodMonth)).limit(24);
}

/** Thuê bao có module của sản phẩm đang TẮT, hoặc module bật mà chưa có thuê bao — lệch giữa thương mại và kỹ thuật. */
export function moduleDrift(productsInUse: readonly string[], live: readonly Pick<SubscriptionRow, "productKey" | "state">[]): { missingSubscription: string[]; subscribedButOff: string[] } {
  const subscribed = new Set(live.filter((s) => s.state !== "CANCELED").map((s) => s.productKey));
  return {
    missingSubscription: productsInUse.filter((p) => !subscribed.has(p)),
    subscribedButOff: [...subscribed].filter((p) => !productsInUse.includes(p) && productDef(p)),
  };
}

