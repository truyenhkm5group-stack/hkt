/**
 * ═══════════ LƯỢT CHỤP GIÁ TRỊ THEO TỔ CHỨC — ĐƯỜNG GHI DUY NHẤT CỦA `platform_tenant_value_snapshots` (0240 · VALUE_CENTER §8) ═══════════
 *
 * Vì sao có: `/platform/saas` muốn trả lời «khách trả bao nhiêu · AI tạo gì · ta lãi gì · ai sắp rời» cho MỌI khách, mà mỗi câu trả
 * lời cần mở CSDL của từng tổ chức (quy kết đơn, hiệu quả AI bán hàng). Làm việc đó mỗi lần mở trang là chậm tuyến tính theo số khách
 * (kiểm toán §1.4). Nên MỘT lượt chụp mỗi ngày VN, ké job `alerts` của nhà (`captureSaasSnapshot(now, { source: "JOB" })`), ghi ảnh
 * vào CSDL nhà; trang chỉ đọc ảnh.
 *
 * KHÔNG có công thức mới: số của mỗi ô là `buildTenantValue` (lib/saas/tenant-value.ts) trên ĐÚNG đầu ra của các bộ đọc đã có —
 *  · CSDL tổ chức, trong `withOrganization(mã)` (mẫu `loadAiValueKpis`): `loadOrderAttribution` + `loadAiSalesPerformance(withMoney)`
 *    cho 7 / 30 / 90 ngày, thêm MỘT lượt hiệu quả của cửa sổ liền trước (xu hướng dùng — D8);
 *  · CSDL nhà, MỘT lượt cho mọi tổ chức: sổ MRR theo ngày (`readSaasDaily`), Số dư AI (`readAiBalancePeriod` + `aiBalanceRevenueVnd`),
 *    hoá đơn đã thu theo `paid_at`, sổ AI (`readAiUsageByOrg` + một câu gom phần đọc ảnh / độ trễ model), sổ chi phí khai DIRECT;
 *  · ảnh chụp thương mại + sức khoẻ vận hành (`readTenantCommercialSignals`, lib/saas/tenant-health-daily.ts).
 *
 * LUẬT CỦA LƯỢT CHỤP:
 *  · Tổ chức được chụp chọn ở MỘT chỗ (`tenantValueTargets`): ACTIVE, không phải nhà, không phải workspace kiểm thử của ops nghiệm thu.
 *  · Một lần mỗi ngày VN: tổ chức đã có đủ ba dòng hôm nay cùng `formula_version` (và dòng sức khoẻ cùng phiên bản luật) bị bỏ qua —
 *    trừ khi `force` (ops). Hôm nay ghi đè được; ngày đã qua KHÔNG có đường nào ghi (`writableDay` — đồng hồ máy chủ).
 *  · Tuần tự từng tổ chức; try/catch theo TỔ CHỨC và theo NGUỒN: một nguồn hỏng ⇒ chỉ ô của nó `null` + `source_errors`, tổ chức
 *    khác vẫn được chụp (luật 42 — chưa biết không thành 0).
 *  · Đo thời gian từng tổ chức và trả về (`orgs[].ms`) để đo production.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { readAiBalancePeriod } from "@/lib/billing/ai-balance";
import { aiBalanceRevenueVnd, type AiBalancePeriod } from "@/lib/billing/ai-balance-rules";
import { addDays, vnDate } from "@/lib/billing/rules";
import { acceptanceWorkspaceOf } from "@/lib/constants/saas-acceptance-registry";
import { DEFAULT_TENANT_VALUE_DECISIONS, TENANT_VALUE_WINDOWS, type TenantValueNumericKey, type TenantValueWindow } from "@/lib/constants/tenant-value-metrics";
import { env } from "@/lib/env";
import { withOrganization } from "@/lib/platform/context";
import { readAiUsageByOrg, readSaasDaily, type AiUsageByOrg } from "@/lib/platform/saas-ledger";
import type { SaasDailyRow } from "@/lib/platform/saas-metrics";
import type { Organization } from "@/lib/platform/types";
import { loadOrderAttribution, type OrderAttributionReport } from "@/lib/sales-chatbot/attribution";
import { loadAiSalesPerformance, type AiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { healthCapturedToday, readTenantCommercialSignals, tenantHealthOf, tenantHealthRuleVersion, writableDay, writeTenantHealthDay, type TenantCommercialRead, type TenantCommercialSignal } from "@/lib/saas/tenant-health-daily";
import { buildTenantValue, tenantValueFormulaVersion, type TenantCogsInput, type TenantSpendInput, type TenantValue } from "@/lib/saas/tenant-value";

const DAY_MS = 86_400_000;
/** Nguồn tỷ giá quy chi phí AI ra ₫ (D11) — chỉ để in nhãn cạnh số. */
export const TENANT_VALUE_FX_SOURCE = "ENV_FACEBOOK_USD_VND";

