/**
 * ═══════════ NGƯỜI VẬN HÀNH: CẤU HÌNH GIÁ + KINH TẾ ĐƠN VỊ — CHỈ MÁY CHỦ (docs/platform/pricing-billing-foundation.md) ═══════════
 *
 * Mọi hàm ở đây nhìn XUYÊN ranh giới tổ chức (bảng gói của nền tảng, ghi đè của tổ chức bất kỳ, sổ AI mọi tổ chức, số dùng
 * đọc từ CSDL từng khách) nên hỏi `platformOperatorDenial(user)` TRƯỚC lượt đọc / ghi đầu tiên (S21). Mọi lượt ghi bắt buộc
 * lý do và vào nhật ký nền tảng (`platform_audit_log`). Không trả nội dung hội thoại, tên khách, khoá hay email người dùng
 * của khách — chỉ tiền, số đếm, mã tổ chức.
 *
 * Khách KHÔNG BAO GIỜ thấy token / chi phí AI của nền tảng ở đây: màn khách (`/settings/plan`) chỉ đọc số dùng theo đơn vị
 * dễ hiểu (`lib/pricing/customer.ts`).
 */
import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { HOME_PLAN_KEY, listPlans, planKeyOf } from "@/lib/entitlements/check";
import { env } from "@/lib/env";
import { platformAudit } from "@/lib/platform/audit";
import { KILL_SWITCH_REASON_MIN } from "@/lib/platform/kill-switches";
import { findOrganization, getHomeOrganization, listOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { readAiUsageByOrg, readCostDeclaration, readSaasDaily } from "@/lib/platform/saas-ledger";
import { aiCostVnd, type PlatformCostDeclaration } from "@/lib/platform/saas-metrics";
import { readPeriodUsage } from "@/lib/platform/usage-meter";
import { normalizeCommercialInput, parseCommercial, QUOTA_KEYS, QUOTA_MAX, type CommercialInput, type CommercialQuotaKey, type PlanCommercial, type QuotaKey } from "@/lib/pricing/catalog";
import { aiCreditLevel, detectCostSpike, ENFORCEMENTS, evaluateQuota, suggestCheaperModel, worstLevel, type Enforcement, type GuardConfig, type QuotaLevel, type QuotaVerdict, type RoutingSuggestion, type SpikeVerdict } from "@/lib/pricing/guard";
import { parseFeatureOverrides, type FeatureKey } from "@/lib/pricing/features";
import { invalidatePricing, PRICING_GUARD_KEY, readGuardConfig, readOrgPricingRow, resolveOrgPricing, QUOTA_METER, type OrgPricingRow } from "@/lib/pricing/entitlements";
import { marginRisk, projectToPeriodEnd, tenantUnitEconomics, trialConversion, div, type MarginRisk, type TenantUnitEconomics, type TrialConversion } from "@/lib/pricing/economics";
import { periodProgress, usagePeriodOf, type MeterReadings } from "@/lib/pricing/meter";
import { AI_UNIT_PRICES_KEY, parseUnitPriceOverrides, priceKeyFor, readUnitPriceOverrides, resolveUnitPrices, type UnitPriceRow } from "@/lib/pricing/unit-prices";
import { parseAiLimits } from "@/lib/ai-usage/types";

export type PricingResult = { ok: true; message: string } | { error: string };

function actorOf(user: SessionUser) {
  return user.organization ? { orgCode: user.organization.code, userId: user.id, email: user.email } : null;
}

function reasonOf(raw: unknown): string | { error: string } {
  const reason = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  if (reason.length < KILL_SWITCH_REASON_MIN) return { error: `Ghi lý do (ít nhất ${KILL_SWITCH_REASON_MIN} ký tự) — nó vào nhật ký nền tảng.` };
  return reason;
}

async function putSetting(user: SessionUser, key: string, value: unknown) {
  const pdb = await getPlatformDb();
  const set = { value, updatedAt: new Date(), updatedBy: `${user.organization?.code ?? ""}:${user.id}`, updatedByEmail: user.email };
  await pdb.insert(schema.platformSettings).values({ key, ...set }).onConflictDoUpdate({ target: schema.platformSettings.key, set });
}

// ─────────────────────────── Sửa gói (phần thương mại) ───────────────────────────

/**
 * Sửa tên · mô tả · phần thương mại của MỘT gói. Giá tháng / tặng tháng khi trả năm vẫn sửa ở `setPlanPrice` (0187 · 0194) —
 * không có đường thứ hai đổi giá. Gói nội bộ không sửa được ở đây (nó không phải một hạng thương mại).
 */
export async function setPlanCommercial(user: SessionUser, raw: CommercialInput & { planKey?: unknown; reason?: unknown }): Promise<PricingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const planKey = typeof raw.planKey === "string" ? raw.planKey : "";
  if (planKey === HOME_PLAN_KEY) return { error: "Gói nội bộ không phải một gói bán — không sửa ở đây." };
  const norm = normalizeCommercialInput(raw);
  if ("error" in norm) return norm;
  const pdb = await getPlatformDb();
  const t = schema.platformPlans;
  const [plan] = await pdb.select().from(t).where(eq(t.key, planKey)).limit(1);
  if (!plan) return { error: `Không có gói «${planKey}».` };
  const before = { name: plan.name, description: plan.description, commercial: plan.commercial };
  const after = { name: norm.name, description: norm.description, commercial: norm.commercial };
  if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true, message: "Không có gì thay đổi." };
  const home = await getHomeOrganization();
  await pdb.update(t).set({ name: norm.name, description: norm.description, commercial: norm.commercial, updatedAt: new Date() }).where(eq(t.key, planKey));
  await platformAudit({ action: "PLAN_COMMERCIAL_SET", targetOrgCode: home.code, subject: `plan:${planKey}`, before, after, reason, source: "UI", actor: actorOf(user) });
  invalidatePricing();
  return { ok: true, message: `Đã lưu gói «${norm.name}». Hạn mức và tính năng áp ngay (đệm tối đa 10 giây ở tiến trình khác).` };
}

