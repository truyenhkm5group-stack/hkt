/**
 * ═══════════ HỘP THƯ NGƯỜI TRONG ERP (M8 · lib/sales-chatbot/inbox.ts) ═══════════
 *
 * Khoá:
 *  · KHUNG GỬI của kênh (thuần): chat web luôn gửi; Messenger 24 giờ (quá ⇒ cảnh báo, không tự chặn); Zalo 48 giờ miễn phí →
 *    tin tính phí (phải xác nhận) → quá 7 ngày không gửi.
 *  · Danh sách: không có khung thử; «Chờ trả lời» = tin khách chưa ai trả lời; tin nhân viên gửi ⇒ rời «Chờ trả lời», vào «Của tôi».
 *  · Gửi Facebook (qua Pancake giả): đúng MỘT lời gọi gửi; dòng `staff-out:` + `PAGE_REPLY`; dòng tin nhân viên mang khoá tài
 *    khoản + tên máy chủ đọc; bot nhường (HANDOFF, lý do nhân viên); sự kiện `human.took_over` + `human.replied` mang
 *    `actor_user_id`; bấm đôi cùng khoá ⇒ không gửi lần hai; TIẾNG VỌNG Pancake không thành «nhân viên ngoài ERP» thứ hai; tin chép
 *    vào lịch sử của bot ĐÚNG MỘT lần; gửi hỏng ⇒ FAILED, không để lại dòng `staff-out:`, hội thoại không đổi.
 *  · Chat web: tin vào lịch sử hội thoại, khách thấy KHÔNG kèm dấu «[Shop đã nhắn]».
 *  · Quyền: chỉ xem (ai_sales:view) ⇒ đọc được, không gửi được; nhận / bỏ nhận / giao (ai_sales:manage); trả lại AI.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { conversationView } from "@/lib/sales-chatbot/engine";
import { fanpageVisitorKey, mirrorFanpageContext, PAGE_REPLY, receiveFanpageEvent, STAFF_REASON } from "@/lib/sales-chatbot/fanpage";
import { assignConversationCore, claimConversationCore, handBackToAiCore, listInbox, loadInboxThread, releaseConversationCore, sendStaffReplyCore, sendWindowOf, WEB_STAFF_REASON } from "@/lib/sales-chatbot/inbox";

const ORG = "hop-thu-nguoi";
const PAGE = "6677889900";
const PAGE_TOKEN = "pancake_page_token_hopthu_0123456789abc";
const H = 3_600_000;

function testWindows() {
  const now = new Date("2026-10-05T10:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * H);
  assert.equal(sendWindowOf({ channel: "WEB", lastCustomerAt: null }, now).kind, "OPEN");
  const fb = sendWindowOf({ channel: "FANPAGE", lastCustomerAt: ago(2) }, now);
  assert.ok(fb.kind === "OPEN" && fb.until && new Date(fb.until).getTime() === ago(2).getTime() + 23.5 * H, JSON.stringify(fb));
  assert.equal(sendWindowOf({ channel: "FANPAGE", lastCustomerAt: ago(30) }, now).kind, "UNKNOWN", "Messenger quá 24 giờ ⇒ cảnh báo, không tự chặn (đường Pancake có thể còn gửi được)");
  assert.equal(sendWindowOf({ channel: "FANPAGE", lastCustomerAt: null }, now).kind, "UNKNOWN");
  assert.equal(sendWindowOf({ channel: "ZALO", lastCustomerAt: ago(10) }, now).kind, "OPEN");
  assert.equal(sendWindowOf({ channel: "ZALO", lastCustomerAt: ago(60) }, now).kind, "PAID", "Zalo quá 48 giờ ⇒ tin tính phí");
  assert.equal(sendWindowOf({ channel: "ZALO", lastCustomerAt: ago(24 * 8) }, now).kind, "CLOSED", "Zalo quá 7 ngày ⇒ không gửi");
}

function fakePancake(opts: { failPost?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === "POST" && opts.failPost) return new Response(JSON.stringify({ success: false, message: "Pancake lỗi" }), { status: 500, headers: { "content-type": "application/json" } });
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `m-out-${calls.length}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, sent: () => calls.filter((c) => c.init?.method === "POST" && c.url.includes("/messages")) };
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

export async function testSalesInbox() {
  testWindows();
  await cleanup();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-hop-thu-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await provisionOrganization({ code: ORG, name: "Shop hộp thư", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { email: u.email, permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] };
      const admin = { ...base, id: u.id, name: u.name, role: "ADMIN" } as unknown as SessionUser;
      const [s1] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      const [s2] = await db.insert(schema.users).values({ email: `minh@${ORG}.local`, name: "Minh CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      // Tên gửi lên KHÁC tên trong `users` — máy chủ phải dùng tên trong `users` (luật 34).
      const lan = { ...base, id: s1.id, name: "Tên giả từ trình duyệt", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const minh = { ...base, id: s2.id, name: "Minh CSKH", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const viewer = { ...base, id: "hop-thu-viewer", name: "Xem", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;

      const pancake = fakePancake();
      const savedConn = await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } });
      assert.ok("ok" in savedConn, JSON.stringify(savedConn));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));

      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const now = Date.now();
      const mk = async (thread: string, minutesAgo: number) => {
        const at = new Date(now - minutesAgo * 60_000);
        const [row] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, thread), pageId: PAGE, threadId: thread, lastCustomerAt: at }).returning({ id: c.id });
        await db.insert(t).values({ pageId: PAGE, threadId: thread, messageId: `cust-${thread}`, text: "Còn size M không shop?", customerName: "Chị Hoa", status: "DONE", processedAt: at, createdAt: at });
        return row.id;
      };
      const convA = await mk("t-a", 5);
      const convFail = await mk("t-fail", 3);
      const [web] = await db.insert(c).values({ channel: "WEB", status: "OPEN" }).returning({ id: c.id });
      await db.insert(schema.salesChatMessages).values([
        { conversationId: web.id, seq: 1, role: "user", content: [{ type: "text", text: "Ship bao lâu?" }] },
        { conversationId: web.id, seq: 2, role: "assistant", content: [{ type: "text", text: "Dạ 2–3 ngày ạ." }] },
      ]);
      await db.insert(c).values({ channel: "TEST", status: "OPEN" });

      // ── Danh sách ──
      const l0 = await listInbox(lan, { filter: "UNANSWERED" });
      assert.ok(l0.ok && l0.rows.map((r) => r.id).sort().join() === [convA, convFail].sort().join(), JSON.stringify(l0));
      assert.ok(l0.ok && l0.counts.ALL === 3, "khung thử không vào hộp thư");
      assert.ok(l0.ok && l0.rows[0].id === convA && l0.rows[0].customerName === "Chị Hoa" && l0.rows[0].waitingSince, "khách chờ LÂU NHẤT lên đầu; tên khách đọc từ tin");

      // ── Chỉ xem: đọc được, không gửi được ──
      const vt = await loadInboxThread(viewer, convA);
      assert.ok(vt.ok && !vt.thread.canReply && vt.thread.items.some((i) => i.side === "CUSTOMER"), JSON.stringify(vt));
      const vs = await sendStaffReplyCore(viewer, convA, { text: "Dạ", requestKey: "req-viewer-0001" }, { fetch: pancake.fetch });
      assert.ok(!vs.ok && vs.error.includes("ai_sales:reply"));
      assert.equal(pancake.sent().length, 0);

      // ── Gửi Facebook ──
      const r1 = await sendStaffReplyCore(lan, convA, { text: "Dạ còn size M ạ, chị lấy màu nào?", requestKey: "req-lan-0001" }, { fetch: pancake.fetch });
      assert.ok(r1.ok && !r1.reused, JSON.stringify(r1));
      assert.equal(pancake.sent().length, 1, "đúng MỘT lời gọi gửi");
      const [msg] = await db.select().from(schema.salesChatStaffMessages).where(eq(schema.salesChatStaffMessages.conversationId, convA));
      assert.ok(msg.status === "SENT" && msg.userId === lan.id && msg.userName === "Lan CSKH" && msg.channel === "FANPAGE", JSON.stringify(msg));
      const staffRows = await db.select().from(t).where(and(eq(t.threadId, "t-a"), like(t.messageId, "staff-out:%")));
      assert.ok(staffRows.length === 1 && staffRows[0].note === PAGE_REPLY, "dòng ghi sẵn staff-out mang nghĩa «page đã trả lời»");
      const [a1] = await db.select().from(c).where(eq(c.id, convA));
      assert.ok(a1.status === "HANDOFF" && a1.handoffReason === STAFF_REASON && a1.assigneeUserId === lan.id && a1.lastStaffAt, JSON.stringify({ s: a1.status, r: a1.handoffReason, a: a1.assigneeUserId }));
      const evs = await db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, convA));
      assert.ok(evs.some((e) => e.type === "human.took_over" && e.actorUserId === lan.id) && evs.some((e) => e.type === "human.replied" && e.actorKind === "HUMAN" && e.actorUserId === lan.id), JSON.stringify(evs.map((e) => [e.type, e.actorUserId])));

      // Bấm đôi cùng khoá ⇒ không gửi lần hai.
      const r1b = await sendStaffReplyCore(lan, convA, { text: "Dạ còn size M ạ, chị lấy màu nào?", requestKey: "req-lan-0001" }, { fetch: pancake.fetch });
      assert.ok(r1b.ok && r1b.reused && r1b.messageId === r1.messageId);
      assert.equal(pancake.sent().length, 1);

      // Tiếng vọng Pancake (mã khác) ⇒ nhận ra là tin ERP, không thêm «nhân viên ngoài ERP».
      const echo = await receiveFanpageEvent({ pageId: PAGE, threadId: "t-a", messageId: "pancake-echo-1", text: "Dạ còn size M ạ, chị lấy màu nào?", customerName: "", fromPage: true, humanStaff: true, inbox: true, comment: null, imageUrls: [] });
      assert.equal(echo.queued, false);
      const pageReplies = await db.select().from(t).where(and(eq(t.threadId, "t-a"), eq(t.note, PAGE_REPLY)));
      assert.equal(pageReplies.length, 1, `tiếng vọng không đẻ dòng PAGE_REPLY thứ hai (${echo.reason})`);
      const took = (await db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, convA))).filter((e) => e.type === "human.took_over");
      assert.equal(took.length, 1);

      // Lịch sử của bot nhận tin nhân viên ĐÚNG MỘT lần.
      await mirrorFanpageContext(convA, PAGE, "t-a", new Date(Date.now() + 60_000));
      const hist = await db.select().from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, convA));
      const shopSaid = hist.filter((m) => JSON.stringify(m.content).includes("Dạ còn size M ạ"));
      assert.equal(shopSaid.length, 1, "tin nhân viên vào lịch sử của bot một lần");

      // Dòng thời gian: khách + nhân viên có tên, không bản trùng phía page.
      const th = await loadInboxThread(lan, convA);
      assert.ok(th.ok);
      const sides = th.thread.items.map((i) => `${i.side}:${i.author ?? ""}`);
      assert.deepEqual(sides, ["CUSTOMER:", "STAFF:Lan CSKH"], JSON.stringify(th.thread.items));
      assert.ok(th.thread.botYields && th.thread.assigneeName === "Lan CSKH");

      // Danh sách sau khi trả lời.
      const l1 = await listInbox(lan, { filter: "UNANSWERED" });
      assert.ok(l1.ok && !l1.rows.some((r) => r.id === convA), "đã trả lời ⇒ rời «Chờ trả lời»");
      const mine = await listInbox(lan, { filter: "MINE" });
      assert.ok(mine.ok && mine.rows.length === 1 && mine.rows[0].id === convA && mine.rows[0].previewSide === "STAFF");
      const search = await listInbox(lan, { filter: "ALL", q: "hoa" });
      assert.ok(search.ok && search.rows.length === 2, "tìm theo tên khách trong tin");

      // ── Gửi hỏng ──
      const broken = fakePancake({ failPost: true });
      const rf = await sendStaffReplyCore(lan, convFail, { text: "Dạ shop kiểm tra ạ", requestKey: "req-lan-0002" }, { fetch: broken.fetch });
      assert.ok(!rf.ok, JSON.stringify(rf));
      const [failed] = await db.select().from(schema.salesChatStaffMessages).where(eq(schema.salesChatStaffMessages.conversationId, convFail));
      assert.equal(failed.status, "FAILED");
      assert.equal((await db.select().from(t).where(and(eq(t.threadId, "t-fail"), like(t.messageId, "staff-out:%")))).length, 0, "gửi hỏng ⇒ không để bot tưởng khách đã nhận");
      const [cf] = await db.select().from(c).where(eq(c.id, convFail));
      assert.ok(cf.status === "OPEN" && !cf.lastStaffAt && !cf.assigneeUserId, "gửi hỏng không đổi hội thoại");
      // Bấm lại CÙNG khoá khi đường gửi đã ổn ⇒ gửi lại đúng tin đó.
      const rf2 = await sendStaffReplyCore(lan, convFail, { text: "Dạ shop kiểm tra ạ", requestKey: "req-lan-0002" }, { fetch: pancake.fetch });
      assert.ok(rf2.ok && rf2.messageId === failed.id, JSON.stringify(rf2));

      // ── Chat web ──
      const rw = await sendStaffReplyCore(minh, web.id, { text: "Dạ shop gửi chị mã giảm 20K ạ", requestKey: "req-minh-0001" }, {});
      assert.ok(rw.ok, JSON.stringify(rw));
      const wv = await conversationView(web.id);
      assert.equal(wv?.messages.at(-1)?.text, "Dạ shop gửi chị mã giảm 20K ạ", "khách thấy tin nhân viên, không kèm dấu nội bộ");
      const [w1] = await db.select().from(c).where(eq(c.id, web.id));
      assert.ok(w1.status === "HANDOFF" && w1.handoffReason === WEB_STAFF_REASON);
      const wt = await loadInboxThread(minh, web.id);
      assert.ok(wt.ok && wt.thread.items.map((i) => i.side).join() === "CUSTOMER,BOT,STAFF", JSON.stringify(wt.ok && wt.thread.items));

      // ── Nhận / bỏ nhận / giao ──
      const steal = await claimConversationCore(minh, convA);
      assert.ok(!steal.ok, "đã có người nhận ⇒ không giành");
      assert.ok(!(await releaseConversationCore(minh, convA)).ok, "không phải người nhận ⇒ không bỏ nhận hộ");
      assert.ok(!(await assignConversationCore(lan, convA, minh.id)).ok, "giao cần ai_sales:manage");
      assert.ok((await assignConversationCore(admin, convA, minh.id)).ok);
      assert.equal((await db.select().from(c).where(eq(c.id, convA)))[0].assigneeUserId, minh.id);
      assert.ok((await releaseConversationCore(minh, convA)).ok);
      assert.ok((await claimConversationCore(lan, convA)).ok);
      assert.ok((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_INBOX_ASSIGN"))).length === 1);

      // ── Trả lại AI ──
      assert.ok((await handBackToAiCore(lan, convA)).ok);
      const [a2] = await db.select().from(c).where(eq(c.id, convA));
      assert.equal(a2.status, "OPEN");
      assert.ok((await db.select().from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.conversationId, convA), eq(schema.salesConversationEvents.type, "ai.resumed")))).some((e) => e.actorUserId === lan.id));
      assert.ok(!(await handBackToAiCore(lan, convA)).ok, "bot đang trả lời ⇒ không có gì để trả lại");
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
  console.log("  ✓ Hộp thư người (M8): khung gửi của kênh (web luôn · Messenger 24 giờ cảnh báo · Zalo 48 giờ / tính phí / 7 ngày); khung thử không vào hộp thư; «Chờ trả lời» xếp khách chờ lâu nhất; gửi Facebook đúng một lời gọi, mang khoá tài khoản + tên máy chủ đọc, bot nhường, human.took_over + human.replied; bấm đôi không gửi lại; tiếng vọng không thành tin thứ hai; lịch sử bot nhận một lần; gửi hỏng ⇒ FAILED, không dấu vết, bấm lại gửi đúng tin; chat web khách thấy tin không kèm dấu nội bộ; nhận / bỏ nhận / giao theo quyền; trả lại AI");
}