export type TenantValueCaptureSource = "JOB" | "OPS";

/** Mã nguồn in trong `source_errors` — danh sách đóng, để màn hình / ops đếm được nguồn nào hay hỏng. */
export const TENANT_VALUE_SOURCES = ["COMMERCIAL", "HEALTH", "SAAS_DAILY", "AI_BALANCE", "INVOICES", "AI_USAGE", "AI_USAGE_DETAIL", "COST_ENTRIES", "ORG_CONTEXT", "ATTRIBUTION", "PERFORMANCE", "USAGE_PREVIOUS", "FLAT"] as const;
export type TenantValueSourceCode = (typeof TENANT_VALUE_SOURCES)[number];

// ─────────────────────────── Chọn tổ chức — MỘT chỗ ───────────────────────────

/**
 * Tổ chức được chụp: ACTIVE, KHÔNG phải nhà (nền tảng không bán cho chính nó), KHÔNG phải workspace kiểm thử của ops nghiệm thu (sổ khai
 * lib/constants/saas-acceptance-registry.ts — mẫu `loadOwnerCockpit`). Mọi lượt chụp / kiểm đi qua đây; không chỗ thứ hai tự lọc.
 */
export function tenantValueTargets(orgs: readonly Organization[]): Organization[] {
  return orgs.filter((o) => o.status === "ACTIVE" && !o.isHome && !acceptanceWorkspaceOf(o.code));
}

// ─────────────────────────── Cửa sổ ───────────────────────────

/** Đầu ngày VN của `now`. */
function startOfVnDay(now: Date): Date {
  return new Date(`${vnDate(now)}T00:00:00+07:00`);
}

/** Cửa sổ `days` ngày lịch VN tính cả hôm nay — ĐÚNG cách tính kỳ của `loadOrderAttribution` / `loadAiSalesPerformance`. */
export function valueWindow(days: number, now: Date): { from: Date; to: Date; fromDay: string; toDay: string } {
  const from = new Date(startOfVnDay(now).getTime() - (days - 1) * DAY_MS);
  return { from, to: now, fromDay: vnDate(from), toDay: vnDate(now) };
}

// ─────────────────────────── Bộ đọc (truyền được để bài kiểm ép từng nguồn hỏng) ───────────────────────────

export type InvoiceCash = { paidVnd: number | null };
export type AiUsageDetail = { visionUsd: number; latencyP50Ms: number | null };
export type DirectCostEntry = { periodMonth: string; scope: string; orgCode: string | null; accountId: string | null; amountVnd: number };

export type TenantValueReaders = {
  commercial: (now: Date) => Promise<TenantCommercialRead>;
  saasDaily: (fromDay: string) => Promise<SaasDailyRow[]>;
  aiBalance: (from: Date, to: Date) => Promise<Map<string, AiBalancePeriod>>;
  invoices: (from: Date, to: Date) => Promise<Map<string, InvoiceCash>>;
  aiUsage: (from: Date, to: Date) => Promise<Map<string, AiUsageByOrg>>;
  aiUsageDetail: (from: Date, to: Date) => Promise<Map<string, AiUsageDetail>>;
  directCosts: (fromMonth: string) => Promise<DirectCostEntry[]>;
  /** Chạy TRONG `withOrganization(orgCode)`. */
  attribution: (orgCode: string, opts: { days: number; now: Date }) => Promise<OrderAttributionReport>;
  /** Chạy TRONG `withOrganization(orgCode)`. */
  performance: (orgCode: string, opts: { days: number; now: Date; until?: Date | null; withMoney: boolean }) => Promise<AiSalesPerformance>;
};

