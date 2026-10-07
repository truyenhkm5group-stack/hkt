/**
 * ═══════════ AI NHƯỜNG NGƯỜI · TIẾP QUẢN · CHO AI TIẾP TỤC (ai-hold-shared.ts · sứ mệnh sales-human-takeover) ═══════════
 *
 * Chủ shop 07/10/2026: nhân viên gửi MỘT câu tay ⇒ AI nhường 30 phút (giữ nguyên), nhưng không có cách cho AI chạy lại ngay và
 * không biết còn bao lâu. Khoá — gọi ĐƯỜNG XỬ LÝ THẬT (Messenger trực tiếp với Graph giả, fanpage qua Pancake giả, AI giả đếm
 * lượt), không regex mã nguồn:
 *  · THUẦN: ba trạng thái AI_ACTIVE · HUMAN_COOLDOWN · HUMAN_TAKEOVER; «Tiếp quản» thắng lý do nhường; dòng cũ (cột NULL) đọc
 *    mốc cũ; đồng hồ đếm ngược theo giờ MÁY CHỦ (bù lệch trình duyệt); mã lý do resume.
 *  · Nhân viên gửi tay ⇒ HUMAN_COOLDOWN với ĐÚNG mốc hết hạn (giờ gửi + 30 phút); tin khách trong lúc nhường ⇒ LƯU, 0 lượt AI,
 *    0 tin gửi; «Cho AI tiếp tục ngay» ⇒ AI_ACTIVE, tin đang chờ KHÔNG được trả lời ngược, tin khách KẾ TIẾP ⇒ AI trả lời.
 *  · Hết 30 phút ⇒ tự AI_ACTIVE + `ai.resumed` COOLDOWN_EXPIRED của MÁY (actor NULL) tại đúng mốc hết hạn.
 *  · «Tiếp quản» (kể cả từ lúc đang nhường) ⇒ HUMAN_TAKEOVER, sau 2 giờ vẫn 0 lượt AI; nhân viên gửi tay khi đang tiếp quản KHÔNG
 *    biến về nhường; «Trả lại cho AI» ⇒ AI_ACTIVE, AI trả lời tin kế tiếp.
 *  · Sổ sự kiện đủ năm loại, mang `users.id` người bấm / người gửi (luật 34); nhật ký người bấm.
 *  · Quyền (chỉ xem không đổi được) + cô lập tổ chức (mã hội thoại của tổ chức khác ⇒ không có).
 *  · Fanpage qua Pancake CÙNG luật — và hồi quy lỗi đồng hồ: Pancake ghi mốc tin khách (đẩy `updated_at`) ngay trước khi hỏi «hết
 *    nhường chưa», nên bản cũ (đồng hồ = `updated_at`) không bao giờ hết nhường khi khách còn nhắn. Đo bằng ĐỒNG HỒ THẬT.
 * Mốc thời gian đều tương đối với đồng hồ thật lúc chạy (luật 50) — không ghim ngày tuyệt đối.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import {
  AI_DOWN_HANDOFF_REASON,
  aiHoldOf,
  aiHoldView,
  cooldownClock,
  cooldownRemainingMs,
  FANPAGE_STAFF_REASON,
  formatCountdown,
  HUMAN_COOLDOWN_MINUTES,
  HUMAN_COOLDOWN_MS,
  humanResumeReason,
  ZALO_STAFF_REASON,
} from "@/lib/sales-chatbot/ai-hold-shared";
import { aiBlock, controlBarStatus } from "@/lib/sales-chatbot/ai-status-shared";
import { aiStatusOrgComputesForTests, buildMessageTrace, classifyInboundNote, forgetAiStatus, KNOWN_INBOUND_NOTES } from "@/lib/sales-chatbot/ai-status";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { NEEDS_HUMAN_NOTE, readConversationControl, TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { holdGate, setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { setSalesChatProviderForTests, TURN_BOT_OFF_ERROR, TURN_MODULE_OFF_ERROR } from "@/lib/sales-chatbot/engine";
import { conversationFor, HUMAN_TAKEOVER_MINUTES, processFanpageThread, receiveFanpageEvent, STAFF_REASON } from "@/lib/sales-chatbot/fanpage";
import { CONV_OPEN_FAILED_NOTE, DEAD_AI_DOWN_NOTE, DEAD_SEND_NOTE_PREFIX } from "@/lib/sales-chatbot/inbound-retry";
import { OPERATING_MODE_SETTING_KEY } from "@/lib/sales-chatbot/operating-mode-shared";
import { PAGE_OFF_NOTE, PAGE_RUNTIME_SETTING_KEY, PAGE_SHADOW_BOT_OFF_NOTE, PAGE_SHADOW_NOTE } from "@/lib/sales-chatbot/page-runtime-shared";
import { setSettingJson } from "@/lib/settings";
import { handBackToAiCore, loadInboxThread, sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import { connectMessengerPage, processMessengerThread, receiveMessengerEvent } from "@/lib/sales-chatbot/messenger";

const ORG = "nhuong-nguoi";
const ORG_B = "nhuong-nguoi-khac";
const APP_ID = "777000555666";
const APP_SECRET = "app-secret-takeover-test-0123456789ab";
const PAGE_M = "3049586172";
const PAGE_TOKEN = "EAAGpagetoken_takeover_0123456789abcdef";
const PAGE_P = "8877665544";
const PANCAKE_TOKEN = "pancake_page_token_nhuong_0123456789abc";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;
const BOT_TEXT = "Dạ size M còn hàng ạ, chị lấy mấy cái ạ?";
const MIN = 60_000;
const PAGE_H = "7766554433";
const HOME_ADMIN = "nhuong-nguoi-nha@test.local";

function testPure() {
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const base = { status: "OPEN", handoffReason: null, state: {}, updatedAt: ago(5 * MIN), humanCooldownUntil: null };
  assert.equal(HUMAN_TAKEOVER_MINUTES, HUMAN_COOLDOWN_MINUTES, "fanpage.ts đọc ĐÚNG ngưỡng cũ — không có số thứ hai");
  assert.equal(HUMAN_COOLDOWN_MINUTES, 30);
  assert.equal(STAFF_REASON, FANPAGE_STAFF_REASON);
  assert.deepEqual(aiHoldOf(base, now), { state: "AI_ACTIVE", cause: null, until: null, expired: null });

  // Nhân viên gửi tay 10 phút trước ⇒ còn 20 phút.
  const until = new Date(now.getTime() + 20 * MIN);
  const cd = aiHoldOf({ ...base, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: until, updatedAt: now }, now);
  assert.ok(cd.state === "HUMAN_COOLDOWN" && cd.cause === "STAFF_REPLY" && cd.until?.getTime() === until.getTime(), JSON.stringify(cd));
  assert.equal(aiHoldOf({ ...base, status: "HANDOFF", handoffReason: ZALO_STAFF_REASON, humanCooldownUntil: until }, now).state, "HUMAN_COOLDOWN", "Zalo cùng luật");
  // ĐỒNG HỒ là cột mốc, không phải `updated_at`: mọi lượt ghi đẩy `updated_at` về «bây giờ» nhưng nhường vẫn hết đúng hạn.
  const lapsed = aiHoldOf({ ...base, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: ago(MIN), updatedAt: now }, now);
  assert.ok(lapsed.state === "AI_ACTIVE" && lapsed.expired?.cause === "STAFF_REPLY" && lapsed.expired.at.getTime() === ago(MIN).getTime(), JSON.stringify(lapsed));
  // Dòng cũ (trước 0231, cột NULL) đọc mốc cũ `updated_at` + 30 phút — không backfill đoán.
  assert.equal(aiHoldOf({ ...base, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, updatedAt: ago(10 * MIN) }, now).until?.getTime(), ago(10 * MIN).getTime() + HUMAN_COOLDOWN_MS);
  assert.equal(aiHoldOf({ ...base, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, updatedAt: ago(31 * MIN) }, now).state, "AI_ACTIVE");
  // AI hỏng ⇒ nhường rồi tự thử lại (đọc `updated_at` như trước).
  const down = aiHoldOf({ ...base, status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, updatedAt: ago(MIN) }, now);
  assert.ok(down.state === "HUMAN_COOLDOWN" && down.cause === "AI_DOWN");
  // «Tiếp quản» thắng mọi lý do nhường — kể cả lý do «nhân viên đang trả lời» đã quá hạn, kể cả khi hội thoại không ở HANDOFF.
  const takeoverState = { control: { mode: "HUMAN", byUserId: "u1", byName: "Lan", at: now.toISOString(), reason: null } };
  const tk = aiHoldOf({ ...base, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: ago(60 * MIN), state: takeoverState }, now);
  assert.ok(tk.state === "HUMAN_TAKEOVER" && tk.cause === "TAKEOVER" && tk.until === null && tk.expired === null, JSON.stringify(tk));
  assert.equal(aiHoldOf({ ...base, state: takeoverState }, new Date(now.getTime() + 48 * 60 * MIN)).state, "HUMAN_TAKEOVER", "tiếp quản không hết hạn");
  // AI / công cụ xin người ⇒ chờ người trả lại, không hết hạn.
  const needs = aiHoldOf({ ...base, status: "HANDOFF", handoffReason: "Khách sỉ — cần báo giá riêng", updatedAt: ago(5 * 60 * MIN) }, now);
  assert.ok(needs.state === "HUMAN_TAKEOVER" && needs.cause === "NEEDS_HUMAN");
  assert.equal(aiHoldOf({ ...base, status: "HANDOFF", handoffReason: TAKEOVER_REASON }, now).state, "HUMAN_TAKEOVER");

  assert.equal(humanResumeReason(cd), "RESUMED_NOW");
  assert.equal(humanResumeReason(tk), "RETURNED");
  assert.equal(humanResumeReason(needs), "RETURNED");
  assert.equal(humanResumeReason(aiHoldOf(base, now)), null);

  // Đếm ngược theo giờ MÁY CHỦ: trình duyệt chạy CHẬM 3 phút ⇒ vẫn đúng 20 phút còn lại.
  const view = aiHoldView({ ...base, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: until }, now);
  assert.ok(view.state === "HUMAN_COOLDOWN" && view.until === until.toISOString() && view.serverNow === now.toISOString());
  const browserNow = now.getTime() - 3 * MIN;
  const skew = new Date(view.serverNow).getTime() - browserNow;
  assert.equal(cooldownRemainingMs(view.until, browserNow, skew), 20 * MIN);
  assert.equal(cooldownRemainingMs(view.until, browserNow + 25 * MIN, skew), 0, "không âm");
  assert.equal(cooldownRemainingMs(null, browserNow, 0), 0);
  assert.equal(formatCountdown(20 * MIN), "20:00");
  assert.equal(formatCountdown(61_500), "01:02");
  assert.equal(formatCountdown(0), "00:00");
  assert.match(cooldownClock(until.toISOString()), /^\d{2}:\d{2}$/);
  assert.equal(cooldownClock(null), "—");
}

type Call = { url: string; init?: RequestInit };
function fakeGraph(): { fetch: typeof fetch; calls: Call[]; sends: (from: number) => Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    if (u.pathname.endsWith(`/${PAGE_M}/subscribed_apps`)) return json({ success: true });
    if (u.pathname.endsWith(`/${PAGE_M}`)) return json({ id: PAGE_M });
    if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === PAGE_TOKEN) return json({ id: PAGE_M, name: "Shop Nhường" });
    if (u.pathname.endsWith("/me/messages")) return json({ recipient_id: "x", message_id: `m.out.${calls.length}` });
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls, sends: (from) => calls.slice(from).filter((c) => c.url.includes("/me/messages")) };
}

function fakePancake(): { fetch: typeof fetch; calls: Call[]; sends: (from: number) => Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `p-out-${calls.length}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls, sends: (from) => calls.slice(from).filter((c) => c.init?.method === "POST" && c.url.includes("/messages")) };
}

let aiCalls = 0;
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      aiCalls += 1;
      return { content: [{ type: "text", text: req.tools.length ? BOT_TEXT : "NONE" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testFlow() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "NhuongNguoi@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: ORG_B, name: ORG_B, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG_B}.local`, name: "QT B", password: "NhuongNguoi@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  const g = fakeGraph();
  const pancake = fakePancake();
  setSalesChatProviderForTests(() => fakeBot());
  const foreignIds: string[] = [];
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { email: u.email, scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: enabled };
      const admin = { ...base, id: u.id, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"] } as unknown as SessionUser;
      const [s1] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      const [s2] = await db.insert(schema.users).values({ email: `minh@${ORG}.local`, name: "Minh CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      const lan = { ...base, id: s1.id, name: "Tên giả", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const minh = { ...base, id: s2.id, name: "Minh CSKH", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const viewer = { ...base, id: "nhuong-viewer", name: "Xem", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;

      const conn = await connectMessengerPage(admin, { id: PAGE_M, name: "Shop Nhường", token: PAGE_TOKEN, canMessage: true }, { fetch: g.fetch });
      assert.ok("ok" in conn, JSON.stringify(conn));
      const pc = await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE_P }, secrets: { pageAccessToken: PANCAKE_TOKEN } });
      assert.ok("ok" in pc, JSON.stringify(pc));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      const cfg = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: cfg }).onConflictDoUpdate({ target: schema.settings.key, set: { value: cfg } });

      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const msg = (psid: string, mid: string, text: string) => ({ platform: "MESSENGER" as const, pageId: PAGE_M, psid, mid, text, imageUrls: [], isEcho: false, appId: null, at: null });
      const at = (ms: number) => () => new Date(Date.now() + ms);
      const convOf = async (psid: string) => (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.threadId, psid))).limit(1))[0];
      const eventsOf = async (id: string) => db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, id));
      const holdOf = async (id: string) => {
        const r = await loadInboxThread(lan, id);
        assert.ok(r.ok, JSON.stringify(r));
        return r.thread.aiHold;
      };
      const inboundStatus = async (mid: string) => (await db.select({ status: t.status }).from(t).where(eq(t.messageId, mid)))[0]?.status;
      /** Mở hội thoại bằng một tin khách + câu trả lời của bot (bot đã nói ⇒ có ngữ cảnh «đang trò chuyện»). */
      const opened = async (psid: string) => {
        await receiveMessengerEvent(msg(psid, `${psid}.0`, "Áo này còn size M không?"));
        const mark = g.calls.length;
        const r = await processMessengerThread(PAGE_M, psid, { fetch: g.fetch, now: at(31_000) });
        assert.ok(r.replies >= 1 && g.sends(mark).length >= 1, `bot trả lời tin đầu: ${JSON.stringify(r)}`);
        return (await convOf(psid)).id;
      };

      // ═══ A. Nhân viên gửi tay (hộp thư ERP) ⇒ HUMAN_COOLDOWN đúng mốc · tin trong lúc nhường lưu, 0 AI · «Cho AI tiếp tục ngay» ═══
      const A = "8100000000001";
      const convA = await opened(A);
      const T0 = new Date();
      const sent = await sendStaffReplyCore(lan, convA, { text: "Dạ để em kiểm kho rồi báo chị ạ", requestKey: "req-nhuong-0001" }, { fetch: g.fetch, now: () => T0 });
      assert.ok(sent.ok, JSON.stringify(sent));
      const rowA = await convOf(A);
      assert.equal(rowA.humanCooldownUntil?.getTime(), T0.getTime() + 30 * MIN, "mốc hết nhường = giờ gửi + 30 phút, ghi TƯỜNG MINH");
      const hA = await holdOf(convA);
      assert.ok(hA.state === "HUMAN_COOLDOWN" && hA.cause === "STAFF_REPLY" && hA.until === new Date(T0.getTime() + 30 * MIN).toISOString() && hA.serverNow, JSON.stringify(hA));
      await receiveMessengerEvent(msg(A, "a.2", "Còn màu đen không em?"));
      let ai0 = aiCalls;
      let mark = g.calls.length;
      const pA = await processMessengerThread(PAGE_M, A, { fetch: g.fetch, now: () => new Date(T0.getTime() + 5 * MIN) });
      assert.ok(pA.replies === 0 && g.sends(mark).length === 0 && aiCalls === ai0, `trong lúc nhường: 0 lượt AI, 0 tin gửi: ${JSON.stringify(pA)}`);
      assert.equal(await inboundStatus("a.2"), "SKIPPED", "tin khách được LƯU (người đọc ở hộp thư), không vào lượt AI");
      // Chỉ xem ⇒ không cho AI tiếp tục được.
      const denied = await setConversationControlCore(viewer, convA, "AUTO");
      assert.ok(!denied.ok && denied.error.includes("ai_sales:reply"), JSON.stringify(denied));
      assert.equal((await holdOf(convA)).state, "HUMAN_COOLDOWN");
      // «Cho AI tiếp tục ngay».
      mark = g.calls.length;
      ai0 = aiCalls;
      const resumed = await setConversationControlCore(lan, convA, "AUTO");
      assert.ok(resumed.ok && resumed.changed, JSON.stringify(resumed));
      const rowA2 = await convOf(A);
      assert.ok(rowA2.status === "OPEN" && rowA2.humanCooldownUntil === null && rowA2.handoffReason === null, JSON.stringify({ s: rowA2.status, u: rowA2.humanCooldownUntil }));
      assert.equal((await holdOf(convA)).state, "AI_ACTIVE");
      // Mục 8: tin đã tới TRONG lúc nhường KHÔNG được trả lời ngược khi bấm (người có thể đã trả lời câu đó).
      assert.ok(g.sends(mark).length === 0 && aiCalls === ai0 && (await inboundStatus("a.2")) === "SKIPPED", "bấm tiếp tục ⇒ không trả lời ngược tin cũ");
      const evA = await eventsOf(convA);
      const resumeA = evA.find((e) => e.type === "ai.resumed");
      assert.ok(resumeA && resumeA.reasonCode === "RESUMED_NOW" && resumeA.actorKind === "HUMAN" && resumeA.actorUserId === lan.id, JSON.stringify(evA.map((e) => [e.type, e.reasonCode, e.actorUserId])));
      const startA = evA.find((e) => e.type === "human.took_over");
      assert.ok(startA && startA.reasonCode === "STAFF_REPLIED" && startA.actorUserId === lan.id && (startA.payload as { cooldownUntil?: string }).cooldownUntil === new Date(T0.getTime() + 30 * MIN).toISOString(), JSON.stringify(startA));
      assert.ok(evA.some((e) => e.type === "human.replied" && e.actorUserId === lan.id), "người gửi tay mang users.id");
      const audA = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHAT_AI_RESUME_NOW"), eq(schema.auditLogs.entityId, convA)));
      assert.ok(audA.length === 1 && audA[0].userId === lan.id && JSON.stringify(audA[0].detail).includes("HUMAN_COOLDOWN"), JSON.stringify(audA));
      // Tin khách KẾ TIẾP ⇒ AI trả lời bình thường.
      await receiveMessengerEvent(msg(A, "a.3", "Vậy lấy 2 cái size M"));
      mark = g.calls.length;
      const pA3 = await processMessengerThread(PAGE_M, A, { fetch: g.fetch, now: at(31_000) });
      assert.ok(pA3.replies >= 1 && g.sends(mark).length >= 1, `sau khi cho AI tiếp tục, tin kế tiếp được AI trả lời: ${JSON.stringify(pA3)}`);
      foreignIds.push(convA);

      // ═══ B. Nhân viên gửi trong Hộp thư Meta (ngoài ERP) ⇒ nhường · hết 30 phút ⇒ TỰ AI_ACTIVE (MÁY ghi kết thúc) ═══
      const B = "8100000000002";
      const convB = await opened(B);
      const TB = new Date();
      const echo = await receiveMessengerEvent({ ...msg(B, "b.staff", "Dạ chị đợi em chút ạ"), isEcho: true, appId: "55555000" }, TB);
      assert.match(echo.reason, /bot nhường/, JSON.stringify(echo));
      assert.equal((await convOf(B)).humanCooldownUntil?.getTime(), TB.getTime() + 30 * MIN);
      const startB = (await eventsOf(convB)).find((e) => e.type === "human.took_over");
      assert.ok(startB && startB.reasonCode === "STAFF_REPLIED" && startB.actorKind === "HUMAN" && startB.actorUserId === null, "nhân viên ngoài ERP: không có danh tính, KHÔNG đoán");
      await receiveMessengerEvent(msg(B, "b.2", "Shop ơi?"));
      ai0 = aiCalls;
      mark = g.calls.length;
      const pB = await processMessengerThread(PAGE_M, B, { fetch: g.fetch, now: () => new Date(TB.getTime() + 29 * MIN) });
      assert.ok(pB.replies === 0 && g.sends(mark).length === 0 && aiCalls === ai0, `29 phút: vẫn nhường: ${JSON.stringify(pB)}`);
      await receiveMessengerEvent(msg(B, "b.3", "Còn hàng không ạ?"));
      mark = g.calls.length;
      const pB3 = await processMessengerThread(PAGE_M, B, { fetch: g.fetch, now: () => new Date(TB.getTime() + 31 * MIN) });
      assert.ok(pB3.replies >= 1 && g.sends(mark).length >= 1, `hết 30 phút ⇒ AI trả lời lại: ${JSON.stringify(pB3)}`);
      const rowB = await convOf(B);
      assert.ok(rowB.status !== "HANDOFF" && rowB.humanCooldownUntil === null, JSON.stringify({ s: rowB.status }));
      const endB = (await eventsOf(convB)).find((e) => e.type === "ai.resumed");
      assert.ok(endB && endB.reasonCode === "COOLDOWN_EXPIRED" && endB.actorKind === "SYSTEM" && endB.actorUserId === null && endB.occurredAt.getTime() === TB.getTime() + 30 * MIN, `kết thúc nhường là của MÁY, tại đúng mốc hết hạn: ${JSON.stringify(endB)}`);

      // ═══ C. «Tiếp quản» từ lúc đang nhường ⇒ HUMAN_TAKEOVER bền · gửi tay không biến về nhường · «Trả lại cho AI» ═══
      const C = "8100000000003";
      const convC = await opened(C);
      assert.ok((await sendStaffReplyCore(lan, convC, { text: "Dạ em chào chị", requestKey: "req-nhuong-0003" }, { fetch: g.fetch })).ok);
      assert.equal((await holdOf(convC)).state, "HUMAN_COOLDOWN");
      const took = await setConversationControlCore(lan, convC, "HUMAN", "Khách sỉ");
      assert.ok(took.ok && took.changed, JSON.stringify(took));
      const hC = await holdOf(convC);
      assert.ok(hC.state === "HUMAN_TAKEOVER" && hC.cause === "TAKEOVER" && hC.until === null, JSON.stringify(hC));
      const takeEv = (await eventsOf(convC)).filter((e) => e.type === "human.took_over" && e.reasonCode === "STAFF_TOOK_OVER");
      assert.ok(takeEv.length === 1 && takeEv[0].actorUserId === lan.id && (takeEv[0].payload as { from?: string }).from === "HUMAN_COOLDOWN", `tiếp quản TỪ lúc đang nhường cũng được ghi: ${JSON.stringify(takeEv)}`);
      await receiveMessengerEvent(msg(C, "c.2", "Lấy sỉ 50 cái giá sao?"));
      ai0 = aiCalls;
      mark = g.calls.length;
      const pC = await processMessengerThread(PAGE_M, C, { fetch: g.fetch, now: at(2 * 60 * MIN) });
      assert.ok(pC.replies === 0 && g.sends(mark).length === 0 && aiCalls === ai0, `tiếp quản: sau 2 giờ vẫn 0 lượt AI: ${JSON.stringify(pC)}`);
      // Nhân viên khác gửi tay khi đang tiếp quản ⇒ VẪN tiếp quản (không biến về nhường 30 phút).
      const startsBefore = (await eventsOf(convC)).filter((e) => e.type === "human.took_over" && e.reasonCode === "STAFF_REPLIED").length;
      assert.ok((await sendStaffReplyCore(minh, convC, { text: "Dạ giá sỉ em gửi chị ngay", requestKey: "req-nhuong-0004" }, { fetch: g.fetch })).ok);
      const rowC = await convOf(C);
      assert.ok(rowC.handoffReason === TAKEOVER_REASON && readConversationControl(rowC.state)?.mode === "HUMAN", JSON.stringify({ r: rowC.handoffReason }));
      assert.equal((await holdOf(convC)).state, "HUMAN_TAKEOVER");
      assert.equal((await eventsOf(convC)).filter((e) => e.type === "human.took_over" && e.reasonCode === "STAFF_REPLIED").length, startsBefore, "gửi tay khi tiếp quản không mở một lần nhường mới");
      await receiveMessengerEvent(msg(C, "c.3", "Ok em"));
      ai0 = aiCalls;
      const pC3 = await processMessengerThread(PAGE_M, C, { fetch: g.fetch, now: at(3 * 60 * MIN) });
      assert.ok(pC3.replies === 0 && aiCalls === ai0, `3 giờ sau câu tay, vẫn tiếp quản: ${JSON.stringify(pC3)}`);
      // «Trả lại cho AI».
      const back = await setConversationControlCore(minh, convC, "AUTO");
      assert.ok(back.ok && back.changed);
      assert.equal((await holdOf(convC)).state, "AI_ACTIVE");
      const backEv = (await eventsOf(convC)).find((e) => e.type === "ai.resumed");
      assert.ok(backEv && backEv.reasonCode === "RETURNED" && backEv.actorUserId === minh.id, JSON.stringify(backEv));
      await receiveMessengerEvent(msg(C, "c.4", "Vậy chị lấy 1 cái lẻ"));
      mark = g.calls.length;
      const pC4 = await processMessengerThread(PAGE_M, C, { fetch: g.fetch, now: at(31_000) });
      assert.ok(pC4.replies >= 1 && g.sends(mark).length >= 1, `trả lại ⇒ AI trả lời tin kế tiếp: ${JSON.stringify(pC4)}`);

      // ═══ Sổ sự kiện: đủ năm loại, mang khoá người (MÁY = NULL) ═══
      const all = await db.select().from(schema.salesConversationEvents);
      const has = (type: string, code: string | null, actor: string | null | "any") => all.some((e) => e.type === type && (code === null || e.reasonCode === code) && (actor === "any" || e.actorUserId === actor));
      assert.ok(has("human.replied", null, lan.id), "1 · người gửi tay");
      assert.ok(has("human.took_over", "STAFF_REPLIED", lan.id), "2 · bắt đầu nhường");
      assert.ok(has("ai.resumed", "COOLDOWN_EXPIRED", null) && has("ai.resumed", "RESUMED_NOW", lan.id), "3 · kết thúc nhường (máy / người bấm)");
      assert.ok(has("human.took_over", "STAFF_TOOK_OVER", lan.id), "4 · tiếp quản");
      assert.ok(has("ai.resumed", "RETURNED", minh.id), "5 · trả lại cho AI");

      // ═══ P. Fanpage qua Pancake — CÙNG luật ═══
      const pev = (thread: string, mid: string, text: string, fromPage = false) => ({ pageId: PAGE_P, threadId: thread, messageId: mid, text, customerName: fromPage ? "" : "Chị Hoa", fromPage, humanStaff: fromPage, inbox: true, comment: null, imageUrls: [] });
      const openedP = async (thread: string) => {
        await receiveFanpageEvent(pev(thread, `${thread}.0`, "Chả mực bao nhiêu shop?"));
        const m0 = pancake.calls.length;
        const r = await processFanpageThread(PAGE_P, thread, { fetch: pancake.fetch, now: at(31_000) });
        assert.ok(r.replies >= 1 && pancake.sends(m0).length >= 1, `bot fanpage trả lời tin đầu: ${JSON.stringify(r)}`);
        return (await convOf(thread)).id;
      };
      const P1 = "p-nhuong-1";
      const convP1 = await openedP(P1);
      const TP = new Date();
      assert.match((await receiveFanpageEvent(pev(P1, "p1.staff", "Dạ chị đợi em kiểm kho", true), TP)).reason, /bot nhường/);
      assert.equal((await convOf(P1)).humanCooldownUntil?.getTime(), TP.getTime() + 30 * MIN);
      assert.equal((await holdOf(convP1)).state, "HUMAN_COOLDOWN");
      await receiveFanpageEvent(pev(P1, "p1.2", "Còn không em?"));
      ai0 = aiCalls;
      mark = pancake.calls.length;
      const pP = await processFanpageThread(PAGE_P, P1, { fetch: pancake.fetch, now: () => new Date(TP.getTime() + 10 * MIN) });
      assert.ok(pP.replies === 0 && pancake.sends(mark).length === 0 && aiCalls === ai0, `fanpage trong lúc nhường: 0 AI, 0 gửi: ${JSON.stringify(pP)}`);
      assert.ok((await setConversationControlCore(lan, convP1, "AUTO")).ok);
      await receiveFanpageEvent(pev(P1, "p1.3", "Lấy 1kg nhé"));
      mark = pancake.calls.length;
      const pP3 = await processFanpageThread(PAGE_P, P1, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(pP3.replies >= 1 && pancake.sends(mark).length >= 1, `fanpage: cho AI tiếp tục ⇒ tin kế tiếp được trả lời: ${JSON.stringify(pP3)}`);

      // Hồi quy LỖI ĐỒNG HỒ, ĐỒNG HỒ THẬT: nhân viên trả lời 31 phút trước. Đường Pancake ghi mốc tin khách (đẩy `updated_at` về
      // bây giờ) ngay trước khi hỏi «hết nhường chưa» — đồng hồ cũ (`updated_at`) nói «mới 0 giây», AI im mãi. Đồng hồ mới: hết hạn.
      const P2 = "p-nhuong-2";
      await openedP(P2);
      await receiveFanpageEvent(pev(P2, "p2.staff", "Dạ em gửi chị bảng giá", true), new Date(Date.now() - 31 * MIN));
      await receiveFanpageEvent(pev(P2, "p2.2", "1kg có miễn ship không?"));
      mark = pancake.calls.length;
      const pP2 = await processFanpageThread(PAGE_P, P2, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(pP2.replies >= 1 && pancake.sends(mark).length >= 1, `nhân viên trả lời 31 phút trước ⇒ AI trả lời lại (đồng hồ là mốc tường minh, không phải updated_at): ${JSON.stringify(pP2)}`);

      // ═══ DẤU VẾT từng tin khách trên dữ liệu thật của đường xử lý ═══
      const traceOf = async (convId: string, text: string) => {
        const r = await loadInboxThread(lan, convId);
        assert.ok(r.ok, JSON.stringify(r));
        const it = r.thread.items.find((i) => i.side === "CUSTOMER" && i.text === text);
        assert.ok(it?.trace, `tin «${text}» có dấu vết: ${JSON.stringify(it)}`);
        return it.trace;
      };
      const trCd = await traceOf(convP1, "Còn không em?");
      assert.ok(trCd.code === "AI_SKIPPED_HUMAN_COOLDOWN" && trCd.steps[1].stage === "ELIGIBLE" && trCd.steps[1].state === "FAILED" && trCd.outcome === "STOPPED", JSON.stringify(trCd));
      const trOk = await traceOf(convP1, "Lấy 1kg nhé");
      assert.ok(trOk.code === null && trOk.outcome === "SENT" && trOk.steps.every((s) => s.state === "DONE") && trOk.steps[6].at, `đi trọn tới «Đã gửi», mốc gửi đọc từ BOT_SENT: ${JSON.stringify(trOk)}`);
      const trTk = await traceOf(convC, "Lấy sỉ 50 cái giá sao?");
      assert.equal(trTk.code, "AI_SKIPPED_HUMAN_TAKEOVER", JSON.stringify(trTk));

      // ═══ Tổ chức KHÁCH: bot tắt ⇒ AI_BLOCKED / BOT_DISABLED + dấu vết AI_SKIPPED_DISABLED; bật lại ⇒ AI_ACTIVE ═══
      const off = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: false });
      await db.update(schema.settings).set({ value: off }).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY));
      await forgetAiStatus();
      const P3 = "p-tat-bot";
      await receiveFanpageEvent(pev(P3, "p3.1", "Có giao hôm nay không?"));
      ai0 = aiCalls;
      mark = pancake.calls.length;
      const pOff = await processFanpageThread(PAGE_P, P3, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(pOff.replies === 0 && aiCalls === ai0 && pancake.sends(mark).length === 0, JSON.stringify(pOff));
      const convP3 = (await convOf(P3)).id;
      const tOff = await loadInboxThread(lan, convP3);
      assert.ok(tOff.ok);
      assert.deepEqual(tOff.thread.aiBlocks.map((b) => b.code), ["BOT_DISABLED"], JSON.stringify(tOff.thread.aiBlocks));
      const sOff = controlBarStatus({ hold: tOff.thread.aiHold, blocks: tOff.thread.aiBlocks, mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (s) => s });
      assert.ok(sOff.state === "AI_BLOCKED" && !/AI đang (tự )?trả lời/.test(sOff.text), JSON.stringify(sOff));
      assert.equal((await traceOf(convP3, "Có giao hôm nay không?")).code, "AI_SKIPPED_DISABLED");
      await db.update(schema.settings).set({ value: cfg }).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY));
      await forgetAiStatus();
      const tOn = await loadInboxThread(lan, convP3);
      assert.ok(tOn.ok && tOn.thread.aiBlocks.length === 0, JSON.stringify(tOn.ok && tOn.thread.aiBlocks));
      assert.equal(controlBarStatus({ hold: tOn.thread.aiHold, blocks: tOn.thread.aiBlocks, mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (s) => s }).state, "AI_ACTIVE", "tổ chức khách bình thường ⇒ AI_ACTIVE");

      // ═══ HIỆU NĂNG: hộp thư tự làm mới vài giây một lần — phần cấp tổ chức tính MỘT lần trong cửa sổ đệm; đường XEM không ghi thông báo ═══
      const n0 = aiStatusOrgComputesForTests();
      const notif0 = (await db.select({ id: schema.notifications.id }).from(schema.notifications)).length;
      for (let i = 0; i < 4; i++) assert.ok((await loadInboxThread(lan, i % 2 ? convP3 : convA)).ok);
      assert.equal(aiStatusOrgComputesForTests() - n0, 0, "đệm vừa được tính ở lượt trên ⇒ bốn lượt làm mới (hai hội thoại) không tính lại lần nào");
      await forgetAiStatus();
      for (let i = 0; i < 3; i++) assert.ok((await loadInboxThread(lan, convA)).ok);
      assert.equal(aiStatusOrgComputesForTests() - n0, 1, "hết đệm ⇒ đúng MỘT lần tính cho cả hộp thư, không theo từng lượt");
      assert.equal((await db.select({ id: schema.notifications.id }).from(schema.notifications)).length, notif0, "mở hộp thư không ghi thông báo nào");

      // ═══ AI KHÔNG CHEN VÀO CUỘC CHAT NGƯỜI: Pancake không gắn uid, câu bot cuối đã 4 giờ — hội thoại đang ở tay người ⇒ vẫn là nhân viên ═══
      const P4 = "p-chat-nguoi";
      const convP4 = await openedP(P4);
      const T4 = new Date();
      await receiveFanpageEvent(pev(P4, "p4.staff1", "Dạ em kiểm hàng cho chị nhé", true), new Date(T4.getTime() - 25 * MIN));
      await db.update(schema.salesChatConversations).set({ lastBotAt: new Date(T4.getTime() - 4 * 60 * MIN) }).where(eq(schema.salesChatConversations.id, convP4));
      const noUid = await receiveFanpageEvent({ ...pev(P4, "p4.staff2", "Dạ mẫu mới về rồi chị ơi, em gửi chị xem", true), humanStaff: false }, T4);
      assert.match(noUid.reason, /bot nhường/, `tin phía page không uid lúc hội thoại đang ở tay người ⇒ nhân viên: ${JSON.stringify(noUid)}`);
      assert.equal((await convOf(P4)).humanCooldownUntil?.getTime(), T4.getTime() + 30 * MIN, "nhường được gia hạn từ câu mới nhất");
      await receiveFanpageEvent(pev(P4, "p4.2", "Ok em gửi đi"));
      ai0 = aiCalls;
      mark = pancake.calls.length;
      const pP4 = await processFanpageThread(PAGE_P, P4, { fetch: pancake.fetch, now: () => new Date(T4.getTime() + 10 * MIN) });
      assert.ok(pP4.replies === 0 && aiCalls === ai0 && pancake.sends(mark).length === 0, `nhân viên đang chat ⇒ AI không chen: ${JSON.stringify(pP4)}`);

      // ═══ «Mở lại có điều kiện» của holdGate: ảnh chụp cũ nói «đã hết hạn» nhưng nhân viên VỪA gửi thêm ⇒ không mở, vẫn im ═══
      const P5 = "p-tranh-chap";
      const convP5 = await openedP(P5);
      const T5 = new Date();
      await receiveFanpageEvent(pev(P5, "p5.staff", "Dạ em trả lời chị đây", true), T5);
      const fresh = await convOf(P5);
      const stale = { id: fresh.id, status: "HANDOFF", handoffReason: fresh.handoffReason, state: fresh.state, updatedAt: fresh.updatedAt, humanCooldownUntil: new Date(T5.getTime() - MIN) };
      const gate = await holdGate(stale, T5);
      assert.ok(gate && gate.skip === STAFF_REASON, `ảnh chụp cũ hết hạn nhưng CSDL mang mốc mới ⇒ vẫn bỏ qua: ${JSON.stringify(gate)}`);
      const afterGate = await convOf(P5);
      assert.ok(afterGate.status === "HANDOFF" && afterGate.humanCooldownUntil?.getTime() === T5.getTime() + 30 * MIN, "không mở lại, mốc mới giữ nguyên");
      assert.ok(!(await eventsOf(convP5)).some((e) => e.type === "ai.resumed"), "không ghi kết thúc nhường giả");
      // «Trả lại AI» của hộp thư trong lúc nhường ⇒ cùng mã nhật ký với thanh điều khiển.
      assert.ok((await handBackToAiCore(lan, convP5)).ok);
      const audP5 = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, convP5), eq(schema.auditLogs.action, "SALES_CHAT_AI_RESUME_NOW")));
      assert.equal(audP5.length, 1, "handBackToAiCore lúc đang nhường ⇒ SALES_CHAT_AI_RESUME_NOW");
      assert.equal((await convOf(P5)).humanCooldownUntil, null);
    });

    // ═══ Cô lập tổ chức: mã hội thoại của tổ chức khác ⇒ không có, không đổi được ═══
    const enabledB = [...(await getEnabledModules(ORG_B))];
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      const ub = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG_B}.local`) });
      assert.ok(ub);
      const adminB = { id: ub.id, email: ub.email, name: "QT B", role: "ADMIN", scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG_B, name: ORG_B, isHome: false }, modules: enabledB, permissions: ["ai_sales:manage", "ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      for (const id of foreignIds) {
        const r = await setConversationControlCore(adminB, id, "HUMAN");
        assert.ok(!r.ok && r.error.includes("Không có hội thoại"), `tổ chức B không chạm được hội thoại của A: ${JSON.stringify(r)}`);
        assert.ok(!(await loadInboxThread(adminB, id)).ok);
      }
    });
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, foreignIds[0]));
      assert.ok(row && readConversationControl(row.state) === null, "hội thoại của A không bị tổ chức B đổi");
    });
  } finally {
    setSalesChatProviderForTests(null);
  }
}

/** Bảng ghi chú → mã + dấu vết (thuần). Mỗi ghi chú đường xử lý ghi vào `sales_chat_inbound.note` đều có mã — không UNKNOWN. */
function testTracePure() {
  for (const note of KNOWN_INBOUND_NOTES) {
    const v = classifyInboundNote(note, { status: "SKIPPED", lastError: null, transport: "MESSENGER" });
    assert.ok(v && !v.code.startsWith("UNKNOWN"), `ghi chú «${note}» phải có mã: ${JSON.stringify(v)}`);
  }
  const k = (note: string, status = "SKIPPED", lastError: string | null = null, transport: "MESSENGER" | "PANCAKE" | "ZALO" = "MESSENGER") => classifyInboundNote(note, { status, lastError, transport })?.code;
  assert.equal(k(PAGE_OFF_NOTE), "AI_SKIPPED_PAGE_OFF");
  assert.equal(k(PAGE_SHADOW_NOTE), "AI_SKIPPED_PAGE_SHADOW");
  assert.equal(k(PAGE_SHADOW_BOT_OFF_NOTE), "AI_SKIPPED_DISABLED");
  assert.equal(k(TURN_BOT_OFF_ERROR), "AI_SKIPPED_DISABLED");
  assert.equal(k(TURN_MODULE_OFF_ERROR), "AI_SKIPPED_MODULE_OFF");
  assert.equal(k(STAFF_REASON), "AI_SKIPPED_HUMAN_COOLDOWN");
  assert.equal(k(ZALO_STAFF_REASON), "AI_SKIPPED_HUMAN_COOLDOWN");
  assert.equal(k(TAKEOVER_REASON), "AI_SKIPPED_HUMAN_TAKEOVER");
  assert.equal(k(`${NEEDS_HUMAN_NOTE}: Khách sỉ — cần báo giá riêng`), "AI_SKIPPED_NEEDS_HUMAN");
  assert.equal(k(CONV_OPEN_FAILED_NOTE, "DEAD"), "AI_QUEUE_FAILED", "hết lượt thử ⇒ hàng chờ hỏng");
  assert.equal(k(DEAD_AI_DOWN_NOTE, "DEAD", "Anthropic 401: invalid x-api-key"), "AI_PROVIDER_AUTH_ERROR");
  assert.equal(k(DEAD_AI_DOWN_NOTE, "DEAD", "429 rate_limit_error: quota exceeded"), "AI_PROVIDER_QUOTA");
  assert.equal(k(DEAD_AI_DOWN_NOTE, "DEAD", "overloaded_error 529"), "AI_MODEL_ERROR");
  assert.equal(k(DEAD_AI_DOWN_NOTE, "DEAD", "prompt is too long: 210000 tokens"), "AI_CONTEXT_ERROR");
  assert.equal(k(`${DEAD_SEND_NOTE_PREFIX}(#10) outside window`, "DEAD", null, "MESSENGER"), "MESSENGER_SEND_FAILED");
  assert.equal(k(`${DEAD_SEND_NOTE_PREFIX}Pancake 500`, "DEAD", null, "PANCAKE"), "PANCAKE_SEND_FAILED");
  assert.equal(k("Một ghi chú chưa ai khai"), "UNKNOWN: Một ghi chú chưa ai khai", "ghi chú lạ ⇒ UNKNOWN nguyên văn, không đoán");

  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const base = { attempts: 0, lastError: null, claimId: null, claimedAt: null, processedAt: null, nextAttemptAt: null, createdAt: ago(5 * MIN) };
  const ev = { transport: "MESSENGER" as const, aiUsage: [], botSentAt: [] };
  const off = buildMessageTrace({ ...base, status: "SKIPPED", note: PAGE_OFF_NOTE, claimId: "c", claimedAt: ago(4 * MIN), processedAt: ago(4 * MIN) }, ev, now);
  assert.equal(off.code, "AI_SKIPPED_PAGE_OFF");
  assert.deepEqual(off.steps.map((s) => s.state), ["DONE", "FAILED", "NOT_REACHED", "NOT_REACHED", "NOT_REACHED", "NOT_REACHED", "NOT_REACHED"], "dừng ở «Đủ điều kiện AI»");
  const pending = buildMessageTrace({ ...base, status: "PENDING", note: null }, ev, now);
  assert.ok(pending.outcome === "IN_PROGRESS" && pending.steps[1].state === "NOT_MEASURED" && pending.steps[2].state === "CURRENT", JSON.stringify(pending));
  const composing = buildMessageTrace({ ...base, status: "PENDING", note: null, claimId: "c", claimedAt: ago(MIN) }, ev, now);
  assert.equal(composing.steps[3].state, "CURRENT");
  const sent = buildMessageTrace({ ...base, status: "DONE", note: null, claimId: "c", claimedAt: ago(4 * MIN), processedAt: ago(3 * MIN) }, { ...ev, aiUsage: [{ at: ago(3.5 * MIN), status: "OK" }], botSentAt: [ago(3.2 * MIN)] }, now);
  assert.ok(sent.outcome === "SENT" && sent.steps[4].at === ago(3.5 * MIN).toISOString() && sent.steps[6].at === ago(3.2 * MIN).toISOString(), JSON.stringify(sent));
  const quick = buildMessageTrace({ ...base, status: "DONE", note: null, claimId: "c", claimedAt: ago(4 * MIN), processedAt: ago(3 * MIN) }, ev, now);
  assert.equal(quick.steps[4].at, null, "không có lượt AI (câu mẫu) ⇒ «Đã soạn» chưa đo, không bịa mốc");
  const auth = buildMessageTrace({ ...base, status: "DEAD", note: DEAD_AI_DOWN_NOTE, lastError: "401 Unauthorized", claimId: "c", claimedAt: ago(4 * MIN), processedAt: ago(3 * MIN) }, ev, now);
  assert.ok(auth.code === "AI_PROVIDER_AUTH_ERROR" && auth.steps[3].stage === "COMPOSING" && auth.steps[3].state === "FAILED" && auth.detail === "401 Unauthorized", JSON.stringify(auth));
  const unk = buildMessageTrace({ ...base, status: "DONE", note: "lạ" }, ev, now);
  assert.ok(unk.code === "UNKNOWN: lạ" && unk.outcome === "UNKNOWN" && unk.steps.slice(1).every((s) => s.state === "NOT_MEASURED"));

  // Câu hiển thị: còn lý do chặn ⇒ AI_BLOCKED, KHÔNG BAO GIỜ «AI đang (tự) trả lời»; người đang cầm vẫn hiện người, kèm câu phụ.
  const view = { state: "AI_ACTIVE" as const, cause: null, until: null, serverNow: now.toISOString() };
  const blocks = [aiBlock("PAGE_OFF", "Page chưa bật"), aiBlock("BOT_DISABLED", "Bot tắt")];
  const blocked = controlBarStatus({ hold: view, blocks, mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (s) => s });
  assert.ok(blocked.state === "AI_BLOCKED" && !/AI đang (tự )?trả lời/.test(blocked.text) && blocked.text.includes("Page chưa bật") && blocked.note?.includes("Bot tắt"), JSON.stringify(blocked));
  assert.equal(controlBarStatus({ hold: view, blocks: [], mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (s) => s }).state, "AI_ACTIVE");
  const cdBlocked = controlBarStatus({ hold: { ...view, state: "HUMAN_COOLDOWN", cause: "STAFF_REPLY", until: new Date(now.getTime() + MIN).toISOString() }, blocks, mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (s) => s });
  assert.ok(cdBlocked.state === "HUMAN_COOLDOWN" && cdBlocked.note?.includes("Page chưa bật"), "đang nhường mà page tắt ⇒ nói luôn hết nhường AI vẫn im");
  assert.ok(!/AI trả lời từ tin khách kế tiếp/.test(controlBarStatus({ hold: { ...view, state: "HUMAN_COOLDOWN", cause: "STAFF_REPLY", until: now.toISOString() }, blocks, mode: "AUTO", handoffReason: null, control: null, lapsed: true, formatAt: (s) => s }).text));
}

