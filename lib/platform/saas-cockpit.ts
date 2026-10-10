import { desc, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { BILLING_STANDING_LABEL, vnDate, type BillingStandingKind } from "@/lib/billing/rules";
import { listPlans } from "@/lib/entitlements/check";
import { env } from "@/lib/env";
import { acceptanceWorkspaceOf } from "@/lib/constants/saas-acceptance-registry";
import { listOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { readAiBalancePeriod } from "@/lib/billing/ai-balance";
import { aiBalanceRevenueVnd } from "@/lib/billing/ai-balance-rules";
import {
  captureSaasSnapshot,
  readAiUsageByOrg,
  readCostDeclaration,
  readEverPaidOrgs,
  readFirstSnapshotDay,
  readLastLoginByOrg,
  readMilestones,
  readSaasDaily,
  readUsageDaily,
  readUsageTotals,
  type AiUsageByOrg,
  type UsageTotals,
} from "@/lib/platform/saas-ledger";
import {
  ACTIVATED_AT,
  activationFunnel,
  aiCostVnd,
  monthRange,
  periodMovement,
  platformMargin,
  SAAS_METRICS_VERSION,
  tenantEconomics,
  tenantLifecycle,
  trendOf,
  TENANT_LIFECYCLES,
  type ActivationMilestone,
  type FunnelStep,
  type PeriodMovement,
  type PlatformCostDeclaration,
  type PlatformMargin,
  type SaasDailyRow,
  type TenantEconomics,
  type TenantLifecycle,
  type Trend,
  type WeekBucket,
  weeklyBuckets,
} from "@/lib/platform/saas-metrics";

/**
 * ═══════════ OWNER COCKPIT — DỮ LIỆU MÀN `/platform/saas` (docs/productization/12_OWNER_COCKPIT_SPEC.md) ═══════════
 *
 * Chỉ máy chủ, chỉ người vận hành nền tảng (`platformOperatorDenial` hỏi TRƯỚC mọi lượt đọc — S21). Không trả nội dung
 * hội thoại, tên khách, khoá, email người dùng của khách: chỉ số tiền, số đếm, mốc thời gian theo MÃ tổ chức.
 */

/** Ảnh chụp hôm nay cũ hơn ngần này thì lượt mở trang / job `alerts` chụp lại (kèm quét mốc kích hoạt). */
export const SNAPSHOT_REFRESH_MS = 30 * 60_000;
/** Job `alerts` của nhà chạy 10 phút/lần — chỉ cần chụp vài lần mỗi ngày để có ảnh chụp cuối ngày gần đúng giờ. */
export const SAAS_SNAPSHOT_JOB_EVERY_MS = 6 * 60 * 60_000;
/** Cửa sổ đọc sổ AI / xu hướng. */
export const AI_WINDOW_DAYS = 30;

/**
 * Chụp ảnh hôm nay nếu chưa có hoặc đã cũ — idempotent, an toàn khi gọi dồn (job `alerts` 10 phút/lần, lượt mở trang).
 * Trả `null` khi ảnh chụp còn mới.
 */
export async function ensureSaasSnapshot(now: Date = new Date(), maxAgeMs: number = SNAPSHOT_REFRESH_MS, source: "JOB" | "PAGE" = "PAGE") {
  const pdb = await getPlatformDb();
  const t = schema.platformSaasDaily;
  const [last] = await pdb.select({ at: t.capturedAt }).from(t).where(eq(t.day, vnDate(now))).orderBy(desc(t.capturedAt)).limit(1);
  if (last && now.getTime() - last.at.getTime() < maxAgeMs) {
    // Ảnh MRR còn mới (lượt mở trang vừa chụp) nhưng ảnh GIÁ TRỊ hôm nay chưa có ⇒ đường job vẫn chạy: không thì một người vận hành mở
    // trang đều tay sẽ giữ ảnh MRR luôn "mới" và job không bao giờ tới lượt chụp giá trị (0240).
    if (source !== "JOB") return null;
    const { tenantValueDue } = await import("@/lib/saas/tenant-value-capture");
    if (!(await tenantValueDue(await listOrganizations(), now))) return null;
  }
  return captureSaasSnapshot(now, { source });
}

/** Lượt ké job `alerts` của nhà: một câu cho chi tiết lượt chạy, `null` khi ảnh chụp còn mới. Không bao giờ ném. */
export async function saasSnapshotForJob(now: Date = new Date()): Promise<string | null> {
  try {
    const r = await ensureSaasSnapshot(now, SAAS_SNAPSHOT_JOB_EVERY_MS, "JOB");
    if (!r) return null;
    const tv = r.tenantValue;
    const slowest = tv?.orgs.reduce<{ orgCode: string; ms: number } | null>((m, o) => (!m || o.ms > m.ms ? o : m), null) ?? null;
    const value = tv ? ` · ảnh giá trị ${tv.status}: ${tv.orgs.length}/${tv.targets} tổ chức, ${tv.totalMs} ms (sổ nhà ${tv.homeMs} ms${slowest ? `, chậm nhất ${slowest.ms} ms` : ""})${tv.errors.length ? `, lỗi nguồn ${tv.errors.length}` : ""}` : "";
    return `sổ SaaS ${r.day}: ${r.orgs} tổ chức, MRR ${r.mrrVnd.toLocaleString("vi-VN")} ₫, +${r.milestonesAdded} mốc${value}${r.errors.length ? ` (lỗi: ${r.errors.slice(0, 2).join(" | ")})` : ""}`;
  } catch (e) {
    return `sổ SaaS hỏng: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`;
  }
}

export type TenantRow = {
  code: string;
  name: string;
  status: string;
  isHome: boolean;
  templateKey: string | null;
  planKey: string;
  planName: string;
  standing: BillingStandingKind;
  standingLabel: string;
  lifecycle: TenantLifecycle;
  economics: TenantEconomics;
  byokAiCostUsd: number;
  homeAiCostVnd: number;
  aiRequests30d: number;
  aiTrend: Trend;
  /** Lỗi / tổng lượt AI 30 ngày; `null` khi chưa có lượt nào. */
  aiErrorRate: number | null;
  lastLoginAt: string | null;
  milestonesReached: number;
  activated: boolean;
  /** Số ngày từ lúc tạo tới mốc «đã kích hoạt» — `null` khi chưa tới / chưa có mốc tạo. */
  daysToActivation: number | null;
  daysToFirstAiOrder: number | null;
  /** Sổ dùng 30 ngày (0204). `null` = chưa có ngày nào trong sổ — khác 0. */
  usage30d: UsageTotals | null;
  /** Hội thoại / đơn AI theo 4 tuần gần nhất (cũ trước) — tuần chưa có ngày nào trong sổ là `null`. */
  usageWeeks: WeekBucket[];
  /** Xu hướng hội thoại tuần này so tuần trước (cùng luật `trendOf`: dưới 10 hội thoại ⇒ «—»). */
  usageTrend: Trend;
};

export type OwnerCockpit = {
  generatedAt: string;
  today: string;
  version: string;
  ledgerSince: string | null;
  usdToVnd: number;
  headline: {
    mrrVnd: number;
    arrVnd: number;
    tenants: number;
    payingTenants: number;
    arpaVnd: number | null;
    byLifecycle: Record<TenantLifecycle, number>;
  };
  thisMonth: { label: string; movement: PeriodMovement };
  lastMonth: { label: string; movement: PeriodMovement };
  margin: PlatformMargin & { aiComplete: boolean; windowDays: number; aiBalanceRevenueVnd: number };
  ai: { requests: number; platformCostVnd: number; byokCostUsd: number; homeCostVnd: number; unpricedRequests: number; errorRate: number | null; tenantsUsingAi: number; conversations: number | null; aiActiveConversations: number | null; aiOrders: number | null; usageDays: number };
  activation: FunnelStep[];
  activationOrgs: number;
  tenants: TenantRow[];
  costs: PlatformCostDeclaration;
  captureErrors: string[];
  /**
   * Workspace KIỂM THỬ của ops nghiệm thu (sổ khai) — KHÔNG vào bất kỳ con số nào ở trên (không phải khách). Chi phí AI của nó là
   * tiền thật nền tảng trả cho lượt nghiệm thu, nên in RIÊNG ở đây thay vì giấu đi.
   */
  testWorkspaces: { codes: string[]; aiRequests: number; platformAiCostVnd: number };
};

const DAY = 86_400_000;

function prevMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

const daysBetween = (a: Date | undefined, b: Date | undefined) => (a && b ? Math.max(0, (b.getTime() - a.getTime()) / DAY) : null);

function sumAi(rows: Iterable<AiUsageByOrg>) {
  let requests = 0;
  let errors = 0;
  const platform = { costUsd: 0, requests: 0, unpricedRequests: 0 };
  let byok = 0;
  let home = 0;
  let unpriced = 0;
  for (const r of rows) {
    requests += r.requests;
    errors += r.errors;
    platform.costUsd += r.platform.costUsd;
    platform.requests += r.platform.requests;
    platform.unpricedRequests += r.platform.unpricedRequests;
    byok += r.byok.costUsd;
    home += r.home.costUsd;
    unpriced += r.platform.unpricedRequests + r.byok.unpricedRequests + r.home.unpricedRequests;
  }
  return { requests, errors, platform, byok, home, unpriced };
}

function usageTrendOf(rows: Parameters<typeof weeklyBuckets>[0], today: string): { usageWeeks: WeekBucket[]; usageTrend: Trend } {
  const usageWeeks = weeklyBuckets(rows, today);
  const [prev, last] = usageWeeks.slice(-2);
  return { usageWeeks, usageTrend: last?.conversations === null || prev?.conversations === null ? "NONE" : trendOf(last.conversations ?? 0, prev.conversations ?? 0) };
}

/** Cộng sổ dùng của tổ chức KHÁCH (bỏ nhà). Chưa có dòng nào ⇒ `null`, không phải 0. */
function usageHeadline(usage: Map<string, UsageTotals>, home: Set<string>) {
  const rows = [...usage.entries()].filter(([code]) => !home.has(code)).map(([, v]) => v);
  if (!rows.length) return { conversations: null, aiActiveConversations: null, aiOrders: null, usageDays: 0 };
  return {
    conversations: rows.reduce((s, r) => s + r.conversationsStarted, 0),
    aiActiveConversations: rows.reduce((s, r) => s + r.aiActiveConversations, 0),
    aiOrders: rows.reduce((s, r) => s + r.aiOrders, 0),
    usageDays: Math.max(...rows.map((r) => r.days)),
  };
}

export async function loadOwnerCockpit(user: SessionUser, now: Date = new Date()): Promise<{ ok: true; value: OwnerCockpit } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const captured = await ensureSaasSnapshot(now).catch((e: unknown) => ({ errors: [`Chụp ảnh hôm nay hỏng: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`] }));
  const today = vnDate(now);
  const thisMonth = today.slice(0, 7);
  const lastMonth = prevMonthOf(thisMonth);
  const usdToVnd = env.facebook.usdToVnd;
  const windowFrom = new Date(now.getTime() - AI_WINDOW_DAYS * DAY);
  const [rawOrgs, plans, ledgerSince, rawDaily, rawMilestones, rawEverPaid, rawAi30, rawAiRecent, rawAiPrev, rawLastLogin, costs, rawBalances30] = await Promise.all([
    listOrganizations(),
    listPlans(),
    readFirstSnapshotDay(),
    readSaasDaily(`${prevMonthOf(lastMonth)}-01`),
    readMilestones(),
    readEverPaidOrgs(),
    readAiUsageByOrg(windowFrom, now),
    readAiUsageByOrg(new Date(now.getTime() - 7 * DAY), now),
    readAiUsageByOrg(new Date(now.getTime() - 14 * DAY), new Date(now.getTime() - 7 * DAY)),
    readLastLoginByOrg(),
    readCostDeclaration(),
    // Doanh thu Số dư AI của CÙNG cửa sổ với chi phí AI (review #648 vòng 2, MEDIUM-1).
    readAiBalancePeriod(windowFrom, now),
  ]);
  // Workspace KIỂM THỬ của ops nghiệm thu (sổ khai lib/constants/saas-acceptance-registry.ts) không phải khách — loại ở MỘT chỗ,
  // ngay sau lượt đọc, nên mọi con số bên dưới (số khách, vòng đời, phễu kích hoạt, MRR, AI của khách, số dùng) chỉ thấy khách.
  // Sổ ảnh chụp đã không chụp nó (captureSaasSnapshot); lớp này chặn cả dữ liệu đọc thẳng (sổ AI, đăng nhập) và dòng chụp cũ.
  const testCodes = new Set(rawOrgs.filter((o) => acceptanceWorkspaceOf(o.code)).map((o) => o.code));
  const customerOnly = <V>(m: Map<string, V>) => new Map([...m].filter(([code]) => !testCodes.has(code)));
  const orgs = rawOrgs.filter((o) => !testCodes.has(o.code));
  const daily = rawDaily.filter((r) => !testCodes.has(r.orgCode));
  const milestones = customerOnly(rawMilestones);
  const everPaid = new Set([...rawEverPaid].filter((code) => !testCodes.has(code)));
  const ai30 = customerOnly(rawAi30);
  const aiRecent = customerOnly(rawAiRecent);
  const aiPrev = customerOnly(rawAiPrev);
  const lastLogin = customerOnly(rawLastLogin);
  const balances30 = customerOnly(rawBalances30);
  const testAi = sumAi([...rawAi30].filter(([code]) => testCodes.has(code)).map(([, v]) => v));
  const balanceRevenue = (code: string) => aiBalanceRevenueVnd(balances30.get(code) ?? null);
  const usageByOrg = customerOnly(await readUsageTotals(vnDate(windowFrom)));
  const usageDaily = customerOnly(await readUsageDaily(vnDate(new Date(now.getTime() - 28 * DAY))));

  const latest = new Map<string, SaasDailyRow>();
  for (const r of daily) if (r.day <= today && (!latest.has(r.orgCode) || latest.get(r.orgCode)!.day < r.day)) latest.set(r.orgCode, r);

  const byLifecycle = Object.fromEntries(TENANT_LIFECYCLES.map((k) => [k, 0])) as Record<TenantLifecycle, number>;
  const tenants: TenantRow[] = [];
  let mrr = 0;
  let paying = 0;
  const activationOrgs: { orgCode: string; reached: Partial<Record<ActivationMilestone, Date>> }[] = [];
  for (const o of orgs) {
    if (o.status === "SETUP_FAILED") continue;
    const snap = latest.get(o.code);
    const planKey = snap?.planKey ?? (o.isHome ? "internal" : (o.plan ?? "trial"));
    const standing: BillingStandingKind = snap?.standing ?? "NOT_BILLED";
    const lifecycle = snap ? tenantLifecycle(snap, everPaid.has(o.code)) : o.isHome ? "INTERNAL" : "FREE";
    if (o.status !== "ARCHIVED") byLifecycle[lifecycle] += 1;
    const mrrVnd = snap ? snap.mrrVnd : null;
    if (!o.isHome && snap?.paying) {
      mrr += snap.mrrVnd ?? 0;
      paying += 1;
    }
    const usage = ai30.get(o.code);
    const recent = aiRecent.get(o.code)?.requests ?? 0;
    const previous = aiPrev.get(o.code)?.requests ?? 0;
    const reached = milestones.get(o.code) ?? {};
    if (!o.isHome && o.status !== "ARCHIVED") activationOrgs.push({ orgCode: o.code, reached });
    tenants.push({
      code: o.code,
      name: o.name,
      status: o.status,
      isHome: o.isHome,
      templateKey: o.templateKey,
      planKey,
      planName: plans.find((p) => p.key === planKey)?.name ?? planKey,
      standing,
      standingLabel: BILLING_STANDING_LABEL[standing],
      lifecycle,
      economics: tenantEconomics(o.isHome ? null : mrrVnd, usage?.platform ?? { costUsd: 0, requests: 0, unpricedRequests: 0 }, usdToVnd, o.isHome ? 0 : balanceRevenue(o.code)),
      byokAiCostUsd: usage?.byok.costUsd ?? 0,
      homeAiCostVnd: aiCostVnd(usage?.home ?? { costUsd: 0, requests: 0, unpricedRequests: 0 }, usdToVnd).vnd,
      aiRequests30d: usage?.requests ?? 0,
      aiTrend: trendOf(recent, previous),
      aiErrorRate: usage && usage.requests > 0 ? usage.errors / usage.requests : null,
      lastLoginAt: lastLogin.get(o.code)?.toISOString() ?? null,
      milestonesReached: Object.keys(reached).length,
      activated: Boolean(reached[ACTIVATED_AT]),
      daysToActivation: daysBetween(reached.SIGNED_UP, reached[ACTIVATED_AT]),
      daysToFirstAiOrder: daysBetween(reached.SIGNED_UP, reached.FIRST_AI_ORDER),
      usage30d: usageByOrg.get(o.code) ?? null,
      ...usageTrendOf(usageDaily.get(o.code) ?? [], today),
    });
  }
  tenants.sort((a, b) => Number(a.isHome) - Number(b.isHome) || (b.economics.mrrVnd ?? -1) - (a.economics.mrrVnd ?? -1) || b.aiRequests30d - a.aiRequests30d || a.code.localeCompare(b.code));

  const tenantAi = sumAi([...ai30.entries()].filter(([code]) => !orgs.find((o) => o.code === code)?.isHome).map(([, v]) => v));
  const allAi = sumAi(ai30.values());
  const platformAi = aiCostVnd(tenantAi.platform, usdToVnd);
  // Cùng tập với chi phí AI của khách (mọi tổ chức trừ nhà) — doanh thu và chi phí nói về cùng một nhóm.
  const aiBalanceRevenue30d = [...balances30.keys()].filter((code) => !orgs.find((o) => o.code === code)?.isHome).reduce((s, code) => s + balanceRevenue(code), 0);
  const tenantCount = orgs.filter((o) => !o.isHome && o.status !== "ARCHIVED" && o.status !== "SETUP_FAILED").length;
  const tm = monthRange(thisMonth);
  const lm = monthRange(lastMonth);
  return {
    ok: true,
    value: {
      generatedAt: now.toISOString(),
      today,
      version: SAAS_METRICS_VERSION,
      ledgerSince,
      usdToVnd,
      headline: { mrrVnd: mrr, arrVnd: mrr * 12, tenants: tenantCount, payingTenants: paying, arpaVnd: paying > 0 ? Math.round(mrr / paying) : null, byLifecycle },
      thisMonth: { label: thisMonth, movement: periodMovement(daily, tm.from, today < tm.to ? today : tm.to) },
      lastMonth: { label: lastMonth, movement: periodMovement(daily, lm.from, lm.to) },
      margin: { ...platformMargin(mrr + aiBalanceRevenue30d, platformAi.vnd, costs), aiBalanceRevenueVnd: aiBalanceRevenue30d, aiComplete: platformAi.complete, windowDays: AI_WINDOW_DAYS },
      ai: {
        requests: allAi.requests,
        platformCostVnd: platformAi.vnd,
        byokCostUsd: allAi.byok,
        homeCostVnd: Math.round(allAi.home * usdToVnd),
        unpricedRequests: allAi.unpriced,
        errorRate: allAi.requests > 0 ? allAi.errors / allAi.requests : null,
        tenantsUsingAi: [...ai30.entries()].filter(([code, v]) => v.requests > 0 && !orgs.find((o) => o.code === code)?.isHome).length,
        ...usageHeadline(usageByOrg, new Set(orgs.filter((o) => o.isHome).map((o) => o.code))),
      },
      activation: activationFunnel(activationOrgs),
      activationOrgs: activationOrgs.length,
      tenants,
      costs,
      captureErrors: captured && "errors" in captured ? captured.errors : [],
      testWorkspaces: { codes: [...testCodes].sort(), aiRequests: testAi.requests, platformAiCostVnd: aiCostVnd(testAi.platform, usdToVnd).vnd },
    },
  };
}
