/**
 * ═══════════ CHẾ ĐỘ «AI DÙNG CHUNG TRẢ TRƯỚC» CỦA MỘT TỔ CHỨC (docs/saas/AI_BALANCE_V1.md §7) — CHỈ MÁY CHỦ ═══════════
 *
 * Quyết định chủ shop 08/10/2026: tổ chức khách đang chạy AI bằng khoá RIÊNG (vd HSLC `gemini-byok`) chuyển sang AI dùng chung
 * của nền tảng NHƯ MỘT KHÁCH — nạp tiền qua QR (Số dư AI), nạp bao nhiêu dùng bấy nhiêu, KHÔNG có credit nền tảng miễn phí.
 *
 * KHÔNG dựng hệ thứ hai và KHÔNG có nhánh theo mã tổ chức — chế độ này là DỮ LIỆU:
 *  · phiên bản giá «Trả trước theo khách AI» (`publishPrepaidAiVersion`, kind chỉ-tới-bằng-ghim): giá thuê bao giữ như giá cũ,
 *    khách AI gồm 0, khối khách AI theo giá vượt của gói AI tự mua rẻ nhất (V1: 590đ / khách) ⇒ `balanceOverageTerms` trả
 *    `included = 0` ⇒ MỌI khách AI trừ Số dư AI (`chargeAiCustomerUsage`), hết số dư ⇒ khách MỚI không nhận AI (`aiBalanceGate`)
 *    — đúng các đường đang chạy cho phần vượt, không sửa dòng nào của chúng;
 *  · cờ `ai_balance.enabled` (đường bật có sẵn, nhật ký nền tảng) — cờ tắt thì phiên bản trả trước KHÔNG trừ, KHÔNG chặn, và
 *    trần AI rơi về trần cũ của gói (credit là trần CỨNG — `catalogAiLimits`);
 *  · cờ bật + ghim ⇒ `prepaidAiLimits`: chưa có credit (bot còn khoá riêng) ⇒ trần tiền của gói như cũ; có credit (đặt cùng lượt
 *    `org-ai-cutover`) ⇒ credit = ngưỡng CẢNH BÁO, trần cứng chống lạm dụng = credit × 3, cổng khách AI MỚI là SỐ DƯ.
 *
 * Thứ tự an toàn (mỗi lượt `--apply` của ops làm ĐÚNG MỘT bước kế tiếp — `prepaidStep`):
 *  1. MỞ NẠP — bật cờ khi tổ chức còn ở giá cũ: giá cũ không có khối khách AI ⇒ chưa trừ, chưa chặn gì; khách tạo được mã QR;
 *  2. CHỜ NẠP — số dư dưới mức kích hoạt (≥ max(100.000đ, ước tính 1 ngày); `--force-low-balance` hạ xuống > 0) ⇒ KHÔNG ghim
 *     (ghim lúc số dư 0 là AI ngừng nhận khách mới ngay — bot im với khách thật);
 *  3. KÍCH HOẠT — đòi `--unit=<đ>` khớp đơn giá đọc lúc ghi; chặn khi còn hoá đơn gia hạn ĐANG MỞ theo giá khác; phát hành phiên
 *     bản (nếu chưa có) + ghim, nhật ký `PRICE_VERSION_PIN` nguồn SCRIPT;
 *  4. ĐANG CHẠY — chạy thử nói rõ bot còn khoá riêng hay đã sang `platform`; việc còn lại là `org-ai-cutover --apply --credit=<USD>`
 *     (script này KHÔNG đổi động cơ, KHÔNG đặt credit).
 * Cổng chặn mọi bước: chưa khai tài khoản nhận tiền ⇒ khách không nạp được ⇒ không làm gì (KHÔNG tự khai).
 */
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, schema } from "@/db";
import { readOrgAiControl } from "@/lib/ai-usage/control";
import { resolveAiLimits, type ResolvedAiLimits } from "@/lib/ai-usage/quota";
import { applyAiOverride, parseAiLimits, vnDayKey, type AiLimits, type AiLimitsOverride } from "@/lib/ai-usage/types";
import { aiBalanceEnabled, readAiBalance, readAiCustomerChargedUnits, type AiBalance } from "@/lib/billing/ai-balance";
import { TOPUP_MIN_VND } from "@/lib/billing/ai-balance-rules";
import { balanceOverageTerms, type BalanceOverageTerms } from "@/lib/billing/ai-usage-charge";
import { getBillingReceiver } from "@/lib/billing/receiver";
import { listPlans, planKeyOf } from "@/lib/entitlements/check";
import { platformAudit } from "@/lib/platform/audit";
import { enableAiBalanceAsOperator } from "@/lib/platform/kill-switches";
import { findOrganization } from "@/lib/platform/organizations";
import type { Organization } from "@/lib/platform/types";
import { invalidateAiEntitlement } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { loadPriceBook, orgPriceVersion, pinOrgPriceVersion, publishPrepaidAiVersion, readPricePin } from "@/lib/pricing/price-book";
import {
  currentCatalogVersion,
  isPrepaidAiPrice,
  isPrepaidVersionKey,
  LEGACY_VERSION_KEY,
  prepaidAiLimits,
  prepaidAiTerms,
  PREPAID_AI_VERSION_KEY,
  PREPAID_AI_VERSION_LABEL,
  priceOf,
  type PlanPrice,
  type PrepaidAiTerms,
} from "@/lib/pricing/versions";
import { parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { rowsOf } from "@/lib/sql-rows";

export const PREPAID_PUBLISH_REASON = "Chế độ AI dùng chung trả trước theo khách AI — quyết định chủ shop 08/10/2026 (phương án tốt nhất: giữ giá thuê bao cũ, mọi khách AI trừ Số dư AI)";
export const PREPAID_PIN_REASON = "Chuyển tổ chức sang «Trả trước theo khách AI»: mọi khách AI trừ Số dư AI, hết số dư ⇒ khách mới không nhận AI — quyết định chủ shop 08/10/2026 (ops org-prepaid-ai)";
export const PREPAID_FLAG_REASON = "Mở nạp Số dư AI trước khi chuyển sang AI dùng chung trả trước — quyết định chủ shop 08/10/2026 (ops org-prepaid-ai)";

// ─────────────────────────── HÀM THUẦN ───────────────────────────

export type PrepaidStep = "OPEN_TOPUP" | "WAIT_TOPUP" | "ACTIVATE" | "ACTIVE" | "BLOCKED";

export const PREPAID_STEP_LABEL: Record<PrepaidStep, string> = {
  OPEN_TOPUP: "MỞ NẠP — bật Số dư AI để chủ shop nạp tiền (chưa trừ, chưa chặn gì)",
  WAIT_TOPUP: "CHỜ NẠP — số dư dưới mức kích hoạt, KHÔNG ghim (ghim lúc này là AI sớm ngừng nhận khách mới)",
  ACTIVATE: "KÍCH HOẠT — ghim phiên bản «Trả trước theo khách AI» (cần --unit=<đ> khớp đơn giá)",
  ACTIVE: "ĐANG CHẠY trả trước — còn lại: chuyển động cơ AI sang AI dùng chung (org-ai-cutover)",
  BLOCKED: "CHẶN — không làm gì",
};

/** Số dư tối thiểu để KÍCH HOẠT = max(mức nạp tối thiểu, ước tính MỘT ngày) — dưới mức ấy bot sẽ ngừng nhận khách mới trong ngày. */
export function prepaidMinActivateVnd(vndPerDay: number | null): number {
  return Math.max(TOPUP_MIN_VND, vndPerDay ?? 0);
}

/** Số dư đủ bao nhiêu GIỜ theo nhịp ước tính — `null` = chưa ước được nhịp (KHÔNG phải 0 giờ). */
export function prepaidHoursCovered(balanceVnd: number | null, vndPerDay: number | null): number | null {
  if (balanceVnd === null || vndPerDay === null || !(vndPerDay > 0)) return null;
  return Math.max(0, Math.floor((balanceVnd / vndPerDay) * 24));
}

/**
 * Bước KẾ TIẾP của một tổ chức — thuần trên các sự thật đã đọc. `blockers` không rỗng ⇒ `BLOCKED`. Trạng thái lệch (đã ghim trả
 * trước mà cờ tắt — người vận hành tắt khẩn) cũng là `BLOCKED`: bật lại cờ lúc ấy là quyết định trên màn hình, không phải của ops.
 * `activationBlockers` chỉ chặn bước KÍCH HOẠT (vd hoá đơn gia hạn đang mở theo giá cũ). Số dư phải > 0 VÀ ≥ mức kích hoạt; cờ
 * `forceLowBalance` (người vận hành chủ động) hạ điều kiện xuống > 0 — không bao giờ cho ghim khi số dư ≤ 0.
 */
export function prepaidStep(f: { blockers: readonly string[]; activationBlockers?: readonly string[]; onPrepaid: boolean; flagOn: boolean; balanceVnd: number | null; minBalanceVnd?: number; forceLowBalance?: boolean }): PrepaidStep {
  if (f.blockers.length) return "BLOCKED";
  if (f.onPrepaid) return f.flagOn ? "ACTIVE" : "BLOCKED";
  if (!f.flagOn) return "OPEN_TOPUP";
  if (f.balanceVnd === null || f.balanceVnd <= 0) return "WAIT_TOPUP";
  if (!f.forceLowBalance && f.balanceVnd < (f.minBalanceVnd ?? TOPUP_MIN_VND)) return "WAIT_TOPUP";
  if (f.activationBlockers?.length) return "BLOCKED";
  return "ACTIVATE";
}

export type DayCount = { day: string; n: number };
export type DayCost = { day: string; usd: number | null };

/** Số ngày VN TRỌN tối thiểu của đồng hồ khách AI để dùng nó làm cơ sở; ít hơn ⇒ dùng số hội thoại AI (cận trên). */
export const PREPAID_METER_MIN_DAYS = 3;
/** Biên an toàn của credit gợi ý (= ngưỡng CẢNH BÁO sau khi chuyển) — cùng tinh thần `CREDIT_MARGIN` của org-ai-cutover. */
export const PREPAID_CREDIT_MARGIN = 1.25;

export type PrepaidUsageEstimate = {
  /** 7 ngày VN TRỌN gần nhất (cũ → mới) — hôm nay chưa xong không vào cơ sở. */
  days7: string[];
  meterFirstDay: string | null;
  /** Số ngày TRỌN trong 7 ngày mà đồng hồ khách AI đã ghi suốt ngày (ngày bật đồng hồ là ngày lẻ, không tính). */
  meterFullDays: number;
  meterPerDay: number | null;
  convPerDay: number | null;
  /** Cơ sở khách AI / ngày dùng để quy tiền: đồng hồ (đủ ngày) hay hội thoại AI (cận trên — khách quay lại nhiều ngày đếm nhiều lần). */
  basis: "METER" | "CONVERSATIONS" | null;
  customersPerDay: number | null;
  vndPerDay: number | null;
  topup7dVnd: number | null;
  topup30dVnd: number | null;
  cost7dUsd: number | null;
  creditSuggestUsd: number | null;
};

const roundUpTo = (v: number, step: number) => Math.ceil(v / step) * step;

/**
 * Mức dùng quy ra tiền — HÀM THUẦN, mọi số là ƯỚC TÍNH (nhãn in cạnh). Mỗi vế = LỚN NHẤT của (trung bình các ngày trọn đo được ·
 * ngày trọn gần nhất): bot vừa chạy đông vài ngày thì trung bình 7 ngày kéo số xuống và khách nạp thiếu. Không đo được ⇒ `null`
 * (KHÔNG phải 0). Gợi ý nạp làm tròn LÊN tới 100.000đ, không dưới mức nạp tối thiểu.
 */
export function prepaidUsageEstimate(input: { now: Date; meterFirstAt: Date | null; meterByDay: readonly DayCount[]; convByDay: readonly DayCount[]; costByDay: readonly DayCost[]; unitPriceVnd: number | null }): PrepaidUsageEstimate {
  const days7 = Array.from({ length: 7 }, (_, i) => vnDayKey(new Date(input.now.getTime() - (7 - i) * 86_400_000)));
  const of = (rows: readonly DayCount[], d: string) => rows.find((r) => r.day === d)?.n ?? 0;
  const meterFirstDay = input.meterFirstAt ? vnDayKey(input.meterFirstAt) : null;
  const measured = meterFirstDay ? days7.filter((d) => d > meterFirstDay) : [];
  const pace = (vals: readonly number[]) => (vals.length ? Math.max(vals.reduce((s, v) => s + v, 0) / vals.length, vals[vals.length - 1]) : null);
  const meterPerDay = measured.length ? pace(measured.map((d) => of(input.meterByDay, d))) : null;
  const convVals = days7.map((d) => of(input.convByDay, d));
  const convPerDay = convVals.some((v) => v > 0) ? pace(convVals) : null;
  const basis = measured.length >= PREPAID_METER_MIN_DAYS && meterPerDay !== null ? "METER" : convPerDay !== null ? "CONVERSATIONS" : meterPerDay !== null ? "METER" : null;
  const customersPerDay = basis === "METER" ? meterPerDay : basis === "CONVERSATIONS" ? convPerDay : null;
  const unit = input.unitPriceVnd;
  const vndPerDay = customersPerDay !== null && unit !== null && unit > 0 ? Math.ceil(customersPerDay * unit) : null;
  const topup = (days: number) => (vndPerDay === null ? null : Math.max(TOPUP_MIN_VND, roundUpTo(vndPerDay * days, 100_000)));
  const costs = days7.map((d) => input.costByDay.find((r) => r.day === d)?.usd ?? null);
  const known = costs.filter((v): v is number => v !== null);
  const cost7dUsd = known.length ? Math.round(known.reduce((s, v) => s + v, 0) * 100) / 100 : null;
  const lastCost = costs[costs.length - 1];
  const monthlyUsd = cost7dUsd === null ? null : Math.max((cost7dUsd * 30) / 7, (lastCost ?? 0) * 30);
  return {
    days7,
    meterFirstDay,
    meterFullDays: measured.length,
    meterPerDay: meterPerDay === null ? null : Math.round(meterPerDay * 10) / 10,
    convPerDay: convPerDay === null ? null : Math.round(convPerDay * 10) / 10,
    basis,
    customersPerDay: customersPerDay === null ? null : Math.round(customersPerDay * 10) / 10,
    vndPerDay,
    topup7dVnd: topup(7),
    topup30dVnd: topup(30),
    cost7dUsd,
    // Làm tròn tới xu TRƯỚC khi làm tròn lên: 93,6 × 1,25 là 117,0000…1 trong số thực, không phải 118.
    creditSuggestUsd: monthlyUsd === null ? null : Math.max(1, Math.ceil(Math.round(monthlyUsd * PREPAID_CREDIT_MARGIN * 100) / 100)),
  };
}

// ─────────────────────────── ĐỌC (chỉ đọc) ───────────────────────────

export type BotEngine = { enabled: boolean; connectorKey: string };

export type PrepaidPlan = {
  orgCode: string;
  orgName: string | null;
  orgStatus: string | null;
  planKey: string | null;
  /** Phiên bản giá ĐANG áp cho tổ chức (ghim, hay bảng giá hiện hành khi chưa ghim). */
  versionKey: string | null;
  versionLabel: string | null;
  pinned: boolean;
  monthlyVnd: number | null;
  receiverReady: boolean;
  flagOn: boolean;
  onPrepaid: boolean;
  balance: AiBalance | null;
  /** Số dư tối thiểu để KÍCH HOẠT (`prepaidMinActivateVnd`) và số dư hiện tại đủ ≈ bao nhiêu giờ (`null` = chưa ước được). */
  minActivateVnd: number;
  hoursCovered: number | null;
  /** Động cơ AI Bán hàng ĐANG LƯU (đọc CSDL tổ chức ở chế độ chỉ đọc) — `null` = không đọc được. */
  engine: BotEngine | null;
  /** Hoá đơn gia hạn ĐANG MỞ mang phiên bản giá KHÁC trả trước — trả sau khi kích hoạt là hoá đơn giá cũ (review #674 M1). */
  openRenewals: { transferCode: string; priceVersionKey: string | null }[];
  /** Khách AI của kỳ (đồng hồ) và số đã có dòng trừ `aic-charge` — chênh lệch là khách chưa thu qua Số dư. */
  period: { aiCustomers: number | null; charged: number | null };
  /** Phiên bản trả trước đã có trong sổ giá chưa — chưa có thì bước KÍCH HOẠT sẽ phát hành nó. */
  prepaidVersionExists: boolean;
  terms: PrepaidAiTerms | null;
  /** Dòng giá trả trước của gói tổ chức (đã có, hay sẽ chép từ dòng legacy khi phát hành). */
  prepaidRow: Pick<PlanPrice, "monthlyVnd" | "included" | "overage"> | null;
  /** Đơn giá + phần gồm mà đường trừ tiền ĐANG đọc (`balanceOverageTerms`) — `null` = hôm nay không trừ số dư. */
  chargingNow: BalanceOverageTerms | null;
  aiLimitsNow: ResolvedAiLimits;
  /** Trần AI sau KÍCH HOẠT, bot còn khoá riêng (credit như hiện tại) — đã gồm ghi đè của người vận hành. */
  aiLimitsAfter: AiLimits | null;
  /** Trần AI sau `org-ai-cutover --credit=<gợi ý>` — `null` khi chưa có credit gợi ý. */
  aiLimitsAfterCutover: AiLimits | null;
  override: AiLimitsOverride;
  usage: PrepaidUsageEstimate | null;
  blockers: string[];
  activationBlockers: string[];
  warnings: string[];
  step: PrepaidStep;
};

/** Kết nối CSDL nền tảng có đang ở chế độ CHỈ ĐỌC không (ops chạy thử phải hỏi lại Postgres trước khi đọc). */
export async function platformDbReadOnly(): Promise<boolean> {
  const [ro] = rowsOf<Record<string, unknown>>(await (await getPlatformDb()).execute(sql`show default_transaction_read_only`));
  return String(ro?.default_transaction_read_only ?? "") === "on";
}

const dayExpr = (col: unknown) => sql<string>`to_char((${col} at time zone 'UTC') + interval '7 hours', 'YYYY-MM-DD')`;

async function readUsageFacts(orgCode: string, now: Date) {
  const pdb = await getPlatformDb();
  const since = new Date(now.getTime() - 9 * 86_400_000);
  const e = schema.platformUsageEvents;
  const meterWhere = and(eq(e.orgCode, orgCode), eq(e.productKey, "chotdon"), eq(e.metric, "ai_customers"));
  const [first] = await pdb.select({ at: sql<Date | string | null>`min(${e.occurredAt})` }).from(e).where(meterWhere);
  const meterRows = await pdb
    .select({ day: dayExpr(e.occurredAt), n: sql<number>`coalesce(sum(${e.quantity}), 0)::int` })
    .from(e)
    .where(and(meterWhere, gte(e.occurredAt, since)))
    .groupBy(dayExpr(e.occurredAt));
  const u = schema.platformAiUsage;
  const convRows = await pdb
    .select({ day: dayExpr(u.at), n: sql<number>`count(distinct ${u.conversationId})::int` })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), eq(u.feature, "sales_chatbot"), eq(u.status, "OK"), isNotNull(u.conversationId), gte(u.at, since)))
    .groupBy(dayExpr(u.at));
  const costRows = await pdb
    .select({ day: dayExpr(u.at), usd: sql<number | null>`sum(${u.costUsd})` })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), inArray(u.feature, ["sales_chatbot", "sales_playbook"]), gte(u.at, since)))
    .groupBy(dayExpr(u.at));
  const at = first?.at ? new Date(first.at) : null;
  return {
    meterFirstAt: at && Number.isFinite(at.getTime()) ? at : null,
    meterByDay: meterRows.map((r) => ({ day: String(r.day), n: Number(r.n) })),
    convByDay: convRows.map((r) => ({ day: String(r.day), n: Number(r.n) })),
    costByDay: costRows.map((r) => ({ day: String(r.day), usd: r.usd === null ? null : Number(r.usd) })),
  };
}

