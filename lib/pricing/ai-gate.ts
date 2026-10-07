/**
 * ═══════════ CỔNG «QUYỀN DÙNG AI THEO GÓI» + MÀN XEM QUYỀN CỦA KHÁCH — CHỈ MÁY CHỦ (docs/saas/PRICING_V1.md §II.7) ═══════════
 *
 * MỘT đường đọc cho mọi nơi kích AI bán hàng: lượt chat (`engine.ts::chatTurnCore`), đọc ảnh khách (`describeCustomerImages`),
 * nhắc khách / học / ghi đơn (`salesChatProvider`), quét lại tin (đi lại `chatTurn`), và thanh trạng thái hộp thư
 * (`ai-status.ts::conversationAiBlocks`). Luật nằm ở hàm thuần `ai-entitlement.ts::aiEntitlementDecision`; tệp này chỉ ĐỌC:
 *  · dòng giá của gói theo phiên bản của tổ chức (`resolveOrgPricing` — legacy / trả phí ⇒ không dùng thử ⇒ luôn cho);
 *  · số khách AI của kỳ (`readAiCustomerUsage` — chỉ đọc khi đang dùng thử, gói trả phí không tốn một truy vấn nào);
 *  · mốc hết dùng thử (`platform_subscriptions.trial_ends_at`, dòng cũ lùi về `paid_through`);
 *  · trạng thái tổ chức (`SUSPENDED`).
 * Đệm 30 giây theo tổ chức; khách AI MỚI được ghi ⇒ quên ngay đệm của tổ chức đó (hạn mức dùng thử đọc số tươi). Mọi lỗi đọc ⇒
 * CHO (nới) + cảnh báo — không bao giờ chặn AI của một khách đang bán hàng vì một lần CSDL chập.
 */
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { readTrialTerms } from "@/lib/billing/standing";
import { getPlanUsage } from "@/lib/entitlements/check";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { readPeriodUsage } from "@/lib/platform/usage-meter";
import { aiCustomerCountedThisPeriod, onAiCustomerRecorded, readAiCustomerUsage } from "@/lib/pricing/ai-customer";
import { aiBalanceEnabled, readAiBalance } from "@/lib/billing/ai-balance";
import { balanceOverageTerms } from "@/lib/billing/ai-usage-charge";
import {
  AI_STOP_MESSAGE,
  AI_STOP_NOTE,
  aiEntitlementDecision,
  CUSTOMER_AI_STATE_LABEL,
  customerAiState,
  effectiveTrialEnd,
  type AiEntitlementDecision,
  type AiStopReason,
  type CustomerAiState,
} from "@/lib/pricing/ai-entitlement";
import { resolveOrgPricing } from "@/lib/pricing/entitlements";
import { featureGranted } from "@/lib/pricing/features";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { meterMonthOf, type MeterCoverage } from "@/lib/pricing/versions";
import { parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";

export type AiEntitlement = AiEntitlementDecision & {
  orgCode: string;
  planKey: string | null;
  planName: string | null;
  aiCustomersUsed: number | null;
  aiCustomersIncluded: number | null | undefined;
  aiCustomersCoverage: MeterCoverage | null;
  trialEndsAt: Date | null;
  periodMonth: string;
};

const TTL_MS = 30_000;
/** Sự thật đã ĐỌC (đệm 30 giây) — phán quyết tính lại MỖI lần theo `now`, nên mốc hết dùng thử chính xác tới từng giây. */
type Facts = Omit<AiEntitlement, keyof AiEntitlementDecision> & { orgStatus: string; trialFlag: boolean | null; warning: AiEntitlementDecision["warnings"][number] | null };
type Holder = { __erpAiGate?: Map<string, { at: number; facts: Facts }> };
const holder = globalThis as unknown as Holder;
if (!holder.__erpAiGate) holder.__erpAiGate = new Map();
const cache = holder.__erpAiGate;

export function invalidateAiEntitlement(orgCode?: string): void {
  if (orgCode) cache.delete(orgCode);
  else cache.clear();
}
onAiCustomerRecorded((orgCode) => invalidateAiEntitlement(orgCode));

async function readFacts(orgCode: string, now: Date, fresh: boolean): Promise<Facts> {
  const blank = (warning: Facts["warning"]): Facts => ({ orgCode, orgStatus: "ACTIVE", trialFlag: false, warning, planKey: null, planName: null, aiCustomersUsed: null, aiCustomersIncluded: undefined, aiCustomersCoverage: null, trialEndsAt: null, periodMonth: meterMonthOf(now) });
  try {
    const org = await findOrganization(orgCode);
    if (!org) return blank("PLAN_UNREADABLE");
    const pricing = await resolveOrgPricing(org);
    const price = pricing.plan?.planPrice ?? null;
    const trial = price ? price.trialDays !== null : null;
    let used: number | null = null;
    let coverage: MeterCoverage | null = null;
    let trialEndsAt: Date | null = null;
    if (trial) {
      const terms = await readTrialTerms(org.code, { fresh });
      trialEndsAt = effectiveTrialEnd(terms.trialEndsAt, terms.paidThrough);
      const reading = (await readAiCustomerUsage([org.code], usagePeriodOf(now), now)).get(org.code);
      used = reading?.value ?? null;
      coverage = reading?.coverage ?? null;
    }
    return { orgCode: org.code, orgStatus: org.status, trialFlag: trial, warning: null, planKey: pricing.plan?.key ?? null, planName: pricing.plan?.name ?? null, aiCustomersUsed: used, aiCustomersIncluded: price?.included.aiCustomers, aiCustomersCoverage: coverage, trialEndsAt, periodMonth: meterMonthOf(now) };
  } catch {
    return blank("PLAN_UNREADABLE");
  }
}

/** Quyền dùng AI của MỘT tổ chức lúc `now`. Không ném. */
export async function loadAiEntitlement(orgCode: string, opts: { now?: Date; fresh?: boolean } = {}): Promise<AiEntitlement> {
  const now = opts.now ?? new Date();
  const hit = cache.get(orgCode);
  let facts: Facts;
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS && hit.facts.periodMonth === meterMonthOf(now)) facts = hit.facts;
  else {
    facts = await readFacts(orgCode, now, !!opts.fresh);
    cache.set(orgCode, { at: Date.now(), facts });
  }
  const decision = aiEntitlementDecision({ orgStatus: facts.orgStatus, trial: facts.trialFlag, trialEndsAt: facts.trialEndsAt, aiCustomersUsed: facts.aiCustomersUsed, aiCustomersIncluded: facts.aiCustomersIncluded, now });
  const warnings = facts.warning ? [...new Set([...decision.warnings, facts.warning])] : decision.warnings;
  return {
    ...decision,
    warnings,
    orgCode: facts.orgCode,
    planKey: facts.planKey,
    planName: facts.planName,
    aiCustomersUsed: facts.aiCustomersUsed,
    aiCustomersIncluded: facts.aiCustomersIncluded,
    aiCustomersCoverage: facts.aiCustomersCoverage,
    trialEndsAt: facts.trialEndsAt,
    periodMonth: facts.periodMonth,
  };
}

