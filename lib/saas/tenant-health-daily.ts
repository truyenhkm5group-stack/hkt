/**
 * ═══════════ SỨC KHOẺ THEO NGÀY — TÍN HIỆU THƯƠNG MẠI + ĐƯỜNG GHI DUY NHẤT CỦA `platform_tenant_health_daily` (0240) ═══════════
 *
 * Ké lượt chụp giá trị của JOB (`lib/saas/tenant-value-capture.ts`). Ba việc, không có công thức nào mới:
 *  1. `readTenantCommercialSignals` — MỘT lượt đọc CSDL nhà cho mọi workspace: ảnh chụp thương mại (`loadCommercialSnapshot` — tài
 *     khoản, cách lập chứng từ, phiên bản giá, thuê bao, đã từng trả tiền) + sức khoẻ vận hành (`readCustomerHealth` → `classifyCustomer`,
 *     đúng lượt gom của màn /platform/customers, không mở CSDL tổ chức nào). Một nguồn hỏng ⇒ chỉ phần của nguồn đó `null` + câu lỗi.
 *  2. `tenantHealthOf` — HÀM THUẦN: `healthOf` · `churnRiskOf` · `topIssueOf` (lib/saas/tenant-health-rules.ts) trên tín hiệu đã đọc.
 *  3. `writeTenantHealthDay` — đường ghi DUY NHẤT của bảng (tests/saas-value-snapshots.test.ts quét mã): chỉ dòng của HÔM NAY (giờ VN
 *     theo đồng hồ máy chủ), ảnh cuối ngày thắng; ngày đã qua không có đường nào ghi.
 *
 * Gọi từ đường JOB của nhà — không có người dùng, không trang nào gọi (đường đọc xuyên tổ chức `readCustomerHealth` chỉ được gọi ở đây
 * và ở lib/saas/console.ts sau `platformOperatorDenial`). Không lưu tên, email, nội dung: chỉ mức + MÃ lý do (CHECK của bảng).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { vnDate } from "@/lib/billing/rules";
import { CHURN_RULE_VERSION } from "@/lib/constants/churn-risk";
import { DEFAULT_TENANT_VALUE_DECISIONS } from "@/lib/constants/tenant-value-metrics";
import { isPrepaidVersionKey } from "@/lib/pricing/versions";
import { readCustomerHealth } from "@/lib/saas/customer-signals";
import { rowLevel, type CustomerHealth } from "@/lib/saas/customer-health";
import { loadCommercialSnapshot } from "@/lib/saas/customers";
import { currentPeriodMonth } from "@/lib/saas/ledger";
import { marginApplicable as marginApplicableFor, type BillingMode, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";
import { baseHealthFrom, churnRiskOf, healthOf, topIssueOf, type BaseHealth, type TenantChurnRisk, type TenantHealth, type TopIssue, type UsageTrend } from "@/lib/saas/tenant-health-rules";
import { tenantValueFormulaVersion, type TenantValue } from "@/lib/saas/tenant-value";

/** Phiên bản của một dòng sức khoẻ: luật rủi ro rời bỏ + công thức giá trị đã nuôi nó. Khác chuỗi ⇒ không so trực tiếp (luật 40). */
export function tenantHealthRuleVersion(): string {
  return `churn${CHURN_RULE_VERSION}.${tenantValueFormulaVersion()}`;
}

/**
 * Ngày VN được phép ghi cho lượt chụp ở mốc `now`: CHỈ hôm nay theo đồng hồ máy chủ. `now` của ngày khác ⇒ `null` — người gọi từ chối,
 * không ghi. Đây là chốt «ngày cũ không có đường nào ghi» cho CẢ HAI bảng ảnh chụp (tệp capture dùng lại hàm này).
 */
export function writableDay(now: Date, clock: Date = new Date()): string | null {
  const day = vnDate(now);
  return day === vnDate(clock) ? day : null;
}

// ─────────────────────────── 1 · Tín hiệu thương mại + sức khoẻ vận hành ───────────────────────────

/** Tình trạng thuê bao dùng cho rủi ro rời bỏ. Thứ tự «còn sống» — workspace có nhiều thuê bao lấy thuê bao CÒN DÙNG ĐƯỢC nhất. */
const SUBSCRIPTION_ALIVE_RANK: Record<EffectiveSubscriptionStatus, number> = { ACTIVE: 0, TRIAL: 1, PAST_DUE: 2, PAUSED: 3, EXPIRED: 4, CANCELED: 5 };

export type TenantCommercialSignal = {
  orgCode: string;
  accountId: string | null;
  accountCode: string | null;
  /** `marginApplicable(billingMode)` — `null` khi workspace chưa gắn tài khoản. */
  marginApplicable: boolean | null;
  /** Phiên bản giá trả trước (phần vượt trừ thẳng Số dư AI ⇒ dòng vượt của bảng kê = 0 thật). */
  prepaid: boolean;
  /** `null` = chưa đọc được / workspace chưa có thuê bao nào còn hiệu lực. */
  subscription: { status: EffectiveSubscriptionStatus; everPaid: boolean | null } | null;
  /** Sức khoẻ vận hành của workspace (`classifyCustomer`) — `null` = nguồn hỏng / workspace chưa gắn tài khoản. */
  base: BaseHealth | null;
};

export type TenantCommercialRead = { signals: Map<string, TenantCommercialSignal>; errors: string[] };

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

/** Mức của workspace + lý do cấp tài khoản in trên CÙNG dòng (mẫu `rowLevel` của màn khách). HÀM THUẦN. */
export function workspaceBaseHealth(c: CustomerHealth, orgCode: string): BaseHealth | null {
  const ws = c.workspaces.find((w) => w.code === orgCode);
  if (!ws) return null;
  if (ws.level === "INACTIVE") return baseHealthFrom(ws);
  return baseHealthFrom({ level: rowLevel(ws.level, c.accountReasons), reasons: [...c.accountReasons, ...ws.reasons], gaps: ws.gaps });
}

