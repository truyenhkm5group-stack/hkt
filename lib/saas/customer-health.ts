/**
 * ═══════════ PHÂN LOẠI SỨC KHOẺ KHÁCH — HÀM THUẦN (mức · lý do · chỗ chưa đo · sự việc để in) ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ (`now` truyền vào), chạy hai lần ra MỘT kết quả. Đầu vào dựng ở
 * `lib/saas/customer-signals.ts` (một lượt gom, chỉ CSDL nhà — không mở CSDL tổ chức nào); mức, lý do, ngưỡng khai ở
 * `lib/constants/customer-health.ts`.
 *
 * Ba luật chạy xuyên tệp:
 *  · MỘT LÝ DO = MỘT SỰ VIỆC có số / mốc / nguồn. Mức = mức nặng nhất (không cộng, không trọng số — §7 spec SaaS).
 *  · THIẾU ≠ KHOẺ: tín hiệu bắt buộc không đọc được là một CHỖ CHƯA ĐO; không lý do + có chỗ chưa đo ⇒ «Chưa đủ dữ liệu».
 *  · KHÔNG KẾT LUẬN KHI KHÔNG CÓ CHỨNG CỨ: vắng dòng đăng nhập trước khi có chỉ mục, ngày sổ dùng chưa chụp, nền tin khách dưới
 *    số ngày tối thiểu — đều là «chưa biết», không phải 0 (luật 42 · 52).
 *
 * Tín hiệu AI / kênh / tin khách / đơn chỉ áp dụng cho workspace THUÊ Chốt Đơn (thuê bao đang mở năng lực). ERP: CSDL nhà chỉ
 * thấy được đăng nhập — việc dùng ERP sâu (đơn, kho…) nằm trong CSDL của khách, màn danh sách không mở (xem `/platform/org/<mã>`).
 */