export type SalesAiPlanGate = { ok: true } | { ok: false; reason: AiStopReason; message: string; note: string };

/** Danh tính hội thoại cho cổng Số dư AI (cùng bốn ô đồng hồ khách AI dựng khoá). */
export type GateConversation = { channel: string; pageId: string | null; threadId: string | null; visitorKey: string | null };

/**
 * CỔNG SỐ DƯ AI THEO HỘI THOẠI (docs/saas/AI_BALANCE_V1.md · chủ shop 08/10/2026: «hết số dư ⇒ khách đã trả trong tháng vẫn được
 * trả lời; khách MỚI không nhận AI; âm tối đa đúng 1 khách»). Chặn (`false`) CHỈ khi đủ cả năm điều: tổ chức đã bật Số dư AI ·
 * gói trừ số dư (trả phí, phần vượt tính tiền) · khách này CHƯA là khách AI của kỳ · số khách của kỳ đã chạm phần gói gồm · số
 * dư ≤ 0. Số dư còn dương dù nhỏ hơn đơn giá ⇒ CHO (lượt trừ sau có thể âm — tối đa một đơn giá). Mọi lỗi đọc ⇒ CHO (nới) —
 * không bao giờ chặn khách đang mua hàng vì một lần CSDL chập.
 */
export async function aiBalanceGate(orgCode: string, conv: GateConversation, now: Date = new Date()): Promise<boolean> {
  try {
    if (!(await aiBalanceEnabled(orgCode))) return true;
    const terms = await balanceOverageTerms(orgCode);
    if (!terms) return true;
    if (await aiCustomerCountedThisPeriod(orgCode, conv, now)) return true;
    const org = await findOrganization(orgCode);
    if (!org) return true;
    const used = (await readAiCustomerUsage([org.code], usagePeriodOf(now), now)).get(org.code)?.value ?? null;
    if (used === null || used < terms.included) return true;
    return (await readAiBalance(orgCode)).totalVnd > 0;
  } catch {
    return true;
  }
}

