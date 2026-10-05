/**
 * ═══════════ MỘT TỔ CHỨC — NHIỀU FACEBOOK PAGE (0217 · org_channel_pages · docs/messaging-providers.md §7) ═══════════
 *
 * Khoá:
 *  · một lượt cấp quyền nối NHIỀU page; page thuộc cửa hàng khác bị bỏ, các page còn lại vẫn nối (lỗi page này không chặn page kia);
 *  · mỗi page một token mã hoá RIÊNG (AAD gắn page — chép bản mã sang page khác không giải được), không token nào ở dạng rõ;
 *  · tin của page nào vào ĐÚNG page đó; bot trả lời bằng token của ĐÚNG page;
 *  · tạm dừng AI ở page B ⇒ B im (tin vẫn vào hộp thư), A vẫn trả lời; lỗi gửi ở B ghi vào sức khoẻ của B, không đụng A;
 *  · gỡ RIÊNG page B ⇒ A chạy tiếp, chỉ mục webhook của B mất;
 *  · tổ chức nối TRƯỚC bản này (chỉ có hàng kết nối đơn) vẫn nhận / gửi như cũ, và bật / tắt AI được theo page.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { listChannelPages, openChannelPageToken } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { inboxPages, listInbox } from "@/lib/sales-chatbot/inbox";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { savePageOverride } from "@/lib/sales-chatbot/page-config";
import { connectMessengerPages, disconnectMessengerPage, messengerView, PAGE_AI_OFF_NOTE, processMessengerThread, receiveMessengerEvent, setMessengerPagesAi } from "@/lib/sales-chatbot/messenger";

const ORG = "msg-multi";
const OTHER = "msg-multi-khac";
const APP_ID = "777000111333";
const APP_SECRET = "app-secret-messenger-multi-0123456789";
const PAGES = { A: "2000000001", B: "2000000002", C: "2000000003" } as const;
const TOKENS: Record<string, string> = { [PAGES.A]: "EAAGtokenA_multipage_0123456789abcdef", [PAGES.B]: "EAAGtokenB_multipage_0123456789abcdef", [PAGES.C]: "EAAGtokenC_multipage_0123456789abcdef" };
const IG_A = "17841400000000077";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;

type Call = { url: string; init?: RequestInit };

/** Graph giả cho nhiều page: page B gửi tin hỏng khi `failB` bật. */
function fakeGraph(state: { failB: boolean }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    const tok = u.searchParams.get("access_token") ?? "";
    if (u.pathname.endsWith("/subscribed_apps")) return json({ success: true });
    if ((u.searchParams.get("fields") ?? "").includes("instagram_business_account")) return u.pathname.endsWith(`/${PAGES.A}`) ? json({ id: PAGES.A, instagram_business_account: { id: IG_A, username: "shopa" } }) : json({ id: "x" });
    if (u.pathname.endsWith("/me") && Object.values(TOKENS).includes(tok)) return json({ id: Object.keys(TOKENS).find((k) => TOKENS[k] === tok), name: "Page" });
    if (u.pathname.endsWith("/me/messages")) {
      if (state.failB && tok === TOKENS[PAGES.B]) return json({ error: { message: "(#10) Không có quyền gửi tin", code: 10 } }, 400);
      return json({ recipient_id: "psid", message_id: `m.bot.${calls.length}` });
    }
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const systems: { system: string }[] = [];
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      if (req.tools.length) systems.push({ system: typeof req.system === "string" ? req.system : JSON.stringify(req.system) });
      return { content: [{ type: "text", text: req.tools.length ? "Dạ shop chào chị ạ" : "NONE" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
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

export async function testMessengerMultiPage() {
  await cleanup();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-nhieu-page-0123456789abcdefghijklmnopqrstuvwxyz";
  setSalesChatProviderForTests(() => fakeBot());
  try {
    await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "NhieuPage@12345" }, source: "TEST", actor: null });
    const pdb = await getPlatformDb();
    // Page C đang thuộc một cửa hàng khác trên nền tảng.
    await pdb.insert(schema.platformMessengerPages).values({ pageId: PAGES.C, orgCode: OTHER, pageName: "Page của cửa hàng khác" });
    const state = { failB: false };
    const g = fakeGraph(state);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] } as unknown as SessionUser;
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }) } });

      // ── Một lượt cấp quyền, ba page: C thuộc cửa hàng khác ⇒ bỏ; A + B vẫn nối ──
      const r = await connectMessengerPages(admin, Object.entries(PAGES).map(([k, id]) => ({ id, name: `Page ${k}`, token: TOKENS[id], canMessage: true })), { fetch: g.fetch });
      assert.ok("ok" in r && r.connected.join() === `${PAGES.A},${PAGES.B}` && r.failed.length === 1 && r.failed[0].id === PAGES.C && /cửa hàng khác/.test(r.failed[0].error), JSON.stringify(r));
      const rows = await listChannelPages("facebook-messenger");
      assert.deepEqual(rows.map((x) => [x.pageId, x.kind, x.status]).sort(), [[IG_A, "INSTAGRAM", "ACTIVE"], [PAGES.A, "PAGE", "ACTIVE"], [PAGES.B, "PAGE", "ACTIVE"]].sort());
      const idx = await pdb.select().from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, ORG));
      assert.deepEqual(idx.map((x) => x.pageId).sort(), [IG_A, PAGES.A, PAGES.B].sort(), "chỉ mục webhook cho từng page (nối thêm không xoá page đã nối)");
      assert.equal((await pdb.select().from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, PAGES.C)))[0]?.orgCode, OTHER, "page của cửa hàng khác giữ nguyên chủ");

      // ── Token riêng từng page, không dạng rõ; bản mã chép sang page khác KHÔNG giải được (AAD gắn page) ──
      const raw = await db.select().from(schema.orgChannelPages);
      assert.ok(!JSON.stringify(raw, (_k, v) => (v && typeof v === "object" && v.type === "Buffer" ? Buffer.from(v.data).toString("latin1") : v)).includes("EAAGtoken"), "không token nào ở dạng rõ");
      const tA = await openChannelPageToken("facebook-messenger", PAGES.A);
      const tB = await openChannelPageToken("facebook-messenger", PAGES.B);
      assert.ok(tA.ok && tA.token === TOKENS[PAGES.A] && tB.ok && tB.token === TOKENS[PAGES.B]);
      const rowB = raw.find((x) => x.pageId === PAGES.B)!;
      await db.update(schema.orgChannelPages).set({ secretsEnc: rowB.secretsEnc, secretsKeyId: rowB.secretsKeyId }).where(eq(schema.orgChannelPages.pageId, PAGES.A));
      const swapped = await openChannelPageToken("facebook-messenger", PAGES.A);
      assert.ok(!swapped.ok && /giải mã/.test(swapped.reason), `token của B chép sang hàng A không mở được: ${JSON.stringify(swapped)}`);
      const rowA = raw.find((x) => x.pageId === PAGES.A)!;
      await db.update(schema.orgChannelPages).set({ secretsEnc: rowA.secretsEnc, secretsKeyId: rowA.secretsKeyId }).where(eq(schema.orgChannelPages.pageId, PAGES.A));

      // ── Tin của page nào vào ĐÚNG page; bot trả lời bằng token của ĐÚNG page ──
      const ev = (pageId: string, psid: string, mid: string, text: string) => ({ platform: "MESSENGER" as const, pageId, psid, mid, text, imageUrls: [], isEcho: false, appId: null, at: null });
      assert.equal((await receiveMessengerEvent(ev(PAGES.A, "psid-a", "mp.a1", "Shop ơi áo còn không"))).queued, true);
      assert.equal((await receiveMessengerEvent(ev(PAGES.B, "psid-b", "mp.b1", "Cho mình hỏi giá"))).queued, true);
      assert.equal((await receiveMessengerEvent(ev(PAGES.C, "psid-c", "mp.c1", "alo"))).queued, false, "page chưa nối ⇒ không nhận");
      const later = () => new Date(Date.now() + 120_000);
      const pA = await processMessengerThread(PAGES.A, "psid-a", { fetch: g.fetch, now: later });
      const pB = await processMessengerThread(PAGES.B, "psid-b", { fetch: g.fetch, now: later });
      assert.ok(pA.replies === 1 && pB.replies === 1, JSON.stringify({ pA, pB }));
      const sends = g.calls.filter((c) => c.url.includes("/me/messages"));
      assert.deepEqual(sends.map((c) => new URL(c.url).searchParams.get("access_token")), [TOKENS[PAGES.A], TOKENS[PAGES.B]], "mỗi câu trả lời đi bằng token của đúng page");
      const convPages = (await db.select({ pageId: schema.salesChatConversations.pageId, threadId: schema.salesChatConversations.threadId }).from(schema.salesChatConversations)).map((c) => `${c.pageId}:${c.threadId}`).sort();
      assert.deepEqual(convPages, [`${PAGES.A}:psid-a`, `${PAGES.B}:psid-b`], "mỗi hội thoại mang đúng page của nó");
      assert.ok((await listChannelPages("facebook-messenger")).find((x) => x.pageId === PAGES.A)?.lastEventAt, "page có tin ⇒ mốc tin gần nhất");

      // ── Tạm dừng AI ở B ⇒ B im (tin vẫn vào hàng chờ / hộp thư), A vẫn trả lời ──
      assert.ok("ok" in (await setMessengerPagesAi(admin, [PAGES.B], false)));
      await receiveMessengerEvent(ev(PAGES.B, "psid-b", "mp.b2", "Còn size M không"));
      await receiveMessengerEvent(ev(PAGES.A, "psid-a", "mp.a2", "Size L còn không"));
      const pB2 = await processMessengerThread(PAGES.B, "psid-b", { fetch: g.fetch, now: later });
      const pA2 = await processMessengerThread(PAGES.A, "psid-a", { fetch: g.fetch, now: later });
      assert.ok(pB2.replies === 0 && pB2.skipped === PAGE_AI_OFF_NOTE && pA2.replies === 1, JSON.stringify({ pB2, pA2 }));
      assert.equal((await db.select().from(schema.salesChatInbound).where(eq(schema.salesChatInbound.messageId, "mp.b2")))[0]?.note, PAGE_AI_OFF_NOTE, "tin vẫn được giữ, ghi rõ vì sao bot không nói");

      // ── Lỗi gửi ở B ghi vào sức khoẻ của B, không đụng A ──
      assert.ok("ok" in (await setMessengerPagesAi(admin, [PAGES.B], true)));
      state.failB = true;
      await receiveMessengerEvent(ev(PAGES.B, "psid-b", "mp.b3", "Shop ơi"));
      await processMessengerThread(PAGES.B, "psid-b", { fetch: g.fetch, now: later });
      state.failB = false;
      const health = await listChannelPages("facebook-messenger");
      assert.ok(/Không có quyền gửi tin/.test(health.find((x) => x.pageId === PAGES.B)?.lastError ?? "") && health.find((x) => x.pageId === PAGES.A)?.lastError === null, JSON.stringify(health.map((x) => [x.pageId, x.lastError])));

      // ── CẤU HÌNH AI THEO PAGE: page B có tên bot + chỉ dẫn riêng ⇒ lượt của B mang chúng; lượt của A vẫn cấu hình chung ──
      assert.ok("ok" in (await savePageOverride(admin, PAGES.B, { botName: "Bot Thời Trang B", extraInstructions: "Page B chỉ bán váy" })));
      assert.ok("error" in (await savePageOverride(admin, "9999999999", { botName: "Bot lạ" })), "page không thuộc tổ chức ⇒ từ chối");
      systems.length = 0;
      await receiveMessengerEvent(ev(PAGES.B, "psid-b", "mp.b9", "Váy này còn không"));
      await receiveMessengerEvent(ev(PAGES.A, "psid-a", "mp.a9", "Còn hàng không"));
      await processMessengerThread(PAGES.B, "psid-b", { fetch: g.fetch, now: later });
      await processMessengerThread(PAGES.A, "psid-a", { fetch: g.fetch, now: later });
      assert.ok(systems.length === 2 && systems[0].system.includes("Bot Thời Trang B") && systems[0].system.includes("Page B chỉ bán váy"), "lời nhắc của page B mang cấu hình riêng");
      assert.ok(!systems[1].system.includes("Bot Thời Trang B") && !systems[1].system.includes("Page B chỉ bán váy"), "page A không nhiễm cấu hình của page B");
      assert.ok("ok" in (await savePageOverride(admin, PAGES.B, null)), "bỏ phần đè ⇒ B dùng lại cấu hình chung");

      // ── HỘP THƯ CHUNG: mọi page ở một danh sách, mỗi hội thoại mang tên page; chọn một page = LỌC, không phải hộp thư thứ hai ──
      const all = await listInbox(admin, {});
      assert.ok(all.ok, JSON.stringify(all));
      const byPage = Object.fromEntries(all.rows.map((x) => [x.pageId, x.pageName]));
      assert.deepEqual(byPage, { [PAGES.A]: "Page A", [PAGES.B]: "Page B" }, `tên page trên từng hội thoại: ${JSON.stringify(byPage)}`);
      const onlyA = await listInbox(admin, { page: PAGES.A });
      assert.ok(onlyA.ok && onlyA.rows.length === 1 && onlyA.rows[0].pageId === PAGES.A && onlyA.counts.ALL === 1, JSON.stringify(onlyA.ok ? onlyA.counts : onlyA));
      assert.ok((await inboxPages()).some((x) => x.id === PAGES.A && x.name === "Page A"));
      // ── CHỈ SỐ THEO PAGE: cùng công thức, page chỉ là chiều lọc — «mọi page» = A + B ──
      const perfAll = await loadAiSalesPerformance(ORG, { withMoney: false });
      const perfA = await loadAiSalesPerformance(ORG, { withMoney: false, pageId: PAGES.A });
      const perfB = await loadAiSalesPerformance(ORG, { withMoney: false, pageId: PAGES.B });
      assert.ok(perfA.cohorts.total.conversations === 1 && perfB.cohorts.total.conversations === 1 && perfAll.cohorts.total.conversations === 2, JSON.stringify([perfAll.cohorts.total, perfA.cohorts.total, perfB.cohorts.total]));
      assert.equal((await loadAiSalesPerformance(ORG, { withMoney: false, pageId: "9999999999" })).cohorts.total.conversations, 0, "page lạ ⇒ 0 hội thoại, không phải mọi page");

      // ── Gỡ RIÊNG B ⇒ A chạy tiếp; chỉ mục webhook của B mất ──
      assert.ok("ok" in (await disconnectMessengerPage(admin, PAGES.B)));
      assert.equal((await receiveMessengerEvent(ev(PAGES.B, "psid-b", "mp.b4", "alo"))).queued, false, "page đã gỡ ⇒ không nhận");
      assert.equal((await receiveMessengerEvent(ev(PAGES.A, "psid-a", "mp.a3", "alo"))).queued, true, "page khác vẫn nhận");
      assert.deepEqual((await pdb.select().from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, ORG))).map((x) => x.pageId).sort(), [IG_A, PAGES.A].sort());
      const view = await messengerView();
      assert.ok(view.pages.find((p) => p.id === PAGES.B)?.status === "DISABLED" && view.page?.id === PAGES.A, JSON.stringify(view.pages.map((p) => [p.id, p.status])));

      // ── Tổ chức nối TRƯỚC 0217: chỉ có hàng kết nối đơn (không hàng page) ⇒ vẫn nhận / gửi; bật / tắt AI theo page được ──
      await db.delete(schema.orgChannelPages).where(and(eq(schema.orgChannelPages.connectorKey, "facebook-messenger"), eq(schema.orgChannelPages.pageId, PAGES.A)));
      await db.delete(schema.orgChannelPages).where(eq(schema.orgChannelPages.pageId, IG_A));
      assert.equal((await receiveMessengerEvent(ev(PAGES.A, "psid-a", "mp.a4", "Shop ơi"))).queued, true, "page của hàng kết nối đơn cũ vẫn nhận");
      const legacyView = await messengerView();
      assert.ok(legacyView.pages.find((p) => p.id === PAGES.A)?.legacy === true, JSON.stringify(legacyView.pages));
      assert.ok("ok" in (await setMessengerPagesAi(admin, [PAGES.A], false)), "page cũ nhận cờ AI (hàng được dựng, không token)");
      const pLegacy = await processMessengerThread(PAGES.A, "psid-a", { fetch: g.fetch, now: later });
      assert.equal(pLegacy.skipped, PAGE_AI_OFF_NOTE);
      assert.ok("ok" in (await setMessengerPagesAi(admin, [PAGES.A], true)));
      await receiveMessengerEvent(ev(PAGES.A, "psid-a", "mp.a5", "Còn hàng không"));
      const before = g.calls.filter((c) => c.url.includes("/me/messages")).length;
      const pLegacy2 = await processMessengerThread(PAGES.A, "psid-a", { fetch: g.fetch, now: later });
      const last = g.calls.filter((c) => c.url.includes("/me/messages")).slice(before);
      assert.ok(pLegacy2.replies >= 1 && last.every((c) => new URL(c.url).searchParams.get("access_token") === TOKENS[PAGES.A]), "page cũ vẫn gửi bằng token ở hàng kết nối đơn");
    });
  } finally {
    setSalesChatProviderForTests(null);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ Nhiều page một tổ chức: một lượt cấp quyền nối nhiều page (page của cửa hàng khác bị bỏ, page còn lại vẫn nối) · token riêng từng page, không dạng rõ, chép bản mã sang page khác không giải được · tin và câu trả lời đi đúng page / đúng token · tạm dừng AI một page không đụng page khác · lỗi gửi ghi vào sức khoẻ của đúng page · hộp thư chung mọi page kèm tên page, lọc một page chỉ còn page đó · chỉ số theo page cùng công thức (mọi page = cộng các page) · gỡ riêng một page · tổ chức nối trước bản này vẫn chạy và bật / tắt AI theo page được");
}
