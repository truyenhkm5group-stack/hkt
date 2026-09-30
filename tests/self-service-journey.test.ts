/**
 * ═══════════ HÀNH TRÌNH TỰ PHỤC VỤ CỦA KHÁCH (0180) — MẪU THỰC PHẨM · SỰ KIỆN ĐƠN · BÁO NHÓM · CHATBOT · XUẤT BẢN ═══════════
 *
 * Tổ chức THẬT `ss-food` dựng qua ĐÚNG luồng `/start` (`createOrganizationFromSignup`, mẫu «Thực phẩm đóng gói»), rồi đi
 * hết hành trình bằng các lõi mà màn hình gọi:
 *  · mẫu: module có «AI bán hàng», field quy cách / bảo quản của sản phẩm, luật báo nhóm ở NHÁP, tổ chức là BẢN NHÁP;
 *  · hộp thử nhắn tin: lưu / kiểm / bật KHÔNG cần PLATFORM_SECRETS_KEY (không bí mật nào);
 *  · cấu hình «báo nhóm vận hành» ⇒ ba luật THẬT (bật + chạy thật) qua dịch vụ luật;
 *  · đơn chốt ⇒ đúng MỘT tin (mã đơn, khách, SĐT, địa chỉ, dòng hàng × đơn giá = thành tiền, ship, COD, nguồn, liên kết) +
 *    hàng GIỮ ở cột khả dụng; sửa SL / địa chỉ ⇒ tin cập nhật; gửi lại đúng lượt sửa / chạy lại luật ⇒ KHÔNG tin thứ hai;
 *    huỷ ⇒ tin huỷ + nhả hàng; huỷ đơn chưa từng chốt ⇒ không tin;
 *  · chatbot (model GIẢ — luật 65): giá / tồn đọc từ ERP, 2 × 400.000 + 1 × 350.000 = 1.150.000; khung THỬ không ghi gì;
 *    kênh WEB lên đơn thật, chốt ⇒ `order.confirmed` ⇒ tin nhóm; chốt thiếu lời đồng ý của khách ⇒ từ chối; hội thoại
 *    khoá theo khách truy cập và theo tổ chức; lượt chatbot không ăn trần 10 lượt/ngày của gói;
 *  · xuất bản: tên miền con (dạng · dành riêng · trùng), kiểm trước, xuất bản, định tuyến host → CHỈ tổ chức đã xuất bản.
 * Tổ chức thứ hai `ss-other` để chứng minh cô lập. Tự dọn.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { sourceUsage } from "@/lib/ai-usage/ledger";
import { resolvePermissions } from "@/lib/auth/permissions";
import { activeUserIdsWhoCan, type SessionUser } from "@/lib/auth/session";
import { FOOD_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/food-commerce";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { SecretsKeyState } from "@/lib/connectors/secrets";
import { ORDER_MATERIAL_CHANGE_LABEL } from "@/lib/constants/manual-orders";
import { loadNotificationSetup, saveOrderNotificationPreset } from "@/lib/messaging/presets";
import { deliverMessage } from "@/lib/messaging/service";
import { DEFAULT_ORDER_TEMPLATES, messagingStatusOf, renderTemplate, unknownTemplateKeys, ORDER_MESSAGE_VAR_KEYS } from "@/lib/messaging/types";
import { BUSINESS_TYPE_SPEC, CORE_MODULES, type SignupDraft } from "@/lib/onboarding/shared";
import { createOrganizationFromSignup } from "@/lib/onboarding/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { domainSlugProblem, hostSlug, subdomainOrigin } from "@/lib/platform/host";
import { HOME_BRAND_PATTERN, hostTabMetadata } from "@/lib/branding/copy";
import { readFileSync } from "node:fs";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { checkDomainSlug, organizationBaseUrl, organizationForHostSlug, publicationOf, publishChecklist, publishOrganization, setDomainSlug } from "@/lib/platform/publish";
import { provisionOrganization } from "@/lib/platform/provision";
import { cancelManualOrderCore, createManualOrderCore, materialChanges, updateManualOrderCore } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { foldVi, searchCatalog, stockFor, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_BOT_ERROR_LABEL, SALES_CHATBOT_SETTING_KEY, salesBotError, withinBusinessHours } from "@/lib/sales-chatbot/config";
import { setSettingJson } from "@/lib/settings";
import { AI_DOWN_HANDOFF_REASON, chatTurn, conversationView, historyForModel, listConversations, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { parsePancakeWebhook, processFanpageThread, receiveFanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { resolveUrlSecretOrganization, webhookUrlToken } from "@/lib/platform/webhooks";
import { runWorkflows } from "@/lib/workflow/engine";

const ORG = "ss-food";
const OTHER = "ss-other";
const ADMIN_EMAIL = "chu@ss-food.local";
const NO_KEY: SecretsKeyState = { ok: false, reason: "Máy chủ chưa có PLATFORM_SECRETS_KEY (kiểm thử)." } as unknown as SecretsKeyState;

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(code: string, email: string): Promise<SessionUser> {
  return withOrganization(code, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
    assert.ok(u, `thiếu quản trị ${email} của ${code}`);
    const org = await findOrganization(code);
    return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: org?.name ?? code, isHome: false }, modules: [...(await getEnabledModules(code))] };
  });
}

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function testPure() {
  // Mẫu thực phẩm qua ĐÚNG bộ kiểm của mẫu / AI; không mang sản phẩm / giá / bí mật nào.
  const v = validateBlueprint(FOOD_COMMERCE_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(BUSINESS_TYPE_SPEC.food.templateKey, "food-commerce");
  for (const m of ["customers", "products", "orders", "inventory", "logistics", "customer_care", "ai_sales"] as const) assert.ok(FOOD_COMMERCE_BLUEPRINT.modules.includes(m), `mẫu thực phẩm thiếu module ${m}`);
  const keys = (FOOD_COMMERCE_BLUEPRINT.fields ?? []).filter((f) => f.objectKey === "product").map((f) => f.key);
  for (const k of ["package_size", "net_weight", "selling_unit", "storage_instruction", "usage_instruction", "food_category"]) assert.ok(keys.includes(k), `thiếu field ${k}`);
  const text = JSON.stringify(FOOD_COMMERCE_BLUEPRINT);
  assert.ok(!/HSLC|Chả mực giã tay|Ruốc bông|Nem hải sản|120000|400000|sk-ant|hook\//i.test(text), "mẫu KHÔNG mang sản phẩm / giá / bí mật của khách nào");
  assert.ok((FOOD_COMMERCE_BLUEPRINT.workflows ?? []).every((w) => w.trigger.kind === "event" && w.trigger.event.startsWith("order.")), "luật mẫu nghe sự kiện đơn");

  // Tên miền con: hàm THUẦN tách slug từ host.
  assert.equal(hostSlug("hslc.erp.vn", "erp.vn"), "hslc");
  assert.equal(hostSlug("HSLC.erp.vn:443", "erp.vn"), "hslc");
  assert.equal(hostSlug("hslc.localhost:3399", "localhost:3399"), "hslc");
  assert.equal(hostSlug("erp.vn", "erp.vn"), null, "miền gốc không có slug");
  assert.equal(hostSlug("a.b.erp.vn", "erp.vn"), null, "nhiều hơn một nhãn ⇒ không");
  assert.equal(hostSlug("evil.com", "erp.vn"), null);
  assert.equal(hostSlug("hslcerp.vn", "erp.vn"), null, "không có dấu chấm ranh giới ⇒ không");
  assert.equal(hostSlug("hslc.erp.vn", null), null, "chưa khai miền gốc ⇒ không định tuyến");
  assert.equal(subdomainOrigin("hslc", "erp.vn"), "https://hslc.erp.vn");
  assert.equal(subdomainOrigin("hslc", "localhost:3399"), "http://hslc.localhost:3399");
  // Tiêu đề tab của trang ngoài dashboard (/login, /chat, /join) trên tên miền con: tên tổ chức, KHÔNG BAO GIỜ chữ của nhà.
  assert.equal(hostTabMetadata({ slug: null, org: null }), null, "miền chính ⇒ bố cục gốc giữ chữ của nhà");
  const tab = hostTabMetadata({ slug: "hslc", org: { name: "HSLC Shop" } });
  assert.equal(tab?.title.absolute, "HSLC Shop");
  assert.equal(tab?.title.template, "%s · HSLC Shop");
  const unknownTab = hostTabMetadata({ slug: "khong-co", org: null });
  assert.equal(unknownTab?.title.absolute, "ERP", "host lạ ⇒ chữ trung tính");
  for (const m of [tab, unknownTab]) assert.ok(!HOME_BRAND_PATTERN.test(`${m?.title.absolute} ${m?.title.template} ${m?.description}`), "không lọt tên / mô tả của nhà");
  const rootLayout = readFileSync("app/layout.tsx", "utf8");
  assert.ok(/generateMetadata[\s\S]*hostTabMetadata\(await hostOrganization\(\)\)/.test(rootLayout), "bố cục gốc đi qua hostTabMetadata(hostOrganization())");
  assert.ok(!/export const metadata\b/.test(rootLayout), "bố cục gốc không còn metadata tĩnh của nhà");
  assert.equal(domainSlugProblem("www")?.code, "RESERVED");
  assert.equal(domainSlugProblem("Hslc Shop")?.code, "FORMAT");
  assert.equal(domainSlugProblem("hslc-")?.code, "EDGE_HYPHEN");
  assert.equal(domainSlugProblem("hs--lc")?.code, "DOUBLE_HYPHEN");
  assert.equal(domainSlugProblem("hslc"), null);

  // Mẫu tin: ô lạ giữ nguyên (người đọc thấy mình gõ sai), mẫu dựng sẵn chỉ dùng ô đã khai.
  assert.equal(renderTemplate("A {{order_code}} {{la}}", { order_code: "#1" }), "A #1 {{la}}");
  for (const t of Object.values(DEFAULT_ORDER_TEMPLATES)) assert.deepEqual(unknownTemplateKeys(t, ORDER_MESSAGE_VAR_KEYS), []);
  assert.equal(messagingStatusOf("sandbox-messaging", { status: "ACTIVE", lastTestOk: true }), "TEST_MODE", "hộp thử không bao giờ là «đã kết nối»");
  assert.equal(messagingStatusOf("lark-webhook", { status: "ACTIVE", lastTestOk: true }), "CONNECTED");
  assert.equal(messagingStatusOf("lark-webhook", { status: "DRAFT", lastTestOk: false }), "FAILED");

  // Phần đơn nhóm vận hành phải biết.
  const base = { customerId: "c", stage: "CONFIRMED", lines: [{ variantId: "a", quantity: 2, unitPrice: 400_000, discount: 0 }], recipient: { name: "Lan", phone: "09", address: "1 A", province: "" }, amountDue: 830_000 };
  assert.deepEqual(materialChanges(base, base), []);
  assert.deepEqual(materialChanges(base, { ...base, lines: [{ ...base.lines[0], quantity: 3 }], amountDue: 1_230_000 }), ["lines", "amount_due"]);
  assert.deepEqual(materialChanges(base, { ...base, recipient: { ...base.recipient, address: "2 B" } }), ["shipping_address"]);
  assert.ok(ORDER_MATERIAL_CHANGE_LABEL.lines && ORDER_MATERIAL_CHANGE_LABEL.shipping_address);

  // Tìm sản phẩm không dấu; giờ làm việc qua nửa đêm.
  const items: CatalogItem[] = [
    { variantId: "v1", productId: "p1", name: "Chả mực giã tay", sku: "CHA-MUC", variant: "", price: 400_000, fields: { package_size: "1kg" } },
    { variantId: "v2", productId: "p2", name: "Ruốc bông tôm 100%", sku: "RUOC-TOM", variant: "", price: 350_000, fields: {} },
  ];
  assert.equal(foldVi("Chả Mực Giã Tay"), "cha muc gia tay");
  assert.deepEqual(searchCatalog(items, "cha muc").map((i) => i.variantId), ["v1"]);
  assert.deepEqual(searchCatalog(items, "ruốc tôm").map((i) => i.variantId), ["v2"]);
  const night = { ...DEFAULT_SALES_CHATBOT_CONFIG.businessHours, enabled: true, start: "22:00", end: "06:00" };
  assert.equal(withinBusinessHours(night, new Date("2026-09-29T16:30:00Z")), true, "23:30 VN trong khung 22–06");
  assert.equal(withinBusinessHours(night, new Date("2026-09-29T05:00:00Z")), false, "12:00 VN ngoài khung");

  // Lịch sử gửi model không bao giờ mở đầu bằng tool_result mồ côi.
  const hist = historyForModel(
    [
      { role: "assistant", content: [{ type: "text", text: "chào" }] },
      { role: "user", content: [{ type: "text", text: "hỏi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_products", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "{}" }] },
    ],
    2,
  );
  assert.ok(hist.length === 0 || hist[0].content.every((b) => b.type === "text"));
  console.log("✓ Tự phục vụ · thuần: mẫu thực phẩm hợp lệ, tên miền con, mẫu tin, phần đổi của đơn, tìm không dấu, giờ làm việc");
}

// ─────────────────────────── MODEL GIẢ (không gọi mạng — luật 65) ───────────────────────────

type Scripted = (req: AiRequest, lastUser: string, lastResults: Record<string, unknown>[]) => AiBlock[];

/** Pancake giả: ghi mọi lời gọi (url + init), trả JSON do `respond` quyết. KHÔNG gọi mạng (luật 65). */
function fakeFetchCalls(respond: (url: string, init?: RequestInit) => unknown): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(respond(url, init)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function fakeProvider(script: Scripted): AiProvider {
  let n = 0;
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      const last = req.messages[req.messages.length - 1];
      const lastUserText = [...req.messages].reverse().find((m) => m.role === "user" && m.content.every((b) => b.type === "text"));
      const results = last.content.filter((b): b is Extract<AiBlock, { type: "tool_result" }> => b.type === "tool_result").map((b) => JSON.parse(b.content) as Record<string, unknown>);
      const text = lastUserText ? lastUserText.content.map((b) => (b.type === "text" ? b.text : "")).join(" ") : "";
      const content = script(req, text, last.role === "user" && results.length ? results : []);
      n += 1;
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 + n * 0 };
    },
  };
}

