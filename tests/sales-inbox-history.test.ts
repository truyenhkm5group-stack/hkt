/**
 * ═══════════ NHẬP ĐỦ LỊCH SỬ HỘI THOẠI VÀO HỘP THƯ (M8 · 0221 · lib/sales-chatbot/history.ts) ═══════════
 *
 * Khoá (Pancake GIẢ — không gọi mạng thật, luật 65; mốc thời gian dựng theo đồng hồ THẬT, luật 50):
 *  · Phần thuần: lập kế hoạch tin (mốc ISO không múi giờ là UTC · tin quá mới không nhập · thu hồi / ghi chú tự động / bình luận bỏ ·
 *    tin page chỉ ảnh «[Ảnh]» · tin khách không chữ ⇒ dòng giữ chỗ), SĐT chuẩn hoá, ảnh đại diện mang khoá KHÔNG lưu, tiếng vọng.
 *  · Phân trang danh sách (`last_conversation_id`) + phân trang tin (`current_count`); dừng giữa chừng ⇒ lượt sau ĐỌC TIẾP đúng trang
 *    tin của hội thoại đang dở (không đọc lại từ đầu).
 *  · Ghi đúng mô hình: tin khách `HISTORY`, tin page `PAGE_REPLY`, `DONE`, `imported_at`, `created_at` = mốc THẬT; hội thoại tạo bằng
 *    `conversationFor`, đánh dấu `system:history-import`, SĐT ở `state.pancakePhones`.
 *  · Idempotent: chạy lại từ đầu ⇒ 0 tin mới; tin webhook đã có ⇒ bỏ qua, không đổi; tiếng vọng tin bot ⇒ không thành tin page thứ hai.
 *  · Không kích hoạt gì: không POST nào tới Pancake, không tin PENDING, không sự kiện, lịch sử bot không nhận tin cũ, máy ghi đơn không
 *    coi tin cũ là ứng viên, số «bot đã xử lý» không đếm tin cũ, số «hội thoại mới» của nền tảng không đếm hội thoại do lượt nhập tạo.
 *  · Hộp thư: hội thoại cũ KHÔNG chưa đọc, KHÔNG chờ trả lời, xếp theo mốc tin thật (không nhảy lên đầu); tin SỐNG chưa trả lời vẫn chờ.
 *  · Quét lại hội thoại ERP trượt khỏi danh sách; 429 ⇒ nghỉ rồi đọc tiếp; «Dừng» ⇒ lượt thôi ngay; quyền ai_sales:manage.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { readOrgUsage } from "@/lib/platform/saas-ledger";
import { fanpageInboundCounts, fanpageVisitorKey, MEDIA_ONLY_TEXT, mirrorFanpageContext, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { cancelInboxHistory, isOwnEcho, loadHistoryRun, pancakeAvatarOf, pancakePhonesOf, pendingThreadOf, planHistoryMessages, runHistoryTick, startInboxHistory } from "@/lib/sales-chatbot/history";
import { HISTORY_CREATED_BY, HISTORY_NOTE, HISTORY_SETTING_KEY, parseHistoryRun } from "@/lib/sales-chatbot/history-shared";
import { listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { runFanpageOrderSync } from "@/lib/sales-chatbot/order-sync";
import { ORDER_SYNC_SETTING_KEY } from "@/lib/sales-chatbot/order-sync-shared";
import { setSettingJson } from "@/lib/settings";

const ORG = "hop-thu-lich-su";
const PAGE = "5566778899";
const TOKEN = "pancake_page_token_lichsu_0123456789abc";
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** ISO KHÔNG múi giờ (đúng kiểu Pancake trả) — nghĩa là UTC. */
const naive = (ms: number) => new Date(ms).toISOString().replace("Z", "");