/** Hoá đơn ĐÃ THU theo `paid_at` trong [from, to). Dòng PAID thiếu số tiền đã thu ⇒ tổng của tổ chức đó CHƯA BIẾT (không lấy số niêm yết bù). */
async function readInvoiceCash(from: Date, to: Date): Promise<Map<string, InvoiceCash>> {
  const pdb = await getPlatformDb();
  const i = schema.platformInvoices;
  const rows = await pdb
    .select({
      orgCode: i.orgCode,
      paid: sql<string>`coalesce(sum(${i.paidAmountVnd}), 0)::bigint`,
      missing: sql<number>`(count(*) filter (where ${i.paidAmountVnd} is null))::int`,
    })
    .from(i)
    .where(and(eq(i.status, "PAID"), gte(i.paidAt, from), lt(i.paidAt, to)))
    .groupBy(i.orgCode);
  return new Map(rows.map((r) => [r.orgCode, { paidVnd: Number(r.missing) > 0 ? null : Number(r.paid) }]));
}

/**
 * Phần sổ AI mà `readAiUsageByOrg` không tách: chi phí ĐỌC ẢNH do nền tảng trả (PLATFORM · VISION, trừ BLOCKED_QUOTA) và trung vị độ
 * trễ model (dòng có `latency_ms` — NULL là chưa đo, không vào trung vị). Một câu gom cho mọi tổ chức.
 */