/** Kịch bản bán chả mực + ruốc tôm: tìm → báo giá (lấy SỐ từ kết quả công cụ) → kiểm tồn + tính giỏ → lưu khách + đơn nháp → chốt. */
function hslcScript(ids: { chaMuc: string; ruocTom: string }): Scripted {
  let id = 0;
  const use = (name: string, input: unknown): AiBlock => ({ type: "tool_use", id: `tu-${++id}`, name, input });
  return (_req, user, results) => {
    const u = foldVi(user);
    if (results.length) {
      const r = results[0];
      if (Array.isArray(r.results)) return [{ type: "text", text: `Chả mực giã tay giá ${String((r.results[0] as { price_text: string }).price_text)} một gói 1kg ạ.` }];
      if (Array.isArray(r.items)) return [use("calculate_cart", { items: [{ variant_id: ids.chaMuc, quantity: 2 }, { variant_id: ids.ruocTom, quantity: 1 }] })];
      if (typeof r.subtotal_text === "string" && !r.order_code) return [{ type: "text", text: `Tạm tính ${r.subtotal_text}, ${String(r.shipping_text)}, tổng thu ${String(r.cod_total_text)}. Chị cho em tên, SĐT, địa chỉ nhé.` }];
      if (r.customer_id) return [use("create_draft_order", { items: [{ variant_id: ids.chaMuc, quantity: 2 }, { variant_id: ids.ruocTom, quantity: 1 }], delivery_note: "Giao giờ hành chính" })];
      if (r.order_code && r.confirmed) return [{ type: "text", text: `Đã chốt đơn ${String(r.order_code)}, tổng thu ${String(r.cod_total_text)}.` }];
      if (r.order_code) return [{ type: "text", text: `Tóm tắt: ${String((r.lines as { text: string }[]).map((l) => l.text).join("; "))}. Tổng thu ${String(r.cod_total_text)}. Chị xác nhận chốt đơn không ạ?` }];
      if (r.error) return [{ type: "text", text: `Lỗi: ${String(r.error)}` }];
      return [{ type: "text", text: "Dạ." }];
    }
    if (u.includes("bao nhieu")) return [use("search_products", { query: "chả mực" })];
    if (u.includes("2 goi")) return [use("check_inventory", { items: [{ variant_id: ids.chaMuc, quantity: 2 }, { variant_id: ids.ruocTom, quantity: 1 }] })];
    if (u.includes("0912345678")) return [use("create_customer", { name: "Nguyễn Thị Lan", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" })];
    if (u.includes("ok chot")) return [use("confirm_order", { customer_confirmation: "ok chốt đơn" })];
    if (u.includes("tu chot")) return [use("confirm_order", { customer_confirmation: "đồng ý" })];
    return [{ type: "text", text: "Dạ em nghe ạ." }];
  };
}

// ─────────────────────────── 2 · TỔ CHỨC THẬT ───────────────────────────

function signup(): SignupDraft {
  return {
    invite: null,
    org: { name: "Shop thực phẩm thử", code: ORG },
    admin: { name: "Chủ shop thử", email: ADMIN_EMAIL, password: "ThucPham@2026!" },
    plan: { businessType: "food", templateKey: "food-commerce", modules: FOOD_COMMERCE_BLUEPRINT.modules.filter((m) => !CORE_MODULES.includes(m)) },
    planKey: "trial",
  };
}

async function testJourney() {
  const home = await getHomeOrganization();
  const operator = { kind: "operator" as const, ip: "10.78.0.1", actor: { orgCode: home.code, userId: "ss-op", email: "op@ss.local" } };
  const r = await createOrganizationFromSignup(signup(), operator);
  assert.ok("ok" in r && r.created, JSON.stringify(r));
  const org = await findOrganization(ORG);
  assert.ok(org && org.status === "ACTIVE" && org.publishState === "DRAFT", "tổ chức mới qua /start là BẢN NHÁP");
  const enabled = await getEnabledModules(ORG);
  for (const m of ["ai_sales", "orders", "inventory", "customers", "products", "logistics", "customer_care", "work"]) assert.ok(enabled.has(m as never), `module ${m} phải bật`);
  assert.equal((await getEnabledModules(home.code)).has("ai_sales"), false, "AI bán hàng TẮT ở tổ chức nhà (0180)");
  const admin = await adminOf(ORG, ADMIN_EMAIL);

  await withOrganization(ORG, async () => {
    const db = await getDb();
    // ── Mẫu đã cài: field sản phẩm, vai trò, luật báo nhóm ở NHÁP ──
    const fields = await db.select({ key: schema.metaCustomFields.fieldKey }).from(schema.metaCustomFields).where(eq(schema.metaCustomFields.objectKey, "product"));
    assert.ok(fields.some((f) => f.key === "package_size") && fields.some((f) => f.key === "storage_instruction"));
    const rules = await db.select().from(schema.workflowRules);
    const confirmRule = rules.find((x) => x.key === "bao_nhom_don_xac_nhan");
    assert.ok(confirmRule && confirmRule.status === "DRAFT", "luật của mẫu ở NHÁP (luật 23)");

    // ── Sản phẩm + tồn ──
    const mk = async (name: string, code: string, price: number, size: string) => {
      const p = await createProductCore(admin, { name, code, unit: "gói", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
      assert.ok(p.ok, JSON.stringify(p));
      const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
      assert.ok(v);
      await db.insert(schema.customValues).values({ objectKey: "product", recordId: p.id, values: { package_size: size } }).onConflictDoNothing();
      return v.id;
    };
    const chaMuc = await mk("Chả mực giã tay", "CHA-MUC-GIA-TAY", 400_000, "1kg");
    const ruocTom = await mk("Ruốc bông tôm 100%", "RUOC-BONG-TOM", 350_000, "250g");
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-SS-1", totalQuantity: 20, createdBy: ADMIN_EMAIL }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values([
      { receiptId: rc.id, variantId: chaMuc, quantity: 10, unitCost: 250_000 },
      { receiptId: rc.id, variantId: ruocTom, quantity: 10, unitCost: 200_000 },
    ]);
    const avail = async (id: string) => (await stockFor([id])).get(id)?.available;
    assert.equal(await avail(chaMuc), 10);

    // ── Hộp thử nhắn tin: không bí mật ⇒ không cần PLATFORM_SECRETS_KEY ──
    assert.ok("ok" in (await saveConnection(admin, { connectorKey: "sandbox-messaging", settings: { channelName: "Nhóm vận hành" } }, { keyState: NO_KEY })));
    assert.ok("ok" in (await testOrgConnection(admin, "sandbox-messaging", { keyState: NO_KEY })));
    assert.ok("ok" in (await setConnectionStatus(admin, "sandbox-messaging", "ACTIVE")));
    const setup0 = await loadNotificationSetup();
    assert.equal(setup0.connections.find((c) => c.key === "sandbox-messaging")?.status, "TEST_MODE");

    // ── Cấu hình sẵn ⇒ ba luật THẬT ──
    const nope = await saveOrderNotificationPreset({ ...admin, role: "MANAGER", permissions: admin.permissions.filter((p) => p !== "workflow:manage") }, { connectorKey: "sandbox-messaging", destination: "", events: [], templates: {} });
    assert.ok(!nope.ok && /workflow:manage/.test(nope.error), "thiếu workflow:manage ⇒ từ chối");
    const bad = await saveOrderNotificationPreset(admin, { connectorKey: "sandbox-messaging", destination: "", events: ["order.confirmed"], templates: { "order.confirmed": "Đơn {{khong_co}}" } });
    assert.ok(!bad.ok && /không điền được/.test(bad.error), "ô lạ trong mẫu ⇒ từ chối trước khi lưu");
    const saved = await saveOrderNotificationPreset(admin, { connectorKey: "sandbox-messaging", destination: "Nhóm vận hành", events: ["order.confirmed", "order.updated", "order.cancelled"], templates: DEFAULT_ORDER_TEMPLATES });
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    const live = (await db.select().from(schema.workflowRules)).filter((x) => x.key.startsWith("bao_nhom_don_"));
    assert.equal(live.length, 3, "một luật cho mỗi sự kiện — luật của mẫu được NÂNG, không đẻ thêm");
    assert.ok(live.every((x) => x.status === "ACTIVE" && x.mode === "LIVE"));

    const deliveries = async () => db.select().from(schema.messagingDeliveries).where(and(eq(schema.messagingDeliveries.isTest, false), like(schema.messagingDeliveries.dedupeKey, "workflow:%"), sql`${schema.messagingDeliveries.runId} is not null`)).orderBy(schema.messagingDeliveries.createdAt);
    const [cus] = await db.insert(schema.customers).values({ name: "Khách Thử", phone: "0988000111", address: "5 Lý Thường Kiệt", province: "Hà Nội" }).returning({ id: schema.customers.id });

    // ── Đơn chốt ⇒ đúng MỘT tin + giữ hàng ──
    const input = { customerId: cus.id, stage: "CONFIRMED" as const, channel: "Zalo", note: "Gọi trước khi giao", orderDiscount: 0, shippingFee: 30_000, lines: [{ variantId: chaMuc, quantity: 2, unitPrice: 400_000, discount: 0 }, { variantId: ruocTom, quantity: 1, unitPrice: 350_000, discount: 0 }] };
    const created = await createManualOrderCore(admin, input);
    assert.ok(created.ok, JSON.stringify(created));
    let d = await deliveries();
    assert.equal(d.length, 1, "đơn chốt ⇒ một tin");
    assert.equal(d[0].status, "SENT");
    assert.equal(d[0].event, "order.confirmed");
    for (const needle of ["ĐƠN MỚI", "Khách Thử", "0988000111", "5 Lý Thường Kiệt", "Chả mực giã tay × 2 × 400.000 ₫ = 800.000 ₫", "Ruốc bông tôm 100% × 1 × 350.000 ₫ = 350.000 ₫", "Ship: 30.000 ₫", "THU COD: 1.180.000 ₫", "Nguồn: Zalo", `/orders/${created.id}`]) {
      assert.ok(d[0].body.includes(needle), `tin đơn chốt thiếu «${needle}»:\n${d[0].body}`);
    }
    assert.equal(await avail(chaMuc), 8, "đơn chốt GIỮ 2 gói ở cột khả dụng");

    // Chạy lại bộ máy luật ⇒ không tin thứ hai.
    await runWorkflows();
    assert.equal((await deliveries()).length, 1, "chạy lại luật không gửi lại");

    // ── Sửa SL ⇒ tin cập nhật; gửi lại đúng lượt sửa ⇒ không gì thêm ──
    const edited = { ...input, lines: [{ variantId: chaMuc, quantity: 3, unitPrice: 400_000, discount: 0 }, input.lines[1]] };
    assert.ok((await updateManualOrderCore(admin, created.id, edited)).ok);
    d = await deliveries();
    assert.equal(d.length, 2);
    assert.equal(d[1].event, "order.updated");
    assert.ok(d[1].body.includes("Hàng / số lượng / giá") && d[1].body.includes("THU COD: 1.580.000 ₫"), d[1].body);
    assert.ok((await updateManualOrderCore(admin, created.id, edited)).ok);
    assert.equal((await deliveries()).length, 2, "gửi lại đúng lượt sửa ⇒ không sự kiện, không tin");
    assert.equal(await avail(chaMuc), 7);

    // ── Đổi địa chỉ giao của RIÊNG đơn ⇒ tin cập nhật; hồ sơ khách giữ nguyên ──
    assert.ok((await updateManualOrderCore(admin, created.id, { ...edited, recipient: { name: "", phone: "", address: "99 Bà Triệu", province: "Hà Nội" } })).ok);
    d = await deliveries();
    assert.equal(d.length, 3);
    assert.ok(d[2].body.includes("Người nhận / địa chỉ") && d[2].body.includes("99 Bà Triệu"), d[2].body);
    assert.equal((await db.query.customers.findFirst({ where: eq(schema.customers.id, cus.id) }))?.address, "5 Lý Thường Kiệt", "địa chỉ giao của đơn không sửa hồ sơ khách");

    // ── Huỷ ⇒ tin huỷ + nhả hàng; huỷ đơn chưa từng chốt ⇒ không tin ──
    assert.ok((await cancelManualOrderCore(admin, created.id, { reason: "Khách đổi ý" })).ok);
    d = await deliveries();
    assert.equal(d.length, 4);
    assert.equal(d[3].event, "order.cancelled");
    assert.ok(d[3].body.includes("HUỶ ĐƠN") && d[3].body.includes("Khách đổi ý"));
    assert.equal(await avail(chaMuc), 10, "huỷ ⇒ nhả hàng");
    const fresh = await createManualOrderCore(admin, { ...input, stage: "NEW" });
    assert.ok(fresh.ok);
    assert.ok((await cancelManualOrderCore(admin, fresh.id, { reason: "Nhầm" })).ok);
    assert.equal((await deliveries()).length, 4, "đơn chưa từng chốt bị huỷ ⇒ không báo nhóm");
    const events = await db.select({ name: schema.domainEvents.name, key: schema.domainEvents.dedupeKey }).from(schema.domainEvents).where(like(schema.domainEvents.name, "order.%"));
    assert.equal(events.filter((e) => e.key === `order.confirmed:${created.id}`).length, 1);

    // ── Sổ gửi tin: dòng PENDING bỏ dở ⇒ KHÔNG gửi lại (at-most-once) ──
    await db.insert(schema.messagingDeliveries).values({ dedupeKey: "workflow:treo:0", connectorKey: "sandbox-messaging", body: "x", status: "PENDING" });
    const again = await deliverMessage({ connectorKey: "sandbox-messaging", body: "y", dedupeKey: "workflow:treo:0" });
    assert.equal(again.status, "UNKNOWN");
    const dup = await deliverMessage({ connectorKey: "sandbox-messaging", body: "z", dedupeKey: d[0].dedupeKey });
    assert.equal(dup.status, "DUPLICATE");

    // ═══ CHATBOT ═══
    const noModule = await saveSalesChatbotConfig({ ...admin, role: "MANAGER", permissions: admin.permissions.filter((p) => p !== "ai_sales:manage") }, DEFAULT_SALES_CHATBOT_CONFIG);
    assert.ok(!noModule.ok, "thiếu ai_sales:manage ⇒ từ chối");
    const noKey = await saveSalesChatbotConfig(admin, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
    assert.ok(!noKey.ok && /Chưa bật được bot/.test(noKey.error), "bật bot khi chưa có khoá AI ⇒ từ chối");
    const cfgOk = await saveSalesChatbotConfig(admin, { ...DEFAULT_SALES_CHATBOT_CONFIG, shippingFee: null });
    assert.ok(cfgOk.ok);

    setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
    try {
      // ── Khung THỬ: đọc thật, ghi mô phỏng ──
      const ordersBefore = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.orders))[0].n);
      const customersBefore = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.customers))[0].n);
      const t = await openConversation("TEST", { createdBy: ADMIN_EMAIL });
      const say = async (id: string, text: string, channel: "TEST" | "WEB", visitorKey?: string) => {
        const res = await chatTurn(id, text, { channel, visitorKey: visitorKey ?? null });
        assert.ok(res.ok, res.ok ? "" : res.error);
        return res.view.messages[res.view.messages.length - 1].text;
      };
      assert.match(await say(t.id, "Chả mực bao nhiêu?", "TEST"), /400\.000 ₫/, "giá đọc từ ERP");
      assert.match(await say(t.id, "Cho chị 2 gói, thêm 1 ruốc tôm.", "TEST"), /1\.150\.000 ₫/, "2 × 400.000 + 1 × 350.000 = 1.150.000 trước ship");
      assert.match(await say(t.id, "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội, giao giờ hành chính", "TEST"), /Chị xác nhận chốt đơn/);
      assert.match(await say(t.id, "ok chốt đơn", "TEST"), /Đã chốt đơn \(thử/);
      assert.equal(Number((await db.select({ n: sql<number>`count(*)` }).from(schema.orders))[0].n), ordersBefore, "khung thử KHÔNG tạo đơn");
      assert.equal(Number((await db.select({ n: sql<number>`count(*)` }).from(schema.customers))[0].n), customersBefore, "khung thử KHÔNG tạo khách");
      assert.equal((await deliveries()).length, 4, "khung thử KHÔNG báo nhóm");

      // ── Kênh WEB: ghi thật ⇒ đơn chốt ⇒ order.confirmed ⇒ tin nhóm ──
      // Bật bot đòi khoá AI ĐANG BẬT (đã kiểm ở trên: không khoá ⇒ từ chối); bài kiểm dùng model giả nên đặt cờ bật thẳng.
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true, shippingFee: null });
      const vk = visitorKeyOf("khach-web-1-abcdefghijklmnop");
      const w = await openConversation("WEB", { visitorKey: vk });
      await say(w.id, "Chả mực bao nhiêu?", "WEB", vk);
      await say(w.id, "Cho chị 2 gói, thêm 1 ruốc tôm.", "WEB", vk);
      await say(w.id, "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội, giao giờ hành chính", "WEB", vk);
      // Chốt khi lời "đồng ý" KHÔNG có trong câu cuối của khách ⇒ từ chối.
      assert.match(await say(w.id, "để chị tự chốt sau nhé", "WEB", vk), /Lỗi: customer_confirmation/);
      const conv0 = await db.query.salesChatConversations.findFirst({ where: eq(schema.salesChatConversations.id, w.id) });
      const draft = conv0?.draftOrderId ? await db.query.orders.findFirst({ where: eq(schema.orders.id, conv0.draftOrderId) }) : null;
      assert.ok(draft && draft.stage === "NEW", "đơn NHÁP (chưa giữ hàng) trước khi khách đồng ý");
      assert.equal(draft.totalPriceAfterDiscount, 1_150_000, "đơn giá do ERP điền");
      assert.ok(draft.note.includes("Phí ship: CHƯA BÁO"), "shop chưa khai ship ⇒ đơn ghi rõ, không bịa số");
      assert.equal(await avail(chaMuc), 10, "đơn nháp không giữ hàng");
      assert.match(await say(w.id, "ok chốt đơn", "WEB", vk), /Đã chốt đơn #/);
      const conv = await db.query.salesChatConversations.findFirst({ where: eq(schema.salesChatConversations.id, w.id) });
      const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, conv?.orderId ?? "") });
      assert.ok(order && order.stage === "CONFIRMED" && order.shipAddress === "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" && order.source === "Chatbot web");
      assert.equal((order.raw as { agent?: string; createdBy?: string | null }).agent, "Chatbot bán hàng");
      assert.equal((order.raw as { createdBy?: string | null }).createdBy, null, "máy không giả làm người (luật 36)");
      assert.equal(await avail(chaMuc), 8, "chốt ⇒ giữ hàng");
      d = await deliveries();
      assert.equal(d.length, 5, "đơn do chatbot chốt ⇒ đúng một tin nhóm");
      assert.ok(d[4].body.includes("Nguyễn Thị Lan") && d[4].body.includes("0912345678") && d[4].body.includes("Nguồn: Chatbot web"), d[4].body);
      const ev = await db.query.domainEvents.findFirst({ where: and(eq(schema.domainEvents.name, "order.confirmed"), eq(schema.domainEvents.subjectId, order.id)) });
      assert.equal(ev?.actorKind, "AGENT");

      // Hội thoại khoá theo khách truy cập.
      const stranger = await chatTurn(w.id, "xin chào", { channel: "WEB", visitorKey: visitorKeyOf("nguoi-khac-xxxxxxxxxxxxxxxx") });
      assert.ok(!stranger.ok, "khách truy cập khác không gõ tiếp hội thoại này");
      assert.ok(!(await chatTurn(w.id, "xin chào", { channel: "TEST" })).ok, "sai kênh ⇒ không");
      const view = await conversationView(w.id);
      assert.equal(view?.order?.stage, "CONFIRMED");

      // Lượt chatbot vào sổ AI nhưng KHÔNG ăn trần lượt / ngày của gói.
      const usage = await sourceUsage(ORG, "BYOK");
      assert.equal(usage.requestsToday, 0, "lượt chatbot không tính vào trần 10 lượt/ngày của trial");
      const pdb = await getPlatformDb();
      const rows = await pdb.select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, ORG), eq(schema.platformAiUsage.feature, "sales_chatbot")));
      assert.ok(rows.length >= 8 && rows.every((x) => x.costUsd !== null), "mỗi lượt khách một dòng sổ, có chi phí ước tính");

      // Tổ chức khác không thấy hội thoại của tổ chức này.
      await withOrganization(OTHER, async () => {
        const other = await chatTurn(w.id, "xin chào", { channel: "WEB", visitorKey: vk });
        assert.ok(!other.ok, "id hội thoại của tổ chức A vô nghĩa ở tổ chức B");
      });
    } finally {
      setSalesChatProviderForTests(null);
    }

    // ── U29 · AI không trả lời được (đo UAT production 30/09/2026: khoá AI của shop hết credit giữa buổi) ⇒ khách chỉ
    // nhận câu xin lỗi + câu chuyển người của shop, hội thoại sang HANDOFF, nhân viên nhận MỘT thông báo gọi lại cho mỗi
    // khách, chủ shop MỘT cảnh báo mỗi ngày. KHÔNG màn hình nào in lỗi gốc của nhà cung cấp. Quá tải (tự khỏi) không
    // thêm cảnh báo chủ shop — nhưng khách vẫn được chuyển người, không bị bỏ lơ.
    assert.equal(salesBotError(null), null);
    assert.equal(salesBotError("429 rate_limit_error")?.notify, false, "quá tải tự khỏi ⇒ không cảnh báo chủ shop");
    const creditMsg = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';
    assert.deepEqual(salesBotError(creditMsg), { kind: "CREDIT", label: SALES_BOT_ERROR_LABEL.CREDIT, notify: true });
    let failWith = creditMsg;
    setSalesChatProviderForTests(() => ({ ...fakeProvider(() => []), complete: async () => { throw new Error(failWith); } }));
    try {
      const ownerAlerts = async () => (await db.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-chat:provider:%"))).length;
      const RAW = /credit|invalid_request|anthropic|\b400\b|\{"type"|stack|Error:/i;
      const customer = async (seed: string, text: string) => {
        const vk = visitorKeyOf(`uat-ai-hong-${seed}-00000000000000`);
        const c = await openConversation("WEB", { visitorKey: vk });
        const r = await chatTurn(c.id, text, { channel: "WEB", visitorKey: vk });
        assert.ok(r.ok, "khách không bao giờ nhận trang lỗi");
        return { c, vk, view: r.ok ? r.view : null };
      };
      const a1 = await customer("a", "Chả mực bao nhiêu?");
      const shown = a1.view!.messages.map((m) => m.text).join(" ");
      assert.match(shown, /trục trặc/);
      assert.ok(shown.includes(DEFAULT_SALES_CHATBOT_CONFIG.handoff.message), "khách nhận câu chuyển người của shop");
      assert.ok(!RAW.test(shown), `khách không thấy lỗi gốc: ${shown}`);
      assert.equal(a1.view!.status, "HANDOFF", "hội thoại chuyển nhân viên");
      const again = await chatTurn(a1.c.id, "Alo em ơi", { channel: "WEB", visitorKey: a1.vk });
      assert.ok(again.ok && /Nhân viên của shop đang tiếp nhận/.test(again.view.messages[again.view.messages.length - 1].text), "khách nhắn tiếp ⇒ đã có người nhận, không gọi lại AI");
      await customer("b", "Còn hàng không em?");
      assert.equal(await ownerAlerts(), 1, "hai khách đâm vào tường ⇒ MỘT cảnh báo cho chủ shop trong ngày");
      const handoffs = (await db.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-chat:handoff:%"))).filter((n) => n.body.startsWith(AI_DOWN_HANDOFF_REASON));
      assert.equal(handoffs.length, 2, "mỗi khách MỘT thông báo gọi lại cho nhân viên");
      assert.ok(handoffs.every((n) => !RAW.test(`${n.title} ${n.body}`)), "thông báo cho nhân viên không mang lỗi gốc");
      // Hộp thư CÁ NHÂN — chuông đọc nó kể cả khi tổ chức KHÔNG bật «Cần xử lý» (mẫu thực phẩm không bật): người đọc được
      // chatbot nhận tin chuyển người, người cấu hình được chatbot nhận cảnh báo AI. Chọn người nhận bằng đúng can().
      const viewers = await activeUserIdsWhoCan("ai_sales:view");
      assert.ok(viewers.length >= 1, "quản trị đọc được chatbot");
      assert.deepEqual(await activeUserIdsWhoCan("platform:operate"), [], "chọn người nhận đi qua can(): quyền chỉ của nhà ⇒ không ai ở tổ chức khách");
      const inbox = await db.select().from(schema.userMessages).where(like(schema.userMessages.dedupeKey, "sales-chat:%"));
      assert.equal(inbox.filter((m) => m.kind === "SALES_CHAT_HANDOFF" && m.body.startsWith(AI_DOWN_HANDOFF_REASON)).length, 2 * viewers.length, "mỗi khách MỘT tin cho MỖI người đọc được chatbot");
      assert.equal(inbox.filter((m) => m.kind === "SALES_CHAT_AI_DOWN").length, (await activeUserIdsWhoCan("ai_sales:manage")).length, "cảnh báo AI: MỘT tin mỗi người cấu hình được, trong ngày");
      assert.ok(inbox.every((m) => !RAW.test(`${m.title} ${m.body}`)), "hộp thư không mang lỗi gốc");
      failWith = "429 rate_limit_error: overloaded";
      const c3 = await customer("c", "Alo");
      assert.equal(c3.view!.status, "HANDOFF", "quá tải ⇒ khách vẫn được chuyển người");
      assert.equal(await ownerAlerts(), 1, "quá tải ⇒ không thêm cảnh báo chủ shop");
      const listed = await listConversations(50);
      assert.ok(listed.some((x) => x.lastError && RAW.test(x.lastError)), "lỗi gốc vẫn nằm trong CSDL cho người vận hành tra");
      const page = readFileSync("app/(dashboard)/ai/sales-chatbot/page.tsx", "utf8");
      assert.ok(!/\{c\.lastError(?!\s*\?)|title=\{c\.lastError\}|c\.lastError\.slice/.test(page), "màn hình không in lỗi gốc — chỉ nhãn tiếng Việt");
    } finally {
      setSalesChatProviderForTests(null);
    }

    // ═══ BOT FANPAGE (0182): tin Pancake ⇒ ĐÚNG tổ chức theo token ⇒ chatbot bán hàng của tổ chức ⇒ trả lời qua reply_inbox ═══
    // Bí mật kết nối cần PLATFORM_SECRETS_KEY: đặt một khoá KIỂM THỬ cho khối này rồi trả lại nguyên trạng (luật 65).
    const savedSecretsKey = process.env.PLATFORM_SECRETS_KEY;
    process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-fanpage-0123456789abcdefghijklmnopqrstuvwxyz";
    try {
    const PAGE = "1122334455";
    const PAGE_TOKEN = "pancake_page_token_0123456789abcdef";
    const pancake = fakeFetchCalls((url, init) => (url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `m-bot-${Math.random().toString(36).slice(2, 8)}` } : { success: true }));
    const savedFp = await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } });
    assert.ok("ok" in savedFp, JSON.stringify(savedFp));
    const tested = await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } });
    assert.ok("ok" in tested, JSON.stringify(tested));
    assert.ok(pancake.calls[0].url.startsWith(`https://pages.fm/api/public_api/v2/pages/${PAGE}/conversations?`) && pancake.calls[0].init?.method === "GET", "kiểm tra = CHỈ ĐỌC danh sách hội thoại");
    assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));

    // Token webhook: đúng tổ chức; sửa một ký tự / đổi mã tổ chức / tổ chức nhà ⇒ không ai.
    const token = webhookUrlToken("PANCAKE_FANPAGE", ORG)!;
    assert.ok(token.startsWith(`${ORG}.`));
    assert.equal(await resolveUrlSecretOrganization("PANCAKE_FANPAGE", token), ORG);
    assert.equal(await resolveUrlSecretOrganization("PANCAKE_FANPAGE", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`), null, "chữ ký sai ⇒ không tổ chức nào");
    assert.equal(await resolveUrlSecretOrganization("PANCAKE_FANPAGE", `${OTHER}.${token.split(".")[1]}`), null, "chữ ký của A không mở được B");
    const home = await getHomeOrganization();
    assert.equal(await resolveUrlSecretOrganization("PANCAKE_FANPAGE", webhookUrlToken("PANCAKE_FANPAGE", home.code)!), null, "không bao giờ phân giải về tổ chức nhà");
    const caddy = readFileSync("deploy/Caddyfile", "utf8");
    const redact = /request>uri regexp "([^"]+)" "([^"]+)"/.exec(caddy)!;
    const re = new RegExp(redact[1].replace("(?i:", "(?:"), "gi");
    assert.equal(`/api/webhooks/pancake/fanpage/${token}`.replace(re, (_m, a: string | undefined, b: string | undefined) => `${a ?? ""}${b ?? ""}REDACTED`), "/api/webhooks/pancake/fanpage/REDACTED", "log Caddy che token fanpage");

    const ev = (id: string, text: string, from: Record<string, unknown> = { id: "cust-1", name: "Chị Lan" }, thread = "t-900", page = PAGE) =>
      parsePancakeWebhook({ event_type: "messaging", page_id: page, data: { conversation: { id: thread, type: "INBOX" }, message: { id, type: "INBOX", message: text, from } } })!;
    assert.equal(parsePancakeWebhook({ event_type: "order_updated" }), null, "không phải tin nhắn ⇒ bỏ qua");
    setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
    try {
      const inboundCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.salesChatInbound))[0].n);
      assert.deepEqual(await receiveFanpageEvent(ev("m1", "Chả mực bao nhiêu?")), { queued: true, reason: "Đã nhận" });
      assert.equal((await receiveFanpageEvent(ev("m1", "Chả mực bao nhiêu?"))).queued, false, "Pancake gửi lại ⇒ không nhận lần hai");
      assert.equal((await receiveFanpageEvent(ev("m-x", "hi", { id: "cust-9" }, "t-1", "9999999999"))).queued, false, "page khác page đã khai ⇒ không nhận");
      const before = await inboundCount();
      const r1 = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch });
      assert.equal(r1.processed, 1, JSON.stringify(r1));
      assert.ok(r1.replies >= 1 && !r1.error, JSON.stringify(r1));
      const sent = pancake.calls.filter((c) => c.url.includes(`/v1/pages/${PAGE}/conversations/t-900/messages`));
      assert.ok(sent.length >= 1 && sent.every((c) => c.init?.method === "POST"), "trả lời qua reply_inbox của đúng hội thoại");
      const body = JSON.parse(String(sent[sent.length - 1].init?.body)) as { action: string; message: string };
      assert.equal(body.action, "reply_inbox");
      assert.match(sent.map((c) => String(c.init?.body)).join(" "), /400\.000/, "giá đọc từ ERP");
      assert.ok(!sent.some((c) => String(c.init?.body).includes(PAGE_TOKEN)), "token không nằm trong body");
      assert.ok((await inboundCount()) > before, "mã tin bot vừa gửi được ghi lại");
      const again = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch });
      assert.equal(again.processed, 0, "không còn tin chờ ⇒ không trả lời lại");
      const convs = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.channel, "FANPAGE"));
      assert.equal(convs.length, 1, "một hội thoại Pancake = một hội thoại chatbot");

      // Pancake đẩy lại chính tin bot vừa gửi (có uid) ⇒ KHÔNG coi là nhân viên.
      const botId = (await db.select({ id: schema.salesChatInbound.messageId }).from(schema.salesChatInbound).where(eq(schema.salesChatInbound.note, "BOT_SENT")).limit(1))[0].id;
      assert.equal((await receiveFanpageEvent(ev(botId, "Dạ...", { id: PAGE, uid: "u-staff" }))).reason, "Tin của chính bot");
      assert.equal((await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, convs[0].id)))[0].status, "OPEN");
      // Nhân viên thật trả lời trên fanpage ⇒ bot nhường hội thoại, tin khách kế tiếp không được bot trả lời.
      assert.match((await receiveFanpageEvent(ev("m-staff-1", "Chị đợi em chút nhé", { id: PAGE, uid: "u-staff", name: "NV" }))).reason, /bot nhường/);
      await receiveFanpageEvent(ev("m2", "Còn hàng không em?"));
      const sentBefore = pancake.calls.length;
      const r2 = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch });
      assert.equal(r2.replies, 0, "nhân viên đang trả lời ⇒ bot im lặng");
      assert.equal(pancake.calls.length, sentBefore, "không gửi gì lên Pancake");
      // Hết thời gian nhường ⇒ bot nhận lại.
      await receiveFanpageEvent(ev("m3", "Chả mực bao nhiêu?"));
      const later = new Date(Date.now() + 31 * 60_000);
      const r3 = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch, now: () => later });
      assert.ok(r3.replies >= 1, `hết ${30} phút ⇒ bot trả lời lại: ${JSON.stringify(r3)}`);
      // Kết nối tắt ⇒ tin không được nhận (không có lối vào cửa sau).
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "DISABLED")));
      assert.equal((await receiveFanpageEvent(ev("m4", "alo"))).reason, "Kết nối fanpage chưa bật");
    } finally {
      setSalesChatProviderForTests(null);
    }
    } finally {
      if (savedSecretsKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
      else process.env.PLATFORM_SECRETS_KEY = savedSecretsKey;
    }
  });

  // ═══ XUẤT BẢN + TÊN MIỀN CON ═══
  const otherAdmin = await adminOf(OTHER, "qt@ss-other.local");
  await withOrganization(OTHER, async () => {
    assert.ok((await setDomainSlug(otherAdmin, "ss-other-shop")).ok);
  });
  await withOrganization(ORG, async () => {
    assert.ok(!(await checkDomainSlug("www", ORG)).ok, "tên dành riêng");
    assert.ok(!(await checkDomainSlug("Shop Thu", ORG)).ok, "sai dạng");
    const taken = await checkDomainSlug("ss-other-shop", ORG);
    assert.ok(!taken.ok && /tổ chức khác/.test(taken.error), "trùng tên miền của tổ chức khác");
    const pre = await publishChecklist();
    assert.equal(pre.ready, false, "chưa chọn tên miền ⇒ chưa xuất bản được");
    assert.ok(pre.checks.find((c) => c.key === "domain" && !c.ok));
    const blocked = await publishOrganization(admin);
    assert.ok(!blocked.ok, "máy chủ kiểm lại — không tin màn hình");
    assert.equal(await organizationForHostSlug("ss-food-shop"), null);
    assert.ok((await setDomainSlug(admin, "ss-food-shop")).ok);
    assert.equal(await organizationForHostSlug("ss-food-shop"), null, "NHÁP ⇒ tên miền con chưa định tuyến");
    const ready = await publishChecklist();
    assert.ok(ready.ready, JSON.stringify(ready.checks.filter((c) => !c.ok)));
    const pub = await publishOrganization(admin);
    assert.ok(pub.ok, pub.ok ? "" : pub.error);
    assert.equal((await publicationOf(ORG)).state, "PUBLISHED");
    assert.equal((await organizationForHostSlug("ss-food-shop"))?.code, ORG, "đã xuất bản ⇒ host trỏ đúng tổ chức");
    assert.equal(await organizationForHostSlug("ss-other-shop"), null, "tổ chức khác còn NHÁP ⇒ không định tuyến");
    const twice = await publishOrganization(admin);
    assert.ok(twice.ok && /từ trước/.test(twice.message), "bấm hai lần ⇒ không ghi gì thêm");
    assert.ok(!(await setDomainSlug(admin, "ss-food-2")).ok, "đã xuất bản ⇒ tên miền khoá");
    const before = process.env.PLATFORM_BASE_DOMAIN;
    process.env.PLATFORM_BASE_DOMAIN = "erp.test";
    try {
      assert.equal(await organizationBaseUrl(ORG), "https://ss-food-shop.erp.test", "liên kết của tổ chức đã xuất bản đi theo tên miền con");
    } finally {
      if (before === undefined) delete process.env.PLATFORM_BASE_DOMAIN;
      else process.env.PLATFORM_BASE_DOMAIN = before;
    }
    const audits = await (await getPlatformDb()).select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, ORG), eq(schema.platformAuditLog.action, "ORG_PUBLISH")));
    assert.equal(audits.length, 1, "một dòng nhật ký nền tảng cho lượt xuất bản");
  });
  const homeAdmin = { ...admin, organization: { code: home.code, name: home.name, isHome: true } };
  await withOrganization(home.code, async () => {
    const h = await publishOrganization(homeAdmin);
    assert.ok(!h.ok, "tổ chức nhà không có bước xuất bản");
  });
  console.log("✓ Tự phục vụ · tổ chức thật: mẫu thực phẩm (NHÁP) → hộp thử → 3 luật báo nhóm → đơn chốt / sửa / huỷ đúng một tin mỗi lần + giữ / nhả hàng → chatbot (thử không ghi · web chốt thật · lời đồng ý bắt buộc · cô lập) → tên miền con → xuất bản → định tuyến");
}

export async function testSelfServiceJourney() {
  testPure();
  await cleanupOrg(ORG);
  await cleanupOrg(OTHER);
  await provisionOrganization({ code: OTHER, name: "Tổ chức khác", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: "qt@ss-other.local", name: "QT khác", password: "ToChucKhac@2026" }, source: "TEST", actor: null });
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ publishState: "DRAFT" }).where(eq(schema.platformOrganizations.code, OTHER));
  invalidateOrganizations();
  try {
    await testJourney();
  } finally {
    await cleanupOrg(ORG);
    await cleanupOrg(OTHER);
  }
}
