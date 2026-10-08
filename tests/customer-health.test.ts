/**
 * SỨC KHOẺ KHÁCH SAAS (sứ mệnh saas-customer-health, 08/10/2026) — `/platform/customers`.
 *
 *  1. THUẦN — `classifyWorkspace` / `classifyCustomer`: đủ dữ liệu + không gì chạm ngưỡng ⇒ KHOẺ; THIẾU bất kỳ tín hiệu bắt buộc
 *     nào ⇒ KHÔNG BAO GIỜ khoẻ (Chưa đủ dữ liệu); AI lỗi / bị chặn / bị tắt / im, mất kênh / chưa nối kênh / tin khách dừng (có
 *     nền) / không hoạt động, không đăng nhập lâu / chưa ai đăng nhập (kèm ân hạn, kèm mốc chỉ mục), vượt hạn mức (trả trước
 *     KHÔNG tính), lỗi ghi đơn (tách khỏi lỗi trả lời — không đếm đôi), hết hạn / quá hạn / dựng hỏng / đình chỉ / đã dừng ⇒ ĐÚNG
 *     mức + ĐÚNG lý do; tài khoản = lý do nặng nhất; chạy hai lần ra một kết quả. Mốc thời gian dựng TỪ hằng chỉ mục / từ `now`
 *     truyền vào (luật 50) — không đồng hồ thật trong phần thuần.
 *  2. MÃ NGUỒN — đường đọc gom xuyên tổ chức chỉ được gọi sau cổng người vận hành (console.ts); hàm phân loại thuần không chạm
 *     CSDL / đồng hồ; đường đọc không mở CSDL tổ chức nào (không N+1); ngưỡng LẤY LẠI từ hằng đang chạy (luật 22).
 *  3. CSDL THẬT (PGlite) — ba tổ chức thử `skh-khoe` (Chốt Đơn chạy tốt) · `skh-hong` (AI lỗi + ghi đơn lỗi + mất kênh) ·
 *     `skh-moi` (ERP, tạo 30 giờ, chưa ai đăng nhập): `loadCustomersConsole` ra đúng mức + lý do, trang chi tiết cùng một mức;
 *     người không phải người vận hành (quản trị tổ chức khách kể cả có `platform:operate`, người nhà không có quyền) bị từ chối;
 *     kết quả không mang tên page / email người nối / giá trị danh tính.
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
import { CUSTOMER_HEALTH_LEVELS, CUSTOMER_HEALTH_THRESHOLDS, HEALTH_REASONS, IDENTITY_INDEX_SINCE, worstLevel, type CustomerHealthLevel, type HealthReasonCode } from "@/lib/constants/customer-health";
import { SESSION_ABSOLUTE_DAYS } from "@/lib/constants/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { SAAS_SNAPSHOT_JOB_EVERY_MS } from "@/lib/platform/saas-cockpit";
import { DEFAULT_USAGE_ALERTS } from "@/lib/pricing/versions";
import { accountOfWorkspace } from "@/lib/saas/accounts";
import { loadCustomerDetail, loadCustomersConsole } from "@/lib/saas/console";
import { classifyCustomer, classifyWorkspace, type AccountHealthInput, type AiLedgerSignal, type UsageDaySignal, type WorkspaceHealthInput } from "@/lib/saas/customer-health";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = CUSTOMER_HEALTH_THRESHOLDS;

// ═══════════ 1 · THUẦN ═══════════

/** `now` của phần thuần dựng TỪ hằng chỉ mục đăng nhập (luật 50): 20 ngày sau ngày chỉ mục bắt đầu. */
const INDEX_START = new Date(`${IDENTITY_INDEX_SINCE}T00:00:00+07:00`);
const NOW = new Date(INDEX_START.getTime() + 20 * DAY + 10 * HOUR);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function aiOk(over: Partial<AiLedgerSignal> = {}): AiLedgerSignal {
  return { okInWindow: 4, errorsInWindow: 0, blockedInWindow: 0, ok24h: 50, errors24h: 0, blocked24h: 0, ok7d: 300, lastOkAt: ago(5 * 60_000), lastErrorAt: null, orderSyncErrors24h: 0, orderSyncErrorsInWindow: 0, orderSyncLastOkAt: ago(HOUR), orderSyncLastErrorAt: null, ...over };
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
  return healthyWs({ code: "ws-erp", subscriptions: [{ productKey: "erp", status: "ACTIVE" }], ai: null, usage: null, modules: { aiSales: false, legacyChatbot: false }, aiCustomers: null, ...over });
}