async function readAiUsageDetail(from: Date, to: Date): Promise<Map<string, AiUsageDetail>> {
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  const rows = await pdb
    .select({
      orgCode: a.orgCode,
      visionUsd: sql<number>`coalesce(sum(${a.costUsd}) filter (where ${a.billingSource} = 'PLATFORM' and ${a.modality} = 'VISION' and ${a.status} <> 'BLOCKED_QUOTA'), 0)::float8`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${a.latencyMs}) filter (where ${a.latencyMs} is not null)`,
    })
    .from(a)
    .where(and(gte(a.at, from), lt(a.at, to)))
    .groupBy(a.orgCode);
  return new Map(rows.map((r) => [r.orgCode, { visionUsd: Number(r.visionUsd), latencyP50Ms: r.p50 === null || r.p50 === undefined ? null : Math.round(Number(r.p50)) }]));
}

/** Khoản chi phí ngoài AI khai DIRECT (EXTERNAL_API · MESSAGING), chưa huỷ, từ tháng `fromMonth`. */
async function readDirectCosts(fromMonth: string): Promise<DirectCostEntry[]> {
  const pdb = await getPlatformDb();
  const c = schema.platformCostEntries;
  const rows = await pdb
    .select({ periodMonth: c.periodMonth, scope: c.scope, orgCode: c.orgCode, accountId: c.accountId, amountVnd: c.amountVnd })
    .from(c)
    .where(and(gte(c.periodMonth, fromMonth), isNull(c.voidedAt), eq(c.allocationBasis, "DIRECT"), inArray(c.category, ["EXTERNAL_API", "MESSAGING"])));
  return rows.map((r) => ({ periodMonth: r.periodMonth, scope: r.scope, orgCode: r.orgCode, accountId: r.accountId, amountVnd: Number(r.amountVnd) }));
}

export const DEFAULT_TENANT_VALUE_READERS: Readonly<TenantValueReaders> = Object.freeze({
  commercial: (now: Date) => readTenantCommercialSignals(now),
  saasDaily: (fromDay: string) => readSaasDaily(fromDay),
  aiBalance: (from: Date, to: Date) => readAiBalancePeriod(from, to),
  invoices: readInvoiceCash,
  aiUsage: (from: Date, to: Date) => readAiUsageByOrg(from, to),
  aiUsageDetail: readAiUsageDetail,
  directCosts: readDirectCosts,
  attribution: (_orgCode: string, opts: { days: number; now: Date }) => loadOrderAttribution(opts),
  performance: (orgCode: string, opts: { days: number; now: Date; until?: Date | null; withMoney: boolean }) => loadAiSalesPerformance(orgCode, opts),
});

// ─────────────────────────── Ghép đầu vào từ sổ nhà — HÀM THUẦN ───────────────────────────

type HomeWindow = {
  balances: Map<string, AiBalancePeriod> | null;
  invoices: Map<string, InvoiceCash> | null;
  aiUsage: Map<string, AiUsageByOrg> | null;
  aiDetail: Map<string, AiUsageDetail> | null;
};

export type HomeReads = {
  commercial: Map<string, TenantCommercialSignal> | null;
  saasDaily: SaasDailyRow[] | null;
  directCosts: DirectCostEntry[] | null;
  windows: Map<TenantValueWindow, HomeWindow>;
  /** Lỗi nguồn nhà — chép vào `source_errors` của MỌI dòng (nguồn đó hỏng cho mọi tổ chức). */
  errors: string[];
};

/**
 * Khách trả trong cửa sổ. MRR ghi nhận = Σ mrr_vnd × 12 / 365 của những ngày ĐÃ chụp với MRR biết được; ngày vắng / MRR chưa biết đếm
 * vào `mrrDaysMissing` (cận dưới). Không ngày nào biết ⇒ `null`, không phải 0. Phần vượt: bảng kê theo THÁNG không cắt được theo cửa
 * sổ ⇒ `null`, trừ khách TRẢ TRƯỚC (vượt trừ thẳng Số dư AI) ⇒ 0 thật (VALUE_CENTER §8). HÀM THUẦN.
 */
export function spendFor(orgCode: string, days: TenantValueWindow, now: Date, home: Pick<HomeReads, "commercial" | "saasDaily">, w: Pick<HomeWindow, "balances" | "invoices">): TenantSpendInput {
  const win = valueWindow(days, now);
  let mrrAccrualVnd: number | null = null;
  let mrrDaysMissing: number = days;
  if (home.saasDaily) {
    const known = home.saasDaily.filter((r) => r.orgCode === orgCode && r.day >= win.fromDay && r.day <= win.toDay && r.mrrVnd !== null);
    const knownDays = new Set(known.map((r) => r.day)).size;
    mrrDaysMissing = Math.max(0, days - knownDays);
    mrrAccrualVnd = knownDays === 0 ? null : Math.round(known.reduce((s, r) => s + (r.mrrVnd ?? 0), 0) * (12 / 365));
  }
  const bal = w.balances ? (w.balances.get(orgCode) ?? null) : undefined;
  const signal = home.commercial ? (home.commercial.get(orgCode) ?? null) : null;
  return {
    mrrAccrualVnd,
    mrrDaysMissing,
    aiBalanceRevenueVnd: bal === undefined ? null : aiBalanceRevenueVnd(bal),
    overageBilledVnd: signal?.prepaid ? 0 : null,
    cashInvoicesVnd: w.invoices ? (w.invoices.has(orgCode) ? w.invoices.get(orgCode)!.paidVnd : 0) : null,
    cashTopupVnd: bal === undefined ? null : (bal?.topupVnd ?? 0),
    promoUsedVnd: bal === undefined ? null : (bal?.usagePromoVnd ?? 0),
  };
}

/** Số ngày lịch chung giữa tháng `periodMonth` (YYYY-MM-01) và [fromDay, toDay]. */
function overlapDays(periodMonth: string, fromDay: string, toDay: string): { overlap: number; monthDays: number } {
  const start = periodMonth;
  const next = (() => {
    const [y, m] = periodMonth.split("-").map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  })();
  const monthDays = Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
  const lo = start > fromDay ? start : fromDay;
  const lastOfMonth = addDays(next, -1);
  const hi = lastOfMonth < toDay ? lastOfMonth : toDay;
  const overlap = hi < lo ? 0 : Math.round((Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / DAY_MS) + 1;
  return { overlap, monthDays };
}

/**
 * Chi phí ngoài AI khai DIRECT của tổ chức trong cửa sổ: khoản theo THÁNG chia theo số ngày chồng lấn (luật 14). Khoản khai cho cả
 * TÀI KHOẢN (không tách được về workspace) chạm cửa sổ ⇒ `null` (có khoản chưa biết số — VALUE_CENTER §8). Không khoản nào ⇒ 0 thật.
 */
export function otherVariableFor(orgCode: string, accountId: string | null | undefined, entries: readonly DirectCostEntry[] | null, days: TenantValueWindow, now: Date): number | null {
  if (!entries) return null;
  const win = valueWindow(days, now);
  let total = 0;
  for (const e of entries) {
    const { overlap, monthDays } = overlapDays(e.periodMonth, win.fromDay, win.toDay);
    if (overlap <= 0) continue;
    if (e.scope === "WORKSPACE" && e.orgCode === orgCode) total += (e.amountVnd * overlap) / monthDays;
    // Tài khoản của tổ chức chưa biết (ảnh thương mại hỏng) mà có khoản cấp tài khoản ⇒ không biết khoản đó có phải của nó không.
    else if (e.scope === "ACCOUNT" && (accountId === undefined || e.accountId === accountId)) return null;
  }
  return Math.round(total);
}

export function cogsFor(orgCode: string, days: TenantValueWindow, now: Date, home: Pick<HomeReads, "commercial" | "directCosts">, w: Pick<HomeWindow, "aiUsage" | "aiDetail">, fx: number | null): TenantCogsInput {
  const usd = (v: number | null) => (v === null || fx === null ? null : Math.round(v * fx));
  const platform = w.aiUsage ? (w.aiUsage.get(orgCode)?.platform ?? { costUsd: 0, requests: 0, unpricedRequests: 0 }) : null;
  const accountId = home.commercial ? (home.commercial.get(orgCode)?.accountId ?? null) : undefined;
  return {
    aiPlatformVnd: platform ? usd(platform.costUsd) : null,
    aiUnpricedCalls: platform?.unpricedRequests ?? 0,
    aiVisionVnd: w.aiDetail ? usd(w.aiDetail.get(orgCode)?.visionUsd ?? 0) : null,
    otherVariableVnd: otherVariableFor(orgCode, accountId, home.directCosts, days, now),
    // D6 mặc định chưa khai phí thanh toán — không có sổ nào để đọc.
    paymentFeeVnd: null,
  };
}

export function aiCallsFor(orgCode: string, w: Pick<HomeWindow, "aiUsage" | "aiDetail">): { total: number; errors: number; modelLatencyP50Ms: number | null } | null {
  if (!w.aiUsage) return null;
  const u = w.aiUsage.get(orgCode);
  return { total: u?.requests ?? 0, errors: u?.errors ?? 0, modelLatencyP50Ms: w.aiDetail?.get(orgCode)?.latencyP50Ms ?? null };
}

// ─────────────────────────── Cột phẳng — HÀM THUẦN ───────────────────────────

export type FlatColumns = {
  customerSpendVnd: number | null;
  variableCogsVnd: number | null;
  platformGrossProfitVnd: number | null;
  aiCreditedGrossProfitVnd: number | null;
  valueMultipleMilli: number | null;
  ordersPending: number | null;
};

/**
 * Cột phẳng để SẮP XẾP: chỉ ô ở trạng thái `VALUE` mới có số — `UNKNOWN` / `NOT_APPLICABLE` ⇒ `NULL` (chưa biết / không áp dụng ≠ 0).
 * Cận (dưới / trên) nằm trong `metrics`, cột phẳng chép giá trị của ô. Khách trả âm (đảo khoản lớn hơn phần dùng trong cửa sổ) không vào
 * cột không-âm: để `NULL` + một dòng `FLAT` trong `source_errors`, số thật vẫn ở `metrics`. HÀM THUẦN.
 */
export function flatColumns(v: TenantValue): { flat: FlatColumns; notes: string[] } {
  const notes: string[] = [];
  const val = (k: TenantValueNumericKey): number | null => {
    const c = v.metrics[k];
    return c && c.state === "VALUE" && c.value !== null && Number.isFinite(c.value) ? c.value : null;
  };
  const int = (x: number | null) => (x === null ? null : Math.round(x));
  let spend = int(val("customer_spend_recognized"));
  if (spend !== null && spend < 0) {
    notes.push(`FLAT: khách trả ghi nhận âm (${spend}) — cột phẳng để trống, số ở metrics`);
    spend = null;
  }
  const mult = val("customer_value_multiple");
  return {
    flat: {
      customerSpendVnd: spend,
      variableCogsVnd: int(val("variable_cogs_known")),
      platformGrossProfitVnd: int(val("platform_gross_profit")),
      aiCreditedGrossProfitVnd: int(val("ai_credited_gross_profit")),
      valueMultipleMilli: mult === null ? null : Math.round(mult * 1000),
      ordersPending: int(val("orders_pending")),
    },
    notes,
  };
}

// ─────────────────────────── Lượt chụp ───────────────────────────

export type TenantValueOrgResult = { orgCode: string; ms: number; rows: number; healthWritten: boolean; sourceErrors: string[] };

export type TenantValueCaptureResult = {
  day: string;
  formulaVersion: string;
  ruleVersion: string;
  source: TenantValueCaptureSource;
  /** `REFUSED` = `now` không phải hôm nay (ngày cũ không bao giờ được ghi) · `SKIPPED` = mọi tổ chức đã chụp hôm nay. */
  status: "CAPTURED" | "SKIPPED" | "REFUSED";
  targets: number;
  /** Tổ chức đã có ảnh hôm nay cùng phiên bản — bỏ qua. */
  alreadyCaptured: string[];
  orgs: TenantValueOrgResult[];
  /** Thời gian đọc sổ nhà (một lượt cho mọi tổ chức). */
  homeMs: number;
  totalMs: number;
  /** Lỗi nguồn nhà + lỗi theo tổ chức (câu ngắn, không PII). */
  errors: string[];
};

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

async function attempt<T>(source: TenantValueSourceCode, errors: string[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${source}: ${short(e)}`);
    return null;
  }
}

