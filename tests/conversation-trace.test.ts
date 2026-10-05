/**
 * ═══════════ ĐƠN ↔ HỘI THOẠI ↔ KHÁCH (gap analysis slice 6) ═══════════
 *
 * Khoá:
 *  · `chatLinkOf` (thuần): tổ chức có Hộp thư khách ⇒ link NỘI BỘ tới hộp thư cho MỌI kênh; không có hộp thư ⇒ link Pancake
 *    chỉ cho hội thoại fanpage (Zalo / web không có link Pancake); đơn đồng bộ Pancake giữ link mang sẵn.
 *  · `orderChatThreads`: khoá CỨNG `orders.sales_conversation_id` thắng (cả Messenger trực tiếp / Zalo / web); đường cũ tra
 *    ngược `state` vẫn chạy; hội thoại kênh thử không bao giờ được nối.
 *  · `customerConversations`: chỉ hội thoại gắn khách hoặc sinh ra đơn của khách — hội thoại của khách TRÙNG TÊN không lọt vào.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { customerConversations } from "@/lib/queries/customer-conversations";
import { chatLinkOf, orderChatThreads, salesInboxEnabled } from "@/lib/queries/orders";

const ORG = "truy-vet-hoi-thoai";

function testPure() {
  const fb = { conversationId: "conv-1", channel: "FANPAGE", pageId: "111", threadId: "psid-9" };
  const zalo = { conversationId: "conv-2", channel: "ZALO", pageId: "oa-1", threadId: "u-1" };
  const none = { pageId: null, conversationId: null };
  assert.deepEqual(chatLinkOf(fb, true, none), { href: "/ai/sales-chatbot/inbox?c=conv-1", internal: true });
  assert.deepEqual(chatLinkOf(zalo, true, none), { href: "/ai/sales-chatbot/inbox?c=conv-2", internal: true }, "Zalo cũng mở trong hộp thư");
  assert.deepEqual(chatLinkOf(fb, false, none), { href: "https://pancake.vn/111?c_id=psid-9", internal: false }, "không hộp thư ⇒ như trước");
  assert.equal(chatLinkOf(zalo, false, none), null, "Zalo không có link Pancake");
  assert.deepEqual(chatLinkOf(undefined, true, { pageId: "222", conversationId: "222_333" }), { href: "https://pancake.vn/222?c_id=222_333", internal: false }, "đơn đồng bộ giữ link Pancake mang sẵn");
  assert.equal(chatLinkOf(undefined, true, none), null);
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

async function testDb() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "TruyVet@12345" }, source: "TEST", actor: null });
  await withOrganization(ORG, async () => {
    const db = await getDb();
    assert.equal(await salesInboxEnabled(), true, "tổ chức bật AI bán hàng ⇒ có hộp thư");
    const c = schema.salesChatConversations;
    await db.insert(schema.customers).values([
      { id: "erp-kh-hoa", name: "Chị Hoa" },
      { id: "erp-kh-hoa-2", name: "Chị Hoa" },
    ]);
    const [messenger] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", pageId: "555", threadId: "psid-1", visitorKey: "vk-1" }).returning({ id: c.id });
    const [zalo] = await db.insert(c).values({ channel: "ZALO", status: "HANDOFF", pageId: "oa-1", threadId: "zu-1", visitorKey: "vk-2", customerId: "erp-kh-hoa" }).returning({ id: c.id });
    const [legacy] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", pageId: "555", threadId: "psid-2", visitorKey: "vk-3", orderId: "erp-don-cu" }).returning({ id: c.id });
    const [other] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", pageId: "555", threadId: "psid-3", visitorKey: "vk-4", customerId: "erp-kh-hoa-2", state: { customer: { name: "Chị Hoa" } } }).returning({ id: c.id });
    const [test] = await db.insert(c).values({ channel: "TEST", status: "OPEN" }).returning({ id: c.id });
    const order = (id: string, customerId: string | null, conv: string | null) =>
      db.insert(schema.orders).values({ id, stage: "CONFIRMED", status: 1, billFullName: "Chị Hoa", totalPrice: 350_000, totalPriceAfterDiscount: 350_000, insertedAt: new Date(), customerId, salesConversationId: conv, origin: "AI_AGENT", raw: { origin: "ERP_MANUAL" } });
    await order("erp-don-msg", "erp-kh-hoa", messenger.id);
    await order("erp-don-cu", "erp-kh-hoa", null);
    await order("erp-don-thu", null, test.id);

    const links = await orderChatThreads(["erp-don-msg", "erp-don-cu", "erp-don-thu"]);
    assert.equal(links.get("erp-don-msg")?.conversationId, messenger.id, "khoá cứng sales_conversation_id");
    assert.equal(links.get("erp-don-cu")?.conversationId, legacy.id, "đường cũ tra ngược state vẫn chạy");
    assert.equal(links.has("erp-don-thu"), false, "hội thoại kênh thử không bao giờ được nối");

    const chats = await customerConversations("erp-kh-hoa");
    const ids = chats.map((x) => x.id).sort();
    assert.deepEqual(ids, [messenger.id, zalo.id].sort(), `hội thoại gắn khách + hội thoại sinh ra đơn của khách: ${JSON.stringify(chats)}`);
    assert.ok(!ids.includes(other.id), "khách TRÙNG TÊN ở hội thoại khác không lọt vào hồ sơ");
    assert.equal(chats.find((x) => x.id === messenger.id)?.orders, 1);
    assert.equal(chats.find((x) => x.id === zalo.id)?.status, "HANDOFF");
    assert.deepEqual(await customerConversations("khong-co-khach"), []);
  });
}

export async function testConversationTrace() {
  testPure();
  await cleanup();
  try {
    await testDb();
  } finally {
    await cleanup();
  }
  console.log("✓ Đơn ↔ hội thoại ↔ khách: đơn bot / chat mở hội thoại trong Hộp thư ERP (mọi kênh, khoá sales_conversation_id thắng, đường cũ vẫn chạy, kênh thử không nối); không hộp thư ⇒ link Pancake như trước; hồ sơ khách chỉ thấy hội thoại nối bằng khoá cứng — trùng tên không lọt");
}

if (process.argv[1] && /conversation-trace\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testConversationTrace)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