// ─────────────────────────── Ghi đè theo tổ chức ───────────────────────────

/**
 * Ghi đè của người vận hành cho MỘT tổ chức: tính năng (`{ khoá: boolean }`), hạn mức (`{ ô: số | null }`), mức áp
 * (`OFF` · `SOFT` · `HARD`), cờ giữ từ trước. Ô vắng trong đầu vào = giữ nguyên. `HARD` chỉ có tác dụng khi công tắc trần
 * cứng của nền tảng cũng bật — màn hình nói rõ điều đó.
 */
export async function setOrgPricing(user: SessionUser, raw: { orgCode?: unknown; grandfathered?: unknown; featureOverrides?: unknown; quotaOverrides?: unknown; enforcement?: unknown; reason?: unknown }): Promise<PricingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const orgCode = typeof raw.orgCode === "string" ? raw.orgCode : "";
  const org = await findOrganization(orgCode);
  if (!org) return { error: `Không có tổ chức «${orgCode}».` };
  if (org.isHome) return { error: "Tổ chức nhà không có giới hạn gói — không ghi đè." };
  const cur = await readOrgPricingRow(org.code, { fresh: true });
  let enforcement: Enforcement = cur.enforcement;
  if (raw.enforcement !== undefined) {
    if (!(ENFORCEMENTS as readonly string[]).includes(String(raw.enforcement))) return { error: "Mức áp chỉ là Tắt · Mềm · Cứng." };
    enforcement = raw.enforcement as Enforcement;
  }
  let featureOverrides: Partial<Record<FeatureKey, boolean>> = cur.featureOverrides;
  if (raw.featureOverrides !== undefined) {
    const parsed = parseFeatureOverrides(raw.featureOverrides);
    if (raw.featureOverrides && typeof raw.featureOverrides === "object" && Object.keys(parsed).length !== Object.keys(raw.featureOverrides as object).length) return { error: "Có tính năng không có trong sổ." };
    featureOverrides = parsed;
  }
  let quotaOverrides: Record<string, number | null> = (cur.quotaOverrides && typeof cur.quotaOverrides === "object" ? cur.quotaOverrides : {}) as Record<string, number | null>;
  if (raw.quotaOverrides !== undefined) {
    const src = raw.quotaOverrides && typeof raw.quotaOverrides === "object" && !Array.isArray(raw.quotaOverrides) ? (raw.quotaOverrides as Record<string, unknown>) : {};
    const next: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(src)) {
      if (!(QUOTA_KEYS as readonly string[]).includes(k)) return { error: `Hạn mức lạ: ${k}.` };
      if (v === null) next[k] = null;
      else if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= QUOTA_MAX) next[k] = v;
      else return { error: `Hạn mức «${k}» phải là số nguyên 0–${QUOTA_MAX.toLocaleString("vi-VN")} hoặc không giới hạn.` };
    }
    quotaOverrides = next;
  }
  const grandfathered = raw.grandfathered === undefined ? cur.grandfathered : raw.grandfathered === true;
  const pdb = await getPlatformDb();
  const t = schema.platformOrgPricing;
  const values = { grandfathered, featureOverrides, quotaOverrides, enforcement, reason, updatedByEmail: user.email, updatedAt: new Date() };
  await pdb.insert(t).values({ orgCode: org.code, ...values }).onConflictDoUpdate({ target: t.orgCode, set: values });
  await platformAudit({
    action: "ORG_PRICING_SET",
    targetOrgCode: org.code,
    subject: `pricing:${org.code}`,
    before: { grandfathered: cur.grandfathered, featureOverrides: cur.featureOverrides, quotaOverrides: cur.quotaOverrides, enforcement: cur.enforcement },
    after: { grandfathered, featureOverrides, quotaOverrides, enforcement },
    reason,
    source: "UI",
    actor: actorOf(user),
  });
  invalidatePricing(org.code);
  return { ok: true, message: `Đã lưu ghi đè cho «${org.name}».` };
}

