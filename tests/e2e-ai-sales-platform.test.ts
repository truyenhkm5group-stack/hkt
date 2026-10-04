/**
 * ═══════════ E2E THEN CHỐT — TỪ TIN KHÁCH TỚI OWNER COCKPIT (lệnh «AI Sales Agent» §26) ═══════════
 *
 * Một tổ chức khách THẬT `e2e-shop` (CSDL PGlite riêng, tự cấp, tự dọn), provider AI giả (không gọi mạng — AGENTS §65):
 *
 *   tin khách → AI trả lời (tìm sản phẩm, báo giá từ ERP) → giỏ + kiểm tồn → khách để SĐT / địa chỉ → đơn nháp → khách
 *   chốt → ĐƠN THẬT → giao bằng phiếu ký nhận → ORDER_OUTCOME = DELIVERED → màn «Hiệu quả» (doanh thu giao thành công,
 *   chi phí / đơn giao, tiết kiệm theo chi phí người chủ shop khai) → ảnh chụp nền tảng → mốc kích hoạt đủ 7 bước (kể cả
 *   «đơn AI giao thành công đầu tiên») → sổ dùng ghi 1 đơn AI → Owner Cockpit: tổ chức «đã kích hoạt», cột dùng AI.
 *
 * Mỗi tầng đã có bài riêng (sales-events, platform-saas, sales-replay…); bài này chứng minh chúng NỐI được với nhau trên
 * cùng một chuỗi dữ liệu — chỗ hỏng thường nằm ở mối nối (khoá đơn ↔ hội thoại, kết cục, kênh THỬ bị loại…).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { loadOwnerCockpit } from "@/lib/platform/saas-cockpit";
import { captureSaasSnapshot, readMilestones } from "@/lib/platform/saas-ledger";
import { ACTIVATION_MILESTONES } from "@/lib/platform/saas-metrics";
import { confirmManualDeliveryCore } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { foldVi } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { loadAiSalesPerformance, savePerformanceSettings } from "@/lib/sales-chatbot/performance";
import { setSettingJson } from "@/lib/settings";

const ORG = "e2e-shop";
const ADMIN_EMAIL = `chu@${ORG}.local`;

export function fakeProvider(script: (lastUser: string, results: Record<string, unknown>[]) => AiBlock[]): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      const last = req.messages[req.messages.length - 1];
      const lastUserText = [...req.messages].reverse().find((m) => m.role === "user" && m.content.every((b) => b.type === "text"));
      const results = last.content.filter((b): b is Extract<AiBlock, { type: "tool_result" }> => b.type === "tool_result").map((b) => JSON.parse(b.content) as Record<string, unknown>);
      const text = lastUserText ? lastUserText.content.map((b) => (b.type === "text" ? b.text : "")).join(" ") : "";
      const content = script(text, last.role === "user" && results.length ? results : []);
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

/** Kịch bản bán: tìm → báo giá (số lấy từ kết quả công cụ) → kiểm tồn + giỏ → lưu khách + đơn nháp → chốt. */
export function shopScript(ids: { chaMuc: string; ruocTom: string }) {
  let n = 0;
  const use = (name: string, input: unknown): AiBlock => ({ type: "tool_use", id: `tu-${++n}`, name, input });
  const items = [
    { variant_id: ids.chaMuc, quantity: 2 },
    { variant_id: ids.ruocTom, quantity: 1 },
  ];
  return (user: string, results: Record<string, unknown>[]): AiBlock[] => {
    const u = foldVi(user);
    if (results.length) {
      const r = results[0];
      if (Array.isArray(r.results)) return [{ type: "text", text: "Dạ chả mực 400.000 ₫ một gói ạ." }];
      if (Array.isArray(r.items)) return [use("calculate_cart", { items })];
      if (typeof r.subtotal_text === "string" && !r.order_code) return [{ type: "text", text: `Dạ tạm tính ${r.subtotal_text}. Chị cho em SĐT, địa chỉ nhé.` }];
      if (r.customer_id) return [use("create_draft_order", { items, delivery_note: "" })];
      if (r.order_code && r.confirmed) return [{ type: "text", text: "Dạ em lên đơn rồi ạ." }];
      if (r.order_code) return [{ type: "text", text: "Dạ tóm tắt đơn — mình lấy thêm gì không, không thì em giao luôn ạ?" }];
      return [{ type: "text", text: "Dạ." }];
    }
    if (u.includes("bao nhieu")) return [use("search_products", { query: "chả mực" })];
    if (u.includes("2 goi")) return [use("check_inventory", { items })];
    if (u.includes("0912345678")) return [use("create_customer", { name: "Nguyễn Thị Lan", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" })];
    if (u.includes("ok chot")) return [use("confirm_order", { customer_confirmation: "ok chốt đơn" })];
    return [{ type: "text", text: "Dạ em nghe ạ." }];
  };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  await pdb.delete(schema.platformSaasDaily).where(eq(schema.platformSaasDaily.orgCode, ORG));
  await pdb.delete(schema.platformOrgMilestones).where(eq(schema.platformOrgMilestones.orgCode, ORG));
  await pdb.delete(schema.platformTenantUsageDaily).where(eq(schema.platformTenantUsageDaily.orgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

export async function testE2eAiSalesPlatform() {
  await cleanup();
  await provisionOrganization({ code: ORG, name: "Shop trọn vòng", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "TronVong@2026!" }, source: "TEST", actor: null });
  try {
    const orderId = await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop trọn vòng", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      const mk = async (name: string, code: string, price: number) => {
        const p = await createProductCore(admin, { name, code, unit: "gói", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
        assert.ok(p.ok, JSON.stringify(p));
        const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
        assert.ok(v);
        return v.id;
      };
      const chaMuc = await mk("Chả mực giã tay", "E2E-CHA-MUC", 400_000);
      const ruocTom = await mk("Ruốc bông tôm", "E2E-RUOC-TOM", 350_000);
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-E2E-1", totalQuantity: 20, createdBy: ADMIN_EMAIL }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values([
        { receiptId: rc.id, variantId: chaMuc, quantity: 10, unitCost: 250_000 },
        { receiptId: rc.id, variantId: ruocTom, quantity: 10, unitCost: 200_000 },
      ]);
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });

      setSalesChatProviderForTests(() => fakeProvider(shopScript({ chaMuc, ruocTom })));
      try {
        // ① Khách nhắn → AI bán tới lúc chốt.
        const vk = visitorKeyOf("e2e-khach-web-0123456789abcdef");
        const w = await openConversation("WEB", { visitorKey: vk });
        for (const text of ["Chả mực bao nhiêu?", "Cho chị 2 gói, thêm 1 ruốc tôm.", "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội", "ok chốt đơn"]) {
          const r = await chatTurn(w.id, text, { channel: "WEB", visitorKey: vk });
          assert.ok(r.ok, r.ok ? "" : r.error);
        }
        const [conv] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, w.id));
        assert.ok(conv.orderId, "② hội thoại mang khoá ĐƠN THẬT");
        const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, conv.orderId!));
        assert.equal(order.totalPriceAfterDiscount, 1_150_000, "giá do lõi đơn tính từ bảng giá: 2 × 400.000 + 350.000");

        // ③ Giao bằng phiếu ký nhận ⇒ ORDER_OUTCOME = DELIVERED.
        const delivered = await confirmManualDeliveryCore(admin, order.id, { signedAt: new Date().toISOString(), receiverName: "Nguyễn Thị Lan" });
        assert.ok(delivered.ok, JSON.stringify(delivered));

        // ④ Phân tích + ROI của chính shop.
        assert.ok("ok" in (await savePerformanceSettings(admin, { humanCostPerConversationVnd: 15_000, reason: "lương 9 triệu ÷ 600 hội thoại" })));
        const perf = await loadAiSalesPerformance(ORG, { withMoney: true });
        assert.equal(perf.orders.delivered, 1);
        assert.equal(perf.orders.deliveredRevenueVnd, 1_150_000, "doanh thu GIAO THÀNH CÔNG, không phải doanh thu đặt");
        assert.equal(perf.orders.deliveryRate, 1);
        assert.equal(perf.human?.estimatedSavingVnd, 15_000, "tiết kiệm ước tính = hội thoại AI tự xử lý × chi phí người chủ shop khai");
        return order.id;
      } finally {
        setSalesChatProviderForTests(null);
      }
    });

    // ⑤ Tầng nền tảng: ảnh chụp ⇒ mốc kích hoạt đủ, sổ dùng, Owner Cockpit.
    const now = new Date();
    const snap = await captureSaasSnapshot(now);
    assert.deepEqual(snap.errors.filter((e) => e.includes(ORG)), [], "không lỗi đọc CSDL của tổ chức");
    const ms = (await readMilestones()).get(ORG) ?? {};
    const missing = ACTIVATION_MILESTONES.filter((m) => m !== "CHANNEL_CONNECTED" && !ms[m]);
    assert.deepEqual(missing, [], "đủ mốc: tạo · có sản phẩm · hội thoại · AI trả lời · đơn AI · đơn AI giao thành công (kênh web không cần nối kênh)");
    const pdb = await getPlatformDb();
    const [usage] = await pdb.select().from(schema.platformTenantUsageDaily).where(and(eq(schema.platformTenantUsageDaily.orgCode, ORG), eq(schema.platformTenantUsageDaily.day, snap.day)));
    assert.deepEqual([usage.conversationsStarted, usage.customerMessages, usage.aiOrders], [1, 4, 1], "sổ dùng: 1 hội thoại · 4 tin khách · 1 đơn AI");
    const home = await getHomeOrganization();
    const op: SessionUser = { id: "e2e-op", email: "op@e2e.local", name: "OP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    const ck = await loadOwnerCockpit(op, now);
    assert.ok(ck.ok);
    const row = ck.value.tenants.find((t) => t.code === ORG);
    assert.ok(row, "tổ chức có trong bảng của chủ nền tảng");
    assert.equal(row.activated, true);
    assert.equal(row.usage30d?.aiOrders, 1);
    assert.ok(ck.value.activation.find((s) => s.milestone === "FIRST_DELIVERED_AI_ORDER")!.reached! >= 1);
    assert.ok(!JSON.stringify(ck.value).includes("0912345678"), "cockpit không mang SĐT khách");
    assert.ok(orderId.length > 0);
    console.log("  ✓ E2E trọn vòng: tin khách → AI bán → đơn thật → giao (ORDER_OUTCOME) → Hiệu quả + ROI → mốc kích hoạt đủ → sổ dùng → Owner Cockpit");
  } finally {
    await cleanup();
  }
}
