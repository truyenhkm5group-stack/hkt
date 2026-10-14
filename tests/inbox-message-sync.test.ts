/**
 * ═══════════ ĐỒNG BỘ TIN PANCAKE → HỘP THƯ (P0 HSLC 14/10/2026 — ca «Châu Dương») ═══════════
 *
 * Gốc: tin PHÍA PAGE ngoài ERP (nhân viên gõ trên Pancake) vào sổ tin nhưng không đẩy mốc nào của hội thoại và không phát sự kiện ⇒
 * Pancake đưa hội thoại lên đầu còn hộp thư ERP vẫn xếp nó theo tin khách cũ. Khoá (đi qua ĐÚNG `receiveFanpageEvent` + `listInbox`):
 *  · tin mới ⇒ có trong trang đầu «Tất cả» đúng thứ tự tin gần nhất; câu nhân viên trả lời trên Pancake ⇒ hội thoại lên đầu, rời
 *    «Chờ trả lời», phát sự kiện cho hộp thư đang mở;
 *  · tin TỰ ĐỘNG của page không đẩy hội thoại; tiếng vọng câu bot không thành dòng thứ hai và không đổi thứ tự;
 *  · webhook TRÙNG ⇒ không dòng thứ hai, thứ tự không đổi; webhook CHẬM / SAI THỨ TỰ (tin cũ tới sau) ⇒ mốc không lùi;
 *  · khách nhắn lại sau câu nhân viên ⇒ về «Chờ trả lời» + «Chưa đọc», đứng đầu.
 *  · Sức khoẻ: độ trễ webhook → sổ P95 > 5 giây ⇒ CẢNH BÁO; mẫu nhỏ ⇒ CHƯA ĐỦ DỮ LIỆU, không phải «khoẻ».
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { subscribe } from "@/lib/realtime/bus";
import { fanpageVisitorKey, receiveFanpageEvent, type FanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { evaluateSalesHealth, INGEST_P95_WARN_SECONDS, type SalesHealthSnapshot } from "@/lib/sales-chatbot/health-shared";
import { listInbox } from "@/lib/sales-chatbot/inbox";
import { resolveAiSalesSlo } from "@/lib/constants/ai-sales-slo";

const ORG = "hop-thu-dong-bo";
const PAGE = "5566778899";
const PAGE_TOKEN = "pancake_page_token_dongbo_0123456789abc";
const MIN = 60_000;

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const okFetch = (async () => new Response(JSON.stringify({ success: true, conversations: [], messages: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

function testIngestHealth() {
  const slo = resolveAiSalesSlo(null);
  const base = {
    at: "2026-10-14T05:00:00.000Z",
    botEnabled: true,
    mode: "AUTOPILOT",
    orderSyncEnabled: false,
    channels: { pancake: { configured: true, lastWebhookAt: null }, messenger: { pages: 0, lastEventAt: null, lastErrorAt: null, lastError: null } },
    lastCustomerMessageAt: null,
    lastAiReplyAt: null,
    lastAiOrderAt: null,
    queue: { pending: 0, retrying: 0, oldestPendingAt: null, failedAiDown24h: 0, failedSend24h: 0, abandoned24h: 0, deadLetter: 0 },
    silent: { customerHandled: 0, botSent: 0, windowMinutes: 30 },
    latency: { p50Seconds: null, p95Seconds: null, sample: 0, unanswered: 0 },
    provider: { okInWindow: 1, errorsInWindow: 0, blockedInWindow: 0, lastOkAt: "2026-10-14T04:59:00.000Z", lastErrorAt: null, lastErrorKind: null, lastErrorLabel: null },
    traffic: { lastHour: 3, baselineSameHour: null, baselineDays: 0 },
    followup: { lastRunAt: "2026-10-14T04:58:00.000Z", lastStatus: "SUCCESS", lastError: null },
    orderSyncErrors24h: 0,
    orderSync: { errorsInWindow: 0, lastOkAt: null, lastErrorAt: null },
    today: { conversationsAi: 0, ordersAi: 0, ordersSync: 0, orderValueAi: 0, conversionPct: null },
    errors24h: 0,
  } satisfies SalesHealthSnapshot;
  const ingestOf = (snap: SalesHealthSnapshot) => evaluateSalesHealth(snap, slo).checks.find((c) => c.key === "INGEST");
  assert.equal(ingestOf(base), undefined, "bản chụp cũ chưa đo ⇒ không có kiểm này (không bịa)");
  assert.equal(ingestOf({ ...base, ingest: { p50Seconds: 1, p95Seconds: 30, sample: 4, windowMinutes: 60 } })?.level, "UNKNOWN", "mẫu nhỏ ⇒ CHƯA ĐỦ DỮ LIỆU, không kết luận");
  assert.equal(ingestOf({ ...base, ingest: { p50Seconds: 1, p95Seconds: INGEST_P95_WARN_SECONDS + 0.5, sample: 40, windowMinutes: 60 } })?.level, "WARNING", "P95 > 5 giây ⇒ cảnh báo");
  assert.equal(ingestOf({ ...base, ingest: { p50Seconds: 0.6, p95Seconds: 1.2, sample: 40, windowMinutes: 60 } })?.level, "OK");
  assert.equal(ingestOf({ ...base, channels: { ...base.channels, pancake: { configured: false, lastWebhookAt: null } }, ingest: { p50Seconds: 1, p95Seconds: 30, sample: 40, windowMinutes: 60 } }), undefined, "không dùng Pancake ⇒ không kiểm");
}

export async function testInboxMessageSync() {
  console.log("Đồng bộ tin Pancake → hộp thư (P0 14/10/2026):");
  testIngestHealth();
  await cleanup();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-dong-bo-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await provisionOrganization({ code: ORG, name: "Shop đồng bộ", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "DongBo@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const viewer = { ...admin, id: "dong-bo-viewer", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: okFetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));

      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const t0 = Date.now();
      const ev = (p: Partial<FanpageEvent> & { threadId: string; messageId: string }): FanpageEvent => ({ pageId: PAGE, text: "Shop ơi còn hàng không", customerName: "Khách", fromPage: false, humanStaff: false, inbox: true, comment: null, imageUrls: [], ...p });
      const convOf = async (thread: string) => (await db.select({ id: c.id }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(PAGE, thread)))).limit(1))[0]?.id;
      const order = async (filter = "ALL") => {
        const r = await listInbox(viewer, { filter });
        assert.ok(r.ok, JSON.stringify(r));
        return r.rows.map((x) => x.id);
      };
      const rowsOfThread = async (thread: string) => db.select({ id: t.id }).from(t).where(and(eq(t.pageId, PAGE), eq(t.threadId, thread)));

      // 1. Tin mới của khách ⇒ hội thoại có trong trang đầu, đúng thứ tự tin gần nhất (A cũ nhất, C mới nhất).
      for (const [thread, ago] of [["t-a", 30], ["t-b", 20], ["t-c", 10]] as const) {
        const r = await receiveFanpageEvent(ev({ threadId: thread, messageId: `cust-${thread}-1` }), new Date(t0 - ago * MIN));
        assert.ok(r.queued, JSON.stringify(r));
      }
      const [A, B, C] = [await convOf("t-a"), await convOf("t-b"), await convOf("t-c")];
      assert.ok(A && B && C, "khách nhắn ⇒ hội thoại có ngay trong hộp thư");
      // Người đã mở cả ba (hết «chưa đọc») ⇒ thứ tự chỉ còn do tin gần nhất.
      await db.update(c).set({ staffSeenAt: new Date() }).where(eq(c.channel, "FANPAGE"));
      assert.deepEqual((await order()).slice(0, 3), [C, B, A], "tin gần nhất lên đầu");

      // 2. Nhân viên trả lời A trên PANCAKE ⇒ A lên đầu, rời «Chờ trả lời», hộp thư đang mở nhận sự kiện.
      const events: string[] = [];
      const off = subscribe((e) => {
        if (e.type === "chat" && e.conversationId) events.push(e.conversationId);
      });
      assert.ok((await order("UNANSWERED")).includes(A), "trước câu trả lời: A đang chờ");
      const staff = await receiveFanpageEvent(ev({ threadId: "t-a", messageId: "page-a-1", text: "Dạ còn ạ, chị lấy mấy kg?", fromPage: true, humanStaff: true }), new Date(t0 - MIN));
      off();
      assert.ok(!staff.queued);
      assert.deepEqual((await order()).slice(0, 3), [A, C, B], "câu nhân viên trên Pancake đẩy hội thoại lên đầu như Pancake");
      assert.ok(!(await order("UNANSWERED")).includes(A), "đã có người trả lời ⇒ rời «Chờ trả lời»");
      assert.ok(events.includes(A), "hộp thư đang mở được báo để làm mới");

      // 3. Webhook TRÙNG (Pancake gửi lại) ⇒ không dòng thứ hai, thứ tự không đổi.
      const before = (await rowsOfThread("t-a")).length;
      await receiveFanpageEvent(ev({ threadId: "t-a", messageId: "page-a-1", text: "Dạ còn ạ, chị lấy mấy kg?", fromPage: true, humanStaff: true }), new Date(t0 - MIN));
      await receiveFanpageEvent(ev({ threadId: "t-a", messageId: "cust-t-a-1" }), new Date(t0 - 30 * MIN));
      assert.equal((await rowsOfThread("t-a")).length, before, "trùng mã tin ⇒ không ghi lại");
      assert.deepEqual((await order()).slice(0, 3), [A, C, B]);

      // 4. Tin TỰ ĐỘNG của page (B) không đẩy hội thoại — Pancake tự gửi không phải ai trả lời.
      await receiveFanpageEvent(ev({ threadId: "t-b", messageId: "page-b-auto", text: "Cảm ơn bạn đã nhắn tin, shop sẽ phản hồi sớm nhất!", fromPage: true, humanStaff: false, automated: true }), new Date(t0));
      assert.deepEqual((await order()).slice(0, 3), [A, C, B], "tin tự động không đổi thứ tự");

      // 5. Bot trả lời C (dòng BOT_SENT + mốc bot) rồi Pancake vọng lại đúng câu ấy ⇒ không dòng thứ hai; C lên đầu theo mốc bot.
      const botAt = new Date();
      await db.insert(t).values({ pageId: PAGE, threadId: "t-c", messageId: "bot-out:c-1", text: "Dạ shop còn hàng ạ", status: "DONE", processedAt: botAt, note: "BOT_SENT" });
      await db.update(c).set({ lastBotAt: botAt }).where(eq(c.id, C));
      const echo = await receiveFanpageEvent(ev({ threadId: "t-c", messageId: "pancake-echo-c-1", text: "Dạ shop còn hàng ạ", fromPage: true, humanStaff: false }), new Date());
      assert.ok(!echo.queued);
      assert.equal((await db.select({ id: t.id }).from(t).where(eq(t.messageId, "pancake-echo-c-1"))).length, 0, "tiếng vọng câu bot không thành dòng thứ hai");
      assert.deepEqual((await order()).slice(0, 3), [C, A, B], "câu bot mới nhất ⇒ C lên đầu");

      // 6. Webhook CHẬM / SAI THỨ TỰ: tin cũ của B (40 phút trước) tới sau ⇒ ghi vào sổ, mốc khách của B không lùi.
      const [bBefore] = await db.select({ at: c.lastCustomerAt }).from(c).where(eq(c.id, B));
      await receiveFanpageEvent(ev({ threadId: "t-b", messageId: "cust-t-b-0", text: "Tin cũ tới muộn" }), new Date(t0 - 40 * MIN));
      const [bAfter] = await db.select({ at: c.lastCustomerAt }).from(c).where(eq(c.id, B));
      assert.equal(bAfter.at?.getTime(), bBefore.at?.getTime(), "mốc không lùi khi tin cũ tới sau");
      assert.equal((await rowsOfThread("t-b")).filter(Boolean).length >= 3, true, "tin tới muộn vẫn vào sổ (không mất)");

      // 7. Khách nhắn lại A sau câu nhân viên ⇒ «Chờ trả lời» + «Chưa đọc», đứng đầu «Tất cả».
      await receiveFanpageEvent(ev({ threadId: "t-a", messageId: "cust-t-a-2", text: "Lấy 2kg nhé" }), new Date());
      assert.ok((await order("UNANSWERED")).includes(A));
      assert.ok((await order("UNREAD")).includes(A));
      assert.equal((await order())[0], A, "chưa đọc lên đầu");
    });
    console.log("  ✓ đạt");
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
}
