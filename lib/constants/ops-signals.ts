/**
 * ═══════════ TÁM TÍN HIỆU VẬN HÀNH CỦA MỘT KHÁCH — HÀM THUẦN, CLIENT-SAFE (LAUNCH SPRINT §11 · sứ mệnh saas-ops-signals) ═══════════
 *
 * Trước khách trả tiền đầu tiên, người vận hành nền tảng phải CHẨN ĐOÁN được cho từng khách: (1) đăng nhập hỏng · (2) Facebook mất kết
 * nối · (3) webhook hỏng · (4) AI im · (5) gửi tin hỏng · (6) đơn không hợp lệ · (7) ghi đơn hỏng · (8) hết hạn mức. Mỗi loại MỘT dòng
 * của khung «Sự cố 24 giờ / 7 ngày» ở `/platform/org/<mã>`: mức · đếm · lần cuối · lý do cuối · id tương quan.
 *
 * NGUỒN (đều ở CSDL NHÀ — đọc một câu cho mọi tổ chức, không N+1, lib/platform/ops-signals.ts):
 *  · LOGIN                    — `platform_auth_failures` (lib/auth/auth-failures.ts).
 *  · AI · QUOTA               — `platform_ai_usage` (dòng ERROR mang `error_class`, BLOCKED_QUOTA mang trần nào chạm) + gương.
 *  · FB · WEBHOOK · SEND · ĐƠN — gương `platform_org_health`, job `sales-health` ghi kết luận đã tính trong CSDL tổ chức; sự cố ghi đơn
 *                               ghi thẳng từ đường nóng (`noteOrgHealthEvent`) để hiện ngay, job đếm lại từ `audit_logs` của tổ chức.
 *
 * CHƯA BIẾT ≠ 0 (luật 42): nguồn chưa từng ghi cho tổ chức này ⇒ đếm `null` («—»), mức UNKNOWN; không áp dụng (không có page nối thẳng,
 * module tắt) ⇒ NA. Sổ mới có từ lúc migration 0236 áp ⇒ dòng in «đo từ …» khi mốc ấy nằm trong cửa sổ 7 ngày — «0 lỗi / 7 ngày»
 * trên một sổ mới hai ngày tuổi là khẳng định sai. Mốc ấy dựng TỪ DỮ LIỆU (dòng sớm nhất của hai sổ mới), không từ dòng gieo lúc migrate.
 */
import { AUTH_FAILURE_FLOW_LABEL, AUTH_FAILURE_REASON_LABEL, type AuthFailureFlow } from "@/lib/constants/auth-failures";

export const OPS_SIGNAL_KEYS = ["LOGIN", "FB_CONNECTION", "WEBHOOK", "AI", "SEND", "ORDER_VALIDATION", "ORDER_WRITE", "QUOTA"] as const;
export type OpsSignalKey = (typeof OPS_SIGNAL_KEYS)[number];

/** Kiểm có GƯƠNG ở `platform_org_health` (LOGIN đọc thẳng sổ lỗi đăng nhập). CHECK của bảng = đúng danh sách này. */
export const ORG_HEALTH_CHECK_KEYS = ["FB_CONNECTION", "WEBHOOK", "AI", "SEND", "ORDER_VALIDATION", "ORDER_WRITE", "QUOTA"] as const satisfies readonly OpsSignalKey[];
export type OrgHealthCheckKey = (typeof ORG_HEALTH_CHECK_KEYS)[number];

export const OPS_LEVELS = ["OK", "WARNING", "CRITICAL", "UNKNOWN", "NA"] as const;
export type OpsLevel = (typeof OPS_LEVELS)[number];

const RANK: Record<OpsLevel, number> = { NA: 0, OK: 0, UNKNOWN: 1, WARNING: 2, CRITICAL: 3 };

/** Mức nặng nhất. Không đối số ⇒ OK. HÀM THUẦN. */
export function worstLevel(...levels: readonly OpsLevel[]): OpsLevel {
  let out: OpsLevel = levels.length ? levels[0] : "OK";
  for (const l of levels) if (RANK[l] > RANK[out] || (RANK[l] === RANK[out] && out === "NA" && l === "OK")) out = l;
  return out;
}