// ─────────────────────────── Ngưỡng Margin Guard ───────────────────────────

export async function setPricingGuard(user: SessionUser, raw: { config?: unknown; reason?: unknown }): Promise<PricingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const c = raw.config && typeof raw.config === "object" && !Array.isArray(raw.config) ? (raw.config as Record<string, unknown>) : null;
  if (!c) return { error: "Thiếu cấu hình ngưỡng." };
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v));
  const notice = n(c.noticePct);
  const warn = n(c.warnPct);
  const limit = n(c.limitPct);
  if (!(notice >= 1 && notice < warn && warn <= limit && limit <= 500)) return { error: "Ba ngưỡng phải tăng dần: nhắc < cảnh báo ≤ hết hạn mức (≤ 500%)." };
  const next = {
    noticePct: notice,
    warnPct: warn,
    limitPct: limit,
    spikeMultiplier: n(c.spikeMultiplier),
    spikeMinUsd: n(c.spikeMinUsd),
    spikeMinDays: n(c.spikeMinDays),
    routingMinSavingsPct: n(c.routingMinSavingsPct),
    hardLimitsEnabled: c.hardLimitsEnabled === true,
  };
  const before = await readGuardConfig({ fresh: true });
  await putSetting(user, PRICING_GUARD_KEY, next);
  const home = await getHomeOrganization();
  await platformAudit({ action: "PRICING_GUARD_SET", targetOrgCode: home.code, subject: PRICING_GUARD_KEY, before, after: next, reason, source: "UI", actor: actorOf(user) });
  invalidatePricing();
  const applied = await readGuardConfig({ fresh: true });
  return { ok: true, message: `Đã lưu ngưỡng ${applied.noticePct}% · ${applied.warnPct}% · ${applied.limitPct}%. Trần cứng của nền tảng: ${applied.hardLimitsEnabled ? "BẬT" : "tắt"}.` };
}

