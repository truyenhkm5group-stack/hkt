/**
 * ═══════════ TÍN HIỆU SỨC KHOẺ KHÁCH — MỘT LƯỢT GOM, CHỈ CSDL NHÀ (sứ mệnh saas-customer-health, 08/10/2026) ═══════════
 *
 * Đọc mọi tín hiệu cho MỌI workspace của danh sách bằng vài câu GOM ở mặt phẳng điều khiển — KHÔNG mở CSDL tổ chức nào (không
 * N+1). Chỉ số chỉ có trong CSDL tổ chức (công tắc bot của shop, lỗi gửi của từng page, hàng chờ tin) thì dùng SỔ ở CSDL nhà
 * (sổ dùng theo ngày, sổ AI, chỉ mục) hoặc nói CHƯA ĐO. Một nguồn đọc hỏng ⇒ tín hiệu đó `null` ⇒ chỗ chưa đo (luật 42), không
 * bao giờ 0, và không làm hỏng các tín hiệu khác.
 *
 * Mỗi chỉ số MỘT nguồn, dùng lại hàm đọc có sẵn (không câu thứ hai cho cùng chỉ số) — bảng `DEFAULT_SIGNAL_READERS`:
 *  · đăng nhập + page Messenger nối thẳng — `workspaceReach` (platform_identities · platform_messenger_pages), MỘT lượt cho cả mảng mã;
 *  · sổ AI bán hàng — `salesAiUsageHealthByOrg` (platform_ai_usage — cùng câu với giám sát `sales-health`), MỘT câu cho cả mảng mã;
 *  · sổ dùng theo ngày — `readUsageDaily` (platform_tenant_usage_daily — cùng câu với cockpit), MỘT câu;
 *  · mốc kích hoạt — `readMilestones` (platform_org_milestones), MỘT câu;
 *  · công tắc AI — `readPlatformAiSwitch` + `orgAiControlFromSettings` (platform_settings · platform_organizations.settings);
 *  · bảng giá (ngưỡng cảnh báo của phiên bản) — `loadPriceBook` (đệm);
 *  · module — `getEnabledModules` / `canUseFeature`: bộ phân giải năng lực là chỗ DUY NHẤT được đọc platform_organization_modules,
 *    nên đây là lượt THEO WORKSPACE duy nhất — ở CSDL nhà, đệm 5 giây, và ảnh chụp thương mại vừa đọc cùng đệm (đồng hồ khách AI) ⇒
 *    thường không thêm lượt CSDL nào;
 *  · khách AI của kỳ THEO KÊNH (fanpage · Zalo · web) — nhãn `metadata.channel` mà điểm gửi ghi vào sổ dùng chung, CÙNG vị ngữ với
 *    đồng hồ khách AI (`aiCustomerEventsWhere`): bằng chứng kênh nào đang có khách thật — chỉ để in, không phân loại;
 *  · thuê bao · gói · đồng hồ khách AI · phần vượt · đã từng trả tiền · job hỏng · kinh tế — ảnh chụp `loadCommercialSnapshot` người
 *    gọi truyền vào.
 * Bộ đọc truyền vào được (`readers`) để bài kiểm ép TỪNG nguồn hỏng và đếm số lượt gọi (tests/customer-health.test.ts).
 *
 * NHÌN XUYÊN MỌI TỔ CHỨC ⇒ chỉ `lib/saas/console.ts` gọi, SAU `platformOperatorDenial` (tests/customer-health.test.ts quét mã).
 * Không trả email, tên người, nội dung tin, khoá — chỉ số đếm, mốc, cờ.
 */
import { inArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { orgAiControlFromSettings, readPlatformAiSwitch } from "@/lib/ai-usage/control";
import { salesAiUsageHealthByOrg, type SalesAiUsageHealth } from "@/lib/ai-usage/sales-health";
import { addDays, vnDate } from "@/lib/billing/rules";
import { CUSTOMER_HEALTH_THRESHOLDS, type CustomerHealthThresholds } from "@/lib/constants/customer-health";
import { canUseFeature, getEnabledModules } from "@/lib/platform/capabilities";
import type { ActivationMilestone } from "@/lib/platform/saas-metrics";
import { readMilestones, readUsageDaily, type UsageDayDetail } from "@/lib/platform/saas-ledger";
import { aiCustomerEventsWhere } from "@/lib/pricing/ai-customer";
import { loadPriceBook } from "@/lib/pricing/price-book";
import { DEFAULT_USAGE_ALERTS, isPrepaidVersionKey, type PriceBook } from "@/lib/pricing/versions";
import type { AdminActivation } from "@/lib/saas/activation";
import { LEGACY_CHATBOT_FEATURE } from "@/lib/saas/catalog";
import { classifyCustomer, type CustomerHealth, type WorkspaceHealthInput } from "@/lib/saas/customer-health";
import { workspaceReach, type CustomerView, type WorkspaceView } from "@/lib/saas/customers";
import { periodRange } from "@/lib/saas/ledger";

type ModuleState = { aiSales: boolean; legacyChatbot: boolean };
type ReachMap = Map<string, { identities: number; lastLoginAt: Date | null; messengerPages: number }>;

/**
 * Bộ đọc của MỘT lượt gom. Hàm nhận MẢNG mã đọc một lượt cho cả mảng; `modules` là lượt theo workspace duy nhất (xem đầu tệp). Hàm
 * nào ném ⇒ tín hiệu đó «chưa đo» cho mọi workspace (không bao giờ 0).
 */
export type SignalReaders = {
  reach: (codes: readonly string[]) => Promise<ReachMap>;
  ai: (codes: readonly string[], now: Date, windowMinutes: number) => Promise<Map<string, SalesAiUsageHealth>>;
  usage: (fromDay: string) => Promise<Map<string, UsageDayDetail[]>>;
  milestones: () => Promise<Map<string, Partial<Record<ActivationMilestone, Date>>>>;
  /** Không ném: đọc hỏng trả `readError` — ở đây là CHƯA ĐO (không phải «tắt»). */
  platformAiSwitch: () => Promise<{ enabled: boolean; readError: boolean }>;
  orgAiDisabled: (codes: readonly string[]) => Promise<Map<string, boolean>>;
  priceBook: () => Promise<PriceBook>;
  modules: (code: string) => Promise<ModuleState>;
  channels: (codes: readonly string[], periodMonth: string) => Promise<Map<string, Record<string, number>>>;
};

/** Module AI bán hàng + runtime cũ (`chatbot/`) — cùng luật với `productsInUse` (lib/saas/accounts.ts). Ném khi không đọc được. */
async function readModuleState(code: string): Promise<ModuleState> {
  const enabled = await getEnabledModules(code);
  const legacyChatbot = enabled.has("connector_pancake") ? await canUseFeature(LEGACY_CHATBOT_FEATURE as `${string}.${string}`, code) : false;
  return { aiSales: enabled.has("ai_sales"), legacyChatbot };
}

/** Công tắc AI của TỪNG tổ chức trong một câu — luật đọc chung với `readOrgAiControl` (`orgAiControlFromSettings`). */
async function readOrgAiDisabled(codes: readonly string[]): Promise<Map<string, boolean>> {
  if (!codes.length) return new Map();
  const pdb = await getPlatformDb();
  const o = schema.platformOrganizations;
  const rows = await pdb.select({ code: o.code, settings: o.settings }).from(o).where(inArray(o.code, [...codes]));
  return new Map(rows.map((r) => [r.code, orgAiControlFromSettings(r.settings).disabled]));
}

/**
 * Khách AI của kỳ theo KÊNH (`metadata.channel`: FANPAGE · ZALO · WEB) — một câu gom cho mọi tổ chức, CÙNG vị ngữ với đồng hồ khách
 * AI (`aiCustomerEventsWhere`, AGENTS 8.12); `sum(quantity)` nên bí danh (số lượng 0) không đếm hai lần.
 */
async function readAiCustomerChannels(codes: readonly string[], periodMonth: string): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (!codes.length) return out;
  const { from, to } = periodRange(periodMonth);
  const pdb = await getPlatformDb();
  const e = schema.platformUsageEvents;
  const channel = sql<string>`coalesce(${e.metadata} ->> 'channel', '')`;
  const rows = await pdb
    .select({ orgCode: e.orgCode, channel, n: sql<number>`coalesce(sum(${e.quantity}), 0)::int` })
    .from(e)
    .where(aiCustomerEventsWhere(codes, from, to))
    .groupBy(e.orgCode, channel);
  for (const r of rows) {
    const n = Number(r.n);
    if (!n) continue;
    out.set(r.orgCode, { ...(out.get(r.orgCode) ?? {}), [r.channel || "?"]: n });
  }
  return out;
}