export const OPS_SIGNAL_LABEL: Record<OpsSignalKey, string> = {
  LOGIN: "Đăng nhập",
  FB_CONNECTION: "Kết nối Facebook",
  WEBHOOK: "Tin khách tới (webhook)",
  AI: "AI trả lời",
  SEND: "Gửi tin cho khách",
  ORDER_VALIDATION: "Đơn không hợp lệ",
  ORDER_WRITE: "Ghi đơn (OMS)",
  QUOTA: "Hạn mức / số dư AI",
};

/** Câu «đọc ở đâu» cho người vận hành (ⓘ) — nguồn thật của từng dòng. */
export const OPS_SIGNAL_SOURCE: Record<OpsSignalKey, string> = {
  LOGIN: "platform_auth_failures — lý do của từng lượt đăng nhập / liên kết đặt mật khẩu / liên kết mời hỏng (định danh đã che).",
  FB_CONNECTION: "Gương job sales-health: page Messenger nối thẳng (lỗi token / quyền) + kiểm đăng ký webhook định kỳ (có trần lượt gọi Graph).",
  WEBHOOK: "Gương job sales-health: đăng ký webhook của page · tin khách im so với nền cùng khung giờ · hàng chờ · tin bị bỏ sót / dead-letter khác.",
  AI: "platform_ai_usage (dòng ERROR theo lớp lỗi) + gương job sales-health (nhà cung cấp AI · bot im · hội thoại chuyển người vì AI hỏng).",
  SEND: "Gương job sales-health: tin khách chốt kèm lỗi gửi (Pancake / Meta / Zalo không nhận tin) — đếm theo tin khách.",
  ORDER_VALIDATION: "audit_logs của tổ chức (order.validation_failed) — công cụ bot / lõi đơn từ chối đơn (thiếu SĐT / địa chỉ, mã không có, chưa có giá, thiếu hàng, hạn mức nợ…).",
  ORDER_WRITE: "audit_logs của tổ chức (order.create_failed) — lõi đơn ném lỗi khi bot ghi khách / đơn. Không bao giờ bị ghi thành «AI hỏng».",
  QUOTA: "platform_ai_usage (BLOCKED_QUOTA theo trần) + gương job sales-health (cổng gói: dùng thử hết · số dư AI hết · đình chỉ).",
};

export const OPS_LEVEL_LABEL: Record<OpsLevel, string> = { OK: "Ổn", WARNING: "Cảnh báo", CRITICAL: "Nghiêm trọng", UNKNOWN: "Chưa rõ", NA: "Không áp dụng" };

// ─────────────────────────── Đơn của bot: kết quả ghi đơn hỏng / bị từ chối ───────────────────────────

/** `audit_logs.entity` của lượt bot ghi đơn KHÔNG thành — chỉ mục (entity, created_at) đếm nhanh, tách khỏi nhật ký đơn thường. */
export const ORDER_ATTEMPT_ENTITY = "ORDER_ATTEMPT";
/** Lõi đơn NÉM lỗi (CSDL hỏng, lỗi lập trình) khi bot ghi khách / đơn — tín hiệu (7). */
export const ORDER_CREATE_FAILED_ACTION = "order.create_failed";
/** Công cụ bot / lõi đơn TỪ CHỐI đơn (dữ liệu không hợp lệ) — tín hiệu (6). */
export const ORDER_VALIDATION_FAILED_ACTION = "order.validation_failed";

export const ORDER_WRITE_REASONS = ["CUSTOMER_WRITE_ERROR", "ORDER_DRAFT_ERROR", "ORDER_CONFIRM_ERROR", "ORDER_FLAG_ERROR"] as const;
export type OrderWriteReason = (typeof ORDER_WRITE_REASONS)[number];

export const ORDER_VALIDATION_REASONS = [
  "MISSING_CONTACT",
  "BAD_INPUT",
  "UNKNOWN_SKU",
  "UNPRICED_SKU",
  "STOCK_SHORT",
  "CREDIT_LIMIT",
  "OMS_INVALID",
  "OMS_CONFLICT",
  "OMS_NOT_SUPPORTED",
  "OMS_MODULE_DISABLED",
  "OMS_FORBIDDEN",
  "OMS_NOT_FOUND",
  "OMS_OTHER",
] as const;
export type OrderValidationReason = (typeof ORDER_VALIDATION_REASONS)[number];

/**
 * Lý do chuyển người khi GHI ĐƠN hỏng — KHÔNG phải «AI tạm không trả lời được»: nhà cung cấp AI vẫn chạy, thứ hỏng là lõi đơn. Không
 * thuộc nhóm nhường tự hết hạn (ai-hold-shared.ts) ⇒ AI im tới khi người trả lại — bot không tự thử ghi lại một đơn chưa ai kiểm.
 */
