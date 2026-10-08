/**
 * ═══════════ PHÂN LOẠI SỨC KHOẺ KHÁCH — HÀM THUẦN (mức · lý do · chỗ chưa đo · sự việc để in) ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ (`now` truyền vào), chạy hai lần ra MỘT kết quả. Đầu vào dựng ở
 * `lib/saas/customer-signals.ts` (một lượt gom, chỉ CSDL nhà — không mở CSDL tổ chức nào); mức, lý do, ngưỡng khai ở
 * `lib/constants/customer-health.ts`.
 *
 * Ba luật chạy xuyên tệp:
 *  · MỘT LÝ DO = MỘT SỰ VIỆC có số / mốc / nguồn. Mức = mức nặng nhất (không cộng, không trọng số — §7 spec SaaS).
 *  · THIẾU ≠ KHOẺ: tín hiệu bắt buộc không đọc được — hoặc đọc được mà CHƯA ĐỦ để kết luận — là một CHỖ CHƯA ĐO; không lý do + có
 *    chỗ chưa đo ⇒ «Chưa đủ dữ liệu». Mọi nhánh «không kết luận được» đều phải để lại chỗ chưa đo, không được im lặng thành «Khoẻ».
 *  · KHÔNG KẾT LUẬN KHI KHÔNG CÓ CHỨNG CỨ: vắng dòng đăng nhập trước khi có chỉ mục, ngày sổ dùng chưa chụp, nền tin khách dưới
 *    số ngày tối thiểu — đều là «chưa biết», không phải 0 (luật 42 · 52).
 *
 * Tín hiệu AI / kênh / tin khách / đơn chỉ áp dụng cho workspace THUÊ Chốt Đơn (thuê bao đang mở năng lực). ERP: CSDL nhà chỉ
 * thấy được đăng nhập — việc dùng ERP sâu (đơn, kho…) nằm trong CSDL của khách, màn danh sách không mở (xem `/platform/org/<mã>`).
 * Câu chữ (`text` · `short`) là chữ thường cho người vận hành — tên bảng, tên tệp, nguồn kỹ thuật chỉ nằm ở `source` của bảng khai.
 */
import { addDays, vnDate } from "@/lib/billing/rules";
import { CUSTOMER_HEALTH_RANK, CUSTOMER_HEALTH_THRESHOLDS, HEALTH_GAPS, HEALTH_REASONS, IDENTITY_INDEX_SINCE, type CustomerHealthLevel, type CustomerHealthThresholds, type HealthGapCode, type HealthReasonCode, type ProblemLevel } from "@/lib/constants/customer-health";
import { formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { DEFAULT_USAGE_ALERTS, USAGE_ALERT_LABEL, usageAlert, type MeterCoverage, type UsageAlertConfig, type UsageAlertLevel } from "@/lib/pricing/versions";
import type { ActivationState } from "@/lib/saas/activation";
import { PRODUCT_LABEL } from "@/lib/saas/catalog";
import { losingMoneyApplies, subscriptionGrantsUse, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

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
  /** Riêng lượt TRẢ LỜI (không gồm lượt đọc hội thoại để ghi đơn hộ) — mốc phục hồi của «AI đang lỗi» đọc ở đây. */
  chatLastOkAt: Date | null;
  chatLastErrorAt: Date | null;
  chatOk24h: number;
  /** Lượt TRẢ LỜI OK 7 ngày (không gồm lượt ghi đơn hộ) — «bot có đang trả lời không» đọc ở đây, không đọc `ok7d`. */
  chatOk7d: number;
};

/** Trạng thái kích hoạt quản trị khách đã nạp (lib/saas/activation.ts) — chỉ các trường lời khuyên cần. */
export type ActivationSignal = { state: ActivationState; activatedAt: string | null; linkExpiresAt: string | null };

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
  /**
   * Workspace đã từng có hoá đơn ĐÃ THU — phân biệt «hết hạn sau khi đã trả tiền» (Nguy cấp) với «dùng thử hết hạn, chưa trả lần
   * nào» (Đã dừng). `null` = không đọc được ⇒ không chứng minh được là dùng thử ⇒ giữ Nguy cấp.
   */
  everPaid: boolean | null;
  /** `null` = không đọc được. */
  modules: { aiSales: boolean; legacyChatbot: boolean } | null;
  login: { identities: number; lastLoginAt: Date | null } | null;
  /**
   * Trạng thái kích hoạt quản trị khách — CHỈ trang một khách nạp (đọc CSDL của khách; danh sách không mở CSDL tổ chức nào).
   * `undefined` = không nạp (danh sách) ⇒ lời khuyên trung tính; `null` = không áp dụng (workspace nhà).
   */
  activation?: ActivationSignal | null;
  /** Page Messenger nối thẳng trong chỉ mục nền tảng. `null` = không đọc được. */
  messengerPages: number | null;
  aiSwitch: { platformEnabled: boolean; orgDisabled: boolean } | null;
  ai: AiLedgerSignal | null;
  /** `null` = không đọc được; `[]` = đọc được, chưa có ngày nào. */
  usage: UsageDaySignal[] | null;
  /** `null` = không đọc được mốc kích hoạt. */
  milestones: { channelConnectedAt: Date | null; firstAiReplyAt: Date | null; firstAiOrderAt: Date | null } | null;
  /**
   * Đồng hồ khách AI của kỳ + phần gồm của gói (phiên bản đã ghim) + ngưỡng cảnh báo của phiên bản. `null` = không có số đồng hồ;
   * `alerts: null` = không đọc được ngưỡng của bảng giá.
   */
  aiCustomers: { value: number | null; coverage: MeterCoverage; included: number | null | undefined; alerts: UsageAlertConfig | null; prepaid: boolean } | null;
  /** Khách AI của kỳ theo kênh (`FANPAGE` · `ZALO` · `WEB`) — chỉ để in. `null` = chưa đo; `{}` = đo được, chưa có khách nào. */
  aiCustomerChannels?: Record<string, number> | null;
  /** Hội thoại mới của CÙNG kỳ với đồng hồ khách AI — chỉ để in. `null` = chưa đo. */
  periodConversations?: number | null;
  /** Dòng vượt ghế (fanpage / người dùng) ĐÃ BIẾT > 0 của bảng kê nháp. */
  overageSeats: { label: string; overUnits: number }[];
  fairUseFlagged: boolean;
};

