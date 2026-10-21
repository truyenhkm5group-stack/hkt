/**
 * ═══════════ VÒNG ĐỜI KHÁCH + FOLLOW-UP AN TOÀN (P0 11/10/2026 · mission `followup-lifecycle`) ═══════════
 *
 * Sự cố KimThu Le (hội thoại a8c10daf…): bot lên đơn #71B31FE3, lõi đơn ghi thẳng «Đã xác nhận» (công tắc «đơn đủ thông tin =
 * đã xác nhận»), nhưng `state.confirmed` chỉ do `confirm_order` ghi ⇒ job follow-up (`lib/sales-chatbot/followup.ts`) vẫn nhắn
 * «đơn … đã lên xong, em xác nhận để gửi đi luôn nhé ạ?» lúc 11:54, 16:54 và «… có muốn tiếp tục chốt đơn» 08:54 hôm sau — đúng
 * lịch 1 · 6 · 22 giờ tính từ tin cuối của bot.
 *
 *  1. THUẦN — `deriveLifecycle` (sáu chiều độc lập; SĐT + địa chỉ không bao giờ thành đơn; nháp của bot ≠ đơn; trả trước Pancake
 *     không phải tiền; ORDER_OUTCOME quyết giao hàng), `optOutInCustomerText`, `decideFollowup` (thứ tự kiểm là luật).
 *  2. CSDL THẬT (tổ chức `fu-life`, tự cấp, tự dọn; Pancake GIẢ, model GIẢ — luật 65; mốc theo đồng hồ thật — luật 50):
 *     chưa có đơn ⇒ gửi · đã tạo đơn ⇒ ORDER_EXISTS · đã có chứng từ thu ⇒ chặn · đã huỷ ⇒ vô hiệu · từ chối nhận tin ⇒ chặn ·
 *     khách nhắn trong lúc AI soạn ⇒ huỷ · hai lượt job đồng thời ⇒ một tin · cron chạy lại cùng lượt ⇒ một tin · khoá gửi đã có
 *     ⇒ không gửi · page / nhân viên vừa trả lời ⇒ chặn · nguồn gửi ERP khác vừa nhắn ⇒ chặn · ca dáng KimThu Le ⇒ không gửi ·
 *     vết quyết định đủ trường, không PII · câu «đã lên đơn» khi đơn chưa xác nhận ⇒ claim-guard chặn.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { manualOrderAmountDue } from "@/lib/constants/order-payments";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createOrderAsAgent } from "@/lib/records/order-create";
import { recordManualPaymentCore } from "@/lib/records/order-payments";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { openConversation, setSalesChatProviderForTests, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { claimConversationEvent, linkAgentOrder } from "@/lib/sales-chatbot/events";
import { fanpageVisitorKey, markWaitingForCustomer, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { runSalesFollowups } from "@/lib/sales-chatbot/followup";
import { decideFollowup, FOLLOWUP_REASON_LABEL, pendingPriorOrderReason, followupScriptOf, followupSlotKey, type FollowupConvSnap, type FollowupGateInput } from "@/lib/sales-chatbot/followup-shared";
import { deriveLifecycle, LIFECYCLE_SHOP_SAID_PREFIX, optOutInCustomerText, orderStateOf, type LifecycleFacts, type LinkedOrderFact } from "@/lib/sales-chatbot/lifecycle";
import { executeTool, type ChatState } from "@/lib/sales-chatbot/tools";
import { confirmedStaleness, repairStaleConfirmed, staleRepairSummaryLines } from "@/lib/sales-chatbot/confirmed-settle";
import { sendOutreachTargets } from "@/lib/outreach/send";
import { parseStaleRepairArgs } from "@/scripts/sales-stale-confirmed-repair";
import { setSettingJson } from "@/lib/settings";

const ORG = "fu-life";
const PAGE = "109877700000123";
const SECRETS_KEY = "khoa-kiem-thu-follow-up-vong-doi-0123456789abcdefghijklmnopqrstuvwxyz";
const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };
const PHONE = "0942777123";
const NAME = "Chị Kim Thử";
const ADDRESS = "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội";

// ─────────────────────────── 1. THUẦN ───────────────────────────

const facts = (p: Partial<LifecycleFacts> = {}): LifecycleFacts => ({ conversation: { status: "WAITING", handoffReason: null, control: "AUTO", turns: 2 }, state: {}, orders: [], customerTexts: [], ...p });
const ord = (p: Partial<LinkedOrderFact> = {}): LinkedOrderFact => ({ id: "erp-aaaaaaaa-0000", stage: "CONFIRMED", insertedAt: new Date(), linkedBy: ["SALES_CONVERSATION"], outcome: "NOT_SHIPPED", leftWarehouse: false, payment: "UNPAID", ...p });
const customer = { id: "c1", name: NAME, phone: PHONE, address: ADDRESS, province: "Hà Nội", simulated: false };
const draft = (orderId: string | null) => ({ orderId, lines: [{ variantId: "v", quantity: 1 }], unitPrices: { v: 280_000 }, recipient: { name: NAME, phone: PHONE, address: ADDRESS, province: "Hà Nội" }, note: "", simulated: false });

export function testLifecyclePure() {
  // SĐT + địa chỉ KHÔNG BAO GIỜ một mình thành đơn.
  const info = deriveLifecycle(facts({ state: { customer } }));
  assert.deepEqual([info.salesStage, info.order, info.payment, info.fulfillment, info.contact], ["CUSTOMER_INFO_COLLECTED", "NONE", "NONE", "NONE", "OK"], "SĐT + địa chỉ ⇒ CUSTOMER_INFO_COLLECTED, đơn NONE");
  assert.equal(info.quote, "UNKNOWN", "chưa có dữ kiện báo giá xác thực ⇒ UNKNOWN (worker authoritative-quote cấp)");
  assert.equal(deriveLifecycle(facts({ quote: { state: "VERIFIED", source: "authoritative-quote" } })).quote, "VERIFIED", "chiều báo giá nhận dữ kiện từ worker báo giá");
  // Nháp của BOT (đơn «Mới», chưa confirm_order) ⇒ CREATION_PENDING; cùng đơn mà lõi ghi «Đã xác nhận» (ca KimThu) ⇒ CONFIRMED.
  const bd = ord({ id: "erp-bbbbbbbb-1111", stage: "NEW" });
  assert.equal(deriveLifecycle(facts({ state: { customer, draft: draft(bd.id) }, orders: [bd] })).order, "CREATION_PENDING");
  const kim = deriveLifecycle(facts({ state: { customer, draft: draft(bd.id) }, orders: [{ ...bd, stage: "CONFIRMED" }] }));
  assert.deepEqual([kim.order, kim.salesStage, kim.orderId], ["CONFIRMED", "AWAITING_CONFIRMATION", bd.id], "đơn bot đã «Đã xác nhận» mà sổ bot chưa confirmed ⇒ order CONFIRMED");
  assert.ok(kim.sources.order.includes(`#${manualOrderShortCode(bd.id)}`) && !kim.sources.order.includes(PHONE), "nguồn chiều đơn trỏ dòng orders, không chứa SĐT");
  // Đơn «Mới» của NGƯỜI / máy ghi đơn ⇒ CREATED (không phải nháp chờ khách).
  assert.equal(deriveLifecycle(facts({ orders: [ord({ stage: "NEW" })] })).order, "CREATED");
  // Đơn sống thắng đơn đã huỷ; chỉ còn đơn huỷ ⇒ CANCELLED; hoàn theo ORDER_OUTCOME ⇒ RETURNED.
  assert.equal(deriveLifecycle(facts({ orders: [ord({ id: "erp-x1", stage: "CANCELLED" }), ord({ id: "erp-x2", stage: "CONFIRMED" })] })).order, "CONFIRMED");
  assert.equal(deriveLifecycle(facts({ orders: [ord({ stage: "CANCELLED" })] })).order, "CANCELLED");
  assert.equal(deriveLifecycle(facts({ orders: [ord({ stage: "SHIPPED", outcome: "RETURNED_BY_RULE" })] })).order, "RETURNED");
  assert.equal(orderStateOf({ id: "x", stage: "DELIVERED", outcome: "CANCELLED" }, null), "CANCELLED", "hãng huỷ (ORDER_OUTCOME) ⇒ huỷ");
  // Tiền CHỈ theo chứng từ thu; đơn Pancake (không sổ thu) ⇒ UNKNOWN dù stage «PAID».
  assert.equal(deriveLifecycle(facts({ orders: [ord({ payment: "PAID" })] })).payment, "PAID");
  assert.equal(deriveLifecycle(facts({ orders: [ord({ payment: "PARTIALLY_PAID" })] })).payment, "PENDING");
  const pos = deriveLifecycle(facts({ orders: [ord({ id: "1234567890", stage: "PAID", payment: null, outcome: "UNKNOWN" })] }));
  assert.deepEqual([pos.order, pos.payment, pos.fulfillment], ["CONFIRMED", "UNKNOWN", "UNKNOWN"], "trạng thái PAID của Pancake không phải tiền thật, không phải đã giao");
  // Giao hàng theo ORDER_OUTCOME / chặng ĐVVC.
  assert.equal(deriveLifecycle(facts({ orders: [ord({ outcome: "DELIVERED" })] })).fulfillment, "DELIVERED");
  assert.equal(deriveLifecycle(facts({ orders: [ord({ outcome: "AWAITING_PICKUP", leftWarehouse: true })] })).fulfillment, "SHIPPING");
  assert.equal(deriveLifecycle(facts({ orders: [ord({ outcome: "NOT_SHIPPED" })] })).fulfillment, "NONE");
  // Đọc đơn lỗi ⇒ UNKNOWN trên cả ba chiều phụ thuộc.
  const bad = deriveLifecycle(facts({ orders: null }));
  assert.deepEqual([bad.order, bad.payment, bad.fulfillment], ["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  // Sổ bot chốt (khung THỬ mô phỏng, không dòng orders) vẫn là CONFIRMED (phía hẹp).
  assert.equal(deriveLifecycle(facts({ state: { confirmed: { orderId: null, simulated: true, total: 1, at: "x" } } })).order, "CONFIRMED");
  // Liên hệ: lời từ chối nhận tin > người tiếp quản.
  assert.equal(deriveLifecycle(facts({ customerTexts: ["thôi em đừng nhắn tin cho chị nữa nhé"] })).contact, "OPTED_OUT");
  assert.equal(deriveLifecycle(facts({ conversation: { status: "HANDOFF", handoffReason: "x", control: "AUTO", turns: 1 } })).contact, "HUMAN_TAKEOVER");
  assert.equal(deriveLifecycle(facts({ conversation: { status: "WAITING", handoffReason: null, control: "COPILOT", turns: 1 } })).contact, "HUMAN_TAKEOVER");
  assert.equal(deriveLifecycle(facts({ state: { declined: { reason: "thôi", at: "x" } } })).salesStage, "CUSTOMER_DECLINED");
  // Lời từ chối nhận tin: chỉ cụm rõ ràng.
  for (const yes of ["đừng nhắn nữa", "Thôi đừng nhắn tin cho chị nữa", "ngừng gửi tin giúp em", "đừng làm phiền", "không muốn nhận tin nhắn của shop", "dung nhan nua", "STOP"]) assert.ok(optOutInCustomerText(yes), `nhận ra: ${yes}`);
  for (const no of ["không nhận hàng đâu", "nhắn em số tài khoản", "chị nhận được tin rồi", "khi nào nhắn lại chị", "đừng giao buổi sáng nhé", "không cần ship nhanh"]) assert.ok(!optOutInCustomerText(no), `không nhầm: ${no}`);
  assert.equal(LIFECYCLE_SHOP_SAID_PREFIX, SHOP_SAID, "tiền tố tin phía shop = SHOP_SAID của engine");

  // ── decideFollowup — thứ tự kiểm là luật ──
  const t0 = Date.now();
  const snap = (p: Partial<FollowupConvSnap> = {}): FollowupConvSnap => ({ status: "WAITING", lastBotAt: new Date(t0 - 3_600_000), lastCustomerAt: new Date(t0 - 3_700_000), lastStaffAt: null, waitingSince: new Date(t0 - 3_600_000), humanCooldownUntil: null, ...p });
  const okLc = deriveLifecycle(facts({ state: { customer } }));
  const gate = (p: Partial<FollowupGateInput> = {}) => decideFollowup({ now: new Date(t0), hasAddress: true, claimed: snap(), fresh: snap(), lifecycle: okLc, pageReplyAfter: false, customerInboundAfter: false, otherBotSendAfter: false, sameScriptRecently: false, ...p }).reason;
  assert.equal(gate(), "OK", "chưa có đơn, khách đã cho thông tin ⇒ gửi được");
  // Đơn đã chốt chưa kết cục của LƯỢT MUA TRƯỚC (P0 21/10/2026, #BD31267C) — thuần + thứ tự (ngay SAU ORDER_EXISTS).
  const hAgo = (h: number) => new Date(t0 - h * 3_600_000);
  const po = (stage: string, h: number, outcome: string | null = "NOT_SHIPPED") => ({ stage, insertedAt: hAgo(h), outcome });
  const pp = (orders: Parameters<typeof pendingPriorOrderReason>[0]) => pendingPriorOrderReason(orders, new Date(t0), 30, 96);
  assert.equal(pp([po("CONFIRMED", 24)]), "PENDING_PRIOR_ORDER");
  assert.equal(pp([po("CONFIRMED", 24, null)]), "PENDING_PRIOR_ORDER", "không đọc được kết cục = chưa kết cục (phía hẹp)");
  assert.equal(pp([po("CONFIRMED", 120)]), "PENDING_PRIOR_ORDER_STALE", "quá 96 giờ ⇒ người kiểm");
  assert.equal(pp([po("CONFIRMED", 31 * 24)]), null, "chốt quá cửa sổ 30 ngày ⇒ không chặn (giả định của CONFIRMED_ORDER_WATCH_DAYS)");
  for (const o of ["DELIVERED", "RETURNED", "RETURNED_BY_RULE", "CANCELLED"]) assert.equal(pp([po("CONFIRMED", 24, o)]), null, `kết cục ${o} ⇒ không chặn`);
  for (const st of ["NEW", "CANCELLED", "DELETED", "DELIVERED"]) assert.equal(pp([po(st, 24)]), null, `đơn ${st} ⇒ không chặn`);
  assert.equal(pp([po("CONFIRMED", 24, "DELIVERED"), po("SHIPPED", 2, "IN_TRANSIT")]), "PENDING_PRIOR_ORDER", "một đơn đã giao + một đơn đang đi ⇒ còn chờ");
  assert.equal(gate({ pendingOrder: "PENDING_PRIOR_ORDER" }), "PENDING_PRIOR_ORDER");
  assert.equal(gate({ pendingOrder: "PENDING_PRIOR_ORDER", lifecycle: kim }), "ORDER_EXISTS", "đơn của lượt HIỆN TẠI giữ mã cũ — luật mới chỉ bắt đơn lượt hiện tại không thấy");
  assert.equal(gate({ lifecycle: kim }), "ORDER_EXISTS", "ca KimThu ⇒ ORDER_EXISTS");
  assert.equal(gate({ lifecycle: deriveLifecycle(facts({ orders: [ord({ payment: "PAID" })] })) }), "PAYMENT_RECORDED", "có chứng từ thu ⇒ chặn (trước ORDER_EXISTS)");
  assert.equal(gate({ lifecycle: deriveLifecycle(facts({ orders: [ord({ stage: "CANCELLED" })] })) }), "ORDER_CANCELLED");
  assert.equal(gate({ lifecycle: deriveLifecycle(facts({ orders: [ord({ outcome: "RETURNED" })] })) }), "ORDER_RETURNED");
  assert.equal(gate({ lifecycle: bad }), "LIFECYCLE_UNKNOWN", "không đọc được đơn ⇒ không gửi");
  assert.equal(gate({ lifecycle: deriveLifecycle(facts({ state: { customer, draft: draft(bd.id) }, orders: [bd] })) }), "OK", "nháp của bot chờ xác nhận ⇒ được nhắc xác nhận");
  assert.equal(followupScriptOf(deriveLifecycle(facts({ state: { customer, draft: draft(bd.id) }, orders: [bd] }))), "CONFIRM_REMINDER");
  assert.equal(followupScriptOf(okLc), "SALES_NUDGE");
  assert.equal(gate({ lifecycle: deriveLifecycle(facts({ customerTexts: ["đừng nhắn nữa"] })) }), "OPTED_OUT");
  assert.equal(gate({ customerInboundAfter: true }), "CUSTOMER_REPLIED");
  assert.equal(gate({ fresh: snap({ lastCustomerAt: new Date(t0 - 1000) }) }), "CUSTOMER_REPLIED", "mốc tin khách đổi sau lúc giành ⇒ huỷ");
  assert.equal(gate({ pageReplyAfter: true, customerInboundAfter: true }), "STAFF_REPLIED", "người lên tiếng xếp trước khách nhắn");
  assert.equal(gate({ fresh: snap({ lastStaffAt: new Date(t0 - 60_000) }) }), "STAFF_REPLIED", "nhân viên gõ trong hộp thư sau tin bot");
  assert.equal(gate({ fresh: snap({ humanCooldownUntil: new Date(t0 + 60_000) }) }), "STAFF_COOLDOWN");
  assert.equal(gate({ fresh: snap({ humanCooldownUntil: new Date(t0 - 60_000) }) }), "OK", "cửa sổ nhường đã hết ⇒ không chặn");
  assert.equal(gate({ lifecycle: deriveLifecycle(facts({ conversation: { status: "HANDOFF", handoffReason: "x", control: "AUTO", turns: 1 } })) }), "HUMAN_TAKEOVER");
  assert.equal(gate({ fresh: snap({ status: "OPEN" }) }), "NOT_WAITING");
  assert.equal(gate({ otherBotSendAfter: true }), "ANOTHER_SENDER");
  assert.equal(gate({ fresh: snap({ lastBotAt: new Date(t0 - 1000) }) }), "ANOTHER_SENDER", "mốc tin bot đổi sau lúc giành ⇒ nguồn khác đã nhắn");
  assert.equal(gate({ sameScriptRecently: true }), "DUPLICATE_SCRIPT");
  assert.equal(gate({ claimed: snap({ lastCustomerAt: new Date(t0 - 25 * 3_600_000) }), fresh: snap({ lastCustomerAt: new Date(t0 - 25 * 3_600_000) }) }), "OUTSIDE_MESSAGING_WINDOW");
  assert.equal(gate({ hasAddress: false, pageReplyAfter: true }), "NO_ADDRESS");
  assert.equal(FOLLOWUP_REASON_LABEL.ORDER_EXISTS.includes("đã chốt đơn"), true, "nhãn cũ «đã chốt đơn» giữ nguyên cho màn hình");
  assert.equal(followupSlotKey(new Date(0), 2), "followup-decided:1970-01-01T00:00:00.000Z:2");
}

// ─────────────────────────── 2. CSDL THẬT ───────────────────────────

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function fakePancake() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `m-fu-${Math.random().toString(36).slice(2, 10)}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls, sentTo: (thread: string) => calls.filter((c) => c.init?.method === "POST" && c.url.includes(`/conversations/${thread}/messages`)) };
}

export async function testFollowupLifecycleDb() {
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = SECRETS_KEY;
  await cleanupOrg(ORG);
  try {
    await provisionOrganization({ code: ORG, name: "Thử follow-up vòng đời", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "FollowUp@2026!" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] };
      const pancake = fakePancake();
      const saved = await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: "tok-fu-life-0123456789" } });
      assert.ok("ok" in saved, JSON.stringify(saved));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: 30_000 });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: false });
      const [cust] = await db.insert(schema.customers).values({ name: NAME, phone: PHONE, address: ADDRESS, province: "Hà Nội" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-fu-prod", name: "Chả cá thu 2kg", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-fu-var", productId: "erp-fu-prod", sku: "CCT-2KG", size: "2kg", retailPrice: 540_000, weight: 2000 });
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-FU", totalQuantity: 50, createdBy: u.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: "erp-fu-var", quantity: 50, unitCost: 250_000 });

      // ── model GIẢ: chữ do bài đặt; móc chạy GIỮA lúc AI soạn (mô phỏng khách / người lên tiếng trong lúc đó) ──
      let aiText = "Dạ chị còn băn khoăn gì về chả cá không ạ, em hỗ trợ chị nhé!";
      let duringCompose: (() => Promise<void>) | null = null;
      const prompts: AiRequest[] = [];
      const provider: AiProvider = {
        name: "fake-fu",
        model: "claude-sonnet-5",
        schemaDialect: "anthropic",
        async complete(req: AiRequest): Promise<AiResponse> {
          prompts.push(req);
          if (duringCompose) await duringCompose();
          const content: AiBlock[] = [{ type: "text", text: aiText }];
          return { content, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      };
      setSalesChatProviderForTests(() => provider);
      const c = schema.salesChatConversations;
      const e = schema.salesConversationEvents;
      const t = schema.salesChatInbound;
      const state0: ChatState = { customer: { ...customer, id: cust.id } };
      /** Hội thoại fanpage đang CHỜ KHÁCH, tới mốc nhắc lần 1 (mốc theo đồng hồ thật). */
      const conv = async (thread: string, state: ChatState = state0, extra: Partial<typeof c.$inferInsert> = {}) => {
        const o = await openConversation("FANPAGE", { visitorKey: fanpageVisitorKey(PAGE, thread) });
        const now = Date.now();
        await db
          .update(c)
          .set({ pageId: PAGE, threadId: thread, status: "WAITING", state, turns: 3, lastCustomerAt: new Date(now - 62 * 60_000), lastBotAt: new Date(now - 61 * 60_000), waitingSince: new Date(now - 61 * 60_000), followupsSent: 0, nextFollowupAt: new Date(now - 60_000), ...extra })
          .where(eq(c.id, o.id));
        return o.id;
      };
      const run = () => runSalesFollowups({ fetch: pancake.fetch, now: () => new Date() });
      const decisions = async (id: string) => db.select({ reasonCode: e.reasonCode, orderId: e.orderId, payload: e.payload, key: e.dedupeKey }).from(e).where(and(eq(e.conversationId, id), eq(e.type, "followup.decided")));
      const onlyReason = async (id: string) => (await decisions(id)).map((d) => d.reasonCode);
      const newOrder = async (stage: "NEW" | "CONFIRMED", key: string) => {
        const r = await createOrderAsAgent(AGENT, { customerId: cust.id, stage, lines: [{ variantId: "erp-fu-var", quantity: 1, unitPrice: 540_000, discount: 0 }], orderDiscount: 0, shippingFee: 30_000, note: "", channel: "Chatbot fanpage", recipient: { name: NAME, phone: PHONE, address: ADDRESS, province: "Hà Nội" } }, { pricing: "RETAIL", allowShortStock: true, idempotencyKey: key });
        assert.ok(r.ok, JSON.stringify(r));
        return r.id;
      };
      const linkTo = (orderId: string, convId: string) => db.update(schema.orders).set({ salesConversationId: convId }).where(eq(schema.orders.id, orderId));

      // ① Khách đã cho SĐT + địa chỉ, CHƯA có đơn ⇒ follow-up hợp lệ, gửi đúng MỘT tin, vết GỬI đủ trường.
      const a = await conv("th-a");
      const ra = await run();
      assert.equal(ra.sent, 1, JSON.stringify(ra));
      assert.equal(pancake.sentTo("th-a").length, 1, "đúng một tin");
      assert.ok(/KHÔNG hỏi lại/.test(prompts.at(-1)!.system), "khách đã gửi SĐT + địa chỉ ⇒ lời nhắc cấm hỏi lại");
      const [da] = await decisions(a);
      const pa = da.payload as Record<string, unknown>;
      const lcA = pa.lifecycle as Record<string, unknown>;
      assert.deepEqual([da.reasonCode, pa.decision, pa.delivery, pa.trigger, pa.workflow, pa.phase, pa.script, pa.attempt], ["OK", "SEND", "SENT", "SCHEDULE", "sales-followup", "SEND", "SALES_NUDGE", 1], JSON.stringify(pa));
      assert.deepEqual([lcA.salesStage, lcA.order, lcA.payment, lcA.fulfillment, lcA.contact, lcA.quote], ["CUSTOMER_INFO_COLLECTED", "NONE", "NONE", "NONE", "OK", "UNKNOWN"]);
      assert.ok(lcA.version && lcA.sources && pa.checks && pa.model === "claude-sonnet-5" && typeof pa.promptHash === "string" && pa.promptVersion && pa.v === 1, "vết: ảnh chụp vòng đời + kết quả kiểm + model + phiên bản / dấu băm lời nhắc");
      const rawA = JSON.stringify(da.payload);
      assert.ok(!rawA.includes(PHONE) && !rawA.includes(NAME) && !rawA.includes(aiText) && !rawA.includes(ADDRESS), "vết KHÔNG chứa SĐT / tên / địa chỉ / chữ câu nhắc");

      // ①b P0 21/10/2026 (ca HSLC #BD31267C): đơn đã chốt của LƯỢT MUA TRƯỚC (đã sang `pastOrders`, lượt mua mới không thấy) còn chưa kết
      // cục ⇒ KHÔNG nhắc bán; quá DWELL_SLA.PENDING.exception ⇒ mã STALE (người kiểm); chốt quá CONFIRMED_ORDER_WATCH_DAYS ⇒ không chặn nữa.
      for (const [thread, ageH, want] of [["th-past-1", 1, "PENDING_PRIOR_ORDER"], ["th-past-5", 5 * 24, "PENDING_PRIOR_ORDER_STALE"], ["th-past-31", 31 * 24, "OK"]] as const) {
        const oid = await newOrder("CONFIRMED", `fu-past-${thread}`);
        await db.update(schema.orders).set({ insertedAt: new Date(Date.now() - ageH * 3_600_000) }).where(eq(schema.orders.id, oid));
        const id = await conv(thread, { ...state0, pastOrders: [{ orderId: oid, simulated: false, total: 570_000, at: new Date(Date.now() - ageH * 3_600_000).toISOString() }] });
        await linkTo(oid, id);
        const before = pancake.sentTo(thread).length;
        await run();
        assert.deepEqual(await onlyReason(id), [want], `${thread}: đơn lượt trước ${ageH} giờ ⇒ ${want}`);
        assert.equal(pancake.sentTo(thread).length - before, want === "OK" ? 1 : 0, `${thread}: ${want === "OK" ? "quá cửa sổ ⇒ nhắc lại bình thường" : "không gửi tin bán hàng cho khách đang chờ đơn"}`);
      }
      assert.equal((await db.select({ id: e.id }).from(e).where(and(eq(e.conversationId, a), eq(e.type, "followup.sent")))).length, 1, "sự kiện followup.sent cũ vẫn ghi (báo cáo đọc nó)");

      // ② Cron chạy lại CÙNG lượt nhắc (mốc bị đặt lại) ⇒ không tin thứ hai.
      await db.update(c).set({ nextFollowupAt: new Date(Date.now() - 60_000), followupsSent: 0, lastBotAt: (await db.select({ w: c.waitingSince }).from(c).where(eq(c.id, a)))[0].w }).where(eq(c.id, a));
      const callsBefore = prompts.length;
      const ra2 = await run();
      assert.equal(pancake.sentTo("th-a").length, 1, `cron lặp ⇒ vẫn một tin: ${JSON.stringify(ra2)}`);
      assert.equal(prompts.length, callsBefore, "lượt lặp bị chặn TRƯỚC lời gọi AI");

      // ③ Đã tạo đơn (nhân viên / máy ghi đơn, «Mới») ⇒ ORDER_EXISTS, không gọi AI.
      const b = await conv("th-b");
      await linkTo(await newOrder("NEW", "fu-b"), b);
      const nb = prompts.length;
      const rb = await run();
      assert.ok(rb.detail.some((d) => d.startsWith(b.slice(0, 8)) && d.includes("đã chốt đơn")), JSON.stringify(rb));
      assert.deepEqual(await onlyReason(b), ["ORDER_EXISTS"]);
      assert.equal(prompts.length, nb, "đơn đã có ⇒ không tốn token");
      assert.equal(pancake.sentTo("th-b").length, 0);

      // ④ Đã thanh toán (chứng từ thu đủ số) ⇒ chặn.
      const cc = await conv("th-c");
      const oc = await newOrder("CONFIRMED", "fu-c");
      await linkTo(oc, cc);
      const due = manualOrderAmountDue({ totalPriceAfterDiscount: 540_000, shippingFee: 30_000 });
      assert.ok((await recordManualPaymentCore(admin, oc, { kind: "RECEIPT", method: "BANK_TRANSFER", amount: due, paidAt: new Date().toISOString() })).ok);
      await run();
      assert.deepEqual(await onlyReason(cc), ["PAYMENT_RECORDED"]);
      assert.equal(pancake.sentTo("th-c").length, 0);

      // ⑤ Đơn đã huỷ ⇒ lịch nhắc cũ vô hiệu.
      const d = await conv("th-d");
      const od = await newOrder("CONFIRMED", "fu-d");
      await linkTo(od, d);
      await db.update(schema.orders).set({ stage: "CANCELLED" }).where(eq(schema.orders.id, od));
      await run();
      assert.deepEqual(await onlyReason(d), ["ORDER_CANCELLED"]);
      assert.equal(pancake.sentTo("th-d").length, 0);

      // ⑥ Khách từ chối nhận tin ⇒ chặn.
      const oo = await conv("th-e");
      await db.insert(schema.salesChatMessages).values({ conversationId: oo, seq: 50, role: "user", content: [{ type: "text", text: "Thôi em đừng nhắn tin cho chị nữa nhé" }] });
      await run();
      assert.deepEqual(await onlyReason(oo), ["OPTED_OUT"]);
      assert.equal(pancake.sentTo("th-e").length, 0);

      // ⑦ Khách nhắn NGAY trước giờ gửi (webhook tới trong lúc AI đang soạn) ⇒ cổng lần 2 huỷ lượt.
      const f = await conv("th-f");
      duringCompose = async () => {
        await db.insert(t).values({ pageId: PAGE, threadId: "th-f", messageId: `m-cust-${Date.now()}`, text: "còn hàng không em", status: "PENDING" });
      };
      const nf = prompts.length;
      await run();
      duringCompose = null;
      assert.equal(prompts.length, nf + 1, "AI đã soạn");
      assert.deepEqual(await onlyReason(f), ["CUSTOMER_REPLIED"]);
      assert.equal((await decisions(f))[0].payload.phase, "PRE_SEND", "chặn ở cổng đọc lại ngay trước khi gửi");
      assert.equal(pancake.sentTo("th-f").length, 0, "khách vừa nhắn ⇒ không gửi câu nhắc");

      // ⑧ Hai lượt job ĐỒNG THỜI cùng một khách ⇒ đúng một tin.
      await conv("th-g");
      await Promise.all([run(), run()]);
      assert.equal(pancake.sentTo("th-g").length, 1, "hai worker ⇒ một tin");

      // ⑨ Khoá gửi đã có (một worker khác đã quyết đúng lượt nhắc này) ⇒ không gửi lần hai, dù cổng cho qua.
      const h = await conv("th-h");
      const [hr] = await db.select({ ws: c.waitingSince, state: c.state }).from(c).where(eq(c.id, h));
      assert.equal(await claimConversationEvent(h, "FANPAGE", hr.state as ChatState, { type: "followup.decided", actorKind: "SYSTEM", occurredAt: new Date(), payload: { decision: "SEND", script: "WORKER_KHAC" }, key: followupSlotKey(hr.ws, 1) }), true);
      const rh = await run();
      assert.ok(rh.detail.some((x) => x.startsWith(h.slice(0, 8)) && x.includes(FOLLOWUP_REASON_LABEL.DUPLICATE)), JSON.stringify(rh));
      assert.equal(pancake.sentTo("th-h").length, 0, "khoá đã có ⇒ không gửi");

      // ⑩ Page / nhân viên vừa trả lời ⇒ chặn; cửa sổ nhường người còn hiệu lực ⇒ chặn.
      const i = await conv("th-i");
      await db.insert(t).values({ pageId: PAGE, threadId: "th-i", messageId: `m-staff-${Date.now()}`, text: "Dạ để em kiểm đơn", status: "DONE", note: PAGE_REPLY });
      const i2 = await conv("th-i2", state0, { humanCooldownUntil: new Date(Date.now() + 20 * 60_000) });
      const ni = prompts.length;
      await run();
      assert.deepEqual(await onlyReason(i), ["STAFF_REPLIED"]);
      assert.deepEqual(await onlyReason(i2), ["STAFF_COOLDOWN"]);
      assert.equal(prompts.length, ni, "người vừa trả lời ⇒ không gọi AI");
      assert.equal(pancake.sentTo("th-i").length + pancake.sentTo("th-i2").length, 0);

      // ⑪ Nguồn gửi ERP khác (tiếng vọng BOT_SENT muộn — vd tin xác nhận đặt lại của máy ghi đơn) ⇒ không gửi chồng.
      const j = await conv("th-j");
      await db.insert(t).values({ pageId: PAGE, threadId: "th-j", messageId: `bot-out:fu-${Date.now()}`, text: "Dạ em xác nhận lại đơn", status: "DONE", note: "BOT_SENT" });
      await run();
      assert.deepEqual(await onlyReason(j), ["ANOTHER_SENDER"]);
      assert.equal(pancake.sentTo("th-j").length, 0);

      // ⑫ CA DÁNG KIMTHU LE: bot lên đơn, lõi ghi thẳng «Đã xác nhận» (công tắc bật) ⇒ sổ bot KHÔNG có confirmed ⇒ lịch nhắc vẫn
      //    được xếp (gốc sự cố) — nhưng cổng mới đọc đơn THẬT ⇒ không gửi.
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
      const k = await conv("th-k");
      const cfg = { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok" as const, enabled: true, shippingFee: 30_000 };
      const tk = await executeTool("create_draft_order", { items: [{ variant_id: "erp-fu-var", quantity: 1 }] }, { conversationId: k, channel: "FANPAGE", config: cfg, state: state0, lastUserText: "lấy chị 2kg nhé", agent: AGENT, turn: 4 });
      assert.ok(!tk.isError, tk.content);
      const kOrder = tk.state.draft!.orderId!;
      await linkAgentOrder(kOrder, k, "AI_AGENT");
      assert.equal((await db.select({ s: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.id, kOrder)))[0].s, "CONFIRMED", "công tắc bật ⇒ nháp của bot ghi thẳng «Đã xác nhận»");
      assert.ok(tk.state.draft && !tk.state.confirmed && !tk.state.declined && !tk.state.handoff, "GỐC: sổ bot không có confirmed ⇒ cổng cũ (st.confirmed || declined || handoff) cho qua");
      await db.update(c).set({ state: { ...tk.state, stage: "CONFIRM" } }).where(eq(c.id, k));
      // P0-B (chủ shop 11/10/2026): lúc XẾP LỊCH đọc đơn THẬT ⇒ không xếp; lịch cũ huỷ, WAITING ⇒ OPEN, bước DONE, một dòng vết.
      await markWaitingForCustomer(k, new Date());
      const [kw] = await db.select({ status: c.status, next: c.nextFollowupAt, ws: c.waitingSince, state: c.state, lastBotAt: c.lastBotAt }).from(c).where(eq(c.id, k));
      assert.deepEqual([kw.status, kw.next, kw.ws, (kw.state as ChatState).stage], ["OPEN", null, null, "DONE"], `đơn đã xác nhận ⇒ không xếp lịch, bước DONE: ${JSON.stringify(kw)}`);
      assert.ok(kw.lastBotAt && Date.now() - kw.lastBotAt.getTime() < 60_000, "mốc tin cuối của bot vẫn ghi");
      const settledK = await db.select({ payload: e.payload, orderId: e.orderId, actor: e.actorKind }).from(e).where(and(eq(e.conversationId, k), eq(e.type, "stage.changed")));
      assert.equal(settledK.length, 1, "một dòng vết dọn sổ");
      const sk = settledK[0].payload as Record<string, unknown>;
      assert.deepEqual([settledK[0].actor, settledK[0].orderId, sk.via, sk.reason, sk.from, sk.to], ["SYSTEM", kOrder, "SCHEDULE", "CONFIRMED_ORDER", "CONFIRM", "DONE"]);
      // Dòng ĐÃ KẸT từ trước bản vá (lịch còn, WAITING, bước CONFIRM) ⇒ job chặn gửi VÀ dọn sổ ngay lúc chạy.
      await db.update(c).set({ status: "WAITING", state: { ...tk.state, stage: "CONFIRM" }, waitingSince: new Date(Date.now() - 61 * 60_000), nextFollowupAt: new Date(Date.now() - 60_000), lastCustomerAt: new Date(Date.now() - 2 * 60_000) }).where(eq(c.id, k));
      const nk = prompts.length;
      const rk = await run();
      assert.equal(pancake.sentTo("th-k").length, 0, `KimThu: không gửi «em xác nhận để gửi đi luôn nhé ạ?»: ${JSON.stringify(rk)}`);
      assert.equal(prompts.length, nk, "KimThu: không gọi AI");
      const [dk] = await decisions(k);
      assert.equal(dk.reasonCode, "ORDER_EXISTS");
      assert.equal(dk.orderId, kOrder, "vết mang mã đơn liên quan");
      const lk = (dk.payload as Record<string, unknown>).lifecycle as Record<string, unknown>;
      assert.deepEqual([lk.order, lk.salesStage], ["CONFIRMED", "AWAITING_CONFIRMATION"]);
      const [kj] = await db.select({ status: c.status, next: c.nextFollowupAt, state: c.state }).from(c).where(eq(c.id, k));
      assert.deepEqual([kj.status, kj.next, (kj.state as ChatState).stage], ["OPEN", null, "DONE"], "job: đơn đã xác nhận ⇒ huỷ lịch + bước DONE ngay lúc chạy");
      const viaJob = (await db.select({ payload: e.payload }).from(e).where(and(eq(e.conversationId, k), eq(e.type, "stage.changed")))).map((r) => String((r.payload as Record<string, unknown>).via)).sort();
      assert.deepEqual(viaJob, ["FOLLOWUP_JOB", "SCHEDULE"], "mỗi nơi phát hiện một dòng vết");

      // ⑭ NGHIỆM THU — CA KIỀU VĂN LỆ: khách nói 2kg, gửi SĐT + địa chỉ, SKU khớp, khung đơn «ĐÃ XÁC NHẬN» ⇒ sau lượt bot trả lời
      //    KHÔNG có lịch nhắc, bước DONE, job chạy bao nhiêu lần cũng KHÔNG một tin «có muốn tiếp tục chốt đơn không».
      const lv = await conv("th-kvl", state0, { status: "OPEN", nextFollowupAt: null, waitingSince: null });
      const tv = await executeTool("create_draft_order", { items: [{ variant_id: "erp-fu-var", quantity: 1 }] }, { conversationId: lv, channel: "FANPAGE", config: cfg, state: state0, lastUserText: "cho chị 2kg chả cá thu nhé", agent: AGENT, turn: 4 });
      assert.ok(!tv.isError, tv.content);
      const lvOrder = tv.state.draft!.orderId!;
      await linkAgentOrder(lvOrder, lv, "AI_AGENT");
      assert.equal((await db.select({ s: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.id, lvOrder)))[0].s, "CONFIRMED", "Kiều Văn Lệ: khung đơn ĐÃ XÁC NHẬN");
      await db.update(c).set({ state: { ...tv.state, stage: "CONFIRM" } }).where(eq(c.id, lv));
      await markWaitingForCustomer(lv, new Date());
      const [lvw] = await db.select({ status: c.status, next: c.nextFollowupAt, state: c.state }).from(c).where(eq(c.id, lv));
      assert.deepEqual([lvw.status, lvw.next, (lvw.state as ChatState).stage], ["OPEN", null, "DONE"], "Kiều Văn Lệ: không lịch nhắc, bước DONE");
      const nlv = prompts.length;
      await run();
      await run();
      assert.equal(pancake.sentTo("th-kvl").length, 0, "Kiều Văn Lệ: không một tin follow-up nào");
      assert.equal(prompts.length, nlv, "Kiều Văn Lệ: không gọi AI");
      assert.deepEqual(await onlyReason(lv), [], "không còn lịch ⇒ job không cả xét");
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: false });

      // ⑬ Nháp của bot CHƯA xác nhận ⇒ nhắc xác nhận hợp lệ — nhưng chữ AI «đơn … đã lên xong» bị claim-guard chặn.
      const l = await conv("th-l");
      const tl = await executeTool("create_draft_order", { items: [{ variant_id: "erp-fu-var", quantity: 1 }] }, { conversationId: l, channel: "FANPAGE", config: cfg, state: state0, lastUserText: "lấy chị 2kg nhé", agent: AGENT, turn: 4 });
      assert.ok(!tl.isError, tl.content);
      await linkAgentOrder(tl.state.draft!.orderId!, l, "AI_AGENT");
      assert.equal((await db.select({ s: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.id, tl.state.draft!.orderId!)))[0].s, "NEW");
      await db.update(c).set({ state: tl.state }).where(eq(c.id, l));
      aiText = "Dạ đơn hàng của chị đã lên xong, em xác nhận để gửi đi luôn nhé ạ?";
      await run();
      assert.ok(/CHƯA xác nhận/.test(prompts.at(-1)!.system) && /KHÔNG nói đơn đã lên/.test(prompts.at(-1)!.system), "lời nhắc: đơn nháp chưa xác nhận, cấm nói đã lên đơn");
      const [dl] = await decisions(l);
      assert.deepEqual([dl.reasonCode, (dl.payload as Record<string, unknown>).claim, (dl.payload as Record<string, unknown>).script], ["CLAIM_BLOCKED", "ORDER_CONFIRMED", "CONFIRM_REMINDER"]);
      assert.equal(pancake.sentTo("th-l").length, 0, "câu «đã lên đơn» khi đơn chưa xác nhận KHÔNG tới khách");

      // ⑮ SỬA DỮ LIỆU (ops sales-stale-confirmed-repair · P0-H): dòng kẹt TỪ TRƯỚC bản vá — (a) đơn đã xác nhận mà còn lịch nhắc,
      //    (b) đơn đã xác nhận mà còn WAITING / bước CONFIRM (không lịch). Đối chứng: đơn «Mới» (chưa xác nhận) và đơn huỷ KHÔNG đụng.
      const stale = (thread: string, extra: Partial<typeof c.$inferInsert>) => conv(thread, { ...state0, stage: "CONFIRM" }, { nextFollowupAt: new Date(Date.now() + 5 * 3_600_000), ...extra });
      const ra1 = await stale("th-rep-a", {});
      await linkTo(await newOrder("CONFIRMED", "fu-rep-a"), ra1);
      const rb1 = await stale("th-rep-b", { nextFollowupAt: null });
      await linkTo(await newOrder("CONFIRMED", "fu-rep-b"), rb1);
      const rNew = await stale("th-rep-new", {});
      await linkTo(await newOrder("NEW", "fu-rep-new"), rNew);
      const rCan = await stale("th-rep-can", {});
      const oCan = await newOrder("CONFIRMED", "fu-rep-can");
      await linkTo(oCan, rCan);
      await db.update(schema.orders).set({ stage: "CANCELLED" }).where(eq(schema.orders.id, oCan));
      const watch = [ra1, rb1, rNew, rCan];
      const snap = async () => JSON.stringify(await db.select({ id: c.id, status: c.status, next: c.nextFollowupAt, ws: c.waitingSince, state: c.state }).from(c).where(inArray(c.id, watch)).orderBy(c.id));
      const evCount = async () => (await db.select({ id: e.id }).from(e)).length;
      const before = await snap();
      const evBefore = await evCount();
      const dry = await repairStaleConfirmed({ apply: false });
      assert.deepEqual([dry.stale, dry.confirmedWithFollowup, dry.confirmedStaleStage, dry.staleStageConfirm, dry.staleWaiting, dry.repaired, dry.unreadable], [2, 1, 2, 2, 2, 0, 0], `chạy thử đếm đúng (a)=1 · (b)=2: ${JSON.stringify(dry)}`);
      assert.equal(await snap(), before, "chạy thử KHÔNG ghi hội thoại nào");
      assert.equal(await evCount(), evBefore, "chạy thử KHÔNG ghi vết nào");
      assert.ok(staleRepairSummaryLines(ORG, dry).some((x) => x.includes("CHẠY THỬ")), "dòng tóm tắt nói rõ chạy thử");
      const ap = await repairStaleConfirmed({ apply: true });
      assert.deepEqual([ap.stale, ap.repaired], [2, 2], JSON.stringify(ap));
      for (const id of [ra1, rb1]) {
        const [r] = await db.select({ status: c.status, next: c.nextFollowupAt, ws: c.waitingSince, state: c.state }).from(c).where(eq(c.id, id));
        assert.deepEqual([r.status, r.next, r.ws, (r.state as ChatState).stage], ["OPEN", null, null, "DONE"], `đã dọn: ${JSON.stringify(r)}`);
        const ev = await db.select({ payload: e.payload }).from(e).where(and(eq(e.conversationId, id), eq(e.type, "stage.changed")));
        assert.deepEqual(ev.map((x) => (x.payload as Record<string, unknown>).via), ["REPAIR"], "một dòng vết REPAIR");
      }
      for (const id of [rNew, rCan]) {
        const [r] = await db.select({ status: c.status, next: c.nextFollowupAt, state: c.state }).from(c).where(eq(c.id, id));
        assert.ok(r.status === "WAITING" && r.next && (r.state as ChatState).stage === "CONFIRM", "đơn chưa xác nhận / đã huỷ ⇒ KHÔNG đụng");
      }
      const evAfterApply = await evCount();
      const afterApply = await snap();
      const again = await repairStaleConfirmed({ apply: true });
      assert.deepEqual([again.stale, again.repaired], [0, 0], `chạy lại = không làm gì: ${JSON.stringify(again)}`);
      assert.equal(await snap(), afterApply, "chạy lần hai không đổi một dòng");
      assert.equal(await evCount(), evAfterApply, "chạy lần hai không thêm vết");
      assert.equal(pancake.sentTo("th-rep-a").length + pancake.sentTo("th-rep-b").length, 0, "sửa dữ liệu không gửi tin");

      // ⑯ KỊCH BẢN BĂN KHOĂN (outreach NURTURE · P0-C): khách chốt đơn GIỮA hai bước ⇒ đọc lại đơn ngay trước khi gửi ⇒ CONVERTED,
      //    không một tin «chị còn băn khoăn…». Đối chứng: khách chưa có đơn vẫn nhận bước kế tiếp.
      const ot = schema.outreachTargets;
      const oBought = await newOrder("CONFIRMED", "fu-nurture");
      await db.update(schema.orders).set({ pageId: PAGE, conversationId: "pc-nurture-bought" }).where(eq(schema.orders.id, oBought));
      await db.insert(ot).values([
        { id: "fu-nur-bought", segment: "NURTURE", status: "PENDING", pageId: PAGE, conversationId: "pc-nurture-bought", pancakeCustomerId: "", customerName: "Khách A", phone: "0911000001", message: "Chị ơi chị còn băn khoăn gì không ạ", dedupeKey: "fu-nur-bought" },
        { id: "fu-nur-open", segment: "NURTURE", status: "PENDING", pageId: PAGE, conversationId: "pc-nurture-open", pancakeCustomerId: "", customerName: "Khách B", phone: "0911000002", message: "Chị ơi chị còn băn khoăn gì không ạ", dedupeKey: "fu-nur-open" },
      ]);
      const sentNurture: string[] = [];
      const fakeClient = {
        sendMessage: async (_p: string, conversationId: string) => (sentNurture.push(conversationId), { ok: true as const, id: `m-${conversationId}` }),
        sendAttachment: async () => ({ ok: true }),
        listMessages: async () => [],
      } as unknown as NonNullable<Parameters<typeof sendOutreachTargets>[2]>["client"];
      const nr = await sendOutreachTargets(["fu-nur-bought", "fu-nur-open"], "test-fu", { client: fakeClient });
      assert.deepEqual(sentNurture, ["pc-nurture-open"], `chỉ khách CHƯA mua nhận bước kế tiếp: ${JSON.stringify(nr)}`);
      const [nBought] = await db.select({ status: ot.status, orderId: ot.orderId }).from(ot).where(eq(ot.id, "fu-nur-bought"));
      assert.deepEqual([nBought.status, nBought.orderId], ["CONVERTED", oBought], "khách đã chốt ⇒ CONVERTED, mang mã đơn");
    });
  } finally {
    setSalesChatProviderForTests(null);
    await cleanupOrg(ORG);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
  }
}

