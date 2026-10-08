/**
 * ═══════════ SỰ KIỆN CHUYỂN ĐỔI GỬI META KHI CHỐT ĐƠN (0236 · lib/marketing/meta-capi.ts) ═══════════
 *
 *  1. Thuần: PSID (sender_id → mã hội thoại Pancake `<page>_<psid>` chỉ khi có tin hộp thư → mã Messenger trực tiếp), sự kiện
 *     Purchase đúng hợp đồng business_messaging, phân loại đơn (không từ chat / không Messenger / không PSID / huỷ / quá 7
 *     ngày), đọc phản hồi Meta (đạt · token hỏng · lỗi tạm), lùi dần có trần.
 *  2. TỔ CHỨC THẬT `capi-hslc`, Graph GIẢ: chưa bật ⇒ 0 request, không sync_runs; lưu → kiểm tra (chỉ GET dataset) → bật;
 *     đơn chốt Messenger ⇒ đúng MỘT POST mỗi đơn kể cả chạy lại; đơn Zalo / không chat / huỷ ⇒ SKIPPED kèm lý do; Meta lỗi
 *     ⇒ FAILED, không gửi lại trước hạn, tới hạn thì gửi được; token hỏng ⇒ dừng lượt; nhà ⇒ HOME_ORG.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { buildPurchaseEvent, capiNextAttempt, capiVerdict, classifyOrderForCapi, metaCapiEventId, psidOf } from "@/lib/constants/meta-capi";
import { emitDomainEvent } from "@/lib/events/emit";
import { runOrgMetaCapi } from "@/lib/marketing/meta-capi";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { runJob } from "@/lib/sync/jobs";

const ORG = "capi-hslc";
const TOKEN = "EAAFakeCapiSystemUserTokenForTestsOnly0123456789abcXYZ";
const DATASET = "987654321012345";
const PAGE = "107401132450005";
const ORG_SECRETS_KEY = "khoa-kiem-thu-meta-capi-org-0123456789abcdefghijklmnopqrstuvwxyz";

export function testMetaCapiPure() {
  // PSID: sender_id thắng; mã hội thoại Pancake `<page>_<psid>` chỉ khi có tin hộp thư; Messenger trực tiếp = mã hội thoại.
  assert.equal(psidOf({ pageId: PAGE, threadId: `${PAGE}_111`, senderId: "24812345678901234", hasInboxMessage: true }), "24812345678901234");
  assert.equal(psidOf({ pageId: PAGE, threadId: `${PAGE}_24812345678901234`, senderId: null, hasInboxMessage: true }), "24812345678901234");
  assert.equal(psidOf({ pageId: PAGE, threadId: `${PAGE}_24812345678901234`, senderId: null, hasInboxMessage: false }), null, "chỉ bình luận ⇒ không đoán PSID");
  assert.equal(psidOf({ pageId: PAGE, threadId: "24812345678901234", senderId: "", hasInboxMessage: true }), "24812345678901234");
  assert.equal(psidOf({ pageId: PAGE, threadId: "abc_def", senderId: PAGE, hasInboxMessage: true }), null, "sender = chính page / mã lạ ⇒ null");

  const at = new Date("2026-10-08T05:00:00Z");
  const ev = buildPurchaseEvent({ orderId: "erp-x1", eventTime: at, pageId: PAGE, psid: "24812345678901234", valueVnd: 280_000, orderCode: "#ABC123" });
  assert.deepEqual(ev, {
    event_name: "Purchase",
    event_time: Math.floor(at.getTime() / 1000),
    event_id: "erp-order-erp-x1",
    action_source: "business_messaging",
    messaging_channel: "messenger",
    user_data: { page_id: PAGE, page_scoped_user_id: "24812345678901234" },
    custom_data: { currency: "VND", value: 280_000, order_id: "#ABC123" },
  });
  assert.equal(metaCapiEventId("erp-x1"), ev.event_id, "event_id cố định theo đơn — Meta khử trùng lượt gửi lại");
  assert.throws(() => buildPurchaseEvent({ orderId: "x", eventTime: at, pageId: PAGE, psid: "1", valueVnd: 1 }), /PSID/);
  assert.throws(() => buildPurchaseEvent({ orderId: "x", eventTime: at, pageId: PAGE, psid: "24812345678901234", valueVnd: 0 }), /giá trị/);

  const base = { exists: true, stage: "CONFIRMED", valueVnd: 280_000, channel: "FANPAGE", pageId: PAGE, psid: "24812345678901234", eventTime: at, now: new Date(at.getTime() + 60_000) };
  assert.deepEqual(classifyOrderForCapi(base), { status: "PENDING" });
  assert.deepEqual(classifyOrderForCapi({ ...base, exists: false }), { status: "SKIPPED", reason: "ORDER_MISSING" });
  assert.deepEqual(classifyOrderForCapi({ ...base, channel: null }), { status: "SKIPPED", reason: "NOT_FROM_CHAT" });
  assert.deepEqual(classifyOrderForCapi({ ...base, channel: "ZALO" }), { status: "SKIPPED", reason: "NOT_MESSENGER" });
  assert.deepEqual(classifyOrderForCapi({ ...base, pageId: "igo_123" }), { status: "SKIPPED", reason: "NOT_MESSENGER" });
  assert.deepEqual(classifyOrderForCapi({ ...base, psid: null }), { status: "SKIPPED", reason: "NO_PSID" });
  assert.deepEqual(classifyOrderForCapi({ ...base, valueVnd: 0 }), { status: "SKIPPED", reason: "NO_VALUE" });
  assert.deepEqual(classifyOrderForCapi({ ...base, stage: "CANCELLED" }), { status: "SKIPPED", reason: "CANCELLED_BEFORE_SEND" });
  assert.deepEqual(classifyOrderForCapi({ ...base, now: new Date(at.getTime() + 7 * 86_400_000) }), { status: "SKIPPED", reason: "TOO_OLD" });

  assert.deepEqual(capiVerdict(200, { events_received: 1, messages: [], fbtrace_id: "Atr1" }), { ok: true, received: 1, fbtraceId: "Atr1" });
  const bad = capiVerdict(400, { error: { code: 190, message: "Invalid OAuth access token", fbtrace_id: "Atr2" } });
  assert.ok(!bad.ok && bad.auth && !bad.retryable && bad.fbtraceId === "Atr2");
  const tam = capiVerdict(500, { error: { code: 2, message: "Service temporarily unavailable" } });
  assert.ok(!tam.ok && !tam.auth && tam.retryable);
  const rong = capiVerdict(200, { events_received: 0 });
  assert.ok(!rong.ok && rong.retryable, "200 mà không nhận sự kiện nào ⇒ chưa phải đã gửi");

  const t0 = new Date("2026-10-08T00:00:00Z");
  assert.equal(capiNextAttempt(1, t0).getTime() - t0.getTime(), 10 * 60_000);
  assert.equal(capiNextAttempt(3, t0).getTime() - t0.getTime(), 40 * 60_000);
  assert.equal(capiNextAttempt(20, t0).getTime() - t0.getTime(), 6 * 3_600_000, "trần 6 giờ");
}

async function cleanupOrg() {
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

type Post = { url: string; auth: string; body: { data: Record<string, unknown>[] } };

/** Graph giả: GET dataset; POST /events theo `mode` (đạt / lỗi tạm / token hỏng). Request lạ ⇒ ném (bài kiểm không gọi mạng thật). */
function fakeGraph(posts: Post[], gets: string[], mode: { value: "OK" | "TEMP" | "AUTH" }): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    if (url.hostname !== "graph.facebook.com") throw new Error(`request lạ: ${url.href}`);
    if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith(`/${DATASET}`)) {
      gets.push(url.href);
      return auth === `Bearer ${TOKEN}` ? json({ id: DATASET, name: "HSLC dataset" }) : json({ error: { code: 190, message: "bad token" } }, 400);
    }
    if (init?.method === "POST" && url.pathname.endsWith(`/${DATASET}/events`)) {
      posts.push({ url: url.href, auth, body: JSON.parse(String(init.body)) as Post["body"] });
      if (mode.value === "TEMP") return json({ error: { code: 2, message: "Service temporarily unavailable", fbtrace_id: "T" } }, 500);
      if (mode.value === "AUTH") return json({ error: { code: 190, message: "Error validating access token", fbtrace_id: "A" } }, 400);
      return json({ events_received: 1, messages: [], fbtrace_id: "OK1" });
    }
    throw new Error(`request lạ: ${init?.method ?? "GET"} ${url.href}`);
  }) as typeof fetch;
}