/** Tổ chức đã có đủ ba cửa sổ hôm nay cùng `formula_version`. */
async function valueCapturedToday(day: string, orgCodes: readonly string[]): Promise<Set<string>> {
  if (!orgCodes.length) return new Set();
  const pdb = await getPlatformDb();
  const t = schema.platformTenantValueSnapshots;
  const rows = await pdb
    .select({ orgCode: t.orgCode, n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.capturedDay, day), eq(t.formulaVersion, tenantValueFormulaVersion()), inArray(t.orgCode, [...orgCodes])))
    .groupBy(t.orgCode);
  return new Set(rows.filter((r) => Number(r.n) >= TENANT_VALUE_WINDOWS.length).map((r) => r.orgCode));
}

/** Tổ chức còn phải chụp HÔM NAY — để đường job quyết có cần chạy lượt chụp khi ảnh MRR còn mới. Không ghi gì. */
export async function tenantValueDue(orgs: readonly Organization[], now: Date): Promise<boolean> {
  const day = writableDay(now);
  if (!day) return false;
  const codes = tenantValueTargets(orgs).map((o) => o.code);
  if (!codes.length) return false;
  const [v, h] = await Promise.all([valueCapturedToday(day, codes), healthCapturedToday(day, codes)]);
  return codes.some((c) => !v.has(c) || !h.has(c));
}

