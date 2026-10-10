/**
 * ═══════════ SỨC KHOẺ V1 · RỦI RO RỜI BỎ · VẤN ĐỀ LỚN NHẤT — HÀM THUẦN (docs/saas/VALUE_CENTER.md §4) ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ. KHÔNG có điểm /100 (spec 11 §7, quyết định D9): mức là thứ bậc, mỗi mức có ít nhất một MÃ
 * LÝ DO, mỗi mã có một câu giải thích tiếng Việt, và trạng thái THIẾU DỮ LIỆU là một mức riêng (`UNKNOWN`), không phải «khoẻ».
 *
 *  · `healthOf` DÙNG LẠI mức + lý do + chỗ chưa đo của `classifyCustomer` (lib/saas/customer-health.ts — `CUSTOMER_HEALTH_LEVELS`,
 *    `HEALTH_REASONS`, `HEALTH_GAPS`), rồi chồng thêm các lý do GIÁ TRỊ đọc từ `buildTenantValue`. Không phân loại lại phần đã có.
 *  · `churnRiskOf` đọc bảng ánh xạ ở MỘT chỗ (`CHURN_REASONS`, lib/constants/churn-risk.ts); ngưỡng giảm sử dụng = D8.
 *  · `topIssueOf` chọn mã NẶNG NHẤT trong hai kết quả trên + lối ra hành động.
 */
import { CUSTOMER_HEALTH_LABEL, CUSTOMER_HEALTH_RANK, HEALTH_GAPS, HEALTH_REASONS, type CustomerHealthLevel, type HealthGapCode, type HealthReasonCode, type ProblemLevel } from "@/lib/constants/customer-health";
import { CHURN_REASONS, CHURN_RISK_RANK, CHURN_RULE_VERSION, CHURN_SIGNALS, type ChurnGapCode, type ChurnReasonCode, type ChurnRiskLevel } from "@/lib/constants/churn-risk";
import { DEFAULT_TENANT_VALUE_DECISIONS, type TenantValueDecisions } from "@/lib/constants/tenant-value-metrics";
import { AI_SALES_MIN_SAMPLE } from "@/lib/sales-chatbot/performance-shared";
import type { CustomerHealth } from "@/lib/saas/customer-health";
import type { EffectiveSubscriptionStatus } from "@/lib/saas/policy";
import type { TenantValue } from "@/lib/saas/tenant-value";

// ─────────────────────────── Lý do & chỗ chưa đo phía GIÁ TRỊ ───────────────────────────

/** Lý do sức khoẻ đọc từ ảnh giá trị — chồng lên `HEALTH_REASONS`, không thay. */
export const VALUE_HEALTH_REASONS = {
  VALUE_BELOW_SPEND: { level: "NEEDS_ATTENTION", label: "Giá trị nhận thấp hơn tiền trả", explanation: "Bội số giá trị < 1: lãi gộp quy công cho AI nhỏ hơn số khách trả trong cửa sổ bội số (độ phủ giá vốn đủ ngưỡng D3)." },
  USAGE_TREND_DOWN: { level: "NEEDS_ATTENTION", label: "Dùng giảm", explanation: "Hội thoại có khách nhắn giảm từ ngưỡng D8 trở lên so với cửa sổ liền trước (cửa sổ trước đủ mẫu)." },
  NO_AI_ORDERS: { level: "NEEDS_ATTENTION", label: "Có hội thoại mà AI không ra đơn", explanation: "Đủ mẫu hội thoại có khách nhắn trong cửa sổ mà không đơn nào AI tự chốt hay góp công." },
} as const satisfies Record<string, { level: ProblemLevel; label: string; explanation: string }>;
export type ValueHealthReasonCode = keyof typeof VALUE_HEALTH_REASONS;