export const DEFAULT_SIGNAL_READERS: Readonly<SignalReaders> = Object.freeze({
  reach: (codes: readonly string[]) => workspaceReach(codes),
  ai: (codes: readonly string[], now: Date, windowMinutes: number) => salesAiUsageHealthByOrg(codes, now, windowMinutes),
  usage: (fromDay: string) => readUsageDaily(fromDay),
  milestones: () => readMilestones(),
  platformAiSwitch: () => readPlatformAiSwitch(),
  orgAiDisabled: readOrgAiDisabled,
  priceBook: () => loadPriceBook(),
  modules: readModuleState,
  channels: readAiCustomerChannels,
});

/** Tín hiệu đã đọc cho cả danh sách. `null` = nguồn đó không đọc được. */
type Signals = {
  reach: ReachMap | null;
  ai: Map<string, SalesAiUsageHealth> | null;
  usage: Map<string, UsageDayDetail[]> | null;
  milestones: Map<string, Partial<Record<ActivationMilestone, Date>>> | null;
  platformAiEnabled: boolean | null;
  orgAiDisabled: Map<string, boolean> | null;
  book: PriceBook | null;
  modules: Map<string, ModuleState | null>;
  /** Khách AI của kỳ theo kênh, theo tổ chức. `null` = không đọc được. */
  channels: Map<string, Record<string, number>> | null;
};

/** Một nguồn hỏng ⇒ `null` (chưa đo) + một dòng nhật ký máy chủ để người sửa tra được nguồn nào — không làm hỏng nguồn khác. */
async function attempt<T>(source: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[customer-health] không đọc được ${source}: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    return null;
  }
}

async function readSignals(codes: readonly string[], now: Date, periodMonth: string, t: CustomerHealthThresholds, r: Readonly<SignalReaders>): Promise<Signals> {
  const fromDay = addDays(vnDate(now), -t.usageLookbackDays);
  const [reach, ai, usage, milestones, platformSwitch, orgAiDisabled, book, modules, channels] = await Promise.all([
    attempt("đăng nhập / page", () => r.reach(codes)),
    attempt("sổ AI", () => r.ai(codes, now, t.aiFailWindowMinutes)),
    attempt("sổ dùng theo ngày", () => r.usage(fromDay)),
    attempt("mốc kích hoạt", () => r.milestones()),
    attempt("công tắc AI nền tảng", () => r.platformAiSwitch()),
    attempt("công tắc AI tổ chức", () => r.orgAiDisabled(codes)),
    attempt("bảng giá", () => r.priceBook()),
    Promise.all(codes.map(async (c) => [c, await attempt(`module của ${c}`, () => r.modules(c))] as const)).then((xs) => new Map(xs)),
    attempt("khách AI theo kênh", () => r.channels(codes, periodMonth)),
  ]);
  return { reach, ai, usage, milestones, platformAiEnabled: platformSwitch && !platformSwitch.readError ? platformSwitch.enabled : null, orgAiDisabled, book, modules, channels };
}

/** Hội thoại mới của KỲ (sổ dùng của ảnh chụp — cùng số cột «Dùng» cũ). Chưa đo ⇒ `null`, không phải 0. */
function periodConversations(w: WorkspaceView): number | null {
  const vals = w.usage.filter((u) => u.metric === "conversations_started").map((u) => u.value);
  return vals.length && vals.every((v) => v !== null) ? vals.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
}