/**
 * MỘT lượt đọc cho mọi workspace. Ảnh chụp thương mại hỏng ⇒ NÉM (người gọi ghi lỗi nguồn `COMMERCIAL` cho mọi tổ chức); sức khoẻ vận
 * hành hỏng ⇒ `base = null` cho mọi workspace + câu lỗi `HEALTH`, phần thương mại vẫn dùng được.
 */
export async function readTenantCommercialSignals(now: Date): Promise<TenantCommercialRead> {
  const errors: string[] = [];
  const snap = await loadCommercialSnapshot({ now });
  const health = await readCustomerHealth(snap.customers, { now, periodMonth: currentPeriodMonth(now) }).catch((e: unknown) => {
    errors.push(`HEALTH: ${short(e)}`);
    return null;
  });
  const signals = new Map<string, TenantCommercialSignal>();
  for (const c of snap.customers) {
    const ch = health ? (health[c.account.id] ?? null) : null;
    for (const w of c.workspaces) {
      const subs = [...w.subscriptions].sort((a, b) => SUBSCRIPTION_ALIVE_RANK[a.status] - SUBSCRIPTION_ALIVE_RANK[b.status]);
      signals.set(w.code, {
        orgCode: w.code,
        accountId: c.account.id,
        accountCode: c.account.code,
        marginApplicable: marginApplicableFor(c.account.billingMode as BillingMode),
        prepaid: isPrepaidVersionKey(w.pricing.versionKey),
        subscription: subs.length ? { status: subs[0].status, everPaid: w.everPaid } : null,
        base: ch ? workspaceBaseHealth(ch, w.code) : null,
      });
    }
  }
  // Workspace chưa gắn tài khoản: không có cách lập chứng từ / thuê bao / sức khoẻ ⇒ để trống (CHƯA BIẾT), không đoán.
  for (const w of snap.orphanWorkspaces) {
    if (!signals.has(w.code)) signals.set(w.code, { orgCode: w.code, accountId: null, accountCode: null, marginApplicable: null, prepaid: false, subscription: null, base: null });
  }
  return { signals, errors };
}

// ─────────────────────────── 2 · Hàm thuần ───────────────────────────

export type TenantHealthDay = { health: TenantHealth; churn: TenantChurnRisk; topIssue: TopIssue | null };

/**
 * Sức khoẻ V1 + rủi ro rời bỏ + vấn đề lớn nhất của MỘT tổ chức. `value` = ảnh giá trị của cửa sổ bội số (D12 — chỉ ở đó bội số có
 * nghĩa), `usage` = hội thoại cửa sổ mặc định (D12) so cửa sổ liền trước cùng độ dài. Thiếu ⇒ truyền `null` (chưa đo — luật PR-1 ra
 * UNKNOWN, không bao giờ «khoẻ»). HÀM THUẦN.
 */
export function tenantHealthOf(input: { orgCode: string; signal: TenantCommercialSignal | null; value: TenantValue | null; usage: UsageTrend | null }): TenantHealthDay {
  const health = healthOf({ base: input.signal?.base ?? null, value: input.value, usage: input.usage, decisions: DEFAULT_TENANT_VALUE_DECISIONS });
  const churn = churnRiskOf({ health, subscription: input.signal?.subscription ?? null, usage: input.usage, value: input.value, decisions: DEFAULT_TENANT_VALUE_DECISIONS });
  const topIssue = topIssueOf({ orgCode: input.orgCode, accountCode: input.signal?.accountCode ?? null, health, churn });
  return { health, churn, topIssue };
}

// ─────────────────────────── 3 · Đường ghi DUY NHẤT ───────────────────────────

/**
 * Ghi dòng HÔM NAY của một tổ chức. `now` không phải hôm nay (đồng hồ máy chủ, giờ VN) ⇒ từ chối, trả `false`. Khoá (ngày, tổ chức)
 * chỉ trùng được với dòng của chính hôm nay — ảnh cuối ngày thắng.
 */
export async function writeTenantHealthDay(orgCode: string, now: Date, day: TenantHealthDay): Promise<boolean> {
  const d = writableDay(now);
  if (!d) return false;
  const pdb = await getPlatformDb();
  const t = schema.platformTenantHealthDaily;
  const values = {
    day: d,
    orgCode,
    level: day.health.level,
    churnRisk: day.churn.risk,
    reasonCodes: [...day.health.reasonCodes],
    gapCodes: [...day.health.gapCodes],
    churnReasonCodes: [...day.churn.reasonCodes],
    topIssue: day.topIssue ? { ...day.topIssue } : null,
    ruleVersion: tenantHealthRuleVersion(),
    capturedAt: now,
  };
  await pdb.insert(t).values(values).onConflictDoUpdate({ target: [t.day, t.orgCode], set: { ...values } });
  return true;
}

/** Tổ chức đã có dòng sức khoẻ HÔM NAY cùng phiên bản luật — lượt chụp của job bỏ qua chúng. */
export async function healthCapturedToday(day: string, orgCodes: readonly string[]): Promise<Set<string>> {
  if (!orgCodes.length) return new Set();
  const pdb = await getPlatformDb();
  const t = schema.platformTenantHealthDaily;
  const rows = await pdb
    .select({ orgCode: t.orgCode })
    .from(t)
    .where(and(eq(t.day, day), eq(t.ruleVersion, tenantHealthRuleVersion()), inArray(t.orgCode, [...orgCodes])));
  return new Set(rows.map((r) => r.orgCode));
}
