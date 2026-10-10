/**
 * ═══════════ CỔNG CHẠY THEO PAGE CỦA WORKSPACE NHÀ (lib/sales-chatbot/page-runtime*.ts · docs/saas/OWNERSHIP.md §4) ═══════════
 *
 * Production 07/10/2026: module `ai_sales` của nhà ĐANG BẬT, bot cũ `chatbot/` vẫn trả lời khách nhà. Trước bản này chỉ một
 * công tắc (`cfg.enabled`) đứng giữa khách thật của nhà và bot mới. Bài này khoá:
 *
 *  1. THUẦN — khách luôn LIVE; nhà không khai ⇒ OFF; danh sách bẩn ⇒ bỏ; «phục vụ khách» của nhà chỉ khi có page LIVE.
 *  2. NHÀ THẬT (CSDL nhà của bộ kiểm thử), module bật + bot bật + Pancake giả + provider giả:
 *     · danh sách RỖNG ⇒ 0 tin gửi và 0 lời gọi AI trên MỌI đường: xử lý tin (webhook), quét lại tin rơi (không cả ĐỌC Pancake),
 *       thử lại tin AI hỏng, follow-up, ghi đơn từ hội thoại, chốt cuối của hàm gửi; việc không gắn page (tin sáng mua lại · báo
 *       nhóm đơn mới · tự học) bỏ qua; «cứu hội thoại bỏ sót» chỉ đọc;
 *     · SHADOW ⇒ một câu soạn bóng được LƯU (kể cả khi bot cũ đã trả lời trước), 0 tin gửi, 0 đơn, không hội thoại bóng nào còn
 *       lại; câu của bot cũ được đem so; follow-up / chốt cuối vẫn chặn;
 *     · LIVE (đòi xác nhận bot cũ) ⇒ gửi như khách; người chỉ xem không đổi được; mỗi lượt có nhật ký.
 *  3. KHÁCH — một danh sách lạc vào CSDL khách cũng không đổi gì: bot vẫn trả lời; công tắc từ chối ở khách.
 *  4. QUÉT MÃ NGUỒN — ba hàm xử lý tin (fanpage · Messenger · Zalo) hỏi cổng TRƯỚC mọi bước «page đã trả lời»; thử lại tin chỉ đi
 *     qua hai hàm xử lý đó; «cứu hội thoại» không import hàm gửi nào.
 *
 * Mọi thứ ghi vào CSDL nhà được dọn / trả lại nguyên trạng trong `finally` (page thử riêng, khoá cài đặt chụp trước).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { sendReorderDigest } from "@/lib/reorder/digest";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { AI_DOWN_HANDOFF_REASON, setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { catchUpFanpage, conversationFor, fanpageBotSendersForTests, PAGE_REPLY, parsePancakeWebhook, processFanpageThread, receiveFanpageEvent, sendFanpageText } from "@/lib/sales-chatbot/fanpage";
import { sendBotImages } from "@/lib/sales-chatbot/messenger";
import { runSalesFollowups } from "@/lib/sales-chatbot/followup";
import { DEAD_AI_DOWN_NOTE, requeueAiDownDeadLetters } from "@/lib/sales-chatbot/inbound-retry";
import { learnLessons } from "@/lib/sales-chatbot/lessons";
import { LESSONS_SETTING_KEY } from "@/lib/sales-chatbot/lessons-shared";
import { sendNewOrderAlerts } from "@/lib/sales-chatbot/new-order-alert";
import { scoreCopilotSuggestions } from "@/lib/sales-chatbot/operating-mode";
import { OPERATING_MODE_SETTING_KEY } from "@/lib/sales-chatbot/operating-mode-shared";
import { runFanpageOrderSync, syncFanpageThreadWhenQuiet } from "@/lib/sales-chatbot/order-sync";
import { ORDER_SYNC_SETTING_KEY } from "@/lib/sales-chatbot/order-sync-shared";
import { homeRuntimeIdleReason, pageRuntimeView, savePageRuntime, setPageRuntimeReaderForTests } from "@/lib/sales-chatbot/page-runtime";
import {
  PAGE_NOT_LIVE_SEND_ERROR,
  PAGE_OFF_NOTE,
  PAGE_RUNTIME_SETTING_KEY,
  PAGE_SHADOW_NOTE,
  pageRuntimeModeOf,
  parsePageRuntime,
  runtimeServesCustomers,
} from "@/lib/sales-chatbot/page-runtime-shared";
import { findMissedConversations } from "@/lib/sales-chatbot/recovery";
import { FOLLOWUP_SETTING_KEY } from "@/lib/sales-chatbot/followup-shared";
import { setSettingJson } from "@/lib/settings";

const goc = path.resolve(__dirname, "..");
const PAGE = "9911223344556";
const PAGE_TOKEN = "pancake_page_token_pg_gate_0123456789abcdef";
const PAGE2 = "9911223344557";
const KHACH = "pg-khach";
const KHACH_PAGE = "8811223344556";
const SECRET_KEY = "khoa-kiem-thu-cong-page-0123456789abcdefghijklmnopqrstuvwxyz";
const REPLY = "Dạ chả mực 250.000đ/kg ạ";
const ADMIN_EMAIL = "pg-gate-admin@test.local";

/* ═════════════ 1 · THUẦN ═════════════ */
function kiemThuan() {
  const home = { isHome: true };
  const khach = { isHome: false };
  assert.equal(pageRuntimeModeOf(khach, {}, "p1"), "LIVE", "khách không có cổng: mọi page LIVE");
  assert.equal(pageRuntimeModeOf(khach, { p1: { mode: "OFF", updatedAt: null, updatedByEmail: null } }, "p1"), "LIVE", "danh sách lạc vào khách cũng bị bỏ qua");
  assert.equal(pageRuntimeModeOf(home, {}, "p1"), "OFF", "nhà: danh sách rỗng ⇒ OFF");
  assert.equal(pageRuntimeModeOf(home, {}, ""), "OFF");
  assert.equal(pageRuntimeModeOf(home, {}, null), "OFF");
  const map = parsePageRuntime({ p1: { mode: "SHADOW" }, p2: { mode: "LIVE", updatedAt: "t", updatedByEmail: "a@b" }, p3: { mode: "BAT_HET" }, "x y": { mode: "LIVE" }, p4: "LIVE" });
  assert.deepEqual(Object.keys(map).sort(), ["p1", "p2"], "mã page lạ / chế độ lạ bị bỏ (page đó về OFF)");
  assert.equal(pageRuntimeModeOf(home, map, "p1"), "SHADOW");
  assert.equal(pageRuntimeModeOf(home, map, "p2"), "LIVE");
  assert.equal(pageRuntimeModeOf(home, map, "p3"), "OFF");
  assert.deepEqual(parsePageRuntime(null), {});
  assert.deepEqual(parsePageRuntime(["p1"]), {});
  assert.equal(runtimeServesCustomers(khach, {}), true);
  assert.equal(runtimeServesCustomers(home, {}), false);
  assert.equal(runtimeServesCustomers(home, { p1: map.p1 }), false, "BÓNG không tính là phục vụ khách");
  assert.equal(runtimeServesCustomers(home, map), true);
}

