/**
 * ═══════════ TÍN HIỆU SỨC KHOẺ KHÁCH — MỘT LƯỢT GOM, CHỈ CSDL NHÀ (sứ mệnh saas-customer-health, 08/10/2026) ═══════════
 *
 * Đọc mọi tín hiệu cho MỌI workspace của danh sách bằng vài câu GOM ở mặt phẳng điều khiển — KHÔNG mở CSDL tổ chức nào (không
 * N+1). Chỉ số chỉ có trong CSDL tổ chức (công tắc bot của shop, lỗi gửi của từng page, hàng chờ tin) thì dùng SỔ ở CSDL nhà
 * (sổ dùng theo ngày, sổ AI, chỉ mục) hoặc nói CHƯA ĐO. Một nguồn đọc hỏng ⇒ tín hiệu đó `null` ⇒ chỗ chưa đo (luật 42), không
 * bao giờ 0, và không làm hỏng các tín hiệu khác.
 *
 * Mỗi chỉ số MỘT nguồn, dùng lại hàm đọc có sẵn (không câu thứ hai cho cùng chỉ số):
 *  · đăng nhập + page Messenger nối thẳng — `workspaceReach` (platform_identities · platform_messenger_pages);
 *  · sổ AI bán hàng — `salesAiUsageHealthByOrg` (platform_ai_usage — cùng câu với giám sát `sales-health`);
 *  · sổ dùng theo ngày — `readUsageDaily` (platform_tenant_usage_daily — cùng câu với cockpit);
 *  · mốc kích hoạt — `readMilestones` (platform_org_milestones);
 *  · công tắc AI — `readPlatformAiSwitch` + `orgAiControlFromSettings` (platform_settings · platform_organizations.settings);
 *  · module — `getEnabledModules` / `canUseFeature` (đệm 5 giây; ảnh chụp thương mại vừa đọc cùng đệm ⇒ không thêm lượt CSDL);
 *  · thuê bao · gói · đồng hồ khách AI · phần vượt · job hỏng · kinh tế — ảnh chụp `loadCommercialSnapshot` người gọi truyền vào.
 *
 * NHÌN XUYÊN MỌI TỔ CHỨC ⇒ chỉ `lib/saas/console.ts` gọi, SAU `platformOperatorDenial` (tests/customer-health.test.ts quét mã).
 * Không trả email, tên người, nội dung tin, khoá — chỉ số đếm, mốc, cờ.
 */
import { inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { orgAiControlFromSettings, readPlatformAiSwitch } from "@/lib/ai-usage/control";
import { salesAiUsageHealthByOrg, type SalesAiUsageHealth } from "@/lib/ai-usage/sales-health";
import { addDays, vnDate } from "@/lib/billing/rules";
import { CUSTOMER_HEALTH_THRESHOLDS, type CustomerHealthThresholds } from "@/lib/constants/customer-health";
import { canUseFeature, getEnabledModules } from "@/lib/platform/capabilities";
import type { ActivationMilestone } from "@/lib/platform/saas-metrics";
import { readMilestones, readUsageDaily, type UsageDayDetail } from "@/lib/platform/saas-ledger";
import { loadPriceBook } from "@/lib/pricing/price-book";
import { DEFAULT_USAGE_ALERTS, isPrepaidVersionKey, type PriceBook } from "@/lib/pricing/versions";
import { LEGACY_CHATBOT_FEATURE } from "@/lib/saas/catalog";
import { classifyCustomer, type CustomerHealth, type WorkspaceHealthInput } from "@/lib/saas/customer-health";
import { workspaceReach, type CustomerView, type WorkspaceView } from "@/lib/saas/customers";

type ModuleState = { aiSales: boolean; legacyChatbot: boolean };

/** Tín hiệu đã đọc cho cả danh sách. `null` = nguồn đó không đọc được. */
type Signals = {
  reach: Map<string, { identities: number; lastLoginAt: Date | null; messengerPages: number }> | null;
  ai: Map<string, SalesAiUsageHealth> | null;
  usage: Map<string, UsageDayDetail[]> | null;
  milestones: Map<string, Partial<Record<ActivationMilestone, Date>>> | null;
  platformAiEnabled: boolean | null;
  orgAiDisabled: Map<string, boolean> | null;
  book: PriceBook | null;
  modules: Map<string, ModuleState | null>;
};

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Module AI bán hàng + runtime cũ (`chatbot/`) — cùng luật với `productsInUse` (lib/saas/accounts.ts). */
async function moduleState(code: string): Promise<ModuleState | null> {
  try {
    const enabled = await getEnabledModules(code);
    const legacyChatbot = enabled.has("connector_pancake") ? await canUseFeature(LEGACY_CHATBOT_FEATURE as `${string}.${string}`, code) : false;
    return { aiSales: enabled.has("ai_sales"), legacyChatbot };
  } catch {
    return null;
  }
}

/** Công tắc AI của TỪNG tổ chức trong một câu — luật đọc chung với `readOrgAiControl` (`orgAiControlFromSettings`). */
async function readOrgAiDisabled(codes: readonly string[]): Promise<Map<string, boolean>> {
  if (!codes.length) return new Map();
  const pdb = await getPlatformDb();
  const o = schema.platformOrganizations;
  const rows = await pdb.select({ code: o.code, settings: o.settings }).from(o).where(inArray(o.code, [...codes]));
  return new Map(rows.map((r) => [r.code, orgAiControlFromSettings(r.settings).disabled]));
}

async function readSignals(codes: readonly string[], now: Date, t: CustomerHealthThresholds): Promise<Signals> {
  const fromDay = addDays(vnDate(now), -t.usageLookbackDays);
  const [reach, ai, usage, milestones, platformSwitch, orgAiDisabled, book, modules] = await Promise.all([
    attempt(() => workspaceReach(codes)),
    attempt(() => salesAiUsageHealthByOrg(codes, now, t.aiFailWindowMinutes)),
    attempt(() => readUsageDaily(fromDay)),
    attempt(() => readMilestones()),
    // Không ném: đọc hỏng trả `readError` (và «tắt» cho đường chặn — ở đây là CHƯA ĐO).
    readPlatformAiSwitch(),
    attempt(() => readOrgAiDisabled(codes)),
    attempt(() => loadPriceBook()),
    Promise.all(codes.map(async (c) => [c, await moduleState(c)] as const)).then((xs) => new Map(xs)),
  ]);
  return { reach, ai, usage, milestones, platformAiEnabled: platformSwitch.readError ? null : platformSwitch.enabled, orgAiDisabled, book, modules };
}

/** Một workspace của ảnh chụp thương mại + tín hiệu đã đọc ⇒ đầu vào của hàm phân loại thuần. */
function workspaceHealthInput(w: WorkspaceView, s: Signals): WorkspaceHealthInput {
  const reach = s.reach?.get(w.code);
  const m = s.milestones ? (s.milestones.get(w.code) ?? {}) : null;
  const orgDisabled = s.orgAiDisabled?.get(w.code);
  const ac = w.pricing.aiCustomers;
  const version = s.book?.versions.find((v) => v.key === w.pricing.versionKey) ?? null;
  return {
    code: w.code,
    name: w.name,
    isHome: w.isHome,
    orgStatus: w.status,
    createdAt: w.createdAt,
    subscriptions: w.subscriptions.map((x) => ({ productKey: x.productKey, status: x.status })),
    hadEndedSubscriptions: w.endedSubscriptions.length > 0,
    modules: s.modules.get(w.code) ?? null,
    login: reach ? { identities: reach.identities, lastLoginAt: reach.lastLoginAt } : null,
    messengerPages: reach ? reach.messengerPages : null,
    aiSwitch: s.platformAiEnabled === null || orgDisabled === undefined ? null : { platformEnabled: s.platformAiEnabled, orgDisabled },
    ai: s.ai?.get(w.code) ?? null,
    usage: s.usage ? (s.usage.get(w.code) ?? []).map((r) => ({ day: r.day, conversationsStarted: r.conversationsStarted, customerMessages: r.customerMessages, botMessages: r.botMessages, aiOrders: r.aiOrders, fanpagesActive: r.fanpagesActive, capturedAt: r.capturedAt })) : null,
    milestones: m === null ? null : { channelConnectedAt: m.CHANNEL_CONNECTED ?? null, firstAiReplyAt: m.FIRST_AI_REPLY ?? null, firstAiOrderAt: m.FIRST_AI_ORDER ?? null },
    // Phần gồm theo PHIÊN BẢN GIÁ đã ghim của workspace + ngưỡng cảnh báo của chính phiên bản đó (không có ⇒ mặc định của bảng giá).
    aiCustomers: ac ? { value: ac.value, coverage: ac.coverage, included: w.pricing.price ? w.pricing.price.included.aiCustomers : undefined, alerts: version?.alerts ?? DEFAULT_USAGE_ALERTS, prepaid: isPrepaidVersionKey(w.pricing.versionKey) } : null,
    overageSeats: (w.pricing.overage?.lines ?? []).filter((l) => (l.key === "fanpages" || l.key === "users") && l.overUnits !== null && l.overUnits > 0).map((l) => ({ label: l.label, overUnits: l.overUnits as number })),
    fairUseFlagged: w.pricing.fairUse?.flagged ?? false,
  };
}

/**
 * Sức khoẻ của MỌI khách trong ảnh chụp, theo mã tài khoản. Vài câu gom cho cả danh sách — số câu KHÔNG tăng theo số khách.
 * Người gọi đã hỏi `platformOperatorDenial` (console.ts).
 */
export async function readCustomerHealth(customers: readonly CustomerView[], now: Date = new Date(), t: CustomerHealthThresholds = CUSTOMER_HEALTH_THRESHOLDS): Promise<Record<string, CustomerHealth>> {
  const codes = [...new Set(customers.flatMap((c) => c.workspaces.map((w) => w.code)))];
  const s = await readSignals(codes, now, t);
  const out: Record<string, CustomerHealth> = {};
  for (const c of customers) {
    out[c.account.id] = classifyCustomer(
      { accountStatus: c.account.status, failedJobs: c.failedJobs, revenueVnd: c.economics.revenueVnd, grossProfitVnd: c.economics.grossProfitVnd, workspaces: c.workspaces.map((w) => workspaceHealthInput(w, s)) },
      now,
      t,
    );
  }
  return out;
}