/** Một workspace của ảnh chụp thương mại + tín hiệu đã đọc ⇒ đầu vào của hàm phân loại thuần. */
function workspaceHealthInput(w: WorkspaceView, s: Signals, activation: Record<string, AdminActivation | null> | undefined): WorkspaceHealthInput {
  const reach = s.reach?.get(w.code);
  const m = s.milestones ? (s.milestones.get(w.code) ?? {}) : null;
  const orgDisabled = s.orgAiDisabled?.get(w.code);
  const ac = w.pricing.aiCustomers;
  const version = s.book?.versions.find((v) => v.key === w.pricing.versionKey) ?? null;
  const act = activation ? activation[w.code] : undefined;
  return {
    code: w.code,
    name: w.name,
    isHome: w.isHome,
    orgStatus: w.status,
    createdAt: w.createdAt,
    subscriptions: w.subscriptions.map((x) => ({ productKey: x.productKey, status: x.status })),
    hadEndedSubscriptions: w.endedSubscriptions.length > 0,
    everPaid: w.everPaid,
    modules: s.modules.get(w.code) ?? null,
    login: reach ? { identities: reach.identities, lastLoginAt: reach.lastLoginAt } : null,
    // Trang một khách nạp trạng thái kích hoạt (console.ts); danh sách không ⇒ `undefined` (lời khuyên trung tính).
    activation: act === undefined ? undefined : act === null ? null : { state: act.state, activatedAt: act.activatedAt, linkExpiresAt: act.linkExpiresAt },
    messengerPages: reach ? reach.messengerPages : null,
    aiSwitch: s.platformAiEnabled === null || orgDisabled === undefined ? null : { platformEnabled: s.platformAiEnabled, orgDisabled },
    ai: s.ai?.get(w.code) ?? null,
    usage: s.usage ? (s.usage.get(w.code) ?? []).map((r) => ({ day: r.day, conversationsStarted: r.conversationsStarted, customerMessages: r.customerMessages, botMessages: r.botMessages, aiOrders: r.aiOrders, fanpagesActive: r.fanpagesActive, capturedAt: r.capturedAt })) : null,
    milestones: m === null ? null : { channelConnectedAt: m.CHANNEL_CONNECTED ?? null, firstAiReplyAt: m.FIRST_AI_REPLY ?? null, firstAiOrderAt: m.FIRST_AI_ORDER ?? null },
    // Phần gồm theo PHIÊN BẢN GIÁ đã ghim của workspace + ngưỡng cảnh báo của chính phiên bản đó (phiên bản không khai ⇒ mặc định
    // của bảng giá); bảng giá không đọc được ⇒ ngưỡng CHƯA BIẾT (`null`), không lặng lẽ dùng mặc định.
    aiCustomers: ac ? { value: ac.value, coverage: ac.coverage, included: w.pricing.price ? w.pricing.price.included.aiCustomers : undefined, alerts: s.book === null ? null : (version?.alerts ?? DEFAULT_USAGE_ALERTS), prepaid: isPrepaidVersionKey(w.pricing.versionKey) } : null,
    // Đồng hồ chưa đo workspace này (runtime cũ / chưa bật) ⇒ theo kênh cũng CHƯA BIẾT, không phải «không kênh nào».
    aiCustomerChannels: ac && ac.coverage !== "NOT_MEASURED" && s.channels ? (s.channels.get(w.code) ?? {}) : null,
    periodConversations: periodConversations(w),
    overageSeats: (w.pricing.overage?.lines ?? []).filter((l) => (l.key === "fanpages" || l.key === "users") && l.overUnits !== null && l.overUnits > 0).map((l) => ({ label: l.label, overUnits: l.overUnits as number })),
    fairUseFlagged: w.pricing.fairUse?.flagged ?? false,
  };
}

/**
 * Sức khoẻ của MỌI khách trong ảnh chụp, theo mã tài khoản. Vài câu gom cho cả danh sách — số câu KHÔNG tăng theo số khách (trừ
 * lượt module theo workspace, đệm). `now` truyền vào (một mốc cho cả lượt — không đọc đồng hồ hai lần quanh nửa đêm); `activation`
 * chỉ trang một khách truyền. Người gọi đã hỏi `platformOperatorDenial` (console.ts).
 */
export async function readCustomerHealth(
  customers: readonly CustomerView[],
  opts: { now: Date; periodMonth: string; activation?: Record<string, AdminActivation | null>; readers?: Readonly<SignalReaders> },
  t: CustomerHealthThresholds = CUSTOMER_HEALTH_THRESHOLDS,
): Promise<Record<string, CustomerHealth>> {
  const { now } = opts;
  const codes = [...new Set(customers.flatMap((c) => c.workspaces.map((w) => w.code)))];
  const s = await readSignals(codes, now, opts.periodMonth, t, opts.readers ?? DEFAULT_SIGNAL_READERS);
  const out: Record<string, CustomerHealth> = {};
  for (const c of customers) {
    out[c.account.id] = classifyCustomer(
      { accountStatus: c.account.status, failedJobs: c.failedJobs, templatePendingJobs: c.templatePendingJobs, revenueVnd: c.economics.revenueVnd, grossProfitVnd: c.economics.grossProfitVnd, workspaces: c.workspaces.map((w) => workspaceHealthInput(w, s, opts.activation)) },
      now,
      t,
    );
  }
  return out;
}
