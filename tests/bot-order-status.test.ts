/**
 * BOT TRA TRẠNG THÁI ĐƠN (Commerce Truth · Master Mission mục V) — `get_order_status`.
 *
 *  · PHẠM VI: chỉ đơn gắn với CHÍNH hội thoại (`sales_conversation_id`), đơn bot đã chốt trong hội thoại, hoặc của khách hội
 *    thoại đã nhận diện — đơn của khách khác KHÔNG BAO GIỜ lộ ra, kể cả cùng tổ chức.
 *  · TRẠNG THÁI = LỜI KHAI của đơn vị vận chuyển (chặng dựng từ sự kiện ĐVVC — AGENTS mục 47, ORDER_OUTCOME.md mục 1): đã thu
 *    tiền / COD mà chưa có sự kiện ĐVVC ⇒ vẫn «chưa có thông tin vận chuyển», không suy «đã giao» từ tiền.
 *  · Khung THỬ không đọc đơn thật; công cụ quy trình luôn bật (kể cả cấu hình cũ đã lưu).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { CUSTOMER_SHIPMENT_STATUS, executeTool, PROCESS_TOOLS, toolDefsFor, type ChatState } from "@/lib/sales-chatbot/tools";

const ORG = "bot-tra-don";

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

type Ord = { orders: { order_code: string; status: string; carrier_status: string | null; tracking_code: string | null; total: string | null }[]; note: string };

async function run() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const conv = async () => (await db.insert(schema.salesChatConversations).values({ channel: "WEB" }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const c1 = await conv();
    const c2 = await conv();
    const now = Date.now();
    const order = async (id: string, conversationId: string | null, minutesAgo: number, extra: Partial<typeof schema.orders.$inferInsert> = {}) => {
      await db.insert(schema.orders).values({ id, insertedAt: new Date(now - minutesAgo * 60_000), salesConversationId: conversationId, totalPrice: 350_000, ...extra });
    };
    // c1: đơn đang giao (lời khai ĐVVC) · đơn chưa giao cho ĐVVC · đơn ĐÃ THU TIỀN nhưng chưa có sự kiện ĐVVC nào.
    await order("btd-o1", c1, 30);
    await db.insert(schema.shipments).values({ orderId: "btd-o1", vtpOrderNumber: "BTD100001", stage: "OUT_FOR_DELIVERY", vtpStatusName: "Đang giao hàng", vtpStatusDate: new Date(now - 10 * 60_000) });
    await order("btd-o2", c1, 20);
    await order("btd-o3", c1, 10);
    await db.insert(schema.shipments).values({ orderId: "btd-o3", vtpOrderNumber: "BTD100003", stage: "UNKNOWN", codStatus: "RECONCILED", codCollected: 350_000 });
    // c2: đơn của KHÁCH KHÁC đã giao — không được lộ sang c1.
    await order("btd-o9", c2, 5);
    await db.insert(schema.shipments).values({ orderId: "btd-o9", vtpOrderNumber: "BTD100009", stage: "DELIVERED", vtpStatusName: "Giao thành công", vtpStatusDate: new Date(now - 60_000) });

    const cfg = parseSalesChatbotConfig(null);
    const ctx = (conversationId: string, state: ChatState = {}, channel: "WEB" | "TEST" = "WEB") => ({ conversationId, channel, config: cfg, state, lastUserText: "Đơn của em tới đâu rồi shop?", agent: { name: "t", source: "t" } });

    // Công cụ quy trình luôn có (kể cả cấu hình cũ đã lưu không khai công cụ mới).
    assert.ok(PROCESS_TOOLS.includes("get_order_status") && toolDefsFor(cfg).some((d) => d.name === "get_order_status"));

    const r1 = await executeTool("get_order_status", {}, ctx(c1));
    assert.ok(!r1.isError, r1.content);
    const v1 = JSON.parse(r1.content) as Ord;
    assert.equal(v1.orders.length, 3, `đúng ba đơn của hội thoại: ${r1.content}`);
    const byTracking = new Map(v1.orders.map((o) => [o.tracking_code, o]));
    assert.equal(byTracking.get("BTD100001")?.status, CUSTOMER_SHIPMENT_STATUS.OUT_FOR_DELIVERY, "chặng ĐVVC ⇒ câu cho khách");
    assert.equal(byTracking.get("BTD100001")?.carrier_status, "Đang giao hàng", "kèm nguyên văn lời khai ĐVVC");
    assert.equal(byTracking.get("BTD100003")?.status, CUSTOMER_SHIPMENT_STATUS.UNKNOWN, "đã thu tiền mà chưa có sự kiện ĐVVC ⇒ KHÔNG suy «đã giao» từ tiền");
    assert.ok(v1.orders.some((o) => o.tracking_code === null && /chuẩn bị/.test(o.status)), "đơn chưa có vận đơn ⇒ shop đang chuẩn bị");
    assert.ok(!r1.content.includes("BTD100009") && !v1.orders.some((o) => o.status === CUSTOMER_SHIPMENT_STATUS.DELIVERED), "đơn của khách khác không lộ");
    assert.ok(v1.orders.every((o) => o.order_code.startsWith("#")));

    // Hội thoại không có đơn ⇒ nói thẳng, hướng chuyển nhân viên, không tra theo SĐT.
    const empty = await executeTool("get_order_status", { phone: "0900000000" }, ctx(await conv()));
    const ve = JSON.parse(empty.content) as Ord;
    assert.ok(!empty.isError && ve.orders.length === 0 && /KHÔNG tự tra theo SĐT/.test(ve.note), empty.content);

    // Đơn bot đã chốt trong hội thoại (state.confirmed) được tra dù đơn chưa gắn sales_conversation_id.
    await order("btd-o5", null, 3);
    const r5 = await executeTool("get_order_status", {}, ctx(await conv(), { confirmed: { orderId: "btd-o5", simulated: false, total: 350_000, at: new Date().toISOString() } }));
    assert.equal((JSON.parse(r5.content) as Ord).orders.length, 1, "đơn đã chốt trong hội thoại");

    // Khung THỬ không đọc đơn thật.
    const t = await executeTool("get_order_status", {}, ctx(c1, {}, "TEST"));
    assert.equal((JSON.parse(t.content) as Ord).orders.length, 0, "khung thử không đọc đơn thật");
  });
}

export async function testBotOrderStatus() {
  await cleanup();
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "TraDon@12345" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log("✓ Bot tra trạng thái đơn: chỉ đơn của CHÍNH hội thoại / đơn đã chốt trong hội thoại · trạng thái = lời khai ĐVVC kèm nguyên văn · đã thu tiền mà chưa có sự kiện ĐVVC ⇒ không suy «đã giao» · đơn khách khác không lộ · không có đơn ⇒ chuyển nhân viên, không tra theo SĐT · khung thử không đọc đơn thật · công cụ luôn bật");
}