// ─────────────────────────── Giá đơn vị AI ghi đè ───────────────────────────

export async function setAiUnitPrices(user: SessionUser, raw: { prices?: unknown; reason?: unknown }): Promise<PricingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const src = raw.prices && typeof raw.prices === "object" && !Array.isArray(raw.prices) ? (raw.prices as Record<string, unknown>) : {};
  const parsed = parseUnitPriceOverrides(src);
  if (Object.keys(parsed).length !== Object.keys(src).length) return { error: "Có dòng giá sai hình: tên model chữ thường, giá vào / ra là số USD ≥ 0 cho 1 triệu token." };
  const before = await readUnitPriceOverrides();
  await putSetting(user, AI_UNIT_PRICES_KEY, parsed);
  const home = await getHomeOrganization();
  await platformAudit({ action: "AI_UNIT_PRICES_SET", targetOrgCode: home.code, subject: AI_UNIT_PRICES_KEY, before: before.overrides, after: parsed, reason, source: "UI", actor: actorOf(user) });
  return { ok: true, message: `Đã lưu ${Object.keys(parsed).length} dòng giá ghi đè (ƯỚC TÍNH). Chi phí đã ghi của các lượt cũ không đổi.` };
}

// ─────────────────────────── Đọc cho màn người vận hành ───────────────────────────

export type PlanAdminRow = { key: string; name: string; description: string | null; priceVnd: number | null; yearlyFreeMonths: number; users: number | null | undefined; aiCreditUsd: number; commercial: PlanCommercial };
export type OrgPricingAdminRow = { code: string; name: string; planKey: string; row: OrgPricingRow };

export async function loadPricingAdmin(user: SessionUser): Promise<{ ok: true; value: { plans: PlanAdminRow[]; orgs: OrgPricingAdminRow[]; guard: GuardConfig; unitPrices: { rows: UnitPriceRow[]; updatedAt: string | null; updatedByEmail: string | null } } } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const [plans, orgs, guard, unit] = await Promise.all([listPlans(), listOrganizations(), readGuardConfig({ fresh: true }), resolveUnitPrices()]);
  const rows: OrgPricingAdminRow[] = [];
  for (const o of orgs) {
    if (o.isHome || o.status === "SETUP_FAILED") continue;
    rows.push({ code: o.code, name: o.name, planKey: planKeyOf(o), row: await readOrgPricingRow(o.code, { fresh: true }) });
  }
  return {
    ok: true,
    value: {
      plans: plans
        .filter((p) => p.key !== HOME_PLAN_KEY)
        .map((p) => {
          const commercial = parseCommercial(p.commercial);
          const lim = p.limits && typeof p.limits === "object" ? (p.limits as Record<string, unknown>) : {};
          return { key: p.key, name: p.name, description: p.description, priceVnd: p.priceVnd, yearlyFreeMonths: p.yearlyFreeMonths, users: lim.users === null ? null : typeof lim.users === "number" ? lim.users : undefined, aiCreditUsd: parseAiLimits(p.limits).limits.platformCreditUsdPerMonth, commercial };
        }),
      orgs: rows,
      guard,
      unitPrices: { rows: unit.rows, updatedAt: unit.updatedAt, updatedByEmail: unit.updatedByEmail },
    },
  };
}

// ─────────────────────────── Kinh tế đơn vị + Margin Guard ───────────────────────────

