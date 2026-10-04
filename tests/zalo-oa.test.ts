/**
 * KÊNH ZALO OA CHO CHATBOT BÁN HÀNG (lib/integrations/zalo · lib/sales-chatbot/zalo.ts).
 *
 * Phần THUẦN: chữ ký webhook trên THÂN THÔ (sửa một byte / sai khoá / header lạ ⇒ từ chối) · bóc sự kiện (tin khách, ảnh, tin
 * của chính OA, tương tác) · cửa sổ 48 giờ / 7 ngày · access token chỉ dùng khi ĐÚNG CẶP với refresh token đang lưu · phong bì
 * lỗi Zalo (HTTP 200 kèm `error ≠ 0`) · không câu lỗi nào mang bí mật.
 *
 * Phần TỔ CHỨC THẬT `zl-zalo` (Zalo GIẢ — luật 65, không gọi mạng):
 *  · «Kiểm tra» làm mới token và LƯU cặp mới NGAY — kể cả khi kiểm tra hỏng (OA khác): refresh token cũ đã bị Zalo huỷ;
 *  · lần làm mới sau gửi refresh token MỚI (chứng minh đã lưu); hai luồng cùng thấy token hết hạn ⇒ đúng MỘT lần làm mới;
 *  · nhật ký xoay vòng không mang token;
 *  · webhook: token sai ⇒ 401; kết nối chưa bật ⇒ 200 không nhận; chữ ký sai ⇒ 401;
 *  · tin khách ⇒ bot trả lời qua tin tư vấn đúng người; Zalo gửi lại ⇒ không nhận lần hai; tiếng vọng của bot ≠ nhân viên;
 *    nhân viên trả lời trong OA Manager ⇒ bot nhường 30 phút; ngoài 48 giờ ⇒ không gửi VÀ không gọi AI.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { parseZaloEvent, verifyZaloSignature, zaloSendText, zaloRefreshTokens, zaloWindow, ZALO_GET_OA_URL, ZALO_MESSAGE_CS_URL, ZALO_OAUTH_TOKEN_URL } from "@/lib/integrations/zalo/oa";
import { tokenPairOf, usableAccessToken } from "@/lib/integrations/zalo/token";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { webhookUrlToken } from "@/lib/platform/webhooks";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { OBSERVE_NOTE } from "@/lib/sales-chatbot/fanpage";
import { DEFAULT_MODE_CONFIG, OPERATING_MODE_SETTING_KEY } from "@/lib/sales-chatbot/operating-mode-shared";
import { processZaloThread, receiveZaloEvent, zaloAccessToken, zaloPageKey, zaloSetupView, ZALO_OUTSIDE_WINDOW, ZALO_STAFF_REASON } from "@/lib/sales-chatbot/zalo";
import { setSettingJson } from "@/lib/settings";
import { POST as zaloWebhook } from "@/app/api/webhooks/zalo-oa/[token]/route";

const ORG = "zl-zalo";
const ADMIN_EMAIL = "chu@zl-zalo.local";
const APP_ID = "1234567890123";
const OA_ID = "4321098765432109";
const APP_SECRET = "appSecretKiemThu_0123456789";
const OA_SECRET = "oaSecretKiemThu_abcdefghij";
const REFRESH0 = "ref_ban_dau_0123456789abcdefghij";
const USER = "8899776655443322";

function mac(appId: string, body: string, ts: string, key: string): string {
  return createHash("sha256").update(`${appId}${body}${ts}${key}`).digest("hex");
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function testPure() {
  // ── Chữ ký: trên THÂN THÔ ──
  const body = JSON.stringify({ event_name: "user_send_text", timestamp: "1759500000000", message: { text: "Chào shop", msg_id: "m1" } });
  const good = mac(APP_ID, body, "1759500000000", OA_SECRET);
  const v = (over: Partial<Parameters<typeof verifyZaloSignature>[0]>) => verifyZaloSignature({ appId: APP_ID, rawBody: body, timestamp: "1759500000000", oaSecretKey: OA_SECRET, header: `mac=${good}`, ...over });
  assert.equal(v({}), true, "chữ ký đúng ⇒ nhận");
  assert.equal(v({ header: good.toUpperCase() }), true, "không tiền tố «mac=», chữ hoa ⇒ vẫn là cùng chữ ký");
  assert.equal(v({ rawBody: body.replace("Chào", "Chao") }), false, "sửa thân ⇒ từ chối");
  assert.equal(v({ rawBody: JSON.stringify(JSON.parse(body), null, 1) }), false, "parse rồi dump lại ⇒ khác byte ⇒ từ chối (phải ký trên thân THÔ)");
  assert.equal(v({ oaSecretKey: APP_SECRET }), false, "App Secret KHÔNG phải khoá ký webhook");
  assert.equal(v({ timestamp: "1759500000001" }), false);
  for (const h of [null, "", "mac=", "mac=xyz", `mac=${good}00`]) assert.equal(v({ header: h }), false, `header lạ «${String(h)}» ⇒ từ chối`);
  assert.equal(v({ oaSecretKey: "" }), false, "chưa khai khoá ⇒ không bao giờ nhận");

  // ── Bóc sự kiện ──
  const cust = parseZaloEvent({ app_id: APP_ID, event_name: "user_send_text", timestamp: "1759500000000", sender: { id: USER }, recipient: { id: OA_ID }, message: { text: " Giá chả cá? ", msg_id: "m1" } });
  assert.deepEqual(cust, { kind: "CUSTOMER", oaId: OA_ID, userId: USER, msgId: "m1", text: "Giá chả cá?", imageUrls: [], at: new Date(1759500000000), eventName: "user_send_text" });
  const img = parseZaloEvent({ event_name: "user_send_image", sender: { id: USER }, recipient: { id: OA_ID }, message: { msg_id: "m2", attachments: [{ type: "image", payload: { url: "https://photo.zdn.vn/a.jpg" } }, { payload: { url: "http://x/b.jpg" } }] } });
  assert.ok(img.kind === "CUSTOMER" && img.imageUrls.length === 1 && img.text === "", "ảnh: chỉ nhận https");
  const echo = parseZaloEvent({ event_name: "oa_send_text", sender: { id: OA_ID }, recipient: { id: USER }, message: { text: "Dạ", msg_id: "z1" } });
  assert.ok(echo.kind === "OA_ECHO" && echo.userId === USER && echo.oaId === OA_ID, "tin của OA: hội thoại theo NGƯỜI NHẬN, không phải OA");
  assert.equal(parseZaloEvent({ event_name: "follow", follower: { id: USER }, oa_id: OA_ID }).kind, "INTERACTION");
  assert.equal(parseZaloEvent({ event_name: "user_send_text", sender: { id: USER }, message: { text: "a" } }).kind, "IGNORED", "thiếu msg_id ⇒ không chống trùng được ⇒ bỏ");
  assert.equal(parseZaloEvent({ event_name: "user_click_chatnow", sender: { id: USER } }).kind, "IGNORED");
  assert.equal(parseZaloEvent(null).kind, "IGNORED");
  assert.equal(parseZaloEvent([]).kind, "IGNORED");

  // ── Cửa sổ tin tư vấn ──
  const t0 = new Date("2026-10-04T00:00:00Z");
  const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
  assert.equal(zaloWindow(null, t0), "UNKNOWN", "chưa biết khách nhắn lúc nào ⇒ CHƯA BIẾT, không phải «trong cửa sổ»");
  assert.equal(zaloWindow(t0, h(48)), "FREE", "đúng 48 giờ vẫn miễn phí");
  assert.equal(zaloWindow(t0, new Date(h(48).getTime() + 1)), "PAID");
  assert.equal(zaloWindow(t0, h(7 * 24)), "PAID");
  assert.equal(zaloWindow(t0, h(7 * 24 + 1)), "CLOSED");

  // ── Access token chỉ dùng khi đúng cặp + còn hạn quá 2 phút ──
  const sec = { refreshToken: "ref_b_0123456789abcdefghij", accessToken: "acc_b", accessTokenExpiresAt: h(1).toISOString(), tokenPairOf: tokenPairOf("ref_b_0123456789abcdefghij") };
  assert.equal(usableAccessToken(sec, t0), "acc_b");
  assert.equal(usableAccessToken({ ...sec, refreshToken: "ref_nguoi_dan_moi_0123456789" }, t0), null, "người dán refresh token mới ⇒ access token cũ (OA cũ) không dùng nữa");
  assert.equal(usableAccessToken(sec, new Date(h(1).getTime() - 60_000)), null, "còn dưới 2 phút ⇒ làm mới trước");
  assert.equal(usableAccessToken({ ...sec, accessTokenExpiresAt: "" }, t0), null);

  // ── OAuth + gửi tin: phong bì, không lộ bí mật ──
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = await zaloRefreshTokens(
    { appId: APP_ID, appSecret: APP_SECRET, refreshToken: REFRESH0 },
    { fetch: async (url, init) => (calls.push({ url, init }), json({ access_token: "acc_1_0123456789abcdefghij", refresh_token: "ref_1_0123456789abcdefghij", expires_in: "3600" })), now: () => t0 },
  );
  assert.ok(ok.ok && ok.pair.refreshToken === "ref_1_0123456789abcdefghij" && ok.pair.expiresAt.getTime() === h(1).getTime());
  assert.equal(calls[0].url, ZALO_OAUTH_TOKEN_URL);
  assert.equal((calls[0].init.headers as Record<string, string>).secret_key, APP_SECRET, "App Secret đi bằng header secret_key");
  assert.match(String(calls[0].init.body), /grant_type=refresh_token/);
  const bad = await zaloRefreshTokens({ appId: APP_ID, appSecret: APP_SECRET, refreshToken: REFRESH0 }, { fetch: async () => json({ error: -14014, error_name: `Invalid refresh token ${REFRESH0}` }) });
  assert.ok(!bad.ok && !bad.error.includes(REFRESH0) && /API Explorer/.test(bad.error), "lỗi làm mới: che token, chỉ đường sửa");
  const sent = await zaloSendText({ accessToken: "acc_x_0123456789abcdef", userId: USER, text: "Dạ" }, { fetch: async () => json({ error: 0, message: "Success", data: { message_id: "zm1" } }) });
  assert.deepEqual(sent, { ok: true, messageId: "zm1" });
  const closed = await zaloSendText({ accessToken: "acc_x_0123456789abcdef", userId: USER, text: "Dạ" }, { fetch: async () => json({ error: -230, message: "User has not interacted with OA in the last 7 days" }) });
  assert.ok(!closed.ok && closed.window, "HTTP 200 kèm error -230 ⇒ lỗi NGOÀI CỬA SỔ, không phải lỗi kết nối");
  console.log("✓ Zalo OA · thuần: chữ ký trên thân thô · bóc sự kiện (tin khách / ảnh https / tiếng vọng OA / tương tác) · cửa sổ 48 giờ – 7 ngày · access token đúng cặp · phong bì lỗi · che bí mật");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
  assert.ok(u);
  const org = await findOrganization(ORG);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: org?.name ?? ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
}

/** Zalo giả: đếm lượt làm mới, cấp cặp mới mỗi lượt; OA trả về đổi được; gửi tin trả mã tin tăng dần. */
function fakeZalo() {
  const st = { refreshes: [] as string[], oaId: OA_ID, sends: [] as { userId: string; text: string; token: string }[], n: 0 };
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    if (url === ZALO_OAUTH_TOKEN_URL) {
      const used = new URLSearchParams(String(init.body)).get("refresh_token") ?? "";
      st.refreshes.push(used);
      const k = st.refreshes.length;
      return json({ access_token: `acc_${k}_0123456789abcdefghij`, refresh_token: `ref_${k}_0123456789abcdefghij`, expires_in: "3600" });
    }
    if (url === ZALO_GET_OA_URL) return json({ error: 0, message: "Success", data: { oa_id: st.oaId, name: "Shop Zalo thử" } });
    if (url === ZALO_MESSAGE_CS_URL) {
      const b = JSON.parse(String(init.body)) as { recipient: { user_id: string }; message: { text: string } };
      st.sends.push({ userId: b.recipient.user_id, text: b.message.text, token: (init.headers as Record<string, string>).access_token });
      return json({ error: 0, message: "Success", data: { message_id: `zm-${++st.n}` } });
    }
    return new Response("không có", { status: 404 });
  };
  return { st, fetch: fetchImpl };
}

