import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { trialPaidThrough, vnDate } from "@/lib/billing/rules";
import { initWorkspaceBilling } from "@/lib/billing/service";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setRequestHostSlugForTests } from "@/lib/platform/host-org";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { readAiCustomerCounts, readAiCustomerUsage, recordAiCustomer, resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { aiCustomerKeyOf, aiCustomerKeys, canonicalAiCustomer, fanpageVisitorKeyMirror } from "@/lib/pricing/ai-customer-identity";
import { AI_STOP_MESSAGE, AI_STOP_NOTE, aiEntitlementDecision, highestUsageThreshold, trialEndFromLastDay, usageAlertDedupeKey } from "@/lib/pricing/ai-entitlement";
import { invalidateAiEntitlement, loadAiEntitlement, loadCustomerEntitlementView } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { invalidatePriceBook, loadPriceBook, pinOrgPriceVersion } from "@/lib/pricing/price-book";
import { customerUsageAlertText, runAiCustomerUsageAlerts } from "@/lib/pricing/usage-alerts";
import { aiCustomerEventKey, computeOverage, currentCatalogVersion, DEFAULT_USAGE_ALERTS, meterMonthOf, priceOf } from "@/lib/pricing/versions";
import { requestProvisioning } from "@/lib/saas/provisioning";
import { classifyInboundNote, conversationAiBlocks, forgetAiStatus } from "@/lib/sales-chatbot/ai-status";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, conversationView, openConversation, setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import { sendPublicChat, startPublicChat } from "@/lib/sales-chatbot/public";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ L5 — DÙNG THỬ / HẾT LƯỢT DỪNG AI · KỲ TÍNH TIỀN · NGƯỠNG CẢNH BÁO · KHOÁ ĐỒNG HỒ THEO KHÁCH CHUẨN ═══════════
 *
 * Quyết định chủ shop 07/10/2026 (docs/saas/PRICING_V1.md): gói DÙNG THỬ dừng AI tự trả lời khi hết lượt khách AI HOẶC hết hạn
 * (cái nào tới trước); gói TRẢ PHÍ / giá cũ không bao giờ dừng (chỉ phần vượt + cảnh báo); dừng AI không khoá dữ liệu. Mọi mốc đi
 * theo đồng hồ thật hoặc dựng từ chính dữ liệu (luật 50 / 65); số gói / ngưỡng đọc từ SỔ GIÁ, không gõ lại.
 */

const T = "l5-trial";
const P = "l5-paid";
const L = "l5-legacy";
const W = "l5-prov";
const ORGS = [T, P, L, W] as const;

// ─────────────────────────── 1 · LUẬT THUẦN ───────────────────────────

function testPure() {
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 86_400_000);
  const base = { orgStatus: "ACTIVE", trial: true, trialEndsAt: later, aiCustomersUsed: 10, aiCustomersIncluded: 100, now };
  assert.deepEqual(aiEntitlementDecision(base).allowed, true, "dùng thử còn hạn + còn lượt ⇒ cho");
  // Hết lượt: đúng bằng số gồm là HẾT (khách thứ 101 không được mở).
  assert.equal(aiEntitlementDecision({ ...base, aiCustomersUsed: 99 }).allowed, true);
  assert.equal(aiEntitlementDecision({ ...base, aiCustomersUsed: 100 }).reason, "TRIAL_QUOTA_EXHAUSTED");
  // Hết hạn: ranh giới đúng tới mili giây.
  assert.equal(aiEntitlementDecision({ ...base, now: new Date(later.getTime() - 1) }).allowed, true, "1 ms trước mốc ⇒ còn dùng thử");
  assert.equal(aiEntitlementDecision({ ...base, now: later }).reason, "TRIAL_EXPIRED", "đúng mốc ⇒ hết dùng thử");
  // CÁI NÀO TỚI TRƯỚC: hết lượt ở ngày 3 ⇒ dừng ở ngày 3 (chưa hết hạn); còn lượt ⇒ dừng đúng ngày hết hạn.
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
  assert.equal(aiEntitlementDecision({ ...base, aiCustomersUsed: 100, now: day(3) }).reason, "TRIAL_QUOTA_EXHAUSTED", "hết lượt tới trước");
  assert.equal(aiEntitlementDecision({ ...base, aiCustomersUsed: 40, now: day(6) }).allowed, true);
  assert.equal(aiEntitlementDecision({ ...base, aiCustomersUsed: 40, now: day(7) }).reason, "TRIAL_EXPIRED", "hết hạn tới trước");
  assert.deepEqual(aiEntitlementDecision({ ...base, aiCustomersUsed: 100, now: day(8) }).reasons, ["TRIAL_EXPIRED", "TRIAL_QUOTA_EXHAUSTED"], "cả hai ⇒ giữ đủ lý do");
  // Gói trả phí / giá cũ: vượt bao nhiêu cũng CHO.
  assert.equal(aiEntitlementDecision({ ...base, trial: false, aiCustomersUsed: 1_000_000, trialEndsAt: day(-30) }).allowed, true, "trả phí vượt 100% ⇒ AI vẫn chạy");
  // Chưa biết ⇒ nới, có cảnh báo.
  const unknown = aiEntitlementDecision({ ...base, aiCustomersUsed: null });
  assert.ok(unknown.allowed && unknown.warnings.includes("USAGE_UNKNOWN"), "số dùng chưa biết ⇒ không chặn");
  const noEnd = aiEntitlementDecision({ ...base, trialEndsAt: null });
  assert.ok(noEnd.allowed && noEnd.warnings.includes("TRIAL_END_UNKNOWN"));
  const noPlan = aiEntitlementDecision({ ...base, trial: null, aiCustomersUsed: 999 });
  assert.ok(noPlan.allowed && noPlan.warnings.includes("PLAN_UNREADABLE"), "không đọc được dòng giá ⇒ không chặn");
  // Đình chỉ ⇒ dừng kể cả gói trả phí.
  assert.equal(aiEntitlementDecision({ ...base, trial: false, orgStatus: "SUSPENDED" }).reason, "WORKSPACE_SUSPENDED");

  // Mốc hết dùng thử = 00:00 giờ VN sau ngày cuối.
  const last = trialPaidThrough(vnDate(now), 7);
  const end = trialEndFromLastDay(last)!;
  assert.equal(vnDate(new Date(end.getTime() - 1)), last, "giây cuối của ngày cuối vẫn là ngày cuối (giờ VN)");
  assert.notEqual(vnDate(end), last);
  assert.equal(trialEndFromLastDay("hỏng"), null);

  // Ngưỡng theo PHIÊN BẢN (không gõ số): V1 mặc định + một bộ khác.
  const c = DEFAULT_USAGE_ALERTS;
  const at = (pct: number) => highestUsageThreshold(pct, 100, c)?.key ?? null;
  assert.deepEqual([at(c.notifyPct - 1), at(c.notifyPct), at(c.overagePct - 1), at(c.overagePct), at(c.strongPct), at(c.reviewPct), at(c.reviewPct * 3)], [null, "notify", "notify", "limit", "strong", "review", "review"]);
  const other = { notifyPct: 70, overagePct: 100, strongPct: 130, reviewPct: 200 };
  assert.equal(highestUsageThreshold(70, 100, other)?.key, "notify", "ngưỡng đi theo phiên bản giá");
  assert.equal(highestUsageThreshold(129, 100, other)?.key, "limit");
  assert.equal(highestUsageThreshold(null, 100, c), null, "chưa biết ⇒ không báo");
  assert.equal(highestUsageThreshold(10, null, c), null, "không giới hạn ⇒ không báo");
  // Khoá chống trùng NEO THEO KỲ: hai lượt kiểm ở hai phía ranh giới giờ trong cùng kỳ ⇒ cùng khoá; sang kỳ ⇒ khoá khác.
  const period = usagePeriodOf(now);
  const a = new Date(period.from.getTime() + 3_600_000 - 1);
  const b = new Date(period.from.getTime() + 3_600_000 + 1);
  assert.equal(usageAlertDedupeKey(meterMonthOf(a), "notify"), usageAlertDedupeKey(meterMonthOf(b), "notify"), "sát ranh giới giờ ⇒ cùng khoá");
  assert.notEqual(usageAlertDedupeKey(meterMonthOf(new Date(period.to.getTime() - 1)), "notify"), usageAlertDedupeKey(meterMonthOf(period.to), "notify"), "sang kỳ ⇒ khoá mới");

  // Câu cho khách: không token / USD / model.
  for (const key of ["notify", "limit", "strong", "review"] as const)
    for (const trial of [true, false]) {
      const t = customerUsageAlertText({ key, used: 120, included: 100, pct: 120, planName: "Starter", periodLabel: period.label, trial, blockSize: 100 });
      assert.ok(!/token|usd|\$|model|nhà cung cấp/i.test(`${t.title} ${t.body}`), `câu ngưỡng ${key} không lộ số nội bộ`);
    }
  assert.equal(AI_STOP_MESSAGE.TRIAL_QUOTA_EXHAUSTED, "Bạn đã sử dụng hết lượt AI của gói hiện tại.", "câu nguyên văn của quyết định");

  // Danh tính chuẩn: Messenger (PSID) và Pancake (`<page>_<PSID>`) ⇒ CÙNG một khoá, không chứa mã hội thoại.
  const page = "112233445566";
  const psid = "998877665544332";
  const month = meterMonthOf(now);
  const viaMessenger = { channel: "FANPAGE", pageId: page, threadId: psid, visitorKey: fanpageVisitorKey(page, psid) };
  const viaPancake = { channel: "FANPAGE", pageId: page, threadId: `${page}_${psid}`, visitorKey: fanpageVisitorKey(page, `${page}_${psid}`) };
  const km = aiCustomerKeys(month, viaMessenger)!;
  const kp = aiCustomerKeys(month, viaPancake)!;
  assert.equal(km.key, kp.key, "đổi đường nhận tin ⇒ cùng khoá");
  assert.ok(!km.key.includes(psid) && !km.key.includes(viaPancake.visitorKey) && !km.key.includes(viaMessenger.visitorKey), "khoá không chứa mã hội thoại / PSID thô");
  assert.ok(km.aliases.includes(aiCustomerEventKey({ month, channel: "FANPAGE", pageId: page, customerKey: viaPancake.visitorKey })!), "bí danh gồm khoá cũ của đường Pancake");
  assert.equal(canonicalAiCustomer({ channel: "FANPAGE", pageId: page, threadId: `${page}_111_222`, visitorKey: "vk-c" })?.kind, "THREAD", "hội thoại bình luận ⇒ không đoán PSID");
  assert.equal(canonicalAiCustomer({ channel: "FANPAGE", pageId: page, threadId: `999_${psid}`, visitorKey: "vk-x" })?.kind, "THREAD", "tiền tố khác page ⇒ không đoán");
  assert.equal(canonicalAiCustomer({ channel: "ZALO", pageId: "zalo:42", threadId: "u-1", visitorKey: "vk" })?.kind, "ZALO");
  assert.equal(canonicalAiCustomer({ channel: "WEB", pageId: null, threadId: null, visitorKey: "vk-web" })?.kind, "WEB");
  assert.equal(canonicalAiCustomer({ channel: "TEST", pageId: page, threadId: psid, visitorKey: "vk" }), null, "khung THỬ không là khách");
  assert.equal(aiCustomerKeyOf("2026-13", { page, kind: "PSID", id: psid }), null);
  for (const [pg, th] of [[page, psid], ["1", "1_2_3"], ["zalo:9", "u"]]) assert.equal(fanpageVisitorKeyMirror(pg, th), fanpageVisitorKey(pg, th), "bản sao khoá fanpage khớp hàm của kênh");
}

