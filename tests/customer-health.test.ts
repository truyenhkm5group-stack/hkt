/**
 * SỨC KHOẺ KHÁCH SAAS (sứ mệnh saas-customer-health, 08/10/2026) — `/platform/customers`.
 *
 *  1. THUẦN — `classifyWorkspace` / `classifyCustomer`: đủ dữ liệu + không gì chạm ngưỡng ⇒ KHOẺ; THIẾU bất kỳ tín hiệu bắt buộc
 *     nào — hoặc đọc được mà CHƯA ĐỦ để kết luận (nền tin khách ngắn, cửa sổ hoạt động chụp thiếu ngày, mốc kích hoạt không đọc
 *     được) ⇒ KHÔNG BAO GIỜ khoẻ (Chưa đủ dữ liệu); AI lỗi / bị chặn / bị tắt / im, mất kênh / chưa nối kênh / tin khách dừng (có
 *     nền) / không hoạt động, không đăng nhập lâu / chưa ai đăng nhập (kèm ân hạn, kèm mốc chỉ mục, kèm lời khuyên theo trạng thái
 *     kích hoạt), sắp chạm / vượt hạn mức (trả trước KHÔNG tính), AI ghi đơn hộ lỗi (tách khỏi lỗi trả lời — không đếm đôi, mốc
 *     phục hồi riêng), hết hạn / dùng thử hết hạn / quá hạn / dựng hỏng / đình chỉ / đã dừng ⇒ ĐÚNG mức + ĐÚNG lý do; tài khoản =
 *     lý do nặng nhất; nhãn một dòng bảng không nhẹ hơn lý do nó in; chữ in ra không mang tên bảng / tệp / từ kỹ thuật. Mốc thời
 *     gian dựng TỪ hằng chỉ mục / từ `now` truyền vào (luật 50) — không đồng hồ thật trong phần thuần.
 *  2. MÃ NGUỒN — đường đọc gom xuyên tổ chức chỉ được gọi sau cổng người vận hành (console.ts); hàm phân loại thuần không chạm
 *     CSDL / đồng hồ; đường đọc không mở CSDL tổ chức nào; ngưỡng LẤY LẠI từ hằng đang chạy (luật 22), ngưỡng khác đơn vị thì
 *     khai mặc định kỹ thuật; ⓘ không in tên bảng / đường dẫn tệp / số gõ tay.
 *  3. BỘ ĐỌC (không CSDL) — `readCustomerHealth` với bộ đọc giả: mỗi nguồn hỏng ⇒ không khoẻ + đúng chỗ chưa đo (khách AI theo
 *     kênh chỉ để in — khai rõ); mỗi bộ đọc gom gọi ĐÚNG MỘT lần với CẢ mảng mã (không N+1), module một lần mỗi workspace; mọi
 *     cửa sổ dựng từ `now` truyền vào (không đọc đồng hồ quanh nửa đêm).
 *  4. CSDL THẬT (PGlite) — ba tổ chức thử `skh-khoe` (Chốt Đơn chạy tốt) · `skh-hong` (AI lỗi + AI ghi đơn hộ lỗi + mất kênh) ·
 *     `skh-moi` (ERP, tạo 30 giờ, chưa ai đăng nhập): `loadCustomersConsole` ra đúng mức + lý do (mốc `now` truyền vào), trang
 *     chi tiết cùng mức và lời khuyên theo trạng thái kích hoạt; xem tiền kỳ trước vẫn ra sức khoẻ của HIỆN TẠI; một nguồn hỏng
 *     trên dữ liệu thật ⇒ không khoẻ; người không phải người vận hành bị từ chối; kết quả không mang tên page / email người nối.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { addDays, vnDate } from "@/lib/billing/rules";
import { DEFAULT_AI_SALES_SLO } from "@/lib/constants/ai-sales-slo";
import { CUSTOMER_HEALTH_LEVELS, CUSTOMER_HEALTH_THRESHOLDS, HEALTH_GAPS, HEALTH_REASONS, IDENTITY_INDEX_SINCE, USAGE_SNAPSHOT_EVERY_HOURS, worstLevel, type CustomerHealthLevel, type HealthGapCode, type HealthReasonCode } from "@/lib/constants/customer-health";
import { SESSION_ABSOLUTE_DAYS } from "@/lib/constants/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { SAAS_SNAPSHOT_JOB_EVERY_MS } from "@/lib/platform/saas-cockpit";
import { DEFAULT_USAGE_ALERTS, type PriceBook } from "@/lib/pricing/versions";
import { accountOfWorkspace } from "@/lib/saas/accounts";
import { loadCustomerDetail, loadCustomersConsole } from "@/lib/saas/console";
import { classifyCustomer, classifyWorkspace, rowLevel, type AccountHealthInput, type AiLedgerSignal, type CustomerHealth, type HealthReason, type UsageDaySignal, type WorkspaceHealthInput } from "@/lib/saas/customer-health";
import { DEFAULT_SIGNAL_READERS, readCustomerHealth, type SignalReaders } from "@/lib/saas/customer-signals";
import type { CustomerView } from "@/lib/saas/customers";
import { currentPeriodMonth } from "@/lib/saas/ledger";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = CUSTOMER_HEALTH_THRESHOLDS;

// ═══════════ 1 · THUẦN ═══════════

/** `now` của phần thuần dựng TỪ hằng chỉ mục đăng nhập (luật 50): 20 ngày sau ngày chỉ mục bắt đầu. */
const INDEX_START = new Date(`${IDENTITY_INDEX_SINCE}T00:00:00+07:00`);
const NOW = new Date(INDEX_START.getTime() + 20 * DAY + 10 * HOUR);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** Sổ AI khoẻ. Mặc định lượt TRẢ LỜI = mọi lượt (không lượt ghi đơn hộ nào hỏng); ca nào tách hai loại thì khai tường minh. */
function aiOk(over: Partial<AiLedgerSignal> = {}): AiLedgerSignal {
  const base = { okInWindow: 4, errorsInWindow: 0, blockedInWindow: 0, ok24h: 50, errors24h: 0, blocked24h: 0, ok7d: 300, lastOkAt: ago(5 * 60_000) as Date | null, lastErrorAt: null as Date | null, orderSyncErrors24h: 0, orderSyncErrorsInWindow: 0, orderSyncLastOkAt: ago(HOUR) as Date | null, orderSyncLastErrorAt: null as Date | null, ...over };
  return {
    ...base,
    chatLastOkAt: "chatLastOkAt" in over ? (over.chatLastOkAt ?? null) : base.lastOkAt,
    chatLastErrorAt: "chatLastErrorAt" in over ? (over.chatLastErrorAt ?? null) : base.lastErrorAt,
    chatOk24h: over.chatOk24h ?? base.ok24h,
    chatOk7d: over.chatOk7d ?? base.ok7d,
  };
}

/** `n` ngày sổ dùng tới HÔM NAY của `NOW` (cũ trước), mỗi ngày như `day(i)` (i = 0 là hôm nay). */
function ledger(n: number, day: (i: number) => Partial<UsageDaySignal> = () => ({})): UsageDaySignal[] {
  const today = vnDate(NOW);
  return Array.from({ length: n }, (_, k) => n - 1 - k).map((i) => ({ day: addDays(today, -i), conversationsStarted: 5, customerMessages: 20, botMessages: 18, aiOrders: 1, fanpagesActive: 1, capturedAt: ago(2 * HOUR), ...day(i) }));
}

/** Workspace Chốt Đơn chạy tốt: mọi tín hiệu đọc được, không gì chạm ngưỡng. */
function healthyWs(over: Partial<WorkspaceHealthInput> = {}): WorkspaceHealthInput {
  return {
    code: "ws-a",
    name: "Shop A",
    isHome: false,
    orgStatus: "ACTIVE",
    createdAt: ago(20 * DAY),
    subscriptions: [{ productKey: "chotdon", status: "ACTIVE" }],
    hadEndedSubscriptions: false,
    everPaid: true,
    modules: { aiSales: true, legacyChatbot: false },
    login: { identities: 2, lastLoginAt: ago(2 * DAY) },
    messengerPages: 1,
    aiSwitch: { platformEnabled: true, orgDisabled: false },
    ai: aiOk(),
    usage: ledger(10),
    milestones: { channelConnectedAt: ago(19 * DAY), firstAiReplyAt: ago(18 * DAY), firstAiOrderAt: ago(17 * DAY) },
    aiCustomers: { value: 40, coverage: "MEASURED", included: 100, alerts: DEFAULT_USAGE_ALERTS, prepaid: false },
    overageSeats: [],
    fairUseFlagged: false,
    ...over,
  };
}

function erpWs(over: Partial<WorkspaceHealthInput> = {}): WorkspaceHealthInput {
  return healthyWs({ code: "ws-erp", subscriptions: [{ productKey: "erp", status: "ACTIVE" }], ai: null, usage: null, modules: { aiSales: false, legacyChatbot: false }, aiCustomers: null, milestones: null, ...over });
}

function account(workspaces: WorkspaceHealthInput[], over: Partial<AccountHealthInput> = {}): AccountHealthInput {
  return { accountStatus: "ACTIVE", failedJobs: 0, revenueVnd: 499_000, grossProfitVnd: 300_000, workspaces, ...over };
}

const codes = (w: { reasons: { code: HealthReasonCode }[] }) => w.reasons.map((r) => r.code).sort();
const gapCodes = (w: { gaps: { code: HealthGapCode }[] }) => w.gaps.map((g) => g.code).sort();

/** Chữ in ra màn hình: không tên bảng / tệp / mã kỹ thuật (review #683 mục 8) — nguồn kỹ thuật chỉ ở `source` của bảng khai. */
const TECH = /platform_|\b[a-z]+_[a-z_]+\b|\.tsx?\b|webhook|container|runtime|ORDER_OUTCOME|#\d{3}/;