/** Cổng của RUNTIME (tổ chức ngữ cảnh). Không ném: lỗi ⇒ cho. */
export async function salesAiPlanGate(opts: { now?: Date; conversation?: GateConversation } = {}): Promise<SalesAiPlanGate> {
  try {
    const org = await currentOrganization();
    const d = await loadAiEntitlement(org.code, opts.now ? { now: opts.now } : {});
    if (!d.allowed && d.reason) return { ok: false, reason: d.reason, message: AI_STOP_MESSAGE[d.reason], note: AI_STOP_NOTE[d.reason] };
    // Số dư AI: chỉ lượt CÓ hội thoại (một khách cụ thể) mới hỏi — việc nội bộ (học, ghi đơn hộ) không mở khách AI mới.
    if (opts.conversation && !(await aiBalanceGate(org.code, opts.conversation, opts.now))) {
      return { ok: false, reason: "BALANCE_EXHAUSTED", message: AI_STOP_MESSAGE.BALANCE_EXHAUSTED, note: AI_STOP_NOTE.BALANCE_EXHAUSTED };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// ─────────────────────────── Màn xem quyền của KHÁCH (không token / USD / model) ───────────────────────────

export type CustomerEntitlementView = {
  plan: { key: string | null; name: string | null; trial: boolean };
  aiCustomers: { used: number | null; limit: number | null | undefined; coverage: MeterCoverage | null };
  fanpages: { used: number | null; limit: number | null | undefined };
  users: { used: number | null; limit: number | null | undefined };
  period: { label: string; resetsOn: string };
  trialEndsAt: string | null;
  paidThrough: string | null;
  ai: { state: CustomerAiState; label: string; message: string | null };
};

async function botEnabledOf(orgCode: string): Promise<boolean | null> {
  try {
    return await withOrganization(orgCode, async () => {
      const db = await getDb();
      const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
      let raw: unknown = null;
      try {
        raw = row?.value ? (JSON.parse(row.value) as unknown) : null;
      } catch {
        raw = null;
      }
      return parseSalesChatbotConfig(raw).enabled;
    });
  } catch {
    return null;
  }
}

/**
 * Gói · Khách AI X/LIMIT · fanpage X/LIMIT · người dùng X/LIMIT · ngày reset · hạn dùng thử / thuê bao · trạng thái AI. Dành cho
 * màn khách (`/settings/plan` — luồng L1 dựng giao diện). Chỉ SỐ ĐẾM theo đơn vị khách hiểu; KHÔNG token, USD, model, nhà cung
 * cấp, chi phí hay biên lãi (`tests/saas-l5-billing-trial.test.ts` duyệt đệ quy mọi khoá). `null` = chưa đo, không phải 0.
 */
export async function loadCustomerEntitlementView(orgCode: string, now: Date = new Date()): Promise<CustomerEntitlementView | null> {
  const org = await findOrganization(orgCode);
  if (!org) return null;
  const pricing = await resolveOrgPricing(org);
  const price = pricing.plan?.planPrice ?? null;
  const period = usagePeriodOf(now);
  const [gate, ac, usage, planUsage, trial, botEnabled] = await Promise.all([
    loadAiEntitlement(org.code, { now }),
    readAiCustomerUsage([org.code], period, now).catch(() => new Map()),
    readPeriodUsage(org, period, now).catch(() => null),
    getPlanUsage(org.code).catch(() => null),
    readTrialTerms(org.code),
    botEnabledOf(org.code),
  ]);
  const reading = ac.get(org.code) as { value: number | null; coverage: MeterCoverage } | undefined;
  const inc = price?.included;
  const usersLimit = pricing.quotas.users !== undefined ? pricing.quotas.users : inc?.users;
  const fanpagesLimit = pricing.quotas.fanpages !== undefined ? pricing.quotas.fanpages : inc?.fanpages;
  const aiSales = featureGranted({ key: "ai_sales", grandfathered: pricing.row.grandfathered, overrides: pricing.row.featureOverrides, planFeatures: pricing.plan?.commercial.features ?? null }).granted;
  const state = customerAiState(gate, { aiSales, botEnabled });
  const trialEnd = gate.trial ? effectiveTrialEnd(trial.trialEndsAt, trial.paidThrough) : null;
  return {
    plan: { key: pricing.plan?.key ?? null, name: pricing.plan?.name ?? null, trial: gate.trial },
    aiCustomers: { used: reading?.value ?? null, limit: inc?.aiCustomers, coverage: reading?.coverage ?? null },
    fanpages: { used: usage?.readings.fanpages_active ?? null, limit: fanpagesLimit },
    users: { used: planUsage?.rows.find((r) => r.kind === "users")?.used ?? null, limit: usersLimit },
    period: { label: period.label, resetsOn: period.resetsOn },
    trialEndsAt: trialEnd ? trialEnd.toISOString() : null,
    paidThrough: trial.paidThrough,
    ai: { state, label: CUSTOMER_AI_STATE_LABEL[state], message: gate.reason ? AI_STOP_MESSAGE[gate.reason] : null },
  };
}