function testPure() {
  const now = Date.now();
  const raw = [
    { id: "a1", from: { id: "psid-1", name: "Chị Lan" }, message: "<div>Cho mình hỏi giá<br>chả cá</div>", inserted_at: naive(now - 3 * D) },
    { id: "a2", from: { id: PAGE, name: "Shop" }, message: "Dạ 180k/kg ạ", inserted_at: naive(now - 3 * D + MIN) },
    { id: "a3", from: { id: PAGE }, message: "Đã đặt giai đoạn của khách hàng: Đủ tiêu chuẩn", inserted_at: naive(now - 3 * D + 2 * MIN) },
    { id: "a4", from: { id: "psid-1" }, message: "", inserted_at: naive(now - 3 * D + 3 * MIN) },
    { id: "a5", from: { id: PAGE, admin_id: "u1" }, message: "", attachments: [{ type: "photo", url: "https://content.pancake.vn/a.jpg" }], inserted_at: naive(now - 3 * D + 4 * MIN) },
    { id: "a6", from: { id: "psid-1" }, message: "đã thu hồi", is_removed: true, inserted_at: naive(now - 3 * D + 5 * MIN) },
    { id: "a7", from: { id: "psid-1" }, message: "còn hàng không", inserted_at: naive(now - 10 * MIN) },
    { id: "a8", from: { id: PAGE }, message: "", inserted_at: naive(now - 3 * D + 6 * MIN) },
    { id: "a9", type: "COMMENT", from: { id: "psid-1" }, message: "giá?", inserted_at: naive(now - 3 * D + 7 * MIN) },
    { id: "a1", from: { id: "psid-1" }, message: "trùng mã", inserted_at: naive(now - 3 * D) },
  ];
  const p = planHistoryMessages(raw, PAGE, { nowMs: now, freshMs: 60 * MIN, fallbackName: "Khách X" });
  assert.deepEqual(p.rows.map((r) => `${r.messageId}:${r.side}`), ["a1:CUSTOMER", "a2:PAGE", "a4:CUSTOMER", "a5:PAGE"], JSON.stringify(p.rows));
  assert.equal(p.rows[0].text, "Cho mình hỏi giá\nchả cá", "chữ HTML của Pancake ⇒ chữ thường");
  assert.equal(p.rows[0].at.getTime(), new Date(naive(now - 3 * D) + "Z").getTime(), "mốc ISO không múi giờ là UTC");
  assert.equal(p.rows[0].customerName, "Chị Lan");
  assert.equal(p.rows[2].text, MEDIA_ONLY_TEXT, "tin khách không chữ ⇒ dòng giữ chỗ cho người mở kênh xem");
  assert.equal(p.rows[2].customerName, "Khách X", "thiếu tên ở tin ⇒ tên của hội thoại");
  assert.ok(p.rows[3].text === "[Ảnh]" && p.rows[3].imageUrls.length === 1, "tin page chỉ ảnh ⇒ «[Ảnh]»");
  assert.equal(p.fresh, 1, "tin quá mới không nhập — việc của webhook / bot");
  assert.equal(p.skipped, 5, "ghi chú tự động · thu hồi · page không chữ · bình luận · trùng mã ⇒ bỏ");

  assert.deepEqual(pancakePhonesOf({ recent_phone_numbers: [{ phone_number: "+84912345678" }, { phone_number: "0912 345 678" }, "84987654321", { phone_number: "abc" }] }), ["0912345678", "0987654321"]);
  assert.equal(pancakeAvatarOf({ from: { avatar_url: `https://pages.fm/api/v1/pages/${PAGE}/avatar/1?page_access_token=${TOKEN}` } }), null, "ảnh đại diện mang khoá KHÔNG lưu");
  assert.equal(pancakeAvatarOf({ customers: [{ avatar: "https://cdn.example.vn/u/1.jpg" }] }), "https://cdn.example.vn/u/1.jpg");
  assert.equal(pendingThreadOf({ id: "x", type: "COMMENT" }), null, "bình luận không phải hộp thư");
  assert.equal(pendingThreadOf({ id: "y", from: { name: "Anh Ba" }, updated_at: naive(now) })?.name, "Anh Ba");

  const at = new Date(now - D);
  const echo = { messageId: "e1", side: "PAGE" as const, text: "Dạ  shop chào   chị ạ", at, imageUrls: [], customerName: null };
  assert.ok(isOwnEcho(echo, [{ text: "Dạ shop chào chị ạ", at: new Date(at.getTime() - 2 * MIN) }]), "cùng chữ trong 10 phút ⇒ tiếng vọng của tin bot");
  assert.ok(!isOwnEcho(echo, [{ text: "Dạ shop chào chị ạ", at: new Date(at.getTime() - 30 * MIN) }]));
  assert.ok(!isOwnEcho({ ...echo, side: "CUSTOMER" }, [{ text: "Dạ shop chào chị ạ", at }]), "tin khách không bao giờ là tiếng vọng");

  assert.equal(parseHistoryRun("hỏng").status, "IDLE");
  const pr = parseHistoryRun({ status: "RUNNING", pending: [{ id: "t1", phones: ["0912345678", 5] }, { nope: 1 }], counts: { messages: 7, errors: -2 }, thread: { id: "t1", count: 25 } });
  assert.ok(pr.status === "RUNNING" && pr.pending.length === 1 && pr.pending[0].phones.length === 1 && pr.counts.messages === 7 && pr.counts.errors === 0 && pr.thread?.count === 25);
}