export type TenantGuardRow = {
  code: string;
  name: string;
  planName: string;
  grandfathered: boolean;
  enforcement: Enforcement;
  mrrVnd: number | null;
  platformAiCostVnd: number;
  projectedPlatformAiCostVnd: number | null;
  byokAiCostUsd: number;
  unpricedCalls: number;
  /** Ước tính lại tiền của lượt chưa định giá theo bảng giá (ghi đè + trong mã) — ESTIMATED, `null` khi không định giá được. */
  reestimatedUnpricedUsd: number | null;
  economics: TenantUnitEconomics;
  risk: MarginRisk;
  quotas: QuotaVerdict[];
  aiCredit: { level: QuotaLevel; pct: number | null; note: string | null };
  worst: QuotaLevel;
  spike: SpikeVerdict;
  routing: (RoutingSuggestion & { scope: "PLATFORM" | "BYOK" }) | null;
  readings: MeterReadings;
  errors: string[];
};

export type PricingEconomics = {
  generatedAt: string;
  periodLabel: string;
  elapsedDays: number;
  totalDays: number;
  usdToVnd: number;
  guard: GuardConfig;
  totals: {
    revenueVnd: number;
    payingTenants: number;
    trialTenants: number;
    platformAiCostVnd: number;
    projectedPlatformAiCostVnd: number | null;
    aiCostComplete: boolean;
    infraVnd: number | null;
    grossProfitVnd: number | null;
    grossMarginPct: number | null;
    arpuVnd: number | null;
    aiCostPerTenantVnd: number | null;
    aiCostPerOrderVnd: number | null;
    aiCostPerConversationVnd: number | null;
    aiOrders: number | null;
    aiConversations: number | null;
    negativeRisk: number;
    spikes: number;
  };
  trial: TrialConversion;
  costs: PlatformCostDeclaration;
  tenants: TenantGuardRow[];
};

const DAY = 86_400_000;

/**
 * Bảng kinh tế đơn vị + Margin Guard của MỌI tổ chức khách trong kỳ hiện tại (tháng lịch VN). Mở CSDL từng tổ chức để ĐẾM
 * (cùng câu đếm với sổ dùng theo ngày) — lỗi một tổ chức nằm ở `errors` của dòng đó, không làm hỏng bảng.
 */