function textProvider(counter: { calls: number }): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      counter.calls += 1;
      const content: AiBlock[] = [{ type: "text", text: `Dạ shop chào chị ạ, chị cần tư vấn món nào ạ? (${counter.calls})` }];
      return { content, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function webhookCall(token: string, body: string, signature: string | null): Promise<Response> {
  const req = new NextRequest(`http://erp.test/api/webhooks/zalo-oa/${token}`, { method: "POST", body, headers: { "content-type": "application/json", ...(signature ? { "x-zevent-signature": signature } : {}) } });
  return zaloWebhook(req, { params: Promise.resolve({ token }) });
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const admin = await adminOf();
    const zalo = fakeZalo();
    const token = webhookUrlToken("ZALO_OA", ORG);
    assert.ok(token?.startsWith(`${ORG}.`));

    // ── Lưu + kiểm tra: token làm mới được LƯU NGAY, kể cả khi kiểm tra hỏng ──
    const saved = await saveConnection(admin, { connectorKey: "zalo-oa", settings: { appId: APP_ID, oaId: OA_ID }, secrets: { appSecret: APP_SECRET, oaSecretKey: OA_SECRET, refreshToken: REFRESH0 } });
    assert.ok("ok" in saved, JSON.stringify(saved));
    zalo.st.oaId = "1111111111111";
    const wrongOa = await testOrgConnection(admin, "zalo-oa", { tester: { fetch: zalo.fetch } });
    assert.ok("error" in wrongOa && /khác OA ID đã khai/.test(wrongOa.error), JSON.stringify(wrongOa));
    assert.deepEqual(zalo.st.refreshes, [REFRESH0], "làm mới đúng một lần, bằng refresh token người dán");
    zalo.st.oaId = OA_ID;
    const passed = await testOrgConnection(admin, "zalo-oa", { tester: { fetch: zalo.fetch } });
    assert.ok("ok" in passed, JSON.stringify(passed));
    assert.equal(zalo.st.refreshes.length, 1, "lần kiểm tra thứ hai dùng access token ĐÃ LƯU — không làm mới (refresh token cũ đã bị Zalo huỷ)");
    const rot = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORG_CONNECTION_TOKEN_ROTATE"));
    assert.equal(rot.length, 1);
    assert.ok(!JSON.stringify(rot).includes("0123456789abcdefghij") && !JSON.stringify(rot).includes(REFRESH0), "nhật ký xoay vòng chỉ có gợi ý ••••, không có token");

    // ── Webhook trước khi bật: token sai ⇒ 401; token đúng ⇒ 200 nhưng không nhận gì ──
    const ev = (msgId: string, text: string, name = "user_send_text", ts = String(Date.now())) =>
      JSON.stringify({ app_id: APP_ID, event_name: name, timestamp: ts, ...(name.startsWith("oa_send") ? { sender: { id: OA_ID }, recipient: { id: USER } } : { sender: { id: USER }, recipient: { id: OA_ID } }), message: { text, msg_id: msgId } });
    const b0 = ev("m-0", "Alo");
    const ts0 = (JSON.parse(b0) as { timestamp: string }).timestamp;
    assert.equal((await webhookCall(`${token!.slice(0, -1)}${token!.endsWith("A") ? "B" : "A"}`, b0, `mac=${mac(APP_ID, b0, ts0, OA_SECRET)}`)).status, 401, "token sai ⇒ 401");
    const notActive = await webhookCall(token!, b0, `mac=${mac(APP_ID, b0, ts0, OA_SECRET)}`);
    assert.equal(notActive.status, 200);
    assert.match(JSON.stringify(await notActive.json()), /chưa bật/);
    assert.ok("ok" in (await setConnectionStatus(admin, "zalo-oa", "ACTIVE")));
    assert.equal((await webhookCall(token!, b0, `mac=${mac(APP_ID, b0, ts0, APP_SECRET)}`)).status, 401, "ký bằng App Secret ⇒ 401");
    assert.equal((await webhookCall(token!, b0, null)).status, 401, "không chữ ký ⇒ 401");
    assert.equal((await db.select().from(schema.salesChatInbound)).length, 0, "không gói nào lọt vào hàng chờ");

    // ── Token: hai luồng cùng thấy hết hạn ⇒ đúng MỘT lần làm mới, bằng refresh token MỚI ĐÃ LƯU ──
    const later = () => new Date(Date.now() + 2 * 3_600_000);
    const [a, b] = await Promise.all([zaloAccessToken({ fetch: zalo.fetch, now: later }), zaloAccessToken({ fetch: zalo.fetch, now: later })]);
    assert.ok(a.ok && b.ok && a.token === b.token, JSON.stringify([a, b]));
    assert.deepEqual(zalo.st.refreshes, [REFRESH0, "ref_1_0123456789abcdefghij"], "làm mới lần hai gửi refresh token Zalo vừa cấp — chứng minh cặp mới đã lưu; hai luồng ⇒ một lần");

    // ── Tin khách ⇒ bot trả lời qua tin tư vấn ──
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });
    const ai = { calls: 0 };
    setSalesChatProviderForTests(() => textProvider(ai));
    try {
      const soon = () => new Date(Date.now() + 10_000);
      assert.deepEqual(await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("m-1", "Chả cá bao nhiêu shop?")))), { queued: true, reason: "Đã nhận", userId: USER });
      assert.equal((await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("m-1", "Chả cá bao nhiêu shop?"))))).queued, false, "Zalo gửi lại ⇒ không nhận lần hai");
      const early = await processZaloThread(USER, { fetch: zalo.fetch });
      assert.ok(early.processed === 0 && /gõ xong/.test(early.skipped ?? ""), "chưa đủ 4 giây ⇒ đợi khách gõ tiếp");
      const r1 = await processZaloThread(USER, { fetch: zalo.fetch, now: soon });
      assert.ok(r1.processed === 1 && r1.replies === 1 && !r1.error, JSON.stringify(r1));
      assert.equal(zalo.st.sends.length, 1);
      assert.equal(zalo.st.sends[0].userId, USER, "trả lời ĐÚNG người dùng Zalo");
      assert.match(zalo.st.sends[0].text, /shop chào chị/);
      const conv = await db.query.salesChatConversations.findFirst({ where: eq(schema.salesChatConversations.channel, "ZALO") });
      assert.ok(conv && conv.pageId === zaloPageKey(OA_ID) && conv.threadId === USER && conv.lastBotAt && conv.lastCustomerAt);

      // Tiếng vọng: đúng mã tin bot vừa gửi ⇒ tin của bot; khác mã nhưng nguyên văn trong 10 phút ⇒ vẫn của bot.
      assert.equal((await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("zm-1", zalo.st.sends[0].text, "oa_send_text"))))).reason, "Tin của chính bot");
      assert.equal((await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("zm-khac", zalo.st.sends[0].text, "oa_send_text"))))).reason, "Tin của chính bot");
      // Nhân viên trả lời trong OA Manager ⇒ bot nhường.
      assert.match((await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("zm-nv", "Chị ơi em là Lan bên shop, chả cá 180k/kg ạ", "oa_send_text"))))).reason, /bot nhường/);
      assert.equal((await db.query.salesChatConversations.findFirst({ where: eq(schema.salesChatConversations.id, conv.id) }))?.handoffReason, ZALO_STAFF_REASON);
      // Sổ sự kiện: kênh ZALO; tin khách / bot trả lời / nhân viên nhận đều có dòng.
      const evs = await db.select({ type: schema.salesConversationEvents.type, channel: schema.salesConversationEvents.channel }).from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, conv.id));
      assert.ok(evs.length > 0 && evs.every((e) => e.channel === "ZALO"), JSON.stringify(evs));
      for (const t of ["message.received", "ai.replied", "human.took_over"]) assert.ok(evs.some((e) => e.type === t), `thiếu sự kiện ${t}: ${JSON.stringify(evs.map((e) => e.type))}`);
      await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("m-2", "Ok lấy 2kg"))));
      const held = await processZaloThread(USER, { fetch: zalo.fetch, now: soon });
      assert.equal(held.skipped, ZALO_STAFF_REASON, JSON.stringify(held));
      assert.equal(zalo.st.sends.length, 1, "nhân viên đang trả lời ⇒ bot không chen");
      // Quá 30 phút ⇒ bot nhận lại.
      await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("m-3", "Shop ơi còn không"))));
      const back = await processZaloThread(USER, { fetch: zalo.fetch, now: () => new Date(Date.now() + 31 * 60_000) });
      assert.ok(back.replies === 1, JSON.stringify(back));

      // Chế độ QUAN SÁT (cổng chung với fanpage): ghi tin, KHÔNG gọi AI, KHÔNG gửi; trả về TỰ ĐỘNG ⇒ bot trả lời lại.
      await setSettingJson(OPERATING_MODE_SETTING_KEY, { ...DEFAULT_MODE_CONFIG, mode: "OBSERVE" });
      await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("m-obs", "Shop ơi"))));
      const aiObs = ai.calls;
      const sendsObs = zalo.st.sends.length;
      const observed = await processZaloThread(USER, { fetch: zalo.fetch, now: () => new Date(Date.now() + 40 * 60_000) });
      assert.equal(observed.skipped, OBSERVE_NOTE, JSON.stringify(observed));
      assert.ok(ai.calls === aiObs && zalo.st.sends.length === sendsObs, "quan sát ⇒ không tốn AI, không gửi");
      await setSettingJson(OPERATING_MODE_SETTING_KEY, DEFAULT_MODE_CONFIG);

      // Ngoài 48 giờ: không gửi VÀ không gọi AI.
      await receiveZaloEvent(parseZaloEvent(JSON.parse(ev("m-4", "Alo"))));
      const callsBefore = ai.calls;
      const sendsBefore = zalo.st.sends.length;
      const stale = await processZaloThread(USER, { fetch: zalo.fetch, now: () => new Date(Date.now() + 49 * 3_600_000) });
      assert.equal(stale.skipped, ZALO_OUTSIDE_WINDOW, JSON.stringify(stale));
      assert.equal(ai.calls, callsBefore, "ngoài cửa sổ ⇒ không tốn tiền AI cho câu không gửi được");
      assert.equal(zalo.st.sends.length, sendsBefore);
      const skipped = await db.select().from(schema.salesChatInbound).where(and(eq(schema.salesChatInbound.messageId, "zalo:m-4")));
      assert.equal(skipped[0]?.status, "SKIPPED");

      const view = await zaloSetupView(ORG);
      assert.ok(view.status === "ACTIVE" && view.oaId === OA_ID && view.webhookUrl?.endsWith(`/api/webhooks/zalo-oa/${token}`), JSON.stringify(view));
      assert.ok(view.counts.done >= 2 && view.counts.skipped >= 2, JSON.stringify(view.counts));
      const rows = await db.select().from(schema.salesChatInbound).where(like(schema.salesChatInbound.pageId, "zalo:%"));
      assert.ok(rows.every((r) => !r.text.includes(APP_SECRET) && !r.text.includes("acc_")), "không token nào nằm trong sổ tin");
    } finally {
      setSalesChatProviderForTests(null);
    }
  });
  console.log("✓ Zalo OA · tổ chức thật: kiểm tra lưu cặp token mới ngay (kể cả khi hỏng) · hai luồng ⇒ một lần làm mới · nhật ký không mang token · webhook 401 khi sai token / sai chữ ký · trả lời đúng người · chống trùng · tiếng vọng ≠ nhân viên · nhân viên ⇒ nhường 30 phút · ngoài 48 giờ không gửi, không gọi AI");
}

export async function testZaloOa() {
  await testPure();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-zalo-oa-0123456789abcdefghijklmnopqrstuvwxyz";
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop Zalo thử", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "ZaloOa@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
  }
}