export const ORDER_WRITE_HANDOFF_REASON = "Ghi đơn hỏng — nhân viên lên đơn tay cho khách (bot đã dừng, đơn CHƯA ghi được)";

// ─────────────────────────── Lý do của gương (mã ngắn, CHECK `^[A-Z][A-Z0-9_]{1,40}$`) ───────────────────────────

export const SEND_FAILURE_REASONS = ["TOKEN", "PERMISSION", "WINDOW", "RECIPIENT", "RATE_LIMIT", "TIMEOUT", "REJECTED", "OTHER"] as const;
export type SendFailureReason = (typeof SEND_FAILURE_REASONS)[number];

export const WEBHOOK_REASONS = ["NOT_SUBSCRIBED", "MISSING_FIELDS", "BACKLOG", "ABANDONED", "DEAD_LETTER", "SILENT", "BASELINE_THIN"] as const;
export const FB_REASONS = ["TOKEN_EXPIRED", "PERMISSION", "TOKEN", "CHECK_SKIPPED"] as const;

export const OPS_REASON_LABEL: Record<string, string> = {
  ...AUTH_FAILURE_REASON_LABEL,
  // AI — lớp lỗi nhà cung cấp (classifyAiFailure) + trần hạn mức (AiQuotaBlockReason)
  CREDIT: "Tài khoản AI hết tiền",
  AUTH: "Khoá AI bị từ chối",
  RATE_LIMIT: "Quá tải / chạm giới hạn gọi",
  MODEL_UNAVAILABLE: "Model không dùng được",
  SERVER_ERROR: "Nhà cung cấp lỗi máy chủ / mạng",
  TIMEOUT: "Hết giờ chờ",
  INVALID_REQUEST: "Câu hỏi bị từ chối (nội dung / sai hình)",
  OTHER: "Lỗi khác",
  UNCLASSIFIED: "Chưa phân loại (dòng trước 0236)",
  REQUESTS_DAY: "Hết lượt AI hôm nay",
  REQUESTS_MONTH: "Hết lượt AI tháng này",
  COST_HARD: "Chạm trần chi phí AI",
  NO_PLATFORM_CREDIT: "Gói không có credit AI dùng chung",
  PLATFORM_CREDIT_USED: "Hết credit AI dùng chung tháng này",
  PLAN_UNREADABLE: "Không đọc được gói",
  // Cổng gói (AiStopReason)
  WORKSPACE_SUSPENDED: "Workspace đình chỉ",
  TRIAL_EXPIRED: "Hết hạn dùng thử",
  TRIAL_QUOTA_EXHAUSTED: "Hết lượt khách AI của dùng thử",
  BALANCE_EXHAUSTED: "Số dư AI hết — không nhận khách mới",
  // Gửi tin
  TOKEN: "Token page hết hiệu lực",
  PERMISSION: "App không còn quyền với page",
  WINDOW: "Ngoài khung 24 giờ",
  RECIPIENT: "Khách chặn page / không nhận tin",
  REJECTED: "Kênh gửi từ chối (HTTP 4xx/5xx)",
  // Facebook / webhook
  TOKEN_EXPIRED: "Token page hết hạn (Meta báo)",
  CHECK_SKIPPED: "Chưa kiểm được (app nền tảng chưa cấu hình / Graph giới hạn)",
  NOT_SUBSCRIBED: "Page chưa đăng ký webhook của app",
  MISSING_FIELDS: "Đăng ký webhook thiếu trường",
  BACKLOG: "Hàng chờ tin quá SLO",
  ABANDONED: "Tin bị bỏ sót (chờ quá cửa sổ tự xử lý)",
  DEAD_LETTER: "Tin không xử lý được (dead-letter khác)",
  SILENT: "Im so với nền cùng khung giờ",
  BASELINE_THIN: "Chưa đủ ngày dữ liệu để biết im hay không",
  AI_DOWN: "Hội thoại chuyển người vì AI hỏng",
  BOT_SILENT: "Bot im (tin khách được chốt, không câu bot nào)",
  PROVIDER: "Nhà cung cấp AI lỗi",
  LATENCY: "Trả lời chậm hơn SLO",
  // Đơn
  CUSTOMER_WRITE_ERROR: "Lỗi khi ghi khách",
  ORDER_DRAFT_ERROR: "Lỗi khi ghi đơn nháp",
  ORDER_CONFIRM_ERROR: "Lỗi khi chốt đơn",
  ORDER_FLAG_ERROR: "Lỗi khi ghi chú «khách huỷ» lên đơn",
  MISSING_CONTACT: "Thiếu tên / SĐT / địa chỉ",
  BAD_INPUT: "Đầu vào đơn không hợp lệ",
  UNKNOWN_SKU: "Mã hàng không có",
  UNPRICED_SKU: "Mã hàng chưa có giá",
  STOCK_SHORT: "Không đủ hàng khả dụng",
  CREDIT_LIMIT: "Vượt hạn mức nợ / cần duyệt",
  OMS_INVALID: "Lõi đơn từ chối: dữ liệu sai",
  OMS_CONFLICT: "Lõi đơn từ chối: xung đột (giá / tồn / cờ kiểm)",
  OMS_NOT_SUPPORTED: "Lõi đơn từ chối: tổ chức đồng bộ đơn / đơn không sửa được",
  OMS_MODULE_DISABLED: "Module Đơn hàng đang tắt",
  OMS_FORBIDDEN: "Lõi đơn từ chối: không có quyền",
  OMS_NOT_FOUND: "Lõi đơn từ chối: không có đơn / khách",
  OMS_OTHER: "Lõi đơn từ chối (khác)",
};