/** Khách AI của kỳ đang mở (đồng hồ) và số khách đã có dòng trừ Số dư trong kỳ. Lỗi ⇒ `null` (chưa biết, không phải 0). */
async function readPeriodCharges(orgCode: string, now: Date): Promise<PrepaidPlan["period"]> {
  const period = usagePeriodOf(now);
  const e = schema.platformUsageEvents;
  const aiCustomers = await (async () => {
    const [row] = await (await getPlatformDb())
      .select({ n: sql<number>`coalesce(sum(${e.quantity}), 0)::int` })
      .from(e)
      .where(and(eq(e.orgCode, orgCode), eq(e.productKey, "chotdon"), eq(e.metric, "ai_customers"), gte(e.occurredAt, period.from)));
    return Number(row?.n ?? 0);
  })().catch(() => null);
  const charged = await readAiCustomerChargedUnits(orgCode, period.from, period.to).catch(() => null);
  return { aiCustomers, charged };
}

/**
 * Động cơ AI Bán hàng ĐANG LƯU của tổ chức — đọc bằng kết nối KIỂM TRA (máy chủ ép chỉ đọc, không migrate), đúng phép đọc của bot
 * (`parseSalesChatbotConfig`). Không đọc được ⇒ `null` (nói ra, không đoán là khoá riêng hay `platform`).
 */