export type AccountHealthInput = {
  accountStatus: string;
  /** Job cấp phát cần người: hỏng + chưa cài được mẫu (`templatePendingJobs` là phần sau). */
  failedJobs: number;
  templatePendingJobs?: number;
  /** Doanh thu kỳ (`null` = chưa biết / không áp dụng) và lãi gộp — chỉ để nói «khách TRẢ TIỀN mà lỗ» (`losingMoneyApplies`). */
  revenueVnd: number | null;
  grossProfitVnd: number | null;
  workspaces: WorkspaceHealthInput[];
};

// ─────────────────────────── Đầu ra ───────────────────────────

/** `short` = bằng chứng gọn (con số / mốc) in cạnh nhãn trong ô bảng; `text` = câu đầy đủ (rê chuột, trang chi tiết). */
export type HealthReason = { code: HealthReasonCode; level: ProblemLevel; workspace: string | null; short: string; text: string };
export type HealthGap = { code: HealthGapCode; workspace: string | null; text: string };

export type AiState = "NOT_SUBSCRIBED" | "ON" | "OFF" | "MODULE_OFF" | "LEGACY" | "UNKNOWN";
export const AI_STATE_LABEL: Record<AiState, string> = { NOT_SUBSCRIBED: "Không thuê", ON: "Bật", OFF: "Bị tắt", MODULE_OFF: "Module tắt", LEGACY: "Bot đời cũ", UNKNOWN: "—" };

/** Kênh của khách AI (`sales_chat_conversations.channel` mà điểm gửi ghi vào sổ dùng chung). Fanpage gồm cả Pancake lẫn Messenger nối thẳng. */
export const AI_CHANNEL_LABEL: Record<string, string> = { FANPAGE: "Fanpage", ZALO: "Zalo", WEB: "Web" };

export type ActivityKind = "LOGIN" | "AI_CALL" | "CUSTOMER_MESSAGE";
export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = { LOGIN: "đăng nhập", AI_CALL: "AI trả lời", CUSTOMER_MESSAGE: "tin khách" };

/** Sự việc để in (đã chuẩn hoá) — mỗi ô `null` là CHƯA BIẾT, in «—». */
export type WorkspaceFacts = {
  createdAt: Date;
  identities: number | null;
  lastLoginAt: Date | null;
  /** Hoạt động cuối CÓ CHỨNG CỨ: đăng nhập · AI trả lời thành công (mốc) · tin khách (ngày). */
  lastActivity: { kind: ActivityKind; at: Date | null; day: string | null } | null;
  messengerPages: number | null;
  fanpagesActive: number | null;
  ledgerCapturedAt: Date | null;
  channelConnectedAt: Date | null;
  /** Khách AI của kỳ theo kênh, nhiều trước. `null` = chưa đo. */
  aiCustomerChannels: { channel: string; customers: number }[] | null;
  /** Lượt TRẢ LỜI (không gồm lượt đọc hội thoại để ghi đơn hộ). */
  ai: { applies: boolean; state: AiState; ok24h: number | null; chatErrors24h: number | null; blocked24h: number | null; lastOkAt: Date | null; lastErrorAt: Date | null; activatedAt: Date | null };
  orders: { lastAiOrderDay: string | null; aiOrders7d: number | null; firstAiOrderAt: Date | null; syncErrors24h: number | null; syncLastErrorAt: Date | null };
  usage: {
    aiCustomers: number | null;
    included: number | null | undefined;
    coverage: MeterCoverage | null;
    level: UsageAlertLevel | null;
    pct: number | null;
    conversations: number | null;
    customerMessages7d: number | null;
    botMessages7d: number | null;
  };
};

export type WorkspaceHealth = {
  code: string;
  name: string;
  isHome: boolean;
  level: CustomerHealthLevel;
  /** Vì sao «Đã dừng» (một câu thường) — chỉ khi mức là INACTIVE. */
  inactiveReason: string | null;
  reasons: HealthReason[];
  gaps: HealthGap[];
  facts: WorkspaceFacts;
};

export type CustomerHealth = {
  level: CustomerHealthLevel;
  /** Vì sao cả tài khoản «Đã dừng» — chỉ khi mức là INACTIVE. */
  inactiveReason: string | null;
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

const sortReasons = (rs: readonly HealthReason[]) => [...rs].sort((a, b) => (a.level === b.level ? 0 : a.level === "CRITICAL" ? -1 : 1));
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

/**
 * Mức của MỘT dòng bảng = mức nặng nhất giữa mức của workspace và lý do cấp tài khoản in trên CÙNG dòng đó — nhãn của dòng không
 * bao giờ nhẹ hơn lý do nó đang in (một dòng «Khoẻ» kèm «Job cấp phát hỏng» là tự mâu thuẫn).
 */
export function rowLevel(workspaceLevel: CustomerHealthLevel, extraReasons: readonly HealthReason[]): CustomerHealthLevel {
  if (extraReasons.some((r) => r.level === "CRITICAL")) return "CRITICAL";
  if (extraReasons.length && CUSTOMER_HEALTH_RANK[workspaceLevel] > CUSTOMER_HEALTH_RANK.NEEDS_ATTENTION) return "NEEDS_ATTENTION";
  return workspaceLevel;
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
    aiCustomerChannels: w.aiCustomerChannels
      ? Object.entries(w.aiCustomerChannels)
          .map(([channel, customers]) => ({ channel, customers }))
          .sort((a, b) => b.customers - a.customers || a.channel.localeCompare(b.channel))
      : null,
    ai: { applies: false, state: "NOT_SUBSCRIBED", ok24h: null, chatErrors24h: null, blocked24h: null, lastOkAt: null, lastErrorAt: null, activatedAt: w.milestones?.firstAiReplyAt ?? null },
    orders: { lastAiOrderDay: null, aiOrders7d: null, firstAiOrderAt: w.milestones?.firstAiOrderAt ?? null, syncErrors24h: null, syncLastErrorAt: null },
    usage: { aiCustomers: null, included: undefined, coverage: null, level: null, pct: null, conversations: w.periodConversations ?? null, customerMessages7d: null, botMessages7d: null },
  };
}