// ─────────────────────────── 2 · MÃ NGUỒN: mọi đường kích AI đi qua cổng ───────────────────────────

function testSource() {
  const goc = process.cwd();
  const read = (f: string) => readFileSync(path.join(goc, f), "utf8");
  const engine = read("lib/sales-chatbot/engine.ts");
  const body = (src: string, fn: string) => {
    const s = src.slice(src.indexOf(fn));
    return s.slice(0, s.indexOf("\n}\n"));
  };
  assert.match(body(engine, "async function chatTurnCore("), /salesAiPlanGate\(/, "lượt chat đi qua cổng gói");
  assert.match(body(engine, "export async function salesChatProvider("), /salesAiPlanGate\(/, "nhắc khách / học / ghi đơn đi qua cổng gói");
  assert.match(body(engine, "export async function describeCustomerImages("), /salesAiPlanGate\(/, "đọc ảnh đi qua cổng gói");
  // Cổng nằm TRƯỚC câu mẫu và câu ngoài giờ (bot không tự trả lời bằng bất cứ gì khi dừng).
  const core = body(engine, "async function chatTurnCore(");
  assert.ok(core.indexOf("salesAiPlanGate(") < core.indexOf("withinBusinessHours(") && core.indexOf("salesAiPlanGate(") < core.indexOf("quickReplyByKeyword("), "cổng trước câu ngoài giờ + câu mẫu");
  assert.ok(!/pauseBot:\s*true/.test(read("lib/pricing/versions.ts")), "ngưỡng không tắt bot gói trả phí");
  // Zalo + web ghi đồng hồ ở điểm gửi thành công.
  assert.match(read("lib/sales-chatbot/zalo.ts"), /aiTexts\.has\(r\.text\)[\s\S]{0,200}noteAiCustomerReply\(conv\.id/, "Zalo ghi đồng hồ sau khi gửi trọn câu AI");
  assert.match(read("lib/sales-chatbot/public.ts"), /aiTexts\?\.length[\s\S]{0,80}noteAiCustomerReply/, "web ghi đồng hồ khi trả câu AI");
  // Ngưỡng chạy trong lịch SẴN CÓ.
  assert.match(body(read("lib/sync/jobs.ts"), '"sales-health": {'), /runAiCustomerUsageAlerts\(/, "ngưỡng đi cùng job sales-health");
  assert.match(read("lib/saas/provisioning.ts"), /initWorkspaceBilling\(/, "cấp phát người vận hành gọi dịch vụ thu phí");
  assert.match(read("lib/onboarding/service.ts"), /initWorkspaceBilling\(/, "/start gọi CÙNG dịch vụ thu phí");
  assert.ok(!/14 ngày/.test(read("lib/onboarding/service.ts")) && !/14 NGÀY/.test(read("lib/billing/service.ts")), "không còn câu 14 ngày mâu thuẫn");
}

// ─────────────────────────── 3 · VÒNG THẬT ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformProvisioningJobs).where(like(schema.platformProvisioningJobs.idempotencyKey, "l5-%"));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, code));
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
      if (org.accountId) {
        const still = await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.accountId, org.accountId)).limit(1);
        if (!still.length) {
          await pdb.delete(schema.platformBillingStatements).where(eq(schema.platformBillingStatements.accountId, org.accountId));
          await pdb.delete(schema.platformAccounts).where(eq(schema.platformAccounts.id, org.accountId));
        }
      }
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  invalidateAiEntitlement();
  resetAiCustomerSeenForTests();
}

async function adminOf(code: string): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
  assert.ok(u);
  const org = await findOrganization(code);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: org?.name ?? code, isHome: false }, modules: [...(await getEnabledModules(code))] };
}

async function seedAiCustomers(org: string, n: number, at: Date, tag: string) {
  const pdb = await getPlatformDb();
  await pdb.execute(sql`
    insert into platform_usage_events (id, occurred_at, org_code, product_key, metric, quantity, unit, source, event_key, metadata)
    select gen_random_uuid()::text, ${at.toISOString()}::timestamptz, ${org}, 'chotdon', 'ai_customers', 1, 'khách AI', 'test', ${`aic:${meterMonthOf(at)}:seed-${tag}:`} || g::text, '{}'::jsonb
    from generate_series(1, ${n}) g`);
}

const counts = async (org: string, now: Date) => (await readAiCustomerCounts([org], usagePeriodOf(now).from, new Date(now.getTime() + 120_000))).get(org) ?? 0;

/** Mọi khoá (đệ quy) của một giá trị — để chứng minh màn khách không mang khoá nội bộ. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  return out;
}

async function run() {
  const now = new Date();
  const pdb = await getPlatformDb();
  const book = await loadPriceBook({ fresh: true });
  const catalog = currentCatalogVersion(book, now);
  assert.ok(catalog, "sổ giá có bảng giá niêm yết (0228)");
  const trialRow = priceOf(book, catalog.key, "trial")!.price;
  const growthRow = priceOf(book, catalog.key, "growth")!.price;
  assert.ok(trialRow.trialDays && typeof trialRow.included.aiCustomers === "number", "gói dùng thử khai số ngày + hạn mức khách AI");
  const trialIncluded = trialRow.included.aiCustomers as number;
  const calls = { n: 0 };
  const provider: AiProvider = {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      calls.n += 1;
      return { content: [{ type: "text", text: "Dạ chả cá thu bên em 280k/kg ạ." }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
  setSalesChatProviderForTests(() => provider);

  // ── A · Khởi tạo thu phí: ghim phiên bản hiện hành + kỳ + dùng thử theo PHIÊN BẢN.
  const init = await initWorkspaceBilling(T, { selfService: false, now });
  assert.equal(init.status, "DONE");
  assert.equal(init.pinnedVersion, catalog.key, "ghim bảng giá hiện hành");
  const pin = await pdb.query.platformPricePins.findFirst({ where: eq(schema.platformPricePins.orgCode, T) });
  assert.deepEqual([pin?.versionKey, pin?.source], [catalog.key, "PROVISIONING"]);
  const sub = await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, T) });
  const expectedEnd = trialEndFromLastDay(trialPaidThrough(vnDate(now), trialRow.trialDays))!;
  assert.equal(sub?.trialDays, trialRow.trialDays, "số ngày dùng thử chụp từ phiên bản giá");
  assert.equal(sub?.trialEndsAt?.getTime(), expectedEnd.getTime(), "mốc hết dùng thử = 00:00 VN sau ngày cuối");
  assert.equal(sub?.billingEnabled, false, "khách người vận hành tạo: chưa bật khoá chỉ xem");
  const again = await initWorkspaceBilling(T, { selfService: false, now: new Date(now.getTime() + 86_400_000) });
  assert.equal(again.created, false, "chạy lại không đổi điều khoản");
  assert.equal((await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, T) }))?.trialEndsAt?.getTime(), expectedEnd.getTime());

  // ── B · Cấp phát qua job (người vận hành) ⇒ bước BILLING chạy thật (trước đây SKIPPED).
  const job = await requestProvisioning(
    { kind: "CREATE_CUSTOMER", account: { code: "l5-acct", name: "Khách L5", accountType: "EXTERNAL" }, workspace: { code: W, name: "Shop L5 cấp phát", planKey: "trial", brand: "chotdon" }, products: ["chotdon"], admin: { email: `admin@${W}.local`, name: "QT" } },
    { actor: null, email: "op@l5.local", source: "TEST", idempotencyKey: "l5-create-w" },
  );
  assert.ok(!("error" in job), JSON.stringify(job));
  assert.equal(job.job.status, "SUCCEEDED", JSON.stringify(job.job.steps));
  const billingStep = (job.job.steps as { key: string; status: string }[]).find((s) => s.key === "BILLING");
  assert.equal(billingStep?.status, "DONE", "bước BILLING không còn SKIPPED");
  assert.equal((await pdb.query.platformPricePins.findFirst({ where: eq(schema.platformPricePins.orgCode, W) }))?.versionKey, catalog.key, "khách mới ghim V1");
  assert.ok((await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, W) }))?.trialEndsAt, "khách mới có mốc hết dùng thử");

  // ── C · DÙNG THỬ HẾT LƯỢT ⇒ AI dừng; hộp thư + gửi tay vẫn chạy.
  await withOrganization(T, () => setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }));
  invalidateAiEntitlement();
  assert.equal((await loadAiEntitlement(T, { fresh: true })).allowed, true, "dùng thử mới ⇒ AI chạy");
  await seedAiCustomers(T, trialIncluded - 1, now, "t");
  invalidateAiEntitlement(T);
  assert.equal((await loadAiEntitlement(T, { fresh: true })).allowed, true, `${trialIncluded - 1}/${trialIncluded} ⇒ còn lượt`);
  resetAiCustomerSeenForTests();
  assert.equal((await recordAiCustomer({ orgCode: T, channel: "WEB", pageId: null, customerKey: "vk-last", at: now })).recorded, true);
  // Không gọi invalidate tay: ghi khách AI mới tự quên đệm của cổng.
  const exhausted = await loadAiEntitlement(T);
  assert.deepEqual([exhausted.allowed, exhausted.reason], [false, "TRIAL_QUOTA_EXHAUSTED"], "đủ số gồm ⇒ hết lượt");
  await withOrganization(T, async () => {
    const callsBefore = calls.n;
    const test = await openConversation("TEST");
    const r = await chatTurn(test.id, "Chả cá bao nhiêu?", { channel: "TEST", actorId: null });
    assert.ok(!r.ok && r.error === AI_STOP_MESSAGE.TRIAL_QUOTA_EXHAUSTED, `khung thử nói câu hết lượt (${JSON.stringify(r)})`);
    const web = await openConversation("WEB", { visitorKey: "vk-web-t" });
    const botBefore = (await conversationView(web.id))!.messages.filter((m) => m.role === "assistant").length;
    const rw = await chatTurn(web.id, "Còn hàng không shop?", { channel: "WEB", visitorKey: "vk-web-t" });
    assert.ok(rw.ok, "web: không lộ lý do nội bộ cho khách lạ");
    assert.equal(rw.ok && rw.view.messages.filter((m) => m.role === "assistant").length, botBefore, "web: bot không trả lời thêm câu nào");
    assert.equal(rw.ok && rw.view.messages.some((m) => m.role === "user" && m.text.includes("Còn hàng")), true, "tin khách VẪN được ghi (hộp thư thấy)");
    assert.equal(calls.n, callsBefore, "không gọi model khi đã dừng");
    // Nhân viên gửi tay vẫn được.
    const sent = await sendStaffReplyCore(await adminOf(T), web.id, { text: "Dạ còn ạ, chị cần mấy ký?", requestKey: "l5-staff-0001" });
    assert.ok(sent.ok, `gửi tay vẫn chạy (${JSON.stringify(sent)})`);
    // Thanh trạng thái hộp thư nói đúng lý do (cùng hàm của cổng).
    await forgetAiStatus();
    const blocks = await conversationAiBlocks({ id: web.id, channel: "WEB", pageId: null, visitorKey: "vk-web-t", state: {} });
    assert.ok(blocks.some((b) => b.code === "TRIAL_QUOTA_EXHAUSTED" && b.reason === AI_STOP_MESSAGE.TRIAL_QUOTA_EXHAUSTED && b.fixHref === "/settings/plan"), JSON.stringify(blocks));
    // Ngưỡng 100%: báo ĐÚNG MỘT lần mỗi kỳ, kể cả lượt kiểm ngay sau (sát ranh giới giờ).
    const n1 = await runAiCustomerUsageAlerts(now);
    assert.equal(n1.sent, "limit", JSON.stringify(n1));
    assert.equal((await runAiCustomerUsageAlerts(now)).sent, null, "chạy lại ⇒ không báo lần hai");
    assert.equal((await runAiCustomerUsageAlerts(new Date(now.getTime() + 3_600_000))).sent, null, "lượt kiểm giờ sau ⇒ không báo lần hai");
    const rows = await (await getDb()).select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "pricing:ai-customers:%"));
    assert.equal(rows.length, 1, "một dòng chuông cho ngưỡng 100% của kỳ");
    assert.ok(!/token|usd|model/i.test(`${rows[0].title} ${rows[0].body}`));
  });
  // Dấu vết tin của kênh nhắn tin: ghi chú cổng gói ⇒ mã máy đọc được.
  assert.equal(classifyInboundNote(AI_STOP_NOTE.TRIAL_QUOTA_EXHAUSTED, { status: "SKIPPED", lastError: null, transport: "PANCAKE" })?.code, "AI_SKIPPED_TRIAL_QUOTA_EXHAUSTED");
  assert.equal(classifyInboundNote(AI_STOP_NOTE.TRIAL_EXPIRED, { status: "SKIPPED", lastError: null, transport: "ZALO" })?.code, "AI_SKIPPED_TRIAL_EXPIRED");

  // Màn khách: số đếm theo đơn vị khách hiểu, KHÔNG khoá nội bộ (duyệt đệ quy).
  const view = await loadCustomerEntitlementView(T, now);
  assert.ok(view);
  assert.equal(view.ai.state, "QUOTA_EXHAUSTED");
  assert.equal(view.aiCustomers.limit, trialIncluded);
  assert.equal(view.aiCustomers.used, trialIncluded);
  assert.equal(view.period.resetsOn, usagePeriodOf(now).resetsOn);
  assert.equal(view.trialEndsAt, expectedEnd.toISOString());
  const leaked = allKeys(view).filter((k) => /token|usd|cost|model|provider|margin|credit|price|vnd/i.test(k));
  assert.deepEqual(leaked, [], "màn khách không chứa trường nội bộ");

  // ── D · DÙNG THỬ HẾT HẠN (còn lượt) ⇒ AI dừng.
  await pdb.delete(schema.platformUsageEvents).where(eq(schema.platformUsageEvents.orgCode, T));
  invalidateAiEntitlement(T);
  assert.equal((await loadAiEntitlement(T, { fresh: true })).allowed, true, "xoá số dùng ⇒ còn lượt");
  await pdb.update(schema.platformSubscriptions).set({ trialEndsAt: new Date(now.getTime() - 60_000), trialStartedAt: new Date(now.getTime() - 8 * 86_400_000) }).where(eq(schema.platformSubscriptions.orgCode, T));
  invalidateSubscriptions(T);
  const expired = await loadAiEntitlement(T, { fresh: true });
  assert.deepEqual([expired.allowed, expired.reason], [false, "TRIAL_EXPIRED"]);
  await withOrganization(T, async () => {
    const test = await openConversation("TEST");
    const r = await chatTurn(test.id, "Alo shop", { channel: "TEST", actorId: null });
    assert.ok(!r.ok && r.error === AI_STOP_MESSAGE.TRIAL_EXPIRED, JSON.stringify(r));
  });
  assert.equal((await loadCustomerEntitlementView(T, now))?.ai.state, "TRIAL_EXPIRED");

  // ── E · GÓI TRẢ PHÍ vượt 100% ⇒ AI VẪN chạy + phần vượt đúng.
  await pdb.update(schema.platformOrganizations).set({ plan: "growth" }).where(eq(schema.platformOrganizations.code, P));
  invalidateOrganizations();
  invalidatePricing();
  await initWorkspaceBilling(P, { selfService: false, now });
  const growthInc = growthRow.included.aiCustomers as number;
  const block = growthRow.overage.aiCustomerBlockSize as number;
  const extra = Math.floor(block * 1.5);
  await seedAiCustomers(P, growthInc + extra, now, "p");
  invalidateAiEntitlement(P);
  const paid = await loadAiEntitlement(P, { fresh: true });
  assert.deepEqual([paid.allowed, paid.trial], [true, false], "gói trả phí vượt 100% ⇒ AI vẫn chạy");
  const used = (await readAiCustomerUsage([P], usagePeriodOf(now), now)).get(P)!;
  const ov = computeOverage(growthRow, { aiCustomers: used.value, aiCustomersCoverage: "MEASURED", fanpages: 0, users: 0, aiConversations: null, aiReplies: null });
  const line = ov.lines.find((l) => l.key === "aiCustomers")!;
  assert.deepEqual([line.overUnits, line.blocks, line.amountVnd], [extra, Math.ceil(extra / block), Math.ceil(extra / block) * (growthRow.overage.aiCustomerBlockVnd as number)], "phần vượt theo khối của phiên bản");
  await withOrganization(P, async () => {
    const before = calls.n;
    const test = await openConversation("TEST");
    const r = await chatTurn(test.id, "Chả cá bao nhiêu?", { channel: "TEST", actorId: null });
    assert.ok(r.ok && calls.n > before, `gói trả phí: model vẫn trả lời (${JSON.stringify(r)})`);
    assert.equal((await runAiCustomerUsageAlerts(now)).sent, "limit", "vượt 100% ⇒ báo bắt đầu tính phần vượt");
  });
  // Đình chỉ ⇒ AI dừng kể cả gói trả phí (cờ đình chỉ sẵn có).
  await pdb.update(schema.platformOrganizations).set({ status: "SUSPENDED" }).where(eq(schema.platformOrganizations.code, P));
  invalidateOrganizations();
  assert.equal((await loadAiEntitlement(P, { fresh: true })).reason, "WORKSPACE_SUSPENDED");
  await pdb.update(schema.platformOrganizations).set({ status: "ACTIVE" }).where(eq(schema.platformOrganizations.code, P));
  invalidateOrganizations();

  // ── F · HSLC-giống: gói `standard` ghim `legacy`, dùng rất nhiều ⇒ trước / sau đều CHO.
  await pdb.update(schema.platformOrganizations).set({ plan: "standard" }).where(eq(schema.platformOrganizations.code, L));
  invalidateOrganizations();
  invalidatePricing();
  await pinOrgPriceVersion(L, "legacy", { source: "TEST", reason: "Bài kiểm L5 — giống HSLC", email: null });
  assert.equal(priceOf(book, "legacy", "standard")?.price.trialDays ?? null, null, "dòng legacy của gói standard không có dùng thử");
  invalidateAiEntitlement(L);
  const before = await loadAiEntitlement(L, { fresh: true });
  await seedAiCustomers(L, 5_300, now, "l");
  invalidateAiEntitlement(L);
  const after = await loadAiEntitlement(L, { fresh: true });
  assert.deepEqual([before.allowed, after.allowed, after.trial, after.reason], [true, true, false, null], "giá cũ / trả phí: không bao giờ bị chặn vì hạn mức");
  await withOrganization(L, async () => {
    // HSLC chạy khoá AI riêng của shop (gói cũ không có credit AI dùng chung).
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true });
    const callsBefore = calls.n;
    const test = await openConversation("TEST");
    const r = await chatTurn(test.id, "Có giao Hải Phòng không?", { channel: "TEST", actorId: null });
    assert.ok(r.ok && calls.n > callsBefore, `HSLC-giống: model vẫn trả lời (${JSON.stringify(r).slice(0, 400)})`);
  });

  // ── G · ĐỒNG HỒ: cùng khách đổi đường giữa tháng ⇒ 1; tin tiếp không tăng; kỳ chuyển tiếp không đếm đôi.
  resetAiCustomerSeenForTests();
  const page = "556677889900";
  const psid = "123456789012345";
  const c0 = await counts(P, now);
  const viaPancake = { orgCode: P, channel: "FANPAGE", pageId: page, threadId: `${page}_${psid}`, customerKey: fanpageVisitorKey(page, `${page}_${psid}`), at: now };
  const viaMessenger = { orgCode: P, channel: "FANPAGE", pageId: page, threadId: psid, customerKey: fanpageVisitorKey(page, psid), at: now };
  assert.equal((await recordAiCustomer(viaPancake)).recorded, true);
  assert.equal((await recordAiCustomer(viaPancake)).recorded, false, "tin tiếp trong kỳ không tăng");
  assert.equal((await recordAiCustomer(viaMessenger)).recorded, false, "đổi sang Messenger giữa tháng ⇒ vẫn một khách");
  assert.equal(await counts(P, now), c0 + 1);
  // Kỳ chuyển tiếp: khách có dòng KHOÁ CŨ (trước bản này) ⇒ khoá mới là bí danh số lượng 0.
  const psid2 = "543210987654321";
  const oldKey = aiCustomerEventKey({ month: meterMonthOf(now), channel: "FANPAGE", pageId: page, customerKey: fanpageVisitorKey(page, `${page}_${psid2}`) })!;
  await pdb.execute(sql`insert into platform_usage_events (id, occurred_at, org_code, product_key, metric, quantity, unit, source, event_key, metadata) values (gen_random_uuid()::text, ${now.toISOString()}::timestamptz, ${P}, 'chotdon', 'ai_customers', 1, 'khách AI', 'sales_chatbot', ${oldKey}, '{}'::jsonb)`);
  const c1 = await counts(P, now);
  assert.equal((await recordAiCustomer({ ...viaMessenger, threadId: psid2, customerKey: fanpageVisitorKey(page, psid2) })).recorded, false, "đã đếm qua khoá cũ ⇒ không đếm lần hai");
  assert.equal((await recordAiCustomer({ ...viaPancake, threadId: `${page}_${psid2}`, customerKey: fanpageVisitorKey(page, `${page}_${psid2}`) })).recorded, false);
  assert.equal(await counts(P, now), c1, "kỳ chuyển tiếp: tổng không đổi");
  const alias = await pdb.select().from(schema.platformUsageEvents).where(and(eq(schema.platformUsageEvents.orgCode, P), like(schema.platformUsageEvents.eventKey, "aic:%"), eq(schema.platformUsageEvents.quantity, 0)));
  assert.equal(alias.length, 1, "đúng một dòng bí danh");
  assert.equal((alias[0].metadata as { aliasOf?: string }).aliasOf, oldKey);
  assert.ok((await pdb.select().from(schema.platformUsageEvents).where(eq(schema.platformUsageEvents.eventKey, oldKey))).length === 1, "dòng cũ giữ nguyên (không backfill)");

  // ── H · CHAT WEB ghi đồng hồ ở điểm trả câu AI (đường công khai thật).
  await pdb.update(schema.platformOrganizations).set({ publishState: "PUBLISHED", domainSlug: "l5-paid-shop" }).where(eq(schema.platformOrganizations.code, P));
  invalidateOrganizations();
  await withOrganization(P, () => setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }));
  setRequestHostSlugForTests(() => "l5-paid-shop");
  try {
    resetAiCustomerSeenForTests();
    const w0 = await counts(P, now);
    const opened = await startPublicChat("vk-web-visitor-1");
    assert.ok("ok" in opened, JSON.stringify(opened));
    const s1 = await sendPublicChat("vk-web-visitor-1", opened.view.conversationId, "Shop ơi chả cá bao nhiêu?");
    assert.ok("ok" in s1, JSON.stringify(s1));
    assert.equal(await counts(P, now), w0 + 1, "web: câu AI tới khách ⇒ 1 khách AI");
    const s2 = await sendPublicChat("vk-web-visitor-1", opened.view.conversationId, "Ship Hải Phòng bao lâu?");
    assert.ok("ok" in s2);
    assert.equal(await counts(P, now), w0 + 1, "web: tin tiếp cùng khách ⇒ vẫn 1");
  } finally {
    setRequestHostSlugForTests(null);
  }
}

export async function testSaasL5BillingTrial() {
  testPure();
  testSource();
  await cleanup();
  for (const code of [T, P, L]) await provisionOrganization({ code, name: `Tổ chức ${code}`, plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "SaasL5@123456" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    setSalesChatProviderForTests(null);
    setRequestHostSlugForTests(null);
    await cleanup();
  }
  console.log("✓ L5 dùng thử / hết lượt: dùng thử hết lượt hoặc hết hạn (cái nào tới trước) ⇒ AI dừng, hộp thư + gửi tay vẫn chạy · trả phí vượt 100% ⇒ AI chạy + phần vượt theo khối · đình chỉ ⇒ dừng · giống HSLC (legacy) không bị chặn · cấp phát ghim V1 + kỳ + mốc dùng thử (job + /start một dịch vụ) · ngưỡng báo một lần mỗi kỳ · khoá đồng hồ theo khách chuẩn (đổi đường = 1, kỳ chuyển tiếp không đếm đôi) · web ghi đồng hồ · màn khách không lộ trường nội bộ");
}
