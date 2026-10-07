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
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
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
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { readConversationControl, TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { HUMAN_TAKEOVER_MINUTES, processFanpageThread, receiveFanpageEvent, STAFF_REASON } from "@/lib/sales-chatbot/fanpage";
import { loadInboxThread, sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
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

export async function testSalesHumanTakeover() {
  testPure();
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