export async function loadPricingEconomics(user: SessionUser, now: Date = new Date()): Promise<{ ok: true; value: PricingEconomics } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const period = usagePeriodOf(now);
  const { elapsedDays, totalDays } = periodProgress(period, now);
  const usdToVnd = env.facebook.usdToVnd;
  const historyFrom = new Date(now.getTime() - 15 * DAY);
  const [orgs, guard, ai, daily, costs, unit] = await Promise.all([
    listOrganizations(),
    readGuardConfig(),
    readAiUsageByOrg(period.from, now),
    readSaasDaily(new Date(now.getTime() - 120 * DAY).toISOString().slice(0, 10)),
    readCostDeclaration(),
    resolveUnitPrices(),
  ]);
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  const dayExpr = sql<string>`to_char((${a.at} at time zone 'UTC') + interval '7 hours', 'YYYY-MM-DD')`;
  const [byModel, byDay] = await Promise.all([
    pdb
      .select({ orgCode: a.orgCode, model: a.model, source: a.billingSource, input: sql<number>`coalesce(sum(${a.inputTokens}), 0)::float8`, output: sql<number>`coalesce(sum(${a.outputTokens}), 0)::float8`, unpricedInput: sql<number>`coalesce(sum(${a.inputTokens}) filter (where ${a.costUsd} is null), 0)::float8`, unpricedOutput: sql<number>`coalesce(sum(${a.outputTokens}) filter (where ${a.costUsd} is null), 0)::float8` })
      .from(a)
      .where(and(gte(a.at, period.from), lt(a.at, now), ne(a.status, "BLOCKED_QUOTA")))
      .groupBy(a.orgCode, a.model, a.billingSource),
    pdb
      .select({ orgCode: a.orgCode, day: dayExpr, cost: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8` })
      .from(a)
      .where(and(gte(a.at, historyFrom), ne(a.status, "BLOCKED_QUOTA")))
      .groupBy(a.orgCode, dayExpr),
  ]);
  const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const histDays: string[] = [];
  for (let i = 14; i >= 1; i--) histDays.push(new Date(now.getTime() + 7 * 3_600_000 - i * DAY).toISOString().slice(0, 10));

  const latest = new Map<string, (typeof daily)[number]>();
  for (const r of daily) if (r.day <= today && (!latest.has(r.orgCode) || latest.get(r.orgCode)!.day < r.day)) latest.set(r.orgCode, r);

  const tenants: TenantGuardRow[] = [];
  for (const o of orgs) {
    if (o.isHome || o.status !== "ACTIVE") continue;
    const pricing = await resolveOrgPricing(o);
    const c = pricing.plan?.commercial;
    const usage = await readPeriodUsage(o, period, now);
    const snap = latest.get(o.code);
    const mrrVnd = snap ? (snap.paying ? snap.mrrVnd : 0) : null;
    const orgAi = ai.get(o.code);
    const platformCost = aiCostVnd(orgAi?.platform ?? { costUsd: 0, requests: 0, unpricedRequests: 0 }, usdToVnd);
    const unpriced = (orgAi?.platform.unpricedRequests ?? 0) + (orgAi?.byok.unpricedRequests ?? 0);
    const models = byModel.filter((m) => m.orgCode === o.code);
    let reest: number | null = unpriced > 0 ? 0 : null;
    for (const m of models) {
      if (!(m.unpricedInput + m.unpricedOutput > 0) || reest === null) continue;
      const usd = m.model ? (() => {
        const k = priceKeyFor(m.model, unit.byModel);
        return k ? (m.unpricedInput * unit.byModel[k].input + m.unpricedOutput * unit.byModel[k].output) / 1_000_000 : null;
      })() : null;
      reest = usd === null ? null : reest + usd;
    }
    const projected = projectToPeriodEnd(platformCost.vnd, elapsedDays, totalDays);
    const quotas = (["aiConversations", "aiMessages", "orders", "fanpages"] as const).map((k) =>
      evaluateQuota({ key: k, used: usage.readings[QUOTA_METER[k]], included: pricing.quotas[k], policy: c?.overage.policy ?? "SOFT_ONLY", unitPriceVnd: c?.overage.unitPricesVnd[k as CommercialQuotaKey] ?? null, graceAllowancePct: c?.overage.graceAllowancePct ?? 0, limitMode: c?.limitModes[k as QuotaKey] ?? "SOFT", enforcement: pricing.row.enforcement, config: guard }),
    );
    const credit = aiCreditLevel(orgAi?.platform.costUsd ?? 0, parseAiLimits(pricing.plan?.limits).limits.platformCreditUsdPerMonth, orgAi?.platform.unpricedRequests ?? 0, guard);
    const costByDay = new Map(byDay.filter((d) => d.orgCode === o.code).map((d) => [d.day, Number(d.cost)]));
    const spike = detectCostSpike(histDays.map((d) => costByDay.get(d) ?? 0), costByDay.get(today) ?? 0, guard);
    const top = [...models].sort((x, y) => y.input + y.output - (x.input + x.output))[0];
    const suggested = top?.model ? suggestCheaperModel({ model: top.model, inputTokens: top.input, outputTokens: top.output, prices: unit.byModel, priceKeyOf: (m) => priceKeyFor(m, unit.byModel), minSavingsPct: guard.routingMinSavingsPct }) : null;
    // Model của AI DÙNG CHUNG (nguồn PLATFORM) do người vận hành đổi ở Platform AI Model Control — một chỗ cho cả nền tảng;
    // model của khoá riêng (BYOK) là cấu hình của chính tổ chức.
    const routing = suggested ? { ...suggested, scope: top.source === "PLATFORM" ? ("PLATFORM" as const) : ("BYOK" as const) } : null;
    tenants.push({
      code: o.code,
      name: o.name,
      planName: pricing.plan?.name ?? planKeyOf(o),
      grandfathered: pricing.row.grandfathered,
      enforcement: pricing.row.enforcement,
      mrrVnd,
      platformAiCostVnd: platformCost.vnd,
      projectedPlatformAiCostVnd: projected === null ? null : Math.round(projected),
      byokAiCostUsd: orgAi?.byok.costUsd ?? 0,
      unpricedCalls: unpriced,
      reestimatedUnpricedUsd: reest,
      economics: tenantUnitEconomics({ revenueVnd: mrrVnd, platformAiCostVnd: platformCost.vnd, aiCostComplete: platformCost.complete, aiOrders: usage.readings.orders_created_by_ai, aiConversations: usage.readings.ai_conversations }),
      risk: marginRisk({ revenueVnd: mrrVnd, platformAiCostToDateVnd: platformCost.vnd, projectedPlatformAiCostVnd: projected }),
      quotas,
      aiCredit: credit,
      worst: worstLevel([...quotas.map((q) => q.level), credit.level]),
      spike,
      routing,
      readings: usage.readings,
      errors: usage.errors,
    });
  }
  const riskRank: Record<MarginRisk, number> = { NEGATIVE: 0, TRIAL_COST: 1, UNKNOWN: 2, OK: 3, NO_COST: 4 };
  tenants.sort((x, y) => riskRank[x.risk] - riskRank[y.risk] || y.platformAiCostVnd - x.platformAiCostVnd || x.code.localeCompare(y.code));

  const paying = tenants.filter((t) => (t.mrrVnd ?? 0) > 0);
  const revenue = paying.reduce((s, t) => s + (t.mrrVnd ?? 0), 0);
  const aiTotal = tenants.reduce((s, t) => s + t.platformAiCostVnd, 0);
  const projectedTotal = projectToPeriodEnd(aiTotal, elapsedDays, totalDays);
  const sumKnown = (vals: (number | null)[]) => (vals.some((v) => v === null) ? null : vals.reduce<number>((s, v) => s + (v ?? 0), 0));
  const aiOrders = sumKnown(tenants.map((t) => t.readings.orders_created_by_ai));
  const aiConversations = sumKnown(tenants.map((t) => t.readings.ai_conversations));
  const aiForMargin = projectedTotal === null ? null : projectedTotal;
  const gross = revenue > 0 && aiForMargin !== null && costs.infraMonthlyVnd !== null ? revenue - aiForMargin - costs.infraMonthlyVnd : null;
  const withCost = tenants.filter((t) => t.platformAiCostVnd > 0);
  return {
    ok: true,
    value: {
      generatedAt: now.toISOString(),
      periodLabel: period.label,
      elapsedDays,
      totalDays,
      usdToVnd,
      guard,
      totals: {
        revenueVnd: revenue,
        payingTenants: paying.length,
        trialTenants: tenants.filter((t) => t.mrrVnd === 0 && latest.get(t.code)?.billingEnabled).length,
        platformAiCostVnd: aiTotal,
        projectedPlatformAiCostVnd: projectedTotal === null ? null : Math.round(projectedTotal),
        aiCostComplete: tenants.every((t) => t.unpricedCalls === 0),
        infraVnd: costs.infraMonthlyVnd,
        grossProfitVnd: gross === null ? null : Math.round(gross),
        grossMarginPct: gross === null ? null : (gross / revenue) * 100,
        arpuVnd: paying.length ? Math.round(revenue / paying.length) : null,
        aiCostPerTenantVnd: withCost.length ? Math.round(aiTotal / withCost.length) : null,
        aiCostPerOrderVnd: div(aiTotal, aiOrders),
        aiCostPerConversationVnd: div(aiTotal, aiConversations),
        aiOrders,
        aiConversations,
        negativeRisk: tenants.filter((t) => t.risk === "NEGATIVE").length,
        spikes: tenants.filter((t) => t.spike.state === "SPIKE").length,
      },
      trial: trialConversion(daily),
      costs,
      tenants,
    },
  };
}
