/**
 * ═══════════ GIÁ TRỊ KHÁCH HÀNG — DỰNG Ô HIỂN THỊ TỪ ẢNH CHỤP (HÀM THUẦN · CLIENT-SAFE) ═══════════
 *
 * Bộ đọc (`lib/saas/tenant-value-read.ts`) lấy dòng của `platform_tenant_value_snapshots` / `platform_tenant_health_daily` (0240);
 * tệp này biến chúng thành CHỮ in được — không đọc CSDL, không đọc đồng hồ (ngày hôm nay là tham số), không tính công thức mới:
 * mọi con số là ĐÚNG ô `buildTenantValue` đã lưu trong `metrics`.
 *
 * Ba trạng thái, ba cách in (luật 42): có số → số; CHƯA BIẾT (`value = null`) → «—» + tooltip nói THIẾU GÌ (`note` của ô, rồi
 * `missingWhat` của sổ chỉ số); KHÔNG ÁP DỤNG → «N/A». Không nhánh nào biến `null` thành 0. Cận dưới / cận trên in «≥» / «≤».
 * Ô ƯỚC TÍNH và ô đang chạy theo QUYẾT ĐỊNH TẠM mang cờ để màn hình gắn nhãn. Không tô màu đạt / không đạt (chưa có đích —
 * luật 38 · 44); mức sức khoẻ là MỨC + MÃ LÝ DO, không chấm điểm tổng (D9).
 */
import { CHURN_REASONS, CHURN_RISK_LABEL, CHURN_RISK_LEVELS, type ChurnRiskLevel } from "@/lib/constants/churn-risk";
import { CUSTOMER_HEALTH_LABEL, CUSTOMER_HEALTH_LEVELS, HEALTH_GAPS, HEALTH_REASONS, type CustomerHealthLevel } from "@/lib/constants/customer-health";
import { TENANT_VALUE_DEFAULT_DECISIONS, TENANT_VALUE_METRIC_BY_KEY, type TenantValueDecisionId, type TenantValueKey } from "@/lib/constants/tenant-value-metrics";
import { formatNumber, formatPercent, formatVND, MISSING_HINT, MISSING_TEXT, NOT_APPLICABLE_TEXT } from "@/lib/format";
import { HEALTH_VERDICT_REASONS, VALUE_HEALTH_GAPS, VALUE_HEALTH_REASONS, explainHealthCode, type TenantHealthGapCode, type TenantHealthReasonCode } from "@/lib/saas/tenant-health-rules";

// ─────────────────────────── Một ô ───────────────────────────

export type StoredCellState = "VALUE" | "UNKNOWN" | "NOT_APPLICABLE";
export type StoredCellBound = "EXACT" | "LOWER" | "UPPER";