/** Hoạt động cuối có chứng cứ: mốc đăng nhập, mốc AI trả lời thành công, ngày gần nhất có tin khách (cận dưới = đầu ngày). */
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

/**
 * Câu «chưa ai đăng nhập» theo trạng thái kích hoạt của quản trị khách: chưa kích hoạt ⇒ gửi lại liên kết; đã kích hoạt ⇒ nhắc
 * đăng nhập bằng email. Danh sách không nạp trạng thái (không mở CSDL khách) ⇒ lời khuyên trung tính, không đoán.
 */
function neverLoggedInText(w: WorkspaceHealthInput, now: Date): { short: string; text: string } {
  const age = ageText(now, w.createdAt);
  const head = `Chưa ai đăng nhập sau ${age} kể từ lúc tạo`;
  const a = w.activation;
  if (a === undefined) return { short: `${age} từ lúc tạo`, text: `${head} — mở trang khách xem trạng thái kích hoạt để gửi lại liên kết hoặc nhắc khách đăng nhập.` };
  if (a === null) return { short: `${age} từ lúc tạo`, text: `${head}.` };
  switch (a.state) {
    case "ACTIVATED":
      return { short: "đã kích hoạt, chưa đăng nhập", text: `Quản trị đã kích hoạt${a.activatedAt ? ` (${vnShortStamp(a.activatedAt)})` : ""} nhưng chưa thấy lần đăng nhập nào bằng email sau ${age} — nhắc khách đăng nhập bằng email + mật khẩu.` };
    case "PENDING":
      return { short: "chưa kích hoạt, liên kết còn hạn", text: `${head}: liên kết kích hoạt còn hạn${a.linkExpiresAt ? ` tới ${vnShortStamp(a.linkExpiresAt)}` : ""} mà khách chưa bấm — gửi lại liên kết kích hoạt nếu khách không nhận được.` };
    case "EXPIRED":
      return { short: "liên kết kích hoạt đã hết hạn", text: `${head}: liên kết kích hoạt đã hết hạn — gửi lại liên kết kích hoạt.` };
    case "NO_LINK":
      return { short: "chưa kích hoạt, không còn liên kết", text: `${head}: không còn liên kết kích hoạt dùng được — gửi lại liên kết kích hoạt.` };
    case "NO_ADMIN":
      return { short: "chưa có tài khoản quản trị", text: `${head}: workspace chưa có tài khoản quản trị — chạy lại job cấp phát.` };
    case "DISABLED":
      return { short: "tài khoản quản trị đang khoá", text: `${head}: tài khoản quản trị đang khoá — mở khoá trước rồi mới gửi kích hoạt.` };
    default:
      return { short: `${age} từ lúc tạo`, text: `${head} — chưa đọc được trạng thái kích hoạt của quản trị (thử tải lại trang).` };
  }
}

type Add = (code: HealthReasonCode, short: string, text: string) => void;
type Gap = (code: HealthGapCode, text?: string) => void;