// ─────────────────────────── 3. ĐƠN ĐÃ XÁC NHẬN THẮNG SỔ CŨ (P0-B / P0-C / P0-H · thuần + quét mã nguồn) ───────────────────────────

export function testConfirmedSettlePure() {
  const lcOf = (order: "CONFIRMED" | "CREATED" | "CREATION_PENDING" | "CANCELLED" | "NONE") => ({ order, orderId: order === "NONE" ? null : "erp-x" });
  const convOf = (p: { status?: string; next?: Date | null; stage?: string }) => ({ status: p.status ?? "WAITING", nextFollowupAt: p.next === undefined ? new Date() : p.next, state: (p.stage ? { stage: p.stage } : {}) as ChatState });
  const s1 = confirmedStaleness(convOf({ stage: "CONFIRM" }), lcOf("CONFIRMED"));
  assert.deepEqual([s1.confirmed, s1.followupScheduled, s1.waiting, s1.stageStale, s1.stale, s1.orderId], [true, true, true, true, true, "erp-x"], "đã xác nhận + lịch + WAITING + bước CONFIRM ⇒ cần dọn");
  assert.equal(confirmedStaleness(convOf({ status: "OPEN", next: null, stage: "DONE" }), lcOf("CONFIRMED")).stale, false, "đã sạch ⇒ không dọn (idempotent)");
  assert.equal(confirmedStaleness(convOf({ status: "OPEN", next: null }), lcOf("CONFIRMED")).stale, true, "bước trống mà đơn đã xác nhận ⇒ dọn");
  for (const o of ["CREATED", "CREATION_PENDING", "CANCELLED", "NONE"] as const) assert.equal(confirmedStaleness(convOf({ stage: "CONFIRM" }), lcOf(o)).stale, false, `${o} ⇒ KHÔNG dọn (chỉ đơn đã xác nhận)`);
  // Tham số script: cờ lạ / số sai ⇒ lỗi, mặc định CHẠY THỬ.
  const okArgs = parseStaleRepairArgs(["hslc"]);
  assert.ok(okArgs.ok && okArgs.args.apply === false && okArgs.args.code === "hslc", "mặc định chạy thử");
  assert.ok(parseStaleRepairArgs(["--all", "--apply", "--days=60"]).ok);
  for (const bad of [[], ["hslc", "--all"], ["hslc", "--days=0"], ["hslc", "--days=121"], ["hslc", "--apply=1"], ["hslc", "--xoa"], ["HSLC;rm"]]) assert.equal(parseStaleRepairArgs(bad).ok, false, `tham số sai bị từ chối: ${bad.join(" ")}`);
}