async function readHome(now: Date, r: Readonly<TenantValueReaders>): Promise<HomeReads> {
  const errors: string[] = [];
  const commercialRead = await attempt("COMMERCIAL", errors, () => r.commercial(now));
  if (commercialRead) errors.push(...commercialRead.errors);
  const widest = valueWindow(Math.max(...TENANT_VALUE_WINDOWS), now);
  const saasDaily = await attempt("SAAS_DAILY", errors, () => r.saasDaily(widest.fromDay));
  const directCosts = await attempt("COST_ENTRIES", errors, () => r.directCosts(`${widest.fromDay.slice(0, 7)}-01`));
  const windows = new Map<TenantValueWindow, HomeWindow>();
  for (const days of TENANT_VALUE_WINDOWS) {
    const w = valueWindow(days, now);
    const errs: string[] = [];
    windows.set(days, {
      balances: await attempt("AI_BALANCE", errs, () => r.aiBalance(w.from, w.to)),
      invoices: await attempt("INVOICES", errs, () => r.invoices(w.from, w.to)),
      aiUsage: await attempt("AI_USAGE", errs, () => r.aiUsage(w.from, w.to)),
      aiDetail: await attempt("AI_USAGE_DETAIL", errs, () => r.aiUsageDetail(w.from, w.to)),
    });
    errors.push(...errs.map((m) => m.replace(/^([A-Z_]+):/, `$1 (${days} ngày):`)));
  }
  return { commercial: commercialRead?.signals ?? null, saasDaily, directCosts, windows, errors };
}