export function classifyWorkspace(w: WorkspaceHealthInput, now: Date, t: CustomerHealthThresholds = CUSTOMER_HEALTH_THRESHOLDS): WorkspaceHealth {
  const reasons: HealthReason[] = [];
  const gaps: HealthGap[] = [];
  const add: Add = (code, short, text) => reasons.push({ code, level: HEALTH_REASONS[code].level, workspace: w.code, short, text });
  // Một mã chỗ chưa đo một lần (câu đầu tiên thắng) — «đang thiết lập» có thể đến từ nhiều bước nên được nói đủ.
  const gap: Gap = (code, text) => {
    if (code !== "NEW_WORKSPACE_PENDING" && gaps.some((g) => g.code === code)) return;
    gaps.push({ code, workspace: w.code, text: text ?? HEALTH_GAPS[code].why });
  };
  const facts = emptyFacts(w);
  const done = (level?: CustomerHealthLevel, inactiveReason: string | null = null): WorkspaceHealth => ({ code: w.code, name: w.name, isHome: w.isHome, level: level ?? levelOf(reasons, gaps), inactiveReason, reasons: sortReasons(reasons), gaps, facts });

  const live = w.subscriptions.filter((s) => s.status !== "CANCELED");
  const granting = live.filter((s) => subscriptionGrantsUse(s.status));
  const expired = live.filter((s) => s.status === "EXPIRED");

  // ── Vòng đời workspace.
  if (w.orgStatus === "SETUP_FAILED") {
    add("WORKSPACE_SETUP_FAILED", "khách chưa vào được", "Lượt dựng workspace hỏng giữa chừng — khách không đăng nhập được; xử lý ở trang Vận hành nền tảng.");
    return done();
  }
  // Đã dừng do người / do khách quyết: lưu trữ · đình chỉ hết năng lực · dùng thử hết hạn mà CHƯA TỪNG trả tiền (khách dừng, sản
  // phẩm không hỏng — không đọc được sổ hoá đơn ⇒ không chứng minh được là dùng thử ⇒ giữ «Hết hạn — chỉ xem», Nguy cấp) · mọi
  // thuê bao tạm dừng · đã huỷ hết.
  const inactiveReason =
    w.orgStatus === "ARCHIVED"
      ? "Workspace đã lưu trữ."
      : w.orgStatus === "SUSPENDED" && granting.length === 0
        ? "Workspace đình chỉ, không còn thuê bao mở năng lực."
        : live.length > 0 && granting.length === 0 && expired.length > 0 && w.everPaid === false
          ? "Dùng thử đã hết hạn, chưa trả tiền lần nào."
          : live.length > 0 && granting.length === 0 && expired.length === 0
            ? "Mọi thuê bao đang tạm dừng."
            : live.length === 0 && w.hadEndedSubscriptions
              ? "Đã huỷ mọi thuê bao."
              : null;
  if (inactiveReason) {
    facts.lastActivity = lastActivityOf(facts, w.usage);
    return done("INACTIVE", inactiveReason);
  }
  if (w.orgStatus === "SUSPENDED") add("WORKSPACE_SUSPENDED", `còn ${granting.length} thuê bao mở`, `Workspace đang đình chỉ trong khi còn ${granting.length} thuê bao mở năng lực — khách không vào được; kiểm có đúng chủ ý.`);
  if (expired.length) add("SUBSCRIPTION_EXPIRED", products(expired), `${products(expired)} hết hạn — khách chỉ xem, không ghi được.`);
  const pastDue = live.filter((s) => s.status === "PAST_DUE");
  if (pastDue.length) add("PAST_DUE", `${products(pastDue)} · đang ân hạn`, `${products(pastDue)} quá hạn thanh toán — đang ân hạn.`);
  if (live.length === 0) add("NO_SUBSCRIPTION", "workspace chạy không thuê bao", "Workspace đang chạy mà chưa thuê sản phẩm nào.");

  // ── Đăng nhập (mọi sản phẩm).
  if (w.login === null) gap("LOGIN_UNREADABLE");
  else if (w.login.lastLoginAt) {
    const days = (now.getTime() - w.login.lastLoginAt.getTime()) / DAY;
    if (days > t.loginStaleDays) add("LOGIN_STALE", `${Math.floor(days)} ngày`, `Không ai đăng nhập ${Math.floor(days)} ngày (lần cuối ${vnShortStamp(w.login.lastLoginAt)}) — mọi phiên đã hết hạn sau ${t.loginStaleDays} ngày, không ai đang dùng.`);
  } else {
    const indexStart = startOfVnDay(IDENTITY_INDEX_SINCE);
    if (w.createdAt.getTime() >= indexStart.getTime()) {
      if (!inGrace(w, now, t)) {
        const m = neverLoggedInText(w, now);
        add("NEVER_LOGGED_IN", m.short, m.text);
      } else gap("NEW_WORKSPACE_PENDING", `Mới tạo ${ageText(now, w.createdAt)} trước, chưa ai đăng nhập — còn trong ân hạn ${t.newWorkspaceGraceHours} giờ.`);
    } else if (now.getTime() - indexStart.getTime() > t.loginStaleDays * DAY) {
      add("LOGIN_STALE", `từ ${dayText(IDENTITY_INDEX_SINCE)}`, `Không ai đăng nhập từ khi hệ thống bắt đầu ghi lần đăng nhập (${dayText(IDENTITY_INDEX_SINCE)}) — mọi phiên cũ đã hết hạn.`);
    } else {
      gap("LOGIN_BEFORE_INDEX", `Chưa có lần đăng nhập nào kể từ khi hệ thống bắt đầu ghi (${dayText(IDENTITY_INDEX_SINCE)}) — phiên cũ có thể còn hạn tới ${dayText(addDays(IDENTITY_INDEX_SINCE, t.loginStaleDays))}.`);
    }
  }

  // ── Chốt Đơn: hạn mức · AI · kênh · tin khách · đơn.
  if (granting.some((s) => s.productKey === CHOTDON)) evaluateChotdon(w, now, t, facts, add, gap, reasons);
  facts.lastActivity = lastActivityOf(facts, w.usage);
  return done();
}

/** Hạn mức gói: đồng hồ khách AI so với phần gồm (ngưỡng cảnh báo của phiên bản giá) + phần vượt ghế + fair-use. */
function evaluateUsageLimit(w: WorkspaceHealthInput, facts: WorkspaceFacts, add: Add, gap: Gap) {
  const ac = w.aiCustomers;
  if (!ac) gap("USAGE_METER_UNMEASURED");
  else {
    const value = ac.coverage !== "NOT_MEASURED" ? ac.value : null;
    facts.usage.aiCustomers = value;
    facts.usage.included = ac.included;
    facts.usage.coverage = ac.coverage;
    // Có TRẦN để chạm khi gói khai một số khách AI — trừ trả trước theo khách AI (gồm 0 theo THIẾT KẾ: mọi khách trừ Số dư, nên
    // «gói không gồm» không phải vượt). Gói không khai / không giới hạn ⇒ không có gì để chạm ⇒ đồng hồ không bắt buộc (N/A).
    const hasCeiling = typeof ac.included === "number" && !(ac.prepaid && ac.included === 0);
    if (hasCeiling && (value === null || ac.alerts === null)) gap("USAGE_METER_UNMEASURED");
    else {
      const alert = usageAlert(value, ac.included, ac.alerts ?? DEFAULT_USAGE_ALERTS);
      facts.usage.level = alert.level;
      facts.usage.pct = alert.pct === null ? null : Math.round(alert.pct);
      if (hasCeiling && value !== null && alert.notifyOperator) {
        const used = `${ac.coverage === "PARTIAL" ? "≥ " : ""}${formatNumber(value)}`;
        if (alert.level === "NOT_INCLUDED") add("USAGE_OVER_LIMIT", `gói không gồm · ${used} khách`, `Gói không gồm khách AI mà kỳ này đã có ${used} khách AI — ${USAGE_ALERT_LABEL[alert.level]}.`);
        else {
          const ratio = `${used}/${formatNumber(ac.included)}${facts.usage.pct !== null ? ` (${facts.usage.pct}%)` : ""}`;
          // ≥ ngưỡng báo (80%) nhưng chưa quá phần gồm là SẮP chạm — không gọi là «vượt».
          add(alert.level === "NOTIFY" ? "USAGE_NEAR_LIMIT" : "USAGE_OVER_LIMIT", ratio, `Khách AI kỳ này ${ratio} — ${USAGE_ALERT_LABEL[alert.level]}.`);
        }
      }
    }
  }
  for (const s of w.overageSeats) add("USAGE_OVER_LIMIT", `${s.label.toLowerCase()} +${formatNumber(s.overUnits)}`, `${s.label}: vượt ${formatNumber(s.overUnits)} so với gói — đang tính phần vượt.`);
  if (w.fairUseFlagged) add("FAIR_USE", "hội thoại / câu AI", "Vượt mức fair-use (hội thoại / câu AI) — chỉ nhắc, không thu thêm phí.");
}