type Msg = Record<string, unknown>;

/** Pancake GIẢ: danh sách hội thoại theo con trỏ + tin theo `current_count`. Ghi mọi lời gọi; 429 tiêm theo hội thoại. */
function fakePancake(lists: Record<string, Msg[]>, threads: Record<string, Msg[][]>, opts: { rateLimitOnce?: Set<string>; threadBody?: Record<string, Msg> } = {}) {
  const calls: { url: string; method: string }[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method !== "GET") return json({ success: true, id: "khong-duoc-goi" });
    const u = new URL(url);
    if (/\/v2\/pages\/[^/]+\/conversations$/.test(u.pathname)) {
      if (u.searchParams.get("page_access_token") !== TOKEN) return json({ success: false, message: "token sai" }, 401);
      return json({ success: true, conversations: lists[u.searchParams.get("last_conversation_id") ?? ""] ?? [] });
    }
    const m = /\/conversations\/([^/]+)\/messages$/.exec(u.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (opts.rateLimitOnce?.has(id)) {
        opts.rateLimitOnce.delete(id);
        return json({ success: false, message: "too many" }, 429, { "retry-after": "90" });
      }
      const pages = threads[id];
      if (!pages) return json({ success: false, message: "không có hội thoại" }, 404);
      const count = Number(u.searchParams.get("current_count") ?? 0);
      let seen = 0;
      let page: Msg[] = [];
      for (const p of pages) {
        if (seen === count) {
          page = p;
          break;
        }
        seen += p.length;
      }
      return json({ success: true, messages: page, ...(opts.threadBody?.[id] ?? {}) });
    }
    return json({ success: true });
  }) as typeof fetch;
  return { fetch: f, calls, posts: () => calls.filter((c) => c.method !== "GET") };
}

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