function account(workspaces: WorkspaceHealthInput[], over: Partial<AccountHealthInput> = {}): AccountHealthInput {
  return { accountStatus: "ACTIVE", failedJobs: 0, revenueVnd: 499_000, grossProfitVnd: 300_000, workspaces, ...over };
}

const codes = (w: { reasons: { code: HealthReasonCode }[] }) => w.reasons.map((r) => r.code).sort();

function expectWs(label: string, input: WorkspaceHealthInput, level: CustomerHealthLevel, reasons: HealthReasonCode[] = [], gaps?: string[]) {
  const r = classifyWorkspace(input, NOW);
  assert.equal(r.level, level, `${label}: mức ${r.level} ≠ ${level} — ${JSON.stringify(r.reasons.map((x) => x.text))} ${JSON.stringify(r.gaps.map((g) => g.code))}`);
  assert.deepEqual(codes(r), [...reasons].sort(), `${label}: lý do`);
  if (gaps) assert.deepEqual(r.gaps.map((g) => g.code).sort(), [...gaps].sort(), `${label}: chỗ chưa đo`);
  for (const x of r.reasons) {
    assert.equal(x.level, HEALTH_REASONS[x.code].level, `${label}: mức của lý do ${x.code} lấy từ bảng khai`);
    assert.ok(x.text.length >= 10, `${label}: lý do ${x.code} phải là câu cụ thể`);
  }
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
  expectWs("ERP đăng nhập 2 ngày", erpWs(), "HEALTHY", [], []);
  assert.deepEqual(classifyWorkspace(healthyWs(), NOW), classifyWorkspace(healthyWs(), NOW), "chạy hai lần ra một kết quả");

  // THIẾU ⇒ KHÔNG BAO GIỜ KHOẺ.
  expectWs("không đọc được đăng nhập", healthyWs({ login: null }), "UNKNOWN", [], ["LOGIN_UNREADABLE"]);
  expectWs("không đọc được sổ AI", healthyWs({ ai: null }), "UNKNOWN", [], ["AI_LEDGER_UNREADABLE"]);
  expectWs("không đọc được sổ dùng", healthyWs({ usage: null }), "UNKNOWN", [], ["USAGE_LEDGER_UNREADABLE"]);
  expectWs("sổ dùng chưa có ngày nào", healthyWs({ usage: [] }), "UNKNOWN", [], ["USAGE_LEDGER_MISSING"]);
  expectWs("sổ dùng cũ", healthyWs({ usage: ledger(10, () => ({ capturedAt: ago((T.usageLedgerFreshHours + 1) * HOUR) })) }), "UNKNOWN", [], ["USAGE_LEDGER_STALE"]);
  expectWs("không đọc được module", healthyWs({ modules: null }), "UNKNOWN", [], ["MODULES_UNREADABLE"]);
  expectWs("không đọc được công tắc AI", healthyWs({ aiSwitch: null }), "UNKNOWN", [], ["AI_SWITCH_UNREADABLE"]);
  expectWs("runtime bot cũ", healthyWs({ modules: { aiSales: false, legacyChatbot: true } }), "UNKNOWN", [], ["AI_RUNTIME_LEGACY"]);
  // Thiếu dữ liệu KHÔNG che lý do: có lý do thì mức theo lý do, chỗ chưa đo vẫn được nói ra.
  const mixed = expectWs("thiếu sổ dùng + AI đang lỗi", healthyWs({ usage: null, ai: aiOk({ errorsInWindow: 3, okInWindow: 0, lastErrorAt: ago(60_000), lastOkAt: ago(30 * 60_000) }) }), "CRITICAL", ["AI_FAILING"], ["USAGE_LEDGER_UNREADABLE"]);
  assert.ok(mixed.reasons[0].text.includes(`${T.aiFailWindowMinutes} phút`));

  // AI.
  expectWs("AI bị tắt riêng tổ chức", healthyWs({ aiSwitch: { platformEnabled: true, orgDisabled: true } }), "CRITICAL", ["AI_OFF"]);
  expectWs("AI bị tắt toàn nền tảng", healthyWs({ aiSwitch: { platformEnabled: false, orgDisabled: false } }), "CRITICAL", ["AI_OFF"]);
  const blocked = expectWs("AI bị chặn hạn mức liên tục", healthyWs({ ai: aiOk({ blockedInWindow: 3, blocked24h: 3, lastErrorAt: ago(60_000), lastOkAt: ago(HOUR) }) }), "CRITICAL", ["AI_FAILING"]);
  assert.ok(blocked.reasons[0].text.includes("bị chặn"), "nói đúng nguyên nhân: bị chặn, không phải lỗi provider");
  expectWs("AI lỗi đã phục hồi nhưng tỷ lệ cao", healthyWs({ ai: aiOk({ ok24h: 40, errors24h: 10, lastErrorAt: ago(2 * HOUR), lastOkAt: ago(60_000) }) }), "NEEDS_ATTENTION", ["AI_ERRORS_RECENT"]);
  expectWs("AI lỗi chưa phục hồi (dưới ngưỡng đang lỗi)", healthyWs({ ai: aiOk({ errors24h: 2, errorsInWindow: 1, lastErrorAt: ago(60_000), lastOkAt: ago(HOUR) }) }), "NEEDS_ATTENTION", ["AI_ERRORS_RECENT"]);
  expectWs("một lượt lỗi lẻ đã phục hồi ⇒ không lý do", healthyWs({ ai: aiOk({ errors24h: 1, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000) }) }), "HEALTHY");
  expectWs("tỷ lệ cao nhưng dưới mẫu tối thiểu", healthyWs({ ai: aiOk({ ok24h: 5, errors24h: 2, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000) }) }), "HEALTHY");
  expectWs("AI bị chặn rải rác", healthyWs({ ai: aiOk({ blocked24h: 2, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000) }) }), "NEEDS_ATTENTION", ["AI_BLOCKED_QUOTA"]);

  // Ghi đơn — lượt ghi đơn cũng là lượt sales_chatbot: lỗi ghi đơn KHÔNG bị đếm lần hai thành «AI lỗi».
  expectWs(
    "ghi đơn đang lỗi",
    healthyWs({ ai: aiOk({ errors24h: 3, errorsInWindow: 3, orderSyncErrors24h: 3, orderSyncErrorsInWindow: 3, lastErrorAt: ago(60_000), lastOkAt: ago(10 * 60_000), orderSyncLastErrorAt: ago(60_000), orderSyncLastOkAt: ago(2 * HOUR) }) }),
    "CRITICAL",
    ["ORDER_SYNC_FAILING"],
  );
  expectWs("ghi đơn lỗi đã phục hồi", healthyWs({ ai: aiOk({ errors24h: 2, orderSyncErrors24h: 2, lastErrorAt: ago(3 * HOUR), lastOkAt: ago(60_000), orderSyncLastErrorAt: ago(3 * HOUR), orderSyncLastOkAt: ago(HOUR) }) }), "NEEDS_ATTENTION", ["ORDER_SYNC_ERRORS"]);

  // Bot im: ngày có ≥ N tin khách, 0 tin bot, trước đó bot vẫn trả lời.
  const silent = expectWs("bot im hôm nay", healthyWs({ usage: ledger(10, (i) => (i === 0 ? { customerMessages: 6, botMessages: 0 } : {})) }), "NEEDS_ATTENTION", ["AI_SILENT"]);
  assert.ok(silent.reasons[0].text.includes("6 tin"));
  expectWs("dưới ngưỡng tin khách ⇒ không im", healthyWs({ usage: ledger(10, (i) => (i === 0 ? { customerMessages: T.aiSilentMinCustomerMessages - 1, botMessages: 0 } : {})) }), "HEALTHY");
  expectWs("bot chưa từng trả lời trong 7 ngày ⇒ không gọi là im", healthyWs({ usage: ledger(10, () => ({ botMessages: 0 })), ai: aiOk({ ok7d: 3 }) }), "HEALTHY");
  expectWs("AI bị tắt đã giải thích im lặng", healthyWs({ aiSwitch: { platformEnabled: true, orgDisabled: true }, usage: ledger(10, (i) => (i === 0 ? { customerMessages: 6, botMessages: 0 } : {})) }), "CRITICAL", ["AI_OFF"]);

  // Kênh.
  const lost = ledger(10, (i) => (i <= 1 ? { fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 } : {}));
  expectWs("mất kênh: 0 fanpage + tin khách dừng", healthyWs({ usage: lost }), "CRITICAL", ["CHANNEL_LOST"]);
  expectWs("0 fanpage nhưng khách vẫn nhắn qua kênh khác", healthyWs({ usage: ledger(10, (i) => (i <= 1 ? { fanpagesActive: 0 } : {})) }), "NEEDS_ATTENTION", ["FANPAGE_OFF"]);
  expectWs("kết nối đơn cũ (fanpage chưa đếm được) ⇒ không kết luận", healthyWs({ usage: ledger(10, () => ({ fanpagesActive: null })) }), "HEALTHY");
  const never = { messengerPages: 0, milestones: { channelConnectedAt: null, firstAiReplyAt: null, firstAiOrderAt: null }, ai: aiOk({ ok7d: 0, ok24h: 0, okInWindow: 0, lastOkAt: null }), usage: ledger(5, () => ({ fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 })) };
  expectWs("chưa nối kênh sau ân hạn", healthyWs({ ...never, createdAt: ago(5 * DAY) }), "NEEDS_ATTENTION", ["NO_CHANNEL"]);
  expectWs("chưa nối kênh trong ân hạn ⇒ đang thiết lập, KHÔNG khoẻ", healthyWs({ ...never, createdAt: ago(2 * HOUR), usage: ledger(1, () => ({ fanpagesActive: 0, customerMessages: 0, botMessages: 0, aiOrders: 0 })) }), "UNKNOWN", [], ["NEW_WORKSPACE_PENDING"]);
  expectWs("không đọc được mốc ⇒ không phân biệt chưa nối / mất kênh", healthyWs({ ...never, milestones: null, createdAt: ago(5 * DAY) }), "UNKNOWN", [], ["MILESTONES_UNREADABLE"]);

  // Tin khách dừng (luật 52): có nền ⇒ cần chú ý; nền dưới số ngày tối thiểu ⇒ không kết luận.
  const drop = ledger(10, (i) => (i <= 1 ? { customerMessages: 0, botMessages: 0 } : {}));
  expectWs("tin khách dừng có nền", healthyWs({ usage: drop }), "NEEDS_ATTENTION", ["INBOUND_DROP"]);
  const shortBase = ledger(10, (i) => (i <= 1 ? { customerMessages: 0, botMessages: 0 } : {})).filter((r, k, all) => k >= all.length - (T.inboundDropDays + T.inboundBaselineMinDays - 1));
  expectWs("nền dưới số ngày tối thiểu ⇒ không kết luận dừng", healthyWs({ usage: shortBase }), "HEALTHY");

  // Kích hoạt / không hoạt động.
  expectWs(
    "chưa kích hoạt sau ân hạn (khách nhắn, AI chưa từng trả lời)",
    healthyWs({ milestones: { channelConnectedAt: ago(5 * DAY), firstAiReplyAt: null, firstAiOrderAt: null }, ai: aiOk({ ok7d: 0, ok24h: 0, okInWindow: 0, lastOkAt: null }), usage: ledger(6, () => ({ botMessages: 0, aiOrders: 0 })), createdAt: ago(6 * DAY) }),
    "NEEDS_ATTENTION",
    ["NOT_ACTIVATED"],
  );
  expectWs("mốc chưa quét kịp nhưng sổ AI đã có lượt thành công ⇒ đã chạy", healthyWs({ milestones: { channelConnectedAt: ago(5 * DAY), firstAiReplyAt: null, firstAiOrderAt: null } }), "HEALTHY");
  expectWs("không hoạt động 7 ngày (đã từng chạy, không có nền)", healthyWs({ usage: ledger(10, () => ({ customerMessages: 0, botMessages: 0, aiOrders: 0, conversationsStarted: 0 })), ai: aiOk({ ok7d: 0, ok24h: 0, okInWindow: 0, lastOkAt: ago(9 * DAY) }) }), "NEEDS_ATTENTION", ["NO_ACTIVITY"]);

  // Đăng nhập: chỉ kết luận khi MỌI phiên chắc chắn đã hết hạn (trần tuyệt đối của phiên).
  expectWs("không đăng nhập quá trần phiên", healthyWs({ login: { identities: 2, lastLoginAt: ago((T.loginStaleDays + 1) * DAY) } }), "NEEDS_ATTENTION", ["LOGIN_STALE"]);
  expectWs("đăng nhập 20 ngày — phiên trượt có thể còn ⇒ không kết luận", healthyWs({ login: { identities: 2, lastLoginAt: ago(20 * DAY) } }), "HEALTHY");
  expectWs("chưa ai đăng nhập sau ân hạn", erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: ago(3 * DAY) }), "NEEDS_ATTENTION", ["NEVER_LOGGED_IN"]);
  expectWs("chưa ai đăng nhập trong ân hạn ⇒ đang thiết lập", erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: ago(2 * HOUR) }), "UNKNOWN", [], ["NEW_WORKSPACE_PENDING"]);
  // Có từ TRƯỚC chỉ mục: vắng dòng chỉ chứng minh «không đăng nhập từ ngày chỉ mục»; còn trong trần phiên ⇒ chưa biết.
  const old = erpWs({ login: { identities: 0, lastLoginAt: null }, createdAt: new Date(INDEX_START.getTime() - 30 * DAY) });
  const r1 = classifyWorkspace(old, new Date(INDEX_START.getTime() + 10 * DAY));
  assert.equal(r1.level, "UNKNOWN", "trước chỉ mục + còn trong trần phiên ⇒ chưa biết, không phải bỏ dùng");
  assert.deepEqual(r1.gaps.map((g) => g.code), ["LOGIN_BEFORE_INDEX"]);
  const r2 = classifyWorkspace(old, new Date(INDEX_START.getTime() + (T.loginStaleDays + 1) * DAY));
  assert.deepEqual(codes(r2), ["LOGIN_STALE"], "quá trần phiên kể từ ngày chỉ mục ⇒ chắc chắn không ai đang dùng");

  // Hạn mức: ngưỡng cảnh báo của phiên bản giá; trả trước theo khách AI (gồm 0 theo thiết kế) KHÔNG phải vượt.
  const over = expectWs("vượt hạn mức khách AI", healthyWs({ aiCustomers: { value: 130, coverage: "MEASURED", included: 100, alerts: DEFAULT_USAGE_ALERTS, prepaid: false } }), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"]);
  assert.ok(over.reasons[0].text.includes("130/100"));
  expectWs("chạm ngưỡng báo người vận hành (80%)", healthyWs({ aiCustomers: { value: 85, coverage: "MEASURED", included: 100, alerts: DEFAULT_USAGE_ALERTS, prepaid: false } }), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"]);
  expectWs("trả trước: gồm 0 khách AI theo thiết kế", healthyWs({ aiCustomers: { value: 50, coverage: "MEASURED", included: 0, alerts: DEFAULT_USAGE_ALERTS, prepaid: true } }), "HEALTHY");
  expectWs("đồng hồ chưa đo ⇒ không kết luận vượt", healthyWs({ aiCustomers: { value: null, coverage: "NOT_MEASURED", included: 100, alerts: DEFAULT_USAGE_ALERTS, prepaid: false } }), "HEALTHY");
  expectWs("vượt ghế", healthyWs({ overageSeats: [{ label: "Người dùng thêm", overUnits: 2 }] }), "NEEDS_ATTENTION", ["USAGE_OVER_LIMIT"]);
  expectWs("vượt fair-use", healthyWs({ fairUseFlagged: true }), "NEEDS_ATTENTION", ["FAIR_USE"]);

  // Thương mại / vòng đời.
  expectWs("hết hạn — chỉ xem", healthyWs({ subscriptions: [{ productKey: "chotdon", status: "EXPIRED" }] }), "CRITICAL", ["SUBSCRIPTION_EXPIRED"]);
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
  assert.equal(classifyCustomer(account([healthyWs({ orgStatus: "ARCHIVED" })]), NOW).level, "INACTIVE");
  assert.equal(classifyCustomer(account([healthyWs()], { accountStatus: "CLOSED" }), NOW).level, "INACTIVE");
  const failed = classifyCustomer(account([healthyWs()], { failedJobs: 1 }), NOW);
  assert.equal(failed.level, "CRITICAL");
  assert.deepEqual(failed.accountReasons.map((r) => r.code), ["PROVISIONING_FAILED"]);
  assert.deepEqual(codes(classifyCustomer(account([]), NOW)), ["NO_WORKSPACE"]);
  assert.deepEqual(codes(classifyCustomer(account([healthyWs()], { revenueVnd: 499_000, grossProfitVnd: -120_000 }), NOW)), ["LOSING_MONEY"], "khách TRẢ TIỀN mà lỗ gộp");
  assert.equal(classifyCustomer(account([healthyWs()], { revenueVnd: 0, grossProfitVnd: -50_000 }), NOW).level, "HEALTHY", "dùng thử lỗ gộp là đúng thiết kế");
  assert.equal(classifyCustomer(account([healthyWs({ login: null })]), NOW).level, "UNKNOWN", "thiếu ở workspace ⇒ tài khoản không khoẻ");

  // Bảng mức.
  assert.equal(worstLevel(["HEALTHY", "UNKNOWN", "NEEDS_ATTENTION"]), "NEEDS_ATTENTION");
  assert.equal(worstLevel([]), "INACTIVE");
  assert.deepEqual([...CUSTOMER_HEALTH_LEVELS], ["CRITICAL", "NEEDS_ATTENTION", "UNKNOWN", "HEALTHY", "INACTIVE"]);
  console.log("  ✓ sức khoẻ khách (thuần): khoẻ khi đủ dữ liệu, thiếu ⇒ không khoẻ, AI / kênh / đăng nhập / hạn mức / đơn / vòng đời đúng mức + lý do");
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

const goc = path.resolve(__dirname, "..");
const boChuThich = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ma = (tep: string) => boChuThich(readFileSync(path.join(goc, tep), "utf8"));

function tepMa(): string[] {
  return execSync("git ls-files lib app components", { cwd: goc, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(path.sep).join("/"))
    .filter((l) => /\.(ts|tsx)$/.test(l));
}

function testSource() {
  // Ngưỡng LẤY LẠI từ hằng đang chạy (luật 22) — không gõ lại số.
  assert.equal(T.aiFailBurst, DEFAULT_AI_SALES_SLO.providerErrorBurst);
  assert.equal(T.aiFailWindowMinutes, DEFAULT_AI_SALES_SLO.providerWindowMinutes);
  assert.equal(T.aiSilentMinCustomerMessages, DEFAULT_AI_SALES_SLO.silentMinCustomerMessages);
  assert.equal(T.inboundBaselineMinDays, DEFAULT_AI_SALES_SLO.webhookBaselineMinDays);
  assert.equal(T.loginStaleDays, SESSION_ABSOLUTE_DAYS);
  // Sổ dùng chụp mỗi SAAS_SNAPSHOT_JOB_EVERY_MS: ngưỡng tươi phải chịu được lỡ MỘT nhịp nhưng không quá hai nhịp + dung sai.
  assert.ok(T.usageLedgerFreshHours * HOUR > SAAS_SNAPSHOT_JOB_EVERY_MS, "ngưỡng tươi ngắn hơn một nhịp chụp ⇒ mọi khách sẽ «sổ cũ»");
  assert.ok(T.usageLedgerFreshHours * HOUR <= 2 * SAAS_SNAPSHOT_JOB_EVERY_MS + HOUR, "đổi nhịp chụp mà quên ngưỡng tươi");

  // Hàm phân loại THUẦN: không CSDL, không đồng hồ.
  const pure = ma("lib/saas/customer-health.ts");
  assert.ok(!/from\s+["']@\/db["']/.test(pure) && !/\bget(?:Platform)?Db\w*\(/.test(pure), "hàm phân loại không đọc CSDL");
  assert.ok(!/Date\.now\(|new Date\(\)/.test(pure), "hàm phân loại không đọc đồng hồ — `now` truyền vào");

  // Đường đọc gom: KHÔNG mở CSDL tổ chức nào (không N+1) — chỉ mặt phẳng điều khiển.
  const reader = ma("lib/saas/customer-signals.ts");
  assert.ok(!/\b(?:getDbFor|getDbForInspection|withOrganization|getDb)\s*\(/.test(reader), "đường đọc sức khoẻ không mở CSDL tổ chức");
  assert.ok(!/\bloadOrgSupport\(|\blistOrgSupportSummaries\(|\bloadOrgDiagnostics\(/.test(reader), "không gọi lại đường đọc mở CSDL từng tổ chức");

  // Đường đọc xuyên tổ chức chỉ được gọi SAU cổng người vận hành (console.ts) — không trang / action nào gọi thẳng.
  const goiDocSucKhoe: string[] = [];
  const goiSoAiGom: string[] = [];
  for (const tep of tepMa()) {
    const m = ma(tep);
    if (/\breadCustomerHealth\(/.test(m.replace(/export async function readCustomerHealth\(/, "")) && tep !== "lib/saas/console.ts") goiDocSucKhoe.push(tep);
    if (/\bsalesAiUsageHealthByOrg\(/.test(m.replace(/export async function salesAiUsageHealthByOrg\(/, "")) && !["lib/saas/customer-signals.ts", "lib/ai-usage/sales-health.ts"].includes(tep)) goiSoAiGom.push(tep);
  }
  assert.deepEqual(goiDocSucKhoe, [], "readCustomerHealth nhìn xuyên mọi tổ chức — chỉ lib/saas/console.ts (sau platformOperatorDenial) được gọi");
  assert.deepEqual(goiSoAiGom, [], "sổ AI gom theo tổ chức chỉ đọc ở đường sức khoẻ khách");
  const consoleSrc = ma("lib/saas/console.ts");
  for (const fn of ["loadCustomersConsole", "loadCustomerDetail"]) {
    const body = consoleSrc.slice(consoleSrc.indexOf(`export async function ${fn}(`));
    assert.ok(body.indexOf("platformOperatorDenial(") < body.indexOf("readCustomerHealth("), `${fn}: hỏi người vận hành TRƯỚC khi đọc sức khoẻ`);
  }
  const page = ma("app/(dashboard)/platform/customers/page.tsx");
  assert.ok(/requirePermission\(\s*["']platform:operate["']\s*\)/.test(page) && /platformOperatorDenial\(user\)/.test(page), "trang chỉ người vận hành nền tảng");
  assert.ok(!/customer-signals/.test(page), "trang đọc qua console.ts, không gọi thẳng đường đọc");
  console.log("  ✓ sức khoẻ khách (mã nguồn): ngưỡng lấy lại hằng đang chạy, phân loại thuần, không mở CSDL tổ chức, chỉ sau cổng người vận hành");
}

// ═══════════ 3 · CSDL THẬT ═══════════

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

/** Sổ dùng `n` ngày tới hôm nay (giờ VN của đồng hồ THẬT — cùng nhịp với `loadCustomersConsole`). */
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

async function testDb() {
  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  const op = user({ id: "skh-op", email: "op@skh.local", organization: { code: home.code, name: home.name, isHome: true } });
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
  await pdb.insert(schema.platformOrgMilestones).values(
    (["SIGNED_UP", "CHANNEL_CONNECTED", "FIRST_CONVERSATION", "FIRST_AI_REPLY", "FIRST_AI_ORDER"] as const).map((milestone, i) => ({ orgCode: KHOE, milestone, reachedAt: new Date(now.getTime() - (20 - i) * DAY), source: "test" })),
  );

  // skh-hong: AI hỏng 3 lượt sau lượt thành công cuối, ghi đơn hỏng 3 lượt, 0 fanpage + 0 tin khách hai ngày gần nhất.
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
    const r = await loadCustomersConsole(u);
    assert.ok("error" in r, `${u.email} không được xem sức khoẻ khách`);
    assert.ok(!JSON.stringify(r).includes(KHOE), `${u.email}: câu từ chối không mang mã tổ chức khác`);
    const d = await loadCustomerDetail(u, KHOE);
    assert.ok(d && "error" in d, `${u.email} không mở được trang một khách`);
  }

  // ── Người vận hành: đúng mức + lý do cho ba tổ chức.
  const list = await loadCustomersConsole(op);
  assert.ok(!("error" in list));
  const acct = async (code: string) => (await accountOfWorkspace(code))!;
  const hKhoe = list.health[(await acct(KHOE)).id];
  const hHong = list.health[(await acct(HONG)).id];
  const hMoi = list.health[(await acct(MOI)).id];
  assert.ok(hKhoe && hHong && hMoi, "mỗi tài khoản có một kết quả sức khoẻ");
  assert.equal(hKhoe.level, "HEALTHY", `skh-khoe: ${JSON.stringify(hKhoe.reasons.map((r) => r.text))} ${JSON.stringify(hKhoe.gaps.map((g) => g.text))}`);
  const fk = hKhoe.workspaces[0].facts;
  assert.deepEqual([fk.identities, fk.messengerPages, fk.fanpagesActive, fk.ai.ok24h, fk.ai.state, fk.orders.lastAiOrderDay], [1, 1, 1, 5, "ON", vnDate(now)]);
  assert.equal(hHong.level, "CRITICAL");
  assert.deepEqual(codes(hHong), ["AI_FAILING", "CHANNEL_LOST", "ORDER_SYNC_FAILING"], JSON.stringify(hHong.reasons.map((r) => r.text)));
  assert.equal(hHong.workspaces[0].facts.ai.chatErrors24h, 3, "lỗi ghi đơn không đếm đôi thành lỗi trả lời");
  assert.equal(hMoi.level, "NEEDS_ATTENTION");
  assert.deepEqual(codes(hMoi), ["NEVER_LOGGED_IN"], JSON.stringify(hMoi.reasons.map((r) => r.text)));
  assert.equal(hMoi.workspaces[0].facts.ai.applies, false, "ERP: tín hiệu AI không áp dụng (N/A), không phải lỗi");
  // Không dữ liệu của người / page trong kết quả.
  const json = JSON.stringify([hKhoe, hHong, hMoi]);
  for (const s of SECRET_STRINGS) assert.ok(!json.includes(s), `kết quả sức khoẻ không mang «${s}»`);

  // ── Trang một khách: cùng đường đọc, cùng hàm ⇒ cùng mức.
  const detail = await loadCustomerDetail(op, (await acct(HONG)).code);
  assert.ok(detail && !("error" in detail));
  assert.equal(detail.health.level, "CRITICAL");
  assert.deepEqual(codes(detail.health), codes(hHong));
  console.log("  ✓ sức khoẻ khách (CSDL): ba tổ chức thử đúng mức + lý do, chi tiết cùng mức, người ngoài bị từ chối, không lộ dữ liệu người");
}

export async function testCustomerHealth() {
  testPure();
  testSource();
  await cleanup();
  try {
    await testDb();
  } finally {
    await cleanup();
  }
  console.log("✓ Sức khoẻ khách SaaS: phân loại thuần · thiếu không bao giờ khoẻ · một lượt gom ở CSDL nhà · chỉ người vận hành");
}