/** Sự việc của sổ dùng (để in) — điền cho mọi workspace Chốt Đơn đọc được sổ, kể cả khi AI không chạy. Trả các ngày của cửa sổ. */
function fillLedgerFacts(rows: readonly UsageDaySignal[], today: string, t: CustomerHealthThresholds, facts: WorkspaceFacts): readonly UsageDaySignal[] {
  facts.ledgerCapturedAt = rows.reduce((m, r) => (r.capturedAt > m ? r.capturedAt : m), rows[0].capturedAt);
  facts.fanpagesActive = rows[rows.length - 1].fanpagesActive;
  const winFrom = addDays(today, -(t.activityWindowDays - 1));
  const win = rows.filter((r) => r.day >= winFrom);
  const sum = (k: "customerMessages" | "botMessages" | "aiOrders") => win.reduce((a, r) => a + r[k], 0);
  // Ngày đã chụp mới tính; cửa sổ chưa có ngày nào ⇒ chưa biết.
  facts.usage.customerMessages7d = win.length ? sum("customerMessages") : null;
  facts.usage.botMessages7d = win.length ? sum("botMessages") : null;
  facts.orders.aiOrders7d = win.length ? sum("aiOrders") : null;
  facts.orders.lastAiOrderDay = [...rows].reverse().find((r) => r.aiOrders > 0)?.day ?? null;
  return win;
}