export async function testSalesInboxHistory() {
  testPure();
  await cleanup();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-lich-su-hop-thu-0123456789abcdefghijklmnopqrstu";
  try {
    await provisionOrganization({ code: ORG, name: "Shop lịch sử", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "LichSu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { email: u.email, permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] };
      const admin = { ...base, id: u.id, name: u.name, role: "ADMIN" } as unknown as SessionUser;
      const cs = { ...base, id: "cs-lich-su", name: "CSKH", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;

      const t = schema.salesChatInbound;
      const c = schema.salesChatConversations;
      const now = Date.now();
      // ── Dữ liệu SỐNG có sẵn: hội thoại webhook «c-live» với một tin khách 2 giờ trước CHƯA ai trả lời + một tin bot đã gửi ──
      const liveAt = new Date(now - 2 * H);
      const [live] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, "c-live"), pageId: PAGE, threadId: "c-live", lastCustomerAt: liveAt }).returning({ id: c.id, updatedAt: c.updatedAt });
      await db.insert(t).values([
        { pageId: PAGE, threadId: "c-live", messageId: "live-1", text: "Còn chả mực không shop?", customerName: "Anh Tú", status: "DONE", processedAt: liveAt, createdAt: liveAt },
        { pageId: PAGE, threadId: "c-live", messageId: "bot-out:old-1", text: "Dạ shop chào anh ạ", status: "DONE", note: "BOT_SENT", createdAt: new Date(now - 5 * D) },
      ]);
      // Hội thoại ERP mà danh sách Pancake KHÔNG liệt kê (khách nhắn giữa lúc nhập ⇒ nhảy lên đầu, sau con trỏ) — phần quét lại bắt.
      await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, "c-moved"), pageId: PAGE, threadId: "c-moved", createdAt: new Date(now - 2 * D) });

      const oldAt = now - 3 * H; // trong 24 giờ — máy ghi đơn sẽ thấy nếu không loại dòng lịch sử
      const lists: Record<string, Msg[]> = {
        "": [
          { id: "c-old", type: "INBOX", updated_at: naive(oldAt + 2 * MIN), from: { name: "Chị Mai" }, recent_phone_numbers: [{ phone_number: "+84912345678" }] },
          { id: "c-live", type: "INBOX", updated_at: naive(now - 10 * MIN), from: { name: "Anh Tú" } },
          { id: "c-cmt", type: "COMMENT", updated_at: naive(now - 3 * D) },
        ],
        // Con trỏ = mã hội thoại CUỐI của trang trước (kể cả bình luận đã lọc).
        "c-cmt": [{ id: "c-new", type: "INBOX", updated_at: naive(now - 20 * D), customers: [{ name: "Cô Hằng" }] }],
        "c-new": [],
      };
      const threads: Record<string, Msg[][]> = {
        "c-old": [
          [
            { id: "o3", from: { id: "psid-mai", name: "Chị Mai" }, message: "Lấy chị 2kg chả cá giao Q7 nhé, 0912345678", inserted_at: naive(oldAt) },
            { id: "o4", from: { id: PAGE, admin_id: "staff-1" }, message: "Dạ em lên đơn ạ", inserted_at: naive(oldAt + 2 * MIN) },
          ],
          [
            { id: "o1", from: { id: "psid-mai", name: "Chị Mai" }, message: "Shop ơi", inserted_at: naive(now - 10 * D) },
            { id: "o2", from: { id: PAGE }, message: "Đã đặt giai đoạn của khách hàng: Đủ tiêu chuẩn", inserted_at: naive(now - 10 * D + MIN) },
          ],
          [],
        ],
        "c-live": [
          [
            { id: "live-fresh", from: { id: "psid-tu", name: "Anh Tú" }, message: "Alo shop", inserted_at: naive(now - 10 * MIN) },
            { id: "live-1", from: { id: "psid-tu", name: "Anh Tú" }, message: "Còn chả mực không shop?", inserted_at: naive(liveAt.getTime()) },
            { id: "pancake-bot-old", from: { id: PAGE }, message: "Dạ shop chào anh ạ", inserted_at: naive(now - 5 * D + MIN) },
            { id: "h-1", from: { id: "psid-tu", name: "Anh Tú" }, message: "Hôm trước mua ngon lắm", inserted_at: naive(now - 6 * D) },
          ],
          [],
        ],
        "c-new": [[{ id: "n1", from: { id: "psid-hang", name: "Cô Hằng" }, message: "Cho cô hỏi giá chả mực", inserted_at: naive(now - 20 * D) }], []],
        "c-moved": [[{ id: "mv1", from: { id: "psid-moved", name: "Bác Tư" }, message: "Tháng trước bác mua rồi", inserted_at: naive(now - 30 * D) }], []],
      };
      const rate = new Set<string>(["c-new"]);
      const pancake = fakePancake(lists, threads, { rateLimitOnce: rate, threadBody: { "c-old": { conv_phone_numbers: ["0987654321"] } } });

      const saved = await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: TOKEN } });
      assert.ok("ok" in saved, JSON.stringify(saved));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      pancake.calls.length = 0;

      // ── Quyền ──
      assert.ok("error" in (await startInboxHistory(cs, {})), "chỉ ai_sales:manage mới bắt đầu được");
      const idle = await runHistoryTick({ fetch: pancake.fetch, sleep: async () => {} });
      assert.ok(idle.status === "IDLE" && idle.requests === 0, "chưa bấm ⇒ không gọi Pancake");
      const st = await startInboxHistory(admin, {});
      assert.ok("ok" in st, JSON.stringify(st));
      assert.ok("error" in (await startInboxHistory(admin, {})), "đang chạy ⇒ không mở lượt thứ hai");

      // ── Lượt 1: dừng giữa hội thoại c-old (trần 2 lời gọi: danh sách + trang tin đầu) ──
      const deps = { fetch: pancake.fetch, sleep: async () => {} };
      const t1 = await runHistoryTick({ ...deps, requestsPerTick: 2 });
      assert.ok(t1.status === "RUNNING" && t1.requests === 2 && t1.inserted === 2, JSON.stringify(t1));
      const r1 = await loadHistoryRun();
      assert.ok(r1.thread?.id === "c-old" && r1.thread.count === 2 && r1.listCursor === "c-cmt" && r1.pending.length === 2, `con trỏ lưu được: ${JSON.stringify({ th: r1.thread, cur: r1.listCursor, p: r1.pending.map((p) => p.id) })}`);
      assert.ok(r1.pending.every((p) => p.id !== "c-cmt"), "bình luận không vào hàng đọc");

      // ── «Tiến trình khởi động lại»: lượt mới đọc TIẾP trang 2 của c-old, không đọc lại danh sách / trang 1 ──
      const before2 = pancake.calls.length;
      const t2 = await runHistoryTick({ ...deps, requestsPerTick: 1 });
      assert.equal(t2.requests, 1);
      assert.ok(pancake.calls[before2].url.includes("/conversations/c-old/messages") && pancake.calls[before2].url.includes("current_count=2"), pancake.calls[before2].url);

      // ── Chạy tới khi gặp 429 ở c-new ⇒ nghỉ, rồi đọc tiếp ──
      let t3 = await runHistoryTick(deps);
      assert.ok(t3.status === "RUNNING" && t3.waitMs >= 90_000, `429 ⇒ nghỉ theo Retry-After: ${JSON.stringify(t3)}`);
      const waiting = await runHistoryTick(deps);
      assert.ok(waiting.requests === 0 && waiting.waitMs > 0, "đang nghỉ ⇒ không gọi Pancake");
      const later = () => new Date(Date.now() + 2 * MIN);
      for (let i = 0; i < 10 && t3.status === "RUNNING"; i++) t3 = await runHistoryTick({ ...deps, now: later });
      assert.equal(t3.status, "DONE", JSON.stringify(t3));
      const done = await loadHistoryRun();
      assert.ok(done.status === "DONE" && done.counts.conversations === 4 && done.counts.created === 2, `đếm: ${JSON.stringify(done.counts)}`);
      assert.equal(done.counts.fresh, 1);
      assert.ok(done.counts.duplicates >= 2, "live-1 (webhook đã có) + tiếng vọng tin bot");
      assert.equal(pancake.posts().length, 0, "nhập lịch sử KHÔNG gửi gì cho khách");

      // ── Dòng tin ──
      const rows = await db.select().from(t).where(isNotNull(t.importedAt));
      const byId = new Map(rows.map((r) => [r.messageId, r]));
      assert.deepEqual([...byId.keys()].sort(), ["h-1", "mv1", "n1", "o1", "o3", "o4"], "đủ tin cũ, không ghi chú tự động / tin quá mới / tin trùng / tiếng vọng");
      assert.ok(rows.every((r) => r.status === "DONE" && r.kind === "INBOX"), "không dòng lịch sử nào vào hàng chờ của bot");
      assert.ok(byId.get("o3")!.note === HISTORY_NOTE && byId.get("o4")!.note === PAGE_REPLY, "khách = HISTORY, page = PAGE_REPLY");
      assert.equal(byId.get("o3")!.createdAt.getTime(), oldAt, "mốc tin THẬT (UTC), không phải giờ nhập");
      assert.equal(byId.get("o3")!.customerName, "Chị Mai");
      const [liveRow] = await db.select().from(t).where(eq(t.messageId, "live-1"));
      assert.ok(liveRow.importedAt === null && liveRow.note === null, "tin webhook đã có giữ nguyên");
      assert.equal((await db.select().from(t).where(eq(t.messageId, "live-fresh"))).length, 0, "tin quá mới để webhook / bot lo");
      assert.equal((await db.select().from(t).where(eq(t.messageId, "pancake-bot-old"))).length, 0, "tiếng vọng tin bot không thành tin page thứ hai");
      assert.equal((await db.select().from(t).where(eq(t.status, "PENDING"))).length, 0);

      // ── Hội thoại ──
      const convOf = async (thread: string) => (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(PAGE, thread)))))[0];
      const cOld = await convOf("c-old");
      assert.ok(cOld && cOld.createdBy === HISTORY_CREATED_BY && cOld.pageId === PAGE && cOld.threadId === "c-old", "hội thoại mở bằng conversationFor, đánh dấu do lượt nhập tạo");
      assert.equal(cOld.lastCustomerAt?.getTime(), oldAt, "mốc tin khách cuối = mốc thật");
      assert.equal(cOld.historyUntil?.getTime(), oldAt + 2 * MIN);
      assert.ok(cOld.historyImportedAt);
      assert.equal(cOld.updatedAt.getTime(), oldAt + 2 * MIN, "hội thoại do lượt nhập tạo: updated_at = mốc tin thật cuối (danh sách hội thoại của bot không ngập hội thoại cũ)");
      assert.deepEqual((cOld.state as { pancakePhones?: string[] }).pancakePhones, ["0987654321", "0912345678"], "SĐT Pancake ghi nhận (trang tin + danh sách) chuẩn hoá");
      const cLive = await convOf("c-live");
      assert.equal(cLive.lastCustomerAt?.getTime(), liveAt.getTime(), "tin cũ không kéo lùi mốc tin khách");
      assert.equal(cLive.updatedAt.getTime(), live.updatedAt.getTime(), "KHÔNG chạm updated_at (đồng hồ «nhân viên đang trả lời» của bot)");
      assert.ok(cLive.createdBy === null);
      assert.equal((await convOf("c-moved")).historyImportedAt !== null, true, "phần quét lại đọc hội thoại ERP trượt khỏi danh sách");
      const greetings = await db.select().from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, cOld.id));
      assert.equal(greetings.length, 1, "chỉ lời chào mặc định — lượt nhập không chép tin vào lịch sử bot");
      assert.equal((await db.select().from(schema.salesConversationEvents)).length, 0, "không sự kiện nào");

      // ── Hộp thư: không thổi phồng chưa đọc / chờ trả lời; xếp theo mốc thật ──
      const all = await listInbox(cs, { filter: "ALL" });
      assert.ok(all.ok);
      const ids = (list: Awaited<ReturnType<typeof listInbox>>) => (list.ok ? list.rows.map((r) => r.id) : []);
      const cNew = await convOf("c-new");
      assert.ok(ids(all).includes(cNew.id) && ids(all).includes(cOld.id), "khách cũ chưa từng nhắn lại vẫn có trong hộp thư");
      assert.equal(ids(all)[0], cLive.id, "hội thoại có tin SỐNG đứng đầu");
      const rowOld = all.ok ? all.rows.find((r) => r.id === cOld.id)! : null;
      assert.equal(rowOld?.lastActivityAt, new Date(oldAt + 2 * MIN).toISOString(), "mốc hoạt động = tin thật cuối, không phải giờ nhập");
      assert.ok(ids(all).indexOf(cNew.id) > ids(all).indexOf(cOld.id), "hội thoại 20 ngày trước đứng sau hội thoại 3 giờ trước");
      const unanswered = await listInbox(cs, { filter: "UNANSWERED" });
      assert.deepEqual(ids(unanswered), [cLive.id], "chỉ tin SỐNG chưa trả lời là «chờ trả lời» — c-new (khách hỏi 20 ngày trước, không ai trả lời) không phải");
      const unread = await listInbox(cs, { filter: "UNREAD" });
      assert.ok(unread.ok && !ids(unread).includes(cOld.id) && !ids(unread).includes(cNew.id), "tin cũ không «chưa đọc»");
      assert.ok(unread.ok && unread.counts.UNREAD === 1 && ids(unread).includes(cLive.id), `tin sống vẫn chưa đọc: ${JSON.stringify(unread.ok && unread.counts)}`);
      const th = await loadInboxThread({ ...cs, permissions: ["ai_sales:view"] } as unknown as SessionUser, cOld.id);
      assert.ok(th.ok && th.thread.items.map((i) => `${i.side}:${i.text.slice(0, 8)}`).join("|") === "CUSTOMER:Shop ơi|CUSTOMER:Lấy chị |PAGE:Dạ em lê", JSON.stringify(th.ok && th.thread.items));
      assert.ok(th.ok && th.thread.customer.name === "Chị Mai");

      // ── Bot / máy ghi đơn / đếm không coi tin cũ là tin mới ──
      await mirrorFanpageContext(cOld.id, PAGE, "c-old", new Date(Date.now() + MIN));
      assert.equal((await db.select().from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, cOld.id))).length, 1, "lịch sử bot không nhận tin page cũ");
      await setSettingJson(ORDER_SYNC_SETTING_KEY, { enabled: true, enabledAt: new Date(now - 2 * D).toISOString() });
      const os = await runFanpageOrderSync({ fetch: pancake.fetch, threadId: "c-old" });
      assert.ok(os.checked === 0 && os.detail[0] === "không hội thoại nào mới yên", `lời chốt CŨ 3 giờ trước không thành ứng viên ghi đơn: ${JSON.stringify(os)}`);
      const counts = await fanpageInboundCounts();
      assert.equal(counts.done, 1, "«bot đã xử lý» chỉ đếm tin sống (live-1)");
      const usage = await readOrgUsage(db, new Date(now - 30 * D), new Date(Date.now() + D));
      assert.equal(usage.conversationsStarted, 2, "số hội thoại mới của nền tảng không đếm 2 hội thoại do lượt nhập tạo");
      assert.equal(usage.botMessages, 0, "lời chào mặc định của hội thoại nhập không phải tin bot");

      // ── Idempotent: chạy lại từ đầu ⇒ 0 tin mới, không nhân đôi ──
      const countBefore = (await db.select().from(t)).length;
      assert.ok("ok" in (await startInboxHistory(admin, { mode: "restart" })));
      let t4 = await runHistoryTick({ ...deps, now: later });
      for (let i = 0; i < 10 && t4.status === "RUNNING"; i++) t4 = await runHistoryTick({ ...deps, now: later });
      const again = await loadHistoryRun();
      assert.ok(again.status === "DONE" && again.counts.messages === 0 && again.counts.created === 0 && again.counts.duplicates >= 6, JSON.stringify(again.counts));
      assert.equal((await db.select().from(t)).length, countBefore, "nhập lại không thêm dòng nào");

      // ── Dừng: lượt thôi ngay, không ghi đè ──
      assert.ok("ok" in (await startInboxHistory(admin, { mode: "restart" })));
      assert.ok("ok" in (await cancelInboxHistory(admin)));
      const afterCancel = await runHistoryTick(deps);
      assert.ok(afterCancel.requests === 0 && (await loadHistoryRun()).status === "CANCELLED");
      const resumed = await startInboxHistory(admin, { mode: "resume" });
      assert.ok("ok" in resumed && resumed.message.includes("đọc tiếp"), JSON.stringify(resumed));
      assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_INBOX_HISTORY_START"))).length, 4);

      // ── Token bị thu hồi ⇒ dừng hẳn, câu lỗi KHÔNG lộ token ──
      const broken = fakePancake({}, {});
      const brokenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => broken.fetch(String(input).replace(TOKEN, "sai"), init)) as typeof fetch;
      const failed = await runHistoryTick({ fetch: brokenFetch, sleep: async () => {} });
      const fr = await loadHistoryRun();
      assert.ok(failed.status === "FAILED" && fr.status === "FAILED" && fr.lastError?.includes("token sai") && !fr.lastError.includes(TOKEN), JSON.stringify(fr.lastError));
      void HISTORY_SETTING_KEY;
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
  console.log(
    "  ✓ Nhập lịch sử hộp thư (M8 · 0221): phân trang danh sách + tin, dừng giữa hội thoại ⇒ lượt sau đọc tiếp đúng trang; 429 ⇒ nghỉ theo Retry-After; tin khách HISTORY / tin page PAGE_REPLY, DONE, mốc thật UTC; tin webhook đã có + tiếng vọng tin bot bỏ qua; tin quá mới để webhook lo; quét lại hội thoại ERP trượt khỏi danh sách; SĐT Pancake ở state.pancakePhones; không gửi gì, không tin chờ, không sự kiện, lịch sử bot / máy ghi đơn / đếm bot / số hội thoại mới của nền tảng không nhận tin cũ; hộp thư không thổi phồng chưa đọc / chờ trả lời, xếp theo mốc thật; nhập lại 0 dòng mới; dừng / chạy tiếp; token hỏng ⇒ dừng, không lộ token",
  );
}