function expectWs(label: string, input: WorkspaceHealthInput, level: CustomerHealthLevel, reasons: HealthReasonCode[] = [], gaps?: HealthGapCode[], now: Date = NOW) {
  const r = classifyWorkspace(input, now);
  assert.equal(r.level, level, `${label}: mức ${r.level} ≠ ${level} — ${JSON.stringify(r.reasons.map((x) => x.text))} ${JSON.stringify(r.gaps.map((g) => g.code))}`);
  assert.deepEqual(codes(r), [...reasons].sort(), `${label}: lý do`);
  if (gaps) assert.deepEqual(gapCodes(r), [...gaps].sort(), `${label}: chỗ chưa đo`);
  for (const x of r.reasons) {
    assert.equal(x.level, HEALTH_REASONS[x.code].level, `${label}: mức của lý do ${x.code} lấy từ bảng khai`);
    assert.ok(x.text.length >= 10, `${label}: lý do ${x.code} phải là câu cụ thể`);
    // Bằng chứng gọn in cạnh nhãn trong ô bảng (~210 px): có số / mốc, đủ ngắn để không cắt mất ý.
    assert.ok(x.short.length >= 2 && x.short.length <= 48, `${label}: bằng chứng gọn của ${x.code} dài ${x.short.length} ký tự: «${x.short}»`);
    assert.ok(!TECH.test(x.text) && !TECH.test(x.short), `${label}: lý do ${x.code} in chữ kỹ thuật: «${x.short}» / «${x.text}»`);
  }
  for (const g of r.gaps) assert.ok(!TECH.test(g.text), `${label}: chỗ chưa đo ${g.code} in chữ kỹ thuật: «${g.text}»`);
  if (level === "INACTIVE") assert.ok(r.inactiveReason && r.inactiveReason.length >= 10, `${label}: «Đã dừng» phải nói vì sao`);
  else assert.equal(r.inactiveReason, null, `${label}: chỉ «Đã dừng» mới mang câu vì sao dừng`);
  return r;
}