/**
 * Chụp ảnh giá trị + sức khoẻ HÔM NAY cho các tổ chức trong `orgs` (lọc lại bằng `tenantValueTargets`). Chỉ đường JOB của nhà gọi
 * (`captureSaasSnapshot(now, { source: "JOB" })`) — và ops khi người vận hành chủ động chạy (`source: "OPS"`). Không bao giờ ném vì một
 * tổ chức / một nguồn: lỗi nằm trong kết quả.
 */
export async function captureTenantValue(
  orgs: readonly Organization[],
  now: Date,
  opts: { source: TenantValueCaptureSource; force?: boolean; readers?: Partial<TenantValueReaders> },
): Promise<TenantValueCaptureResult> {
  const t0 = Date.now();
  const formulaVersion = tenantValueFormulaVersion();
  const ruleVersion = tenantHealthRuleVersion();
  const targets = tenantValueTargets(orgs);
  const base = { formulaVersion, ruleVersion, source: opts.source, targets: targets.length, orgs: [] as TenantValueOrgResult[], homeMs: 0 };
  const day = writableDay(now);
  if (!day) return { ...base, day: vnDate(now), status: "REFUSED", alreadyCaptured: [], totalMs: Date.now() - t0, errors: [`Không ghi ngày ${vnDate(now)}: chỉ chụp được HÔM NAY (giờ VN) — ngày đã qua đóng băng.`] };

  const codes = targets.map((o) => o.code);
  let done = new Set<string>();
  if (!opts.force) {
    const [v, h] = await Promise.all([valueCapturedToday(day, codes), healthCapturedToday(day, codes)]);
    done = new Set(codes.filter((c) => v.has(c) && h.has(c)));
  }
  const todo = targets.filter((o) => !done.has(o.code));
  if (!todo.length) return { ...base, day, status: "SKIPPED", alreadyCaptured: [...done], totalMs: Date.now() - t0, errors: [] };

  const r: Readonly<TenantValueReaders> = { ...DEFAULT_TENANT_VALUE_READERS, ...(opts.readers ?? {}) };
  const tHome = Date.now();
  const home = await readHome(now, r);
  const homeMs = Date.now() - tHome;
  const fxRaw = env.facebook.usdToVnd;
  const fx = Number.isFinite(fxRaw) && fxRaw > 0 ? fxRaw : null;
  const d = DEFAULT_TENANT_VALUE_DECISIONS;
  const pdb = await getPlatformDb();
  const table = schema.platformTenantValueSnapshots;
  const errors = [...home.errors];
  const results: TenantValueOrgResult[] = [];

  for (const org of todo) {
    const tOrg = Date.now();
    const orgErrors: string[] = [];
    const attr = new Map<TenantValueWindow, OrderAttributionReport | null>();
    const perf = new Map<TenantValueWindow, AiSalesPerformance | null>();
    const winErrors = new Map<TenantValueWindow, string[]>(TENANT_VALUE_WINDOWS.map((w) => [w, []]));
    let previousConversations: number | null = null;
    let rows = 0;
    let healthWritten = false;
    try {
      // CSDL tổ chức — một ngữ cảnh cho cả tổ chức; mở hỏng ⇒ mọi ô của nguồn tổ chức `null` + ORG_CONTEXT.
      await withOrganization(org.code, async () => {
        for (const days of TENANT_VALUE_WINDOWS) {
          const errs = winErrors.get(days)!;
          attr.set(days, await attempt("ATTRIBUTION", errs, () => r.attribution(org.code, { days, now })));
          perf.set(days, await attempt("PERFORMANCE", errs, () => r.performance(org.code, { days, now, withMoney: true })));
        }
        // Cửa sổ liền trước của cửa sổ mặc định (D12) — CÙNG bộ đọc, CÙNG định nghĩa hội thoại; hỏng ⇒ xu hướng CHƯA ĐO (UNKNOWN).
        const cur = valueWindow(d.defaultWindowDays, now);
        const prevNow = new Date(cur.from.getTime() - 1);
        const prev = await attempt("USAGE_PREVIOUS", orgErrors, () => r.performance(org.code, { days: d.defaultWindowDays, now: prevNow, until: prevNow, withMoney: false }));
        previousConversations = prev ? prev.cohorts.total.conversations : null;
      }).catch((e: unknown) => {
        orgErrors.push(`ORG_CONTEXT: ${short(e)}`);
      });

      const signal = home.commercial ? (home.commercial.get(org.code) ?? null) : null;
      const values = new Map<TenantValueWindow, TenantValue>();
      for (const days of TENANT_VALUE_WINDOWS) {
        const hw = home.windows.get(days)!;
        const win = valueWindow(days, now);
        const value = buildTenantValue({
          window: days,
          // Workspace chưa gắn tài khoản / ảnh thương mại hỏng ⇒ không biết cách lập chứng từ. Khi đó phần vượt cũng `null` ⇒ khách trả
          // ghi nhận `null` ⇒ biên / bội số ra CHƯA BIẾT (không phải số đoán theo khách ngoài).
          marginApplicable: signal?.marginApplicable ?? true,
          fx: { rateVndPerUsd: fx, source: TENANT_VALUE_FX_SOURCE },
          spend: spendFor(org.code, days, now, home, hw),
          cogs: cogsFor(org.code, days, now, home, hw, fx),
          attribution: attr.get(days) ?? null,
          perf: perf.get(days) ?? null,
          aiCalls: aiCallsFor(org.code, hw),
        });
        values.set(days, value);
        const { flat, notes } = flatColumns(value);
        const sourceErrors = [...home.errors, ...orgErrors, ...winErrors.get(days)!, ...notes].map((m) => m.slice(0, 200));
        const row = { capturedDay: day, orgCode: org.code, windowDays: days, windowFrom: win.from, windowTo: win.to, metrics: { ...value.metrics }, ...flat, formulaVersion, sourceErrors, capturedAt: now };
        // Khoá (ngày, tổ chức, cửa sổ) chỉ trùng được với dòng CỦA HÔM NAY — ảnh cuối ngày thắng.
        await pdb.insert(table).values(row).onConflictDoUpdate({ target: [table.capturedDay, table.orgCode, table.windowDays], set: { ...row } });
        rows += 1;
      }

      const current = perf.get(d.defaultWindowDays)?.cohorts.total.conversations ?? null;
      const healthDay = tenantHealthOf({ orgCode: org.code, signal, value: values.get(d.multipleWindowDays) ?? null, usage: { current, previous: previousConversations } });
      healthWritten = await writeTenantHealthDay(org.code, now, healthDay);
    } catch (e) {
      errors.push(`[${org.code}] ${short(e)}`);
    }
    const sourceErrors = [...orgErrors, ...TENANT_VALUE_WINDOWS.flatMap((w) => winErrors.get(w)!.map((m) => `${w}d ${m}`))];
    results.push({ orgCode: org.code, ms: Date.now() - tOrg, rows, healthWritten, sourceErrors });
  }
  return { ...base, day, status: "CAPTURED", alreadyCaptured: [...done], orgs: results, homeMs, totalMs: Date.now() - t0, errors };
}
