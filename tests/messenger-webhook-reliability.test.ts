/**
 * ═══════════ MESSENGER TRỰC TIẾP — ĐỘ BỀN WEBHOOK (M4, 21/10/2026, kiểm toán M2 của code-erp-01) ═══════════
 *
 * Khoá:
 *  1. P0 MẤT TIN: tra page ⇒ tổ chức gặp lỗi CSDL thì KHÔNG được coi là «page lạ». `resolvePageOrganization` ném (trừ bảng chưa
 *     có — máy chưa migrate), route trả 503 để Meta gửi lại; page lạ THẬT vẫn 200 (Meta không cần gửi lại thứ không ai nhận).
 *  2. P1 TỐN CREDIT: lần gửi gần nhất bị Meta báo token hỏng (190) ⇒ lượt sau KHÔNG gọi AI cho page đó (cùng luật màn Kênh kết
 *     nối hiện «cần nối lại»); nối lại ⇒ bot chạy tiếp. Trạng thái page (lựa chọn của người) không bị đổi.
 *  3. P1 CUỘC ĐUA: hai cửa hàng nối cùng page cùng lúc ⇒ bên thua nhận lỗi «vừa được nối với cửa hàng khác», dòng page của bên
 *     thua bị hoàn, chỉ mục giữ chủ thật — không báo «Đã nối» giả.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { listChannelPages } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { resolvePageOrganization } from "@/lib/platform/webhooks";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { connectMessengerPages, messengerPageNeedsReconnect, PAGE_NEEDS_RECONNECT_NOTE, processMessengerThread, receiveMessengerEvent } from "@/lib/sales-chatbot/messenger";
import { POST } from "@/app/api/webhooks/messenger/route";

const ORG = "msg-rel";
const OTHER = "msg-rel-khac";
const APP_ID = "777000222444";
const APP_SECRET = "app-secret-messenger-rel-0123456789";
const PAGE = "3000000001";
const RACE = "3000000002";
const TOKENS: Record<string, string> = { [PAGE]: "EAAGtokenREL_page_0123456789abcdef", [RACE]: "EAAGtokenREL_race_0123456789abcdef" };
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;

let aiCalls = 0;
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      if (req.tools.length) aiCalls += 1;
      return { content: [{ type: "text", text: req.tools.length ? "Dạ shop chào chị ạ" : "NONE" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

/** Graph giả: `tokenDead` ⇒ Send API trả 190; `onSubscribe` chạy ĐÚNG lúc page được đăng ký (để dựng cuộc đua). */
function fakeGraph(state: { tokenDead: boolean; permDenied?: boolean; onSubscribe?: (pageId: string) => Promise<void> }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const tok = u.searchParams.get("access_token") ?? "";
    if (u.pathname.endsWith("/subscribed_apps")) {
      const id = u.pathname.split("/").at(-2) ?? "";
      if (state.onSubscribe) await state.onSubscribe(id);
      return json({ success: true });
    }
    if ((u.searchParams.get("fields") ?? "").includes("instagram_business_account")) return json({ id: "x" });
    if (u.pathname.endsWith("/me") && Object.values(TOKENS).includes(tok)) return json({ id: Object.keys(TOKENS).find((k) => TOKENS[k] === tok), name: "Page" });
    if (u.pathname.endsWith("/me/messages")) {
      if (state.tokenDead) return json({ error: { message: "Error validating access token: The session has been invalidated", type: "OAuthException", code: 190 } }, 400);
      if (state.permDenied) return json({ error: { message: "(#10) Không có quyền gửi tin", code: 10 } }, 400);
      return json({ recipient_id: "psid", message_id: `m.bot.${Date.now()}` });
    }
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
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

/** Gói webhook Meta ký bằng app secret — đúng khuôn route kiểm. */
function signedPost(pageId: string, mid: string): NextRequest {
  const body = JSON.stringify({ object: "page", entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: "4000000099" }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text: "Shop ơi" } }] }] });
  const sig = `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
  return new NextRequest("https://erp.example.test/api/webhooks/messenger", { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
}

export async function testMessengerWebhookReliability() {
  await cleanup();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-do-ben-webhook-0123456789abcdefghijklmnopqrstuvwxyz";
  setSalesChatProviderForTests(() => fakeBot());
  const pdb = await getPlatformDb();
  try {
    await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "DoBenWebhook@12345" }, source: "TEST", actor: null });

    // ── 1 · P0: lỗi CSDL khi tra page ≠ page lạ ──
    assert.equal(await resolvePageOrganization("3999999999"), null, "page lạ THẬT ⇒ null");
    assert.equal(await resolvePageOrganization("abc"), null, "mã page sai khuôn ⇒ null");
    await pdb.insert(schema.platformMessengerPages).values({ pageId: PAGE, orgCode: ORG, pageName: "Page thử" });
    assert.equal(await resolvePageOrganization(PAGE), ORG);
    const unknownRes = await POST(signedPost("3999999999", "m.rel.unknown"));
    assert.equal(unknownRes.status, 200, "page lạ THẬT ⇒ 200 (Meta không cần gửi lại)");
    await pdb.execute(sql`ALTER TABLE platform_messenger_pages RENAME COLUMN org_code TO org_code_tam`);
    try {
      await assert.rejects(() => resolvePageOrganization(PAGE), "lỗi CSDL (cột hỏng) ⇒ NÉM, không giả làm page lạ");
      const res = await POST(signedPost(PAGE, "m.rel.dbfail"));
      assert.equal(res.status, 503, "không tra được page ⇒ 503 để Meta gửi lại (200 = tin mất hẳn)");
    } finally {
      await pdb.execute(sql`ALTER TABLE platform_messenger_pages RENAME COLUMN org_code_tam TO org_code`);
    }
    await pdb.execute(sql`ALTER TABLE platform_messenger_pages RENAME TO platform_messenger_pages_tam`);
    try {
      assert.equal(await resolvePageOrganization(PAGE), null, "bảng chưa có (máy chưa migrate) ⇒ null như cũ");
    } finally {
      await pdb.execute(sql`ALTER TABLE platform_messenger_pages_tam RENAME TO platform_messenger_pages`);
    }
    await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, PAGE));

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] } as unknown as SessionUser;
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }) } });
      const state: { tokenDead: boolean; permDenied?: boolean; onSubscribe?: (pageId: string) => Promise<void> } = { tokenDead: false };
      const g = fakeGraph(state);
      const later = () => new Date(Date.now() + 120_000);
      const ev = (mid: string) => ({ platform: "MESSENGER" as const, pageId: PAGE, psid: "psid-rel", mid, text: "Shop ơi áo còn không", imageUrls: [], isEcho: false, appId: null, at: null });

      // ── 2 · P1: token chết ⇒ lượt sau không gọi AI ──
      const c1 = await connectMessengerPages(admin, [{ id: PAGE, name: "Page thử", token: TOKENS[PAGE], canMessage: true }], { fetch: g });
      assert.ok("ok" in c1 && c1.connected.includes(PAGE), JSON.stringify(c1));
      assert.equal(await messengerPageNeedsReconnect(PAGE), false, "page mới nối ⇒ không cần nối lại");
      state.tokenDead = true;
      await receiveMessengerEvent(ev("m.rel.1"));
      aiCalls = 0;
      await processMessengerThread(PAGE, "psid-rel", { fetch: g, now: later });
      assert.ok(aiCalls >= 1, "lượt đầu chưa biết token chết ⇒ có gọi AI (rồi gửi hỏng)");
      assert.equal(await messengerPageNeedsReconnect(PAGE), true, `Meta báo 190 ⇒ page «cần nối lại»: ${JSON.stringify((await listChannelPages("facebook-messenger")).map((x) => x.lastError))}`);
      await receiveMessengerEvent(ev("m.rel.2"));
      aiCalls = 0;
      const p2 = await processMessengerThread(PAGE, "psid-rel", { fetch: g, now: later });
      assert.equal(aiCalls, 0, "page cần nối lại ⇒ KHÔNG gọi AI (không tốn credit)");
      assert.equal(p2.skipped, PAGE_NEEDS_RECONNECT_NOTE);
      assert.equal((await db.select().from(schema.salesChatInbound).where(eq(schema.salesChatInbound.messageId, "m.rel.2")))[0]?.note, PAGE_NEEDS_RECONNECT_NOTE, "tin vẫn được giữ, ghi rõ vì sao bot không nói");
      assert.equal((await listChannelPages("facebook-messenger")).find((x) => x.pageId === PAGE)?.status, "ACTIVE", "trạng thái page (lựa chọn của người) KHÔNG bị đổi");
      // Nối lại ⇒ last_error xoá ⇒ bot chạy tiếp.
      state.tokenDead = false;
      assert.ok("ok" in (await connectMessengerPages(admin, [{ id: PAGE, name: "Page thử", token: TOKENS[PAGE], canMessage: true }], { fetch: g })));
      assert.equal(await messengerPageNeedsReconnect(PAGE), false, "nối lại ⇒ hết «cần nối lại»");
      await receiveMessengerEvent(ev("m.rel.3"));
      aiCalls = 0;
      const p3 = await processMessengerThread(PAGE, "psid-rel", { fetch: g, now: later });
      assert.ok(aiCalls >= 1 && p3.replies === 1, `nối lại ⇒ bot trả lời lại: ${JSON.stringify(p3)}`);
      // CỐ Ý chỉ TOKEN: thiếu quyền (mã 10) có thể tự hết mà không ai nối lại ⇒ KHÔNG được chặn AI (bot im vĩnh viễn là lỗi tệ hơn).
      state.permDenied = true;
      await receiveMessengerEvent(ev("m.rel.4"));
      await processMessengerThread(PAGE, "psid-rel", { fetch: g, now: later });
      state.permDenied = false;
      assert.match((await listChannelPages("facebook-messenger")).find((x) => x.pageId === PAGE)?.lastError ?? "", /quyền/, "lỗi thiếu quyền được ghi vào sức khoẻ page");
      assert.equal(await messengerPageNeedsReconnect(PAGE), false, "lỗi PERMISSION KHÔNG chặn AI — chỉ token chết mới chặn");

      // ── 3 · P1: cuộc đua nối cùng page ──
      state.onSubscribe = async (pageId) => {
        if (pageId === RACE) await pdb.insert(schema.platformMessengerPages).values({ pageId: RACE, orgCode: OTHER, pageName: "Cửa hàng khác nối trước một nhịp" }).onConflictDoNothing();
      };
      const race = await connectMessengerPages(admin, [{ id: RACE, name: "Page tranh", token: TOKENS[RACE], canMessage: true }], { fetch: g });
      state.onSubscribe = undefined;
      assert.ok("error" in race && /vừa được nối với một cửa hàng khác/.test(race.error), `bên thua cuộc đua phải nhận lỗi, không «Đã nối»: ${JSON.stringify(race)}`);
      assert.equal((await pdb.select().from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, RACE)))[0]?.orgCode, OTHER, "chỉ mục giữ đúng chủ thật");
      const raceRow = (await listChannelPages("facebook-messenger")).find((x) => x.pageId === RACE);
      assert.ok(!raceRow || raceRow.status === "DISABLED", `dòng page của bên thua bị hoàn: ${JSON.stringify(raceRow)}`);
    });
    console.log("✓ Messenger độ bền webhook: lỗi CSDL khi tra page ⇒ 503 (Meta gửi lại), page lạ thật ⇒ 200 · token 190 ⇒ lượt sau không gọi AI, nối lại chạy tiếp · cuộc đua nối cùng page ⇒ bên thua nhận lỗi, chỉ mục giữ chủ thật");
  } finally {
    setSalesChatProviderForTests(null);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, RACE));
    await cleanup();
  }
}