/** Một ô đã lưu trong `metrics` (jsonb) — đọc PHÒNG THỦ: jsonb không có kiểu, ảnh cũ có thể thiếu trường. */
export type StoredMetricCell = {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  availability: "MEASURED" | "ESTIMATED" | "UNAVAILABLE";
  state: StoredCellState;
  provisional: boolean;
  bound: StoredCellBound;
  coverage: number | null;
  note: string | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Ô `key` trong `metrics`; vắng ⇒ `null` (ảnh không có ô này — CHƯA BIẾT, không phải 0). */
export function readStoredCell(metrics: unknown, key: string): StoredMetricCell | null {
  if (!metrics || typeof metrics !== "object") return null;
  const raw = (metrics as Record<string, unknown>)[key];
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const value = num(c.value);
  const declared = c.state === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : c.state === "VALUE" ? "VALUE" : "UNKNOWN";
  // Ô nói VALUE mà giá trị không phải số hữu hạn ⇒ CHƯA BIẾT (không bao giờ đọc thành 0).
  const state: StoredCellState = declared === "VALUE" && value === null ? "UNKNOWN" : declared === "UNKNOWN" && value !== null ? "VALUE" : declared;
  return {
    value: state === "VALUE" ? value : null,
    numerator: num(c.numerator),
    denominator: num(c.denominator),
    availability: c.availability === "ESTIMATED" ? "ESTIMATED" : c.availability === "UNAVAILABLE" ? "UNAVAILABLE" : "MEASURED",
    state,
    provisional: c.provisional === true,
    bound: c.bound === "LOWER" ? "LOWER" : c.bound === "UPPER" ? "UPPER" : "EXACT",
    coverage: num(c.coverage),
    note: str(c.note),
  };
}

export type CellView = {
  /** Chữ in trong ô: số đã định dạng, «—» (chưa biết) hoặc «N/A» (không áp dụng). */
  text: string;
  state: StoredCellState;
  /** Tooltip: tên chỉ số · tử/mẫu · độ phủ · cận · ước tính · thiếu gì · quyết định tạm. */
  hint: string;
  bound: StoredCellBound;
  estimated: boolean;
  /** Ô đang chạy theo một quyết định CHƯA chốt — mã để màn hình nối tới mục quyết định. `null` = không tạm. */
  provisional: TenantValueDecisionId | "?" | null;
};

const ratioText = (v: number) => `${v.toFixed(2).replace(".", ",")}×`;
const msText = (v: number) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1).replace(".", ",")} s`);

/** Định dạng theo ĐƠN VỊ khai trong sổ chỉ số. Chỉ gọi với số hữu hạn. */
function formatByUnit(key: TenantValueKey, v: number, full = false): string {
  switch (TENANT_VALUE_METRIC_BY_KEY[key].unit) {
    case "VND":
      // Gọn («1,2 tr») cho ô hẹp; dưới 1.000 in đủ «₫» — số trần «300» không nói là tiền.
      return full || Math.abs(v) < 1000 ? formatVND(v) : formatVND(v, { compact: true });
    case "PERCENT":
      return formatPercent(v * 100, 0);
    case "RATIO":
      return ratioText(v);
    case "MS":
      return msText(v);
    case "HOURS":
      return `${formatNumber(Math.round(v))} giờ`;
    default:
      return formatNumber(v);
  }
}

/** Ô hiển thị của một khoá. `cell = null` ⇒ ảnh không có ô ⇒ «—». */
export function metricCellView(key: TenantValueKey, cell: StoredMetricCell | null): CellView {
  const spec = TENANT_VALUE_METRIC_BY_KEY[key];
  const lines: string[] = [spec.label];
  if (!cell) {
    lines.push(spec.missingWhat ?? "Ảnh chụp không có ô này — chưa biết, không phải 0.");
    return { text: MISSING_TEXT, state: "UNKNOWN", hint: lines.join("\n"), bound: "EXACT", estimated: spec.availability === "ESTIMATED", provisional: null };
  }
  const estimated = cell.availability === "ESTIMATED";
  let text: string;
  if (cell.state === "NOT_APPLICABLE") text = NOT_APPLICABLE_TEXT;
  else if (cell.value === null) text = MISSING_TEXT;
  else text = `${cell.bound === "LOWER" ? "≥ " : cell.bound === "UPPER" ? "≤ " : ""}${formatByUnit(key, cell.value)}`;
  if (cell.state === "VALUE" && cell.value !== null && spec.unit === "VND") lines.push(`Giá trị: ${formatVND(cell.value)}`);
  if (cell.numerator !== null || cell.denominator !== null) lines.push(`Tử/mẫu: ${formatNumber(cell.numerator)}/${formatNumber(cell.denominator)}`);
  if (cell.coverage !== null) lines.push(`Độ phủ: ${formatPercent(cell.coverage * 100, 0)}`);
  if (cell.bound === "LOWER") lines.push("Cận dưới — số thật có thể lớn hơn.");
  if (cell.bound === "UPPER") lines.push("Cận trên — số thật có thể nhỏ hơn.");
  if (estimated) lines.push("ƯỚC TÍNH.");
  if (cell.note) lines.push(cell.note);
  else if (cell.state !== "VALUE") lines.push(cell.state === "NOT_APPLICABLE" ? "Không áp dụng cho khách / cửa sổ này." : (spec.missingWhat ?? MISSING_HINT));
  let provisional: CellView["provisional"] = null;
  if (cell.provisional) {
    provisional = spec.decision ?? "?";
    if (spec.decision) lines.push(`Quyết định TẠM ${spec.decision}: ${TENANT_VALUE_DEFAULT_DECISIONS[spec.decision].defaultLabel}`);
  }
  return { text, state: cell.state, hint: lines.join("\n"), bound: cell.bound, estimated, provisional };
}

export const cellOf = (metrics: unknown, key: TenantValueKey): CellView => metricCellView(key, readStoredCell(metrics, key));

// ─────────────────────────── Sức khoẻ · rủi ro · vấn đề chính ───────────────────────────

export type ExplainedCode = { code: string; label: string; text: string };

export type HealthView = {
  day: string;
  /** Số ngày ảnh sức khoẻ cũ hơn hôm nay — 0 = hôm nay. */
  staleDays: number;
  level: CustomerHealthLevel;
  levelLabel: string;
  reasons: ExplainedCode[];
  gaps: ExplainedCode[];
  churn: { risk: ChurnRiskLevel; label: string; reasons: ExplainedCode[] };
  topIssue: { label: string; explanation: string; actionLabel: string; href: string } | null;
};

export type TenantHealthRaw = {
  day: string;
  level: string;
  churnRisk: string;
  reasonCodes: readonly string[];
  gapCodes: readonly string[];
  churnReasonCodes: readonly string[];
  topIssue: unknown;
};

const VERDICT_LABEL: Record<keyof typeof HEALTH_VERDICT_REASONS, string> = { ALL_SIGNALS_OK: "Mọi tín hiệu ổn", SIGNALS_MISSING: "Còn tín hiệu chưa đo", INACTIVE: "Đã dừng" };
const VALUE_GAP_LABEL: Record<keyof typeof VALUE_HEALTH_GAPS, string> = {
  BASE_HEALTH_MISSING: "Chưa có sức khoẻ vận hành",
  VALUE_SNAPSHOT_MISSING: "Chưa có ảnh giá trị",
  USAGE_TREND_UNMEASURED: "Chưa so được xu hướng dùng",
  VALUE_MULTIPLE_UNMEASURED: "Chưa có bội số giá trị",
};

function explainSafe(code: string): string {
  try {
    return explainHealthCode(code as TenantHealthReasonCode | TenantHealthGapCode) || code;
  } catch {
    return code;
  }
}

function healthCodeLabel(code: string): string {
  if (code in HEALTH_REASONS) return HEALTH_REASONS[code as keyof typeof HEALTH_REASONS].label;
  if (code in VALUE_HEALTH_REASONS) return VALUE_HEALTH_REASONS[code as keyof typeof VALUE_HEALTH_REASONS].label;
  if (code in VERDICT_LABEL) return VERDICT_LABEL[code as keyof typeof VERDICT_LABEL];
  if (code in HEALTH_GAPS) return HEALTH_GAPS[code as keyof typeof HEALTH_GAPS].label;
  if (code in VALUE_GAP_LABEL) return VALUE_GAP_LABEL[code as keyof typeof VALUE_GAP_LABEL];
  return code;
}

/** Số ngày từ `day` tới `today` (cả hai YYYY-MM-DD). */
export function daysBetween(day: string, today: string): number {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
}

function topIssueView(raw: unknown): HealthView["topIssue"] {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const action = (t.action && typeof t.action === "object" ? t.action : {}) as Record<string, unknown>;
  const label = str(t.label);
  const href = str(action.href);
  // Lối ra chỉ là đường dẫn NỘI BỘ của trang nền tảng — không in một URL lạ lấy từ jsonb.
  if (!label || !href || !href.startsWith("/platform/")) return label ? { label, explanation: str(t.explanation) ?? "", actionLabel: "", href: "" } : null;
  return { label, explanation: str(t.explanation) ?? "", actionLabel: str(action.label) ?? "Mở", href };
}

export function healthView(raw: TenantHealthRaw | null, today: string): HealthView | null {
  if (!raw) return null;
  const level = (CUSTOMER_HEALTH_LEVELS as readonly string[]).includes(raw.level) ? (raw.level as CustomerHealthLevel) : "UNKNOWN";
  const risk = (CHURN_RISK_LEVELS as readonly string[]).includes(raw.churnRisk) ? (raw.churnRisk as ChurnRiskLevel) : "UNKNOWN";
  return {
    day: raw.day,
    staleDays: daysBetween(raw.day, today),
    level,
    levelLabel: CUSTOMER_HEALTH_LABEL[level],
    reasons: raw.reasonCodes.map((code) => ({ code, label: healthCodeLabel(code), text: explainSafe(code) })),
    gaps: raw.gapCodes.map((code) => ({ code, label: healthCodeLabel(code), text: explainSafe(code) })),
    churn: {
      risk,
      label: CHURN_RISK_LABEL[risk],
      reasons: raw.churnReasonCodes.map((code) => {
        const r = code in CHURN_REASONS ? CHURN_REASONS[code as keyof typeof CHURN_REASONS] : null;
        return { code, label: r?.label ?? code, text: r?.explanation ?? code };
      }),
    },
    topIssue: topIssueView(raw.topIssue),
  };
}

// ─────────────────────────── Một dòng của bảng ───────────────────────────

export type TenantValueRawRow = {
  orgCode: string;
  orgName: string | null;
  orgStatus: string | null;
  accountCode: string | null;
  capturedDay: string;
  capturedAtMs: number;
  formulaVersion: string;
  sourceErrors: readonly string[];
  metrics: unknown;
  /** Ô bội số đọc từ ảnh của cửa sổ BỘI SỐ (D12) cùng tổ chức — bội số chỉ có nghĩa ở đó. `null` = chưa có ảnh cửa sổ ấy. */
  multiple: { metrics: unknown; capturedDay: string } | null;
};

export type TenantValueBoardRow = {
  orgCode: string;
  orgName: string;
  orgStatus: string | null;
  accountCode: string | null;
  /** Trang chi tiết khách (theo tài khoản) — workspace chưa gắn tài khoản ⇒ chẩn đoán tổ chức. */
  href: string;
  capturedDay: string;
  capturedAtMs: number;
  /** Số ngày ảnh giá trị cũ hơn hôm nay — 0 = ảnh hôm nay. */
  staleDays: number;
  formulaVersion: string;
  sourceErrors: string[];
  spend: CellView;
  spendCash: CellView;
  cogs: CellView;
  aiCogs: CellView;
  unpricedCalls: CellView;
  aiAutoOrders: CellView;
  aiInfluencedOrders: CellView;
  aiCreditedRevenue: CellView;
  aiInfluencedRevenue: CellView;
  ordersPending: CellView;
  multiple: CellView;
  multipleCoverage: CellView;
  multipleDay: string | null;
  contribution: CellView;
  grossProfit: CellView;
  grossProfitCeiling: CellView;
  health: HealthView | null;
};

export function tenantValueRowView(raw: TenantValueRawRow, health: TenantHealthRaw | null, today: string): TenantValueBoardRow {
  const m = raw.metrics;
  const mm = raw.multiple?.metrics ?? null;
  return {
    orgCode: raw.orgCode,
    orgName: raw.orgName ?? raw.orgCode,
    orgStatus: raw.orgStatus,
    accountCode: raw.accountCode,
    href: raw.accountCode ? `/platform/customers/${encodeURIComponent(raw.accountCode)}` : `/platform/org/${encodeURIComponent(raw.orgCode)}`,
    capturedDay: raw.capturedDay,
    capturedAtMs: raw.capturedAtMs,
    staleDays: daysBetween(raw.capturedDay, today),
    formulaVersion: raw.formulaVersion,
    sourceErrors: [...raw.sourceErrors],
    spend: cellOf(m, "customer_spend_recognized"),
    spendCash: cellOf(m, "customer_spend_cash"),
    cogs: cellOf(m, "variable_cogs_known"),
    aiCogs: cellOf(m, "actual_ai_cogs"),
    unpricedCalls: cellOf(m, "ai_unpriced_calls"),
    aiAutoOrders: cellOf(m, "ai_auto_closed_orders"),
    aiInfluencedOrders: cellOf(m, "ai_influenced_orders"),
    aiCreditedRevenue: cellOf(m, "ai_credited_delivered_revenue"),
    aiInfluencedRevenue: cellOf(m, "ai_influenced_delivered_revenue"),
    ordersPending: cellOf(m, "orders_pending"),
    multiple: raw.multiple ? cellOf(mm, "customer_value_multiple") : metricCellView("customer_value_multiple", null),
    multipleCoverage: raw.multiple ? cellOf(mm, "ai_credited_cogs_coverage") : metricCellView("ai_credited_cogs_coverage", null),
    multipleDay: raw.multiple?.capturedDay ?? null,
    contribution: cellOf(m, "platform_contribution"),
    grossProfit: cellOf(m, "platform_gross_profit"),
    grossProfitCeiling: cellOf(m, "platform_gross_profit_ceiling"),
    health: healthView(health, today),
  };
}

/** Các quyết định TẠM mà những dòng đang hiện dựa vào — để khối «Quyết định tạm» chỉ liệt kê đúng những mục đang có hiệu lực. */
export function provisionalDecisionsOf(rows: readonly TenantValueBoardRow[]): TenantValueDecisionId[] {
  const out = new Set<TenantValueDecisionId>();
  for (const r of rows) {
    for (const c of [r.spend, r.spendCash, r.cogs, r.aiCogs, r.aiAutoOrders, r.aiInfluencedOrders, r.aiCreditedRevenue, r.aiInfluencedRevenue, r.multiple, r.multipleCoverage, r.contribution, r.grossProfit, r.grossProfitCeiling]) {
      if (c.provisional && c.provisional !== "?") out.add(c.provisional);
    }
  }
  return [...out].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// ─────────────────────────── Một khách: ba cửa sổ ───────────────────────────

/** Dòng của khối «Giá trị & kinh tế đơn vị» ở trang một khách (màn người vận hành — được thấy giá vốn / biên, OPERATOR_KEYS). */
export const TENANT_VALUE_DETAIL_KEYS = [
  "customer_spend_recognized",
  "customer_spend_cash",
  "variable_cogs_known",
  "actual_ai_cogs",
  "ai_unpriced_calls",
  "platform_contribution",
  "platform_gross_profit",
  "platform_gross_profit_ceiling",
  "ai_auto_closed_orders",
  "ai_assisted_orders",
  "human_only_orders",
  "unattributed_orders",
  "attributed_orders_total",
  "ai_recovered_orders",
  "ai_upsell_orders",
  "orders_pending",
  "ai_credited_delivered_revenue",
  "ai_influenced_delivered_revenue",
  "ai_credited_gross_profit",
  "ai_credited_cogs_coverage",
  "customer_value_multiple",
  "conversations",
  "conversion_rate",
  "human_intervention_rate",
  "cost_per_conversation",
  "ai_error_rate",
  "response_p50_ms",
] as const satisfies readonly TenantValueKey[];
export type TenantValueDetailKey = (typeof TENANT_VALUE_DETAIL_KEYS)[number];

export type TenantValueWindowView = {
  capturedDay: string;
  capturedAtMs: number;
  staleDays: number;
  formulaVersion: string;
  sourceErrors: string[];
  cells: Record<TenantValueDetailKey, CellView>;
};

export function tenantValueWindowView(raw: { capturedDay: string; capturedAtMs: number; formulaVersion: string; sourceErrors: readonly string[]; metrics: unknown }, today: string): TenantValueWindowView {
  return {
    capturedDay: raw.capturedDay,
    capturedAtMs: raw.capturedAtMs,
    staleDays: daysBetween(raw.capturedDay, today),
    formulaVersion: raw.formulaVersion,
    sourceErrors: [...raw.sourceErrors],
    cells: Object.fromEntries(TENANT_VALUE_DETAIL_KEYS.map((k) => [k, cellOf(raw.metrics, k)])) as Record<TenantValueDetailKey, CellView>,
  };
}
