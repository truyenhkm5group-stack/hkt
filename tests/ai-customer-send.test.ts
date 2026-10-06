import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { readAiCustomerCounts, resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { parsePancakeWebhook, processFanpageThread, receiveFanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ ĐỒNG HỒ KHÁCH AI TRÊN ĐƯỜNG GỬI THẬT (0226 · docs/saas/PRICING_V1.md §II.2) ═══════════
 *
 * Chạy ĐƯỜNG THẬT của bot fanpage (receiveFanpageEvent → processFanpageThread → engine → gửi Pancake) với Pancake giả và
 * provider AI giả. Đặc tả: một khách AI = khách đã nhận ÍT NHẤT MỘT câu trả lời do AI SINH RA và đã gửi THÀNH CÔNG.
 *  · câu MẪU theo từ khoá (không gọi model) ⇒ 0 khách AI;
 *  · câu AI gửi thành công ⇒ 1; trả lời tiếp cùng khách ⇒ vẫn 1;
 *  · gửi hỏng ⇒ 0 (khách chưa nhận câu nào).
 * Mốc đi theo đồng hồ thật (luật 50 / 65).
 */

const ORG = "aicm-send";
const ADMIN_EMAIL = "chu@aicm-send.local";
const PAGE = "6677889900";
const PAGE_TOKEN = "pancake_page_token_aicm_0123456789abcdef";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  await pdb.delete(schema.platformUsageEvents).where(eq(schema.platformUsageEvents.orgCode, ORG));
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, ORG));
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    if (org.accountId) {
      const still = await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.accountId, org.accountId)).limit(1);
      if (!still.length) await pdb.delete(schema.platformAccounts).where(eq(schema.platformAccounts.id, org.accountId));
    }
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [ORG]));
  invalidateOrganizations();
  invalidateCapabilities();
  resetAiCustomerSeenForTests();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
  assert.ok(u);
  const org = await findOrganization(ORG);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: org?.name ?? ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
}

async function run() {
  const st = { calls: 0 };
  const provider: AiProvider = {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      st.calls += 1;
      return { content: [{ type: "text", text: "Dạ chả cá thu bên em 280k/kg ạ, anh/chị lấy mấy ký ạ?" }], stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
  const count = async () => (await readAiCustomerCounts([ORG], usagePeriodOf(new Date()).from, new Date(Date.now() + 120_000))).get(ORG) ?? 0;
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const admin = await adminOf();
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
    await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false });
    await db.insert(schema.salesChatQuickReplies).values({ title: "Giờ mở cửa", triggers: ["mở cửa mấy giờ", "giờ mở cửa"], answer: "Dạ shop mở cửa từ 8h đến 22h hằng ngày ạ.", active: true });
    const posts: string[] = [];
    let sendFails = false;
    const pancakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = { success: true };
      if (url.includes("/conversations?")) body = { success: true, conversations: [{ id: "c1" }] };
      else if (init?.method === "POST") {
        if (sendFails) body = { success: false, message: "Pancake không nhận tin: conversation_id not found" };
        else {
          posts.push(String(init.body));
          body = { success: true, id: `m-bot-${posts.length}` };
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } })));
    assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancakeFetch } })));
    assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
    setSalesChatProviderForTests(() => provider);
    const ev = (id: string, text: string, thread: string) => parsePancakeWebhook({ event_type: "messaging", page_id: PAGE, data: { conversation: { id: thread, type: "INBOX" }, message: { id, type: "INBOX", message: text, from: { id: `cust-${thread}`, name: "Chị Hoa" } } } })!;
    const later = (sec: number) => () => new Date(Date.now() + sec * 1000);

    // 1 · CÂU MẪU theo từ khoá (không gọi model) ⇒ khách nhận câu, nhưng KHÔNG phải khách AI.
    assert.ok((await receiveFanpageEvent(ev("q-m1", "shop mở cửa mấy giờ", "q-t1"))).queued);
    const r1 = await processFanpageThread(PAGE, "q-t1", { fetch: pancakeFetch, now: later(31) });
    assert.ok(r1.replies >= 1 && !r1.error, JSON.stringify(r1));
    assert.equal(st.calls, 0, "câu mẫu theo từ khoá không gọi model");
    assert.equal(posts.length, 1);
    assert.equal(await count(), 0, "câu mẫu ⇒ 0 khách AI");

    // 2 · Câu AI gửi THÀNH CÔNG ⇒ 1 khách AI; trả lời tiếp cùng khách ⇒ vẫn 1.
    assert.ok((await receiveFanpageEvent(ev("a-m1", "Chả cá thu bao nhiêu em?", "a-t1"))).queued);
    const r2 = await processFanpageThread(PAGE, "a-t1", { fetch: pancakeFetch, now: later(31) });
    assert.ok(r2.replies >= 1 && !r2.error && st.calls >= 1, JSON.stringify(r2));
    assert.equal(await count(), 1, "câu AI tới khách ⇒ 1 khách AI");
    assert.ok((await receiveFanpageEvent(ev("a-m2", "Ship về Hải Phòng mất bao lâu?", "a-t1"))).queued);
    const r3 = await processFanpageThread(PAGE, "a-t1", { fetch: pancakeFetch, now: later(120) });
    assert.ok(r3.replies >= 1 && !r3.error, JSON.stringify(r3));
    assert.equal(await count(), 1, "cùng khách trả lời tiếp trong kỳ ⇒ vẫn 1");

    // 3 · Gửi HỎNG ⇒ khách chưa nhận câu AI nào ⇒ không đếm.
    sendFails = true;
    const callsBefore = st.calls;
    assert.ok((await receiveFanpageEvent(ev("f-m1", "Còn hàng không em?", "f-t1"))).queued);
    const r4 = await processFanpageThread(PAGE, "f-t1", { fetch: pancakeFetch, now: later(31) });
    assert.ok(r4.error && st.calls > callsBefore, JSON.stringify(r4));
    assert.equal(await count(), 1, "gửi hỏng ⇒ 0 khách AI mới");
    sendFails = false;
    const conv = (await db.select().from(schema.salesChatConversations).where(and(eq(schema.salesChatConversations.threadId, "f-t1"))))[0];
    assert.ok(conv, "hội thoại gửi hỏng vẫn tồn tại — chỉ không được đếm");
  });
}

export async function testAiCustomerSend() {
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-khach-ai-0123456789abcdefghijklmnopqrstuvwxyz";
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Shop đồng hồ khách AI", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "KhachAi@2026!" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    setSalesChatProviderForTests(null);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
  console.log("✓ Đồng hồ khách AI (đường fanpage thật): câu mẫu theo từ khoá ⇒ 0 · câu AI gửi thành công ⇒ 1 · trả lời tiếp cùng khách ⇒ vẫn 1 · gửi hỏng ⇒ không đếm");
}
