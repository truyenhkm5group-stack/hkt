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
import { sendMessengerImage } from "@/lib/integrations/messenger/graph";
import { zaloSendImage, zaloUploadImage, ZALO_MESSAGE_CS_URL, ZALO_UPLOAD_IMAGE_URL } from "@/lib/integrations/zalo/oa";
import { conversationView } from "@/lib/sales-chatbot/engine";
import { fanpageVisitorKey, mirrorFanpageContext, PAGE_REPLY, receiveFanpageEvent, STAFF_REASON } from "@/lib/sales-chatbot/fanpage";
import { assignConversationCore, checkStaffImages, claimConversationCore, handBackToAiCore, listInbox, loadInboxThread, releaseConversationCore, sendStaffReplyCore, sendWindowOf, WEB_STAFF_REASON } from "@/lib/sales-chatbot/inbox";
import { addNoteCore, archiveLabelCore, createLabelCore, deleteNoteCore, listLabels, setConversationLabelsCore } from "@/lib/sales-chatbot/inbox-labels";

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

function fakePancake(opts: { failPost?: boolean; failUpload?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === "POST" && opts.failPost) return new Response(JSON.stringify({ success: false, message: "Pancake lỗi" }), { status: 500, headers: { "content-type": "application/json" } });
    if (url.includes("/upload_contents")) {
      if (opts.failUpload) return new Response(JSON.stringify({ success: false, message: "Ảnh lỗi" }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ success: true, id: `content-${calls.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `m-out-${calls.length}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const posts = () => calls.filter((c) => c.init?.method === "POST" && c.url.includes("/messages"));
  const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body ?? "{}")) as { message?: string; content_ids?: string[] };
  return {
    fetch: f,
    sent: posts,
    textPosts: () => posts().filter((c) => typeof bodyOf(c).message === "string").length,
    imagePosts: () => posts().filter((c) => Array.isArray(bodyOf(c).content_ids)).length,
    uploads: () => calls.filter((c) => c.url.includes("/upload_contents")).length,
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);

function testImageRules() {
  assert.ok(checkStaffImages("FANPAGE", [{ data: JPEG }, { data: PNG }, { data: WEBP }]).ok, "JPG / PNG / WEBP nhận diện từ byte");
  const fake = checkStaffImages("FANPAGE", [{ data: new TextEncoder().encode("<svg onload=alert(1)>") }]);
  assert.ok(!fake.ok && fake.error.includes("JPG / PNG / WEBP"), "tệp không phải ảnh (đổi đuôi) bị từ chối theo BYTE");
  assert.ok(!checkStaffImages("FANPAGE", Array.from({ length: 5 }, () => ({ data: JPEG }))).ok, "tối đa 4 ảnh");
  assert.ok(!checkStaffImages("WEB", [{ data: JPEG }]).ok, "chat web chưa nhận ảnh");
  assert.ok(!checkStaffImages("ZALO", [{ data: WEBP }]).ok, "Zalo không nhận WEBP");
  const big = new Uint8Array(1024 * 1024 + 10);
  big.set(JPEG);
  assert.ok(!checkStaffImages("ZALO", [{ data: big }]).ok && checkStaffImages("FANPAGE", [{ data: big }]).ok, "Zalo ≤ 1 MB; Facebook nhận");
  const huge = new Uint8Array(5 * 1024 * 1024 + 1);
  huge.set(JPEG);
  assert.ok(!checkStaffImages("FANPAGE", [{ data: huge }]).ok, "mỗi ảnh ≤ 5 MB");
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

/** Hình dạng lời gọi ảnh của Messenger trực tiếp + Zalo OA (máy chủ giả — tài khoản thật là HUMAN GATE). */
async function testChannelImageCalls() {
  const seen: { url: string; init: RequestInit }[] = [];
  const graphFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ recipient_id: "psid-1", message_id: "mid.img-1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const m = await sendMessengerImage({ appId: "app-1", appSecret: "secret-abcdef0123456789" }, "page-token-abcdef0123456789", "psid-1", { data: JPEG, contentType: "image/jpeg" }, graphFake);
  assert.ok(m.ok && m.id === "mid.img-1", JSON.stringify(m));
  const form = seen[0].init.body as FormData;
  assert.ok(seen[0].url.includes("/me/messages?") && seen[0].url.includes("appsecret_proof="), "đúng Send API, có appsecret_proof");
  assert.equal(JSON.parse(String(form.get("message"))).attachment.type, "image");
  assert.equal(JSON.parse(String(form.get("recipient"))).id, "psid-1");
  assert.ok(form.get("filedata") instanceof Blob, "ảnh đi dạng TỆP kèm, không cần URL công khai");

  const zcalls: { url: string; init: RequestInit }[] = [];
  const zfake = async (url: string, init: RequestInit) => {
    zcalls.push({ url, init });
    const data = url === ZALO_UPLOAD_IMAGE_URL ? { attachment_id: "att-1" } : { message_id: "zm-img-1" };
    return new Response(JSON.stringify({ error: 0, message: "Success", data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const up = await zaloUploadImage({ accessToken: "acc_zalo_0123456789abcdef", data: JPEG, contentType: "image/jpeg" }, { fetch: zfake });
  assert.ok(up.ok && up.attachmentId === "att-1", JSON.stringify(up));
  assert.ok(zcalls[0].url === ZALO_UPLOAD_IMAGE_URL && (zcalls[0].init.body as FormData).get("file") instanceof Blob);
  const zs = await zaloSendImage({ accessToken: "acc_zalo_0123456789abcdef", userId: "8899", attachmentId: "att-1" }, { fetch: zfake });
  assert.ok(zs.ok && zs.messageId === "zm-img-1");
  const sentBody = JSON.parse(String(zcalls[1].init.body)) as { recipient: { user_id: string }; message: { attachment: { payload: { template_type: string; elements: { media_type: string; attachment_id: string }[] } } } };
  assert.ok(zcalls[1].url === ZALO_MESSAGE_CS_URL && sentBody.recipient.user_id === "8899" && sentBody.message.attachment.payload.template_type === "media" && sentBody.message.attachment.payload.elements[0].attachment_id === "att-1", JSON.stringify(sentBody));
  const noWebp = await zaloUploadImage({ accessToken: "acc_zalo_0123456789abcdef", data: WEBP, contentType: "image/webp" }, { fetch: zfake });
  assert.ok(!noWebp.ok && zcalls.length === 2, "Zalo không nhận WEBP — chặn trước khi gọi mạng");
}

export async function testSalesInbox() {
  testWindows();
  testImageRules();
  await testChannelImageCalls();
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

      // ── Ảnh (0211): chữ + ảnh qua Pancake; ảnh hỏng ⇒ bấm lại chỉ gửi lại ẢNH ──
      const convImg = await mk("t-img", 2);
      const pc = fakePancake();
      const ri = await sendStaffReplyCore(lan, convImg, { text: "Dạ mẫu này ạ", requestKey: "req-img-0001" }, { fetch: pc.fetch }, [{ data: JPEG }, { data: PNG }]);
      assert.ok(ri.ok, JSON.stringify(ri));
      assert.ok(pc.textPosts() === 1 && pc.uploads() === 2 && pc.imagePosts() === 1, `chữ 1 · tải 2 · gửi ảnh 1 (${pc.textPosts()}/${pc.uploads()}/${pc.imagePosts()})`);
      const [im] = await db.select().from(schema.salesChatStaffMessages).where(eq(schema.salesChatStaffMessages.conversationId, convImg));
      assert.ok(im.status === "SENT" && im.imageCount === 2 && im.textSentAt, JSON.stringify(im));
      const stored = await db.select().from(schema.salesChatStaffImages).where(eq(schema.salesChatStaffImages.staffMessageId, im.id));
      assert.deepEqual(stored.map((x) => x.contentType), ["image/jpeg", "image/png"], "loại ảnh lưu theo byte, đúng thứ tự");
      const imgMark = await db.select().from(t).where(eq(t.messageId, `staff-out:${im.id}:img`));
      assert.ok(imgMark.length === 1 && imgMark[0].note === PAGE_REPLY && imgMark[0].text === "[Ảnh]", "ảnh tính là «page đã trả lời», bot biết shop đã gửi ảnh");
      const ti = await loadInboxThread(lan, convImg);
      assert.ok(ti.ok && ti.thread.items.find((x) => x.side === "STAFF")?.images.every((u) => u.startsWith("/api/ai-sales/inbox-images/")) && ti.thread.items.find((x) => x.side === "STAFF")?.images.length === 2);

      const convPart = await mk("t-part", 2);
      const badImg = fakePancake({ failUpload: true });
      const rp = await sendStaffReplyCore(lan, convPart, { text: "Dạ ảnh đây ạ", requestKey: "req-img-0002" }, { fetch: badImg.fetch }, [{ data: JPEG }]);
      assert.ok(!rp.ok && rp.error.startsWith("Đã gửi chữ; ẢNH chưa gửi được"), JSON.stringify(rp));
      const [pm] = await db.select().from(schema.salesChatStaffMessages).where(eq(schema.salesChatStaffMessages.conversationId, convPart));
      assert.ok(pm.status === "FAILED" && pm.textSentAt, "chữ đã tới khách được ghi lại");
      const goodImg = fakePancake();
      const rp2 = await sendStaffReplyCore(lan, convPart, { text: "Dạ ảnh đây ạ", requestKey: "req-img-0002" }, { fetch: goodImg.fetch }, []);
      assert.ok(rp2.ok && rp2.messageId === pm.id, JSON.stringify(rp2));
      assert.ok(goodImg.textPosts() === 0 && goodImg.uploads() === 1 && goodImg.imagePosts() === 1, "bấm lại: KHÔNG gửi chữ lần hai, chỉ gửi ảnh đã lưu");
      const noImgWeb = await sendStaffReplyCore(minh, web.id, { text: "", requestKey: "req-web-img-01" }, {}, [{ data: JPEG }]);
      assert.ok(!noImgWeb.ok && noImgWeb.error.includes("Chat web"), "chat web chưa nhận ảnh — báo rõ, không ghi");
      const empty = await sendStaffReplyCore(lan, convImg, { text: "  ", requestKey: "req-empty-001" }, { fetch: pc.fetch }, []);
      assert.ok(!empty.ok && empty.error.includes("Tin trống"));

      // ── Nhãn (0211) ──
      assert.ok(!(await createLabelCore(viewer, { name: "Khách sỉ", color: "green" })).ok, "chỉ xem ⇒ không tạo nhãn");
      const lb = await createLabelCore(lan, { name: "Khách sỉ", color: "green" });
      assert.ok(lb.ok && !lb.existed, JSON.stringify(lb));
      const lbDup = await createLabelCore(minh, { name: "  khách   SỈ ", color: "red" });
      assert.ok(lbDup.ok && lbDup.existed && lbDup.label.id === lb.label.id, "trùng tên (hoa thường / khoảng trắng) ⇒ dùng lại nhãn có sẵn");
      const lb2 = await createLabelCore(lan, { name: "Hẹn gọi lại", color: "amber" });
      assert.ok(lb2.ok);
      assert.ok(!(await createLabelCore(lan, { name: "Đỏ", color: "rainbow" })).ok, "màu ngoài bảng màu ⇒ từ chối");
      const set1 = await setConversationLabelsCore(lan, convA, [lb.label.id, lb2.label.id, "khong-co-nhan-nay"]);
      assert.ok(set1.ok && set1.labels.map((l) => l.name).sort().join() === "Hẹn gọi lại,Khách sỉ", JSON.stringify(set1));
      const byLabel = await listInbox(lan, { filter: "ALL", label: lb.label.id });
      assert.ok(byLabel.ok && byLabel.rows.length === 1 && byLabel.rows[0].id === convA && byLabel.rows[0].labels.length === 2, "lọc hộp thư theo nhãn");
      assert.ok(!(await archiveLabelCore(lan, lb2.label.id)).ok, "gỡ nhãn khỏi bộ nhãn cần ai_sales:manage");
      assert.ok((await archiveLabelCore(admin, lb2.label.id)).ok);
      assert.deepEqual((await listLabels()).map((l) => l.name), ["Khách sỉ"], "nhãn đã gỡ không còn trong bộ chọn");
      const ta = await loadInboxThread(lan, convA);
      assert.ok(ta.ok && ta.thread.labels.length === 2, "hội thoại cũ vẫn giữ nhãn đã gỡ");
      const set2 = await setConversationLabelsCore(lan, convA, [lb.label.id, lb2.label.id]);
      assert.ok(set2.ok && set2.labels.length === 2, "lưu lại bộ nhãn không vô tình gỡ nhãn đã lưu trữ");
      const set3 = await setConversationLabelsCore(lan, convA, []);
      assert.ok(set3.ok && set3.labels.length === 0);

      // ── Ghi chú nội bộ (0211) ──
      const n1 = await addNoteCore(lan, convA, "Khách hẹn 5h chiều gọi lại, giao giờ hành chính");
      assert.ok(n1.ok && n1.note.author === "Lan CSKH", JSON.stringify(n1));
      assert.ok(!(await addNoteCore(viewer, convA, "x")).ok, "chỉ xem ⇒ không ghi chú");
      assert.ok(!(await deleteNoteCore(minh, n1.note.id)).ok, "không phải người viết ⇒ không xoá");
      const tn = await loadInboxThread(minh, convA);
      assert.ok(tn.ok && tn.thread.notes.length === 1 && !tn.thread.notes[0].canDelete);
      const botHist = await db.select().from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, convA));
      assert.ok(!botHist.some((m) => JSON.stringify(m.content).includes("hẹn 5h chiều")), "ghi chú KHÔNG vào lịch sử của bot");
      assert.ok((await deleteNoteCore(admin, n1.note.id)).ok, "người quản lý xoá được");
      const tn2 = await loadInboxThread(lan, convA);
      assert.ok(tn2.ok && tn2.thread.notes.length === 0);
      assert.equal((await db.select().from(schema.salesChatNotes).where(eq(schema.salesChatNotes.conversationId, convA))).length, 1, "xoá = đánh dấu, dòng còn");

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
  console.log("  ✓ Hộp thư người (M8): khung gửi của kênh (web luôn · Messenger 24 giờ cảnh báo · Zalo 48 giờ / tính phí / 7 ngày); khung thử không vào hộp thư; «Chờ trả lời» xếp khách chờ lâu nhất; gửi Facebook đúng một lời gọi, mang khoá tài khoản + tên máy chủ đọc, bot nhường, human.took_over + human.replied; bấm đôi không gửi lại; tiếng vọng không thành tin thứ hai; lịch sử bot nhận một lần; gửi hỏng ⇒ FAILED, không dấu vết, bấm lại gửi đúng tin; chat web khách thấy tin không kèm dấu nội bộ; nhận / bỏ nhận / giao theo quyền; trả lại AI; ảnh nhận diện từ byte (JPG / PNG / WEBP ≤ 5 MB, Zalo ≤ 1 MB, chat web chưa nhận), chữ + ảnh qua Pancake, ảnh hỏng ⇒ bấm lại chỉ gửi ảnh; nhãn trùng tên dùng lại, lọc theo nhãn, gỡ nhãn cần quyền quản lý và không xoá khỏi hội thoại cũ; ghi chú mang tên người viết, không vào lịch sử bot, xoá là đánh dấu");
}