function testPure() {
  // Đủ dữ liệu, không gì chạm ngưỡng ⇒ KHOẺ (cả Chốt Đơn lẫn ERP chỉ đo được đăng nhập).
  const ok = expectWs("Chốt Đơn chạy tốt", healthyWs(), "HEALTHY", [], []);
  assert.equal(ok.facts.ai.state, "ON");
  assert.equal(ok.facts.fanpagesActive, 1);
  assert.equal(ok.facts.orders.lastAiOrderDay, vnDate(NOW));
  assert.equal(ok.facts.usage.pct, 40);
  assert.equal(ok.facts.lastActivity?.kind, "AI_CALL", "hoạt động cuối = mốc gần nhất có chứng cứ");
  assert.equal(ok.facts.aiCustomerChannels, null, "chưa truyền khách AI theo kênh ⇒ chưa biết, không phải «0 kênh»");
  assert.equal(ok.facts.usage.conversations, null, "chưa truyền hội thoại kỳ ⇒ chưa biết");
  const ch = classifyWorkspace(healthyWs({ aiCustomerChannels: { ZALO: 3, FANPAGE: 12 }, periodConversations: 33 }), NOW);
  assert.deepEqual(ch.facts.aiCustomerChannels, [{ channel: "FANPAGE", customers: 12 }, { channel: "ZALO", customers: 3 }], "theo kênh, nhiều trước");
  assert.equal(ch.facts.usage.conversations, 33);
  assert.equal(ch.level, "HEALTHY", "khách AI theo kênh / hội thoại kỳ chỉ để in — không đổi mức");
  expectWs("ERP đăng nhập 2 ngày", erpWs(), "HEALTHY", [], []);
  expectWs("ERP: nguồn của Chốt Đơn hỏng không áp dụng", erpWs({ ai: null, usage: null, milestones: null, modules: null, aiSwitch: null }), "HEALTHY", [], []);
  assert.deepEqual(classifyWorkspace(healthyWs(), NOW), classifyWorkspace(healthyWs(), NOW), "chạy hai lần ra một kết quả");

  // THIẾU ⇒ KHÔNG BAO GIỜ KHOẺ.
  expectWs("không đọc được đăng nhập", healthyWs({ login: null }), "UNKNOWN", [], ["LOGIN_UNREADABLE"]);
  expectWs("không đọc được sổ AI", healthyWs({ ai: null }), "UNKNOWN", [], ["AI_LEDGER_UNREADABLE"]);
  expectWs("không đọc được sổ dùng", healthyWs({ usage: null }), "UNKNOWN", [], ["USAGE_LEDGER_UNREADABLE"]);
  expectWs("sổ dùng chưa có ngày nào", healthyWs({ usage: [] }), "UNKNOWN", [], ["USAGE_LEDGER_MISSING"]);
  expectWs("sổ dùng cũ", healthyWs({ usage: ledger(10, () => ({ capturedAt: ago((T.usageLedgerFreshHours + 1) * HOUR) })) }), "UNKNOWN", [], ["USAGE_LEDGER_STALE"]);
  expectWs("không đọc được module", healthyWs({ modules: null }), "UNKNOWN", [], ["MODULES_UNREADABLE"]);
  expectWs("không đọc được công tắc AI", healthyWs({ aiSwitch: null }), "UNKNOWN", [], ["AI_SWITCH_UNREADABLE"]);
  expectWs("không đọc được mốc kích hoạt (dù AI đang chạy)", healthyWs({ milestones: null }), "UNKNOWN", [], ["MILESTONES_UNREADABLE"]);
  expectWs("bot đời cũ", healthyWs({ modules: { aiSales: false, legacyChatbot: true } }), "UNKNOWN", [], ["AI_RUNTIME_LEGACY"]);
  // Thiếu dữ liệu KHÔNG che lý do: có lý do thì mức theo lý do, chỗ chưa đo vẫn được nói ra.
  const mixed = expectWs("thiếu sổ dùng + AI đang lỗi", healthyWs({ usage: null, ai: aiOk({ errorsInWindow: 3, okInWindow: 0, lastErrorAt: ago(60_000), lastOkAt: ago(30 * 60_000) }) }), "CRITICAL", ["AI_FAILING"], ["USAGE_LEDGER_UNREADABLE"]);
  assert.ok(mixed.reasons[0].text.includes(`${T.aiFailWindowMinutes} phút`));

  // ── Ba đường «đọc được mà chưa đủ để kết luận» (review #683 BLOCKER 1) — chỗ chưa đo, KHÔNG im lặng thành «Khoẻ».
  // (a) 0 tin khách những ngày gần nhất, nền dưới số ngày tối thiểu.
  const shortBase = ledger(10, (i) => (i <= 1 ? { customerMessages: 0, botMessages: 0 } : {})).filter((_, k, all) => k >= all.length - (T.inboundDropDays + T.inboundBaselineMinDays - 1));
  expectWs("nền dưới số ngày tối thiểu ⇒ chưa đủ dữ liệu", healthyWs({ usage: shortBase }), "UNKNOWN", [], ["INBOUND_BASELINE_SHORT"]);
  expectWs("ngày gần nhất chưa chụp, các ngày đã chụp 0 tin ⇒ chưa đủ dữ liệu", healthyWs({ usage: ledger(10, (i) => (i === 1 ? { customerMessages: 0 } : {})).filter((r) => r.day !== vnDate(NOW)) }), "UNKNOWN", [], ["INBOUND_BASELINE_SHORT"]);
  expectWs("đủ nền, nền thấp ⇒ 0 tin là bình thường", healthyWs({ usage: ledger(10, (i) => (i <= 1 ? { customerMessages: 0, botMessages: 0 } : { customerMessages: 1, botMessages: 1 })) }), "HEALTHY", [], []);
  // (b) Không tin khách + không lượt AI, cửa sổ chụp dưới số ngày tối thiểu.
  const sparse = ledger(3, () => ({ customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 }));
  const aiIdle = aiOk({ ok7d: 0, ok24h: 0, okInWindow: 0, lastOkAt: null });
  expectWs("cửa sổ hoạt động chụp thiếu ngày ⇒ chưa đủ dữ liệu", healthyWs({ usage: sparse, ai: aiIdle }), "UNKNOWN", [], ["ACTIVITY_WINDOW_SHORT", "INBOUND_BASELINE_SHORT"]);
  // (c) Mốc kích hoạt không đọc được, AI không lượt nào, page vẫn bật (KHÔNG phải nhánh 0 fanpage).
  const quiet = ledger(10, () => ({ customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 }));
  expectWs("mốc không đọc được + AI im + không tin khách ⇒ chưa đủ dữ liệu", healthyWs({ milestones: null, ai: aiIdle, usage: quiet }), "UNKNOWN", [], ["MILESTONES_UNREADABLE"]);
  expectWs("mốc không đọc được + khách nhắn mà AI im cả tuần ⇒ bot im (sự việc đúng dù chưa rõ đã kích hoạt chưa)", healthyWs({ milestones: null, ai: aiIdle }), "NEEDS_ATTENTION", ["AI_SILENT"], ["MILESTONES_UNREADABLE"]);

  // AI.
  expectWs("AI bị tắt riêng tổ chức", healthyWs({ aiSwitch: { platformEnabled: true, orgDisabled: true } }), "CRITICAL", ["AI_OFF"]);
  expectWs("AI bị tắt toàn nền tảng", healthyWs({ aiSwitch: { platformEnabled: false, orgDisabled: false } }), "CRITICAL", ["AI_OFF"]);
  const blocked = expectWs("AI bị chặn hạn mức liên tục", healthyWs({ ai: aiOk({ blockedInWindow: 3, blocked24h: 3, lastErrorAt: ago(60_000), lastOkAt: ago(HOUR) }) }), "CRITICAL", ["AI_FAILING"]);
  assert.ok(blocked.reasons[0].text.includes("bị chặn"), "nói đúng nguyên nhân: bị chặn, không phải lỗi nhà cung cấp");
  expectWs("AI lỗi đã phục hồi nhưng tỷ lệ cao", healthyWs({ ai: aiOk({ ok24h: 40, errors24h: 10, lastErrorAt: ago(2 * HOUR), lastOkAt: ago(60_000) }) }), "NEEDS_ATTENTION", ["AI_ERRORS_RECENT"]);
  expectWs("AI lỗi chưa phục hồi (dưới ngưỡng đang lỗi)", healthyWs({ ai: aiOk({ errors24h: 2, errorsInWindow: 1, lastErrorAt: ago(60_000), lastOkAt: ago(HOUR) }) }), "NEEDS_ATTENTION", ["AI_ERRORS_RECENT"]);
  expectWs("một lượt lỗi lẻ đã phục hồi ⇒ không lý do", healthyWs({ ai: aiOk({ errors24h: 1, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000) }) }), "HEALTHY");
  expectWs("tỷ lệ cao nhưng dưới mẫu tối thiểu", healthyWs({ ai: aiOk({ ok24h: 5, errors24h: 2, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000) }) }), "HEALTHY");
  expectWs("AI bị chặn rải rác", healthyWs({ ai: aiOk({ blocked24h: 2, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000) }) }), "NEEDS_ATTENTION", ["AI_BLOCKED_QUOTA"]);

  // AI ghi đơn hộ — lượt đọc hội thoại để ghi đơn hộ cũng là lượt AI bán hàng: lỗi của nó KHÔNG đếm lần hai thành «AI lỗi», và mốc
  // phục hồi của hai loại lượt đọc RIÊNG (review #683 mục 2 · 3).
  const syncBurst = expectWs(
    "AI ghi đơn hộ lỗi liên tục ⇒ Cần chú ý (lượt sau đọc lại), không phải Nguy cấp",
    healthyWs({ ai: aiOk({ errors24h: 3, errorsInWindow: 3, orderSyncErrors24h: 3, orderSyncErrorsInWindow: 3, lastErrorAt: ago(60_000), lastOkAt: ago(10 * 60_000), chatLastErrorAt: null, chatLastOkAt: ago(10 * 60_000), orderSyncLastErrorAt: ago(60_000), orderSyncLastOkAt: ago(2 * HOUR) }) }),
    "NEEDS_ATTENTION",
    ["ORDER_SYNC_ERRORS"],
  );
  assert.equal(syncBurst.reasons[0].short, `3 lượt / ${T.aiFailWindowMinutes} phút`);
  assert.ok(syncBurst.reasons[0].text.includes("đọc hội thoại để ghi đơn hộ") && syncBurst.reasons[0].text.includes("lượt sau đọc lại"), syncBurst.reasons[0].text);
  assert.equal(HEALTH_REASONS.ORDER_SYNC_ERRORS.label, "AI ghi đơn hộ lỗi");
  assert.ok(/lỗi lưu đơn/.test(HEALTH_REASONS.ORDER_SYNC_ERRORS.source) && /chặn hạn mức/.test(HEALTH_REASONS.ORDER_SYNC_ERRORS.source), "nguồn khai rõ: không gồm lỗi lưu đơn và lượt bị chặn");
  const syncOld = expectWs("AI ghi đơn hộ lỗi đã phục hồi", healthyWs({ ai: aiOk({ errors24h: 2, orderSyncErrors24h: 2, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000), chatLastErrorAt: null, orderSyncLastErrorAt: ago(3 * HOUR), orderSyncLastOkAt: ago(HOUR) }) }), "NEEDS_ATTENTION", ["ORDER_SYNC_ERRORS"]);
  assert.ok(syncOld.reasons[0].short.endsWith("/ 24 giờ") && syncOld.reasons[0].text.includes("đã có lượt thành công"));
  expectWs(
    "lượt ghi đơn hộ OK SAU lỗi trả lời không làm trả lời trông như đã khỏi",
    healthyWs({ ai: aiOk({ errorsInWindow: 3, errors24h: 3, okInWindow: 1, lastOkAt: ago(30_000), lastErrorAt: ago(60_000), chatLastOkAt: ago(30 * 60_000), chatLastErrorAt: ago(60_000), orderSyncLastOkAt: ago(30_000) }) }),
    "CRITICAL",
    ["AI_FAILING"],
  );
  const syncStuck = expectWs(
    "lượt trả lời OK SAU lỗi ghi đơn hộ không làm ghi đơn hộ trông như đã khỏi",
    healthyWs({ ai: aiOk({ errors24h: 3, errorsInWindow: 3, orderSyncErrors24h: 3, orderSyncErrorsInWindow: 3, lastOkAt: ago(30_000), lastErrorAt: ago(60_000), chatLastOkAt: ago(30_000), chatLastErrorAt: null, orderSyncLastErrorAt: ago(60_000), orderSyncLastOkAt: ago(2 * HOUR) }) }),
    "NEEDS_ATTENTION",
    ["ORDER_SYNC_ERRORS"],
  );
  assert.ok(syncStuck.reasons[0].short.endsWith(`/ ${T.aiFailWindowMinutes} phút`), "ghi đơn hộ chưa phục hồi ⇒ nói theo cửa sổ, không theo 24 giờ");
  // Cửa sổ «AI đang lỗi» chỉ đếm lỗi TRẢ LỜI: 2 lỗi trả lời + 2 lỗi ghi đơn hộ trong cửa sổ KHÔNG thành 3 lượt trả lời hỏng.
  expectWs(
    "lỗi ghi đơn hộ không cộng vào cửa sổ «AI đang lỗi»",
    healthyWs({ ai: aiOk({ errorsInWindow: 4, errors24h: 4, orderSyncErrorsInWindow: 2, orderSyncErrors24h: 2, lastErrorAt: ago(60_000), lastOkAt: ago(30 * 60_000), orderSyncLastErrorAt: ago(60_000), orderSyncLastOkAt: ago(HOUR) }) }),
    "NEEDS_ATTENTION",
    ["AI_ERRORS_RECENT", "ORDER_SYNC_ERRORS"],
  );
  const facts = classifyWorkspace(healthyWs({ ai: aiOk({ ok24h: 60, chatOk24h: 45, lastOkAt: ago(30_000), chatLastOkAt: ago(5 * 60_000) }) }), NOW).facts.ai;
  assert.deepEqual([facts.ok24h, facts.lastOkAt?.getTime()], [45, ago(5 * 60_000).getTime()], "ô AI in lượt TRẢ LỜI, không gồm lượt ghi đơn hộ");

  // Bot im: ngày có ≥ N tin khách, 0 tin bot, trước đó bot vẫn trả lời.
  const silent = expectWs("bot im hôm nay", healthyWs({ usage: ledger(10, (i) => (i === 0 ? { customerMessages: 6, botMessages: 0 } : {})) }), "NEEDS_ATTENTION", ["AI_SILENT"]);
  assert.ok(silent.reasons[0].text.includes("6 tin") && silent.reasons[0].text.includes(`${T.activityWindowDays} ngày trước đó`));
  expectWs("dưới ngưỡng tin khách / ngày ⇒ không im", healthyWs({ usage: ledger(10, (i) => (i === 0 ? { customerMessages: T.aiSilentMinCustomerMessagesPerDay - 1, botMessages: 0 } : {})) }), "HEALTHY");
  expectWs("bot chưa từng trả lời trong 7 ngày nhưng sổ AI có lượt ⇒ không gọi là im", healthyWs({ usage: ledger(10, () => ({ botMessages: 0 })), ai: aiOk({ ok7d: 3 }) }), "HEALTHY");
  expectWs("AI bị tắt đã giải thích im lặng", healthyWs({ aiSwitch: { platformEnabled: true, orgDisabled: true }, usage: ledger(10, (i) => (i === 0 ? { customerMessages: 6, botMessages: 0 } : {})) }), "CRITICAL", ["AI_OFF"]);
  // Chỉ có lượt AI ghi đơn hộ OK mà bot không trả lời ai cả tuần, khách vẫn nhắn ⇒ bot im, không phải Khoẻ (re-review #683 F1).
  const syncOnly = expectWs("chỉ lượt ghi đơn hộ OK, bot không trả lời cả tuần ⇒ bot im", healthyWs({ ai: aiOk({ ok7d: 12, chatOk7d: 0, ok24h: 2, chatOk24h: 0, okInWindow: 0, lastOkAt: ago(HOUR), chatLastOkAt: ago(10 * DAY) }), usage: ledger(10, () => ({ botMessages: 0 })) }), "NEEDS_ATTENTION", ["AI_SILENT"], []);
  assert.ok(syncOnly.reasons[0].text.includes("chỉ có lượt AI ghi đơn hộ") && syncOnly.reasons[0].text.includes("nếu không cố ý tắt bot"), syncOnly.reasons[0].text);
  const longSilent = expectWs("đã kích hoạt, khách vẫn nhắn mà AI không lượt nào cả tuần ⇒ bot im", healthyWs({ ai: aiIdle, usage: ledger(10, () => ({ botMessages: 0, aiOrders: 0 })) }), "NEEDS_ATTENTION", ["AI_SILENT"], []);
  assert.ok(longSilent.reasons[0].text.includes(`${T.activityWindowDays} ngày`));

  // Kênh.
  const lost = ledger(10, (i) => (i <= 1 ? { fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 } : {}));
  expectWs("mất kênh: 0 fanpage + tin khách dừng", healthyWs({ usage: lost }), "CRITICAL", ["CHANNEL_LOST"]);
  expectWs("0 fanpage nhưng khách vẫn nhắn qua kênh khác", healthyWs({ usage: ledger(10, (i) => (i <= 1 ? { fanpagesActive: 0 } : {})) }), "NEEDS_ATTENTION", ["FANPAGE_OFF"]);
  expectWs("kết nối đơn cũ (fanpage chưa đếm được) ⇒ không kết luận", healthyWs({ usage: ledger(10, () => ({ fanpagesActive: null })) }), "HEALTHY");
  const never = { messengerPages: 0, milestones: { channelConnectedAt: null, firstAiReplyAt: null, firstAiOrderAt: null }, ai: aiIdle, usage: ledger(5, () => ({ fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 })) };
  expectWs("chưa nối kênh sau ân hạn", healthyWs({ ...never, createdAt: ago(5 * DAY) }), "NEEDS_ATTENTION", ["NO_CHANNEL"]);
  expectWs("chưa nối kênh trong ân hạn ⇒ đang thiết lập, KHÔNG khoẻ", healthyWs({ ...never, createdAt: ago(2 * HOUR), usage: ledger(1, () => ({ fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0 })) }), "UNKNOWN", [], ["NEW_WORKSPACE_PENDING"]);
  // Mốc không đọc được ⇒ không phân biệt chưa nối / mất kênh; nền tin khách 5 ngày cũng chưa đủ để nói tin đã dừng — hai chỗ chưa đo.
  expectWs("không đọc được mốc ⇒ không phân biệt chưa nối / mất kênh", healthyWs({ ...never, milestones: null, createdAt: ago(5 * DAY) }), "UNKNOWN", [], ["INBOUND_BASELINE_SHORT", "MILESTONES_UNREADABLE"]);

  // Tin khách dừng (luật 52): có nền ⇒ cần chú ý.
  const drop = ledger(10, (i) => (i <= 1 ? { customerMessages: 0, botMessages: 0 } : {}));
  expectWs("tin khách dừng có nền", healthyWs({ usage: drop }), "NEEDS_ATTENTION", ["INBOUND_DROP"]);

  // Kích hoạt / không hoạt động.
  expectWs(
    "chưa kích hoạt sau ân hạn (khách nhắn, AI chưa từng trả lời)",
    healthyWs({ milestones: { channelConnectedAt: ago(5 * DAY), firstAiReplyAt: null, firstAiOrderAt: null }, ai: aiIdle, usage: ledger(6, () => ({ botMessages: 0, aiOrders: 0 })), createdAt: ago(6 * DAY) }),
    "NEEDS_ATTENTION",
    ["NOT_ACTIVATED"],
  );
  expectWs("mốc chưa quét kịp nhưng sổ AI đã có lượt thành công ⇒ đã chạy", healthyWs({ milestones: { channelConnectedAt: ago(5 * DAY), firstAiReplyAt: null, firstAiOrderAt: null } }), "HEALTHY");
  expectWs("không hoạt động 7 ngày (đã từng chạy, đủ ngày chụp)", healthyWs({ usage: quiet, ai: aiOk({ ok7d: 0, ok24h: 0, okInWindow: 0, lastOkAt: ago(9 * DAY) }) }), "NEEDS_ATTENTION", ["NO_ACTIVITY"]);

  // Đăng nhập: chỉ kết luận khi MỌI phiên chắc chắn đã hết hạn (trần tuyệt đối của phiên).
  expectWs("không đăng nhập quá trần phiên", healthyWs({ login: { identities: 2, lastLoginAt: ago((T.loginStaleDays + 1) * DAY) } }), "NEEDS_ATTENTION", ["LOGIN_STALE"]);
  expectWs("đăng nhập 20 ngày — phiên trượt có thể còn ⇒ không kết luận", healthyWs({ login: { identities: 2, lastLoginAt: ago(20 * DAY) } }), "HEALTHY");
  const neutral = expectWs("chưa ai đăng nhập sau ân hạn (danh sách: không nạp kích hoạt)", erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: ago(3 * DAY) }), "NEEDS_ATTENTION", ["NEVER_LOGGED_IN"]);
  assert.ok(neutral.reasons[0].text.includes("mở trang khách"), "danh sách không đoán trạng thái kích hoạt — chỉ đường tới trang khách");
  // Trang một khách nạp trạng thái kích hoạt ⇒ lời khuyên đúng việc (review #683 mục 16).
  const advice = (state: "ACTIVATED" | "PENDING" | "EXPIRED" | "NO_LINK" | "NO_ADMIN" | "DISABLED" | "UNKNOWN") =>
    classifyWorkspace(erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: ago(3 * DAY), activation: { state, activatedAt: state === "ACTIVATED" ? ago(2 * DAY).toISOString() : null, linkExpiresAt: state === "PENDING" ? ago(-HOUR).toISOString() : null } }), NOW).reasons[0];
  assert.match(advice("PENDING").text, /gửi lại liên kết kích hoạt/);
  assert.match(advice("EXPIRED").text, /hết hạn — gửi lại liên kết kích hoạt/);
  assert.match(advice("NO_LINK").text, /gửi lại liên kết kích hoạt/);
  assert.match(advice("ACTIVATED").text, /nhắc khách đăng nhập bằng email/);
  assert.ok(!/gửi lại/.test(advice("ACTIVATED").text), "đã kích hoạt ⇒ không khuyên gửi lại liên kết (đó là liên kết đặt lại mật khẩu)");
  assert.match(advice("NO_ADMIN").text, /job cấp phát/);
  assert.match(advice("DISABLED").text, /mở khoá/);
  assert.equal(advice("UNKNOWN").code, "NEVER_LOGGED_IN");
  expectWs("chưa ai đăng nhập trong ân hạn ⇒ đang thiết lập", erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: ago(2 * HOUR) }), "UNKNOWN", [], ["NEW_WORKSPACE_PENDING"]);
  // Có từ TRƯỚC chỉ mục: vắng dòng chỉ chứng minh «không đăng nhập từ ngày chỉ mục»; còn trong trần phiên ⇒ chưa biết.
  const old = erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: new Date(INDEX_START.getTime() - 30 * DAY) });
  expectWs("trước chỉ mục + còn trong trần phiên ⇒ chưa biết", old, "UNKNOWN", [], ["LOGIN_BEFORE_INDEX"], new Date(INDEX_START.getTime() + 10 * DAY));
  expectWs("quá trần phiên kể từ ngày chỉ mục ⇒ chắc chắn không ai đang dùng", old, "NEEDS_ATTENTION", ["LOGIN_STALE"], [], new Date(INDEX_START.getTime() + (T.loginStaleDays + 1) * DAY));

  // Hạn mức: ngưỡng cảnh báo của phiên bản giá; trả trước theo khách AI (gồm 0 theo thiết kế) KHÔNG phải vượt.
  const ac = (over: Partial<NonNullable<WorkspaceHealthInput["aiCustomers"]>>) => ({ aiCustomers: { value: 40, coverage: "MEASURED" as const, included: 100, alerts: DEFAULT_USAGE_ALERTS, prepaid: false, ...over } });
  const over = expectWs("vượt hạn mức khách AI", healthyWs(ac({ value: 130 })), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"]);
  assert.ok(over.reasons[0].text.includes("130/100"));
  const near = expectWs("chạm ngưỡng báo người vận hành (80%) ⇒ SẮP chạm, không phải vượt", healthyWs(ac({ value: 85 })), "NEEDS_ATTENTION", ["USAGE_NEAR_LIMIT"]);
  assert.ok(!/vượt/i.test(near.reasons[0].text) && near.reasons[0].short === "85/100 (85%)", near.reasons[0].text);
  assert.ok(!/vượt/i.test(HEALTH_REASONS.USAGE_NEAR_LIMIT.label));
  expectWs("gói không gồm khách AI mà có khách", healthyWs(ac({ value: 3, included: 0 })), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"]);
  expectWs("trả trước: gồm 0 khách AI theo thiết kế", healthyWs(ac({ value: 50, included: 0, prepaid: true })), "HEALTHY", [], []);
  expectWs("trả trước: đồng hồ chưa đo không phải chỗ thiếu (không có trần để chạm)", healthyWs(ac({ value: null, coverage: "NOT_MEASURED", included: 0, prepaid: true })), "HEALTHY", [], []);
  expectWs("gói không khai khách AI ⇒ không áp dụng", healthyWs(ac({ value: null, coverage: "NOT_MEASURED", included: undefined })), "HEALTHY", [], []);
  expectWs("gói không giới hạn ⇒ không áp dụng", healthyWs(ac({ value: 9999, included: null })), "HEALTHY", [], []);
  // Đồng hồ là tín hiệu bắt buộc khi gói có trần (review #683 mục 17).
  expectWs("đồng hồ chưa đo ⇒ chưa đủ dữ liệu", healthyWs(ac({ value: null, coverage: "NOT_MEASURED" })), "UNKNOWN", [], ["USAGE_METER_UNMEASURED"]);
  expectWs("không có số đồng hồ ⇒ chưa đủ dữ liệu", healthyWs({ aiCustomers: null }), "UNKNOWN", [], ["USAGE_METER_UNMEASURED"]);
  expectWs("không đọc được ngưỡng của bảng giá ⇒ chưa đủ dữ liệu", healthyWs(ac({ alerts: null })), "UNKNOWN", [], ["USAGE_METER_UNMEASURED"]);
  expectWs("vượt ghế", healthyWs({ overageSeats: [{ label: "Người dùng thêm", overUnits: 2 }] }), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"]);
  expectWs("vượt fair-use", healthyWs({ fairUseFlagged: true }), "NEEDS_ATTENTION", ["FAIR_USE"]);
  expectWs("module không đọc được không che vượt ghế", healthyWs({ modules: null, overageSeats: [{ label: "Fanpage thêm", overUnits: 1 }] }), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"], ["MODULES_UNREADABLE"]);

  // Thương mại / vòng đời.
  expectWs("hết hạn sau khi đã trả tiền — chỉ xem", healthyWs({ subscriptions: [{ productKey: "chotdon", status: "EXPIRED" }] }), "CRITICAL", ["SUBSCRIPTION_EXPIRED"]);
  const lapsed = expectWs("dùng thử hết hạn, chưa trả tiền lần nào ⇒ đã dừng", healthyWs({ subscriptions: [{ productKey: "chotdon", status: "EXPIRED" }], everPaid: false }), "INACTIVE");
  assert.match(lapsed.inactiveReason ?? "", /Dùng thử đã hết hạn/);
  expectWs("không đọc được sổ hoá đơn ⇒ không chứng minh được là dùng thử ⇒ giữ Nguy cấp", healthyWs({ subscriptions: [{ productKey: "chotdon", status: "EXPIRED" }], everPaid: null }), "CRITICAL", ["SUBSCRIPTION_EXPIRED"]);
  expectWs("quá hạn — đang ân hạn", healthyWs({ subscriptions: [{ productKey: "chotdon", status: "PAST_DUE" }] }), "NEEDS_ATTENTION", ["PAST_DUE"]);
  expectWs("dựng hỏng", healthyWs({ orgStatus: "SETUP_FAILED" }), "CRITICAL", ["WORKSPACE_SETUP_FAILED"]);
  expectWs("đình chỉ khi thuê bao còn mở", healthyWs({ orgStatus: "SUSPENDED" }), "NEEDS_ATTENTION", ["WORKSPACE_SUSPENDED"]);
  expectWs("lưu trữ", healthyWs({ orgStatus: "ARCHIVED", ai: aiOk({ errorsInWindow: 5, lastErrorAt: ago(60_000) }) }), "INACTIVE");
  expectWs("mọi thuê bao tạm dừng", healthyWs({ subscriptions: [{ productKey: "chotdon", status: "PAUSED" }] }), "INACTIVE");
  expectWs("đã huỷ hết thuê bao", healthyWs({ subscriptions: [], hadEndedSubscriptions: true }), "INACTIVE");
  expectWs("chưa thuê sản phẩm nào", erpWs({ subscriptions: [] }), "NEEDS_ATTENTION", ["NO_SUBSCRIPTION"]);

  // Tài khoản = lý do nặng nhất; workspace đã dừng không kéo mức.
  assert.equal(classifyCustomer(account([healthyWs()]), NOW).level, "HEALTHY");
  const multi = classifyCustomer(account([healthyWs(), healthyWs({ code: "ws-b", ai: aiOk({ errorsInWindow: 3, okInWindow: 0, lastErrorAt: ago(60_000), lastOkAt: ago(HOUR) }) })]), NOW);
  assert.equal(multi.level, "CRITICAL");
  assert.equal(multi.workspaces[0].code, "ws-b", "workspace nặng trước");
  assert.equal(multi.reasons[0].workspace, "ws-b");
  assert.equal(classifyCustomer(account([healthyWs(), healthyWs({ code: "ws-c", orgStatus: "ARCHIVED" })]), NOW).level, "HEALTHY", "workspace lưu trữ không kéo mức");
  const stopped = classifyCustomer(account([healthyWs({ orgStatus: "ARCHIVED" })]), NOW);
  assert.deepEqual([stopped.level, stopped.inactiveReason], ["INACTIVE", "Workspace đã lưu trữ."]);
  const trialOver = classifyCustomer(account([healthyWs({ subscriptions: [{ productKey: "chotdon", status: "EXPIRED" }], everPaid: false })], { revenueVnd: 0, grossProfitVnd: -20_000 }), NOW);
  assert.equal(trialOver.level, "INACTIVE", "dùng thử hết hạn không kẹt mãi ở Nguy cấp");
  const closed = classifyCustomer(account([healthyWs()], { accountStatus: "CLOSED" }), NOW);
  assert.deepEqual([closed.level, closed.inactiveReason, closed.workspaces[0].level], ["INACTIVE", "Tài khoản đã đóng.", "INACTIVE"]);
  const failed = classifyCustomer(account([healthyWs()], { failedJobs: 1 }), NOW);
  assert.equal(failed.level, "CRITICAL");
  assert.deepEqual(failed.accountReasons.map((r) => r.code), ["PROVISIONING_FAILED"]);
  assert.match(failed.accountReasons[0].text, /Chạy lại/);
  // #682: job xong mà CHƯA cài được mẫu — cùng mức Nguy cấp, lối ra khác («Cài lại mẫu», không phải «Chạy lại»).
  const tplOnly = classifyCustomer(account([healthyWs()], { failedJobs: 1, templatePendingJobs: 1 }), NOW);
  assert.equal(tplOnly.level, "CRITICAL");
  assert.equal(tplOnly.accountReasons.length, 1);
  assert.ok(/Cài lại mẫu/.test(tplOnly.accountReasons[0].text) && !/Chạy lại/.test(tplOnly.accountReasons[0].text) && /mẫu/.test(tplOnly.accountReasons[0].short), tplOnly.accountReasons[0].text);
  const both = classifyCustomer(account([healthyWs()], { failedJobs: 3, templatePendingJobs: 1 }), NOW).accountReasons.map((r) => r.short);
  assert.deepEqual(both, ["2 job hỏng", "chưa cài được mẫu (1 job)"]);
  assert.deepEqual(codes(classifyCustomer(account([]), NOW)), ["NO_WORKSPACE"]);
  assert.deepEqual(codes(classifyCustomer(account([healthyWs()], { revenueVnd: 499_000, grossProfitVnd: -120_000 }), NOW)), ["LOSING_MONEY"], "khách TRẢ TIỀN mà lỗ gộp");
  assert.equal(classifyCustomer(account([healthyWs()], { revenueVnd: 0, grossProfitVnd: -50_000 }), NOW).level, "HEALTHY", "dùng thử lỗ gộp là đúng thiết kế");
  assert.equal(classifyCustomer(account([healthyWs({ login: null })]), NOW).level, "UNKNOWN", "thiếu ở workspace ⇒ tài khoản không khoẻ");

  // Nhãn một dòng bảng không nhẹ hơn lý do cấp tài khoản in trên dòng đó (review #683 mục 10).
  const r = (code: HealthReasonCode): HealthReason => ({ code, level: HEALTH_REASONS[code].level, workspace: null, short: "x", text: "câu thử đủ dài" });
  assert.equal(rowLevel("HEALTHY", [r("PROVISIONING_FAILED")]), "CRITICAL");
  assert.equal(rowLevel("UNKNOWN", [r("LOSING_MONEY")]), "NEEDS_ATTENTION");
  assert.equal(rowLevel("INACTIVE", [r("LOSING_MONEY")]), "NEEDS_ATTENTION");
  assert.equal(rowLevel("CRITICAL", [r("LOSING_MONEY")]), "CRITICAL");
  assert.equal(rowLevel("HEALTHY", []), "HEALTHY");

  // Bảng mức + bảng khai: chữ của người vận hành không mang tên bảng / tệp / từ kỹ thuật.
  assert.equal(worstLevel(["HEALTHY", "UNKNOWN", "NEEDS_ATTENTION"]), "NEEDS_ATTENTION");
  assert.equal(worstLevel([]), "INACTIVE");
  assert.deepEqual([...CUSTOMER_HEALTH_LEVELS], ["CRITICAL", "NEEDS_ATTENTION", "UNKNOWN", "HEALTHY", "INACTIVE"]);
  for (const [k, g] of Object.entries(HEALTH_GAPS)) assert.ok(!TECH.test(g.why) && !TECH.test(g.label) && g.source.length > 5, `chỗ chưa đo ${k}: câu in ra mang chữ kỹ thuật, hoặc thiếu nguồn`);
  for (const [k, x] of Object.entries(HEALTH_REASONS)) assert.ok(!TECH.test(x.label) && x.source.length > 5, `lý do ${k}: nhãn mang chữ kỹ thuật, hoặc thiếu nguồn`);
  console.log("  ✓ sức khoẻ khách (thuần): khoẻ khi đủ dữ liệu, thiếu / chưa đủ để kết luận ⇒ không khoẻ, AI / ghi đơn hộ / kênh / đăng nhập / hạn mức / vòng đời đúng mức + lý do, chữ thường");
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

const goc = path.resolve(__dirname, "..");
const boChuThich = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const tho = (tep: string) => readFileSync(path.join(goc, tep), "utf8");
const ma = (tep: string) => boChuThich(tho(tep));

function tepMa(): string[] {
  return execSync("git ls-files lib app components", { cwd: goc, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(path.sep).join("/"))
    .filter((l) => /\.(ts|tsx)$/.test(l));
}

function testSource() {
  // Ngưỡng LẤY LẠI từ hằng đang chạy (luật 22) — không gõ lại số; ngưỡng KHÁC ĐƠN VỊ với SLO thì là mặc định kỹ thuật riêng.
  assert.equal(T.aiFailBurst, DEFAULT_AI_SALES_SLO.providerErrorBurst);
  assert.equal(T.aiFailWindowMinutes, DEFAULT_AI_SALES_SLO.providerWindowMinutes);
  assert.equal(T.inboundBaselineMinDays, DEFAULT_AI_SALES_SLO.webhookBaselineMinDays);
  assert.equal(T.loginStaleDays, SESSION_ABSOLUTE_DAYS);
  const constSrc = tho("lib/constants/customer-health.ts");
  for (const k of ["aiSilentMinCustomerMessagesPerDay", "inboundBaselineMinMessagesPerDay"]) {
    const at = constSrc.indexOf(`  ${k}:`);
    assert.ok(at > 0 && /Mặc định kỹ thuật/.test(constSrc.slice(constSrc.lastIndexOf("/**", at), at)), `${k}: ngưỡng theo NGÀY khác đơn vị với SLO (theo phút / giờ) ⇒ khai «Mặc định kỹ thuật», không lấy lại số SLO`);
  }
  assert.ok(!/aiSilentMinCustomerMessages\b|inboundBaselineMinPerDay\b/.test(constSrc), "tên ngưỡng cũ (đơn vị mơ hồ) đã thay");
  // Sổ dùng chụp mỗi SAAS_SNAPSHOT_JOB_EVERY_MS: hằng client-safe phải khớp, ngưỡng tươi DẪN XUẤT từ nó (lỡ một nhịp + 1 giờ).
  assert.equal(USAGE_SNAPSHOT_EVERY_HOURS * HOUR, SAAS_SNAPSHOT_JOB_EVERY_MS, "đổi nhịp chụp mà quên USAGE_SNAPSHOT_EVERY_HOURS");
  assert.equal(T.usageLedgerFreshHours, 2 * USAGE_SNAPSHOT_EVERY_HOURS + 1);
  // Cửa sổ hoạt động phải khớp cửa sổ 7 ngày cố định của sổ AI (`salesAiUsageHealthByOrg` — ok7d): đổi một bên là hai câu nói hai số.
  assert.equal(T.activityWindowDays, 7);
  assert.match(tho("lib/ai-usage/sales-health.ts"), /gte\(a\.at, new Date\(now\.getTime\(\) - 7 \* 86_400_000\)\)/);

  // Hàm phân loại THUẦN: không CSDL, không đồng hồ; chỉ nhập KIỂU từ lõi kích hoạt (tệp đó mở CSDL của khách).
  const pure = ma("lib/saas/customer-health.ts");
  assert.ok(!/from\s+["']@\/db["']/.test(pure) && !/\bget(?:Platform)?Db\w*\(/.test(pure), "hàm phân loại không đọc CSDL");
  assert.ok(!/Date\.now\(|new Date\(\)/.test(pure), "hàm phân loại không đọc đồng hồ — `now` truyền vào");
  assert.ok(/import type \{[^}]*\} from "@\/lib\/saas\/activation"/.test(pure) && !/import \{[^}]*\} from "@\/lib\/saas\/activation"/.test(pure), "chỉ nhập kiểu từ lib/saas/activation");

  // Đường đọc gom: KHÔNG mở CSDL tổ chức nào — chỉ mặt phẳng điều khiển; không gọi lõi kích hoạt (mở CSDL khách).
  const reader = ma("lib/saas/customer-signals.ts");
  assert.ok(!/\b(?:getDbFor|getDbForInspection|withOrganization|getDb)\s*\(/.test(reader), "đường đọc sức khoẻ không mở CSDL tổ chức");
  assert.ok(!/\bloadOrgSupport\(|\blistOrgSupportSummaries\(|\bloadOrgDiagnostics\(|\bloadAdminActivations\(|\bloadWorkspaceActivation\(/.test(reader), "không gọi lại đường đọc mở CSDL từng tổ chức");
  // Khách AI theo kênh dùng ĐÚNG vị ngữ của đồng hồ khách AI (AGENTS 8.12) — không chép lại điều kiện.
  assert.ok(/aiCustomerEventsWhere\(/.test(reader) && !/AI_CUSTOMER_METRIC|AI_CUSTOMER_PRODUCT/.test(reader), "khách AI theo kênh dùng chung vị ngữ với đồng hồ");
  assert.match(ma("lib/pricing/ai-customer.ts"), /\.where\(aiCustomerEventsWhere\(orgCodes, from, to\)\)/);

  // Đường đọc xuyên tổ chức chỉ được gọi SAU cổng người vận hành (console.ts) — không trang / action nào gọi thẳng.
  const goiDocSucKhoe: string[] = [];
  const goiSoAiGom: string[] = [];
  for (const tep of tepMa()) {
    const m = ma(tep);
    // Ngoại lệ DUY NHẤT ngoài console.ts: lượt chụp sức khoẻ theo ngày của JOB nhà (0240, lib/saas/tenant-health-daily.ts) — không có
    // người dùng, không trang / action nào gọi nó (tests/saas-value-snapshots.test.ts quét mã), chỉ ghi mức + MÃ lý do vào CSDL nhà.
    if (/\breadCustomerHealth\(/.test(m.replace(/export async function readCustomerHealth\(/, "")) && !["lib/saas/console.ts", "lib/saas/tenant-health-daily.ts"].includes(tep)) goiDocSucKhoe.push(tep);
    if (/\bsalesAiUsageHealthByOrg\(/.test(m.replace(/export async function salesAiUsageHealthByOrg\(/, "")) && !["lib/saas/customer-signals.ts", "lib/ai-usage/sales-health.ts"].includes(tep)) goiSoAiGom.push(tep);
  }
  assert.deepEqual(goiDocSucKhoe, [], "readCustomerHealth nhìn xuyên mọi tổ chức — chỉ lib/saas/console.ts (sau platformOperatorDenial) và lượt chụp của job (lib/saas/tenant-health-daily.ts) được gọi");
  assert.deepEqual(goiSoAiGom, [], "sổ AI gom theo tổ chức chỉ đọc ở đường sức khoẻ khách");
  const consoleSrc = ma("lib/saas/console.ts");
  for (const fn of ["loadCustomersConsole", "loadCustomerDetail"]) {
    const body = consoleSrc.slice(consoleSrc.indexOf(`export async function ${fn}(`));
    assert.ok(body.indexOf("platformOperatorDenial(") < body.indexOf("readCustomerHealth("), `${fn}: hỏi người vận hành TRƯỚC khi đọc sức khoẻ`);
    assert.ok(body.indexOf("opts.now ?? new Date()") > 0 && body.indexOf("opts.now ?? new Date()") < body.indexOf("loadCommercialSnapshot("), `${fn}: MỘT mốc \`now\` cho cả lượt (truyền được từ bài kiểm)`);
  }
  // Trang chi tiết đọc đăng nhập MỘT lần (dùng chung cho ô của trang và tín hiệu sức khoẻ — review #683 INFO).
  const detailBody = consoleSrc.slice(consoleSrc.indexOf("export async function loadCustomerDetail("), consoleSrc.indexOf("export async function loadProductsConsole("));
  assert.equal(detailBody.match(/\bworkspaceReach\(/g)?.length, 1, "loadCustomerDetail gọi workspaceReach đúng một lần");

  const page = ma("app/(dashboard)/platform/customers/page.tsx");
  assert.ok(/requirePermission\(\s*["']platform:operate["']\s*\)/.test(page) && /platformOperatorDenial\(user\)/.test(page), "trang chỉ người vận hành nền tảng");
  assert.ok(!/customer-signals/.test(page), "trang đọc qua console.ts, không gọi thẳng đường đọc");
  assert.ok(/rowLevel\(/.test(page) && /NOT_APPLICABLE_TEXT/.test(page) && /healthPeriodMonth/.test(page), "trang: nhãn dòng theo lý do nặng nhất · N/A khi không có workspace · nói rõ kỳ của sức khoẻ");
  // Bảng vừa một màn hình: mỗi cột tiêu đề một độ rộng khai, tổng ≤ 1.150 px (trần thực dụng của màn 1440 px trừ thanh điều hướng).
  const cols = [...page.matchAll(/<col className="w-\[(\d+)px\]"/g)].map((m) => Number(m[1]));
  assert.equal(cols.length, (page.match(/<th className=/g) ?? []).length, "mỗi cột tiêu đề có đúng một độ rộng");
  assert.ok(cols.reduce((a, b) => a + b, 0) <= 1150, `bảng ${cols.reduce((a, b) => a + b, 0)} px — quá trần 1.150 px`);

  // ⓘ và ô bảng: chữ thường cho người vận hành — không tên bảng / đường dẫn tệp / ORDER_OUTCOME / «OK», không gõ tay nhịp chụp
  // hay cửa sổ ngày (review #683 mục 8 · 13).
  const comp = ma("components/saas/customer-health.tsx").replace(/^import .*$/gm, "");
  assert.ok(!/platform_[a-z]|ORDER_OUTCOME|lib\/|\.tsx?\b|webhook|container/.test(comp), "component in chữ kỹ thuật");
  assert.ok(!/[`"']OK\b|\bOK [$`]/.test(comp), "ô AI không in «OK»");
  assert.ok(!/\b6 giờ|\b7 ngày/.test(comp) && /USAGE_SNAPSHOT_EVERY_HOURS/.test(comp) && /T\.activityWindowDays/.test(comp), "nhịp chụp / cửa sổ ngày lấy từ hằng, không gõ tay");
  console.log("  ✓ sức khoẻ khách (mã nguồn): ngưỡng lấy lại hằng đang chạy, phân loại thuần, không mở CSDL tổ chức, chỉ sau cổng người vận hành, chữ thường");
}

// ═══════════ 3 · BỘ ĐỌC (không CSDL) ═══════════

/** Ảnh chụp thương mại GIẢ — chỉ các trường `readCustomerHealth` đọc (kiểu đầy đủ do loader thật dựng). */
function fakeCustomer(id: string, ws: { code: string; product?: string }[]): CustomerView {
  return {
    account: { id, code: id, name: id, status: "ACTIVE" },
    failedJobs: 0,
    economics: { revenueVnd: 499_000, grossProfitVnd: 300_000 },
    workspaces: ws.map((w) => ({
      code: w.code,
      name: w.code,
      isHome: false,
      status: "ACTIVE",
      createdAt: ago(20 * DAY),
      subscriptions: [{ productKey: w.product ?? "chotdon", status: "ACTIVE" }],
      endedSubscriptions: [],
      everPaid: true,
      pricing: { versionKey: null, price: { included: { aiCustomers: 100 } }, aiCustomers: { value: 40, coverage: "MEASURED", note: null }, overage: null, fairUse: null },
      usage: [{ productKey: "chotdon", metric: "conversations_started", value: 12 }],
    })),
  } as unknown as CustomerView;
}

type Calls = Record<keyof SignalReaders, unknown[][]>;

const ALL_CODES = ["rd-a1", "rd-a2", "rd-b1", "rd-c1"];

/** Bộ đọc giả trả dữ liệu KHOẺ + ghi lại mọi lượt gọi (tham số) để đếm. */
function fakeReaders(calls: Calls): SignalReaders {
  const log = (k: keyof SignalReaders, args: unknown[]) => calls[k].push(args);
  return {
    reach: async (c) => (log("reach", [c]), new Map(c.map((x) => [x, { identities: 2, lastLoginAt: ago(DAY), messengerPages: 1 }]))),
    ai: async (c, now, win) => (log("ai", [c, now, win]), new Map(c.map((x) => [x, aiOk()]))),
    usage: async (fromDay) => (log("usage", [fromDay]), new Map(ALL_CODES.map((x) => [x, ledger(10)]))),
    milestones: async () => (log("milestones", []), new Map(ALL_CODES.map((x) => [x, { CHANNEL_CONNECTED: ago(19 * DAY), FIRST_AI_REPLY: ago(18 * DAY), FIRST_AI_ORDER: ago(17 * DAY) }]))),
    platformAiSwitch: async () => (log("platformAiSwitch", []), { enabled: true, readError: false }),
    orgAiDisabled: async (c) => (log("orgAiDisabled", [c]), new Map(c.map((x) => [x, false]))),
    priceBook: async () => (log("priceBook", []), { versions: [] } as unknown as PriceBook),
    modules: async (code) => (log("modules", [code]), { aiSales: true, legacyChatbot: false }),
    channels: async (c, pm) => (log("channels", [c, pm]), new Map(c.map((x) => [x, { FANPAGE: 3 }]))),
  };
}

const FAKE = [fakeCustomer("acct-a", [{ code: "rd-a1" }, { code: "rd-a2" }]), fakeCustomer("acct-b", [{ code: "rd-b1" }]), fakeCustomer("acct-c", [{ code: "rd-c1" }])];
const PERIOD = currentPeriodMonth(NOW);
const emptyCalls = (): Calls => ({ reach: [], ai: [], usage: [], milestones: [], platformAiSwitch: [], orgAiDisabled: [], priceBook: [], modules: [], channels: [] });
const boom = () => Promise.reject(new Error("nguồn hỏng thử"));

async function testReaders() {
  // Đủ nguồn ⇒ khoẻ; mỗi bộ đọc gom gọi ĐÚNG MỘT lần với CẢ mảng mã (không N+1); module một lần mỗi workspace (bộ phân giải năng
  // lực là chỗ duy nhất được đọc bảng module — đệm 5 giây); mọi cửa sổ dựng từ `now` truyền vào.
  const calls = emptyCalls();
  const all = await readCustomerHealth(FAKE, { now: NOW, periodMonth: PERIOD, readers: fakeReaders(calls) });
  for (const c of FAKE) assert.equal(all[c.account.id].level, "HEALTHY", `${c.account.id}: ${JSON.stringify(all[c.account.id].gaps.map((g) => g.code))} ${JSON.stringify(all[c.account.id].reasons.map((x) => x.code))}`);
  const sorted = (x: unknown) => [...(x as string[])].sort();
  for (const k of ["reach", "ai", "orgAiDisabled", "channels"] as const) {
    assert.equal(calls[k].length, 1, `${k}: một lượt cho cả danh sách, không phải một lượt mỗi khách`);
    assert.deepEqual(sorted(calls[k][0][0]), ALL_CODES, `${k}: nhận CẢ mảng mã`);
  }
  for (const k of ["usage", "milestones", "platformAiSwitch", "priceBook"] as const) assert.equal(calls[k].length, 1, `${k}: một lượt`);
  assert.deepEqual(calls.modules.map((a) => a[0]).sort(), ALL_CODES, "module: đúng một lượt mỗi workspace");
  assert.deepEqual(calls.ai[0].slice(1), [NOW, T.aiFailWindowMinutes], "sổ AI: cửa sổ dựng từ `now` truyền vào");
  assert.deepEqual(calls.usage[0], [addDays(vnDate(NOW), -T.usageLookbackDays)], "sổ dùng: ngày đầu dựng từ `now` truyền vào (không đọc đồng hồ quanh nửa đêm)");
  assert.equal(calls.channels[0][1], PERIOD);
  assert.deepEqual(all["acct-b"].workspaces[0].facts.aiCustomerChannels, [{ channel: "FANPAGE", customers: 3 }]);
  assert.equal(all["acct-b"].workspaces[0].facts.usage.conversations, 12, "hội thoại kỳ từ chính ảnh chụp sức khoẻ đọc");

  // TỪNG nguồn hỏng ⇒ không khách Chốt Đơn nào khoẻ + đúng chỗ chưa đo; các nguồn khác vẫn đọc (review #683 mục 5).
  const FAIL: [string, HealthGapCode, (r: SignalReaders) => SignalReaders][] = [
    ["đăng nhập / page", "LOGIN_UNREADABLE", (r) => ({ ...r, reach: boom })],
    ["sổ AI", "AI_LEDGER_UNREADABLE", (r) => ({ ...r, ai: boom })],
    ["sổ dùng", "USAGE_LEDGER_UNREADABLE", (r) => ({ ...r, usage: boom })],
    ["mốc kích hoạt", "MILESTONES_UNREADABLE", (r) => ({ ...r, milestones: boom })],
    ["công tắc nền tảng ném", "AI_SWITCH_UNREADABLE", (r) => ({ ...r, platformAiSwitch: boom })],
    ["công tắc nền tảng báo lỗi đọc", "AI_SWITCH_UNREADABLE", (r) => ({ ...r, platformAiSwitch: async () => ({ enabled: false, readError: true }) })],
    ["công tắc tổ chức", "AI_SWITCH_UNREADABLE", (r) => ({ ...r, orgAiDisabled: boom })],
    ["bảng giá", "USAGE_METER_UNMEASURED", (r) => ({ ...r, priceBook: boom })],
    ["module", "MODULES_UNREADABLE", (r) => ({ ...r, modules: boom })],
  ];
  for (const [name, gapCode, broken] of FAIL) {
    const h = await readCustomerHealth(FAKE, { now: NOW, periodMonth: PERIOD, readers: broken(fakeReaders(emptyCalls())) });
    for (const c of FAKE) {
      const x: CustomerHealth = h[c.account.id];
      assert.notEqual(x.level, "HEALTHY", `${name} hỏng: ${c.account.id} không được «Khoẻ»`);
      assert.ok(x.gaps.some((g) => g.code === gapCode), `${name} hỏng: ${c.account.id} phải có chỗ chưa đo ${gapCode} — có ${JSON.stringify(x.gaps.map((g) => g.code))}`);
    }
  }
  // Khách AI theo kênh CHỈ ĐỂ IN (khai trong đầu vào): hỏng ⇒ ô in «chưa biết», mức không đổi.
  const noCh = await readCustomerHealth(FAKE, { now: NOW, periodMonth: PERIOD, readers: { ...fakeReaders(emptyCalls()), channels: boom } });
  assert.equal(noCh["acct-b"].level, "HEALTHY");
  assert.equal(noCh["acct-b"].workspaces[0].facts.aiCustomerChannels, null, "nguồn theo kênh hỏng ⇒ chưa biết, không phải «0 khách»");
  // ERP: nguồn của Chốt Đơn hỏng không áp dụng; đăng nhập hỏng thì vẫn không khoẻ.
  const erp = [fakeCustomer("acct-erp", [{ code: "rd-a1", product: "erp" }])];
  const erpBad = await readCustomerHealth(erp, { now: NOW, periodMonth: PERIOD, readers: { ...fakeReaders(emptyCalls()), ai: boom, usage: boom, milestones: boom } });
  assert.equal(erpBad["acct-erp"].level, "HEALTHY", JSON.stringify(erpBad["acct-erp"].gaps));
  const erpNoLogin = await readCustomerHealth(erp, { now: NOW, periodMonth: PERIOD, readers: { ...fakeReaders(emptyCalls()), reach: boom } });
  assert.equal(erpNoLogin["acct-erp"].level, "UNKNOWN");
  // Trang một khách truyền trạng thái kích hoạt ⇒ lời khuyên đúng việc; danh sách không truyền ⇒ trung tính.
  const fresh = [fakeCustomer("acct-new", [{ code: "rd-c1", product: "erp" }])];
  const noLogin: SignalReaders = { ...fakeReaders(emptyCalls()), reach: async (c) => new Map(c.map((x) => [x, { identities: 0, lastLoginAt: null, messengerPages: 0 }])) };
  const listView = await readCustomerHealth(fresh, { now: NOW, periodMonth: PERIOD, readers: noLogin });
  const detailView = await readCustomerHealth(fresh, { now: NOW, periodMonth: PERIOD, readers: noLogin, activation: { "rd-c1": { orgCode: "rd-c1", email: null, source: "JOB", state: "EXPIRED", activatedAt: null, linkExpiresAt: ago(DAY).toISOString(), lastLinkAt: ago(2 * DAY).toISOString(), canResend: true } } });
  assert.match(listView["acct-new"].reasons[0].text, /mở trang khách/);
  assert.match(detailView["acct-new"].reasons[0].text, /gửi lại liên kết kích hoạt/);
  assert.equal(Object.isFrozen(DEFAULT_SIGNAL_READERS), true, "bộ đọc mặc định không sửa được lúc chạy");
  console.log("  ✓ sức khoẻ khách (bộ đọc): mỗi nguồn hỏng ⇒ không khoẻ + đúng chỗ chưa đo, một lượt gom mỗi nguồn với cả mảng mã, mốc `now` truyền vào");
}

// ═══════════ 4 · CSDL THẬT ═══════════

const KHOE = "skh-khoe";
const HONG = "skh-hong";
const MOI = "skh-moi";
const ORGS = [KHOE, HONG, MOI] as const;
const PAGE_ID = "990000000077";
const SECRET_STRINGS = ["Trang bí mật skh", "noi-page@skh.local", "khach@skh-khoe.local"];

function user(over: Partial<SessionUser>): SessionUser {
  return { id: "skh-user", email: "skh@local", name: "SKH", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const codesList = [...ORGS];
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, codesList));
  await pdb.delete(schema.platformTenantUsageDaily).where(inArray(schema.platformTenantUsageDaily.orgCode, codesList));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, codesList));
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, PAGE_ID));
  await pdb.delete(schema.platformOrgMilestones).where(inArray(schema.platformOrgMilestones.orgCode, codesList));
  await pdb.delete(schema.platformSaasDaily).where(inArray(schema.platformSaasDaily.orgCode, codesList));
  await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, codesList));
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, codesList));
  for (const code of codesList) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, code));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  // Tài khoản thử: chỉ cái KHÔNG còn workspace nào trỏ tới.
  const accts = (await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts).where(like(schema.platformAccounts.code, "skh-%"))).map((a) => a.id);
  const used = accts.length ? new Set((await pdb.select({ id: schema.platformOrganizations.accountId }).from(schema.platformOrganizations).where(inArray(schema.platformOrganizations.accountId, accts))).map((r) => r.id)) : new Set<string | null>();
  const free = accts.filter((id) => !used.has(id));
  if (free.length) {
    await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.accountId, free));
    await pdb.delete(schema.platformAccounts).where(inArray(schema.platformAccounts.id, free));
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, codesList));
  invalidateOrganizations();
  invalidateCapabilities();
}

/** Sổ dùng `n` ngày tới hôm nay (giờ VN của `now` — CÙNG mốc truyền vào loader). */
async function seedLedger(orgCode: string, now: Date, n: number, day: (i: number) => Partial<typeof schema.platformTenantUsageDaily.$inferInsert>) {
  const pdb = await getPlatformDb();
  const today = vnDate(now);
  for (let i = n - 1; i >= 0; i--) {
    await pdb.insert(schema.platformTenantUsageDaily).values({ day: addDays(today, -i), orgCode, conversationsStarted: 4, customerMessages: 10, botMessages: 9, aiActiveConversations: 3, aiOrders: 1, fanpagesActive: 1, capturedAt: new Date(now.getTime() - HOUR), ...day(i) });
  }
}

async function seedAi(orgCode: string, rows: { at: Date; status: "OK" | "ERROR" | "BLOCKED_QUOTA"; ref?: string }[]) {
  const pdb = await getPlatformDb();
  await pdb.insert(schema.platformAiUsage).values(rows.map((r) => ({ orgCode, feature: "sales_chatbot", billingSource: "PLATFORM", requests: r.status === "BLOCKED_QUOTA" ? 0 : 1, status: r.status, at: r.at, ref: r.ref ?? null })));
}

/** Kỳ ngay trước kỳ `periodMonth` (YYYY-MM-01). */
function previousPeriod(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function testDb() {
  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  const op = user({ id: "skh-op", email: "op@skh.local", organization: { code: home.code, name: home.name, isHome: true } });
  // MỘT mốc cho cả bài: gieo dữ liệu tương đối với nó và TRUYỀN nó vào loader — không đọc đồng hồ lần hai quanh nửa đêm (luật 50).
  const now = new Date();
  const ai = ["core", "work", "customers", "products", "orders", "inventory", "ai_sales"];
  await provisionOrganization({ code: KHOE, name: "SKH Khoẻ", modules: ai, source: "TEST", actor: null });
  await provisionOrganization({ code: HONG, name: "SKH Hỏng", modules: ai, source: "TEST", actor: null });
  await provisionOrganization({ code: MOI, name: "SKH Mới", modules: ["core", "work", "customers", "products", "orders", "logistics"], source: "TEST", actor: null });
  // `skh-moi` tạo 30 giờ trước (quá ân hạn 24 giờ) — và SAU ngày chỉ mục đăng nhập (dựng từ hằng, kiểm tường minh).
  const moiCreated = new Date(now.getTime() - 30 * HOUR);
  assert.ok(moiCreated.getTime() >= INDEX_START.getTime(), "tiền điều kiện: workspace thử tạo SAU ngày chỉ mục đăng nhập");
  await pdb.update(schema.platformOrganizations).set({ createdAt: moiCreated }).where(eq(schema.platformOrganizations.code, MOI));
  for (const code of [KHOE, HONG]) await pdb.update(schema.platformOrganizations).set({ createdAt: new Date(now.getTime() - 20 * DAY) }).where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();

  // skh-khoe: đăng nhập hôm qua, page Messenger nối thẳng, sổ dùng 10 ngày đều, AI trả lời đều, đã kích hoạt.
  await pdb.insert(schema.platformIdentities).values({ kind: "EMAIL", value: "khach@skh-khoe.local", orgCode: KHOE, userId: "u-khoe", lastUsedAt: new Date(now.getTime() - DAY) });
  await pdb.insert(schema.platformMessengerPages).values({ pageId: PAGE_ID, orgCode: KHOE, pageName: "Trang bí mật skh", connectedByEmail: "noi-page@skh.local" });
  await seedLedger(KHOE, now, 10, () => ({}));
  await seedAi(KHOE, [1, 2, 3, 4, 5].map((m) => ({ at: new Date(now.getTime() - m * 60_000), status: "OK" as const })));
  // Một khách AI qua fanpage + một bí danh (số lượng 0) — cùng sổ, cùng khoá với đồng hồ khách AI; bí danh không đếm hai lần.
  await pdb.insert(schema.platformUsageEvents).values([
    { occurredAt: now, orgCode: KHOE, productKey: "chotdon", metric: "ai_customers", quantity: 1, unit: "khách AI", source: "test", eventKey: "skh-aic-1", metadata: { channel: "FANPAGE" } },
    { occurredAt: now, orgCode: KHOE, productKey: "chotdon", metric: "ai_customers", quantity: 0, unit: "khách AI", source: "test", eventKey: "skh-aic-1-alias", metadata: { channel: "FANPAGE", aliasOf: "skh-aic-1" } },
  ]);
  await pdb.insert(schema.platformOrgMilestones).values(
    (["SIGNED_UP", "CHANNEL_CONNECTED", "FIRST_CONVERSATION", "FIRST_AI_REPLY", "FIRST_AI_ORDER"] as const).map((milestone, i) => ({ orgCode: KHOE, milestone, reachedAt: new Date(now.getTime() - (20 - i) * DAY), source: "test" })),
  );

  // skh-hong: AI trả lời hỏng 3 lượt sau lượt thành công cuối, AI ghi đơn hộ hỏng 3 lượt, 0 fanpage + 0 tin khách hai ngày gần nhất.
  await pdb.insert(schema.platformIdentities).values({ kind: "EMAIL", value: "khach@skh-hong.local", orgCode: HONG, userId: "u-hong", lastUsedAt: new Date(now.getTime() - 2 * DAY) });
  await seedLedger(HONG, now, 10, (i) => (i <= 1 ? { fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0, aiActiveConversations: 0 } : {}));
  await seedAi(HONG, [
    { at: new Date(now.getTime() - 40 * 60_000), status: "OK", ref: "order-sync:o1" },
    { at: new Date(now.getTime() - 30 * 60_000), status: "OK" },
    { at: new Date(now.getTime() - 4 * 60_000), status: "ERROR" },
    { at: new Date(now.getTime() - 3 * 60_000), status: "ERROR" },
    { at: new Date(now.getTime() - 2 * 60_000), status: "ERROR" },
    { at: new Date(now.getTime() - 4 * 60_000), status: "ERROR", ref: "order-sync:o2" },
    { at: new Date(now.getTime() - 3 * 60_000), status: "ERROR", ref: "order-sync:o3" },
    { at: new Date(now.getTime() - 2 * 60_000), status: "ERROR", ref: "order-sync:o4" },
  ]);
  await pdb.insert(schema.platformOrgMilestones).values([
    { orgCode: HONG, milestone: "CHANNEL_CONNECTED", reachedAt: new Date(now.getTime() - 19 * DAY), source: "test" },
    { orgCode: HONG, milestone: "FIRST_AI_REPLY", reachedAt: new Date(now.getTime() - 18 * DAY), source: "test" },
  ]);
  // skh-moi: ERP, chưa ai đăng nhập — không gieo gì thêm.

  // ── Người ngoài bị từ chối: quản trị tổ chức khách (kể cả được gán platform:operate), người nhà không có quyền vận hành.
  const tenantAdmin = user({ id: "skh-tenant", email: "qt@skh-hong.local", permissions: ["platform:operate"], organization: { code: HONG, name: HONG, isHome: false } });
  const homeCs = user({ id: "skh-cs", role: "CS", organization: { code: home.code, name: home.name, isHome: true } });
  for (const u of [tenantAdmin, homeCs]) {
    const r = await loadCustomersConsole(u, undefined, { now });
    assert.ok("error" in r, `${u.email} không được xem sức khoẻ khách`);
    assert.ok(!JSON.stringify(r).includes(KHOE), `${u.email}: câu từ chối không mang mã tổ chức khác`);
    const d = await loadCustomerDetail(u, KHOE, undefined, { now });
    assert.ok(d && "error" in d, `${u.email} không mở được trang một khách`);
  }

  // ── Người vận hành: đúng mức + lý do cho ba tổ chức, mốc đọc = mốc truyền vào.
  const list = await loadCustomersConsole(op, undefined, { now });
  assert.ok(!("error" in list));
  assert.equal(list.healthAt.getTime(), now.getTime(), "sức khoẻ đọc theo ĐÚNG mốc truyền vào");
  assert.equal(list.healthPeriodMonth, currentPeriodMonth(now));
  const acct = async (code: string) => (await accountOfWorkspace(code))!;
  const idKhoe = (await acct(KHOE)).id;
  const idHong = (await acct(HONG)).id;
  const idMoi = (await acct(MOI)).id;
  const hKhoe = list.health[idKhoe];
  const hHong = list.health[idHong];
  const hMoi = list.health[idMoi];
  assert.ok(hKhoe && hHong && hMoi, "mỗi tài khoản có một kết quả sức khoẻ");
  assert.equal(hKhoe.level, "HEALTHY", `skh-khoe: ${JSON.stringify(hKhoe.reasons.map((r) => r.text))} ${JSON.stringify(hKhoe.gaps.map((g) => g.text))}`);
  const fk = hKhoe.workspaces[0].facts;
  assert.deepEqual([fk.identities, fk.messengerPages, fk.fanpagesActive, fk.ai.ok24h, fk.ai.state, fk.orders.lastAiOrderDay], [1, 1, 1, 5, "ON", vnDate(now)]);
  assert.deepEqual(fk.aiCustomerChannels, [{ channel: "FANPAGE", customers: 1 }], "khách AI kỳ theo kênh từ sổ dùng chung (bí danh không đếm)");
  assert.deepEqual(hHong.workspaces[0].facts.aiCustomerChannels, [], "đồng hồ đo được, chưa có khách nào ⇒ danh sách rỗng (0 thật), không phải chưa biết");
  assert.equal(hHong.level, "CRITICAL");
  assert.deepEqual(codes(hHong), ["AI_FAILING", "CHANNEL_LOST", "ORDER_SYNC_ERRORS"], JSON.stringify(hHong.reasons.map((r) => r.text)));
  assert.equal(hHong.reasons.find((r) => r.code === "ORDER_SYNC_ERRORS")?.level, "NEEDS_ATTENTION", "AI ghi đơn hộ lỗi là Cần chú ý — mức Nguy cấp đến từ AI trả lời hỏng + mất kênh");
  const fh = hHong.workspaces[0].facts.ai;
  assert.deepEqual([fh.chatErrors24h, fh.ok24h], [3, 1], "lỗi ghi đơn hộ không đếm đôi thành lỗi trả lời; lượt trả lời OK không gồm lượt ghi đơn hộ");
  assert.equal(fh.lastOkAt?.getTime(), now.getTime() - 30 * 60_000, "lần trả lời OK cuối không phải lượt ghi đơn hộ");
  assert.equal(hMoi.level, "NEEDS_ATTENTION");
  assert.deepEqual(codes(hMoi), ["NEVER_LOGGED_IN"], JSON.stringify(hMoi.reasons.map((r) => r.text)));
  assert.match(hMoi.reasons[0].text, /mở trang khách/, "danh sách không mở CSDL khách ⇒ lời khuyên trung tính");
  assert.equal(hMoi.workspaces[0].facts.ai.applies, false, "ERP: tín hiệu AI không áp dụng (N/A), không phải lỗi");
  // Không dữ liệu của người / page trong kết quả.
  const json = JSON.stringify([hKhoe, hHong, hMoi]);
  for (const s of SECRET_STRINGS) assert.ok(!json.includes(s), `kết quả sức khoẻ không mang «${s}»`);

  // ── Xem tiền kỳ trước: sức khoẻ vẫn của HIỆN TẠI (không trộn đồng hồ tháng trước với lỗi AI 15 phút qua — review #683 mục 11).
  const prev = previousPeriod(list.periodMonth);
  const past = await loadCustomersConsole(op, prev, { now });
  assert.ok(!("error" in past));
  assert.deepEqual([past.periodMonth, past.healthPeriodMonth], [prev, list.healthPeriodMonth]);
  for (const id of [idKhoe, idHong, idMoi]) assert.deepEqual([past.health[id].level, codes(past.health[id])], [list.health[id].level, codes(list.health[id])]);
  assert.deepEqual(past.health[idKhoe].workspaces[0].facts.aiCustomerChannels, [{ channel: "FANPAGE", customers: 1 }], "khách AI theo kênh của kỳ HIỆN TẠI");

  // ── Một nguồn hỏng trên dữ liệu thật ⇒ không khoẻ (đường đọc thật, chỉ thay bộ đọc mốc).
  const broken = await readCustomerHealth(
    list.customers.filter((c) => c.account.id === idKhoe),
    { now, periodMonth: list.healthPeriodMonth, readers: { ...DEFAULT_SIGNAL_READERS, milestones: boom } },
  );
  assert.deepEqual([broken[idKhoe].level, gapCodes(broken[idKhoe])], ["UNKNOWN", ["MILESTONES_UNREADABLE"]]);

  // ── Trang một khách: cùng đường đọc, cùng hàm ⇒ cùng mức; lời khuyên «chưa ai đăng nhập» theo trạng thái kích hoạt THẬT.
  const detail = await loadCustomerDetail(op, (await acct(HONG)).code, undefined, { now });
  assert.ok(detail && !("error" in detail));
  assert.equal(detail.healthAt.getTime(), now.getTime());
  assert.equal(detail.health.level, "CRITICAL");
  assert.deepEqual(codes(detail.health), codes(hHong));
  const dMoi = await loadCustomerDetail(op, (await acct(MOI)).code, undefined, { now });
  assert.ok(dMoi && !("error" in dMoi));
  assert.deepEqual(codes(dMoi.health), ["NEVER_LOGGED_IN"]);
  assert.ok(dMoi.activation[MOI], "trang một khách nạp trạng thái kích hoạt");
  assert.doesNotMatch(dMoi.health.reasons[0].text, /mở trang khách/, `trang một khách nói việc cụ thể theo trạng thái ${dMoi.activation[MOI]?.state}: ${dMoi.health.reasons[0].text}`);
  console.log("  ✓ sức khoẻ khách (CSDL): ba tổ chức thử đúng mức + lý do, mốc `now` truyền vào, kỳ trước vẫn ra sức khoẻ hiện tại, nguồn hỏng ⇒ không khoẻ, chi tiết cùng mức + lời khuyên kích hoạt, người ngoài bị từ chối");
}

/** Phần không CSDL (thuần + mã nguồn + bộ đọc giả) — chạy riêng được, nhanh. */
export async function testCustomerHealthPure() {
  testPure();
  testSource();
  await testReaders();
}

export async function testCustomerHealth() {
  await testCustomerHealthPure();
  await cleanup();
  try {
    await testDb();
  } finally {
    await cleanup();
  }
  console.log("✓ Sức khoẻ khách SaaS: phân loại thuần · thiếu không bao giờ khoẻ · một lượt gom ở CSDL nhà · chỉ người vận hành");
}