/** Chỗ chưa đo phía giá trị. `required: true` thiếu ⇒ không được kết luận «Khoẻ». */
export const VALUE_HEALTH_GAPS = {
  BASE_HEALTH_MISSING: { required: true, explanation: "Chưa có phân loại sức khoẻ vận hành của khách (classifyCustomer)." },
  VALUE_SNAPSHOT_MISSING: { required: true, explanation: "Chưa có ảnh giá trị của khách cho cửa sổ này (buildTenantValue)." },
  USAGE_TREND_UNMEASURED: { required: true, explanation: "Chưa so được số hội thoại với cửa sổ trước (thiếu số, hoặc cửa sổ trước dưới mẫu tối thiểu D8)." },
  VALUE_MULTIPLE_UNMEASURED: { required: false, explanation: "Chưa có bội số giá trị (giá vốn dưới ngưỡng độ phủ D3, khách trả chưa biết, mẫu đơn đã giao chưa đủ, hoặc không phải cửa sổ bội số D12)." },
} as const satisfies Record<string, { required: boolean; explanation: string }>;
export type ValueHealthGapCode = keyof typeof VALUE_HEALTH_GAPS;

/** Mã kết luận để MỌI mức có lý do in được. */
export const HEALTH_VERDICT_REASONS = {
  ALL_SIGNALS_OK: "Mọi tín hiệu bắt buộc đọc được và không tín hiệu nào chạm ngưỡng.",
  SIGNALS_MISSING: "Không thấy lý do nào nhưng còn tín hiệu bắt buộc chưa đọc được — KHÔNG phải khoẻ.",
  INACTIVE: "Tài khoản / workspace đã dừng do người quyết — không xếp vào sức khoẻ.",
} as const;
export type HealthVerdictCode = keyof typeof HEALTH_VERDICT_REASONS;

export type TenantHealthReasonCode = HealthReasonCode | ValueHealthReasonCode | HealthVerdictCode;
export type TenantHealthGapCode = HealthGapCode | ValueHealthGapCode;

export type Explained<C extends string> = { code: C; text: string };

export type TenantHealth = {
  level: CustomerHealthLevel;
  /** Luôn ≥ 1 phần tử. */
  reasonCodes: TenantHealthReasonCode[];
  gapCodes: TenantHealthGapCode[];
  explanation: Explained<TenantHealthReasonCode | TenantHealthGapCode>[];
};

// ─────────────────────────── Tiện ích ───────────────────────────

export type UsageTrend = { current: number | null; previous: number | null };

/**
 * Dùng có GIẢM không: `true` / `false`, hoặc `null` khi chưa so được (thiếu số, cửa sổ trước dưới mẫu tối thiểu) — luật 52:
 * không có nền thì không kết luận. HÀM THUẦN.
 */
export function usageDropped(u: UsageTrend | null, d: Pick<TenantValueDecisions, "churnUsageDropRatio" | "churnUsageMinSample"> = DEFAULT_TENANT_VALUE_DECISIONS): boolean | null {
  if (!u || u.current === null || u.previous === null) return null;
  if (!(u.previous >= d.churnUsageMinSample) || u.previous <= 0) return null;
  return u.current <= u.previous * (1 - d.churnUsageDropRatio);
}

/** Phân loại `classifyCustomer` → đầu vào gọn của `healthOf` (mã, không câu). HÀM THUẦN. */
export function baseHealthFrom(c: Pick<CustomerHealth, "level" | "reasons" | "gaps">): BaseHealth {
  return { level: c.level, reasonCodes: [...new Set(c.reasons.map((r) => r.code))], gapCodes: [...new Set(c.gaps.map((g) => g.code))] };
}

export type BaseHealth = { level: CustomerHealthLevel; reasonCodes: readonly HealthReasonCode[]; gapCodes: readonly HealthGapCode[] };

function multipleOf(v: TenantValue | null) {
  return v ? v.metrics.customer_value_multiple : null;
}

// ─────────────────────────── Sức khoẻ V1 ───────────────────────────

