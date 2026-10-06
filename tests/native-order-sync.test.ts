/**
 * ═══════════ SHOP CHỈ NỐI FACEBOOK TRỰC TIẾP — KHÔNG MỘT LỜI GỌI PANCAKE (gap analysis N1 + N2) ═══════════
 *
 * Khoá:
 *  · N1 — GHI ĐƠN TỪ HỘI THOẠI cho Messenger trực tiếp: nhân viên chat tay (bot tắt), khách tự gửi SĐT + địa chỉ ⇒ máy lên đơn
 *    «Mới» đọc tin từ CHÍNH sổ `sales_chat_inbound` (không qua Pancake), giá từ ERP; chạy lại không đơn thứ hai. Bot bật + hội thoại
 *    AUTO ⇒ đơn là việc của bot (không ghi); hội thoại ở chế độ AI gợi ý ⇒ người phụ trách ⇒ máy ghi.
 *  · Hồ sơ hội thoại dựng từ sổ tin: tin shop trùng liền nhau gộp một, dòng ghi sẵn (`bot-out:` / `staff-out:`) không làm mã tin,
 *    SĐT «đã ghi nhận» chỉ lấy từ tin của KHÁCH.
 *  · N2 — trọn đường nhận tin → bot trả lời → nhân viên gửi → tạo đơn trong chat → máy ghi đơn: `fetch` giả đếm host ⇒ 0 lời gọi
 *    tới `pages.fm` (Pancake) ở mọi bước; Send API của Meta có được gọi.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createOrderFromChatCore } from "@/lib/records/chat-order";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import { connectMessengerPage, processMessengerThread, receiveMessengerEvent } from "@/lib/sales-chatbot/messenger";
import { inboundThreadProfile, runFanpageOrderSync, saveOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";
import { ORDER_SYNC_CHANNEL } from "@/lib/sales-chatbot/order-sync-shared";

const ORG = "chi-facebook";
const APP_ID = "777000777888";
const APP_SECRET = "app-secret-native-test-0123456789abcd";
const PAGE = "4059687183";
const PAGE_TOKEN = "EAAGpagetoken_native_0123456789abcdef";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;

/** Mạng giả: Graph của Meta trả lời; MỌI host khác được ghi lại — bài kiểm đòi 0 lời gọi tới Pancake. */
function fakeNet() {
  const hosts: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    hosts.push(u.host);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.host !== "graph.facebook.com") return json({ success: false, message: "không được gọi host này" }, 500);
    if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) return json({ success: true });
    if (u.pathname.endsWith(`/${PAGE}`)) return json({ id: PAGE });
    if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === PAGE_TOKEN) return json({ id: PAGE, name: "Shop Chỉ Facebook" });
    if (u.pathname.endsWith("/me/messages")) return json({ recipient_id: "x", message_id: `m.out.${hosts.length}` });
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, pancakeCalls: () => hosts.filter((h) => h.endsWith("pages.fm")).length, graphCalls: () => hosts.filter((h) => h === "graph.facebook.com").length };
}