export function opsReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return OPS_REASON_LABEL[code] ?? code;
}

/** Gương không được đo lại quá chừng này ⇒ dòng mang dấu «cũ» (job chạy 5 phút / lần). */
export const OPS_MIRROR_STALE_MINUTES = 20;

/** QUOTA: lượt bị chặn gần hơn chừng này ⇒ NGHIÊM TRỌNG (khách đang không được AI trả lời); xa hơn trong 24 giờ ⇒ CẢNH BÁO. */
export const OPS_QUOTA_HOT_MINUTES = 60;

// ─────────────────────────── Dựng tám dòng (HÀM THUẦN) ───────────────────────────

/** Một dòng gương đã đọc (ngày dạng ISO). */
export type OrgHealthRowView = {
  key: OrgHealthCheckKey;
  level: OpsLevel;
  count24h: number | null;
  count7d: number | null;
  lastAt: string | null;
  lastReason: string | null;
  correlationId: string | null;
  detail: string | null;
  since: string | null;
  measuredAt: string | null;
};

/** Đếm gom từ sổ của CSDL nhà (lỗi đăng nhập · dòng AI ERROR · dòng BLOCKED_QUOTA) — `extra` tuỳ nguồn. */
export type FailureAgg = { count24h: number; count7d: number; lastAt: string | null; lastReason: string | null; correlationId: string | null; extra: string | null; unclassified: number };

export type OpsSignalInput = {
  mirror: Partial<Record<OrgHealthCheckKey, OrgHealthRowView>>;
  login: FailureAgg | null;
  aiErrors: FailureAgg | null;
  aiBlocked: FailureAgg | null;
  /** Lượt AI gần nhất (mọi trạng thái) của tổ chức trong sổ — `null` = tổ chức chưa từng có lượt AI nào. */
  aiLastAnyAt: string | null;
  /**
   * Mốc bắt đầu đo của các sổ MỚI (0236) — dựng TỪ DỮ LIỆU: dòng sớm nhất của `platform_auth_failures` / `platform_org_health` trên
   * toàn nền tảng (cận dưới thận trọng: bộ ghi chạy TỪ TRƯỚC mốc này). `null` = hai sổ còn trống ⇒ chưa chứng minh được bộ ghi đã chạy.
   */
  signalsSince: string | null;
  /** Tổ chức có bật AI bán hàng không — `false` ⇒ các dòng chỉ có gương in N/A; `null`/thiếu = không biết (in «—»). */
  aiSalesEnabled?: boolean | null;
};