export function healthOf(input: { base: BaseHealth | null; value: TenantValue | null; usage: UsageTrend | null; decisions?: Partial<TenantValueDecisions> }): TenantHealth {
  const d = { ...DEFAULT_TENANT_VALUE_DECISIONS, ...(input.decisions ?? {}) };
  const base = input.base;
  if (base?.level === "INACTIVE") return { level: "INACTIVE", reasonCodes: ["INACTIVE"], gapCodes: [], explanation: [{ code: "INACTIVE", text: HEALTH_VERDICT_REASONS.INACTIVE }] };

  const reasons: (HealthReasonCode | ValueHealthReasonCode)[] = [...(base?.reasonCodes ?? [])];
  const gaps: TenantHealthGapCode[] = [...(base?.gapCodes ?? [])];
  if (!base) gaps.push("BASE_HEALTH_MISSING");

  const v = input.value;
  if (!v) gaps.push("VALUE_SNAPSHOT_MISSING");
  const mult = multipleOf(v);
  if (mult && mult.state === "VALUE" && mult.value !== null && mult.value < 1) reasons.push("VALUE_BELOW_SPEND");
  else if (mult && mult.state === "UNKNOWN") gaps.push("VALUE_MULTIPLE_UNMEASURED");

  const dropped = usageDropped(input.usage, d);
  if (dropped === true) reasons.push("USAGE_TREND_DOWN");
  else if (dropped === null) gaps.push("USAGE_TREND_UNMEASURED");

  if (v) {
    const conv = v.metrics.conversations.value;
    const influenced = v.metrics.ai_influenced_orders.value;
    if (conv !== null && influenced !== null && conv >= AI_SALES_MIN_SAMPLE && influenced === 0) reasons.push("NO_AI_ORDERS");
  }

  const levelOf = (code: HealthReasonCode | ValueHealthReasonCode): ProblemLevel => (code in VALUE_HEALTH_REASONS ? VALUE_HEALTH_REASONS[code as ValueHealthReasonCode].level : HEALTH_REASONS[code as HealthReasonCode].level);
  const isRequiredGap = (g: TenantHealthGapCode) => (g in VALUE_HEALTH_GAPS ? VALUE_HEALTH_GAPS[g as ValueHealthGapCode].required : true);

  let level: CustomerHealthLevel;
  const reasonCodes: TenantHealthReasonCode[] = [...new Set(reasons)];
  if (reasonCodes.length) level = reasonCodes.map((c) => levelOf(c as HealthReasonCode | ValueHealthReasonCode)).reduce<CustomerHealthLevel>((w, l) => (CUSTOMER_HEALTH_RANK[l] < CUSTOMER_HEALTH_RANK[w] ? l : w), "NEEDS_ATTENTION");
  else if (gaps.some(isRequiredGap)) {
    level = "UNKNOWN";
    reasonCodes.push("SIGNALS_MISSING");
  } else {
    level = "HEALTHY";
    reasonCodes.push("ALL_SIGNALS_OK");
  }
  const gapCodes = [...new Set(gaps)];
  return { level, reasonCodes, gapCodes, explanation: [...reasonCodes.map((c) => ({ code: c, text: explainHealthCode(c) })), ...gapCodes.map((g) => ({ code: g, text: explainHealthCode(g) }))] };
}

/** Câu giải thích của một mã sức khoẻ / chỗ chưa đo. */
export function explainHealthCode(code: TenantHealthReasonCode | TenantHealthGapCode): string {
  if (code in HEALTH_VERDICT_REASONS) return HEALTH_VERDICT_REASONS[code as HealthVerdictCode];
  if (code in VALUE_HEALTH_REASONS) return VALUE_HEALTH_REASONS[code as ValueHealthReasonCode].explanation;
  if (code in VALUE_HEALTH_GAPS) return VALUE_HEALTH_GAPS[code as ValueHealthGapCode].explanation;
  if (code in HEALTH_REASONS) {
    const r = HEALTH_REASONS[code as HealthReasonCode];
    return `${r.label} (${CUSTOMER_HEALTH_LABEL[r.level]}).`;
  }
  return HEALTH_GAPS[code as HealthGapCode].why;
}

// ─────────────────────────── Rủi ro rời bỏ ───────────────────────────

export type TenantChurnRisk = {
  risk: ChurnRiskLevel;
  /** Luôn ≥ 1 phần tử. */
  reasonCodes: ChurnReasonCode[];
  gapCodes: ChurnGapCode[];
  explanation: Explained<ChurnReasonCode | ChurnGapCode>[];
  ruleVersion: number;
};

