/**
 * ═══════════ AI HAY NGƯỜI TRÊN TỪNG HỘI THOẠI (conversation-control*.ts · gap analysis slice 1) ═══════════
 *
 * Khoá:
 *  · THUẦN: ghi đè của hội thoại chỉ THU HẸP cổng của tổ chức (HUMAN ⇒ quan sát; COPILOT ⇒ copilot; tổ chức đang quan sát thì
 *    COPILOT không mở được gì); phán quyết gửi so ảnh chụp đầu lượt với ảnh chụp đọc lại (HANDOFF · chế độ · `last_staff_at`
 *    tăng ⇒ KHÔNG gửi); dữ liệu `state.control` hỏng ⇒ AUTO; lý do bị cắt; lý do tiếp quản xếp nhóm `STAFF_TOOK_OVER`.
 *  · LỖ HỔNG TRẢ LỜI ĐÔI (Messenger trực tiếp, Graph giả): nhân viên TIẾP QUẢN trong lúc AI đang soạn ⇒ bot KHÔNG gửi câu đã soạn
 *    (0 lời gọi Send API); nhân viên GỬI TIN từ hộp thư trong lúc AI soạn ⇒ khách nhận ĐÚNG MỘT tin — của nhân viên.
 *  · TIẾP QUẢN BỀN: quá 30 phút vẫn im, không tốn lượt AI; bấm lại ⇒ không ghi thêm; nhật ký mang người + lý do + trước / sau;
 *    sự kiện `human.took_over` (STAFF_TOOK_OVER) mang `users.id`.
 *  · AI GỢI Ý trên MỘT hội thoại: bot soạn gợi ý, không gửi. TRẢ LẠI AI: `ai.resumed`, gỡ chế độ, bot trả lời lại.
 *  · Hai người đổi chế độ CÙNG LÚC ⇒ đúng một người thắng. Chỉ xem ⇒ không đổi được. Chat web không có Copilot.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import {
  applyConversationControl,
  BOT_YIELDED_NOTE,
  botSendVerdict,
  CONTROL_REASON_MAX,
  controlOf,
  controlSkipNote,
  normalizeControlReason,
  readConversationControl,
  TAKEOVER_REASON,
} from "@/lib/sales-chatbot/conversation-control-shared";
import { botMaySend, captureSendSnapshot, setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import { connectMessengerPage, processMessengerThread, receiveMessengerEvent } from "@/lib/sales-chatbot/messenger";
import type { ReplyGate } from "@/lib/sales-chatbot/operating-mode-shared";

const ORG = "kiem-soat-hoi-thoai";
const APP_ID = "777000333444";
const APP_SECRET = "app-secret-control-test-0123456789ab";
const PAGE = "2039485761";
const PAGE_TOKEN = "EAAGpagetoken_control_0123456789abcdef";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;
const BOT_TEXT = "Dạ size M còn hàng ạ, chị lấy mấy cái ạ?";

function testPure() {
  const auto: ReplyGate = { mode: "AUTOPILOT", arm: null, experimentKey: null, pinNow: false };
  const observe: ReplyGate = { ...auto, mode: "OBSERVE" };
  const copilot: ReplyGate = { ...auto, mode: "COPILOT" };
  assert.equal(applyConversationControl(auto, "AUTO").mode, "AUTOPILOT");
  assert.equal(applyConversationControl(auto, "HUMAN").mode, "OBSERVE");
  assert.equal(applyConversationControl(auto, "COPILOT").mode, "COPILOT");
  assert.equal(applyConversationControl(observe, "COPILOT").mode, "OBSERVE", "tổ chức đang quan sát ⇒ hội thoại không tự mở được copilot");
  assert.equal(applyConversationControl(observe, "AUTO").mode, "OBSERVE", "AUTO = theo tổ chức, không mở rộng");
  assert.equal(applyConversationControl(copilot, "HUMAN").mode, "OBSERVE");
  const arm: ReplyGate = { mode: "AUTOPILOT", arm: "AI", experimentKey: "e1", pinNow: true };
  assert.deepEqual(applyConversationControl(arm, "HUMAN"), { ...arm, mode: "OBSERVE" }, "nhánh thử nghiệm giữ nguyên để báo cáo thử nghiệm không lệch");

  assert.equal(controlOf(null), "AUTO");
  assert.equal(controlOf({ control: { mode: "BOGUS" } }), "AUTO", "dữ liệu lạ ⇒ AUTO");
  assert.equal(controlOf({ control: "HUMAN" }), "AUTO");
  assert.deepEqual(readConversationControl({ control: { mode: "HUMAN", byUserId: "u1", byName: "Lan", at: "2026-10-06T00:00:00.000Z", reason: "Khách sỉ" } }), { mode: "HUMAN", byUserId: "u1", byName: "Lan", at: "2026-10-06T00:00:00.000Z", reason: "Khách sỉ" });
  assert.equal(controlSkipNote("AUTO"), null);
  assert.ok(controlSkipNote("HUMAN") && controlSkipNote("COPILOT"));

  const t0 = new Date("2026-10-06T08:00:00Z");
  const t1 = new Date("2026-10-06T08:00:05Z");
  const open = { status: "OPEN", state: {}, lastStaffAt: t0 };
  assert.deepEqual(botSendVerdict(open, open), { ok: true });
  assert.deepEqual(botSendVerdict({ ...open, lastStaffAt: null }, { ...open, lastStaffAt: null }), { ok: true });
  assert.ok(!botSendVerdict(open, { ...open, status: "HANDOFF" }).ok, "hội thoại sang người trong lúc bot soạn ⇒ không gửi");
  assert.ok(!botSendVerdict(open, { ...open, state: { control: { mode: "HUMAN" } } }).ok, "vừa tiếp quản ⇒ không gửi");
  assert.ok(!botSendVerdict(open, { ...open, state: { control: { mode: "COPILOT" } } }).ok, "vừa chuyển AI gợi ý ⇒ không gửi");
  assert.ok(!botSendVerdict(open, { ...open, lastStaffAt: t1 }).ok, "nhân viên vừa gửi tin (trạng thái chưa kịp đổi) ⇒ không gửi");
  assert.ok(!botSendVerdict({ ...open, lastStaffAt: null }, { ...open, lastStaffAt: t1 }).ok, "tin nhân viên ĐẦU TIÊN cũng tính");
  const v = botSendVerdict(open, { ...open, status: "HANDOFF" });
  assert.ok(!v.ok && v.reason === BOT_YIELDED_NOTE);

  assert.equal(normalizeControlReason("   "), null);
  assert.equal(normalizeControlReason(42), null);
  assert.equal(normalizeControlReason("  khách   sỉ \n"), "khách sỉ");
  assert.equal(normalizeControlReason("x".repeat(500))?.length, CONTROL_REASON_MAX);
  assert.equal(classifyHandoffReason(TAKEOVER_REASON), "STAFF_TOOK_OVER", "lý do tiếp quản đếm riêng trên màn «Hiệu quả»");
}

type Call = { url: string; init?: RequestInit };
function fakeGraph(): { fetch: typeof fetch; calls: Call[]; sends: (from: number) => Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) return json({ success: true });
    if (u.pathname.endsWith(`/${PAGE}`)) return json({ id: PAGE });
    if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === PAGE_TOKEN) return json({ id: PAGE, name: "Shop Kiểm Soát" });
    if (u.pathname.endsWith("/me/messages")) return json({ recipient_id: "x", message_id: `m.out.${calls.length}` });
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls, sends: (from) => calls.slice(from).filter((c) => c.url.includes("/me/messages")) };
}

/** Bot giả: mỗi lượt có công cụ (= lượt trả lời thật) chạy `duringTurn` một lần — đúng khoảng «AI đang soạn» ngoài đời. */
let duringTurn: (() => Promise<void>) | null = null;
let aiCalls = 0;
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      aiCalls += 1;
      if (req.tools.length && duringTurn) {
        const f = duringTurn;
        duringTurn = null;
        await f();
      }
      const text = req.tools.length ? BOT_TEXT : "NONE";
      return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testFlow() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "KiemSoat@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  const g = fakeGraph();
  setSalesChatProviderForTests(() => fakeBot());
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
      const viewer = { ...base, id: "ctl-viewer", name: "Xem", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;

      const conn = await connectMessengerPage(admin, { id: PAGE, name: "Shop Kiểm Soát", token: PAGE_TOKEN, canMessage: true }, { fetch: g.fetch });
      assert.ok("ok" in conn, JSON.stringify(conn));
      const cfg = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: cfg }).onConflictDoUpdate({ target: schema.settings.key, set: { value: cfg } });

      const c = schema.salesChatConversations;
      const ev = (psid: string, mid: string, text: string) => ({ platform: "MESSENGER" as const, pageId: PAGE, psid, mid, text, imageUrls: [], isEcho: false, appId: null, at: null });
      const later = (ms: number) => () => new Date(Date.now() + ms);
      const convOf = async (psid: string) => (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.threadId, psid))).limit(1))[0];
      const eventsOf = async (id: string) => db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, id));

      // ═══ A. TIẾP QUẢN trong lúc AI đang soạn ⇒ bot không gửi câu đã soạn ═══
      const A = "7000000000001";
      await receiveMessengerEvent(ev(A, "a.1", "Áo này còn size M không?"));
      duringTurn = async () => {
        const conv = await convOf(A);
        const r = await setConversationControlCore(lan, conv.id, "HUMAN", "  Khách sỉ  ");
        assert.ok(r.ok && r.changed && r.mode === "HUMAN", JSON.stringify(r));
      };
      let mark = g.calls.length;
      const pA = await processMessengerThread(PAGE, A, { fetch: g.fetch, now: later(31_000) });
      assert.equal(duringTurn, null, "lượt AI đã chạy (giả lập khoảng «đang soạn»)");
      assert.equal(g.sends(mark).length, 0, `tiếp quản giữa lượt ⇒ 0 lời gọi Send API: ${JSON.stringify(pA)}`);
      // Hai lớp chặn, tuỳ người bấm rơi vào lúc nào: trước khi lượt AI đọc trạng thái cuối ⇒ lượt thấy HANDOFF và im; sau đó ⇒
      // cổng gửi (`botMaySend`) giữ câu lại. Kết quả khách thấy là một: KHÔNG có câu bot.
      assert.ok(pA.replies === 0 && (pA.skipped === BOT_YIELDED_NOTE || pA.skipped === "Chuyển nhân viên — bot im lặng"), JSON.stringify(pA));
      const inA = await db.select().from(schema.salesChatInbound).where(eq(schema.salesChatInbound.messageId, "a.1"));
      assert.equal(inA[0]?.status, "DONE");
      const convA = await convOf(A);
      const stA = readConversationControl(convA.state);
      assert.ok(convA.status === "HANDOFF" && convA.handoffReason === TAKEOVER_REASON && convA.assigneeUserId === lan.id, JSON.stringify({ s: convA.status, r: convA.handoffReason }));
      assert.ok(stA?.mode === "HUMAN" && stA.byUserId === lan.id && stA.byName === "Lan CSKH" && stA.reason === "Khách sỉ", `tiếp quản sống qua lượt AI (bump không ghi đè), người bấm do MÁY CHỦ đọc (luật 34): ${JSON.stringify(stA)}`);
      const tookA = (await eventsOf(convA.id)).filter((e) => e.type === "human.took_over");
      assert.ok(tookA.length === 1 && tookA[0].reasonCode === "STAFF_TOOK_OVER" && tookA[0].actorUserId === lan.id && tookA[0].actorKind === "HUMAN", JSON.stringify(tookA));
      const audA = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHAT_CONTROL_SET"), eq(schema.auditLogs.entityId, convA.id)));
      assert.equal(audA.length, 1);
      assert.ok(audA[0].userId === lan.id && audA[0].reason === "Khách sỉ" && JSON.stringify(audA[0].detail).includes('"mode":"AUTO"') && JSON.stringify(audA[0].detail).includes('"mode":"HUMAN"'), `nhật ký: người · lý do · trước → sau: ${JSON.stringify(audA[0])}`);

      // Tiếp quản BỀN: quá 30 phút vẫn im, không tốn lượt AI.
      await receiveMessengerEvent(ev(A, "a.2", "Shop ơi?"));
      const aiBefore = aiCalls;
      mark = g.calls.length;
      const pA2 = await processMessengerThread(PAGE, A, { fetch: g.fetch, now: later(2 * 3_600_000) });
      assert.ok(pA2.replies === 0 && g.sends(mark).length === 0 && aiCalls === aiBefore, `quá 30 phút vẫn im, 0 lượt AI: ${JSON.stringify(pA2)}`);
      // Bấm lại đúng chế độ ⇒ không ghi gì thêm (luật 61).
      const again = await setConversationControlCore(minh, convA.id, "HUMAN");
      assert.ok(again.ok && !again.changed);
      assert.equal((await eventsOf(convA.id)).filter((e) => e.type === "human.took_over").length, 1);
      assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHAT_CONTROL_SET"), eq(schema.auditLogs.entityId, convA.id)))).length, 1);
      // Chỉ xem ⇒ không đổi được.
      const denied = await setConversationControlCore(viewer, convA.id, "AUTO");
      assert.ok(!denied.ok && denied.error.includes("ai_sales:reply"));
      // TRẢ LẠI AI ⇒ gỡ chế độ, `ai.resumed`, bot trả lời tin kế tiếp.
      const back = await setConversationControlCore(lan, convA.id, "AUTO");
      assert.ok(back.ok && back.changed && back.mode === "AUTO");
      const convA2 = await convOf(A);
      assert.ok(convA2.status === "OPEN" && convA2.handoffReason === null && readConversationControl(convA2.state) === null, JSON.stringify({ s: convA2.status }));
      assert.ok((await eventsOf(convA.id)).some((e) => e.type === "ai.resumed" && e.actorUserId === lan.id));
      await receiveMessengerEvent(ev(A, "a.3", "Vậy lấy 2 cái size M"));
      mark = g.calls.length;
      const pA3 = await processMessengerThread(PAGE, A, { fetch: g.fetch, now: later(31_000) });
      assert.ok(pA3.replies >= 1 && g.sends(mark).length >= 1, `trả lại AI ⇒ bot trả lời lại: ${JSON.stringify(pA3)}`);

      // ═══ B. Nhân viên GỬI TIN từ hộp thư trong lúc AI soạn ⇒ khách nhận ĐÚNG MỘT tin — của nhân viên ═══
      const B = "7000000000002";
      await receiveMessengerEvent(ev(B, "b.1", "Áo trắng còn không shop?"));
      await processMessengerThread(PAGE, B, { fetch: g.fetch, now: later(31_000) });
      const convB = await convOf(B);
      await receiveMessengerEvent(ev(B, "b.2", "Size L nữa nhé"));
      duringTurn = async () => {
        const r = await sendStaffReplyCore(lan, convB.id, { text: "Dạ để em kiểm kho rồi báo chị ngay ạ", requestKey: "req-ctl-000001" }, { fetch: g.fetch });
        assert.ok(r.ok, JSON.stringify(r));
      };
      mark = g.calls.length;
      const pB = await processMessengerThread(PAGE, B, { fetch: g.fetch, now: later(31_000) });
      const sentB = g.sends(mark).map((s) => String(s.init?.body));
      assert.equal(sentB.length, 1, `đúng MỘT tin tới khách: ${JSON.stringify(sentB)} ${JSON.stringify(pB)}`);
      assert.ok(sentB[0].includes("kiểm kho") && !sentB[0].includes("size M còn hàng"), "tin tới khách là của nhân viên, không phải câu bot đã soạn");

      // ═══ B2. Cổng gửi đọc CSDL thật: ảnh chụp đầu lượt → người gửi tin → không gửi; không ai làm gì → gửi ═══
      {
        const before = await captureSendSnapshot(convA.id);
        assert.ok(before);
        assert.deepEqual(await botMaySend(convA.id, before), { ok: true }, "không ai làm gì giữa lượt ⇒ bot gửi");
        await db.update(c).set({ lastStaffAt: new Date(Date.now() + 1_000) }).where(eq(c.id, convA.id));
        const v = await botMaySend(convA.id, before);
        assert.ok(!v.ok && v.reason === BOT_YIELDED_NOTE, "tin nhân viên tới SAU ảnh chụp đầu lượt ⇒ bot không gửi");
        assert.ok(!(await botMaySend(convA.id, null)).ok, "không có ảnh chụp đầu lượt ⇒ nghi ngờ thì để người");
        assert.ok(!(await botMaySend("khong-co-hoi-thoai", before)).ok);
      }

      // ═══ C. AI GỢI Ý trên MỘT hội thoại: soạn, không gửi ═══
      const C = "7000000000003";
      await receiveMessengerEvent(ev(C, "c.1", "Giá áo sơ mi bao nhiêu?"));
      await processMessengerThread(PAGE, C, { fetch: g.fetch, now: later(31_000) });
      const convC = await convOf(C);
      const cop = await setConversationControlCore(minh, convC.id, "COPILOT");
      assert.ok(cop.ok && cop.changed);
      await receiveMessengerEvent(ev(C, "c.2", "Có màu xanh không?"));
      mark = g.calls.length;
      const pC = await processMessengerThread(PAGE, C, { fetch: g.fetch, now: later(31_000) });
      assert.equal(g.sends(mark).length, 0, `AI gợi ý ⇒ không gửi: ${JSON.stringify(pC)}`);
      const sug = await db.select().from(schema.salesCopilotSuggestions).where(eq(schema.salesCopilotSuggestions.conversationId, convC.id));
      assert.ok(sug.length >= 1, "bot soạn gợi ý cho người gửi");

      // Hai người đổi chế độ CÙNG LÚC ⇒ đúng một người thắng, người kia được báo tải lại.
      const both = await Promise.all([setConversationControlCore(lan, convC.id, "AUTO"), setConversationControlCore(minh, convC.id, "HUMAN")]);
      const winners = both.filter((r) => r.ok && r.changed);
      assert.equal(winners.length, 1, `một người thắng: ${JSON.stringify(both)}`);
      const loser = both.find((r) => !(r.ok && r.changed));
      assert.ok(loser && !loser.ok && loser.error.includes("tải lại"), JSON.stringify(loser));

      // Chat web không có Copilot.
      const [web] = await db.insert(c).values({ channel: "WEB", status: "OPEN" }).returning({ id: c.id });
      const webCop = await setConversationControlCore(lan, web.id, "COPILOT");
      assert.ok(!webCop.ok && webCop.error.includes("Chat web"));
      const bogus = await setConversationControlCore(lan, convC.id, "ROBOT");
      assert.ok(!bogus.ok);
      const missing = await setConversationControlCore(lan, "khong-co-hoi-thoai-nay", "HUMAN");
      assert.ok(!missing.ok && missing.error.includes("Không có hội thoại"));
    });
  } finally {
    duringTurn = null;
    setSalesChatProviderForTests(null);
  }
}

export async function testConversationControl() {
  testPure();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-kiem-soat-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await cleanup();
    await testFlow();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ AI ↔ người trên từng hội thoại: ghi đè chỉ thu hẹp cổng tổ chức; tiếp quản / nhân viên gửi tin GIỮA lượt AI ⇒ bot không gửi câu đã soạn (khách nhận đúng một tin); tiếp quản bền quá 30 phút, 0 lượt AI; bấm lại không ghi thêm; nhật ký người + lý do + trước → sau; AI gợi ý soạn không gửi; trả lại AI ⇒ ai.resumed, bot trả lời lại; hai người cùng bấm ⇒ một người thắng; chỉ xem không đổi được");
}

if (process.argv[1] && /conversation-control.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testConversationControl)
    .then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
}