/* ═════════════ dụng cụ ═════════════ */
function fakePancake() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `m-bot-${Math.random().toString(36).slice(2, 8)}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls, sent: () => calls.filter((c) => c.init?.method === "POST" && c.url.includes("/messages")) };
}

function fakeProvider(onCall: () => void): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      onCall();
      const content: AiBlock[] = [{ type: "text", text: REPLY }];
      return { content, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

const ev = (page: string, id: string, text: string, thread: string) => parsePancakeWebhook({ event_type: "messaging", page_id: page, data: { conversation: { id: thread, type: "INBOX" }, message: { id, type: "INBOX", message: text, from: { id: `cust-${thread}`, name: "Khách" } } } })!;
const later = () => new Date(Date.now() + 5 * 60_000);

async function datAiSalesNha(homeId: string, enabled: boolean | null) {
  const pdb = await getPlatformDb();
  const where = and(eq(schema.platformOrganizationModules.organizationId, homeId), eq(schema.platformOrganizationModules.moduleKey, "ai_sales"));
  if (enabled === null) await pdb.delete(schema.platformOrganizationModules).where(where);
  else {
    await pdb
      .insert(schema.platformOrganizationModules)
      .values({ organizationId: homeId, moduleKey: "ai_sales", enabled, updatedBy: "system:test" })
      .onConflictDoUpdate({ target: [schema.platformOrganizationModules.organizationId, schema.platformOrganizationModules.moduleKey], set: { enabled, updatedBy: "system:test" } });
  }
  invalidateCapabilities();
}

async function connectPancake(admin: SessionUser, page: string, pancake: ReturnType<typeof fakePancake>) {
  assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: page }, secrets: { pageAccessToken: PAGE_TOKEN } })));
  assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
  assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
}

/* ═════════════ 2 · NHÀ ═════════════ */
const SNAP_KEYS = [SALES_CHATBOT_SETTING_KEY, PAGE_RUNTIME_SETTING_KEY, ORDER_SYNC_SETTING_KEY, OPERATING_MODE_SETTING_KEY, FOLLOWUP_SETTING_KEY, LESSONS_SETTING_KEY] as const;

async function kiemNha() {
  const home = await getHomeOrganization();
  const pdb = await getPlatformDb();
  const [goc0] = await pdb
    .select({ enabled: schema.platformOrganizationModules.enabled })
    .from(schema.platformOrganizationModules)
    .where(and(eq(schema.platformOrganizationModules.organizationId, home.id), eq(schema.platformOrganizationModules.moduleKey, "ai_sales")));
  const nguyenTrang = goc0 ? goc0.enabled : null;
  const startedAt = new Date(Date.now() - 1_000);
  let aiCalls = 0;
  setSalesChatProviderForTests(() => fakeProvider(() => (aiCalls += 1)));
  await datAiSalesNha(home.id, true);
  await withOrganization(home.code, async () => {
    const db = await getDb();
    const st = schema.settings;
    const snap = await db.select().from(st).where(inArray(st.key, [...SNAP_KEYS]));
    const [connBefore] = await db.select({ id: schema.orgConnections.id }).from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "pancake-fanpage"));
    assert.equal(connBefore, undefined, "CSDL nhà của bộ kiểm thử chưa có kết nối fanpage — bài này dựng rồi gỡ");
    // Quản trị viên RIÊNG của bài (xoá ở cuối) — không mượn tài khoản của bài khác.
    await db.delete(schema.users).where(eq(schema.users.email, ADMIN_EMAIL));
    const [u] = await db.insert(schema.users).values({ email: ADMIN_EMAIL, name: "Cổng page", passwordHash: "khong-dang-nhap", role: "ADMIN" }).returning();
    const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    const viewer: SessionUser = { ...admin, id: "pg-viewer", role: "VIEWER", permissions: ["ai_sales:view"] };
    const t = schema.salesChatInbound;
    const cv = schema.salesChatConversations;
    try {
      const pancake = fakePancake();
      await connectPancake(admin, PAGE, pancake);
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: 30_000 });
      await db.delete(st).where(inArray(st.key, [PAGE_RUNTIME_SETTING_KEY, OPERATING_MODE_SETTING_KEY, FOLLOWUP_SETTING_KEY, ORDER_SYNC_SETTING_KEY, LESSONS_SETTING_KEY]));
      const sentTo = (thread: string) => pancake.sent().filter((c) => c.url.includes(`/conversations/${thread}/messages`)).length;
      const rowsOf = (thread: string) => db.select().from(t).where(and(eq(t.pageId, PAGE), eq(t.threadId, thread)));
      const waiting = async (thread: string) => {
        const conv = await conversationFor(PAGE, thread);
        assert.ok(conv);
        const now = new Date();
        await db.update(cv).set({ status: "WAITING", lastCustomerAt: new Date(now.getTime() - 2 * 3_600_000), lastBotAt: new Date(now.getTime() - 2 * 3_600_000), waitingSince: new Date(now.getTime() - 2 * 3_600_000), nextFollowupAt: new Date(now.getTime() - 60_000), followupsSent: 0 }).where(eq(cv.id, conv.id));
        return conv.id;
      };

      /* ── Ca 1 · danh sách RỖNG ⇒ 0 tin trên MỌI đường ── */
      assert.equal((await pageRuntimeView()).pages.find((p) => p.id === PAGE)?.mode, "OFF", "page đã nối mà chưa khai ⇒ OFF trên màn hình");
      // (a) webhook ⇒ xử lý tin
      assert.ok((await receiveFanpageEvent(ev(PAGE, "pg-o1", "Chả mực bao nhiêu?", "pg-off"))).queued);
      const r1 = await processFanpageThread(PAGE, "pg-off", { fetch: pancake.fetch, now: later });
      assert.equal(r1.skipped, PAGE_OFF_NOTE, JSON.stringify(r1));
      assert.equal(aiCalls, 0, "OFF ⇒ không gọi AI");
      assert.equal(sentTo("pg-off"), 0, "OFF ⇒ không gửi");
      assert.ok((await rowsOf("pg-off")).every((r) => r.status === "SKIPPED" && r.note === PAGE_OFF_NOTE), "tin khách bỏ qua có lý do");
      // (b) quét lại tin rơi (đường API của Pancake) ⇒ không đọc gì
      const callsBefore = pancake.calls.length;
      const cu = await catchUpFanpage({ fetch: pancake.fetch });
      assert.deepEqual(cu.detail, [PAGE_OFF_NOTE], JSON.stringify(cu));
      assert.equal(pancake.calls.length, callsBefore, "OFF ⇒ lượt quét lại không gọi Pancake lần nào");
      // (c) thử lại tin AI hỏng (đúng hai bước của retry-runner: trả về hàng chờ rồi processFanpageThread catchUp)
      const deadConv = await conversationFor(PAGE, "pg-dead");
      assert.ok(deadConv);
      await db.update(cv).set({ status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON }).where(eq(cv.id, deadConv.id));
      const t0 = Date.now() - 5 * 60_000;
      await db.insert(t).values({ pageId: PAGE, threadId: "pg-dead", messageId: "pg-d1", text: "Còn hàng không?", status: "DEAD", note: DEAD_AI_DOWN_NOTE, attempts: 1, processedAt: new Date(t0 + 1_000), nextAttemptAt: new Date(t0 + 60_000), createdAt: new Date(t0) });
      const rq = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, new Date(Date.now() - 30_000), new Date());
      assert.deepEqual(rq.requeued, [{ pageId: PAGE, threadId: "pg-dead" }], JSON.stringify(rq));
      const r2 = await processFanpageThread(PAGE, "pg-dead", { fetch: pancake.fetch, catchUp: true });
      assert.equal(r2.skipped, PAGE_OFF_NOTE, JSON.stringify(r2));
      assert.equal(sentTo("pg-dead"), 0, "thử lại ⇒ vẫn không gửi");
      // (d) follow-up
      const fu = await waiting("pg-fu");
      const f1 = await runSalesFollowups({ fetch: pancake.fetch });
      assert.equal(f1.sent, 0, JSON.stringify(f1));
      assert.ok(f1.detail.some((d) => d.startsWith(fu.slice(0, 8)) && /chưa LIVE/.test(d)), JSON.stringify(f1.detail));
      assert.equal(sentTo("pg-fu"), 0);
      // (e) chốt cuối: tin bot không mang dấu nhân viên ⇒ từ chối; tin nhân viên (có dấu) ⇒ vẫn đi (người bấm, không phải bot).
      assert.deepEqual(await sendFanpageText(PAGE, "pg-off", "Chị ơi", { fetch: pancake.fetch }), { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR });
      assert.equal(sentTo("pg-off"), 0, "chốt cuối chặn tin bot");
      assert.deepEqual(await sendFanpageText(PAGE, "pg-off", "Dạ em là nhân viên", { fetch: pancake.fetch }, { staffMessageId: "pg-staff-1" }), { ok: true });
      assert.equal(sentTo("pg-off"), 1, "tin nhân viên từ hộp thư ERP không qua cổng");
      // (e2) gọi THẲNG các hàm gửi nội bộ của đường bot — chốt nằm trong chính chúng, không chỉ ở nơi gọi.
      const callsDirect = pancake.calls.length;
      assert.deepEqual(await fanpageBotSendersForTests.sendInbox(PAGE, "pg-off", "Chị ơi", pancake.fetch, "BOT"), { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR, sentParts: 0, rateLimited: false });
      assert.deepEqual(await fanpageBotSendersForTests.sendImages(PAGE, "pg-off", ["c1"], pancake.fetch), { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR, ids: [] });
      const cr = await fanpageBotSendersForTests.deliverCommentReply({ pageId: PAGE, threadId: "pg-off", commentId: "cmt-1", postId: "post-1", fromId: "cust-1", text: "Dạ em nhắn riêng ạ", imageIds: [], conversationId: "khong-co" }, { fetch: pancake.fetch });
      assert.deepEqual(cr, { kind: "FAILED", reason: PAGE_NOT_LIVE_SEND_ERROR });
      assert.deepEqual(await sendBotImages(PAGE, "pg-off", ["anh-1"], { fetch: pancake.fetch }), { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR }, "ảnh bot qua Messenger");
      assert.equal(pancake.calls.length, callsDirect, "hàm gửi nội bộ ở page OFF: không một lời gọi Pancake (kể cả lời đọc hộp thư)");
      assert.equal((await fanpageBotSendersForTests.sendInbox(PAGE, "pg-off", "Dạ em là nhân viên", pancake.fetch, "STAFF")).ok, true, "STAFF không qua cổng");
      assert.equal(sentTo("pg-off"), 2);
      // (f) ghi đơn từ hội thoại (công tắc riêng) ⇒ page không LIVE thì không đọc, không lên đơn
      await setSettingJson(ORDER_SYNC_SETTING_KEY, { enabled: true, enabledAt: new Date(Date.now() - 3_600_000).toISOString() });
      const callsOs = pancake.calls.length;
      const os = await runFanpageOrderSync({ fetch: pancake.fetch });
      assert.equal(os.checked, 0, JSON.stringify(os));
      assert.match(os.detail.join(" "), /chưa page nào LIVE/);
      assert.equal(pancake.calls.length, callsOs, "không đọc hội thoại nào qua Pancake");
      // (g) việc không gắn page
      const vnNine = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 2, 0, 0));
      assert.match((await sendReorderDigest(vnNine)).reason, /chưa có page nào LIVE/);
      assert.match((await sendNewOrderAlerts()).reason ?? "", /chưa có page nào LIVE/);
      assert.match((await learnLessons()).note, /chưa có page nào LIVE/);
      // (h) cứu hội thoại bỏ sót: chỉ đọc
      const postsBefore = pancake.sent().length;
      await findMissedConversations(new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000));
      assert.equal(pancake.sent().length, postsBefore);
      assert.equal(aiCalls, 0, "danh sách rỗng ⇒ 0 lời gọi AI trên mọi đường");
      assert.equal(pancake.sent().length, 2, "danh sách rỗng ⇒ 0 tin bot (hai tin duy nhất là của nhân viên)");

      /* ── Công tắc: quyền + nhật ký + LIVE đòi xác nhận ── */
      assert.ok("error" in (await savePageRuntime(viewer, PAGE, "SHADOW")), "người chỉ xem không đổi được");
      assert.ok("error" in (await savePageRuntime(admin, "9999999999", "SHADOW")), "page không thuộc tổ chức ⇒ từ chối");
      assert.ok("error" in (await savePageRuntime(admin, PAGE, "BAT")), "chế độ lạ ⇒ từ chối");
      assert.ok("ok" in (await savePageRuntime(admin, PAGE, "SHADOW")));

      /* ── Ca 2 · SHADOW ⇒ soạn + lưu, 0 gửi ── */
      // Đếm trước / sau (không lọc theo mốc: đơn mẫu của bộ kiểm thử có thể mang ngày tương lai).
      const orderCount = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders))[0].n);
      const ordersBefore = await orderCount();
      assert.ok((await receiveFanpageEvent(ev(PAGE, "pg-s1", "Chả mực bao nhiêu?", "pg-sh"))).queued);
      const [cust] = await rowsOf("pg-sh");
      // Bot cũ trả lời TRƯỚC khi bot mới kịp xử lý (đúng thực tế ở nhà) — bóng vẫn phải soạn.
      await db.insert(t).values({ pageId: PAGE, threadId: "pg-sh", messageId: "pg-legacy-1", text: "dạ chả mực 250.000đ/kg ạ!", status: "DONE", processedAt: new Date(), note: PAGE_REPLY, createdAt: new Date(cust.createdAt.getTime() + 2_000) });
      const r3 = await processFanpageThread(PAGE, "pg-sh", { fetch: pancake.fetch, now: later });
      assert.equal(r3.skipped, PAGE_SHADOW_NOTE, JSON.stringify(r3));
      assert.equal(aiCalls, 1, "bóng ⇒ đúng MỘT lượt AI");
      assert.equal(sentTo("pg-sh"), 0, "bóng ⇒ không gửi gì");
      const sugg = await db.select().from(schema.salesCopilotSuggestions).where(eq(schema.salesCopilotSuggestions.pageId, PAGE));
      assert.equal(sugg.length, 1, "câu soạn bóng được lưu");
      assert.equal(sugg[0].threadId, "pg-sh");
      assert.equal(sugg[0].suggestion, REPLY);
      assert.equal(sugg[0].createdAt.getTime(), cust.createdAt.getTime(), "mốc của câu bóng = tin khách — để câu bot cũ tới sau tin khách được đem so");
      await scoreCopilotSuggestions(new Date(), { pageId: PAGE, threadId: "pg-sh" });
      const [scored] = await db.select().from(schema.salesCopilotSuggestions).where(eq(schema.salesCopilotSuggestions.pageId, PAGE));
      assert.equal(scored.humanReply, "dạ chả mực 250.000đ/kg ạ!", "câu của bot cũ là câu đem so");
      assert.equal(scored.verdict, "SAME");
      const temp = await db.select({ n: sql<number>`count(*)::int` }).from(cv).where(like(cv.createdBy, "copilot:%"));
      assert.equal(Number(temp[0].n), 0, "không hội thoại bóng nào còn lại");
      assert.equal(await orderCount(), ordersBefore, "bóng không tạo đơn");
      const fu2 = await waiting("pg-fu2");
      const f2 = await runSalesFollowups({ fetch: pancake.fetch });
      assert.ok(f2.detail.some((d) => d.startsWith(fu2.slice(0, 8)) && /chưa LIVE/.test(d)), "bóng ⇒ follow-up vẫn chặn");
      assert.equal((await sendFanpageText(PAGE, "pg-sh", "x", { fetch: pancake.fetch })).ok, false, "bóng ⇒ chốt cuối vẫn chặn");
      assert.ok(await homeRuntimeIdleReason(), "bóng không phải phục vụ khách");
      assert.equal(aiCalls, 1, "bóng: follow-up không gọi AI");
      assert.equal((await pageRuntimeView()).pages.find((p) => p.id === PAGE)?.shadowDrafts7d, 1);
      // Bóng KHÔNG ghi đơn: cả lượt job lẫn lượt hẹn của webhook — 0 lời gọi Pancake, 0 đơn, 0 tin báo nhóm.
      const deliveries = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.messagingDeliveries))[0].n);
      const [callsSh, delivSh] = [pancake.calls.length, await deliveries()];
      const osSh = await runFanpageOrderSync({ fetch: pancake.fetch });
      assert.equal(osSh.checked, 0, JSON.stringify(osSh));
      assert.match(osSh.detail.join(" "), /chưa page nào LIVE/, "bóng ⇒ nguồn của page bị bỏ khỏi ghi đơn");
      const quiet = await syncFanpageThreadWhenQuiet(PAGE, "pg-sh", { fetch: pancake.fetch, sleep: async () => undefined, now: () => new Date(Date.now() + 30 * 60_000) });
      assert.ok(quiet, "hội thoại đã yên ⇒ lượt hẹn có chạy");
      assert.equal(quiet.checked, 0, JSON.stringify(quiet));
      assert.match(quiet.detail.join(" "), /chưa page nào LIVE/);
      assert.equal(pancake.calls.length, callsSh, "bóng ⇒ ghi đơn không đọc Pancake");
      assert.equal(await orderCount(), ordersBefore, "bóng ⇒ 0 đơn từ ghi đơn");
      assert.equal(await deliveries(), delivSh, "bóng ⇒ 0 tin báo nhóm");

      /* ── Ca 3 · LIVE ⇒ như khách ── */
      assert.ok("error" in (await savePageRuntime(admin, PAGE, "LIVE")), "LIVE thiếu xác nhận bot cũ ⇒ từ chối");
      assert.ok("ok" in (await savePageRuntime(admin, PAGE, "LIVE", { acknowledgeLegacyBot: true })));
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHATBOT_PAGE_RUNTIME"));
      assert.equal(audits.length, 2, "mỗi lượt đổi một dòng nhật ký (SHADOW · LIVE)");
      assert.equal(await homeRuntimeIdleReason(), null);
      assert.ok((await receiveFanpageEvent(ev(PAGE, "pg-l1", "Chả mực bao nhiêu?", "pg-live"))).queued);
      const r4 = await processFanpageThread(PAGE, "pg-live", { fetch: pancake.fetch, now: later });
      assert.ok(r4.replies >= 1 && !r4.error, JSON.stringify(r4));
      assert.ok(sentTo("pg-live") >= 1, "LIVE ⇒ bot trả lời");
      assert.deepEqual(await sendFanpageText(PAGE, "pg-live", "Chị ơi", { fetch: pancake.fetch }), { ok: true }, "LIVE ⇒ chốt cuối cho qua");
      // ĐỌC CẤU HÌNH HỎNG khi page đang LIVE ⇒ hẹp: 0 AI, 0 gửi trên xử lý tin lẫn chốt cuối.
      setPageRuntimeReaderForTests(() => Promise.reject(new Error("CSDL tạm không đọc được")));
      try {
        const aiBefore = aiCalls;
        assert.ok((await receiveFanpageEvent(ev(PAGE, "pg-e1", "Chả mực bao nhiêu?", "pg-err"))).queued);
        const re = await processFanpageThread(PAGE, "pg-err", { fetch: pancake.fetch, now: later });
        assert.equal(re.skipped, PAGE_OFF_NOTE, `đọc lỗi ⇒ OFF — ${JSON.stringify(re)}`);
        assert.equal(aiCalls, aiBefore, "đọc lỗi ⇒ 0 lời gọi AI");
        assert.equal(sentTo("pg-err"), 0, "đọc lỗi ⇒ 0 tin");
        assert.deepEqual(await sendFanpageText(PAGE, "pg-err", "Chị ơi", { fetch: pancake.fetch }), { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR });
        assert.ok(await homeRuntimeIdleReason(), "đọc lỗi ⇒ việc không gắn page cũng dừng");
      } finally {
        setPageRuntimeReaderForTests(null);
      }
      // HAI LƯỢT LƯU ĐỒNG THỜI cho hai page: tắt PAGE và bóng PAGE2 — không lượt nào ghi lại bản cũ của page kia.
      assert.ok(await conversationFor(PAGE2, "pg2-t1"), "page thứ hai có hội thoại ⇒ là page ứng viên");
      const [offR, shR] = await Promise.all([savePageRuntime(admin, PAGE, "OFF"), savePageRuntime(admin, PAGE2, "SHADOW")]);
      assert.ok("ok" in offR && "ok" in shR, JSON.stringify([offR, shR]));
      const afterRace = await pageRuntimeView();
      assert.equal(afterRace.pages.find((p) => p.id === PAGE)?.mode, "OFF", "page vừa TẮT không bị lượt lưu song song đưa về LIVE");
      assert.equal(afterRace.pages.find((p) => p.id === PAGE2)?.mode, "SHADOW");
      assert.ok("ok" in (await savePageRuntime(admin, PAGE2, "OFF")));
    } finally {
      // Dọn CSDL nhà: page thử, kết nối, nhật ký của bài, cài đặt chụp trước.
      setPageRuntimeReaderForTests(null);
      await db.delete(cv).where(inArray(cv.pageId, [PAGE, PAGE2]));
      await db.delete(t).where(eq(t.pageId, PAGE));
      await db.delete(schema.salesCopilotSuggestions).where(eq(schema.salesCopilotSuggestions.pageId, PAGE));
      await db.delete(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "pancake-fanpage"));
      await db.delete(schema.auditLogs).where(and(gte(schema.auditLogs.createdAt, startedAt), inArray(schema.auditLogs.userId, [u.id])));
      await db.delete(schema.users).where(eq(schema.users.id, u.id));
      await db.delete(st).where(inArray(st.key, [...SNAP_KEYS]));
      if (snap.length) await db.insert(st).values(snap);
    }
  });
  await pdb.delete(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, home.code), gte(schema.platformAiUsage.at, startedAt)));
  await datAiSalesNha(home.id, nguyenTrang);
}

/* ═════════════ 3 · KHÁCH ═════════════ */
async function donKhach() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, KHACH));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, KHACH) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [KHACH]));
  invalidateOrganizations();
  invalidateCapabilities();
  try {
    rmSync(organizationDatabaseUrl({ code: KHACH, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  } catch {
    // Windows giữ tệp của PGlite đang mở — lượt chạy sau xoá ở đầu bài.
  }
}

async function kiemKhach() {
  await donKhach();
  await provisionOrganization({ code: KHACH, name: "Cổng page — khách", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${KHACH}.local`, name: "QT", password: "CongPage@123456" }, source: "TEST", actor: null });
  let aiCalls = 0;
  setSalesChatProviderForTests(() => fakeProvider(() => (aiCalls += 1)));
  await withOrganization(KHACH, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${KHACH}.local`) });
    assert.ok(u);
    const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: KHACH, name: KHACH, isHome: false } };
    const pancake = fakePancake();
    await connectPancake(admin, KHACH_PAGE, pancake);
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: 30_000 });
    // Một danh sách lạc vào CSDL khách (ví dụ chép cấu hình) — vẫn không đổi gì.
    await setSettingJson(PAGE_RUNTIME_SETTING_KEY, { [KHACH_PAGE]: { mode: "OFF" } });
    assert.ok((await receiveFanpageEvent(ev(KHACH_PAGE, "pk-1", "Chả mực bao nhiêu?", "pk-t1"))).queued);
    const r = await processFanpageThread(KHACH_PAGE, "pk-t1", { fetch: pancake.fetch, now: later });
    assert.ok(r.replies >= 1 && !r.error, `khách: bot trả lời như trước — ${JSON.stringify(r)}`);
    assert.ok(aiCalls >= 1);
    assert.deepEqual(await sendFanpageText(KHACH_PAGE, "pk-t1", "Chị ơi", { fetch: pancake.fetch }), { ok: true }, "khách: chốt cuối không chặn");
    assert.equal(await homeRuntimeIdleReason(), null, "khách luôn «đang phục vụ»");
    assert.ok("error" in (await savePageRuntime(admin, KHACH_PAGE, "OFF")), "công tắc theo page không dùng ở khách");
    assert.deepEqual(await pageRuntimeView(), { isHome: false, pages: [] });
  });
}

/* ═════════════ 4 · QUÉT MÃ NGUỒN ═════════════ */
function kiemMaNguon() {
  const src = (f: string) => readFileSync(path.join(goc, f), "utf8").replace(/\r\n/g, "\n");
  const body = (s: string, start: string) => {
    const i = s.indexOf(start);
    assert.ok(i >= 0, `thiếu ${start}`);
    const j = s.indexOf("\n}\n", i);
    return s.slice(i, j < 0 ? undefined : j);
  };
  // Ba hàm xử lý tin hỏi cổng ngay sau lượt giành, TRƯỚC mọi bước bỏ qua vì page / nhân viên đã trả lời và trước lượt AI.
  const cases: [string, string, string][] = [
    ["lib/sales-chatbot/fanpage.ts", "export async function processFanpageThread(", "if (await pageRepliedSince()) {\n      await finish"],
    ["lib/sales-chatbot/messenger.ts", "export async function processMessengerThread(", "if (await pageRepliedSince()) {\n      await finish"],
    ["lib/sales-chatbot/zalo.ts", "export async function processZaloThread(", "const [staff] = await db"],
  ];
  for (const [file, start, firstSkip] of cases) {
    const b = body(src(file), start);
    const g = b.indexOf("await inboundPageGate(");
    assert.ok(g > 0, `${file}: xử lý tin phải hỏi cổng page`);
    assert.ok(g > b.indexOf(".returning("), `${file}: cổng đặt SAU lượt giành tin`);
    assert.ok(g < b.indexOf(firstSkip), `${file}: cổng đặt TRƯỚC bước bỏ qua vì page / nhân viên đã trả lời (bóng ở nhà phải soạn được dù bot cũ đã trả lời)`);
    assert.ok(g < b.indexOf("chatTurn("), `${file}: cổng đặt trước lượt AI`);
  }
  // Chốt cuối nằm TRONG các hàm gửi của đường bot (một hàm dùng chung `botSendAllowed`, đọc lỗi ⇒ không gửi).
  const chot = /if \(!mark && !\(await botSendAllowed\(pageId\)\)\) return \{ ok: false, error: PAGE_NOT_LIVE_SEND_ERROR \};/;
  assert.match(body(src("lib/sales-chatbot/fanpage.ts"), "export async function sendFanpageText("), chot);
  assert.match(body(src("lib/sales-chatbot/messenger.ts"), "export async function sendMessengerPageText("), chot);
  for (const fn of ["async function sendInbox(", "async function sendImages("]) assert.match(body(src("lib/sales-chatbot/fanpage.ts"), fn), /if \(who === "BOT" && !\(await botSendAllowed\(pageId\)\)\) return/, `fanpage ${fn}`);
  const dcr = body(src("lib/sales-chatbot/fanpage.ts"), "async function deliverCommentReply(");
  assert.ok(dcr.indexOf("await botSendAllowed(pageId)") > 0 && dcr.indexOf("await botSendAllowed(pageId)") < dcr.indexOf("privateReplyInbox("), "deliverCommentReply: chốt trước mọi lời gọi Pancake");
  assert.match(body(src("lib/sales-chatbot/messenger.ts"), "export async function sendBotImages("), /if \(!\(await botSendAllowed\(pageId\)\)\) return \{ ok: false, error: PAGE_NOT_LIVE_SEND_ERROR \};/);
  const pm = body(src("lib/sales-chatbot/messenger.ts"), "export async function processMessengerThread(");
  assert.ok(pm.lastIndexOf("await botSendAllowed(pageId)", pm.indexOf("sendPrivateReply(")) > pm.indexOf("if (commentRow) {"), "Messenger: chốt ngay trước tin riêng trả lời bình luận");
  const pz = body(src("lib/sales-chatbot/zalo.ts"), "export async function processZaloThread(");
  assert.ok(pz.indexOf("await botSendAllowed(pageId)") > 0 && pz.indexOf("await botSendAllowed(pageId)") < pz.indexOf("zaloSendText("), "Zalo: chốt trước lời gửi tin bot");
  // Thử lại tin AI hỏng chỉ trả lời qua hai hàm xử lý đã có cổng.
  const retry = src("lib/sales-chatbot/retry-runner.ts");
  assert.deepEqual(
    [...retry.matchAll(/^import \{([^}]+)\} from "@\/lib\/sales-chatbot\/(fanpage|messenger)";$/gm)].map((m) => `${m[2]}:${m[1].trim()}`).sort(),
    ["fanpage:processFanpageThread", "messenger:processMessengerThread"],
    "retry-runner chỉ dùng hai hàm xử lý tin",
  );
  // «Cứu hội thoại bỏ sót» chỉ đọc.
  const rec = src("lib/sales-chatbot/recovery.ts");
  assert.doesNotMatch(rec, /from "@\/lib\/sales-chatbot\/(fanpage|messenger|zalo)"|deliverMessage|sendInbox/, "recovery.ts không import đường gửi nào");
  // Follow-up hỏi cổng trước lời gọi AI.
  const fu = src("lib/sales-chatbot/followup.ts");
  assert.ok(fu.indexOf("await pageRuntimeMode(row.pageId)") > 0 && fu.indexOf("await pageRuntimeMode(row.pageId)") < fu.indexOf("prov.provider.complete("), "follow-up: cổng trước lời gọi AI");
}

export async function testSaasPageGate() {
  kiemThuan();
  kiemMaNguon();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = SECRET_KEY;
  try {
    await kiemNha();
    await kiemKhach();
  } finally {
    setSalesChatProviderForTests(null);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await donKhach();
  }
  console.log("✓ Cổng page của nhà: danh sách rỗng ⇒ 0 tin / 0 AI trên xử lý tin · quét lại · thử lại · follow-up · ghi đơn · chốt gửi · việc không gắn page; BÓNG ⇒ lưu câu soạn (kể cả khi bot cũ đã trả lời), 0 gửi, 0 đơn; LIVE (đòi xác nhận bot cũ) ⇒ như khách; khách không đổi");
}

if (/saas-page-gate\.test\.ts$/.test(process.argv[1] ?? "")) testSaasPageGate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