export type OpsSignalLine = {
  key: OpsSignalKey;
  label: string;
  level: OpsLevel;
  /** `null` = CHƯA ĐO («—»), không phải 0. */
  count24h: number | null;
  count7d: number | null;
  lastAt: string | null;
  lastReason: string | null;
  lastReasonLabel: string | null;
  correlationId: string | null;
  detail: string | null;
  /** Mốc bắt đầu đo khi nó nằm TRONG cửa sổ 7 ngày (số 7 ngày là số một phần). */
  measuredFrom: string | null;
  /** Lượt đo gần nhất của gương (chỉ dòng có gương). */
  measuredAt: string | null;
  /** Gương quá `OPS_MIRROR_STALE_MINUTES` không được đo lại. */
  stale: boolean;
  /** Câu giải thích vì sao «—» / N/A / số một phần. */
  note: string | null;
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const newer = (a: string | null, b: string | null): string | null => {
  const x = ms(a);
  const y = ms(b);
  if (x === null) return b;
  if (y === null) return a;
  return x >= y ? a : b;
};

function measuredFromOf(since: string | null, now: Date): string | null {
  const t = ms(since);
  return t !== null && t > now.getTime() - 7 * 86_400_000 ? since : null;
}

function base(key: OpsSignalKey): Omit<OpsSignalLine, "level"> {
  return { key, label: OPS_SIGNAL_LABEL[key], count24h: null, count7d: null, lastAt: null, lastReason: null, lastReasonLabel: null, correlationId: null, detail: null, measuredFrom: null, measuredAt: null, stale: false, note: null };
}

function mirrorLine(key: OrgHealthCheckKey, row: OrgHealthRowView | undefined, input: OpsSignalInput, now: Date): OpsSignalLine {
  if (!row) {
    if (input.aiSalesEnabled === false) return { ...base(key), level: "NA", note: "Tổ chức không bật AI bán hàng — không có gì để đo." };
    return { ...base(key), level: "UNKNOWN", note: "Chưa có lượt đo nào cho tổ chức này (job sales-health chỉ chạy cho tổ chức bật AI bán hàng) — CHƯA BIẾT, không phải 0." };
  }
  const measured = ms(row.measuredAt);
  const stale = measured === null || now.getTime() - measured > OPS_MIRROR_STALE_MINUTES * 60_000;
  const note =
    measured === null
      ? "Mới có sự cố ghi thẳng từ đường nóng, chưa có lượt đo nào của giám sát — số đếm là phần ghi được, chưa đối chiếu."
      : stale
        ? "Giám sát không đo lại tổ chức này từ mốc «đo lúc» — mức và số là của lượt đo đó."
        : null;
  return {
    ...base(key),
    level: row.level,
    count24h: row.count24h,
    count7d: row.count7d,
    lastAt: row.lastAt,
    lastReason: row.lastReason,
    lastReasonLabel: opsReasonLabel(row.lastReason),
    correlationId: row.correlationId,
    detail: row.detail,
    measuredAt: row.measuredAt,
    stale,
    note,
  };
}

function loginLine(input: OpsSignalInput, now: Date): OpsSignalLine {
  if (!input.signalsSince) return { ...base("LOGIN"), level: "UNKNOWN", note: "Sổ lỗi đăng nhập và gương sức khoẻ còn trống trên toàn nền tảng — chưa chứng minh được bộ ghi đã chạy, CHƯA BIẾT." };
  const a = input.login;
  const c24 = a?.count24h ?? 0;
  const who = a?.extra ? a.extra : null;
  return {
    ...base("LOGIN"),
    level: c24 > 0 ? "WARNING" : "OK",
    count24h: c24,
    count7d: a?.count7d ?? 0,
    lastAt: a?.lastAt ?? null,
    lastReason: a?.lastReason ?? null,
    lastReasonLabel: opsReasonLabel(a?.lastReason),
    correlationId: null,
    detail: who,
    measuredFrom: measuredFromOf(input.signalsSince, now),
  };
}

function aiLine(input: OpsSignalInput, now: Date): OpsSignalLine {
  const m = input.mirror.AI;
  const e = input.aiErrors;
  if (!m && !e && !input.aiLastAnyAt) return { ...base("AI"), level: input.aiSalesEnabled === false ? "NA" : "UNKNOWN", note: "Tổ chức chưa có lượt AI nào trong sổ và chưa có lượt đo của giám sát — CHƯA BIẾT." };
  const fromMirror = m ? mirrorLine("AI", m, input, now) : null;
  const c24 = e?.count24h ?? 0;
  const errorLevel: OpsLevel = c24 > 0 ? "WARNING" : "OK";
  const lastReason = e ? (e.lastReason ?? "UNCLASSIFIED") : (m?.lastReason ?? null);
  const parts = [m?.detail ?? null, e && e.unclassified > 0 ? `${e.unclassified} lượt lỗi chưa phân loại (trước 0236)` : null, e?.extra ? `tính năng lỗi cuối: ${e.extra}` : null].filter((x): x is string => Boolean(x));
  return {
    ...base("AI"),
    level: worstLevel(errorLevel, fromMirror ? fromMirror.level : "OK"),
    count24h: c24,
    count7d: e?.count7d ?? 0,
    lastAt: newer(e?.lastAt ?? null, m?.lastAt ?? null),
    lastReason,
    lastReasonLabel: opsReasonLabel(lastReason),
    correlationId: e?.correlationId ?? m?.correlationId ?? null,
    detail: parts.join(" · ") || null,
    measuredAt: m?.measuredAt ?? null,
    stale: fromMirror?.stale ?? false,
    note: fromMirror ? fromMirror.note : "Giám sát bot chưa đo tổ chức này — số đếm chỉ là dòng lỗi của sổ AI.",
  };
}

function quotaLine(input: OpsSignalInput, now: Date): OpsSignalLine {
  const m = input.mirror.QUOTA;
  const b = input.aiBlocked;
  if (!m && !b && !input.aiLastAnyAt) return { ...base("QUOTA"), level: input.aiSalesEnabled === false ? "NA" : "UNKNOWN", note: "Tổ chức chưa có lượt AI nào trong sổ và chưa có lượt đo của giám sát — CHƯA BIẾT." };
  const fromMirror = m ? mirrorLine("QUOTA", m, input, now) : null;
  const last = ms(b?.lastAt ?? null);
  const blockedLevel: OpsLevel = !b || b.count24h === 0 ? "OK" : last !== null && now.getTime() - last <= OPS_QUOTA_HOT_MINUTES * 60_000 ? "CRITICAL" : "WARNING";
  const lastAt = newer(b?.lastAt ?? null, m?.lastAt ?? null);
  const lastReason = lastAt && lastAt === (b?.lastAt ?? null) ? (b?.lastReason ?? "UNCLASSIFIED") : (m?.lastReason ?? null);
  const plan24 = m?.count24h ?? null;
  const parts = [b && b.count24h > 0 ? `${b.count24h} lượt bị chặn hạn mức / 24 giờ` : null, m?.detail ?? null].filter((x): x is string => Boolean(x));
  return {
    ...base("QUOTA"),
    level: worstLevel(blockedLevel, fromMirror ? fromMirror.level : "OK"),
    count24h: (b?.count24h ?? 0) + (plan24 ?? 0),
    count7d: (b?.count7d ?? 0) + (m?.count7d ?? 0),
    lastAt,
    lastReason,
    lastReasonLabel: opsReasonLabel(lastReason),
    correlationId: lastAt && lastAt === (b?.lastAt ?? null) ? (b?.correlationId ?? null) : (m?.correlationId ?? b?.correlationId ?? null),
    detail: parts.join(" · ") || null,
    measuredAt: m?.measuredAt ?? null,
    stale: fromMirror?.stale ?? false,
    note: fromMirror ? fromMirror.note : "Giám sát chưa đo cổng gói / số dư của tổ chức này — số đếm chỉ là lượt bị chặn hạn mức trong sổ AI.",
  };
}

/** Tám dòng, đúng thứ tự `OPS_SIGNAL_KEYS`. HÀM THUẦN, chạy hai lần ra cùng kết quả. */
export function buildOpsSignalLines(input: OpsSignalInput, now: Date): OpsSignalLine[] {
  const from = measuredFromOf(input.signalsSince, now);
  return OPS_SIGNAL_KEYS.map((key) => {
    if (key === "LOGIN") return loginLine(input, now);
    if (key === "AI") return aiLine(input, now);
    if (key === "QUOTA") return quotaLine(input, now);
    const line = mirrorLine(key, input.mirror[key], input, now);
    // Sổ đơn của bot (audit_logs) chỉ có từ 0236 — số 7 ngày là một phần khi mốc nằm trong cửa sổ.
    return key === "ORDER_WRITE" || key === "ORDER_VALIDATION" ? { ...line, measuredFrom: line.count7d === null ? null : from } : line;
  });
}

/** Chữ của một dòng lỗi đăng nhập cuối: «Đăng nhập · ng***@gmail.com». */
export function authFailureWho(flow: string | null, masked: string | null): string | null {
  const f = flow && flow in AUTH_FAILURE_FLOW_LABEL ? AUTH_FAILURE_FLOW_LABEL[flow as AuthFailureFlow] : null;
  return [f, masked].filter(Boolean).join(" · ") || null;
}