/**
 * WORKSPACE NHÀ, cổng page chưa bật (sự cố 07/10/2026): tin khách bị bỏ ⇒ hội thoại AI_BLOCKED / PAGE_OFF (không bao giờ «AI đang
 * tự trả lời»), dấu vết dừng ở «Đủ điều kiện AI» với AI_SKIPPED_PAGE_OFF; ba lớp chặn cùng lúc (page · bot tắt · không nguồn AI)
 * đều hiện, đúng thứ tự đường xử lý. Chỉ ĐỌC: bài không bật page nào. Dọn sạch CSDL nhà ở cuối.
 */
async function testHomeBlocked() {
  const home = await getHomeOrganization();
  const pdb = await getPlatformDb();
  const modWhere = and(eq(schema.platformOrganizationModules.organizationId, home.id), eq(schema.platformOrganizationModules.moduleKey, "ai_sales"));
  const [mod0] = await pdb.select({ enabled: schema.platformOrganizationModules.enabled }).from(schema.platformOrganizationModules).where(modWhere);
  const setModule = async (enabled: boolean | null) => {
    if (enabled === null) await pdb.delete(schema.platformOrganizationModules).where(modWhere);
    else await pdb.insert(schema.platformOrganizationModules).values({ organizationId: home.id, moduleKey: "ai_sales", enabled, updatedBy: "system:test" }).onConflictDoUpdate({ target: [schema.platformOrganizationModules.organizationId, schema.platformOrganizationModules.moduleKey], set: { enabled, updatedBy: "system:test" } });
    invalidateCapabilities();
  };
  const startedAt = new Date(Date.now() - 1_000);
  const pancake = fakePancake();
  setSalesChatProviderForTests(() => fakeBot());
  await setModule(true);
  try {
    await withOrganization(home.code, async () => {
      const db = await getDb();
      const st = schema.settings;
      const KEYS = [SALES_CHATBOT_SETTING_KEY, PAGE_RUNTIME_SETTING_KEY, OPERATING_MODE_SETTING_KEY];
      const snap = await db.select().from(st).where(inArray(st.key, KEYS));
      const [connBefore] = await db.select({ id: schema.orgConnections.id }).from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "pancake-fanpage"));
      assert.equal(connBefore, undefined, "CSDL nhà của bộ kiểm thử chưa có kết nối fanpage — bài này dựng rồi gỡ");
      await db.delete(schema.users).where(eq(schema.users.email, HOME_ADMIN));
      const [u] = await db.insert(schema.users).values({ email: HOME_ADMIN, name: "Nhường nhà", passwordHash: "khong-dang-nhap", role: "ADMIN" }).returning();
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } } as unknown as SessionUser;
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      try {
        assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE_H }, secrets: { pageAccessToken: PANCAKE_TOKEN } })));
        assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
        assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
        await db.delete(st).where(inArray(st.key, [PAGE_RUNTIME_SETTING_KEY, OPERATING_MODE_SETTING_KEY]));
        await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
        await forgetAiStatus();
        const TH = "h-nhuong-1";
        const conv = await conversationFor(PAGE_H, TH);
        assert.ok(conv);
        assert.ok((await receiveFanpageEvent({ pageId: PAGE_H, threadId: TH, messageId: "h.1", text: "Chả cá còn không shop?", customerName: "Khách nhà", fromPage: false, humanStaff: false, inbox: true, comment: null, imageUrls: [] })).queued);
        const ai0 = aiCalls;
        const r = await processFanpageThread(PAGE_H, TH, { fetch: pancake.fetch, now: () => new Date(Date.now() + 31_000) });
        assert.ok(r.skipped === PAGE_OFF_NOTE && aiCalls === ai0 && pancake.sends(0).length === 0, JSON.stringify(r));
        const th = await loadInboxThread(admin, conv.id);
        assert.ok(th.ok, JSON.stringify(th));
        assert.equal(th.thread.aiHold.state, "AI_ACTIVE", "không ai đang cầm — nhưng đó KHÔNG phải «AI đang trả lời»");
        assert.deepEqual(th.thread.aiBlocks.map((b) => b.code), ["PAGE_OFF"], JSON.stringify(th.thread.aiBlocks));
        assert.ok(th.thread.aiBlocks[0].fixHref?.includes("#page-runtime"), "nút sửa trỏ tới khối «Bot Chốt Đơn theo page»");
        const s = controlBarStatus({ hold: th.thread.aiHold, blocks: th.thread.aiBlocks, mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (x) => x });
        assert.ok(s.state === "AI_BLOCKED" && !/AI đang (tự )?trả lời/.test(s.text), `nhà, page OFF ⇒ AI_BLOCKED, không bao giờ «AI đang tự trả lời»: ${JSON.stringify(s)}`);
        const tr = th.thread.items.find((i) => i.side === "CUSTOMER")?.trace;
        assert.ok(tr && tr.code === "AI_SKIPPED_PAGE_OFF" && tr.steps[1].state === "FAILED" && tr.steps.slice(2).every((x) => x.state === "NOT_REACHED"), `dấu vết dừng ở «Đủ điều kiện AI»: ${JSON.stringify(tr)}`);
        // Ba lớp của sự cố cùng lúc: page OFF · bot tắt · không nguồn AI nào chạy được — đúng thứ tự đường xử lý.
        await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: false });
        setSalesChatProviderForTests(() => null);
        await forgetAiStatus();
        const th3 = await loadInboxThread(admin, conv.id);
        assert.ok(th3.ok);
        assert.deepEqual(th3.thread.aiBlocks.map((b) => b.code), ["PAGE_OFF", "BOT_DISABLED", "NO_AI_SOURCE"], JSON.stringify(th3.thread.aiBlocks));
        // Chỉ đọc: không bật page, không trả lời ngược tin cũ.
        assert.equal((await db.select({ s: t.status }).from(t).where(eq(t.messageId, "h.1")))[0]?.s, "SKIPPED");
        assert.equal((await db.select().from(st).where(eq(st.key, PAGE_RUNTIME_SETTING_KEY))).length, 0, "bài không bật page nào");
      } finally {
        await db.delete(c).where(eq(c.pageId, PAGE_H));
        await db.delete(t).where(eq(t.pageId, PAGE_H));
        await db.delete(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "pancake-fanpage"));
        await db.delete(schema.auditLogs).where(and(gte(schema.auditLogs.createdAt, startedAt), eq(schema.auditLogs.userId, u.id)));
        await db.delete(schema.users).where(eq(schema.users.id, u.id));
        await db.delete(st).where(inArray(st.key, KEYS));
        if (snap.length) await db.insert(st).values(snap);
        await forgetAiStatus();
      }
    });
  } finally {
    setSalesChatProviderForTests(null);
    await pdb.delete(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, home.code), gte(schema.platformAiUsage.at, startedAt)));
    await setModule(mod0 ? mod0.enabled : null);
  }
}

export async function testSalesHumanTakeover() {
  testPure();
  testTracePure();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-nhuong-nguoi-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await cleanupOrg(ORG);
    await cleanupOrg(ORG_B);
    await testFlow();
    await testHomeBlocked();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanupOrg(ORG);
    await cleanupOrg(ORG_B);
  }
  console.log("✓ AI nhường người: ba trạng thái AI_ACTIVE · HUMAN_COOLDOWN · HUMAN_TAKEOVER từ MỘT hàm thuần; gửi tay ⇒ nhường đúng mốc giờ gửi + 30 phút (cột tường minh, không phải updated_at); tin khách trong lúc nhường lưu, 0 lượt AI, 0 tin gửi; «Cho AI tiếp tục ngay» ⇒ AI trả lời tin kế tiếp, không trả lời ngược tin cũ; hết 30 phút ⇒ máy ghi kết thúc; tiếp quản bền qua 2–3 giờ, gửi tay không biến về nhường; trả lại cho AI; năm loại sự kiện mang users.id; chỉ xem không đổi được; cô lập tổ chức; fanpage Pancake cùng luật + hồi quy đồng hồ thật; đếm ngược theo giờ máy chủ");
}

if (process.argv[1] && /sales-human-takeover.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSalesHumanTakeover)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
