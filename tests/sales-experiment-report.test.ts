/**
 * SO AI vs NGƯỜI THEO NHÁNH + DRILL-DOWN VỀ HỘI THOẠI (lib/sales-chatbot/experiment-*.ts · DoD #9, #15).
 *
 *  1. THUẦN — nhánh không có đường ghi đơn ⇒ mọi số đơn `null` (không phải 0); mẫu dưới ngưỡng ⇒ tỷ lệ `null`; chênh lệch
 *     chỉ có khi CẢ HAI bên đo được; bộ lọc drill-down bỏ giá trị lạ; che SĐT giữ 3 số cuối.
 *  2. TỔ CHỨC THẬT `xr-shop` (AI giả): 12 hội thoại nhánh AI (một hội thoại bán thật tới lúc giao ⇒ ORDER_OUTCOME DELIVERED),
 *     12 hội thoại fanpage nhánh người (một đơn ghi hộ). «AI ghi đơn hộ nhân viên» TẮT ⇒ nhánh người «chưa đo», BẬT ⇒ có số;
 *     hội thoại khoá thử nghiệm KHÁC không lẫn vào; drill-down đúng nhóm / lý do / nhánh; xem lại hội thoại mở được, kênh
 *     THỬ thì không; tổ chức khác không thấy gì.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { confirmManualDeliveryCore } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { listDrillConversations, loadConversationReview, loadExperimentReport } from "@/lib/sales-chatbot/experiment-report";
import { armStats, drillHref, liftOrNull, maskPhones, parseDrillFilter } from "@/lib/sales-chatbot/experiment-shared";
import { basketStats, loadBasketStats } from "@/lib/sales-chatbot/basket";
import { saveModeConfig, loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { saveOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";
import { setSettingJson } from "@/lib/settings";
import { fakeProvider, shopScript } from "./e2e-ai-sales-platform.test";

const ORG = "xr-shop";
const OTHER = "xr-khac";

function testPure() {
  const raw = { conversations: 12, orders: 3, ordersValueVnd: 900_000, settled: 2, delivered: 2, deliveredRevenueVnd: 600_000 };
  const none = armStats(raw, 0, "tắt");
  assert.deepEqual([none.orders, none.conversion, none.delivered, none.note], [null, null, null, "tắt"], "không đường ghi đơn ⇒ CHƯA ĐO, không phải 0");
  const s = armStats(raw, 12);
  assert.equal(s.conversion, 3 / 12);
  assert.equal(s.deliveredConversion, 2 / 12);
  assert.equal(s.deliveryRate, 1);
  assert.equal(s.aovVnd, 300_000);
  assert.equal(s.deliveredAovVnd, 300_000);
  assert.equal(armStats(raw, 9).conversion, null, "dưới 10 hội thoại ⇒ null");
  assert.equal(liftOrNull(0.3, null), null, "một bên chưa đo ⇒ không có chênh lệch — AI không thắng giả");
  assert.ok(Math.abs((liftOrNull(0.3, 0.2) ?? 0) - 0.1) < 1e-9);
  assert.deepEqual(parseDrillFilter({ days: "999", cohort: "XYZ", arm: "AI", reason: "WHOLESALE", confirmed: "1" }), { days: 30, cohort: null, arm: "AI", reason: "WHOLESALE", confirmed: true });
  assert.equal(parseDrillFilter({ reason: "drop table" }).reason, null);
  assert.equal(drillHref({ days: 7, cohort: "AI_ONLY" }), "/ai/sales-chatbot/conversations?days=7&cohort=AI_ONLY");
  assert.equal(maskPhones("SĐT em 0912345678 nhé"), "SĐT em ••••678 nhé");
  assert.equal(maskPhones("+84 912 345 678"), "••••678");
  assert.equal(maskPhones("lấy 2 hộp 500g giá 250.000đ"), "lấy 2 hộp 500g giá 250.000đ", "không che số tiền / số lượng");
  // Bán chéo: sản phẩm chính = giá trị dòng lớn nhất; phần còn lại là giá trị bán chéo (đơn chốt, danh nghĩa).
  const b = basketStats([
    [{ productId: "cha", quantity: 2, valueVnd: 800_000 }, { productId: "ruoc", quantity: 1, valueVnd: 350_000 }],
    [{ productId: "cha", quantity: 1, valueVnd: 400_000 }, { productId: "cha", quantity: 1, valueVnd: 400_000 }],
    [],
  ]);
  assert.deepEqual([b.orders, b.multiProductOrders, b.crossSellValueVnd, b.itemsPerOrder], [2, 1, 350_000, 2.5], "đơn không dòng nào bị bỏ; hai dòng cùng sản phẩm không phải bán chéo");
  assert.equal(b.multiProductRate, null, "2 đơn < 10 ⇒ tỷ lệ null");
  const many = basketStats(Array.from({ length: 10 }, (_, i) => (i < 3 ? [{ productId: "a", quantity: 1, valueVnd: 1 }, { productId: "b", quantity: 1, valueVnd: 1 }] : [{ productId: "a", quantity: 1, valueVnd: 1 }])));
  assert.equal(many.multiProductRate, 0.3);
  console.log("  ✓ AI vs người (thuần): chưa đo ≠ 0, mẫu < 10 ⇒ null, chênh lệch chỉ khi hai bên đo được, lọc drill-down, che SĐT");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [ORG, OTHER]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
    await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(org: string): Promise<SessionUser> {
  const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `chu@${org}.local`) });
  assert.ok(u);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false }, modules: [...(await getEnabledModules(org))] };
}

export async function testSalesExperimentReport() {
  testPure();
  await cleanup();
  for (const code of [ORG, OTHER]) {
    await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${code}.local`, name: "Chủ shop", password: "NhanhThu@2026!" }, source: "TEST", actor: null });
  }
  try {
    const ids = await withOrganization(ORG, async () => {
      const db = await getDb();
      const admin = await adminOf(ORG);
      const mk = async (name: string, code: string, price: number) => {
        const p = await createProductCore(admin, { name, code, unit: "gói", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
        assert.ok(p.ok, JSON.stringify(p));
        const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
        assert.ok(v);
        return v.id;
      };
      const chaMuc = await mk("Chả mực giã tay", "XR-CHA-MUC", 400_000);
      const ruocTom = await mk("Ruốc bông tôm", "XR-RUOC-TOM", 350_000);
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-XR-1", totalQuantity: 20, createdBy: admin.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values([
        { receiptId: rc.id, variantId: chaMuc, quantity: 10, unitCost: 250_000 },
        { receiptId: rc.id, variantId: ruocTom, quantity: 10, unitCost: 200_000 },
      ]);
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });
      assert.equal(await loadExperimentReport(), null, "chưa chia hội thoại nào ⇒ không có khối");
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "EXPERIMENT", aiSharePct: 50 })));
      const key = (await loadModeConfig()).experimentKey;
      const pin = (arm: "AI" | "HUMAN", k = key) => ({ experiment: { key: k, arm, at: new Date().toISOString() } });

      // Nhánh AI: một hội thoại bán thật tới lúc giao.
      setSalesChatProviderForTests(() => fakeProvider(shopScript({ chaMuc, ruocTom })));
      let sold: string;
      try {
        const vk = visitorKeyOf("xr-khach-web-0123456789abcdefgh");
        const w = await openConversation("WEB", { visitorKey: vk });
        for (const text of ["Chả mực bao nhiêu?", "Cho chị 2 gói, thêm 1 ruốc tôm.", "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội", "ok chốt đơn"]) assert.ok((await chatTurn(w.id, text, { channel: "WEB", visitorKey: vk })).ok);
        sold = w.id;
      } finally {
        setSalesChatProviderForTests(null);
      }
      const c = schema.salesChatConversations;
      await db.update(c).set({ state: { ...(await db.query.salesChatConversations.findFirst({ where: eq(c.id, sold) }))!.state, ...pin("AI") } }).where(eq(c.id, sold));
      const [soldConv] = await db.select().from(c).where(eq(c.id, sold));
      assert.ok(soldConv.orderId);
      assert.ok((await confirmManualDeliveryCore(admin, soldConv.orderId!, { signedAt: new Date().toISOString(), receiverName: "Lan" })).ok);
      for (let i = 0; i < 11; i++) await db.insert(c).values({ channel: "FANPAGE", visitorKey: `xr-ai-${i}`, turns: 1, state: pin("AI") });
      // Nhánh người: 12 hội thoại fanpage, một đơn ghi hộ nhân viên (chưa giao).
      const humanIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const [h] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: `xr-hu-${i}`, turns: 1, state: pin("HUMAN") }).returning({ id: c.id });
        humanIds.push(h.id);
      }
      await db.insert(schema.customers).values({ id: "xr-cus", name: "Khách người" });
      await db.insert(schema.orders).values({ id: "xr-ord-human", customerId: "xr-cus", billFullName: "Khách người", insertedAt: new Date(), totalPriceAfterDiscount: 500_000, origin: "AI_ORDER_SYNC", salesConversationId: humanIds[0] });
      // Khoá thử nghiệm CŨ — không được lẫn vào.
      await db.insert(c).values({ channel: "FANPAGE", visitorKey: "xr-old", turns: 1, state: pin("AI", "e-cu") });
      return { sold, humanIds, admin };
    });

    await withOrganization(ORG, async () => {
      const off = await loadExperimentReport();
      assert.ok(off);
      assert.equal(off.arms.AI.conversations, 12, "khoá cũ không lẫn vào");
      assert.equal(off.arms.AI.orders, 1);
      assert.equal(off.arms.AI.delivered, 1, "giao bằng phiếu ⇒ ORDER_OUTCOME DELIVERED");
      assert.equal(off.arms.AI.conversion, 1 / 12);
      assert.equal(off.arms.HUMAN.conversations, 12);
      assert.equal(off.arms.HUMAN.orders, null, "ghi đơn hộ TẮT ⇒ nhánh người CHƯA ĐO, không phải 0");
      assert.ok(off.arms.HUMAN.note?.includes("TẮT"));
      assert.ok("ok" in (await saveOrderSyncConfig(ids.admin, true)));
      const on = await loadExperimentReport();
      assert.ok(on);
      assert.equal(on.arms.HUMAN.orders, 1);
      assert.equal(on.arms.HUMAN.conversion, 1 / 12);
      assert.equal(on.arms.HUMAN.delivered, 0);
      assert.equal(on.arms.HUMAN.measurableConversations, 12);

      // Bán chéo: đơn bán thật có chả mực + ruốc ⇒ 1 đơn ≥ 2 sản phẩm, giá trị bán chéo 350.000 ₫. Đơn ghi hộ người (origin
      // AI_ORDER_SYNC) không phải đơn bot chốt ⇒ không vào giỏ.
      const basket = await loadBasketStats({ days: 30 });
      assert.deepEqual([basket.booked.orders, basket.booked.multiProductOrders, basket.booked.crossSellValueVnd, basket.booked.itemsPerOrder], [1, 1, 350_000, 3]);
      assert.deepEqual([basket.delivered.orders, basket.delivered.crossSellValueVnd], [1, 350_000], "đơn đã giao bằng phiếu ⇒ vào giỏ đã giao");
      // Đơn bot chốt thứ hai, CHƯA giao (không vận đơn, không phiếu): vào giỏ đơn chốt, KHÔNG vào giỏ đã giao.
      const db = await getDb();
      await db.insert(schema.orders).values({ id: "xr-ord-ai-2", customerId: "xr-cus", billFullName: "Khách 2", insertedAt: new Date(), totalPriceAfterDiscount: 750_000, origin: "AI_AGENT", salesConversationId: ids.sold });
      await db.insert(schema.orderItems).values([
        { id: "xr-oi-2a", orderId: "xr-ord-ai-2", productId: "cha", quantity: 1, unitPrice: 400_000 },
        { id: "xr-oi-2b", orderId: "xr-ord-ai-2", productId: "ruoc", quantity: 1, unitPrice: 350_000 },
        { id: "xr-oi-2c", orderId: "xr-ord-ai-2", productId: "qua", quantity: 1, unitPrice: 90_000, isBonus: true },
      ]);
      await db.insert(schema.salesConversationEvents).values({ conversationId: ids.sold, cycle: 1, type: "order.confirmed", actorKind: "AI", channel: "WEB", occurredAt: new Date(), orderId: "xr-ord-ai-2", dedupeKey: "xr-ord-ai-2:confirmed" });
      const basket2 = await loadBasketStats({ days: 30 });
      assert.deepEqual([basket2.booked.orders, basket2.booked.multiProductOrders, basket2.booked.crossSellValueVnd], [2, 2, 700_000], "hàng tặng không phải bán chéo");
      assert.deepEqual([basket2.delivered.orders, basket2.delivered.crossSellValueVnd], [1, 350_000], "đơn chưa ngã ngũ không vào giỏ đã giao");
      // Drill-down: hội thoại bán thật có sổ sự kiện ⇒ vào nhóm AI tự xử lý, nhánh AI; không vào nhánh người / lý do sỉ.
      const viewer: SessionUser = { ...ids.admin, id: "xr-viewer", role: "VIEWER", permissions: ["ai_sales:view"] };
      const all = await listDrillConversations(viewer, parseDrillFilter({}));
      assert.ok("ok" in all && all.rows.some((r) => r.id === ids.sold));
      const aiOnly = await listDrillConversations(viewer, parseDrillFilter({ cohort: "AI_ONLY", confirmed: "1", arm: "AI" }));
      assert.ok("ok" in aiOnly && aiOnly.rows.map((r) => r.id).includes(ids.sold));
      const human = await listDrillConversations(viewer, parseDrillFilter({ arm: "HUMAN" }));
      assert.ok("ok" in human && !human.rows.some((r) => r.id === ids.sold));
      const sỉ = await listDrillConversations(viewer, parseDrillFilter({ reason: "WHOLESALE" }));
      assert.ok("ok" in sỉ && sỉ.rows.length === 0);
      const noPerm: SessionUser = { ...viewer, permissions: [] , role: "VIEWER" };
      assert.ok("error" in (await listDrillConversations({ ...noPerm, permissions: ["dashboard:view"] }, parseDrillFilter({}))), "không có ai_sales:view ⇒ từ chối");

      // Xem lại: mở được hội thoại thật; kênh THỬ không.
      const rv = await loadConversationReview(viewer, ids.sold);
      assert.ok("ok" in rv && rv.value.view.messages.length >= 8 && rv.value.events.some((e) => e.type === "order.confirmed") && rv.value.arm === "AI");
      const test = await openConversation("TEST", { createdBy: "xr" });
      assert.ok("error" in (await loadConversationReview(viewer, test.id)), "khung thử không mở ở màn xem lại");
    });

    // Tổ chức khác: không thấy lượt nào, không mở được hội thoại bằng id.
    await withOrganization(OTHER, async () => {
      const other = await adminOf(OTHER);
      assert.equal(await loadExperimentReport(), null);
      assert.ok("error" in (await loadConversationReview(other, ids.sold)));
      const d = await listDrillConversations(other, parseDrillFilter({}));
      assert.ok("ok" in d && d.rows.length === 0);
    });
    console.log("  ✓ AI vs người (tổ chức thật): nhánh AI 1/12 đơn giao thật, nhánh người chưa đo khi ghi hộ tắt / có số khi bật, khoá cũ không lẫn, drill-down đúng nhóm, xem lại hội thoại, cô lập tổ chức");
  } finally {
    await cleanup();
  }
}
