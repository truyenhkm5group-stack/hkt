/**
 * ═══════════ QUY KẾT TỪNG ĐƠN + FOLLOW-UP THU HỒI + KINH TẾ BOT (docs/revenue-attribution.md) ═══════════
 *
 * Khoá:
 *  · ba nhãn AI_ONLY / AI_ASSISTED / HUMAN_ONLY theo đúng định nghĩa: chỉ việc BÁN HÀNG THẬT của AI (báo giá · nháp · mời
 *    mua thêm · SĐT) mới là góp công — một câu bot trả lời thì không; người chạm vào SAU mốc chốt không làm mất «AI tự bán»;
 *    công của lượt mua trước không chảy sang lượt mua sau; đơn không có sự kiện ⇒ CHƯA BIẾT, không phải «người bán»;
 *  · follow-up thu hồi = đơn lên SAU tin khách trả lời lời nhắc, cùng lượt mua; khách tự quay lại không qua lời nhắc thì không;
 *  · kinh tế bot: chưa có đơn / mẫu dưới ngưỡng / chi phí 0 hay chưa biết ⇒ `null`, không phải 0;
 *  · trên CSDL tổ chức thật: tổng ba nhãn + chưa quy kết = số đơn của kỳ, doanh thu giao thành công qua ORDER_OUTCOME.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { MANUAL_ORDER_ORIGIN } from "@/lib/constants/manual-orders";
import { confirmManualDeliveryCore } from "@/lib/records/order-create";
import { loadOrderAttribution } from "@/lib/sales-chatbot/attribution";
import { attributeOrder, attributionTable, followupRecovery, type AttributionEvent } from "@/lib/sales-chatbot/attribution-shared";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { salesEconomics } from "@/lib/sales-chatbot/performance-shared";

const ORG = "quy-ket-don";
const T0 = new Date("2026-10-01T08:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ev = (type: string, actorKind: string, min: number, extra: Partial<AttributionEvent> = {}): AttributionEvent => ({ type, actorKind, occurredAt: at(min), cycle: 0, orderId: null, ...extra });

function testPure() {
  const O = "erp-o1";
  // Bot tư vấn → SĐT → nháp → khách đồng ý (tác nhân CUSTOMER) ⇒ AI tự bán.
  const botSale = [ev("message.received", "CUSTOMER", 0), ev("ai.replied", "AI", 1), ev("quote.given", "AI", 1), ev("customer.identified", "CUSTOMER", 5), ev("order.drafted", "AI", 6, { orderId: O }), ev("order.confirmed", "CUSTOMER", 8, { orderId: O })];
  assert.equal(attributeOrder(O, botSale), "AI_ONLY");
  // Người chạm vào SAU mốc chốt (khách hỏi giao hàng) ⇒ vẫn AI tự bán.
  assert.equal(attributeOrder(O, [...botSale, ev("human.took_over", "HUMAN", 30)]), "AI_ONLY");
  // Chuyển người TRƯỚC mốc chốt, bot chốt sau khi người trả lại ⇒ AI góp công.
  assert.equal(attributeOrder(O, [...botSale.slice(0, 5), ev("handoff.requested", "AI", 7), ev("order.confirmed", "CUSTOMER", 20, { orderId: O })]), "AI_ASSISTED");

  const H = "erp-h1";
  // Người lên đơn trong khung chat; trước đó bot đã báo giá bằng công cụ ⇒ AI góp công.
  assert.equal(attributeOrder(H, [ev("message.received", "CUSTOMER", 0), ev("quote.given", "AI", 1), ev("human.took_over", "HUMAN", 10), ev("order.confirmed", "HUMAN", 12, { orderId: H })]), "AI_ASSISTED");
  // Bot chỉ chào (ai.replied) rồi người bán ⇒ NGƯỜI BÁN — một câu trả lời không phải góp công.
  assert.equal(attributeOrder(H, [ev("message.received", "CUSTOMER", 0), ev("ai.replied", "AI", 1), ev("human.took_over", "HUMAN", 3), ev("order.confirmed", "HUMAN", 12, { orderId: H })]), "HUMAN_ONLY");
  // Bot báo giá ở lượt mua TRƯỚC; lượt mua này người bán từ đầu ⇒ NGƯỜI BÁN (công không chảy sang lượt sau).
  assert.equal(attributeOrder(H, [ev("quote.given", "AI", 1), ev("message.received", "CUSTOMER", 100, { cycle: 1 }), ev("order.confirmed", "HUMAN", 120, { orderId: H, cycle: 1 })]), "HUMAN_ONLY");
  // Bot báo giá SAU mốc người lên đơn ⇒ không phải công trước đơn ⇒ NGƯỜI BÁN.
  assert.equal(attributeOrder(H, [ev("order.drafted", "HUMAN", 5, { orderId: H }), ev("quote.given", "AI", 6), ev("order.confirmed", "HUMAN", 9, { orderId: H })]), "HUMAN_ONLY");
  // AI ghi hộ đơn của nhân viên (order-sync: `order.drafted` tác nhân HUMAN) — chép lại không phải bán ⇒ NGƯỜI BÁN.
  assert.equal(attributeOrder(H, [ev("message.received", "CUSTOMER", 0), ev("human.took_over", "HUMAN", 1), ev("order.drafted", "HUMAN", 40, { orderId: H }), ev("order.confirmed", "HUMAN", 41, { orderId: H })]), "HUMAN_ONLY");
  // Không có sự kiện lên / chốt nào của chính đơn ⇒ CHƯA BIẾT.
  assert.equal(attributeOrder("erp-khong-co", botSale), null);

  const t = attributionTable(
    [
      { attribution: "AI_ONLY", valueVnd: 500_000, delivered: true, deliveredRevenueVnd: 500_000, settled: true, cancelled: false },
      { attribution: "AI_ONLY", valueVnd: 300_000, delivered: false, deliveredRevenueVnd: 0, settled: true, cancelled: false },
      { attribution: "HUMAN_ONLY", valueVnd: 200_000, delivered: false, deliveredRevenueVnd: 0, settled: false, cancelled: true },
    ],
    2,
  );
  assert.deepEqual(t.AI_ONLY, { orders: 2, valueVnd: 800_000, delivered: 1, deliveredRevenueVnd: 500_000, settled: 2, cancelled: 0 });
  assert.deepEqual(t.AI_ASSISTED, { orders: 0, valueVnd: 0, delivered: 0, deliveredRevenueVnd: 0, settled: 0, cancelled: 0 });
  assert.equal(t.HUMAN_ONLY.cancelled, 1);
  assert.equal(t.unattributed, 2);

  // Follow-up: nhắc → khách trả lời → đơn ⇒ thu hồi.
  const R = "erp-r1";
  const nudged = [ev("message.received", "CUSTOMER", 0), ev("quote.given", "AI", 1), ev("followup.sent", "AI", 60), ev("message.received", "CUSTOMER", 300), ev("order.drafted", "AI", 305, { orderId: R }), ev("order.confirmed", "CUSTOMER", 310, { orderId: R })];
  assert.deepEqual(followupRecovery(nudged, at(0)), { followedUp: true, replied: true, recoveredOrderIds: [R] });
  // Lời nhắc trước đầu kỳ ⇒ không xét.
  assert.deepEqual(followupRecovery(nudged, at(61)), { followedUp: false, replied: false, recoveredOrderIds: [] });
  // Nhắc mà khách không trả lời, vẫn có đơn (vd nhân viên gọi điện) ⇒ không phải thu hồi.
  assert.deepEqual(followupRecovery([ev("followup.sent", "AI", 60), ev("order.confirmed", "HUMAN", 400, { orderId: R })], at(0)), { followedUp: true, replied: false, recoveredOrderIds: [] });
  // Đơn lên TRƯỚC tin trả lời ⇒ không phải thu hồi.
  assert.deepEqual(followupRecovery([ev("followup.sent", "AI", 60), ev("order.drafted", "AI", 70, { orderId: R }), ev("message.received", "CUSTOMER", 300), ev("order.confirmed", "CUSTOMER", 310, { orderId: R })], at(0)).recoveredOrderIds, []);
  // Trả lời ở lượt mua khác ⇒ không phải trả lời lời nhắc này.
  assert.deepEqual(followupRecovery([ev("followup.sent", "AI", 60), ev("message.received", "CUSTOMER", 9000, { cycle: 1 }), ev("order.confirmed", "CUSTOMER", 9010, { orderId: R, cycle: 1 })], at(0)), { followedUp: true, replied: false, recoveredOrderIds: [] });
  // Đơn chỉ có nháp (chưa chốt) ⇒ chưa thu hồi.
  assert.deepEqual(followupRecovery(nudged.slice(0, 5), at(0)).recoveredOrderIds, []);

  // Kinh tế bot.
  const base = { conversations: 40, confirmedOrders: 4, confirmedValueVnd: 2_000_000, deliveredRevenueVnd: 1_500_000, aiCostVnd: 30_000, unknownCostTurns: 0 };
  assert.deepEqual(salesEconomics(base), { aovVnd: 500_000, deliveredRevenuePerConversationVnd: 37_500, aiCostPerConversationVnd: 750, revenuePerAiCost: 50, costIsLowerBound: false });
  assert.equal(salesEconomics({ ...base, confirmedOrders: 0, confirmedValueVnd: 0 }).aovVnd, null, "chưa có đơn ⇒ không có AOV");
  const few = salesEconomics({ ...base, conversations: 9 });
  assert.ok(few.deliveredRevenuePerConversationVnd === null && few.aiCostPerConversationVnd === null, "mẫu dưới 10 hội thoại ⇒ trống");
  assert.equal(salesEconomics({ ...base, aiCostVnd: 0 }).revenuePerAiCost, null, "chi phí 0 ⇒ không chia");
  const noMoney = salesEconomics({ ...base, aiCostVnd: null });
  assert.ok(noMoney.aiCostPerConversationVnd === null && noMoney.revenuePerAiCost === null, "không thấy tiền / chưa biết ⇒ trống");
  assert.equal(salesEconomics({ ...base, unknownCostTurns: 3 }).costIsLowerBound, true);
  // Trang chủ «Hôm nay AI làm ra bao nhiêu» KHÔNG có công thức riêng: chỉ đọc hai hàm của màn «Hiệu quả», không tự truy vấn.
  const home = readFileSync("components/onboarding/ai-sales-today.tsx", "utf8");
  assert.ok(home.includes("loadAiSalesPerformance(") && home.includes("loadOrderAttribution("), "trang chủ đọc đúng hai hàm của màn Hiệu quả");
  assert.ok(!/drizzle-orm|@\/db"|getDb\(|sql`/.test(home), "trang chủ không tự viết truy vấn — một công thức thứ hai là hai con số");
  assert.ok(readFileSync("components/onboarding/getting-started.tsx", "utf8").includes("<AiSalesToday user={user} />"), "khối AI hôm nay nằm trên trang chủ tổ chức khách");
  console.log("✓ Quy kết từng đơn · thuần: AI tự bán / AI góp công / người bán theo việc bán hàng THẬT (một câu trả lời không phải góp công) · người chạm SAU mốc chốt không làm mất AI tự bán · công không chảy sang lượt mua sau · AI ghi hộ đơn nhân viên = người bán · không sự kiện ⇒ chưa biết · follow-up thu hồi chỉ khi đơn lên SAU tin trả lời cùng lượt mua · kinh tế bot: chưa có đơn / mẫu bé / chi phí 0 ⇒ trống · trang chủ «hôm nay AI làm ra bao nhiêu» đọc đúng hai hàm của màn Hiệu quả, không công thức riêng");
}

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

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
    assert.ok(u);
    const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] } as unknown as SessionUser;
    const now = Date.now();
    const m = (min: number) => new Date(now - 3 * 3_600_000 + min * 60_000);
    const conv = async () => (await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE" }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const order = (id: string, total: number, origin: string, convId: string) => db.insert(schema.orders).values({ id, stage: "CONFIRMED", status: 1, billFullName: "Khách", totalPrice: total, totalPriceAfterDiscount: total, insertedAt: new Date(), origin, salesConversationId: convId, raw: { origin: MANUAL_ORDER_ORIGIN, orderDiscount: 0, createdBy: null } });
    const rec = (convId: string, type: Parameters<typeof recordConversationEvent>[1]["type"], actorKind: Parameters<typeof recordConversationEvent>[1]["actorKind"], min: number, key: string, orderId?: string) => recordConversationEvent(convId, { type, actorKind, occurredAt: m(min), orderId: orderId ?? null, key });

    // c1 — bot tự bán, có lời nhắc và khách trả lời trước khi chốt (thu hồi), giao bằng phiếu ký nhận.
    const c1 = await conv();
    await order("erp-qk-ai", 600_000, "AI_AGENT", c1);
    await rec(c1, "message.received", "CUSTOMER", 0, "msg:1");
    await rec(c1, "quote.given", "AI", 1, "quote:1");
    await rec(c1, "followup.sent", "AI", 60, "followup:1");
    await rec(c1, "message.received", "CUSTOMER", 90, "msg:2");
    await rec(c1, "order.drafted", "AI", 95, "draft:erp-qk-ai", "erp-qk-ai");
    await rec(c1, "order.confirmed", "CUSTOMER", 96, "confirm:erp-qk-ai", "erp-qk-ai");
    // c2 — bot báo giá, nhân viên nhận rồi tạo đơn trong khung chat ⇒ AI góp công.
    const c2 = await conv();
    await order("erp-qk-assist", 400_000, "ERP_FORM", c2);
    await rec(c2, "message.received", "CUSTOMER", 0, "msg:1");
    await rec(c2, "quote.given", "AI", 2, "quote:1");
    await rec(c2, "human.took_over", "HUMAN", 10, "staff:1");
    await rec(c2, "order.confirmed", "HUMAN", 20, "human-order:erp-qk-assist", "erp-qk-assist");
    // c3 — người bán từ đầu (bot chỉ chào) ⇒ người bán.
    const c3 = await conv();
    await order("erp-qk-human", 250_000, "ERP_FORM", c3);
    await rec(c3, "message.received", "CUSTOMER", 0, "msg:1");
    await rec(c3, "ai.replied", "AI", 1, "reply:1");
    await rec(c3, "human.took_over", "HUMAN", 3, "staff:1");
    await rec(c3, "order.confirmed", "HUMAN", 15, "human-order:erp-qk-human", "erp-qk-human");
    // c4 — khung THỬ: không bao giờ vào quy kết.
    const [c4] = await db.insert(schema.salesChatConversations).values({ channel: "TEST" }).returning({ id: schema.salesChatConversations.id });
    await rec(c4.id, "order.confirmed", "CUSTOMER", 5, "confirm:sim");

    const r0 = await loadOrderAttribution({ days: 7 });
    const t0 = r0.table;
    assert.deepEqual([t0.AI_ONLY.orders, t0.AI_ASSISTED.orders, t0.HUMAN_ONLY.orders, t0.unattributed], [1, 1, 1, 0], JSON.stringify(t0));
    assert.deepEqual([t0.AI_ONLY.valueVnd, t0.AI_ASSISTED.valueVnd, t0.HUMAN_ONLY.valueVnd], [600_000, 400_000, 250_000]);
    assert.equal(t0.AI_ONLY.deliveredRevenueVnd, 0, "chưa giao ⇒ chưa có doanh thu");
    assert.deepEqual([r0.followup.conversations, r0.followup.replied, r0.followup.recoveredOrders, r0.followup.recoveredValueVnd], [1, 1, 1, 600_000]);
    assert.equal(r0.followup.replyRate, null, "1 hội thoại < mẫu tối thiểu ⇒ trống");

    const d = await confirmManualDeliveryCore(admin, "erp-qk-ai", { signedAt: new Date().toISOString(), receiverName: "Khách" });
    assert.ok(d.ok, JSON.stringify(d));
    const r1 = await loadOrderAttribution({ days: 7 });
    assert.deepEqual([r1.table.AI_ONLY.delivered, r1.table.AI_ONLY.deliveredRevenueVnd, r1.table.AI_ONLY.settled], [1, 600_000, 1], "giao bằng phiếu ⇒ ORDER_OUTCOME = DELIVERED ⇒ doanh thu AI tự bán");
    assert.deepEqual([r1.followup.recoveredDelivered, r1.followup.recoveredDeliveredRevenueVnd], [1, 600_000]);
    assert.equal(r1.table.AI_ASSISTED.deliveredRevenueVnd + r1.table.HUMAN_ONLY.deliveredRevenueVnd, 0, "đơn chưa giao không có doanh thu");
  });
  console.log("✓ Quy kết từng đơn · tổ chức thật: ba hội thoại ⇒ AI tự bán / AI góp công / người bán (khung thử loại) · lời nhắc → khách trả lời → đơn ⇒ thu hồi · giao bằng phiếu ⇒ doanh thu AI tự bán và doanh thu thu hồi qua ORDER_OUTCOME");
}

export async function testOrderAttribution() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop quy kết đơn", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "QuyKetDon@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}