/**
 * P0-C: sau khi đơn đã xác nhận, KHÔNG đường ERP nào được gửi kịch bản chốt / «còn băn khoăn» / «tiếp tục chốt». Mọi tệp trong
 * lib/ gọi một ống gửi tin RA KHÁCH phải khai ở đây kèm lý do; hai đường TỰ GỬI kịch bản chốt phải đọc ĐƠN THẬT ngay trước khi gửi.
 */
const POST_CONFIRM_SEND_PATHS: Record<string, string> = {
  "lib/sales-chatbot/fanpage.ts": "trả lời TIN MỚI của khách (chatTurn) — được phép sau xác nhận (P0-C); khách nhắn sau khi chốt ⇒ engine chuyển người",
  "lib/sales-chatbot/messenger.ts": "như fanpage — Messenger trực tiếp",
  "lib/sales-chatbot/zalo.ts": "như fanpage — Zalo OA",
  "lib/sales-chatbot/inbox.ts": "NHÂN VIÊN gõ — người quyết",
  "lib/sales-chatbot/order-sync.ts": "xác nhận đặt lại do KHÁCH chủ động mua lại",
  "lib/sales-chatbot/followup.ts": "TỰ GỬI kịch bản chốt — cổng đọc vòng đời ngay trước khi gửi: đơn đã có ⇒ ORDER_EXISTS, đơn đã xác nhận ⇒ dọn sổ",
  "lib/outreach/send.ts": "TỰ GỬI kịch bản băn khoăn (NURTURE) — đọc lại đơn ngay trước khi gửi từng bước ⇒ CONVERTED, không gửi",
  "lib/outreach/broadcast.ts": "chiến dịch NHÂN VIÊN soạn và bấm gửi — campaign riêng (P0-C: bán chéo sau mua là campaign riêng)",
};
const CUSTOMER_SEND = /\b(?:sendBotText|sendFanpageText|sendMessengerPageText|sendMessengerText|sendZaloText|zaloSendText|sendInbox)\(|\.(?:sendMessage|sendText|sendAttachment)\(/;
const SEND_DEF = /function\s+(?:sendBotText|sendFanpageText|sendMessengerPageText|sendMessengerText|sendZaloText|zaloSendText|sendInbox)\(|^\s*(?:sendMessage|sendText|sendAttachment)\(/;

function libFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) libFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

export function testPostConfirmSendPaths() {
  const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
  const senders = libFiles("lib")
    .filter((f) => !f.startsWith("lib/integrations/"))
    .filter((f) => read(f).split("\n").some((ln) => CUSTOMER_SEND.test(ln) && !SEND_DEF.test(ln) && !/^\s*(?:\/\/|\*)/.test(ln)));
  const undeclared = senders.filter((f) => !(f in POST_CONFIRM_SEND_PATHS));
  assert.deepEqual(undeclared, [], `đường gửi tin ra khách CHƯA khai luật sau-xác-nhận (P0-C): ${undeclared.join(", ")}`);
  for (const f of Object.keys(POST_CONFIRM_SEND_PATHS)) assert.ok(senders.includes(f), `khai thừa (tệp không còn gửi tin): ${f}`);
  // Follow-up: cổng đọc vòng đời + dọn sổ đơn đã xác nhận, đều TRƯỚC lời gọi gửi.
  const fu = read("lib/sales-chatbot/followup.ts");
  const send = fu.indexOf("await sendBotText(");
  assert.ok(fu.indexOf("decideFollowup(") > 0 && fu.indexOf("decideFollowup(") < send, "follow-up: cổng trước khi gửi");
  assert.ok(fu.indexOf("settleConfirmedConversation(") > 0 && fu.indexOf("settleConfirmedConversation(") < send, "follow-up: dọn sổ đơn đã xác nhận ở nhánh chặn");
  assert.ok(read("lib/sales-chatbot/followup-shared.ts").includes('return no("ORDER_EXISTS")'), "decideFollowup có nhánh ORDER_EXISTS");
  // Xếp lịch: đọc đơn thật trước khi xếp.
  const fp = read("lib/sales-chatbot/fanpage.ts");
  const mw = fp.slice(fp.indexOf("export async function markWaitingForCustomer("));
  assert.ok(mw.indexOf("loadLifecycle(") > 0 && mw.indexOf("loadLifecycle(") < mw.indexOf("nextFollowupAt(now"), "xếp lịch: đọc đơn thật TRƯỚC khi xếp");
  // Kịch bản băn khoăn: đọc lại đơn TRƯỚC lời gọi gửi.
  const os = read("lib/outreach/send.ts");
  assert.ok(os.indexOf("hasRecentOrder(") > 0 && os.indexOf("hasRecentOrder(") < os.indexOf("client.sendMessage("), "kịch bản băn khoăn: đọc lại đơn TRƯỚC khi gửi");
}

export async function testFollowupLifecycle() {
  testLifecyclePure();
  testConfirmedSettlePure();
  testPostConfirmSendPaths();
  await testFollowupLifecycleDb();
  console.log("  ✓ vòng đời khách + follow-up an toàn: sáu chiều độc lập (SĐT ≠ đơn, nháp bot ≠ đơn, Pancake PAID ≠ tiền); cổng đọc lại trước khi gửi — đã tạo đơn / đã thu / đã huỷ / từ chối nhận tin / khách vừa nhắn / người vừa trả lời / nguồn ERP khác ⇒ không gửi; hai worker · cron lặp · khoá có sẵn ⇒ một tin; ca KimThu Le ⇒ không gửi; vết đủ trường không PII; «đã lên đơn» khi đơn chưa xác nhận ⇒ claim-guard chặn");
  console.log("  ✓ đơn đã xác nhận thắng sổ cũ: xếp lịch + job phát hiện ⇒ huỷ lịch, WAITING ⇒ OPEN, bước DONE, vết theo nơi phát hiện; ca Kiều Văn Lệ ⇒ không lịch, không tin; sửa dữ liệu: chạy thử 0 dòng ghi, --apply dọn đúng (a)+(b), chạy lại = không làm gì, đơn Mới / huỷ không đụng; mọi đường gửi tin ra khách khai luật sau-xác-nhận, kịch bản băn khoăn đọc lại đơn trước khi gửi");
}