import { addDays, vnDate } from "@/lib/billing/rules";
import { CUSTOMER_HEALTH_RANK, CUSTOMER_HEALTH_THRESHOLDS, HEALTH_GAPS, HEALTH_REASONS, IDENTITY_INDEX_SINCE, type CustomerHealthLevel, type CustomerHealthThresholds, type HealthGapCode, type HealthReasonCode, type ProblemLevel } from "@/lib/constants/customer-health";
import { formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { USAGE_ALERT_LABEL, usageAlert, type MeterCoverage, type UsageAlertConfig, type UsageAlertLevel } from "@/lib/pricing/versions";
import { PRODUCT_LABEL } from "@/lib/saas/catalog";
import { subscriptionGrantsUse, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CHOTDON = "chotdon";

// ─────────────────────────── Đầu vào ───────────────────────────

/** Một ngày của sổ dùng (`platform_tenant_usage_daily`). Ngày VẮNG trong mảng = chưa chụp (chưa biết), không phải 0. */
export type UsageDaySignal = { day: string; conversationsStarted: number; customerMessages: number; botMessages: number; aiOrders: number; fanpagesActive: number | null; capturedAt: Date };

/** Sổ AI bán hàng của một workspace (`lib/ai-usage/sales-health.ts`, gom theo tổ chức). Đếm theo LƯỢT (dòng sổ). */
export type AiLedgerSignal = {
  okInWindow: number;
  errorsInWindow: number;
  blockedInWindow: number;
  ok24h: number;
  errors24h: number;
  blocked24h: number;
  ok7d: number;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  orderSyncErrors24h: number;
  orderSyncErrorsInWindow: number;
  orderSyncLastOkAt: Date | null;
  orderSyncLastErrorAt: Date | null;
};

export type WorkspaceHealthInput = {
  code: string;
  name: string;
  isHome: boolean;
  orgStatus: string;
  createdAt: Date;
  /** Thuê bao SỐNG (chưa huỷ) kèm tình trạng hiệu lực. */
  subscriptions: { productKey: string; status: EffectiveSubscriptionStatus }[];
  /** Đã từng có thuê bao và đã huỷ hết — phân biệt «đã dừng» với «chưa thuê bao giờ». */
  hadEndedSubscriptions: boolean;
  /** `null` = không đọc được. */
  modules: { aiSales: boolean; legacyChatbot: boolean } | null;
  login: { identities: number; lastLoginAt: Date | null } | null;
  /** Page Messenger nối thẳng trong chỉ mục nền tảng. `null` = không đọc được. */
  messengerPages: number | null;
  aiSwitch: { platformEnabled: boolean; orgDisabled: boolean } | null;
  ai: AiLedgerSignal | null;
  /** `null` = không đọc được; `[]` = đọc được, chưa có ngày nào. */
  usage: UsageDaySignal[] | null;
  /** `null` = không đọc được mốc kích hoạt. */
  milestones: { channelConnectedAt: Date | null; firstAiReplyAt: Date | null; firstAiOrderAt: Date | null } | null;
  /** Đồng hồ khách AI của kỳ + phần gồm của gói (phiên bản đã ghim) + ngưỡng cảnh báo của phiên bản. `null` = không có. */
  aiCustomers: { value: number | null; coverage: MeterCoverage; included: number | null | undefined; alerts: UsageAlertConfig; prepaid: boolean } | null;
  /** Dòng vượt ghế (fanpage / người dùng) ĐÃ BIẾT > 0 của bảng kê nháp. */
  overageSeats: { label: string; overUnits: number }[];
  fairUseFlagged: boolean;
};

export type AccountHealthInput = {
  accountStatus: string;
  failedJobs: number;
  /** Doanh thu kỳ (`null` = chưa biết / không áp dụng) và lãi gộp — chỉ để nói «khách TRẢ TIỀN mà lỗ». */
  revenueVnd: number | null;
  grossProfitVnd: number | null;
  workspaces: WorkspaceHealthInput[];
};

// ─────────────────────────── Đầu ra ───────────────────────────

export type HealthReason = { code: HealthReasonCode; level: ProblemLevel; workspace: string | null; text: string };
export type HealthGap = { code: HealthGapCode; workspace: string | null; text: string };

export type AiState = "NOT_SUBSCRIBED" | "ON" | "OFF" | "MODULE_OFF" | "LEGACY" | "UNKNOWN";
export const AI_STATE_LABEL: Record<AiState, string> = { NOT_SUBSCRIBED: "Không thuê", ON: "Bật", OFF: "Bị tắt", MODULE_OFF: "Module tắt", LEGACY: "Runtime cũ", UNKNOWN: "—" };

export type ActivityKind = "LOGIN" | "AI_CALL" | "CUSTOMER_MESSAGE";
export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = { LOGIN: "đăng nhập", AI_CALL: "lượt AI", CUSTOMER_MESSAGE: "tin khách" };

/** Sự việc để in (đã chuẩn hoá) — mỗi ô `null` là CHƯA BIẾT, in «—». */
export type WorkspaceFacts = {
  createdAt: Date;
  identities: number | null;
  lastLoginAt: Date | null;
  /** Hoạt động cuối CÓ CHỨNG CỨ: đăng nhập · lượt AI thành công (mốc) · tin khách (ngày). */
  lastActivity: { kind: ActivityKind; at: Date | null; day: string | null } | null;
  messengerPages: number | null;
  fanpagesActive: number | null;
  ledgerCapturedAt: Date | null;
  channelConnectedAt: Date | null;
  ai: { applies: boolean; state: AiState; ok24h: number | null; chatErrors24h: number | null; blocked24h: number | null; lastOkAt: Date | null; lastErrorAt: Date | null; activatedAt: Date | null };
  orders: { lastAiOrderDay: string | null; aiOrders7d: number | null; firstAiOrderAt: Date | null; syncErrors24h: number | null; syncLastErrorAt: Date | null };
  usage: { aiCustomers: number | null; included: number | null | undefined; coverage: MeterCoverage | null; level: UsageAlertLevel | null; pct: number | null; customerMessages7d: number | null; botMessages7d: number | null };
};

export type WorkspaceHealth = { code: string; name: string; isHome: boolean; level: CustomerHealthLevel; reasons: HealthReason[]; gaps: HealthGap[]; facts: WorkspaceFacts };

export type CustomerHealth = {
  level: CustomerHealthLevel;
  /** Lý do cấp TÀI KHOẢN (job cấp phát, lỗ gộp, chưa có workspace). */
  accountReasons: HealthReason[];
  /** Mọi lý do (tài khoản + workspace đang hoạt động), nặng trước. */
  reasons: HealthReason[];
  gaps: HealthGap[];
  workspaces: WorkspaceHealth[];
};

// ─────────────────────────── Tiện ích thuần ───────────────────────────

/** «12 phút» · «5 giờ» · «3 ngày» — tuổi của một mốc so với `now`. */
export function ageText(now: Date, at: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}

/** «08/10» từ ngày `YYYY-MM-DD`. */
export function dayText(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

function startOfVnDay(day: string): Date {
  return new Date(`${day}T00:00:00+07:00`);
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const sortReasons = (rs: HealthReason[]) => [...rs].sort((a, b) => (a.level === b.level ? 0 : a.level === "CRITICAL" ? -1 : 1));
const products = (subs: readonly { productKey: string }[]) => [...new Set(subs.map((s) => PRODUCT_LABEL[s.productKey] ?? s.productKey))].join(", ");

/** Còn trong ân hạn thiết lập (tính từ lúc tạo workspace). */
function inGrace(w: Pick<WorkspaceHealthInput, "createdAt">, now: Date, t: CustomerHealthThresholds): boolean {
  return now.getTime() - w.createdAt.getTime() < t.newWorkspaceGraceHours * HOUR;
}

/** Mức từ lý do + chỗ chưa đo (không xét INACTIVE — người gọi lo). */
function levelOf(reasons: readonly HealthReason[], gaps: readonly HealthGap[]): CustomerHealthLevel {
  if (reasons.some((r) => r.level === "CRITICAL")) return "CRITICAL";
  if (reasons.length) return "NEEDS_ATTENTION";
  if (gaps.length) return "UNKNOWN";
  return "HEALTHY";
}

// ─────────────────────────── Một workspace ───────────────────────────

function emptyFacts(w: WorkspaceHealthInput): WorkspaceFacts {
  return {
    createdAt: w.createdAt,
    identities: w.login?.identities ?? null,
    lastLoginAt: w.login?.lastLoginAt ?? null,
    lastActivity: null,
    messengerPages: w.messengerPages,
    fanpagesActive: null,
    ledgerCapturedAt: null,
    channelConnectedAt: w.milestones?.channelConnectedAt ?? null,
    ai: { applies: false, state: "NOT_SUBSCRIBED", ok24h: null, chatErrors24h: null, blocked24h: null, lastOkAt: null, lastErrorAt: null, activatedAt: w.milestones?.firstAiReplyAt ?? null },
    orders: { lastAiOrderDay: null, aiOrders7d: null, firstAiOrderAt: w.milestones?.firstAiOrderAt ?? null, syncErrors24h: null, syncLastErrorAt: null },
    usage: { aiCustomers: null, included: undefined, coverage: null, level: null, pct: null, customerMessages7d: null, botMessages7d: null },
  };
}

/** Hoạt động cuối có chứng cứ: mốc đăng nhập, mốc lượt AI thành công, ngày gần nhất có tin khách (cận dưới = đầu ngày). */
function lastActivityOf(f: WorkspaceFacts, usage: readonly UsageDaySignal[] | null): WorkspaceFacts["lastActivity"] {
  const cands: { kind: ActivityKind; at: Date | null; day: string | null; t: number }[] = [];
  if (f.lastLoginAt) cands.push({ kind: "LOGIN", at: f.lastLoginAt, day: null, t: f.lastLoginAt.getTime() });
  if (f.ai.lastOkAt) cands.push({ kind: "AI_CALL", at: f.ai.lastOkAt, day: null, t: f.ai.lastOkAt.getTime() });
  const lastMsg = [...(usage ?? [])].sort((a, b) => b.day.localeCompare(a.day)).find((r) => r.customerMessages > 0);
  if (lastMsg) cands.push({ kind: "CUSTOMER_MESSAGE", at: null, day: lastMsg.day, t: startOfVnDay(lastMsg.day).getTime() });
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => (b.t > a.t ? b : a));
  return { kind: best.kind, at: best.at, day: best.day };
}

export function classifyWorkspace(w: WorkspaceHealthInput, now: Date, t: CustomerHealthThresholds = CUSTOMER_HEALTH_THRESHOLDS): WorkspaceHealth {
  const reasons: HealthReason[] = [];
  const gaps: HealthGap[] = [];
  const add = (code: HealthReasonCode, text: string) => reasons.push({ code, level: HEALTH_REASONS[code].level, workspace: w.code, text });
  const gap = (code: HealthGapCode, text?: string) => gaps.push({ code, workspace: w.code, text: text ?? HEALTH_GAPS[code].why });
  const facts = emptyFacts(w);
  const done = (level?: CustomerHealthLevel): WorkspaceHealth => ({ code: w.code, name: w.name, isHome: w.isHome, level: level ?? levelOf(reasons, gaps), reasons: sortReasons(reasons), gaps, facts });

  const live = w.subscriptions.filter((s) => s.status !== "CANCELED");
  const granting = live.filter((s) => subscriptionGrantsUse(s.status));

  // ── Vòng đời workspace.
  if (w.orgStatus === "SETUP_FAILED") {
    add("WORKSPACE_SETUP_FAILED", "Lượt dựng workspace hỏng giữa chừng — khách không đăng nhập được; xử lý ở /platform.");
    return done();
  }
  const inactive =
    w.orgStatus === "ARCHIVED" ||
    (w.orgStatus === "SUSPENDED" && granting.length === 0) ||
    (live.length > 0 && granting.length === 0 && !live.some((s) => s.status === "EXPIRED")) ||
    (live.length === 0 && w.hadEndedSubscriptions);
  if (inactive) {
    facts.lastActivity = lastActivityOf(facts, w.usage);
    return done("INACTIVE");
  }
  if (w.orgStatus === "SUSPENDED") add("WORKSPACE_SUSPENDED", `Workspace đang đình chỉ trong khi còn ${granting.length} thuê bao mở năng lực — khách không vào được; kiểm có đúng chủ ý.`);
  const expired = live.filter((s) => s.status === "EXPIRED");
  if (expired.length) add("SUBSCRIPTION_EXPIRED", `${products(expired)} hết hạn — khách chỉ xem, không ghi được.`);
  const pastDue = live.filter((s) => s.status === "PAST_DUE");
  if (pastDue.length) add("PAST_DUE", `${products(pastDue)} quá hạn thanh toán — đang ân hạn.`);
  if (live.length === 0) add("NO_SUBSCRIPTION", "Workspace đang chạy mà chưa thuê sản phẩm nào.");

  // ── Đăng nhập (mọi sản phẩm).
  if (w.login === null) gap("LOGIN_UNREADABLE");
  else if (w.login.lastLoginAt) {
    const days = (now.getTime() - w.login.lastLoginAt.getTime()) / DAY;
    if (days > t.loginStaleDays) add("LOGIN_STALE", `Không ai đăng nhập ${Math.floor(days)} ngày (lần cuối ${vnShortStamp(w.login.lastLoginAt)}) — mọi phiên đã hết hạn sau ${t.loginStaleDays} ngày, không ai đang dùng.`);
  } else {
    const indexStart = startOfVnDay(IDENTITY_INDEX_SINCE);
    if (w.createdAt.getTime() >= indexStart.getTime()) {
      if (!inGrace(w, now, t)) add("NEVER_LOGGED_IN", `Chưa ai đăng nhập sau ${ageText(now, w.createdAt)} kể từ lúc tạo — gửi lại liên kết kích hoạt.`);
      else gap("NEW_WORKSPACE_PENDING", `Mới tạo ${ageText(now, w.createdAt)} trước, chưa ai đăng nhập — còn trong ân hạn ${t.newWorkspaceGraceHours} giờ.`);
    } else if (now.getTime() - indexStart.getTime() > t.loginStaleDays * DAY) {
      add("LOGIN_STALE", `Không ai đăng nhập từ khi có chỉ mục đăng nhập (${dayText(IDENTITY_INDEX_SINCE)}) — mọi phiên cũ đã hết hạn.`);
    } else {
      gap("LOGIN_BEFORE_INDEX", `Chưa có lần đăng nhập nào trong chỉ mục (ghi từ ${dayText(IDENTITY_INDEX_SINCE)}) — phiên cũ có thể còn hạn tới ${dayText(addDays(IDENTITY_INDEX_SINCE, t.loginStaleDays))}.`);
    }
  }

  // ── Chốt Đơn: AI · kênh · tin khách · đơn · hạn mức.
  const chotdon = granting.some((s) => s.productKey === CHOTDON);
  if (chotdon) evaluateChotdon(w, now, t, facts, add, gap, reasons);
  facts.lastActivity = lastActivityOf(facts, w.usage);
  return done();
}

type Add = (code: HealthReasonCode, text: string) => void;
type Gap = (code: HealthGapCode, text?: string) => void;

function evaluateChotdon(w: WorkspaceHealthInput, now: Date, t: CustomerHealthThresholds, facts: WorkspaceFacts, add: Add, gap: Gap, reasons: readonly HealthReason[]) {
  facts.ai.applies = true;
  const has = (code: HealthReasonCode) => reasons.some((r) => r.code === code);

  // Module + runtime.
  if (w.modules === null) {
    facts.ai.state = "UNKNOWN";
    gap("MODULES_UNREADABLE");
    return;
  }
  if (!w.modules.aiSales && !w.modules.legacyChatbot) {
    facts.ai.state = "MODULE_OFF";
    add("AI_MODULE_OFF", "Thuê Chốt Đơn nhưng module AI bán hàng (ai_sales) đang tắt — bot không chạy.");
    return;
  }
  if (!w.modules.aiSales) {
    facts.ai.state = "LEGACY";
    gap("AI_RUNTIME_LEGACY");
    return;
  }
  facts.ai.state = "ON";

  // Công tắc AI của người vận hành.
  if (w.aiSwitch === null) {
    facts.ai.state = "UNKNOWN";
    gap("AI_SWITCH_UNREADABLE");
  } else if (!w.aiSwitch.platformEnabled) {
    facts.ai.state = "OFF";
    add("AI_OFF", "AI bị tắt TOÀN NỀN TẢNG (công tắc người vận hành) — bot không trả lời khách.");
  } else if (w.aiSwitch.orgDisabled) {
    facts.ai.state = "OFF";
    add("AI_OFF", "AI của workspace này bị người vận hành tắt — bot không trả lời khách.");
  }

  // Sổ AI: lượt trả lời (trừ lượt ghi đơn) + lượt ghi đơn.
  if (w.ai === null) gap("AI_LEDGER_UNREADABLE");
  else evaluateAiLedger(w.ai, t, facts, add);

  // Hạn mức gói (đồng hồ khách AI + ghế) — đọc được cả khi sổ dùng cũ.
  const ac = w.aiCustomers;
  if (ac) {
    facts.usage.aiCustomers = ac.coverage === "NOT_MEASURED" ? null : ac.value;
    facts.usage.included = ac.included;
    facts.usage.coverage = ac.coverage;
    if (ac.coverage !== "NOT_MEASURED" && ac.value !== null) {
      const alert = usageAlert(ac.value, ac.included, ac.alerts);
      facts.usage.level = alert.level;
      facts.usage.pct = alert.pct === null ? null : Math.round(alert.pct);
      // Trả trước theo khách AI: gói gồm 0 khách AI theo THIẾT KẾ (mọi khách trừ Số dư) — «gói không gồm» không phải vượt.
      if (alert.notifyOperator && !(ac.prepaid && alert.level === "NOT_INCLUDED")) {
        const used = `${ac.coverage === "PARTIAL" ? "≥ " : ""}${formatNumber(ac.value)}`;
        const of = ac.included === null || ac.included === undefined ? "" : `/${formatNumber(ac.included)}`;
        add("USAGE_OVER_LIMIT", `Khách AI kỳ này ${used}${of}${facts.usage.pct !== null ? ` (${facts.usage.pct}%)` : ""} — ${USAGE_ALERT_LABEL[alert.level]}.`);
      }
    }
  }
  for (const s of w.overageSeats) add("USAGE_OVER_LIMIT", `${s.label}: vượt ${formatNumber(s.overUnits)} so với gói — đang tính phần vượt.`);
  if (w.fairUseFlagged) add("FAIR_USE", "Vượt mức fair-use (hội thoại / câu AI) — chỉ nhắc, không thu thêm phí.");

  // Sổ dùng theo ngày: kênh · bot im · tin khách dừng · không hoạt động · đơn AI gần nhất.
  if (w.usage === null) return gap("USAGE_LEDGER_UNREADABLE");
  if (w.usage.length === 0) return gap("USAGE_LEDGER_MISSING");
  const rows = [...w.usage].sort((a, b) => a.day.localeCompare(b.day));
  const latest = rows[rows.length - 1];
  const capturedAt = rows.reduce((m, r) => (r.capturedAt > m ? r.capturedAt : m), rows[0].capturedAt);
  facts.ledgerCapturedAt = capturedAt;
  facts.fanpagesActive = latest.fanpagesActive;
  const today = vnDate(now);
  const winFrom = addDays(today, -(t.activityWindowDays - 1));
  const win = rows.filter((r) => r.day >= winFrom);
  const sum = (xs: readonly UsageDaySignal[], k: "customerMessages" | "botMessages" | "aiOrders") => xs.reduce((a, r) => a + r[k], 0);
  // Ngày đã chụp mới tính; cửa sổ chưa có ngày nào ⇒ chưa biết.
  facts.usage.customerMessages7d = win.length ? sum(win, "customerMessages") : null;
  facts.usage.botMessages7d = win.length ? sum(win, "botMessages") : null;
  facts.orders.aiOrders7d = win.length ? sum(win, "aiOrders") : null;
  facts.orders.lastAiOrderDay = [...rows].reverse().find((r) => r.aiOrders > 0)?.day ?? null;

  if (now.getTime() - capturedAt.getTime() > t.usageLedgerFreshHours * HOUR) {
    gap("USAGE_LEDGER_STALE", `Sổ dùng chụp lần cuối ${vnShortStamp(capturedAt)} (quá ${t.usageLedgerFreshHours} giờ) — kênh, tin khách, đơn AI chưa cập nhật.`);
    return;
  }

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const recentDays = Array.from({ length: t.inboundDropDays }, (_, i) => addDays(today, -i));
  const recent = recentDays.map((d) => byDay.get(d));
  const custRecent = recent.every((r) => r !== undefined) ? recent.reduce((a, r) => a + (r?.customerMessages ?? 0), 0) : null;
  const cust7 = facts.usage.customerMessages7d;

  // Kênh: 0 = KHÔNG fanpage / kết nối kênh bán nào đang bật (null = chỉ có kết nối đơn cũ, chưa đếm được page — không kết luận).
  // Web chat / Zalo OA không nằm trong số đếm này ⇒ chỉ kết luận «mất kênh» khi tin khách CŨNG dừng.
  let channelExplained = false;
  if (latest.fanpagesActive === 0) {
    const hadChannel = (w.milestones?.channelConnectedAt ?? null) !== null || (w.messengerPages ?? 0) > 0 || rows.some((r) => (r.fanpagesActive ?? 0) > 0);
    const since = w.milestones?.channelConnectedAt ? ` (từng nối ${vnShortStamp(w.milestones.channelConnectedAt).slice(0, 5)})` : "";
    const where = `0 fanpage / kết nối kênh bán đang bật (sổ dùng ${vnShortStamp(latest.capturedAt)})${since}`;
    if (hadChannel && custRecent === 0) {
      channelExplained = true;
      add("CHANNEL_LOST", `${where} và không có tin khách ${t.inboundDropDays} ngày — bot không nhận được khách nào.`);
    } else if (hadChannel) {
      add("FANPAGE_OFF", custRecent === null ? `${where} — sổ dùng chưa đủ ngày để biết khách còn nhắn qua kênh khác không.` : `${where} — khách còn nhắn ${formatNumber(custRecent)} tin ${t.inboundDropDays} ngày qua kênh khác (web / Zalo).`);
    } else if (w.milestones === null) {
      gap("MILESTONES_UNREADABLE");
    } else if (cust7 === 0) {
      channelExplained = true;
      if (inGrace(w, now, t)) gap("NEW_WORKSPACE_PENDING", `Mới tạo ${ageText(now, w.createdAt)} trước, chưa nối fanpage / Messenger — còn trong ân hạn ${t.newWorkspaceGraceHours} giờ.`);
      else add("NO_CHANNEL", "Chưa nối fanpage / Messenger nào và chưa có tin khách — bot chưa nhận được khách.");
    }
  }

  // Bot im: một ngày (hôm nay / hôm qua) có ≥ N tin khách mà 0 tin bot, trong khi 7 ngày trước đó bot vẫn trả lời. AI bị tắt /
  // đang lỗi đã giải thích sự im lặng ⇒ không nhắc lại.
  if (!has("AI_OFF") && !has("AI_FAILING")) {
    for (const d of recentDays) {
      const r = byDay.get(d);
      if (!r || r.customerMessages < t.aiSilentMinCustomerMessages || r.botMessages > 0) continue;
      const botBefore = rows.some((x) => x.day < d && x.day >= addDays(d, -t.activityWindowDays) && x.botMessages > 0);
      if (!botBefore) continue;
      add("AI_SILENT", `Ngày ${dayText(d)}: khách nhắn ${formatNumber(r.customerMessages)} tin, bot gửi 0 tin (7 ngày trước đó bot vẫn trả lời) — nếu không cố ý tắt bot thì kiểm ngay.`);
      break;
    }
  }

  // Tin khách dừng: nền trung vị theo ngày (≥ N ngày đã chụp) đủ lớn mà các ngày gần nhất đều 0 (luật 52 — không nền thì không kết luận).
  let inboundDrop = false;
  if (!channelExplained && custRecent === 0) {
    const baseTo = addDays(today, -t.inboundDropDays);
    const baseFrom = addDays(baseTo, -(t.activityWindowDays - 1));
    const base = rows.filter((r) => r.day >= baseFrom && r.day <= baseTo).map((r) => r.customerMessages);
    if (base.length >= t.inboundBaselineMinDays) {
      const med = median(base);
      if (med >= t.inboundBaselineMinPerDay) {
        inboundDrop = true;
        add("INBOUND_DROP", `Không có tin khách ${t.inboundDropDays} ngày gần nhất (bình thường ~${formatNumber(Math.round(med))} tin / ngày) — kiểm kết nối page / webhook.`);
      }
    }
  }

  if (channelExplained || inboundDrop) return;
  // Chưa kích hoạt: AI CHƯA TỪNG trả lời một khách thật (mốc FIRST_AI_REPLY) và 7 ngày không lượt AI thành công nào (mốc chưa quét
  // kịp mà sổ AI đã có lượt thành công thì là đã chạy). Trong ân hạn ⇒ đang thiết lập.
  const neverActivated = w.milestones !== null && w.milestones.firstAiReplyAt === null && w.ai !== null && w.ai.ok7d === 0;
  if (neverActivated) {
    if (inGrace(w, now, t)) gap("NEW_WORKSPACE_PENDING", `Mới tạo ${ageText(now, w.createdAt)} trước, AI chưa trả lời khách thật nào — còn trong ân hạn ${t.newWorkspaceGraceHours} giờ.`);
    else add("NOT_ACTIVATED", `AI chưa trả lời khách thật nào sau ${ageText(now, w.createdAt)} kể từ lúc tạo — khách chưa chạy được sản phẩm.`);
    return;
  }
  // Không hoạt động: đã từng chạy, đủ tuổi, cửa sổ đã chụp đủ ngày, 0 tin khách và 0 lượt AI thành công.
  const ageDays = (now.getTime() - w.createdAt.getTime()) / DAY;
  if (ageDays >= t.activityWindowDays && win.length >= t.inboundBaselineMinDays && cust7 === 0 && w.ai !== null && w.ai.ok7d === 0) {
    add("NO_ACTIVITY", `Không có tin khách và không có lượt AI thành công nào ${t.activityWindowDays} ngày.`);
  }
}

function evaluateAiLedger(a: AiLedgerSignal, t: CustomerHealthThresholds, facts: WorkspaceFacts, add: Add) {
  // Lượt ghi đơn cũng là lượt `sales_chatbot` (ref `order-sync:`) ⇒ lỗi TRẢ LỜI = tổng lỗi − lỗi ghi đơn (hai lý do, không đếm đôi).
  const chatErrors24h = Math.max(0, a.errors24h - a.orderSyncErrors24h);
  const chatErrorsWin = Math.max(0, a.errorsInWindow - a.orderSyncErrorsInWindow);
  facts.ai.ok24h = a.ok24h;
  facts.ai.chatErrors24h = chatErrors24h;
  facts.ai.blocked24h = a.blocked24h;
  facts.ai.lastOkAt = a.lastOkAt;
  facts.ai.lastErrorAt = a.lastErrorAt;
  facts.orders.syncErrors24h = a.orderSyncErrors24h;
  facts.orders.syncLastErrorAt = a.orderSyncLastErrorAt;

  const notRecovered = a.lastErrorAt !== null && (a.lastOkAt === null || a.lastErrorAt.getTime() > a.lastOkAt.getTime());
  const burst = chatErrorsWin + a.blockedInWindow;
  if (notRecovered && burst >= t.aiFailBurst) {
    const what = a.blockedInWindow > chatErrorsWin ? `bị chặn vì hạn mức ${formatNumber(a.blockedInWindow)}` : `lỗi ${formatNumber(chatErrorsWin)}`;
    add("AI_FAILING", `AI ${what} lượt trong ${t.aiFailWindowMinutes} phút, chưa lượt nào thành công sau lượt hỏng cuối ${vnShortStamp(a.lastErrorAt)} — khách không được trả lời.`);
  } else {
    const total = a.ok24h + chatErrors24h;
    if (chatErrors24h > 0 && notRecovered) add("AI_ERRORS_RECENT", `AI lỗi ${formatNumber(chatErrors24h)} lượt trong 24 giờ, chưa thấy lượt thành công sau lượt hỏng cuối ${vnShortStamp(a.lastErrorAt)}.`);
    else if (total >= t.aiErrorRateMinSample && chatErrors24h * 100 >= t.aiErrorRateAttentionPct * total) add("AI_ERRORS_RECENT", `AI lỗi ${formatNumber(chatErrors24h)}/${formatNumber(total)} lượt trong 24 giờ (${Math.round((chatErrors24h * 100) / total)}%).`);
    if (a.blocked24h > 0) add("AI_BLOCKED_QUOTA", `${formatNumber(a.blocked24h)} lượt AI bị chặn vì hạn mức trong 24 giờ — khách của các lượt đó không được AI trả lời.`);
  }

  const syncNotRecovered = a.orderSyncLastErrorAt !== null && (a.orderSyncLastOkAt === null || a.orderSyncLastErrorAt.getTime() > a.orderSyncLastOkAt.getTime());
  if (syncNotRecovered && a.orderSyncErrorsInWindow >= t.aiFailBurst) {
    add("ORDER_SYNC_FAILING", `Ghi đơn từ hội thoại lỗi ${formatNumber(a.orderSyncErrorsInWindow)} lượt trong ${t.aiFailWindowMinutes} phút, chưa lượt nào thành công sau lỗi cuối ${vnShortStamp(a.orderSyncLastErrorAt)} — đơn có thể bị sót.`);
  } else if (a.orderSyncErrors24h > 0) {
    add("ORDER_SYNC_ERRORS", `Ghi đơn từ hội thoại lỗi ${formatNumber(a.orderSyncErrors24h)} lượt trong 24 giờ${syncNotRecovered ? `, chưa thấy lượt thành công sau lỗi cuối ${vnShortStamp(a.orderSyncLastErrorAt)}` : " (đã có lượt thành công sau đó)"}.`);
  }
}

// ─────────────────────────── Một tài khoản ───────────────────────────

/**
 * Mức của tài khoản = mức nặng nhất của lý do cấp tài khoản + workspace ĐANG HOẠT ĐỘNG. Tài khoản đóng / tạm dừng, hoặc mọi
 * workspace đã dừng (và không lý do cấp tài khoản nào) ⇒ «Đã dừng».
 */
export function classifyCustomer(a: AccountHealthInput, now: Date, t: CustomerHealthThresholds = CUSTOMER_HEALTH_THRESHOLDS): CustomerHealth {
  const computed = a.workspaces.map((w) => classifyWorkspace(w, now, t));
  if (a.accountStatus === "CLOSED" || a.accountStatus === "SUSPENDED") {
    const workspaces = computed.map((w) => ({ ...w, level: "INACTIVE" as const, reasons: [], gaps: [] }));
    return { level: "INACTIVE", accountReasons: [], reasons: [], gaps: [], workspaces };
  }
  const accountReasons: HealthReason[] = [];
  const add = (code: HealthReasonCode, text: string) => accountReasons.push({ code, level: HEALTH_REASONS[code].level, workspace: null, text });
  if (a.failedJobs > 0) add("PROVISIONING_FAILED", `${formatNumber(a.failedJobs)} job cấp phát hỏng — mở trang khách, bấm chạy lại.`);
  if (a.workspaces.length === 0) add("NO_WORKSPACE", "Tài khoản chưa có workspace nào.");
  // Chỉ khách TRẢ TIỀN trong kỳ: dùng thử / miễn phí lỗ gộp là đúng thiết kế, không phải việc cần xem.
  if (a.revenueVnd !== null && a.revenueVnd > 0 && a.grossProfitVnd !== null && a.grossProfitVnd < 0) add("LOSING_MONEY", `Lỗ gộp kỳ này ${formatVND(a.grossProfitVnd)} trên doanh thu ${formatVND(a.revenueVnd)}.`);
  const active = computed.filter((w) => w.level !== "INACTIVE");
  const reasons = sortReasons([...accountReasons, ...active.flatMap((w) => w.reasons)]);
  const gaps = active.flatMap((w) => w.gaps);
  const allStopped = computed.length > 0 && active.length === 0;
  const level = allStopped && !accountReasons.length ? "INACTIVE" : levelOf(reasons, gaps);
  const workspaces = [...computed].sort((x, y) => CUSTOMER_HEALTH_RANK[x.level] - CUSTOMER_HEALTH_RANK[y.level] || x.code.localeCompare(y.code));
  return { level, accountReasons: sortReasons(accountReasons), reasons, gaps, workspaces };
}