function evaluateChotdon(w: WorkspaceHealthInput, now: Date, t: CustomerHealthThresholds, facts: WorkspaceFacts, add: Add, gap: Gap, reasons: readonly HealthReason[]) {
  facts.ai.applies = true;
  const has = (code: HealthReasonCode) => reasons.some((r) => r.code === code);
  // Hạn mức không phụ thuộc bot có chạy không — luôn xét.
  evaluateUsageLimit(w, facts, add, gap);
  const today = vnDate(now);
  const rows = w.usage?.length ? [...w.usage].sort((a, b) => a.day.localeCompare(b.day)) : [];
  const win = rows.length ? fillLedgerFacts(rows, today, t, facts) : [];

  // Module + bot.
  if (w.modules === null) {
    facts.ai.state = "UNKNOWN";
    return gap("MODULES_UNREADABLE");
  }
  if (!w.modules.aiSales && !w.modules.legacyChatbot) {
    facts.ai.state = "MODULE_OFF";
    return add("AI_MODULE_OFF", "thuê Chốt Đơn, AI bán hàng tắt", "Thuê Chốt Đơn nhưng module AI bán hàng đang tắt — bot không chạy.");
  }
  if (!w.modules.aiSales) {
    facts.ai.state = "LEGACY";
    return gap("AI_RUNTIME_LEGACY");
  }
  facts.ai.state = "ON";
  // Mốc kích hoạt là tín hiệu ÁP DỤNG của Chốt Đơn (chưa từng nối kênh / chưa kích hoạt / ngừng chạy) — không đọc được ⇒ không thể
  // «mọi tín hiệu đều đọc được», nên không bao giờ «Khoẻ», kể cả khi các nhánh dưới không cần tới nó.
  if (w.milestones === null) gap("MILESTONES_UNREADABLE");

  // Công tắc AI của người vận hành.
  if (w.aiSwitch === null) {
    facts.ai.state = "UNKNOWN";
    gap("AI_SWITCH_UNREADABLE");
  } else if (!w.aiSwitch.platformEnabled) {
    facts.ai.state = "OFF";
    add("AI_OFF", "toàn nền tảng", "AI bị tắt TOÀN NỀN TẢNG (công tắc người vận hành) — bot không trả lời khách.");
  } else if (w.aiSwitch.orgDisabled) {
    facts.ai.state = "OFF";
    add("AI_OFF", "riêng workspace này", "AI của workspace này bị người vận hành tắt — bot không trả lời khách.");
  }

  // Sổ AI: lượt trả lời (không gồm lượt đọc hội thoại để ghi đơn hộ) + lượt ghi đơn hộ.
  if (w.ai === null) gap("AI_LEDGER_UNREADABLE");
  else evaluateAiLedger(w.ai, t, facts, add);

  // Sổ dùng theo ngày: kênh · bot im · tin khách dừng · không hoạt động.
  if (w.usage === null) return gap("USAGE_LEDGER_UNREADABLE");
  if (!rows.length) return gap("USAGE_LEDGER_MISSING");
  const capturedAt = facts.ledgerCapturedAt ?? rows[0].capturedAt;
  if (now.getTime() - capturedAt.getTime() > t.usageLedgerFreshHours * HOUR) {
    return gap("USAGE_LEDGER_STALE", `Sổ dùng chụp lần cuối ${vnShortStamp(capturedAt)} (quá ${t.usageLedgerFreshHours} giờ) — kênh, tin khách, đơn AI chưa cập nhật.`);
  }
  const latest = rows[rows.length - 1];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const recentDays = Array.from({ length: t.inboundDropDays }, (_, i) => addDays(today, -i));
  const recent = recentDays.map((d) => byDay.get(d));
  const recentAny = recent.some((r) => (r?.customerMessages ?? 0) > 0);
  // Tổng tin khách các ngày gần nhất — CHỈ khi mọi ngày đó đã chụp (thiếu một ngày ⇒ chưa biết, không phải 0).
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
      add("CHANNEL_LOST", `0 page bật, 0 tin ${t.inboundDropDays} ngày`, `${where} và không có tin khách ${t.inboundDropDays} ngày — bot không nhận được khách nào.`);
    } else if (hadChannel) {
      add(
        "FANPAGE_OFF",
        custRecent === null ? "0 page bật" : `0 page bật · ${formatNumber(custRecent)} tin qua kênh khác`,
        custRecent === null ? `${where} — sổ dùng chưa đủ ngày để biết khách còn nhắn qua kênh khác không.` : `${where} — khách còn nhắn ${formatNumber(custRecent)} tin ${t.inboundDropDays} ngày qua kênh khác (web / Zalo).`,
      );
    } else if (w.milestones === null) {
      gap("MILESTONES_UNREADABLE");
    } else if (cust7 === 0) {
      channelExplained = true;
      if (inGrace(w, now, t)) gap("NEW_WORKSPACE_PENDING", `Mới tạo ${ageText(now, w.createdAt)} trước, chưa nối fanpage / Messenger — còn trong ân hạn ${t.newWorkspaceGraceHours} giờ.`);
      else add("NO_CHANNEL", "chưa nối fanpage / Messenger", "Chưa nối fanpage / Messenger nào và chưa có tin khách — bot chưa nhận được khách.");
    }
  }

  // Bot im: một ngày (hôm nay / hôm qua) có ≥ N tin khách mà 0 tin bot, trong khi các ngày trước đó bot vẫn trả lời. AI bị tắt /
  // đang lỗi đã giải thích sự im lặng ⇒ không nhắc lại.
  if (!has("AI_OFF") && !has("AI_FAILING")) {
    for (const d of recentDays) {
      const r = byDay.get(d);
      if (!r || r.customerMessages < t.aiSilentMinCustomerMessagesPerDay || r.botMessages > 0) continue;
      if (!rows.some((x) => x.day < d && x.day >= addDays(d, -t.activityWindowDays) && x.botMessages > 0)) continue;
      add("AI_SILENT", `${dayText(d)}: ${formatNumber(r.customerMessages)} tin khách, 0 tin bot`, `Ngày ${dayText(d)}: khách nhắn ${formatNumber(r.customerMessages)} tin, bot gửi 0 tin (${t.activityWindowDays} ngày trước đó bot vẫn trả lời) — nếu không cố ý tắt bot thì kiểm ngay.`);
      break;
    }
  }

  // Tin khách dừng (luật 52 — không nền thì không kết luận, và KHÔNG im lặng thành «Khoẻ»): các ngày gần nhất không tin nào ⇒ so nền
  // trung vị theo ngày; các ngày gần nhất chưa chụp đủ, hoặc nền chưa đủ ngày ⇒ chỗ chưa đo.
  let inboundDrop = false;
  if (!channelExplained && !recentAny) {
    if (custRecent === null) {
      gap("INBOUND_BASELINE_SHORT", `Không thấy tin khách ở những ngày đã chụp, nhưng sổ dùng thiếu ngày trong ${t.inboundDropDays} ngày gần nhất — chưa kết luận được tin khách có dừng không.`);
    } else {
      const baseTo = addDays(today, -t.inboundDropDays);
      const baseFrom = addDays(baseTo, -(t.activityWindowDays - 1));
      const base = rows.filter((r) => r.day >= baseFrom && r.day <= baseTo).map((r) => r.customerMessages);
      if (base.length < t.inboundBaselineMinDays) {
        gap("INBOUND_BASELINE_SHORT", `Không có tin khách ${t.inboundDropDays} ngày gần nhất nhưng sổ dùng mới có ${base.length}/${t.inboundBaselineMinDays} ngày nền — chưa biết đó là bình thường hay tin đã dừng.`);
      } else {
        const med = median(base);
        if (med >= t.inboundBaselineMinMessagesPerDay) {
          inboundDrop = true;
          add("INBOUND_DROP", `0 tin ${t.inboundDropDays} ngày (thường ~${formatNumber(Math.round(med))} / ngày)`, `Không có tin khách ${t.inboundDropDays} ngày gần nhất (bình thường ~${formatNumber(Math.round(med))} tin / ngày) — kiểm kết nối page.`);
        }
      }
    }
  }

  if (channelExplained || inboundDrop || w.ai === null) return;
  // Kích hoạt / hoạt động chỉ phải xét khi 7 ngày không lượt AI TRẢ LỜI thành công nào — lượt đọc hội thoại để ghi đơn hộ OK không
  // chứng minh bot đang trả lời khách (re-review #683 F1).
  if (w.ai.chatOk7d > 0) return;
  const syncOnly = w.ai.ok7d > 0 ? " (chỉ có lượt AI ghi đơn hộ)" : "";
  // Chưa kích hoạt: AI CHƯA TỪNG trả lời một khách thật (mốc FIRST_AI_REPLY). Trong ân hạn ⇒ đang thiết lập. Mốc không đọc được ⇒
  // không phân biệt «chưa từng chạy» với «ngừng chạy» (chỗ chưa đo đã ghi ở trên).
  const neverReplied = w.milestones === null ? null : w.milestones.firstAiReplyAt === null;
  if (neverReplied === true) {
    if (inGrace(w, now, t)) return gap("NEW_WORKSPACE_PENDING", `Mới tạo ${ageText(now, w.createdAt)} trước, AI chưa trả lời khách thật nào — còn trong ân hạn ${t.newWorkspaceGraceHours} giờ.`);
    return add("NOT_ACTIVATED", `${ageText(now, w.createdAt)} từ lúc tạo, AI chưa trả lời ai`, `AI chưa trả lời khách thật nào sau ${ageText(now, w.createdAt)} kể từ lúc tạo — khách chưa chạy được sản phẩm.`);
  }
  // Khách VẪN nhắn mà cả cửa sổ không lượt AI nào thành công ⇒ bot im (dài hơn một ngày — nhánh «bot im» theo ngày ở trên cần tin bot
  // của những ngày trước đó nên không thấy trường hợp này). Sự việc đúng dù mốc kích hoạt đọc được hay không; AI bị tắt / đang lỗi đã
  // giải thích ⇒ không nhắc lại; workspace còn trong ân hạn mà chưa đọc được mốc ⇒ có thể chỉ là đang thiết lập, không kết luận.
  if (cust7 !== null && cust7 > 0) {
    if (!has("AI_SILENT") && !has("AI_OFF") && !has("AI_FAILING") && !(neverReplied === null && inGrace(w, now, t))) {
      add("AI_SILENT", `${formatNumber(cust7)} tin khách, 0 lượt AI ${t.activityWindowDays} ngày`, `Khách nhắn ${formatNumber(cust7)} tin trong ${t.activityWindowDays} ngày mà AI không trả lời thành công lượt nào${syncOnly} — nếu không cố ý tắt bot thì kiểm ngay.`);
    }
    return;
  }
  if (neverReplied === null) return;
  // Không hoạt động: đã từng chạy, 0 tin khách và 0 lượt AI thành công trong cửa sổ. Kết luận chỉ khi đủ tuổi + cửa sổ đã chụp đủ
  // ngày; thiếu thì chỗ chưa đo.
  const ageDays = (now.getTime() - w.createdAt.getTime()) / DAY;
  if (cust7 === 0 && ageDays >= t.activityWindowDays && win.length >= t.inboundBaselineMinDays) {
    return add("NO_ACTIVITY", `0 tin khách · 0 lượt AI ${t.activityWindowDays} ngày`, `Không có tin khách và không có lượt AI trả lời thành công nào ${t.activityWindowDays} ngày${syncOnly}.`);
  }
  gap("ACTIVITY_WINDOW_SHORT", `Không thấy tin khách và không có lượt AI trả lời thành công nào, nhưng sổ dùng mới chụp ${win.length}/${t.inboundBaselineMinDays} ngày trong ${t.activityWindowDays} ngày gần nhất — chưa kết luận «không hoạt động».`);
}