export function churnRiskOf(input: {
  health: Pick<TenantHealth, "level" | "reasonCodes"> | null;
  subscription: { status: EffectiveSubscriptionStatus; everPaid: boolean | null } | null;
  usage: UsageTrend | null;
  value: TenantValue | null;
  decisions?: Partial<TenantValueDecisions>;
}): TenantChurnRisk {
  const d = { ...DEFAULT_TENANT_VALUE_DECISIONS, ...(input.decisions ?? {}) };
  const done = (risk: ChurnRiskLevel, reasonCodes: ChurnReasonCode[], gapCodes: ChurnGapCode[]): TenantChurnRisk => ({
    risk,
    reasonCodes,
    gapCodes,
    explanation: [...reasonCodes.map((c) => ({ code: c, text: CHURN_REASONS[c].explanation })), ...gapCodes.map((g) => ({ code: g, text: churnGapWhy(g) }))],
    ruleVersion: CHURN_RULE_VERSION,
  });
  const h = input.health;
  if (h?.level === "INACTIVE") return done("UNKNOWN", ["INACTIVE"], []);

  const reasons: ChurnReasonCode[] = [];
  const gaps: ChurnGapCode[] = [];
  if (!h) gaps.push(CHURN_SIGNALS.HEALTH.gap);
  if (!input.subscription) gaps.push(CHURN_SIGNALS.SUBSCRIPTION_STATUS.gap);
  const dropped = usageDropped(input.usage, d);
  if (dropped === null) gaps.push(CHURN_SIGNALS.USAGE_TREND.gap);
  const mult = multipleOf(input.value);
  const multKnown = !!mult && mult.state === "VALUE" && mult.value !== null;
  if (!multKnown && mult?.state !== "NOT_APPLICABLE") gaps.push(CHURN_SIGNALS.VALUE_MULTIPLE.gap);

  const codes = new Set<string>(h?.reasonCodes ?? []);
  const sub = input.subscription;
  if (h?.level === "CRITICAL") reasons.push("PRODUCT_DOWN");
  if (sub?.status === "EXPIRED" && sub.everPaid === true) reasons.push("PAID_THEN_EXPIRED");
  if (sub?.status === "PAST_DUE" && dropped === true) reasons.push("PAST_DUE_AND_USAGE_DOWN");
  if (codes.has("LOGIN_STALE") && codes.has("INBOUND_DROP")) reasons.push("NO_LOGIN_AND_INBOUND_DROP");
  if (dropped === true) reasons.push("USAGE_TREND_DOWN");
  if (multKnown && (mult?.value ?? Infinity) < 1) reasons.push("VALUE_BELOW_SPEND");
  if (codes.has("NOT_ACTIVATED")) reasons.push("NOT_ACTIVATED_AFTER_GRACE");

  if (reasons.length) {
    const risk = reasons.map((c) => CHURN_REASONS[c].risk).reduce<ChurnRiskLevel>((w, l) => (CHURN_RISK_RANK[l] < CHURN_RISK_RANK[w] ? l : w), "LOW");
    return done(risk, reasons, gaps);
  }
  const requiredGaps = (Object.values(CHURN_SIGNALS) as { required: boolean; gap: ChurnGapCode }[]).filter((s) => s.required).map((s) => s.gap);
  if (gaps.some((g) => requiredGaps.includes(g))) return done("UNKNOWN", ["REQUIRED_SIGNAL_MISSING"], gaps);
  return done("LOW", ["NO_RISK_SIGNAL"], gaps);
}

function churnGapWhy(g: ChurnGapCode): string {
  return (Object.values(CHURN_SIGNALS) as { gap: string; why: string }[]).find((s) => s.gap === g)?.why ?? g;
}

// ─────────────────────────── Vấn đề lớn nhất hôm nay ───────────────────────────

export type TopIssue = {
  code: string;
  source: "HEALTH" | "CHURN" | "GAP";
  /** 0 nặng nhất. */
  rank: number;
  label: string;
  explanation: string;
  action: { label: string; href: string };
};