export async function testMetaCapiDb() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử CAPI", plan: "standard", modules: ["customers", "products", "orders", "marketing"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "CapiThu@12345" }, source: "TEST", actor: null });
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedFetch = globalThis.fetch;
  const posts: Post[] = [];
  const gets: string[] = [];
  const mode: { value: "OK" | "TEMP" | "AUTH" } = { value: "OK" };
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  globalThis.fetch = fakeGraph(posts, gets, mode);
  try {
    const home = await getHomeOrganization();
    const nha = (await runJob("meta-capi-org", { trigger: "CRON", actor: "capi-test", org: home.code })) as { skipped?: string };
    assert.equal(nha.skipped, "HOME_ORG", JSON.stringify(nha));
    const bo = (await runJob("meta-capi-org", { trigger: "CRON", actor: "capi-test", org: ORG })) as { skipped?: string };
    assert.equal(bo.skipped, "NO_ACTIVE_CONNECTION", JSON.stringify(bo));
    assert.equal(posts.length + gets.length, 0, "chưa bật ⇒ 0 request");

    await withOrganization(ORG, async () => {
      const db = await getDb();
      assert.equal((await db.select().from(schema.syncRuns)).length, 0, "bỏ qua ⇒ không ghi sync_runs");
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử CAPI", isHome: false } };

      // ── Lưu → kiểm tra (chỉ GET dataset, không POST sự kiện thử) → bật ──
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "meta-capi-org", settings: { datasetId: DATASET }, secrets: { accessToken: TOKEN } })));
      assert.ok("error" in (await setConnectionStatus(admin, "meta-capi-org", "ACTIVE")), "chưa kiểm tra ⇒ không bật được");
      const kiem = await testOrgConnection(admin, "meta-capi-org", { tester: { fetch: globalThis.fetch } });
      assert.ok("ok" in kiem && kiem.ok, JSON.stringify(kiem));
      assert.equal(posts.length, 0, "kiểm tra không gửi sự kiện thử");
      assert.ok(gets.length >= 1);
      assert.ok("ok" in (await setConnectionStatus(admin, "meta-capi-org", "ACTIVE")));

      // ── Bật mà chưa đơn nào chốt ⇒ không việc, không sync_runs ──
      const rong = await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" });
      assert.equal((rong as { skipped?: string }).skipped, "NOTHING_TO_DO", JSON.stringify(rong));

      // ── Dữ liệu: hội thoại Messenger (sender_id) · Messenger cũ (PSID trong mã hội thoại) · Zalo · đơn POS · đơn huỷ · đơn cũ ──
      const c = schema.salesChatConversations;
      const conv = async (channel: string, thread: string) => (await db.insert(c).values({ channel, status: "OPEN", visitorKey: channel === "FANPAGE" ? fanpageVisitorKey(PAGE, thread) : `zalo-${thread}`, pageId: PAGE, threadId: thread, lastCustomerAt: new Date() }).returning({ id: c.id }))[0].id;
      const cA = await conv("FANPAGE", "t-capi-a");
      const cD = await conv("FANPAGE", `${PAGE}_24800000000000002`);
      const cB = await conv("ZALO", "t-capi-b");
      const cG = await conv("FANPAGE", "t-capi-g");
      const t = schema.salesChatInbound;
      await db.insert(t).values([
        { pageId: PAGE, threadId: "t-capi-a", messageId: "m-capi-a", text: "chốt 1kg", status: "DONE", kind: "INBOX", senderId: "24800000000000001" },
        { pageId: PAGE, threadId: `${PAGE}_24800000000000002`, messageId: "m-capi-d", text: "lấy 2kg", status: "DONE", kind: "INBOX" },
        { pageId: PAGE, threadId: "t-capi-g", messageId: "m-capi-g", text: "ok em", status: "DONE", kind: "INBOX", senderId: "24800000000000007" },
      ]);
      const now = new Date();
      const ord = (id: string, value: number, conversationId: string | null, stage: "CONFIRMED" | "CANCELLED" = "CONFIRMED") => ({ id, stage, status: 1, billFullName: "Khách thử", totalPrice: value, totalPriceAfterDiscount: value, insertedAt: now, origin: "AI_AGENT", salesConversationId: conversationId });
      await db.insert(schema.orders).values([
        ord("erp-capi-a", 280_000, cA),
        ord("erp-capi-d", 540_000, cD),
        ord("erp-capi-b", 400_000, cB),
        ord("erp-capi-c", 150_000, null),
        ord("erp-capi-e", 280_000, cA, "CANCELLED"),
        ord("erp-capi-g", 120_000, cG),
        ord("erp-capi-old", 280_000, cA),
      ]);
      const confirm = (orderId: string, at: Date) => emitDomainEvent(db, { name: "order.confirmed", subjectType: "order", subjectId: orderId, payload: { orderId }, actorKind: "AGENT", source: "tests/meta-capi", dedupeKey: `order.confirmed:${orderId}`, occurredAt: at });
      for (const id of ["erp-capi-a", "erp-capi-d", "erp-capi-b", "erp-capi-c", "erp-capi-e"]) await confirm(id, new Date(now.getTime() - 5 * 60_000));
      await confirm("erp-capi-old", new Date(now.getTime() - 8 * 86_400_000));

      // ── Lượt 1: gửi A và D, ghi lý do cho B / C / E, bỏ qua đơn quá 7 ngày ──
      const r1 = await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" }, { now: () => now });
      assert.ok("run" in r1, JSON.stringify(r1));
      assert.equal(posts.length, 2, `đúng hai sự kiện: ${JSON.stringify(posts.map((p) => p.body.data[0].event_id))}`);
      for (const p of posts) {
        assert.ok(p.url.endsWith(`/${DATASET}/events`) && p.auth === `Bearer ${TOKEN}`, "gửi vào đúng dataset, token ở header (không ở URL)");
        assert.ok(!p.url.includes(TOKEN));
        assert.equal(p.body.data.length, 1);
        assert.equal(p.body.data[0].action_source, "business_messaging");
      }
      const byId = new Map(posts.map((p) => [String(p.body.data[0].event_id), p.body.data[0]]));
      assert.deepEqual(byId.get(metaCapiEventId("erp-capi-a"))?.user_data, { page_id: PAGE, page_scoped_user_id: "24800000000000001" });
      assert.deepEqual(byId.get(metaCapiEventId("erp-capi-d"))?.user_data, { page_id: PAGE, page_scoped_user_id: "24800000000000002" }, "PSID lấy từ mã hội thoại Pancake khi chưa có sender_id");
      assert.deepEqual((byId.get(metaCapiEventId("erp-capi-d"))?.custom_data as { value?: number }).value, 540_000);
      const m = schema.metaConversionEvents;
      const rows = new Map((await db.select().from(m)).map((r) => [r.orderId, r]));
      assert.equal(rows.get("erp-capi-a")?.status, "SENT");
      assert.equal(rows.get("erp-capi-d")?.status, "SENT");
      assert.deepEqual([rows.get("erp-capi-b")?.status, rows.get("erp-capi-b")?.skipReason], ["SKIPPED", "NOT_MESSENGER"]);
      assert.deepEqual([rows.get("erp-capi-c")?.status, rows.get("erp-capi-c")?.skipReason], ["SKIPPED", "NOT_FROM_CHAT"]);
      assert.deepEqual([rows.get("erp-capi-e")?.status, rows.get("erp-capi-e")?.skipReason], ["SKIPPED", "CANCELLED_BEFORE_SEND"]);
      assert.ok(!rows.has("erp-capi-old"), "quá 7 ngày ⇒ không xếp hàng");
      const runs1 = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "capi_purchase"));
      assert.equal(runs1.length, 1);
      assert.equal(runs1[0].status, "SUCCESS");

      // ── Chạy lại ⇒ không gửi lần hai ──
      const r2 = await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" }, { now: () => now });
      assert.equal((r2 as { skipped?: string }).skipped, "NOTHING_TO_DO", JSON.stringify(r2));
      assert.equal(posts.length, 2, "chạy lại ⇒ 0 POST mới");

      // ── Meta lỗi tạm ⇒ FAILED, không gửi lại trước hạn; tới hạn thì gửi được ──
      await confirm("erp-capi-g", new Date(now.getTime() - 60_000));
      mode.value = "TEMP";
      await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" }, { now: () => now });
      assert.equal(posts.length, 3);
      const [g1] = await db.select().from(m).where(eq(m.orderId, "erp-capi-g"));
      assert.ok(g1.status === "FAILED" && g1.attempts === 1 && g1.nextAttemptAt && g1.nextAttemptAt > now, JSON.stringify(g1));
      mode.value = "OK";
      await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" }, { now: () => new Date(now.getTime() + 60_000) });
      assert.equal(posts.length, 3, "chưa tới hạn ⇒ không gửi lại");
      await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" }, { now: () => new Date(now.getTime() + 11 * 60_000) });
      assert.equal(posts.length, 4);
      const [g2] = await db.select().from(m).where(eq(m.orderId, "erp-capi-g"));
      assert.equal(g2.status, "SENT");
      assert.equal(posts[3].body.data[0].event_id, posts[2].body.data[0].event_id, "gửi lại mang CÙNG event_id");

      // ── Token hỏng ⇒ FAILED, lượt dừng ở sự kiện đầu ──
      await db.insert(schema.orders).values([ord("erp-capi-h1", 100_000, cA), ord("erp-capi-h2", 100_000, cA)]);
      await confirm("erp-capi-h1", new Date(now.getTime() - 30_000));
      await confirm("erp-capi-h2", new Date(now.getTime() - 20_000));
      mode.value = "AUTH";
      await runOrgMetaCapi({ trigger: "CRON", actor: "capi-test" }, { now: () => new Date(now.getTime() + 12 * 60_000) });
      assert.equal(posts.length, 5, "token hỏng ⇒ dừng sau lượt gọi đầu, không gõ tiếp");
      const h = new Map((await db.select().from(m)).map((r) => [r.orderId, r]));
      assert.equal(h.get("erp-capi-h1")?.status, "FAILED");
      assert.ok(!(h.get("erp-capi-h1")?.lastError ?? "").includes(TOKEN), "lỗi không mang token");
      assert.equal(h.get("erp-capi-h2")?.status, "PENDING", "đơn sau giữ nguyên chờ lượt sau");
      const last = (await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "capi_purchase"))).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      assert.equal(last.status, "PARTIAL");
    });
    console.log("  ✓ sự kiện Meta khi chốt đơn: chưa bật ⇒ 0 request · kiểm tra chỉ GET dataset · đơn Messenger ⇒ đúng một Purchase (PSID từ sender_id hoặc mã hội thoại) · Zalo / POS / huỷ / quá 7 ngày có lý do · chạy lại không gửi lần hai · lỗi tạm thử lại cùng event_id · token hỏng dừng lượt · nhà bỏ qua");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
}