async function readBotEngine(org: Pick<Organization, "code" | "isHome">): Promise<BotEngine | null> {
  try {
    const db = await getDbForInspection(org);
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
    let raw: unknown = null;
    try {
      raw = row?.value ? (JSON.parse(row.value) as unknown) : null;
    } catch {
      raw = null;
    }
    const cfg = parseSalesChatbotConfig(raw);
    return { enabled: cfg.enabled, connectorKey: cfg.connectorKey };
  } catch {
    return null;
  }
}

async function readOpenRenewals(orgCode: string): Promise<PrepaidPlan["openRenewals"]> {
  const t = schema.platformInvoices;
  const rows = await (await getPlatformDb())
    .select({ transferCode: t.transferCode, priceVersionKey: t.priceVersionKey })
    .from(t)
    .where(and(eq(t.orgCode, orgCode), eq(t.status, "OPEN"), eq(t.kind, "RENEWAL")));
  return rows.filter((r) => !isPrepaidVersionKey(r.priceVersionKey)).map((r) => ({ transferCode: r.transferCode, priceVersionKey: r.priceVersionKey ?? null }));
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/** KẾ HOẠCH cho MỘT tổ chức — CHỈ ĐỌC. Không ném vì một nguồn phụ hỏng: nguồn ấy in «—» + cảnh báo. */
export async function planPrepaidAi(orgCode: string, now: Date = new Date(), opts: { forceLowBalance?: boolean } = {}): Promise<PrepaidPlan> {
  const blockers: string[] = [];
  const activationBlockers: string[] = [];
  const warnings: string[] = [];
  const org = await findOrganization(orgCode);
  const base: PrepaidPlan = {
    orgCode,
    orgName: org?.name ?? null,
    orgStatus: org?.status ?? null,
    planKey: org ? planKeyOf(org) : null,
    versionKey: null,
    versionLabel: null,
    pinned: false,
    monthlyVnd: null,
    receiverReady: false,
    flagOn: false,
    onPrepaid: false,
    balance: null,
    minActivateVnd: TOPUP_MIN_VND,
    hoursCovered: null,
    engine: null,
    openRenewals: [],
    period: { aiCustomers: null, charged: null },
    prepaidVersionExists: false,
    terms: null,
    prepaidRow: null,
    chargingNow: null,
    aiLimitsNow: null,
    aiLimitsAfter: null,
    aiLimitsAfterCutover: null,
    override: {},
    usage: null,
    blockers,
    activationBlockers,
    warnings,
    step: "BLOCKED",
  };
  if (!org) {
    blockers.push(`Không có tổ chức mã «${orgCode}».`);
    return base;
  }
  if (org.isHome) blockers.push("Tổ chức nhà dùng khoá của nhà (HOME) — không có chế độ trả trước.");
  if (org.status !== "ACTIVE") blockers.push(`Tổ chức đang ${org.status} — chỉ chuyển tổ chức ACTIVE.`);
  const planKey = planKeyOf(org);

  const receiver = await getBillingReceiver();
  base.receiverReady = receiver !== null;
  if (!receiver) blockers.push("Nền tảng CHƯA khai tài khoản nhận tiền ⇒ khách không tạo được mã nạp QR. Chủ shop cần khai tài khoản nhận tiền ở /platform (khung «Thu phí thuê bao») — script KHÔNG tự khai.");

  const [v, book] = await Promise.all([orgPriceVersion(org.code, now), loadPriceBook({ fresh: true })]);
  base.versionKey = v.version?.key ?? null;
  base.versionLabel = v.version?.label ?? null;
  base.pinned = v.pinned;
  const current = priceOf(book, v.version?.key, planKey);
  base.monthlyVnd = current?.price.monthlyVnd ?? null;
  base.onPrepaid = isPrepaidVersionKey(v.version?.key) && !!current && current.source === "VERSION" && isPrepaidAiPrice(current.price, v.version?.kind ?? null);
  if (v.note) warnings.push(v.note);

  // Phiên bản trả trước: đã có ⇒ đọc đơn giá từ chính dòng của nó; chưa có ⇒ dẫn xuất từ bảng giá niêm yết + dòng legacy của gói.
  const prepaidVersion = book.versions.find((x) => x.key === PREPAID_AI_VERSION_KEY) ?? null;
  base.prepaidVersionExists = prepaidVersion !== null;
  if (prepaidVersion) {
    const own = book.prices.find((p) => p.versionKey === PREPAID_AI_VERSION_KEY && p.planKey === planKey && isPrepaidAiPrice(p, prepaidVersion.kind)) ?? null;
    if (!own) blockers.push(`Phiên bản «${PREPAID_AI_VERSION_KEY}» không có dòng giá trả trước cho gói «${planKey}» — cần phiên bản trả trước mới (không vá phiên bản đã phát hành).`);
    else {
      const size = own.overage.aiCustomerBlockSize as number;
      const vnd = own.overage.aiCustomerBlockVnd as number;
      base.terms = { blockSize: size, blockVnd: vnd, unitPriceVnd: Math.ceil(vnd / size), fromVersionKey: PREPAID_AI_VERSION_KEY, fromPlanKey: own.planKey, fromPlanName: own.name };
      base.prepaidRow = { monthlyVnd: own.monthlyVnd, included: own.included, overage: own.overage };
    }
  } else {
    const catalog = currentCatalogVersion(book, now);
    base.terms = catalog ? prepaidAiTerms(book.prices.filter((p) => p.versionKey === catalog.key)) : null;
    if (!base.terms) blockers.push("Bảng giá niêm yết không có gói AI tự mua nào khai giá vượt khách AI — không dẫn xuất được đơn giá.");
    const legacyRow = book.prices.find((p) => p.versionKey === LEGACY_VERSION_KEY && p.planKey === planKey) ?? null;
    if (!legacyRow) blockers.push(`Gói «${planKey}» không có dòng giá cũ (legacy) để chép — không chuyển.`);
    else if (base.terms) base.prepaidRow = { monthlyVnd: legacyRow.monthlyVnd, included: { ...legacyRow.included, aiCustomers: 0, fanpages: null, users: null }, overage: { mode: "BILLED", aiCustomerBlockSize: base.terms.blockSize, aiCustomerBlockVnd: base.terms.blockVnd, extraFanpageVnd: null, extraUserVnd: null } };
  }
  // V1: chỉ tổ chức đang ở GIÁ CŨ (legacy) — tổ chức theo bảng giá V1 đã trừ Số dư cho phần vượt; đưa họ sang trả trước toàn
  // phần là một quyết định giá khác, không làm ở đây.
  if (!base.onPrepaid && v.version?.key !== LEGACY_VERSION_KEY) blockers.push(`Tổ chức đang ở phiên bản giá «${v.version?.key ?? "—"}» (không phải giá cũ «${LEGACY_VERSION_KEY}») — V1 chỉ chuyển tổ chức ở giá cũ; tổ chức theo bảng giá V1 đã trừ Số dư AI cho khách vượt phần gồm.`);
  if (current?.price.trialDays != null) blockers.push("Gói đang là dùng thử — Số dư AI chỉ dùng cho gói trả phí.");
  if (base.monthlyVnd === null && !base.onPrepaid) warnings.push(`Gói «${planKey}» không có giá thuê bao tháng ở giá cũ — phiên bản trả trước GIỮ đúng như vậy (không tự đặt giá thuê bao).`);

  try {
    base.flagOn = await aiBalanceEnabled(org.code);
    base.balance = await readAiBalance(org.code);
  } catch (e) {
    blockers.push(`Không đọc được Số dư AI: ${errText(e)}`);
  }
  base.chargingNow = await balanceOverageTerms(org.code).catch(() => null);
  base.aiLimitsNow = await resolveAiLimits(org.code).catch(() => null);
  const control = await readOrgAiControl(org.code, { fresh: true }).catch(() => null);
  base.override = control?.limits ?? {};

  try {
    const facts = await readUsageFacts(org.code, now);
    base.usage = prepaidUsageEstimate({ now, ...facts, unitPriceVnd: base.terms?.unitPriceVnd ?? null });
  } catch (e) {
    warnings.push(`Không đọc được mức dùng: ${errText(e)}`);
  }
  base.period = await readPeriodCharges(org.code, now);

  const planRow = (await listPlans()).find((p) => p.key === planKey);
  const prepaidBase = prepaidAiLimits(parseAiLimits(planRow?.limits).limits);
  base.aiLimitsAfter = applyAiOverride(prepaidBase, base.override);
  const credit = base.usage?.creditSuggestUsd ?? null;
  base.aiLimitsAfterCutover = credit === null ? null : applyAiOverride(prepaidBase, { ...base.override, platformCreditUsdPerMonth: credit });
  if (typeof base.override.costUsdHard === "number") warnings.push(`Ghi đè trần tiền tháng (costUsdHard = ${base.override.costUsdHard} USD) THẮNG trần chống lạm dụng (credit × 3) — chạm trần là chặn cả AI Bán hàng.`);
  if (!(base.aiLimitsAfter.platformCreditUsdPerMonth > 0))
    warnings.push("Credit AI dùng chung đang 0 ⇒ AI dùng chung CHƯA mở (platformChatAi đòi credit > 0) và trần tiền của gói còn áp. Đặt bằng org-ai-cutover --apply --credit=<USD> CÙNG lượt chuyển động cơ: credit = ngưỡng CẢNH BÁO, trần cứng chống lạm dụng = credit × 3.");

  base.minActivateVnd = prepaidMinActivateVnd(base.usage?.vndPerDay ?? null);
  base.hoursCovered = prepaidHoursCovered(base.balance?.totalVnd ?? null, base.usage?.vndPerDay ?? null);

  base.engine = await readBotEngine(org);
  if (base.engine === null) warnings.push("Không đọc được động cơ AI Bán hàng của tổ chức (CSDL tổ chức) — kiểm bằng org-ai-cutover <mã>.");
  if (base.flagOn && base.engine?.connectorKey === "platform" && !base.onPrepaid)
    warnings.push("Cờ Số dư AI BẬT + bot đang chạy AI DÙNG CHUNG mà tổ chức KHÔNG ở «Trả trước theo khách AI» ⇒ không trừ số dư cho khách AI (giá cũ không có khối khách AI) — AI nền tảng chạy tới trần credit mà không thu. Kích hoạt trả trước hoặc chuyển bot về khoá riêng.");
  if (base.onPrepaid && base.flagOn && base.engine && base.engine.connectorKey !== "platform")
    warnings.push(`CHƯA chuyển động cơ — đang thu ${base.terms?.unitPriceVnd ?? "—"}đ / khách AI trong khi bot còn chạy khoá riêng «${base.engine.connectorKey}». Chạy NGAY: org-ai-cutover ${org.code} --apply --credit=${credit ?? "<USD>"}.`);

  if (!base.onPrepaid) {
    try {
      base.openRenewals = await readOpenRenewals(org.code);
    } catch (e) {
      activationBlockers.push(`Không đọc được hoá đơn đang mở: ${errText(e)} — không kích hoạt mù.`);
    }
    if (base.openRenewals.length)
      activationBlockers.push(
        `Còn ${base.openRenewals.length} hoá đơn gia hạn ĐANG MỞ theo giá «${[...new Set(base.openRenewals.map((r) => r.priceVersionKey ?? "trước 0228"))].join(", ")}» (${base.openRenewals.map((r) => r.transferCode).join(", ")}) — huỷ hoặc cho khách TRẢ TRƯỚC khi kích hoạt, để kỳ đã trả và giá của nó không nói hai điều.`,
      );
  }

  base.step = prepaidStep({ blockers, activationBlockers, onPrepaid: base.onPrepaid, flagOn: base.flagOn, balanceVnd: base.balance?.totalVnd ?? null, minBalanceVnd: base.minActivateVnd, forceLowBalance: opts.forceLowBalance });
  if (base.onPrepaid && !base.flagOn && !blockers.length) blockers.push("Đã ghim «Trả trước theo khách AI» nhưng cờ Số dư AI đang TẮT (tắt khẩn?) — không trừ, không chặn, trần AI về trần cũ của gói. Bật lại là quyết định trên /platform/ai-balance, không phải của ops.");
  return base;
}

// ─────────────────────────── GHI (một bước mỗi lượt) ───────────────────────────

export type PrepaidOperator = { orgCode: string; email: string };
export type PrepaidApplyOptions = { unitVnd?: number | null; forceLowBalance?: boolean };
export type PrepaidApplyResult = { ok: true; step: PrepaidStep; changed: boolean; message: string } | { error: string; step: PrepaidStep };

/**
 * Làm ĐÚNG MỘT bước kế tiếp của `planPrepaidAi` (đọc lại TƯƠI trước khi ghi). Mỗi lượt ghi đi qua lõi có sẵn + nhật ký nền tảng
 * nguồn SCRIPT: bật cờ (`enableAiBalanceAsOperator`) · phát hành phiên bản (`publishPrepaidAiVersion`) · ghim
 * (`pinOrgPriceVersion` + `PRICE_VERSION_PIN`). KÍCH HOẠT đòi `unitVnd` = đơn giá đọc lúc ghi (người bấm xác nhận đúng con số sẽ
 * trừ). KHÔNG đổi động cơ AI, KHÔNG đặt credit, KHÔNG khai tài khoản nhận tiền.
 */
export async function applyPrepaidAiStep(orgCode: string, operator: PrepaidOperator, now: Date = new Date(), opts: PrepaidApplyOptions = {}): Promise<PrepaidApplyResult> {
  const plan = await planPrepaidAi(orgCode, now, { forceLowBalance: opts.forceLowBalance });
  const step = plan.step;
  if (step === "BLOCKED") return { error: [...plan.blockers, ...plan.activationBlockers].join(" · ") || "Bị chặn.", step };
  if (step === "ACTIVE") return { ok: true, step, changed: false, message: `Đã ở chế độ trả trước — không có gì để ghi. Bước còn lại: org-ai-cutover ${orgCode} --apply --credit=<USD>.` };
  if (step === "WAIT_TOPUP") {
    const bal = plan.balance?.totalVnd ?? null;
    return {
      error:
        bal === null || bal <= 0
          ? "Số dư AI chưa dương — KHÔNG ghim (AI sẽ ngừng nhận khách mới ngay). Chờ chủ shop nạp qua /settings/ai-balance rồi chạy lại."
          : `Số dư dưới mức kích hoạt (cần ≥ ${plan.minActivateVnd.toLocaleString("vi-VN")}đ = max(100.000đ, ước tính 1 ngày)${plan.hoursCovered !== null ? ` · hiện đủ ≈ ${plan.hoursCovered} giờ` : ""}) — KHÔNG ghim. Nạp thêm, hoặc chủ động chạy với --force-low-balance.`,
      step,
    };
  }
  if (step === "OPEN_TOPUP") {
    const r = await enableAiBalanceAsOperator({ orgCode, operator, reason: PREPAID_FLAG_REASON });
    if ("error" in r) return { error: r.error, step };
    return { ok: true, step, changed: r.changed, message: `${r.message} Tổ chức còn ở giá cũ ⇒ chưa trừ, chưa chặn gì. Chờ chủ shop nạp ở /settings/ai-balance rồi chạy lại --apply --unit=<đ> để kích hoạt.` };
  }
  // KÍCH HOẠT — người bấm xác nhận ĐÚNG đơn giá sẽ trừ.
  const expect = plan.terms?.unitPriceVnd ?? null;
  if (opts.unitVnd === undefined || opts.unitVnd === null) return { error: `Kích hoạt cần --unit=<đ> xác nhận đơn giá khách AI (đọc được: ${expect ?? "—"}đ) — chưa ghi gì.`, step };
  if (opts.unitVnd !== expect) return { error: `--unit=${opts.unitVnd} khác đơn giá đọc được (${expect ?? "—"}đ) — chưa ghi gì.`, step };
  const label = `${operator.email} (vận hành nền tảng · ${operator.orgCode})`.slice(0, 200);
  const pub = await publishPrepaidAiVersion({ reason: PREPAID_PUBLISH_REASON, actor: null, email: label, now, source: "SCRIPT" });
  if ("error" in pub) return { error: pub.error, step };
  if (pub.terms.unitPriceVnd !== opts.unitVnd) return { error: `Phiên bản trả trước mang đơn giá ${pub.terms.unitPriceVnd}đ, khác --unit=${opts.unitVnd} — chưa ghim gì.`, step };
  const org = await findOrganization(orgCode);
  if (!org) return { error: `Không có tổ chức mã «${orgCode}».`, step };
  const planKey = planKeyOf(org);
  const book = await loadPriceBook({ fresh: true });
  const row = priceOf(book, PREPAID_AI_VERSION_KEY, planKey);
  const kind = book.versions.find((x) => x.key === PREPAID_AI_VERSION_KEY)?.kind ?? null;
  if (!row || row.source !== "VERSION" || !isPrepaidAiPrice(row.price, kind)) return { error: `Phiên bản «${PREPAID_AI_VERSION_KEY}» không có dòng giá trả trước cho gói «${planKey}» — chưa ghim gì.`, step };
  const before = await readPricePin(org.code, { fresh: true });
  const pin = await pinOrgPriceVersion(org.code, PREPAID_AI_VERSION_KEY, { source: "OPERATOR", reason: PREPAID_PIN_REASON, email: label });
  const revert = async () => {
    if (pin.changed) await pinOrgPriceVersion(org.code, before ?? LEGACY_VERSION_KEY, { source: "OPERATOR", reason: "Hoàn ghim (ops org-prepaid-ai): bước kích hoạt không hoàn tất", email: label });
    invalidatePricing(org.code);
    invalidateAiEntitlement(org.code);
  };
  invalidatePricing(org.code);
  invalidateAiEntitlement(org.code);
  // Kiểm lại trên ĐÚNG đường trừ tiền: khách AI gồm 0 + đơn giá của phiên bản ⇒ mọi khách AI trừ số dư.
  const terms = await balanceOverageTerms(org.code).catch(() => null);
  if (!terms || terms.included !== 0 || terms.priceVersionKey !== PREPAID_AI_VERSION_KEY || terms.unitPriceVnd !== opts.unitVnd) {
    await revert();
    return { error: `Sau khi ghim, đường trừ tiền không đọc ra «gồm 0 · ${opts.unitVnd}đ / khách» (${JSON.stringify(terms)}) — đã hoàn ghim, chưa đổi gì.`, step };
  }
  if (pin.changed) {
    try {
      await platformAudit({ action: "PRICE_VERSION_PIN", targetOrgCode: org.code, subject: `price-pin:${org.code}`, before: { versionKey: pin.before }, after: { versionKey: PREPAID_AI_VERSION_KEY, label: PREPAID_AI_VERSION_LABEL, unitPriceVnd: terms.unitPriceVnd, by: label, forceLowBalance: opts.forceLowBalance === true }, reason: PREPAID_PIN_REASON, source: "SCRIPT", actor: null });
    } catch {
      await revert();
      return { error: "Không ghi được nhật ký nền tảng — đã hoàn ghim, chưa đổi gì.", step };
    }
  }
  return {
    ok: true,
    step,
    changed: pin.changed,
    message: `${pub.created ? `Đã phát hành phiên bản «${PREPAID_AI_VERSION_KEY}» · ` : ""}Đã ghim «${org.code}» vào «${PREPAID_AI_VERSION_LABEL}»: mọi khách AI trừ ${terms.unitPriceVnd.toLocaleString("vi-VN")}đ vào Số dư AI${plan.hoursCovered !== null ? ` (số dư đủ ≈ ${plan.hoursCovered} giờ)` : ""}. Bước kế — chạy NGAY: org-ai-cutover ${org.code} --apply --credit=<USD>.`,
  };
}