/** Lối ra hành động theo mã — `{account}` / `{org}` thay bằng mã thật. Mã không khai ⇒ trang chi tiết khách. */
const ACTIONS: Record<string, { label: string; path: "account" | "org" }> = {
  AI_OFF: { label: "Mở chẩn đoán tổ chức — bật lại AI", path: "org" },
  AI_FAILING: { label: "Mở chẩn đoán tổ chức — xem lỗi AI", path: "org" },
  AI_ERRORS_RECENT: { label: "Mở chẩn đoán tổ chức — xem lỗi AI", path: "org" },
  AI_BLOCKED_QUOTA: { label: "Mở chẩn đoán tổ chức — xem hạn mức AI", path: "org" },
  AI_SILENT: { label: "Mở chẩn đoán tổ chức — bot đang im", path: "org" },
  ORDER_SYNC_ERRORS: { label: "Mở chẩn đoán tổ chức — lỗi ghi đơn hộ", path: "org" },
  CHANNEL_LOST: { label: "Mở chẩn đoán tổ chức — nối lại kênh bán", path: "org" },
  USAGE_TREND_DOWN: { label: "Xem hội thoại & lý do chuyển người của tổ chức", path: "org" },
  NO_AI_ORDERS: { label: "Xem phễu & lý do khách không mua", path: "org" },
  PRODUCT_DOWN: { label: "Mở chẩn đoán tổ chức", path: "org" },
  PAST_DUE: { label: "Xem thu phí & gia hạn", path: "account" },
  SUBSCRIPTION_EXPIRED: { label: "Xem thu phí & gia hạn", path: "account" },
  PAID_THEN_EXPIRED: { label: "Liên hệ khách — gia hạn", path: "account" },
  PAST_DUE_AND_USAGE_DOWN: { label: "Liên hệ khách — thu phí & hỗ trợ dùng", path: "account" },
  VALUE_BELOW_SPEND: { label: "Xem giá trị & kinh tế đơn vị của khách", path: "account" },
  VALUE_MULTIPLE_UNMEASURED: { label: "Nhắc khách nhập giá vốn sản phẩm", path: "account" },
  USAGE_TREND_UNMEASURED: { label: "Chờ đủ cửa sổ trước — xem chi tiết khách", path: "account" },
};

export function topIssueOf(input: { orgCode: string; accountCode: string | null; health: TenantHealth | null; churn: TenantChurnRisk | null }): TopIssue | null {
  const cands: TopIssue[] = [];
  const href = (code: string): { label: string; href: string } => {
    const a = ACTIONS[code];
    const useOrg = a?.path === "org" || !input.accountCode;
    const path = useOrg ? `/platform/org/${encodeURIComponent(input.orgCode)}` : `/platform/customers/${encodeURIComponent(input.accountCode ?? "")}`;
    return { label: a?.label ?? (useOrg ? "Mở chẩn đoán tổ chức" : "Mở chi tiết khách"), href: path };
  };
  const h = input.health;
  if (h && h.level !== "INACTIVE") {
    for (const code of h.reasonCodes) {
      if (code === "ALL_SIGNALS_OK" || code === "SIGNALS_MISSING") continue;
      const isValue = code in VALUE_HEALTH_REASONS;
      const level: ProblemLevel = isValue ? VALUE_HEALTH_REASONS[code as ValueHealthReasonCode].level : HEALTH_REASONS[code as HealthReasonCode].level;
      const label = isValue ? VALUE_HEALTH_REASONS[code as ValueHealthReasonCode].label : HEALTH_REASONS[code as HealthReasonCode].label;
      cands.push({ code, source: "HEALTH", rank: level === "CRITICAL" ? 0 : 2, label, explanation: explainHealthCode(code), action: href(code) });
    }
    for (const g of h.gapCodes) {
      const required = g in VALUE_HEALTH_GAPS ? VALUE_HEALTH_GAPS[g as ValueHealthGapCode].required : true;
      cands.push({ code: g, source: "GAP", rank: required ? 3 : 4, label: g in HEALTH_GAPS ? HEALTH_GAPS[g as HealthGapCode].label : "Thiếu dữ liệu", explanation: explainHealthCode(g), action: href(g) });
    }
  }
  const c = input.churn;
  if (c) {
    for (const code of c.reasonCodes) {
      const r = CHURN_REASONS[code];
      if (r.risk === "LOW" || r.risk === "UNKNOWN") continue;
      cands.push({ code, source: "CHURN", rank: r.risk === "CRITICAL" ? 0 : r.risk === "HIGH" ? 1 : 2, label: r.label, explanation: r.explanation, action: href(code) });
    }
  }
  if (!cands.length) return null;
  const srcOrder = { HEALTH: 0, CHURN: 1, GAP: 2 } as const;
  cands.sort((a, b) => a.rank - b.rank || srcOrder[a.source] - srcOrder[b.source] || a.code.localeCompare(b.code));
  return cands[0];
}