function evaluateAiLedger(a: AiLedgerSignal, t: CustomerHealthThresholds, facts: WorkspaceFacts, add: Add) {
  // Lượt đọc hội thoại để ghi đơn hộ cũng là lượt `sales_chatbot` (ref `order-sync:`) ⇒ lỗi TRẢ LỜI = tổng lỗi − lỗi ghi đơn hộ, và
  // mốc phục hồi của trả lời đọc RIÊNG lượt trả lời (`chatLastOkAt` / `chatLastErrorAt`) — không lý do nào đếm đôi, không lượt ghi
  // đơn OK nào làm trả lời trông như đã khỏi (và ngược lại).
  const chatErrors24h = Math.max(0, a.errors24h - a.orderSyncErrors24h);
  const chatErrorsWin = Math.max(0, a.errorsInWindow - a.orderSyncErrorsInWindow);
  facts.ai.ok24h = a.chatOk24h;
  facts.ai.chatErrors24h = chatErrors24h;
  facts.ai.blocked24h = a.blocked24h;
  facts.ai.lastOkAt = a.chatLastOkAt;
  facts.ai.lastErrorAt = a.chatLastErrorAt;
  facts.orders.syncErrors24h = a.orderSyncErrors24h;
  facts.orders.syncLastErrorAt = a.orderSyncLastErrorAt;

  const notRecovered = a.chatLastErrorAt !== null && (a.chatLastOkAt === null || a.chatLastErrorAt.getTime() > a.chatLastOkAt.getTime());
  if (notRecovered && chatErrorsWin + a.blockedInWindow >= t.aiFailBurst) {
    const blocked = a.blockedInWindow > chatErrorsWin;
    const n = blocked ? a.blockedInWindow : chatErrorsWin;
    add(
      "AI_FAILING",
      `${blocked ? "chặn " : ""}${formatNumber(n)} lượt / ${t.aiFailWindowMinutes} phút`,
      `AI ${blocked ? "bị chặn vì hạn mức" : "lỗi"} ${formatNumber(n)} lượt trong ${t.aiFailWindowMinutes} phút, chưa lượt trả lời nào thành công sau lượt hỏng cuối ${vnShortStamp(a.chatLastErrorAt)} — khách không được trả lời.`,
    );
  } else {
    const total = a.chatOk24h + chatErrors24h;
    if (chatErrors24h > 0 && notRecovered) add("AI_ERRORS_RECENT", `${formatNumber(chatErrors24h)} lỗi / 24 giờ, chưa phục hồi`, `AI lỗi ${formatNumber(chatErrors24h)} lượt trong 24 giờ, chưa thấy lượt trả lời thành công sau lượt hỏng cuối ${vnShortStamp(a.chatLastErrorAt)}.`);
    else if (total >= t.aiErrorRateMinSample && chatErrors24h * 100 >= t.aiErrorRateAttentionPct * total) {
      const pct = Math.round((chatErrors24h * 100) / total);
      add("AI_ERRORS_RECENT", `${formatNumber(chatErrors24h)}/${formatNumber(total)} lượt (${pct}%) / 24 giờ`, `AI lỗi ${formatNumber(chatErrors24h)}/${formatNumber(total)} lượt trả lời trong 24 giờ (${pct}%).`);
    }
    if (a.blocked24h > 0) add("AI_BLOCKED_QUOTA", `${formatNumber(a.blocked24h)} lượt / 24 giờ`, `${formatNumber(a.blocked24h)} lượt AI bị chặn vì hạn mức trong 24 giờ — khách của các lượt đó không được AI trả lời.`);
  }

  // Lượt AI ĐỌC HỘI THOẠI ĐỂ GHI ĐƠN HỘ: chỉ lỗi gọi nhà cung cấp AI vào sổ (lỗi lưu đơn / lưu khách KHÔNG vào) — Cần chú ý, lượt
  // sau tự đọc lại (xem bảng khai `ORDER_SYNC_ERRORS`).
  const syncNotRecovered = a.orderSyncLastErrorAt !== null && (a.orderSyncLastOkAt === null || a.orderSyncLastErrorAt.getTime() > a.orderSyncLastOkAt.getTime());
  if (syncNotRecovered && a.orderSyncErrorsInWindow >= t.aiFailBurst) {
    add(
      "ORDER_SYNC_ERRORS",
      `${formatNumber(a.orderSyncErrorsInWindow)} lượt / ${t.aiFailWindowMinutes} phút`,
      `Lượt AI đọc hội thoại để ghi đơn hộ lỗi ${formatNumber(a.orderSyncErrorsInWindow)} lượt / ${t.aiFailWindowMinutes} phút, chưa lượt nào thành công sau lỗi cuối ${vnShortStamp(a.orderSyncLastErrorAt)} (lượt sau đọc lại).`,
    );
  } else if (a.orderSyncErrors24h > 0) {
    add(
      "ORDER_SYNC_ERRORS",
      `${formatNumber(a.orderSyncErrors24h)} lượt / 24 giờ${syncNotRecovered ? ", chưa phục hồi" : ""}`,
      `Lượt AI đọc hội thoại để ghi đơn hộ lỗi ${formatNumber(a.orderSyncErrors24h)} lượt trong 24 giờ${syncNotRecovered ? `, chưa thấy lượt thành công sau lỗi cuối ${vnShortStamp(a.orderSyncLastErrorAt)}` : " (đã có lượt thành công sau đó)"} (lượt sau đọc lại).`,
    );
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
    const why = a.accountStatus === "CLOSED" ? "Tài khoản đã đóng." : "Tài khoản đang tạm dừng.";
    const workspaces = computed.map((w) => ({ ...w, level: "INACTIVE" as const, inactiveReason: why, reasons: [], gaps: [] }));
    return { level: "INACTIVE", inactiveReason: why, accountReasons: [], reasons: [], gaps: [], workspaces };
  }
  const accountReasons: HealthReason[] = [];
  const add: Add = (code, short, text) => accountReasons.push({ code, level: HEALTH_REASONS[code].level, workspace: null, short, text });
  // Cùng mức Nguy cấp, hai lối ra khác nhau (#682): job hỏng ⇒ «Chạy lại»; job xong mà bước mẫu hỏng ⇒ «Cài lại mẫu».
  const tpl = Math.min(a.templatePendingJobs ?? 0, a.failedJobs);
  const broken = a.failedJobs - tpl;
  if (broken > 0) add("PROVISIONING_FAILED", `${formatNumber(broken)} job hỏng`, `${formatNumber(broken)} job cấp phát hỏng — mở trang khách, bấm «Chạy lại».`);
  if (tpl > 0) add("PROVISIONING_FAILED", `chưa cài được mẫu (${formatNumber(tpl)} job)`, `Đã tạo khách nhưng chưa cài được mẫu (${formatNumber(tpl)} job) — mở trang khách, bấm «Cài lại mẫu».`);
  if (a.workspaces.length === 0) add("NO_WORKSPACE", "tài khoản trống", "Tài khoản chưa có workspace nào.");
  // Chỉ khách TRẢ TIỀN trong kỳ — cùng vị từ với cờ của bảng kê (dùng thử lỗ gộp là đúng thiết kế).
  if (losingMoneyApplies(a.revenueVnd, a.grossProfitVnd)) add("LOSING_MONEY", formatVND(a.grossProfitVnd), `Lỗ gộp kỳ này ${formatVND(a.grossProfitVnd)} trên doanh thu ${formatVND(a.revenueVnd)}.`);
  const active = computed.filter((w) => w.level !== "INACTIVE");
  const reasons = sortReasons([...accountReasons, ...active.flatMap((w) => w.reasons)]);
  const gaps = active.flatMap((w) => w.gaps);
  const stopped = computed.length > 0 && active.length === 0 && accountReasons.length === 0;
  const workspaces = [...computed].sort((x, y) => CUSTOMER_HEALTH_RANK[x.level] - CUSTOMER_HEALTH_RANK[y.level] || x.code.localeCompare(y.code));
  const inactiveReason = stopped ? [...new Set(computed.map((w) => w.inactiveReason).filter((x): x is string => Boolean(x)))].join(" ") || null : null;
  return { level: stopped ? "INACTIVE" : levelOf(reasons, gaps), inactiveReason, accountReasons: sortReasons(accountReasons), reasons, gaps, workspaces };
}
