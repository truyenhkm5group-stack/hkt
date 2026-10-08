/**
 * ═══════════ POS TỰ CHỦ · P5 — NHÂN VIÊN TẠO ĐƠN TRONG KHUNG CHAT (docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Khoá:
 *  · đơn đi ĐÚNG đường tạo đơn tay chung, mang `origin = ERP_FORM` + `sales_conversation_id`, sự kiện hội thoại `HUMAN` kèm
 *    khoá tài khoản (không bao giờ cộng công cho bot);
 *  · CÙNG `requestKey` (bấm hai lần) ⇒ đúng MỘT đơn, MỘT sự kiện, MỘT dòng nhật ký;
 *  · khách theo SĐT: chưa có ⇒ tạo; đã có ⇒ dùng lại và KHÔNG sửa tên / địa chỉ đang lưu — tên / địa chỉ mới vào NGƯỜI NHẬN;
 *  · hội thoại đã có đơn còn sống (bot chốt) ⇒ form thấy để cảnh báo, không chặn;
 *  · hồ sơ CHƯA xác minh là của người đang chat (gắn qua SĐT gõ tay) ⇒ form không điền tên / địa chỉ ĐÃ LƯU, ô trống lấy chữ khách
 *    gõ trong hội thoại, không có thì bắt nhập — kể cả khi bỏ chọn hồ sơ và chỉ gõ SĐT; hồ sơ khớp Facebook ⇒ như cũ;
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
import { subscribe } from "@/lib/realtime/bus";
import { chatCustomerTrust, chatOrderContext, createOrderFromChatCore } from "@/lib/records/chat-order";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { listDrillConversations } from "@/lib/sales-chatbot/experiment-report";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";

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
  // ── Hàm thuần: chỉ cờ máy chủ `verifiedIdentity` của ĐÚNG hồ sơ đang gắn mới là «đã xác minh» ──
  assert.deepEqual(chatCustomerTrust(null, "kh-1"), { verified: false, typed: null });
  assert.equal(chatCustomerTrust({ customer: { id: "kh-1", name: "A", verifiedIdentity: true } }, "kh-1").verified, true);
  assert.deepEqual(chatCustomerTrust({ customer: { id: "kh-1", name: "A", verifiedIdentity: true } }, "kh-2"), { verified: false, typed: null }, "chữ của MỘT hồ sơ khác không phải của hội thoại này");
  assert.deepEqual(chatCustomerTrust({ customer: { id: null, name: " Bé ", phone: "09", address: "1 A", province: "HN" } }, null), { verified: false, typed: { name: "Bé", phone: "09", address: "1 A", province: "HN" } });
  assert.deepEqual(chatCustomerTrust({ customer: { id: null, name: "Thử", simulated: true } }, null), { verified: false, typed: null }, "khung thử không có khách thật");
  assert.deepEqual(chatCustomerTrust({ customer: { id: "kh-1", name: "Chủ SĐT", address: "Địa chỉ đầy đủ", savedAddress: true } }, "kh-1"), { verified: false, typed: null }, "chữ MÁY CHỦ điền từ đơn cũ không phải chữ khách gõ");
  assert.equal(chatCustomerTrust({ customer: { id: "kh-1", verifiedIdentity: "true" } }, "kh-1").verified, false, "chỉ đúng giá trị true");

  await cleanupOrg(ORG);
  try {
    await provisionOrganization({ code: ORG, name: "Shop tạo đơn trong chat", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "DonTrongChat@123" }, source: "TEST", actor: null });
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
      const seen: { type: string; action?: string; source?: string; orderId?: string }[] = [];
      const unsub = subscribe((e) => seen.push(e as never));
      const r1 = await createOrderFromChatCore(admin, conv.id, input("lan-bam-0001"));
      unsub();
      assert.ok(r1.ok && seen.some((e) => e.type === "order" && e.action === "created" && e.source === "ERP" && e.orderId === r1.orderId), `đơn ERP mới phát sự kiện realtime cho trang Đơn hàng đang mở (${JSON.stringify(seen)})`);
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

      // ── Màn «Hiệu quả» + drill-down: đơn NGƯỜI tạo trong khung chat KHÔNG phải «đơn bot chốt» (events-sql.ts) ──
      // Trước bản vá, `order.confirmed` tác nhân HUMAN của form này bị đếm vào đơn bot chốt, doanh thu AI và chi phí AI / đơn,
      // và hội thoại chỉ có đơn người vẫn nằm ở nhóm «AI tự làm». Đối chứng: hội thoại thứ hai bot chốt THẬT (sự kiện mang
      // tác nhân CUSTOMER — khách đồng ý với bot) vẫn phải đếm — lọc nhầm `actor = 'AI'` sẽ làm nó mất.
      await recordConversationEvent(conv.id, { type: "message.received", actorKind: "CUSTOMER", occurredAt: new Date(), key: "msg:1" });
      const [botConv] = await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE" }).returning({ id: schema.salesChatConversations.id });
      await db.insert(schema.orders).values({ id: "erp-bot-chot-2", stage: "CONFIRMED", status: 1, billFullName: "Anh Tú", totalPrice: 420_000, totalPriceAfterDiscount: 420_000, insertedAt: new Date(), origin: "AI_AGENT", salesConversationId: botConv.id });
      await recordConversationEvent(botConv.id, { type: "message.received", actorKind: "CUSTOMER", occurredAt: new Date(), key: "msg:1" });
      await recordConversationEvent(botConv.id, { type: "order.confirmed", actorKind: "CUSTOMER", occurredAt: new Date(), orderId: "erp-bot-chot-2", amountVnd: 420_000, key: "confirm:erp-bot-chot-2" });
      const perf = await loadAiSalesPerformance(ORG, { withMoney: false });
      assert.equal(perf.orders.confirmed, 1, `chỉ đơn bot chốt: ${JSON.stringify(perf.orders)}`);
      assert.equal(perf.orders.confirmedValueVnd, 420_000);
      assert.deepEqual([perf.cohorts.aiOnly.conversations, perf.cohorts.aiOnly.confirmed, perf.cohorts.aiThenHuman.conversations, perf.cohorts.aiThenHuman.confirmed], [1, 1, 1, 0], "hội thoại có đơn người ⇒ nhóm có người, không có đơn bot");
      const drillAi = await listDrillConversations(admin, { days: 30, cohort: "AI_ONLY", reason: null, arm: null, confirmed: true });
      assert.ok("ok" in drillAi && drillAi.rows.map((r) => r.id).join() === botConv.id, `ô «AI tự chốt» mở đúng hội thoại bot chốt: ${JSON.stringify(drillAi)}`);
      const drillHuman = await listDrillConversations(admin, { days: 30, cohort: "AI_THEN_HUMAN", reason: null, arm: null, confirmed: false });
      assert.ok("ok" in drillHuman && drillHuman.rows.map((r) => r.id).join() === conv.id, JSON.stringify(drillHuman));

      // ── Hồ sơ CHƯA xác minh là của người đang chat (review bảo mật #656, MEDIUM): kẻ gian gõ SĐT nạn nhân rồi xin gặp người ⇒
      // form từng hiện tên + địa chỉ THẬT của nạn nhân dưới nhãn «khách của hội thoại», ô trống thì đơn đi về địa chỉ ĐÃ LƯU. ──
      const [victim] = await db.insert(schema.customers).values({ name: "Nạn Nhân Thật", phone: "0977111222", address: "99 Đường Nhà Thật", province: "Hà Nội" }).returning({ id: schema.customers.id });
      const [phish] = await db
        .insert(schema.salesChatConversations)
        .values({ channel: "FANPAGE", status: "HANDOFF", customerId: victim.id, state: { customer: { id: victim.id, name: "Kẻ Gõ", phone: "0977111222", address: "1 Đường Kẻ Gõ", province: "Hà Nội", simulated: false } } })
        .returning({ id: schema.salesChatConversations.id });
      const pc = await chatOrderContext(admin, phish.id);
      assert.ok(pc.ok && pc.value.customer?.verified === false && pc.value.customer.name === "Kẻ Gõ" && pc.value.customer.address === "1 Đường Kẻ Gõ", JSON.stringify(pc));
      assert.ok(!/Nạn Nhân Thật|99 Đường Nhà Thật/.test(JSON.stringify(pc)), "form không bao giờ thấy chữ ĐÃ LƯU của hồ sơ chưa xác minh");
      const blank = { requestKey: "phish-bam-0001", customerId: victim.id, name: "", phone: "", address: "", province: "", stage: "NEW", lines: [{ variantId: "erp-chat-var", quantity: 1, unitPrice: 350_000 }] };
      const ph1 = await createOrderFromChatCore(admin, phish.id, blank);
      assert.ok(ph1.ok, JSON.stringify(ph1));
      const [po] = await db.select().from(schema.orders).where(eq(schema.orders.id, ph1.orderId));
      assert.ok(po.shipFullName === "Kẻ Gõ" && po.shipAddress === "1 Đường Kẻ Gõ", `ô trống ⇒ chữ khách gõ trong hội thoại, không phải của hồ sơ: ${JSON.stringify({ name: po.shipFullName, addr: po.shipAddress })}`);
      assert.notEqual(po.shipProvince, "", "tỉnh khách gõ đi cùng địa chỉ khách gõ (dòng địa chỉ không nói tỉnh)");
      // Bỏ chọn hồ sơ, để trống hết ⇒ tìm khách theo SĐT khách GÕ, người nhận là chữ khách gõ — không phải của hồ sơ tìm được.
      const ph2 = await createOrderFromChatCore(admin, phish.id, { ...blank, requestKey: "phish-bam-0002", customerId: null });
      assert.ok(ph2.ok && ph2.customerExisting === true, JSON.stringify(ph2));
      const [po2] = await db.select().from(schema.orders).where(eq(schema.orders.id, ph2.orderId));
      assert.ok(po2.customerId === victim.id && po2.shipFullName === "Kẻ Gõ" && po2.shipAddress === "1 Đường Kẻ Gõ", JSON.stringify({ c: po2.customerId, name: po2.shipFullName, addr: po2.shipAddress }));
      // Hồ sơ gắn mà hội thoại chưa gõ gì ⇒ không điền sẵn; ô trống bị từ chối — kể cả khi bỏ chọn hồ sơ và chỉ gõ SĐT của nó.
      const [bare] = await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE", status: "HANDOFF", customerId: victim.id }).returning({ id: schema.salesChatConversations.id });
      const bc = await chatOrderContext(admin, bare.id);
      assert.ok(bc.ok && bc.value.customer?.verified === false && bc.value.customer.name === "" && bc.value.customer.address === "" && bc.value.customer.phone === "0977111222", JSON.stringify(bc));
      const bareBefore = (await db.select().from(schema.orders)).length;
      const b1 = await createOrderFromChatCore(admin, bare.id, { ...blank, requestKey: "bare-bam-0001" });
      assert.ok(!b1.ok && b1.code === "INVALID" && /"address"/.test(JSON.stringify(b1)) && /"name"/.test(JSON.stringify(b1)), JSON.stringify(b1));
      const b2 = await createOrderFromChatCore(admin, bare.id, { ...blank, requestKey: "bare-bam-0002", customerId: null, phone: "0977111222", name: "Ai Đó" });
      assert.ok(!b2.ok && b2.code === "INVALID" && /"address"/.test(JSON.stringify(b2)) && !/"name"/.test(JSON.stringify(b2)), JSON.stringify(b2));
      assert.equal((await db.select().from(schema.orders)).length, bareBefore, "ô trống của hồ sơ chưa xác minh ⇒ không ghi đơn");
      // Hồ sơ ĐÃ xác minh (khớp mã Facebook — cờ máy chủ ghi) ⇒ như cũ: điền sẵn chữ của HỒ SƠ, ô trống lấy của hồ sơ.
      const [own] = await db
        .insert(schema.salesChatConversations)
        .values({ channel: "FANPAGE", status: "HANDOFF", customerId: victim.id, state: { customer: { id: victim.id, name: "Tên Gõ", phone: "0977111222", address: "Địa Chỉ Gõ", province: "", simulated: false, verifiedIdentity: true } } })
        .returning({ id: schema.salesChatConversations.id });
      const oc = await chatOrderContext(admin, own.id);
      assert.ok(oc.ok && oc.value.customer?.verified === true && oc.value.customer.name === "Nạn Nhân Thật" && oc.value.customer.address === "99 Đường Nhà Thật", JSON.stringify(oc));
      const ov = await createOrderFromChatCore(admin, own.id, { ...blank, requestKey: "own-bam-0001" });
      assert.ok(ov.ok, JSON.stringify(ov));
      const [oo] = await db.select().from(schema.orders).where(eq(schema.orders.id, ov.orderId));
      assert.ok(oo.shipFullName === "Nạn Nhân Thật" && oo.shipAddress === "99 Đường Nhà Thật", JSON.stringify({ name: oo.shipFullName, addr: oo.shipAddress }));
      // Chọn một hồ sơ KHÁC hồ sơ đã xác minh của hội thoại ⇒ không còn là «đã xác minh»: ô trống lấy chữ gõ, không lấy của hồ sơ.
      const [other] = await db.insert(schema.customers).values({ name: "Hồ Sơ Khác", phone: "0977333444", address: "7 Đường Khác", province: "" }).returning({ id: schema.customers.id });
      const ox = await createOrderFromChatCore(admin, own.id, { ...blank, requestKey: "own-bam-0002", customerId: other.id });
      assert.ok(ox.ok, JSON.stringify(ox));
      const [oxo] = await db.select().from(schema.orders).where(eq(schema.orders.id, ox.orderId));
      assert.ok(oxo.shipAddress === "Địa Chỉ Gõ" && oxo.shipFullName === "Tên Gõ", JSON.stringify({ name: oxo.shipFullName, addr: oxo.shipAddress }));
      // Review #657 (MEDIUM): kẻ gian gõ SĐT nạn nhân, đáp «đúng» cho địa chỉ ĐÃ CHE ⇒ máy chủ ghi tên + địa chỉ ĐẦY ĐỦ của nạn nhân vào
      // `state.customer` (`savedAddress`). Đó KHÔNG phải chữ khách gõ: form không hiện, ô trống không dùng.
      const [saved] = await db
        .insert(schema.salesChatConversations)
        .values({ channel: "FANPAGE", status: "HANDOFF", customerId: victim.id, state: { customer: { id: victim.id, name: "Nạn Nhân Thật", phone: "0977111222", address: "99 Đường Nhà Thật", province: "Hà Nội", simulated: false, savedAddress: true } } })
        .returning({ id: schema.salesChatConversations.id });
      const sc = await chatOrderContext(admin, saved.id);
      assert.ok(sc.ok && sc.value.customer?.verified === false && sc.value.customer.name === "" && sc.value.customer.address === "" && !/Nạn Nhân Thật|99 Đường Nhà Thật/.test(JSON.stringify(sc)), JSON.stringify(sc));
      const savedBefore = (await db.select().from(schema.orders)).length;
      const sv = await createOrderFromChatCore(admin, saved.id, { ...blank, requestKey: "saved-bam-0001" });
      assert.ok(!sv.ok && sv.code === "INVALID" && /"address"/.test(JSON.stringify(sv)), JSON.stringify(sv));
      assert.equal((await db.select().from(schema.orders)).length, savedBefore, "địa chỉ máy điền không thành người nhận");

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
  console.log("  ✓ Tạo đơn trong khung chat: đơn đi đường tạo đơn tay chung, origin ERP_FORM + khoá hội thoại, sự kiện HUMAN kèm khoá tài khoản; bấm hai lần cùng khoá ⇒ một đơn / một sự kiện / một nhật ký; đơn người KHÔNG vào «đơn bot chốt» và kéo hội thoại sang nhóm có người (màn Hiệu quả + drill-down), đơn bot chốt vẫn đếm; khách theo SĐT dùng lại, không đè hồ sơ, tên / địa chỉ mới vào người nhận; hồ sơ chưa xác minh là của người đang chat ⇒ không điền sẵn / không làm dự phòng chữ đã lưu (ô trống lấy chữ gõ trong hội thoại, không có thì bắt nhập), hồ sơ khớp Facebook như cũ; đơn bot chốt hiện để cảnh báo, không chặn; khung thử / thiếu quyền / hội thoại lạ / khoá sai ⇒ từ chối, không ghi");
}
