/**
 * MESSENGER TRỰC TIẾP (0207 · lib/sales-chatbot/messenger.ts · lib/integrations/messenger/*). Không gọi mạng (luật 65): Graph
 * API và AI đều GIẢ.
 *
 *  1. THUẦN — gói webhook ⇒ sự kiện (chữ, ảnh, nút bấm; bỏ đã nhận / đã xem / nhãn dán / tin xoá; tiếng vọng mang mã app);
 *     chữ ký X-Hub-Signature-256 (đúng / sai / thiếu / thân bị sửa); cookie danh sách page mã hoá chỉ mở được bởi ĐÚNG tổ chức
 *     + người bấm.
 *  2. GRAPH GIẢ — code ⇒ token dài hạn ⇒ page (chỉ page nhắn tin được); mọi lời gọi bằng token kèm appsecret_proof; token
 *     không lọt vào câu lỗi; Send API đúng người nhận + RESPONSE.
 *  3. CSDL THẬT — nối page (lưu mã hoá, đăng ký webhook, kiểm tra, bật, chỉ mục page ⇒ tổ chức); tổ chức KHÁC nối cùng page ⇒
 *     từ chối; webhook phân giải theo mã page (page lạ ⇒ không rơi về nhà); tin khách ⇒ bot trả lời qua Send API; tiếng vọng
 *     của chính bot bị bỏ qua; người trả lời trong Hộp thư Meta ⇒ bot nhường; gỡ ⇒ chỉ mục mất.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { openPendingPages, sealPendingPages } from "@/lib/integrations/messenger/connect";
import { appSecretProof, pagesFromCode, parseMessengerWebhook, sendMessengerText, subscribePage, verifyMessengerSignature } from "@/lib/integrations/messenger/graph";
import { invalidateCapabilities, getEnabledModules } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { addQuickReplyImages, saveQuickReply } from "@/lib/sales-chatbot/quick-replies";
import { connectMessengerPage, disconnectMessengerPage, processMessengerThread, receiveMessengerEvent } from "@/lib/sales-chatbot/messenger";
import { PANCAKE_OWNS_PAGE_REASON } from "@/lib/sales-chatbot/channel-ownership";

const ORG = "msg-shop";
const OTHER = "msg-other";
const APP_ID = "777000111222";
const APP_SECRET = "app-secret-messenger-test-0123456789";
const PAGE = "1029384756";
const PSID = "5566778899001";
const PAGE_TOKEN = "EAAGpagetoken_messenger_0123456789abcdef";
const IG = "17841400000000001";
const IGSID = "6677889900112";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function testPure() {
  const payload = {
    object: "page",
    entry: [
      {
        id: PAGE,
        time: 1,
        messaging: [
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1_790_000_000_000, message: { mid: "m.1", text: "Áo này còn size M không?" } },
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: "m.2", attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/a.jpg" } }] } },
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: "m.3", sticker_id: 369239263222822, attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/like.png" } }] } },
          { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid: "m.4", is_echo: true, app_id: 777000111222, text: "Dạ còn ạ" } },
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, postback: { title: "Xem bảng giá", payload: "PRICE" } },
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, delivery: { mids: ["m.1"] } },
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, read: { watermark: 1 } },
          { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: "m.5", is_deleted: true } },
        ],
      },
      { id: "không-phải-số", messaging: [{ sender: { id: PSID }, message: { mid: "m.x", text: "x" } }] },
    ],
  };
  const ev = parseMessengerWebhook(payload);
  assert.deepEqual(
    ev.map((e) => [e.mid, e.psid, e.text, e.imageUrls.length, e.isEcho, e.appId]),
    [
      ["m.1", PSID, "Áo này còn size M không?", 0, false, null],
      ["m.2", PSID, "", 1, false, null],
      ["m.4", PSID, "Dạ còn ạ", 0, true, APP_ID],
      [`postback:${PSID}:1`, PSID, "Xem bảng giá", 0, false, null],
    ],
    "chữ · ảnh · tiếng vọng (PSID = người nhận) · nút bấm; bỏ nhãn dán / đã nhận / đã xem / tin xoá / page lạ",
  );
  assert.deepEqual(parseMessengerWebhook({ object: "instagram", entry: [] }), []);
  const feed = parseMessengerWebhook({
    object: "page",
    entry: [
      {
        id: PAGE,
        changes: [
          { field: "feed", value: { item: "comment", verb: "add", comment_id: "777_1", post_id: `${PAGE}_777`, from: { id: "5566770000001", name: "Chị Mai" }, message: "Cho giá ạ", created_time: 1790000000 } },
          { field: "feed", value: { item: "comment", verb: "add", comment_id: "777_2", post_id: `${PAGE}_777`, from: { id: PAGE }, message: "Shop inbox chị nhé" } },
          { field: "feed", value: { item: "comment", verb: "edited", comment_id: "777_3", post_id: `${PAGE}_777`, from: { id: "5566770000002" }, message: "sửa" } },
          { field: "feed", value: { item: "reaction", verb: "add", post_id: `${PAGE}_777`, from: { id: "5566770000003" } } },
        ],
      },
    ],
  });
  assert.deepEqual(
    feed.map((e) => [e.mid, e.psid, e.text, e.comment?.commentId, e.comment?.postId]),
    [["comment:777_1", "5566770000001", "Cho giá ạ", "777_1", `${PAGE}_777`]],
    "bình luận MỚI của khách ⇒ một sự kiện; bình luận của chính page, sửa bình luận, cảm xúc ⇒ bỏ",
  );
  const ig = parseMessengerWebhook({ object: "instagram", entry: [{ id: IG, messaging: [{ sender: { id: IGSID }, recipient: { id: IG }, timestamp: 2, message: { mid: "ig.m.1", text: "Áo này giá bao nhiêu?" } }, { sender: { id: IG }, recipient: { id: IGSID }, timestamp: 3, message: { mid: "ig.m.2", is_echo: true, text: "Dạ 359k ạ" } }] }] });
  assert.deepEqual(ig.map((e) => [e.platform, e.pageId, e.psid, e.isEcho, e.appId]), [["INSTAGRAM", IG, IGSID, false, null], ["INSTAGRAM", IG, IGSID, true, null]], "Instagram DM cùng khuôn; tiếng vọng Instagram không mang mã app");
  assert.deepEqual(parseMessengerWebhook({ object: "whatsapp_business_account", entry: [{ id: IG, messaging: [{ sender: { id: IGSID }, message: { mid: "w", text: "x" } }] }] }), [], "object lạ ⇒ không");
  const body = JSON.stringify(payload);
  assert.ok(verifyMessengerSignature(body, sign(body), APP_SECRET));
  assert.ok(verifyMessengerSignature(new TextEncoder().encode(body), sign(body).toUpperCase().replace("SHA256=", "sha256="), APP_SECRET), "hex hoa / byte đều nhận");
  assert.ok(!verifyMessengerSignature(body.replace("size M", "size L"), sign(body), APP_SECRET), "thân bị sửa ⇒ sai");
  assert.ok(!verifyMessengerSignature(body, sign(body, "khoa-khac"), APP_SECRET), "khoá khác ⇒ sai");
  for (const bad of [null, "", "sha1=abc", "sha256=zz"]) assert.ok(!verifyMessengerSignature(body, bad, APP_SECRET), `chữ ký «${String(bad)}» ⇒ sai`);
  assert.ok(!verifyMessengerSignature(body, sign(body, ""), ""), "không có app secret ⇒ không bao giờ đúng");
}

async function testPendingCookie() {
  const pages = [{ id: PAGE, name: "Shop A", token: PAGE_TOKEN, canMessage: true }];
  const sealed = await sealPendingPages(ORG, "u1", pages);
  assert.ok(!sealed.includes(PAGE_TOKEN) && !Buffer.from(sealed.split(".")[3] ?? "", "base64url").toString("latin1").includes("EAAG"), "token không đọc được trong cookie");
  assert.deepEqual(await openPendingPages(sealed, ORG, "u1"), pages);
  assert.equal(await openPendingPages(sealed, OTHER, "u1"), null, "tổ chức khác ⇒ không mở");
  assert.equal(await openPendingPages(sealed, ORG, "u2"), null, "người khác ⇒ không mở");
  assert.equal(await openPendingPages(`${sealed}x`, ORG, "u1"), null, "bị sửa ⇒ không mở");
}

type Call = { url: string; init?: RequestInit };

/** Graph giả: ghi mọi lời gọi; trả lời theo đường dẫn. */
function fakeGraph(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    if (u.pathname.endsWith("/oauth/access_token")) return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "LONG_USER_TOKEN_xyz123" }) : json({ access_token: "SHORT_USER_TOKEN_abc" });
    if (u.pathname.endsWith("/me/accounts"))
      return json({ data: [{ id: PAGE, name: "Shop Áo A", access_token: PAGE_TOKEN, tasks: ["MESSAGING", "ANALYZE"] }, { id: "1111111111", name: "Page chỉ xem", access_token: "EAAGviewonly0000000000", tasks: ["ANALYZE"] }] });
    if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) return json({ success: true });
    if (u.pathname.endsWith(`/${PAGE}`) && (u.searchParams.get("fields") ?? "").includes("instagram_business_account")) return json({ instagram_business_account: { id: IG, username: "shopaoa" }, id: PAGE });
    if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === PAGE_TOKEN) return json({ id: PAGE, name: "Shop Áo A" });
    if (u.pathname.endsWith("/me/messages")) return json({ recipient_id: PSID, message_id: `m.bot.${calls.length}` });
    if (u.pathname.endsWith(`/${PAGE}_777`) && u.searchParams.get("fields") === "message") return json({ id: `${PAGE}_777`, message: "ÁO SƠ MI LINEN — 359K, đủ size S M L" });
    return json({ error: { message: `không có ${u.pathname} — token ${u.searchParams.get("access_token") ?? ""}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function testGraph() {
  const app = { appId: APP_ID, appSecret: APP_SECRET };
  const g = fakeGraph();
  const got = await pagesFromCode(app, "CODE123", "https://erp.test/api/connect/messenger/callback", g.fetch);
  assert.ok("pages" in got, JSON.stringify(got));
  assert.deepEqual(got.pages.map((p) => [p.id, p.canMessage]), [[PAGE, true], ["1111111111", false]], "page không có quyền nhắn tin bị đánh dấu");
  const accounts = g.calls.find((c) => c.url.includes("/me/accounts"))!;
  assert.ok(accounts.url.includes("access_token=LONG_USER_TOKEN") && accounts.url.includes(`appsecret_proof=${appSecretProof("LONG_USER_TOKEN_xyz123", APP_SECRET)}`), "đọc page bằng token DÀI HẠN + appsecret_proof");
  assert.ok((await subscribePage(app, PAGE, PAGE_TOKEN, g.fetch)).ok);
  const sub = g.calls.at(-1)!;
  assert.ok(sub.init?.method === "POST" && sub.url.includes("subscribed_fields=messages%2Cmessaging_postbacks%2Cmessage_echoes") && sub.url.includes("appsecret_proof="));
  const sent = await sendMessengerText(app, PAGE_TOKEN, PSID, "Dạ shop chào chị", g.fetch);
  assert.ok(sent.ok);
  const body = JSON.parse(String(g.calls.at(-1)!.init?.body)) as { recipient: { id: string }; messaging_type: string; message: { text: string } };
  assert.deepEqual(body, { recipient: { id: PSID }, messaging_type: "RESPONSE", message: { text: "Dạ shop chào chị" } });
  const bad = await subscribePage(app, "9999999999", PAGE_TOKEN, g.fetch);
  assert.ok(!bad.ok && !bad.error.includes(PAGE_TOKEN) && !bad.error.includes(APP_SECRET), "token / app secret không lọt vào câu lỗi");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [ORG, OTHER]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
    await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, code));
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(code: string): Promise<SessionUser> {
  return withOrganization(code, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
    assert.ok(u);
    return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false }, modules: [...(await getEnabledModules(code))] };
  });
}

const botCalls: AiRequest[] = [];
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      botCalls.push(req);
      const text = req.tools.length ? "Dạ size M còn hàng ạ, chị lấy mấy cái ạ?" : "NONE";
      return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function testFlow() {
  // MỘT tổ chức thật (mỗi CSDL thử nằm trong bộ nhớ tới hết lượt kiểm — bộ kiểm đã mở >130 tổ chức); «tổ chức khác» chỉ cần
  // là CHỦ của một dòng chỉ mục page, không cần CSDL của nó.
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "Messenger@12345" }, source: "TEST", actor: null });
  const admin = await adminOf(ORG);
  const g = fakeGraph();
  const page = { id: PAGE, name: "Shop Áo A", token: PAGE_TOKEN, canMessage: true };

  await withOrganization(ORG, async () => {
    const r = await connectMessengerPage(admin, page, { fetch: g.fetch });
    assert.ok("ok" in r, JSON.stringify(r));
    assert.ok(g.calls.some((c) => c.url.includes(`/${PAGE}/subscribed_apps`)), "đăng ký webhook cho page");
    const row = await (await getDb()).query.orgConnections.findFirst({ where: eq(schema.orgConnections.connectorKey, "facebook-messenger") });
    assert.ok(row?.status === "ACTIVE" && !JSON.stringify(row).includes(PAGE_TOKEN), "bật; token chỉ nằm ở dạng mã hoá");
  });
  const idx = await (await getPlatformDb()).select().from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, PAGE));
  assert.equal(idx[0]?.orgCode, ORG, "chỉ mục page ⇒ tổ chức");
  const OTHER_PAGE = "5050505050";
  await (await getPlatformDb()).insert(schema.platformMessengerPages).values({ pageId: OTHER_PAGE, orgCode: OTHER, pageName: "Page của cửa hàng khác" });
  await withOrganization(ORG, async () => {
    const stolen = await connectMessengerPage(admin, { id: OTHER_PAGE, name: "Page của cửa hàng khác", token: PAGE_TOKEN, canMessage: true }, { fetch: g.fetch });
    assert.ok("error" in stolen && stolen.error.includes("cửa hàng khác"), "page đang thuộc tổ chức khác ⇒ từ chối, không cướp");
  });
  assert.equal((await (await getPlatformDb()).select().from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, OTHER_PAGE)))[0]?.orgCode, OTHER, "chỉ mục của tổ chức kia giữ nguyên");
  assert.equal(await resolveWebhookOrganization("MESSENGER", { pageId: PAGE }), ORG);
  await assert.rejects(resolveWebhookOrganization("MESSENGER", { pageId: "1234509876" }), WebhookAuthError, "page chưa nối ⇒ không rơi về nhà");
  await assert.rejects(resolveWebhookOrganization("MESSENGER"), WebhookAuthError);

  setSalesChatProviderForTests(() => fakeBot());
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }) } });
      const ev = (mid: string, text: string, extra: Partial<Parameters<typeof receiveMessengerEvent>[0]> = {}) => ({ platform: "MESSENGER" as const, pageId: PAGE, psid: PSID, mid, text, imageUrls: [], isEcho: false, appId: null, at: null, ...extra });
      assert.deepEqual(await receiveMessengerEvent(ev("m.1", "Áo này còn size M không?")), { queued: true, reason: "Đã nhận" });
      assert.equal((await receiveMessengerEvent(ev("m.1", "Áo này còn size M không?"))).queued, false, "Meta gửi lại ⇒ không nhận lần hai");
      const in31s = () => new Date(Date.now() + 31_000);
      const before = g.calls.length;
      const p1 = await processMessengerThread(PAGE, PSID, { fetch: g.fetch, now: in31s });
      assert.ok(p1.replies >= 1 && !p1.error, JSON.stringify(p1));
      const sends = g.calls.slice(before).filter((c) => c.url.includes("/me/messages"));
      assert.ok(sends.length >= 1 && sends.every((c) => c.url.includes("appsecret_proof=")), "trả lời qua Send API, kèm appsecret_proof");
      assert.match(String(sends[0].init?.body), /size M còn hàng/);
      // Tiếng vọng của CHÍNH bot (mã app nền tảng) ⇒ không phải nhân viên.
      assert.equal((await receiveMessengerEvent(ev("m.echo.1", "Dạ size M còn hàng ạ", { isEcho: true, appId: APP_ID }))).reason, "Tin của chính bot");
      // Người trả lời trong Hộp thư Meta (tiếng vọng không mang mã app nền tảng) khi bot đang trò chuyện ⇒ bot nhường.
      assert.match((await receiveMessengerEvent(ev("m.echo.2", "Chị đợi em check kho nhé", { isEcho: true, appId: "263902037430900" }))).reason, /bot nhường/);
      const conv = (await db.select().from(schema.salesChatConversations).where(and(eq(schema.salesChatConversations.channel, "FANPAGE"), eq(schema.salesChatConversations.threadId, PSID))))[0];
      assert.ok(conv?.status === "HANDOFF" && conv.pageId === PAGE, JSON.stringify(conv?.status));
      // Sổ sự kiện: hội thoại chuyển sang người ⇒ ĐÚNG MỘT `human.took_over` (như đường Pancake). Thiếu nó thì màn «Hiệu quả»
      // đếm hội thoại nhân viên đã cầm vào nhóm «AI tự làm». Tin thứ hai của nhân viên không ghi lại.
      await receiveMessengerEvent(ev("m.echo.3", "Có size M chị nhé", { isEcho: true, appId: "263902037430900" }));
      const took = await db.select().from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.conversationId, conv.id), eq(schema.salesConversationEvents.type, "human.took_over")));
      assert.ok(took.length === 1 && took[0].actorKind === "HUMAN" && took[0].reasonCode === "STAFF_REPLIED", JSON.stringify(took));
      await receiveMessengerEvent(ev("m.6", "ok em"));
      const p2 = await processMessengerThread(PAGE, PSID, { fetch: g.fetch, now: () => new Date(Date.now() + 62_000) });
      assert.ok(p2.replies === 0, `nhân viên đang trả lời ⇒ bot im: ${JSON.stringify(p2)}`);
      // INSTAGRAM DM: tài khoản Instagram doanh nghiệp gắn với page được nối cùng lượt; tin vào ⇒ bot trả lời qua Send API.
      assert.equal(await resolveWebhookOrganization("MESSENGER", { pageId: IG }), ORG, "mã Instagram cũng tra ra tổ chức");
      const igEv = (mid: string, text: string, extra: Partial<Parameters<typeof receiveMessengerEvent>[0]> = {}) => ({ platform: "INSTAGRAM" as const, pageId: IG, psid: IGSID, mid, text, imageUrls: [], isEcho: false, appId: null, at: null, ...extra });
      assert.deepEqual(await receiveMessengerEvent(igEv("ig.m.1", "Áo này giá bao nhiêu?")), { queued: true, reason: "Đã nhận" });
      const igBefore = g.calls.length;
      const pIg = await processMessengerThread(IG, IGSID, { fetch: g.fetch, now: in31s });
      assert.ok(pIg.replies >= 1 && !pIg.error, JSON.stringify(pIg));
      const igSend = g.calls.slice(igBefore).find((c) => c.url.includes("/me/messages"))!;
      assert.equal((JSON.parse(String(igSend.init?.body)) as { recipient: { id: string } }).recipient.id, IGSID, "trả lời đúng người gửi Instagram");
      const igBotMid = (await db.select().from(schema.salesChatInbound).where(and(eq(schema.salesChatInbound.threadId, IGSID), eq(schema.salesChatInbound.note, "BOT_SENT"))))[0]?.messageId;
      assert.ok(igBotMid, "mã tin bot gửi được ghi lại");
      assert.equal((await receiveMessengerEvent(igEv(igBotMid!, "Dạ size M còn hàng ạ", { isEcho: true }))).reason, "Tin của chính bot", "tiếng vọng Instagram (không mã app) nhận ra bằng mã tin");
      // ẢNH CỦA CÂU TRẢ LỜI MẪU: bot gửi chữ rồi ảnh (tải tệp kèm) qua Send API — trước đây chỉ ghi «chưa gửi».
      const PSID2 = "5566778899002";
      const qr = await saveQuickReply(admin, { title: "Bảng size", triggers: "bảng size", answer: "Dạ bảng size bên em đây ạ.", active: true });
      assert.ok("ok" in qr, JSON.stringify(qr));
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      assert.ok("ok" in (await addQuickReplyImages(admin, qr.id, [png])));
      await receiveMessengerEvent(ev("m.qr.1", "cho xem bảng size", { psid: PSID2 }));
      const qrBefore = g.calls.length;
      const pQr = await processMessengerThread(PAGE, PSID2, { fetch: g.fetch, now: in31s });
      assert.ok(pQr.replies >= 1 && !pQr.error, JSON.stringify(pQr));
      const qrCalls = g.calls.slice(qrBefore).filter((c) => c.url.includes("/me/messages"));
      assert.ok(qrCalls.length >= 2 && String(qrCalls[0].init?.body).includes("bảng size") && qrCalls[1].init?.body instanceof FormData, "chữ của câu mẫu rồi tới ảnh (multipart)");
      const imgForm = qrCalls[1].init?.body as FormData;
      assert.ok(String(imgForm.get("recipient")).includes(PSID2) && imgForm.get("filedata") instanceof Blob, "ảnh tới đúng khách, tải tệp kèm");
      // BÌNH LUẬN dưới bài viết ⇒ TIN RIÊNG (Private Replies) — bot đọc nội dung bài để hiểu «cho giá».
      const cev = { platform: "MESSENGER" as const, pageId: PAGE, psid: "5566770000001", mid: "comment:777_1", text: "Cho giá ạ", imageUrls: [], isEcho: false, appId: null, at: null, comment: { commentId: "777_1", postId: `${PAGE}_777` } };
      assert.deepEqual(await receiveMessengerEvent(cev), { queued: true, reason: "Đã nhận bình luận" });
      assert.equal((await receiveMessengerEvent(cev)).queued, false, "Meta gửi lại ⇒ không nhận lần hai");
      const cBefore = g.calls.length;
      const botBefore = botCalls.length;
      const pC = await processMessengerThread(PAGE, "comment:777_1", { fetch: g.fetch, now: in31s });
      assert.ok(pC.replies === 1 && !pC.error, JSON.stringify(pC));
      const pr = g.calls.slice(cBefore).filter((c) => c.url.includes("/me/messages"));
      assert.equal(pr.length, 1, "MỘT tin riêng cho một bình luận");
      assert.deepEqual((JSON.parse(String(pr[0].init?.body)) as { recipient: unknown }).recipient, { comment_id: "777_1" }, "trả lời riêng ĐÚNG bình luận, không công khai");
      assert.ok(botCalls.slice(botBefore).some((r) => r.system.includes("ÁO SƠ MI LINEN") && r.system.includes("BÌNH LUẬN DƯỚI BÀI VIẾT")), "lời nhắc có nội dung bài viết");
      // Tin của page KHÁC page đã nối ⇒ không nhận.
      assert.equal((await receiveMessengerEvent({ ...ev("m.7", "hi"), pageId: "5555555555" })).queued, false);
      // MỘT PAGE — MỘT ĐƯỜNG CANONICAL (channel-ownership.ts · 0232). Page NỐI MESSENGER TRƯỚC ⇒ đường chính đã lưu = Meta trực
      // tiếp (page mới ưu tiên Direct); CÙNG page bật thêm qua Pancake SAU ⇒ Messenger VẪN là đường kích AI, nối lại page được.
      const oc = schema.orgConnections;
      const modeRow = (await db.select().from(schema.channelPageModes).where(eq(schema.channelPageModes.pageId, PAGE)))[0];
      assert.ok(modeRow && modeRow.mode === "META_DIRECT" && modeRow.source === "CONNECT", `nối Messenger cho page mới ⇒ META_DIRECT: ${JSON.stringify(modeRow)}`);
      await db.insert(oc).values({ orgCode: ORG, connectorKey: "pancake-fanpage", status: "ACTIVE", settings: { pageId: PAGE }, lastTestOk: true });
      assert.equal((await receiveMessengerEvent(ev("m.direct.1", "Áo này còn không?"))).queued, true, "đường chính Meta trực tiếp ⇒ nhận dù Pancake cũng bật");
      // Page CÓ TỪ TRƯỚC 0232 (không dòng canonical) ⇒ LUẬT CŨ: Pancake thắng, đường Messenger nhường MỌI gói tin của page đó (không
      // hàng chờ, không hội thoại thứ hai) và không cho nối lại page ấy.
      await db.delete(schema.channelPageModes).where(eq(schema.channelPageModes.pageId, PAGE));
      const inboundBefore = (await db.select().from(schema.salesChatInbound)).length;
      assert.deepEqual(await receiveMessengerEvent(ev("m.dual.1", "Áo này còn không?")), { queued: false, reason: PANCAKE_OWNS_PAGE_REASON });
      assert.equal((await receiveMessengerEvent(ev("m.dual.2", "Dạ còn ạ", { isEcho: true, appId: "263902037430900" }))).reason, PANCAKE_OWNS_PAGE_REASON, "tiếng vọng cũng nhường — không ép hội thoại sang người");
      assert.equal((await db.select().from(schema.salesChatInbound)).length, inboundBefore, "không một dòng hàng chờ nào");
      const again = await connectMessengerPage(admin, page, { fetch: g.fetch });
      assert.ok("error" in again && again.error.includes("MỘT đường"), JSON.stringify(again));
      await db.delete(oc).where(eq(oc.connectorKey, "pancake-fanpage"));
      // Gỡ ⇒ chỉ mục mất ⇒ webhook của page không còn tới tổ chức.
      assert.ok("ok" in (await disconnectMessengerPage(admin)));
    });
  } finally {
    setSalesChatProviderForTests(null);
  }
  await assert.rejects(resolveWebhookOrganization("MESSENGER", { pageId: PAGE }), WebhookAuthError, "đã gỡ ⇒ page không còn thuộc tổ chức nào");
  await assert.rejects(resolveWebhookOrganization("MESSENGER", { pageId: IG }), WebhookAuthError, "đã gỡ ⇒ Instagram cũng hết");
}

export async function testMessenger() {
  testPure();
  await testPendingCookie();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  // Kênh Messenger ưu tiên app Messenger riêng khi đủ cặp — bài này đo đường của app đăng nhập, nên gỡ cặp kia (khôi phục ở finally).
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-messenger-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await testGraph();
    await cleanup();
    await testFlow();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ Messenger trực tiếp: gói webhook ⇒ sự kiện, chữ ký app, cookie page mã hoá theo tổ chức + người; Graph giả: token dài hạn, appsecret_proof, Send API; nối page (mã hoá, đăng ký webhook, bật), tổ chức khác không cướp được page, webhook theo mã page không rơi về nhà, bot trả lời qua Send API (Messenger lẫn Instagram DM, kèm ảnh câu mẫu), bình luận ⇒ tin riêng có ngữ cảnh bài viết, tiếng vọng của bot bỏ qua (theo mã app hoặc mã tin), người trong Hộp thư Meta ⇒ bot nhường, gỡ ⇒ hết nhận");
}
