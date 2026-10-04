/**
 * ═══════════ POS TỰ CHỦ · P5 — NHÂN VIÊN TẠO ĐƠN TRONG KHUNG CHAT (docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Khoá:
 *  · đơn đi ĐÚNG đường tạo đơn tay chung, mang `origin = ERP_FORM` + `sales_conversation_id`, sự kiện hội thoại `HUMAN` kèm
 *    khoá tài khoản (không bao giờ cộng công cho bot);
 *  · CÙNG `requestKey` (bấm hai lần) ⇒ đúng MỘT đơn, MỘT sự kiện, MỘT dòng nhật ký;
 *  · khách theo SĐT: chưa có ⇒ tạo; đã có ⇒ dùng lại và KHÔNG sửa tên / địa chỉ đang lưu — tên / địa chỉ mới vào NGƯỜI NHẬN;
 *  · hội thoại đã có đơn còn sống (bot chốt) ⇒ form thấy để cảnh báo, không chặn;
 *  · khung thử ⇒ từ chối; thiếu `orders:write` ⇒ từ chối, không ghi; hội thoại lạ ⇒ không có.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { chatOrderContext, createOrderFromChatCore } from "@/lib/records/chat-order";

const ORG = "don-trong-chat";

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

export async function testChatOrder() {
  await cleanupOrg(ORG);
  try {
    await provisionOrganization({ code: ORG, name: "Shop tạo đơn trong chat", plan: "standard", modules: ["customers", "products", "orders", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "DonTrongChat@123" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop tạo đơn trong chat", isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const viewer = { ...admin, role: "VIEWER", permissions: ["orders:read", "ai_sales:view"] } as unknown as SessionUser;

      await db.insert(schema.products).values({ id: "erp-chat-prod", name: "Váy hoa", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-chat-var", productId: "erp-chat-prod", sku: "VH-M", size: "M", retailPrice: 350_000, weight: 300 });
      const [conv] = await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE", status: "HANDOFF" }).returning({ id: schema.salesChatConversations.id });
      const [testConv] = await db.insert(schema.salesChatConversations).values({ channel: "TEST" }).returning({ id: schema.salesChatConversations.id });

      // ── Ngữ cảnh form: có quyền, có mẫu mã, chưa có đơn ──
      const ctx = await chatOrderContext(admin, conv.id);
      assert.ok(ctx.ok && ctx.value.canCreate && ctx.value.variants.some((v) => v.id === "erp-chat-var") && ctx.value.existing.length === 0 && ctx.value.channel === "Fanpage", JSON.stringify(ctx));
      const vctx = await chatOrderContext(viewer, conv.id);
      assert.ok(vctx.ok && !vctx.value.canCreate && vctx.value.variants.length === 0, "thiếu quyền ⇒ form không mở, không lộ danh mục");

      const input = (requestKey: string, extra: Record<string, unknown> = {}) => ({ requestKey, name: "Chị Lan", phone: "0912 345 678", address: "12 Hàng Bạc, Hoàn Kiếm", province: "Hà Nội", stage: "CONFIRMED", lines: [{ variantId: "erp-chat-var", quantity: 2, unitPrice: 350_000 }], shippingFee: 30_000, ...extra });

      // ── Tạo: khách mới theo SĐT; đơn của NGƯỜI gắn về hội thoại ──
      const r1 = await createOrderFromChatCore(admin, conv.id, input("lan-bam-0001"));
      assert.ok(r1.ok && !r1.reused && r1.customerExisting === false, JSON.stringify(r1));
      const [o1] = await db.select().from(schema.orders).where(eq(schema.orders.id, r1.orderId));
      assert.ok(o1.origin === "ERP_FORM" && o1.salesConversationId === conv.id && o1.stage === "CONFIRMED" && o1.source === "Fanpage", JSON.stringify({ origin: o1.origin, conv: o1.salesConversationId, stage: o1.stage, source: o1.source }));
      assert.ok(o1.totalPriceAfterDiscount === 700_000 && o1.shippingFee === 30_000, "tiền hàng 2 × 350.000 (cùng nghĩa cột Pancake, không gồm ship) + ship khách trả 30.000");
      const evs = () => db.select().from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.conversationId, conv.id), eq(schema.salesConversationEvents.type, "order.confirmed")));
      const e1 = await evs();
      assert.ok(e1.length === 1 && e1[0].actorKind === "HUMAN" && e1[0].actorUserId === admin.id && e1[0].orderId === r1.orderId && e1[0].amountVnd === 700_000, JSON.stringify(e1));

      // ── Bấm hai lần (cùng requestKey) ⇒ đúng một đơn, một sự kiện, một dòng nhật ký ──
      const r1b = await createOrderFromChatCore(admin, conv.id, input("lan-bam-0001"));
      assert.ok(r1b.ok && r1b.reused && r1b.orderId === r1.orderId, JSON.stringify(r1b));
      assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, conv.id))).length, 1);
      assert.equal((await evs()).length, 1);
      assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHAT_ORDER_CREATE"))).length, 1);

      // ── Khách cũ cùng SĐT: dùng lại, KHÔNG sửa hồ sơ; tên / địa chỉ mới vào người nhận của đơn ──
      const r2 = await createOrderFromChatCore(admin, conv.id, input("lan-bam-0002", { name: "Anh Minh (chồng chị Lan)", address: "5 Lý Thái Tổ, Hoàn Kiếm", stage: "NEW" }));
      assert.ok(r2.ok && r2.customerExisting === true && r2.orderId !== r1.orderId, JSON.stringify(r2));
      const [o2] = await db.select().from(schema.orders).where(eq(schema.orders.id, r2.orderId));
      assert.equal(o2.customerId, o1.customerId, "một SĐT, một khách");
      assert.equal(o2.shipFullName, "Anh Minh (chồng chị Lan)");
      const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.id, o1.customerId!));
      assert.ok(cust.name === "Chị Lan" && cust.address === "12 Hàng Bạc, Hoàn Kiếm", "hồ sơ khách không bị đè (mục 3.12)");
      const drafted = await db.select().from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.conversationId, conv.id), eq(schema.salesConversationEvents.type, "order.drafted")));
      assert.equal(drafted.length, 1, "đơn «Mới» ⇒ sự kiện order.drafted");

      // ── Đơn bot chốt đã có ⇒ form thấy để cảnh báo (không chặn) ──
      await db.insert(schema.orders).values({ id: "erp-bot-chot-1", stage: "CONFIRMED", status: 1, billFullName: "Chị Lan", totalPrice: 350_000, totalPriceAfterDiscount: 350_000, insertedAt: new Date(), origin: "AI_AGENT", salesConversationId: conv.id });
      const ctx2 = await chatOrderContext(admin, conv.id);
      assert.ok(ctx2.ok && ctx2.value.existing.length === 3 && ctx2.value.existing.find((e) => e.id === "erp-bot-chot-1")?.byBot === true && ctx2.value.existing.find((e) => e.id === r1.orderId)?.byBot === false, JSON.stringify(ctx2.ok ? ctx2.value.existing : ctx2));
      const r3 = await createOrderFromChatCore(admin, conv.id, input("lan-bam-0003"));
      assert.ok(r3.ok, "có đơn bot vẫn tạo được — người quyết");

      // ── Từ chối: khung thử, thiếu quyền, hội thoại lạ, khoá lượt bấm sai dạng ──
      const before = (await db.select().from(schema.orders)).length;
      const t = await createOrderFromChatCore(admin, testConv.id, input("lan-bam-0004"));
      assert.ok(!t.ok && t.code === "NOT_SUPPORTED", JSON.stringify(t));
      const f = await createOrderFromChatCore(viewer, conv.id, input("lan-bam-0005"));
      assert.ok(!f.ok && f.code === "FORBIDDEN", JSON.stringify(f));
      const n = await createOrderFromChatCore(admin, "00000000-0000-0000-0000-000000000000", input("lan-bam-0006"));
      assert.ok(!n.ok && n.code === "NOT_FOUND", JSON.stringify(n));
      const k = await createOrderFromChatCore(admin, conv.id, input("ngan"));
      assert.ok(!k.ok && k.code === "INVALID", JSON.stringify(k));
      assert.equal((await db.select().from(schema.orders)).length, before, "bốn lượt bị từ chối không ghi đơn nào");
    });
  } finally {
    await cleanupOrg(ORG);
  }
  console.log("  ✓ Tạo đơn trong khung chat: đơn đi đường tạo đơn tay chung, origin ERP_FORM + khoá hội thoại, sự kiện HUMAN kèm khoá tài khoản; bấm hai lần cùng khoá ⇒ một đơn / một sự kiện / một nhật ký; khách theo SĐT dùng lại, không đè hồ sơ, tên / địa chỉ mới vào người nhận; đơn bot chốt hiện để cảnh báo, không chặn; khung thử / thiếu quyền / hội thoại lạ / khoá sai ⇒ từ chối, không ghi");
}