function fakeAi(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      // Lượt bot (có công cụ) ⇒ một câu trả lời; máy ghi đơn (không công cụ) ⇒ JSON đơn mới chỉ vào tin cuối của khách.
      const prompt = req.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("")).join("");
      if (!req.tools.length && prompt.includes("0977 111 222"))
        return { content: [{ type: "text", text: JSON.stringify({ kind: "NEW_ORDER", items: [{ variant_id: "erp-nf-v", quantity: 1 }], recipient_name: "Mai", recipient_phone: "0977111222", address: "7 Trần Phú, Hà Đông, Hà Nội", agreement_index: 2, summary: "Chốt 1kg" }) }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
      const text = req.tools.length
        ? "Dạ chả mực 400k/1kg ạ, chị lấy mấy kg ạ?"
        : JSON.stringify({ kind: "NEW_ORDER", items: [{ variant_id: "erp-nf-v", quantity: 2 }], recipient_name: "Lan", recipient_phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", agreement_index: 3, summary: "Chốt 2kg chả mực" });
      return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testFlow() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "ChiFacebook@123" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  const net = fakeNet();
  setSalesChatProviderForTests(() => fakeAi());
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view", "ai_sales:reply", "orders:create", "orders:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: enabled } as unknown as SessionUser;
      await db.insert(schema.products).values({ id: "erp-nf-p", name: "Chả mực giã tay", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-nf-v", productId: "erp-nf-p", sku: "CHA-MUC", size: "1kg", retailPrice: 400_000 });
      const setBot = (on: boolean) => {
        const v = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: on });
        return db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: v }).onConflictDoUpdate({ target: schema.settings.key, set: { value: v } });
      };
      const conn = await connectMessengerPage(admin, { id: PAGE, name: "Shop Chỉ Facebook", token: PAGE_TOKEN, canMessage: true }, { fetch: net.fetch });
      assert.ok("ok" in conn, JSON.stringify(conn));
      assert.equal((await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "pancake-fanpage"))).length, 0, "không có kết nối Pancake nào");

      const t = schema.salesChatInbound;
      const c = schema.salesChatConversations;
      const t0 = Date.now();
      const min = (m: number) => new Date(t0 + m * 60_000);
      const ev = (psid: string, mid: string, text: string) => ({ platform: "MESSENGER" as const, pageId: PAGE, psid, mid, text, imageUrls: [], isEcho: false, appId: null, at: null });
      assert.ok("ok" in (await saveOrderSyncConfig(admin, true, min(-120))));
      // Tin khách ghi THẲNG vào sổ với mốc cụ thể (webhook ghi đúng hình này — đường nhận thật chạy ở phần N2 bên dưới).
      const cust = (psid: string, mid: string, text: string, at: Date) => db.insert(t).values({ pageId: PAGE, threadId: psid, messageId: mid, text, customerName: "Lan Nguyễn", status: "SKIPPED", note: "Bot tắt", createdAt: at });

      // ═══ Hồ sơ hội thoại từ sổ tin (thuần trên CSDL) ═══
      await db.insert(t).values([
        { pageId: PAGE, threadId: "p-1", messageId: "p1", text: "Cho chị 1kg", status: "DONE", createdAt: min(-60) },
        { pageId: PAGE, threadId: "p-1", messageId: "bot-out:x", text: "Dạ 400k ạ", status: "DONE", note: "BOT_SENT", createdAt: min(-59) },
        { pageId: PAGE, threadId: "p-1", messageId: "m.bot.1", text: "Dạ 400k ạ", status: "DONE", note: "BOT_SENT", createdAt: min(-59) },
        { pageId: PAGE, threadId: "p-1", messageId: "staff-out:abc:0", text: "Chị gửi SĐT 0987000111 cho em nhé", status: "DONE", note: "PAGE_REPLY", createdAt: min(-58) },
        { pageId: PAGE, threadId: "p-1", messageId: "p2", text: "0912 345 678 nhé em", status: "DONE", createdAt: min(-57) },
      ]);
      const prof = await inboundThreadProfile(PAGE, "p-1", min(0), min(0), { priorMessages: 20, priorChars: 300, pages: 1 });
      assert.deepEqual(prof.prior.map((m) => [m.from, m.id ?? null]), [["customer", "p1"], ["shop", "m.bot.1"], ["shop", null], ["customer", "p2"]], `bản trùng của tin bot gộp một và giữ mã tin thật; dòng ghi sẵn không làm mã tin: ${JSON.stringify(prof.prior)}`);
      assert.deepEqual(prof.phones, ["0912345678"], "SĐT «đã ghi nhận» chỉ từ tin của KHÁCH (SĐT shop gõ không tính)");
      assert.deepEqual(prof.fbIds, []);
      await db.delete(t).where(eq(t.threadId, "p-1"));

      // ═══ N1 · bot TẮT, nhân viên chat tay, khách tự gửi SĐT + địa chỉ ⇒ máy lên đơn ═══
      await setBot(false);
      const A = "8100000000001";
      await cust(A, "a.1", "Shop ơi cho chị 2kg chả mực", min(-30));
      await db.insert(t).values({ pageId: PAGE, threadId: A, messageId: "a.staff", text: "Dạ chị cho em xin SĐT và địa chỉ ạ", status: "DONE", note: "PAGE_REPLY", createdAt: min(-29) });
      await cust(A, "a.2", "Lan 0912 345 678, 12 Hàng Bạc, Hoàn Kiếm, Hà Nội", min(-28));
      const r1 = await runFanpageOrderSync({ fetch: net.fetch, now: () => min(0) });
      assert.deepEqual([r1.checked, r1.created, r1.errors], [1, 1, 0], JSON.stringify(r1));
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.source, ORDER_SYNC_CHANNEL));
      assert.equal(orders.length, 1);
      assert.deepEqual([orders[0].stage, orders[0].shipPhone, orders[0].totalPriceAfterDiscount], ["NEW", "0912345678", 800_000], "đơn «Mới», SĐT của khách, giá đọc từ ERP");
      assert.ok(orders[0].note.includes("Mã tin fanpage: a.2"), orders[0].note);
      const r2 = await runFanpageOrderSync({ fetch: net.fetch, now: () => min(1) });
      assert.equal(r2.created, 0, "chạy lại ⇒ không đơn thứ hai");
      assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.source, ORDER_SYNC_CHANNEL))).length, 1);

      // ═══ Bot BẬT: hội thoại AUTO là việc của bot; hội thoại ở chế độ AI gợi ý ⇒ người phụ trách ⇒ máy ghi ═══
      await setBot(true);
      const B = "8100000000002";
      const C = "8100000000003";
      await cust(B, "b.1", "Shop ơi cho chị 2kg chả mực", min(-20));
      await cust(B, "b.2", "Lan 0912 345 678, 12 Hàng Bạc, Hoàn Kiếm, Hà Nội", min(-18));
      // C là một khách KHÁC (khách A vừa có đơn ⇒ lời chốt cùng SĐT trước đơn đó bị mốc cắt chặn — đúng luật chống trùng).
      await cust(C, "cc.1", "Shop ơi cho chị 1kg chả mực", min(-20));
      await cust(C, "cc.2", "Mai 0977 111 222, 7 Trần Phú, Hà Đông, Hà Nội", min(-18));
      // Hội thoại phải tồn tại để đổi chế độ: mở qua lượt ghi đơn đầu (máy ghi «BOT» cho cả hai).
      await runFanpageOrderSync({ fetch: net.fetch, now: () => min(2) });
      const convC = (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.threadId, C))))[0];
      assert.ok(convC, "hội thoại C đã mở");
      assert.ok((await setConversationControlCore(admin, convC.id, "COPILOT")).ok);
      const r3 = await runFanpageOrderSync({ fetch: net.fetch, now: () => min(3) });
      const convB = (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.threadId, B))))[0];
      assert.equal((convB.state as { orderSync?: { lastOutcome?: string } }).orderSync?.lastOutcome, "BOT", "bot bật + AUTO ⇒ đơn là việc của bot");
      assert.ok(r3.created >= 1, `chế độ AI gợi ý ⇒ người phụ trách ⇒ máy ghi đơn: ${JSON.stringify(r3)}`);
      const convC2 = (await db.select().from(c).where(eq(c.id, convC.id)))[0];
      assert.equal((convC2.state as { orderSync?: { lastOutcome?: string } }).orderSync?.lastOutcome, "CREATED");

      // ═══ N2 · trọn đường: nhận → bot trả lời → nhân viên gửi → tạo đơn trong chat — 0 lời gọi Pancake ═══
      const D = "8100000000004";
      await receiveMessengerEvent(ev(D, "d.1", "Chả mực bao nhiêu shop?"));
      const graphBefore = net.graphCalls();
      const pd = await processMessengerThread(PAGE, D, { fetch: net.fetch, now: () => new Date(Date.now() + 31_000) });
      assert.ok(pd.replies >= 1 && !pd.error, `bot trả lời qua Send API: ${JSON.stringify(pd)}`);
      const convD = (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.threadId, D))))[0];
      const staff = await sendStaffReplyCore(admin, convD.id, { text: "Dạ chị cho em xin SĐT ạ", requestKey: "req-native-0001" }, { fetch: net.fetch });
      assert.ok(staff.ok, JSON.stringify(staff));
      const chatOrder = await createOrderFromChatCore(admin, convD.id, { requestKey: "req-native-order-01", name: "Hoa", phone: "0987654321", address: "5 Lê Lợi, Huế", province: "Thừa Thiên Huế", stage: "NEW", lines: [{ variantId: "erp-nf-v", quantity: 1, unitPrice: 400_000 }] });
      assert.ok(chatOrder.ok, JSON.stringify(chatOrder));
      assert.ok(net.graphCalls() > graphBefore, "bot + nhân viên đi qua Send API của Meta");
      assert.equal(net.pancakeCalls(), 0, "KHÔNG một lời gọi nào tới Pancake (pages.fm) ở mọi bước");
    });
  } finally {
    setSalesChatProviderForTests(null);
  }
}

export async function testNativeOrderSync() {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  // Kênh Messenger ưu tiên app Messenger riêng khi đủ cặp — bài này đo đường của app đăng nhập, nên gỡ cặp kia (khôi phục ở finally).
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-chi-facebook-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await cleanup();
    await testFlow();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ Shop chỉ nối Facebook trực tiếp: ghi đơn từ hội thoại đọc sổ tin của ERP (không Pancake) — bot tắt ⇒ máy lên đơn «Mới» giá ERP, chạy lại không trùng; bot bật + AUTO ⇒ việc của bot; AI gợi ý ⇒ người phụ trách ⇒ máy ghi; hồ sơ hội thoại gộp bản trùng, SĐT chỉ từ tin khách; trọn đường nhận → bot → nhân viên → đơn trong chat → ghi đơn: 0 lời gọi pages.fm");
}
