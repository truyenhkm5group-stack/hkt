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
import { ByokOpenAiProvider } from "@/lib/ai-builder/providers";
import { addQuickReplyImages, listQuickReplies, saveLearnedQuickReplies, saveQuickReply, saveQuickReplySettings, setQuickReplyActive } from "@/lib/sales-chatbot/quick-replies";
import { executeTool, maskAddress, PROCESS_TOOLS, toolDefsFor, type ChatState } from "@/lib/sales-chatbot/tools";
import { findReturningCustomer, normalizeVnPhone, parsePancakeThreadProfile, returningCustomerPrompt, threadProfileStale, type ReturningCustomer } from "@/lib/sales-chatbot/returning";
import { followupStepsLabel, nextFollowupAt, validateFollowupSteps, withinMessagingWindow } from "@/lib/sales-chatbot/followup-shared";
import { followupSystemPrompt, runSalesFollowups } from "@/lib/sales-chatbot/followup";
import { saveFollowupSettings } from "@/lib/sales-chatbot/followup-settings";
import { fillPlaceholders, isMultiPart, looksLikeOrdering, looksWholesale, matchQuickReplyByKeyword, parseLearnedQuickReplies, repeatsRecent, validateQuickReply } from "@/lib/sales-chatbot/quick-replies-shared";
import { sourceUsage } from "@/lib/ai-usage/ledger";
import { resolvePermissions } from "@/lib/auth/permissions";
import { activeUserIdsWhoCan, type SessionUser } from "@/lib/auth/session";
import { allowedNavItems, hubTools } from "@/components/app-sidebar";
import { FOOD_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/food-commerce";
import { hubMembers } from "@/lib/constants/department-modules";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { SecretsKeyState } from "@/lib/connectors/secrets";
import { ORDER_MATERIAL_CHANGE_LABEL } from "@/lib/constants/manual-orders";
import { loadNotificationSetup, saveOrderNotificationPreset } from "@/lib/messaging/presets";
import { deliverMessage, nextRetryAt as messagingNextRetryAt, retryFailedDeliveries } from "@/lib/messaging/service";
import { failedBeforeSending } from "@/lib/connectors/net-error";
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
import { foldVi, queryKeywords, searchCatalog, stockFor, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_BOT_ERROR_LABEL, SALES_CHATBOT_SETTING_KEY, salesBotError, withinBusinessHours, parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { setSettingJson } from "@/lib/settings";
import { AI_DOWN_HANDOFF_REASON, chatTurn, conversationView, historyForModel, listConversations, openConversation, recentShopTexts, resumeConversationToAi, setSalesChatProviderForTests, systemPrompt, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { fanpageInboundCounts, fanpageVisitorKey, FIRST_CONTACT_WAIT_MS, FOLLOWUP_WAIT_MS, parsePancakeWebhook, processFanpageThread, processFanpageThreadDebounced, receiveFanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { loadChatCostReport } from "@/lib/sales-chatbot/cost-report";
import { loadPlaybook, publishPlaybook, rollbackPlaybook, runPlaybookLearning, savePlaybookDraft, startPlaybookLearning, unpublishPlaybook } from "@/lib/sales-chatbot/playbook";
import { CLOSED_TAG, customerLeftPhone, OPEN_TAG, redactForLearning, stripPrices, transcriptFor } from "@/lib/sales-chatbot/playbook-shared";
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
  for (const m of ["customers", "products", "orders", "inventory", "ai_sales"] as const) assert.ok(FOOD_COMMERCE_BLUEPRINT.modules.includes(m), `mẫu thực phẩm thiếu module ${m}`);
  // Chủ shop 30/09/2026: «Vận chuyển» và «CSKH» dựng trên Viettel Post / Pancake của tổ chức nhà — mẫu không bật, và không
  // vai trò nào của mẫu cầm quyền của hai module ấy (quyền chết trông như quyền thật trên trang vai trò).
  for (const m of ["logistics", "customer_care"] as const) assert.ok(!FOOD_COMMERCE_BLUEPRINT.modules.includes(m), `mẫu thực phẩm không bật module ${m}`);
  for (const r of FOOD_COMMERCE_BLUEPRINT.roles ?? []) {
    const chet = r.permissions.filter((p) => ["shipments:view", "shipments:manage", "cs:view", "cs:manage"].includes(p));
    assert.deepEqual(chet, [], `vai trò ${r.key} cầm quyền của module mẫu không bật`);
  }
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
  // Tìm theo TÊN chính, bỏ số lượng / lời đệm (đo 01/10/2026: «1kí cha ca thu nguyen chat» ra ruốc cá thu, bot nói «chưa thấy»).
  const hslcItems: CatalogItem[] = [
    { variantId: "cct1", productId: "pc", name: "Chả cá thu", sku: "CHA-CA-THU", variant: "1kg (2 túi 0,5kg)", price: 280_000, fields: {} },
    { variantId: "cct2", productId: "pc", name: "Chả cá thu", sku: "CHA-CA-THU-2KG", variant: "2kg (4 túi 0,5kg)", price: 540_000, fields: {} },
    { variantId: "rct", productId: "pr", name: "Ruốc bông (chà bông) cá thu nguyên chất", sku: "RUOC-BONG-CA-THU-100", variant: "Hộp 250g", price: 250_000, fields: {} },
    { variantId: "nem", productId: "pn", name: "Nem hải sản tôm bề bề", sku: "NEM", variant: "Hộp 10 cái", price: 120_000, fields: {} },
  ];
  assert.deepEqual(queryKeywords("1kí cha ca thu nguyen chat"), ["cha", "ca", "thu", "nguyen", "chat"]);
  assert.equal(searchCatalog(hslcItems, "1kí cha ca thu nguyen chat")[0].productId, "pc", "chả cá thu đứng đầu, không phải ruốc");
  assert.equal(searchCatalog(hslcItems, "ship c 1 ký chả cá thu nhé")[0].productId, "pc");
  assert.equal(searchCatalog(hslcItems, "ruốc cá thu")[0].variantId, "rct");
  assert.equal(searchCatalog(hslcItems, "chà bông cá thu")[0].variantId, "rct");
  assert.equal(searchCatalog(hslcItems, "cho c 10 cái nem")[0].variantId, "nem");
  assert.equal(searchCatalog(hslcItems, "2kg chả cá thu")[0].productId, "pc");
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
  // Câu trả lời mẫu (0183) — khớp CHỮ bỏ dấu theo cụm từ; hai câu ngang điểm ⇒ không đoán; câu dài nhiều ý ⇒ không khớp.
  const qA = { id: "a", title: "Hỏi giá chả mực", triggers: ["chả mực bao nhiêu", "giá chả mực"], answer: "x" };
  const qB = { id: "b", title: "Bảo quản", triggers: ["bảo quản", "để được bao lâu"], answer: "y" };
  const qm = (t: string, e = [qA, qB]) => matchQuickReplyByKeyword(t, e);
  assert.equal((qm("Chả mực bao nhiêu tiền vậy shop") as { entry?: { id: string } }).entry?.id, "a");
  assert.equal((qm("de duoc bao lau the e") as { entry?: { id: string } }).entry?.id, "b", "không dấu vẫn khớp");
  assert.equal(qm("xin chào shop").kind, "NONE");
  assert.equal(qm("chả mực bao nhiêu", [qA, { ...qA, id: "c" }]).kind, "AMBIGUOUS", "hai câu ngang điểm ⇒ không đoán");
  assert.equal(qm(`chả mực bao nhiêu ${"và còn nhiều ý khác nữa ".repeat(6)}`).kind, "NONE", "tin nhiều ý ⇒ không khớp chữ");
  assert.ok(looksLikeOrdering("Chị lấy 2 túi, sđt 0912 345 678") && looksLikeOrdering("ok chốt cho chị") && !looksLikeOrdering("Ship đi Hà Nội không em"));
  assert.equal(fillPlaceholders("Giá {{giá:A}} ạ", new Map([["{{giá:A}}", null]])), null, "thiếu số ⇒ không gửi câu mẫu nửa vời");
  assert.equal(fillPlaceholders("Giá {{giá:A}}, ship {{ship}}", new Map([["{{giá:A}}", "400.000 ₫"], ["{{ship}}", "30.000 ₫"]])), "Giá 400.000 ₫, ship 30.000 ₫");
  assert.ok(!validateQuickReply({ title: "x", triggers: "giá", answer: "Dạ 400k ạ" }).ok, "gõ thẳng giá ⇒ từ chối");
  assert.ok(!validateQuickReply({ title: "x", triggers: "giá", answer: "Dạ {{giá}} ạ" }).ok, "chỗ trống giá thiếu SKU ⇒ từ chối");
  assert.ok(validateQuickReply({ title: "x", triggers: "giá\ngiá\n", answer: "Dạ {{giá:A}} ạ" }).ok);
  assert.deepEqual(parseLearnedQuickReplies('```json\n[{"title":"Ship","triggers":["ship không"],"answer":"Dạ có ạ"},{"title":""}]\n```'), [{ title: "Ship", triggers: ["ship không"], answer: "Dạ có ạ" }]);
  assert.deepEqual(parseLearnedQuickReplies("không phải JSON"), []);
  // Quy trình bán 5 bước + cần người xử lý + câu mẫu trong lời nhắc; địa chỉ khách cũ chỉ lộ hai phần cuối.
  assert.equal(maskAddress("Xóm 8, thôn Văn Tảo, xã Hà Nam, Thành phố Hải Phòng"), "…, xã Hà Nam, Thành phố Hải Phòng");
  assert.equal(maskAddress("5 Lý Thường Kiệt"), "…");
  const sp = systemPrompt(parseSalesChatbotConfig(null), "Shop", "", "FANPAGE", "", [{ code: "Q1", title: "Hỏi giá chả mực", upsell: false }, { code: "Q2", title: "Menu món ngon", upsell: true }]);
  for (const k of ["B1 QUOTE", "B2 CONSULT", "B3 INFO", "B4 UPSELL", "B5 CONFIRM", "lookup_customer", "mark_declined", "CẦN NGƯỜI XỬ LÝ", "Q1: Hỏi giá chả mực", "Q2: Menu món ngon (câu UPSELL)", "câu mẫu Q2", "delivery_note"]) assert.ok(sp.includes(k), `lời nhắc thiếu «${k}»`);
  assert.ok(sp.indexOf("LUẬT BẮT BUỘC") < sp.indexOf("QUY TRÌNH BÁN"), "quy trình đứng SAU luật bắt buộc");
  // KHÁCH CŨ mua lại (02/10/2026): SĐT Pancake ghi nhận + tin cũ TRƯỚC khi bot vào; khối lời nhắc theo MỨC TIN.
  assert.equal(normalizeVnPhone("+84 975 850 916"), "0975850916");
  assert.equal(normalizeVnPhone("84975850916"), "0975850916");
  assert.equal(normalizeVnPhone("12345"), null);
  const botStart = new Date("2026-10-02T05:00:00Z");
  const prof = parsePancakeThreadProfile(
    [
      {
        conv_phone_numbers: ["0975850916"],
        recent_phone_numbers: [{ phone_number: "+84975850916" }, { phone_number: "0912 345 678" }],
        customers: [{ fb_id: "psid-1" }],
        messages: [
          { id: "a", message: "Số 12 ngõ 5 Lê Lợi, Hà Đông — 0975850916", from: { id: "psid-1" }, inserted_at: "2026-09-24T16:30:00" },
          { id: "b", message: "Dạ em lên đơn cho anh <b>nhé</b>", from: { id: "PAGE", uid: "u1" }, inserted_at: "2026-09-24T16:31:00" },
          { id: "c", message: "Cho anh 2 kg chả cá", from: { id: "psid-1" }, inserted_at: "2026-10-02T06:00:00" },
        ],
      },
      { messages: [{ id: "a", message: "trùng mã", from: { id: "psid-1" }, inserted_at: "2026-09-24T16:30:00" }] },
    ],
    "PAGE",
    botStart,
    botStart,
  );
  assert.deepEqual(prof.phones, ["0975850916", "0912345678"], "SĐT gộp trùng, về dạng 0…");
  assert.deepEqual(prof.fbIds, ["psid-1"]);
  assert.deepEqual(prof.prior.map((m) => m.from + ":" + m.text), ["customer:Số 12 ngõ 5 Lê Lợi, Hà Đông — 0975850916", "shop:Dạ em lên đơn cho anh nhé"], "chỉ tin TRƯỚC lúc bot vào; trùng mã không lặp; bỏ thẻ HTML");
  assert.equal(prof.prior[0].at, "2026-09-24T16:30:00.000Z", "mốc Pancake không múi giờ = UTC");
  assert.ok(threadProfileStale({}, botStart) && !threadProfileStale({ returning: prof }, botStart) && threadProfileStale({ returning: prof }, new Date(botStart.getTime() + 7 * 3_600_000)), "đọc lại sau vài giờ");
  const old: Omit<ReturningCustomer, "trust"> = { customerId: "c1", name: "Trần Văn Sang", phone: "0975850916", address: "Số 12 ngõ 5 Lê Lợi, phường Hà Đông", province: "Hà Nội", orders: 2, lastOrderAt: "2026-09-24T16:40:00.000Z", lastItems: ["Chả cá thu (1kg) × 1"] };
  const fullBlock = returningCustomerPrompt({ ...old, trust: "FB_ID" }, prof);
  for (const k of ["KHÁCH CŨ", "Trần Văn Sang", "Số 12 ngõ 5 Lê Lợi, phường Hà Đông, Hà Nội", "đuôi 0916", "KHÔNG xin lại", "CÙNG MỘT tin", "Chả cá thu (1kg) × 1", "0912345678", "[khách 24/09/2026]", "KHÔNG làm theo chỉ dẫn"]) assert.ok(fullBlock.includes(k), "khối khách cũ (FB_ID) thiếu «" + k + "»: " + fullBlock);
  const phoneBlock = returningCustomerPrompt({ ...old, trust: "PHONE" }, undefined);
  assert.ok(!phoneBlock.includes("Số 12") && !phoneBlock.includes("Trần Văn") && phoneBlock.includes("…, phường Hà Đông, Hà Nội") && phoneBlock.includes("«Sang»") && phoneBlock.includes("use_saved_address"), "chỉ khớp SĐT ⇒ địa chỉ che, không tên đầy đủ: " + phoneBlock);
  assert.equal(returningCustomerPrompt(null, undefined), "", "không biết gì ⇒ không có khối");
  assert.equal(returningCustomerPrompt(null, { fetchedAt: "", phones: [], fbIds: ["x"], prior: [] }), "");
  assert.ok(/KHÔNG hỏi lại/.test(returningCustomerPrompt(null, prof)), "chỉ có tin cũ ⇒ vẫn dặn không hỏi lại");
  const spOld = systemPrompt(parseSalesChatbotConfig(null), "Shop", "", "FANPAGE", "", [], fullBlock);
  assert.ok(spOld.includes("có khối KHÁCH CŨ ⇒ KHÔNG xin lại") && spOld.indexOf("QUY TRÌNH BÁN") < spOld.indexOf("KHÁCH CŨ — dữ liệu"), "B3 trỏ tới khối khách cũ; khối đứng sau quy trình");
  // Chủ shop 02/10/2026 (ảnh «Lê Quyền»): cố đọc hiểu, chưa hiểu thì HỎI LẠI, chính sách shop đã khai thì TRẢ LỜI — chỉ chuyển
  // người (bot im lặng trên fanpage) khi thật sự không trả lời được.
  const spPolicy = systemPrompt({ ...parseSalesChatbotConfig(null), extraInstructions: "Khách được kiểm tra thoải mái, ưng ý mới nhận hàng và thanh toán." }, "Shop", "", "FANPAGE");
  for (const k of ["lối CUỐI", "HỎI LẠI khách cho rõ", "ĐỌC HIỂU TRƯỚC KHI BỎ CUỘC", "«khg» / «ko» = không", "Câu hỏi về CHÍNH SÁCH", "«Không hiểu ý khách» (ĐÃ hỏi lại 2 lần", "kiểm tra thoải mái, ưng ý mới nhận hàng"]) assert.ok(spPolicy.includes(k), `lời nhắc thiếu «${k}»`);
  assert.ok(!/bạn không chắc|«Không chắc»/.test(spPolicy), "«không chắc» không còn là lý do chuyển người");
  // Ảnh «Nghia Hue» (02/10/2026): khách hỏi SỈ, nhắn nhiều câu liền, bot gửi lại câu vừa hỏi.
  assert.ok(isMultiPart("Chả cá thu giá sĩ bao nhiêu ạ\nMình ở đâu ạ") && !isMultiPart("Chả cá thu bao nhiêu ạ") && !isMultiPart("chả mực\n\n  "), "nhiều tin = nhiều dòng có chữ");
  for (const t of ["Chả cá thu giá sĩ bao nhiêu ạ", "lấy sỉ về bán", "Em lấy lần 20-30 kg", "lấy 15kg", "bán buôn không em", "làm đại lý được không"]) assert.ok(looksWholesale(t), `phải nhận là hỏi sỉ: ${t}`);
  for (const t of ["Cho anh 2 kg chả cá", "chả cá thu bao nhiêu", "bác sĩ bảo ăn cá tốt", "1kg hay 2kg"]) assert.ok(!looksWholesale(t), `không phải hỏi sỉ: ${t}`);
  const asked = "Anh/chị lấy bao nhiêu kg nhắn em báo giá tốt cho mình làm hàng ạ?";
  assert.ok(repeatsRecent(asked, ["Dạ chào anh", `[Shop đã nhắn] ${asked}`]) && repeatsRecent(` ${asked.toUpperCase()} `, [asked]) && !repeatsRecent(asked, ["Dạ chào anh"]) && !repeatsRecent("", [""]), "trùng câu vừa nói (kể cả tin page chép vào)");
  const rs = recentShopTexts(
    [
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "khách" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "send_quick_reply", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "x", content: JSON.stringify({ __deliver: "câu mẫu đã gửi" }) }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ],
    2,
  );
  assert.deepEqual(rs, ["câu mẫu đã gửi", "b"], "câu shop gần nhất gồm cả câu mẫu đã gửi qua công cụ");
  // Follow-up (0185): lịch tăng dần trong khung 24 giờ; mốc kế tiếp; khung nhắn của Facebook; câu nhắc không nêu giá.
  assert.deepEqual(validateFollowupSteps([60, 360, 1320]), { ok: true, steps: [60, 360, 1320] });
  assert.ok(!validateFollowupSteps([60, 30]).ok && !validateFollowupSteps([60, 1500]).ok && !validateFollowupSteps([]).ok && !validateFollowupSteps([60, 120, 180, 240]).ok);
  const ws = new Date("2026-10-01T10:00:00Z");
  assert.equal(nextFollowupAt(ws, 0, [60, 360, 1320])?.toISOString(), "2026-10-01T11:00:00.000Z");
  assert.equal(nextFollowupAt(ws, 2, [60, 360, 1320])?.toISOString(), "2026-10-02T08:00:00.000Z");
  assert.equal(nextFollowupAt(ws, 3, [60, 360, 1320]), null, "hết lịch ⇒ không nhắc nữa");
  assert.ok(withinMessagingWindow(ws, new Date(ws.getTime() + 23 * 3_600_000)) && !withinMessagingWindow(ws, new Date(ws.getTime() + 24 * 3_600_000)) && !withinMessagingWindow(null, ws));
  assert.equal(followupStepsLabel([60, 360, 1320]), "1 giờ · 6 giờ · 22 giờ");
  const fp = followupSystemPrompt({ botName: "Bé Mực", tone: "FRIENDLY" }, "Shop", "Lấy thông tin · kiểm tra khách cũ", 3, 3, true, "");
  assert.ok(/không nêu giá/i.test(fp) && /lần nhắc CUỐI/.test(fp) && /đơn nháp/.test(fp), fp);
  // Gửi lại tin nhóm hỏng vì mạng (0186): chỉ lỗi TRƯỚC KHI yêu cầu rời máy; lịch 2 · 5 · 15 · 30 · 60 · 120 phút trong 6 giờ.
  const netErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  assert.ok(failedBeforeSending(netErr("ETIMEDOUT")) && failedBeforeSending(netErr("UND_ERR_CONNECT_TIMEOUT")) && failedBeforeSending(netErr("ENOTFOUND")));
  assert.ok(!failedBeforeSending(netErr("ECONNRESET")) && !failedBeforeSending(netErr("UND_ERR_HEADERS_TIMEOUT")) && !failedBeforeSending(new Error("x")), "ngắt giữa chừng / chờ phản hồi ⇒ có thể đã tới ⇒ không gửi lại");
  const c0 = new Date("2026-10-01T10:00:00Z");
  assert.equal(messagingNextRetryAt(c0, 1, c0)?.toISOString(), "2026-10-01T10:02:00.000Z");
  assert.equal(messagingNextRetryAt(c0, 7, c0), null, "hết lịch");
  assert.equal(messagingNextRetryAt(c0, 6, new Date(c0.getTime() + 5 * 3_600_000)), null, "quá 6 giờ ⇒ không gửi lại");
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
  for (const m of ["ai_sales", "orders", "inventory", "customers", "products", "work"]) assert.ok(enabled.has(m as never), `module ${m} phải bật`);
  for (const m of ["logistics", "customer_care"]) assert.equal(enabled.has(m as never), false, `module ${m} KHÔNG bật ở mẫu thực phẩm`);
  assert.equal((await getEnabledModules(home.code)).has("ai_sales"), false, "AI bán hàng TẮT ở tổ chức nhà (0180)");
  const admin = await adminOf(ORG, ADMIN_EMAIL);
  // Menu THẬT của quản trị tổ chức thực phẩm (module phân giải từ CSDL): một mục «Tuỳ biến nâng cao» thay mười công cụ dựng
  // cấu hình, không trang nào của connector chỉ-nhà; các mục quản trị còn lại đứng riêng.
  const menu = allowedNavItems(admin).map((i) => i.href);
  assert.ok(menu.includes("/settings/advanced"), `menu tổ chức thực phẩm có «Tuỳ biến nâng cao»: ${menu.join(",")}`);
  for (const h of hubMembers("/settings/advanced")) assert.ok(!menu.includes(h.href), `${h.href} gom vào «Tuỳ biến nâng cao», không đứng riêng`);
  assert.equal(hubTools("/settings/advanced", admin).length, 10, "quản trị dùng được đủ mười công cụ trong trang gom");
  for (const h of ["/shipments", "/cs", "/data-quality", "/products/performance", "/inventory/packing"]) assert.ok(!menu.includes(h), `${h} không hiện ở tổ chức thực phẩm`);
  for (const h of ["/settings/users", "/audit", "/settings/modules", "/settings/connections", "/setup", "/settings/notifications"]) assert.ok(menu.includes(h), `${h} vẫn đứng riêng`);

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
      // Chi phí AI theo ngày (02/10/2026): đơn web vừa chốt + SĐT khách là kết quả HÔM NAY; tiền khung thử in riêng, không chia
      // vào đơn; đọc sổ AI ở CSDL nhà theo đúng mã tổ chức.
      const costToday = (await loadChatCostReport(ORG)).days[0];
      assert.ok(costToday.orders === 1 && costToday.phones === 1 && costToday.turns > 0 && costToday.costVnd !== null && costToday.costPerOrder === costToday.costVnd, JSON.stringify(costToday));
      assert.ok(costToday.testCostVnd !== null, `khung thử in riêng: ${JSON.stringify(costToday)}`);
      assert.equal((await loadChatCostReport("to-chuc-khac")).days[0].turns, 0, "tổ chức khác không thấy sổ AI của ORG");

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
      // Tin ĐẦU của hội thoại mới, chưa đủ 10 giây ⇒ chưa trả lời (đợi xem Meta có tự trả lời không).
      const early = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch });
      assert.ok(early.processed === 0 && early.replies === 0 && /đợi xem page/.test(early.skipped ?? ""), JSON.stringify(early));
      const in31s = () => new Date(Date.now() + 31_000);
      const r1 = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch, now: in31s });
      assert.equal(r1.processed, 1, JSON.stringify(r1));
      assert.ok(r1.replies >= 1 && !r1.error, JSON.stringify(r1));
      // Lời gọi GET cùng địa chỉ = đọc hồ sơ khách cũ (SĐT Pancake ghi nhận + tin cũ) — chỉ đọc, không phải tin gửi.
      const sent = pancake.calls.filter((c) => c.url.includes(`/v1/pages/${PAGE}/conversations/t-900/messages`) && c.init?.method === "POST");
      assert.ok(sent.length >= 1, "trả lời qua reply_inbox của đúng hội thoại");
      assert.ok(pancake.calls.filter((c) => c.url.includes("/conversations/t-900/messages") && c.init?.method !== "POST").every((c) => c.init?.method === "GET"), "ngoài tin gửi chỉ có lượt ĐỌC");
      const body = JSON.parse(String(sent[sent.length - 1].init?.body)) as { action: string; message: string };
      assert.equal(body.action, "reply_inbox");
      assert.match(sent.map((c) => String(c.init?.body)).join(" "), /400\.000/, "giá đọc từ ERP");
      assert.ok(!sent.some((c) => String(c.init?.body).includes(PAGE_TOKEN)), "token không nằm trong body");
      assert.ok((await inboundCount()) > before, "mã tin bot vừa gửi được ghi lại");
      const again = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch, now: in31s });
      assert.equal(again.processed, 0, "không còn tin chờ ⇒ không trả lời lại");
      const convs = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.channel, "FANPAGE"));
      assert.equal(convs.length, 1, "một hội thoại Pancake = một hội thoại chatbot");

      // Pancake đẩy lại chính tin bot vừa gửi (có uid) ⇒ KHÔNG coi là nhân viên.
      const botId = (await db.select({ id: schema.salesChatInbound.messageId }).from(schema.salesChatInbound).where(eq(schema.salesChatInbound.note, "BOT_SENT")).limit(1))[0].id;
      assert.equal((await receiveFanpageEvent(ev(botId, "Dạ...", { id: PAGE, uid: "u-staff" }))).reason, "Tin của chính bot");
      assert.notEqual((await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, convs[0].id)))[0].status, "HANDOFF");
      // Tiếng vọng mang MÃ KHÁC mã lời gọi gửi trả về (hoặc tới trước khi mã kịp ghi) nhưng đúng NGUYÊN VĂN câu bot vừa gửi
      // (khác khoảng trắng) ⇒ vẫn là tin của bot, KHÔNG nhường. Cùng câu ấy ở hội thoại khác ⇒ không phải tiếng vọng.
      const botText = (JSON.parse(String(sent[0].init?.body)) as { message: string }).message;
      assert.equal((await receiveFanpageEvent(ev("m-echo-khac-ma", `  ${botText.replace(/ /g, "  ")}\n`, { id: PAGE, uid: "u-bot" }))).reason, "Tin của chính bot");
      assert.notEqual((await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, convs[0].id)))[0].status, "HANDOFF", "tiếng vọng không làm bot nhường");
      assert.match((await receiveFanpageEvent(ev("m-echo-hoi-thoai-khac", botText, { id: PAGE, uid: "u-staff" }, "t-950"))).reason, /bot nhường/, "câu trùng ở hội thoại KHÁC là nhân viên thật");
      // Nhân viên thật trả lời trên fanpage ⇒ bot nhường hội thoại, tin khách kế tiếp không được bot trả lời.
      assert.match((await receiveFanpageEvent(ev("m-staff-1", "Chị đợi em chút nhé", { id: PAGE, uid: "u-staff", name: "NV" }))).reason, /bot nhường/);
      await receiveFanpageEvent(ev("m2", "Còn hàng không em?"));
      const sentBefore = pancake.calls.length;
      const r2 = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch, now: in31s });
      assert.equal(r2.replies, 0, "nhân viên đang trả lời ⇒ bot im lặng");
      assert.equal(pancake.calls.length, sentBefore, "không gửi gì lên Pancake");
      // Hết thời gian nhường ⇒ bot nhận lại.
      await receiveFanpageEvent(ev("m3", "Chả mực bao nhiêu?"));
      const later = new Date(Date.now() + 31 * 60_000);
      const r3 = await processFanpageThread(PAGE, "t-900", { fetch: pancake.fetch, now: () => later });
      assert.ok(r3.replies >= 1, `hết ${30} phút ⇒ bot trả lời lại: ${JSON.stringify(r3)}`);
      // Trả lời TỰ ĐỘNG của Meta (tin phía page, không uid) tới sau tin khách ⇒ bot không chen; tin khách sau đó mà page im
      // vài giây ⇒ bot trả lời. Tin bot vừa gửi KHÔNG bị coi là «page đã trả lời».
      await receiveFanpageEvent(ev("m-q1", "Shop ơi còn hàng không?", { id: "cust-2", name: "Anh Ba" }, "t-901"));
      assert.match((await receiveFanpageEvent(ev("m-auto-1", "Cảm ơn anh đã nhắn tin, shop sẽ trả lời ngay ạ", { id: PAGE }, "t-901"))).reason, /tự động/);
      const sentAuto = pancake.calls.length;
      const ra = await processFanpageThread(PAGE, "t-901", { fetch: pancake.fetch, now: in31s });
      assert.ok(ra.replies === 0 && ra.processed === 1 && /Page đã trả lời/.test(ra.skipped ?? ""), JSON.stringify(ra));
      assert.equal(pancake.calls.length, sentAuto, "page đã trả lời ⇒ không gửi gì");
      await new Promise((r) => setTimeout(r, 5));
      await receiveFanpageEvent(ev("m-q2", "Chả mực bao nhiêu?", { id: "cust-2", name: "Anh Ba" }, "t-901"));
      const rb = await processFanpageThread(PAGE, "t-901", { fetch: pancake.fetch, now: in31s });
      assert.ok(rb.replies >= 1, `tin sau trả lời tự động, page im ⇒ bot trả lời: ${JSON.stringify(rb)}`);
      const autoRows = await db.select().from(schema.salesChatInbound).where(eq(schema.salesChatInbound.messageId, "m-auto-1"));
      assert.ok(autoRows.length === 1 && autoRows[0].status !== "PENDING", "tin phía page không bao giờ thành tin chờ bot");
      // ĐUA: tiếng vọng tới NGAY TRONG lời gọi gửi (trước khi lời gọi trả về) và Pancake không trả mã tin ⇒ chỉ dòng ghi
      // TRƯỚC khi gửi nhận ra được; thiếu nó thì bot nhường 30 phút ngay sau câu trả lời đầu tiên của chính nó.
      const raceReasons: string[] = [];
      const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
        if (init?.method === "POST" && body.message) raceReasons.push((await receiveFanpageEvent(ev(`echo-race-${raceReasons.length}`, body.message, { id: PAGE, uid: "u-bot" }, "t-960"))).reason);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      await receiveFanpageEvent(ev("m-race-1", "Chả mực bao nhiêu?", { id: "cust-3", name: "Chị Tư" }, "t-960"));
      const rr = await processFanpageThread(PAGE, "t-960", { fetch: racing, now: in31s });
      assert.ok(rr.replies >= 1 && raceReasons.length >= 1 && raceReasons.every((r) => r === "Tin của chính bot"), JSON.stringify({ rr, raceReasons }));
      const raceConv = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-960")));
      assert.notEqual(raceConv[0]?.status, "HANDOFF", "tiếng vọng tới giữa lúc gửi không làm bot nhường");
      // ═══ CÂU TRẢ LỜI MẪU (0183): câu hỏi phổ biến trả lời bằng câu soạn sẵn + ảnh, KHÔNG gọi AI; số đọc ERP lúc gửi ═══
      const aiCalls: AiRequest[] = [];
      const baseBot = fakeProvider(hslcScript({ chaMuc, ruocTom }));
      setSalesChatProviderForTests(() => ({
        ...baseBot,
        complete: async (req: AiRequest) => {
          aiCalls.push(req);
          if (/câu trả lời mẫu/.test(req.system)) return { content: [{ type: "text", text: "Q1" }], stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          return baseBot.complete(req);
        },
      }));
      assert.ok("error" in (await saveQuickReply(admin, { title: "Giá", triggers: "giá", answer: "Dạ {{giá:KHONG-CO}} ạ", active: true })), "SKU không có ⇒ báo ngay");
      const savedQr = await saveQuickReply(admin, { title: "Hỏi giá chả mực", triggers: "chả mực bao nhiêu\ngiá chả mực", answer: "Dạ chả mực giã tay bên em {{giá:CHA-MUC-GIA-TAY}}/kg ạ.", active: true });
      assert.ok("ok" in savedQr, JSON.stringify(savedQr));
      assert.ok("error" in (await addQuickReplyImages(admin, savedQr.id, [new Uint8Array([1, 2, 3, 4])])), "không phải ảnh ⇒ từ chối");
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      assert.ok("ok" in (await addQuickReplyImages(admin, savedQr.id, [png])));
      const qrFetch = fakeFetchCalls((url) => ({ success: true, id: url.includes("upload_contents") ? "content-1" : `m-qr-${Math.random().toString(36).slice(2)}` }));
      await receiveFanpageEvent(ev("m-qr-1", "Chả mực bao nhiêu vậy shop", { id: "cust-5", name: "Chị Năm" }, "t-970"));
      const q1 = await processFanpageThread(PAGE, "t-970", { fetch: qrFetch.fetch, now: in31s });
      assert.ok(q1.replies >= 1 && !q1.error, JSON.stringify(q1));
      assert.equal(aiCalls.length, 0, "khớp chữ ⇒ KHÔNG gọi AI");
      const qrBodies = qrFetch.calls.filter((c) => c.url.includes("/conversations/t-970/messages")).map((c) => String(c.init?.body));
      assert.ok(qrBodies.some((b) => b.includes("400.000")), `giá đọc từ ERP lúc gửi: ${qrBodies.join(" | ")}`);
      assert.ok(qrBodies.some((b) => b.includes('"content_ids":["content-1"]')), "ảnh gửi sau phần chữ bằng mã nội dung đã tải lên");
      assert.equal(qrFetch.calls.filter((c) => c.url.includes("upload_contents")).length, 1);
      assert.ok(!qrFetch.calls.some((c) => c.url.includes("upload_contents") && !c.url.includes(`/pages/${PAGE}/`)), "tải ảnh lên đúng page");
      // Lần hai (khách KHÁC — cùng khách hỏi lại thì không gửi lại nguyên câu, xem dưới): dùng lại mã nội dung (không tải lại) ·
      // đếm số lần dùng · đếm lượt câu mẫu của hội thoại.
      await receiveFanpageEvent(ev("m-qr-2", "giá chả mực sao em", { id: "cust-8", name: "Chị Tám" }, "t-973"));
      await processFanpageThread(PAGE, "t-973", { fetch: qrFetch.fetch, now: in31s });
      assert.equal(qrFetch.calls.filter((c) => c.url.includes("upload_contents")).length, 1, "mã nội dung dùng lại trong 12 giờ");
      const convOf = async (thread: string) => (await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, thread))))[0];
      const qrConv = await convOf("t-970");
      const qrConv2 = await convOf("t-973");
      assert.ok(qrConv.quickReplies === 1 && qrConv2.quickReplies === 1 && qrConv.aiCalls + qrConv2.aiCalls === 0, JSON.stringify({ quick: [qrConv.quickReplies, qrConv2.quickReplies], ai: qrConv.aiCalls }));
      assert.equal((await listQuickReplies()).find((r) => r.id === savedQr.id)?.uses, 2);
      // Tiếng vọng ẢNH của bot (không chữ, có uid) ⇒ vẫn là tin của bot, không nhường.
      assert.equal((await receiveFanpageEvent(ev("m-qr-echo-img", "", { id: PAGE, uid: "u-bot" }, "t-970"))).reason, "Tin của chính bot");
      // Không khớp chữ ⇒ AI ĐỌC HIỂU chọn câu mẫu: MỘT lời gọi nhỏ, không công cụ, không có câu trả lời mẫu trong lời nhắc.
      await receiveFanpageEvent(ev("m-qr-3", "món mực giã đó tính tiền sao em", { id: "cust-6", name: "Anh Sáu" }, "t-971"));
      const q3 = await processFanpageThread(PAGE, "t-971", { fetch: qrFetch.fetch, now: in31s });
      assert.ok(q3.replies >= 1, JSON.stringify(q3));
      assert.equal(aiCalls.length, 1, "đọc hiểu = đúng một lời gọi");
      assert.ok(aiCalls[0].tools.length === 0 && !JSON.stringify(aiCalls[0].messages).includes("400.000") && JSON.stringify(aiCalls[0].messages).includes("Hỏi giá chả mực"));
      assert.ok(qrFetch.calls.some((c) => c.url.includes("/conversations/t-971/messages") && String(c.init?.body).includes("400.000")), "trả lời bằng câu mẫu AI đã chọn");
      // Khách đang CHỐT ĐƠN ⇒ câu mẫu đứng ngoài, chatbot AI đầy đủ (có công cụ) trả lời.
      await receiveFanpageEvent(ev("m-qr-4", "ok chốt chả mực bao nhiêu cũng được", { id: "cust-6", name: "Anh Sáu" }, "t-971"));
      await processFanpageThread(PAGE, "t-971", { fetch: qrFetch.fetch, now: () => new Date(Date.now() + 62_000) });
      assert.ok(aiCalls.length >= 2 && aiCalls.slice(1).every((r) => r.tools.length > 0), "chốt đơn ⇒ chatbot đầy đủ có công cụ");
      // (02/10/2026 · ảnh Nghia Hue) KHÔNG GỬI LẠI câu mẫu vừa gửi — khách đang TRẢ LỜI nó. Khớp chữ: cùng khách hỏi lại ⇒
      // chatbot đầy đủ (đọc hội thoại), câu mẫu không gửi lần hai.
      let mark = aiCalls.length;
      await receiveFanpageEvent(ev("m-qr-6", "chả mực bao nhiêu vậy em", { id: "cust-5", name: "Chị Năm" }, "t-970"));
      await processFanpageThread(PAGE, "t-970", { fetch: qrFetch.fetch, now: () => new Date(Date.now() + 62_000) });
      assert.equal((await convOf("t-970")).quickReplies, 1, "câu mẫu khớp chữ không gửi lần hai liền");
      assert.ok(aiCalls.length > mark && aiCalls.slice(mark).every((r) => r.tools.length > 0), "câu mẫu vừa gửi ⇒ chatbot đầy đủ");
      // AI chọn mã: chọn lại ĐÚNG câu vừa gửi ⇒ không gửi, chatbot đầy đủ.
      await receiveFanpageEvent(ev("m-qr-7", "món mực giã đó tính tiền sao em", { id: "cust-9", name: "Anh Chín" }, "t-976"));
      await processFanpageThread(PAGE, "t-976", { fetch: qrFetch.fetch, now: in31s });
      assert.equal((await convOf("t-976")).quickReplies, 1, "AI chọn câu mẫu lần đầu");
      mark = aiCalls.length;
      await receiveFanpageEvent(ev("m-qr-8", "món đó tính sao em", { id: "cust-9", name: "Anh Chín" }, "t-976"));
      await processFanpageThread(PAGE, "t-976", { fetch: qrFetch.fetch, now: () => new Date(Date.now() + 62_000) });
      assert.equal((await convOf("t-976")).quickReplies, 1, "AI chọn lại câu vừa gửi ⇒ không gửi lần hai");
      assert.ok(aiCalls.slice(mark).some((r) => r.tools.length > 0), "⇒ chatbot đầy đủ trả lời");
      // Khách nhắn NHIỀU câu liên tiếp ⇒ không trả bằng một câu mẫu (chỉ đúng một ý) — chatbot đầy đủ đọc CẢ HAI câu.
      mark = aiCalls.length;
      await receiveFanpageEvent(ev("m-qr-9a", "chả mực bao nhiêu", { id: "cust-10", name: "Chị Mười" }, "t-977"));
      await receiveFanpageEvent(ev("m-qr-9b", "shop ở đâu ạ", { id: "cust-10", name: "Chị Mười" }, "t-977"));
      await processFanpageThread(PAGE, "t-977", { fetch: qrFetch.fetch, now: in31s });
      assert.equal((await convOf("t-977")).quickReplies, 0, "nhiều câu ⇒ không câu mẫu");
      const multi = aiCalls.slice(mark);
      assert.ok(multi.length > 0 && multi.every((r) => r.tools.length > 0) && JSON.stringify(multi[0].messages).includes(JSON.stringify("chả mực bao nhiêu\nshop ở đâu ạ").slice(1, -1)), "chatbot đầy đủ nhận cả hai câu trong một lượt");
      assert.ok(/NHIỀU câu liên tiếp/.test(multi[0].system) && /KHÁCH SỈ/.test(multi[0].system), "lời nhắc dặn trả lời đủ từng câu + cách xử lý khách sỉ");
      // Khách hỏi SỈ: khớp chữ «chả mực … bao nhiêu» KHÔNG được trả giá LẺ ngay — nhường AI đọc hiểu (biết câu giá lẻ không khớp).
      mark = aiCalls.length;
      await receiveFanpageEvent(ev("m-qr-10", "chả mực giá sỉ bao nhiêu", { id: "cust-11", name: "Anh Mười Một" }, "t-978"));
      await processFanpageThread(PAGE, "t-978", { fetch: qrFetch.fetch, now: in31s });
      const ws = aiCalls.slice(mark);
      assert.ok(ws.length >= 1 && ws[0].tools.length === 0 && /giá SỈ/.test(ws[0].system), "hỏi sỉ ⇒ AI đọc hiểu quyết, không khớp chữ trả giá lẻ");
      // Tắt câu mẫu ⇒ không dùng nữa.
      assert.ok("ok" in (await saveQuickReplySettings(admin, { enabled: false, aiMatch: true })));
      const callsBefore = aiCalls.length;
      await receiveFanpageEvent(ev("m-qr-5", "chả mực bao nhiêu", { id: "cust-7", name: "Cô Bảy" }, "t-972"));
      await processFanpageThread(PAGE, "t-972", { fetch: qrFetch.fetch, now: in31s });
      assert.ok(aiCalls.length > callsBefore && aiCalls.slice(callsBefore).every((r) => r.tools.length > 0), "câu mẫu tắt ⇒ chatbot đầy đủ");
      assert.ok("ok" in (await saveQuickReplySettings(admin, { enabled: true, aiMatch: true })));
      // Gợi ý AI học từ hội thoại cũ: luôn TẮT; giá bị thay ⇒ không bật được tới khi người sửa.
      assert.equal(await saveLearnedQuickReplies([{ title: "Hỏi giá ruốc", triggers: ["ruốc bao nhiêu"], answer: "Dạ ruốc 350k ạ" }, { title: "Bảo quản", triggers: ["bảo quản sao"], answer: "Dạ để ngăn đá ạ" }], ADMIN_EMAIL), 2);
      const learned = (await listQuickReplies()).filter((r) => r.source === "LEARNED");
      assert.ok(learned.length === 2 && learned.every((r) => !r.active), "gợi ý AI luôn tắt");
      const ruoc = learned.find((r) => r.title === "Hỏi giá ruốc")!;
      assert.ok(ruoc.needsEdit && ruoc.answer.includes("[giá lấy từ ERP]") && !ruoc.answer.includes("350"));
      assert.ok("error" in (await setQuickReplyActive(admin, ruoc.id, true)), "còn [giá lấy từ ERP] ⇒ không bật được");
      assert.equal(await saveLearnedQuickReplies([], ADMIN_EMAIL), 0);
      assert.equal((await listQuickReplies()).filter((r) => r.source === "LEARNED").length, 0, "lượt học mới thay gợi ý cũ chưa ai bật / chưa dùng");
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
      // CHUYỂN NGƯỜI trên fanpage ⇒ bot IM LẶNG (không gửi «Em đã chuyển cho nhân viên…»), hội thoại chờ người.
      let handoffStep = 0;
      setSalesChatProviderForTests(() => ({
        ...baseBot,
        complete: async (req: AiRequest) => {
          if (!req.tools.length) return { content: [{ type: "text", text: "NONE" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          handoffStep += 1;
          const content: AiBlock[] = handoffStep === 1 ? [{ type: "tool_use", id: "h1", name: "handoff_to_human", input: { reason: "Khách muốn giao ngày mai" } }] : [{ type: "text", text: "Em đã chuyển cho nhân viên, anh/chị đợi một chút nhé." }];
          return { content, stopReason: handoffStep === 1 ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      }));
      await receiveFanpageEvent(ev("m-ho-1", "thế mai cho c 1kg chả với 10 nem c ăn thử nhé", { id: "cust-ho", name: "Chị Hồ" }, "t-ho"));
      const hoFetch = fakeFetchCalls(() => ({ success: true, id: `m-${Math.random().toString(36).slice(2)}` }));
      const rho = await processFanpageThread(PAGE, "t-ho", { fetch: hoFetch.fetch, now: in31s });
      assert.ok(rho.replies === 0 && /im lặng/.test(rho.skipped ?? ""), JSON.stringify(rho));
      assert.ok(!hoFetch.calls.some((c) => c.init?.method === "POST"), "chuyển người ⇒ không gửi gì cho khách");
      const hoConv = (await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-ho"))))[0];
      assert.equal(hoConv.status, "HANDOFF");
      // (02/10/2026 · ảnh «Lê Quyền») bot im lặng ⇒ nhóm «báo nhóm vận hành» của shop nhận MỘT tin có TÊN khách trên fanpage.
      const hoGroup = await db.select().from(schema.messagingDeliveries).where(and(eq(schema.messagingDeliveries.event, "sales_chat.handoff"), eq(schema.messagingDeliveries.subjectId, hoConv.id)));
      assert.ok(hoGroup.length === 1 && hoGroup[0].connectorKey === "sandbox-messaging" && /Khách cần nhân viên trả lời: Chị Hồ/.test(hoGroup[0].body) && /Bot đã dừng/.test(hoGroup[0].body), JSON.stringify(hoGroup.map((d) => [d.connectorKey, d.body])));
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
      // ═══ GỬI LẠI TIN NHÓM HỎNG VÌ MẠNG (0186 — Telegram chập chờn từ máy chủ ở Việt Nam) ═══
      const tgToken = `123456789:${"A".repeat(35)}`;
      const okTg = () => ({ ok: true, result: { message_id: 77, username: "don_hang_bot", first_name: "Đơn hàng", id: 1 } });
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "telegram-bot", settings: { chatId: "-1001234567" }, secrets: { botToken: tgToken } })));
      assert.ok("ok" in (await testOrgConnection(admin, "telegram-bot", { tester: { fetch: fakeFetchCalls(okTg).fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "telegram-bot", "ACTIVE")));
      const tgErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
      const flaky = (failures: number, code = "ETIMEDOUT") => {
        let n = 0;
        const calls: string[] = [];
        const f = (async (input: RequestInfo | URL) => {
          calls.push(String(input));
          n += 1;
          if (n <= failures) throw tgErr(code);
          return new Response(JSON.stringify(okTg()), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        return { fetch: f, calls };
      };
      const tSleeps: number[] = [];
      const tsleep = async (ms: number) => void tSleeps.push(ms);
      // Mạng tắc 2 lần rồi thông ⇒ gửi được NGAY trong lượt (thử lại sau 2 giây · 5 giây).
      const q = flaky(2);
      const d1 = await deliverMessage({ connectorKey: "telegram-bot", body: "🟢 ĐƠN MỚI #A", dedupeKey: "retry:test:1" }, { fetch: q.fetch, sleep: tsleep });
      assert.ok(d1.status === "SENT" && q.calls.length === 3 && tSleeps.join(",") === "2000,5000", JSON.stringify({ d1, n: q.calls.length, tSleeps }));
      // Tắc mãi ⇒ FAILED + hẹn gửi lại 2 phút; job tới mốc ⇒ gửi được, lần thử thứ 2.
      const dead = flaky(99);
      const d2 = await deliverMessage({ connectorKey: "telegram-bot", body: "🟢 ĐƠN MỚI #B", dedupeKey: "retry:test:2" }, { fetch: dead.fetch, sleep: tsleep });
      assert.ok(d2.status === "FAILED" && /ETIMEDOUT/.test(d2.error) && /tự gửi lại/.test(d2.error), JSON.stringify(d2));
      const mrow = async (k: string) => (await db.select().from(schema.messagingDeliveries).where(eq(schema.messagingDeliveries.dedupeKey, k)))[0];
      let mr2 = await mrow("retry:test:2");
      const dueIn = mr2.nextRetryAt!.getTime() - Date.now();
      assert.ok(mr2.status === "FAILED" && mr2.attempts === 1 && dueIn > 100_000 && dueIn <= 120_000, JSON.stringify({ s: mr2.status, a: mr2.attempts, dueIn }));
      assert.equal((await retryFailedDeliveries({ fetch: flaky(0).fetch, sleep: tsleep, now: () => new Date() })).due, 0, "chưa tới mốc");
      const laterR = () => new Date(Date.now() + 3 * 60_000);
      const good = flaky(0);
      const [ra1, ra2] = await Promise.all([retryFailedDeliveries({ fetch: good.fetch, sleep: tsleep, now: laterR }), retryFailedDeliveries({ fetch: good.fetch, sleep: tsleep, now: laterR })]);
      assert.ok(ra1.sent + ra2.sent === 1 && ra1.failed + ra2.failed === 0, `hai lượt job chồng nhau ⇒ gửi lại đúng MỘT lần, lượt thua nhường chứ không đập vào dòng đang gửi: ${JSON.stringify([ra1, ra2])}`);
      assert.equal(good.calls.filter((u) => u.includes("/sendMessage")).length, 1);
      mr2 = await mrow("retry:test:2");
      assert.ok(mr2.status === "SENT" && mr2.attempts === 2 && mr2.nextRetryAt === null);
      // Bị NGẮT giữa chừng (có thể đã tới) ⇒ không thử lại trong lượt, không hẹn gửi lại — thà thiếu còn hơn trùng.
      const reset = flaky(99, "ECONNRESET");
      const d3 = await deliverMessage({ connectorKey: "telegram-bot", body: "🟢 ĐƠN MỚI #C", dedupeKey: "retry:test:3" }, { fetch: reset.fetch, sleep: tsleep });
      assert.ok(d3.status === "FAILED" && reset.calls.length === 1 && (await mrow("retry:test:3")).nextRetryAt === null, JSON.stringify(d3));
      // Tin THỬ ⇒ không hẹn gửi lại (người bấm đang nhìn kết quả).
      await deliverMessage({ connectorKey: "telegram-bot", body: "[TIN THỬ]", dedupeKey: "retry:test:4", isTest: true }, { fetch: flaky(99).fetch, sleep: tsleep });
      assert.equal((await mrow("retry:test:4")).nextRetryAt, null);
      // ═══ QUY TRÌNH BÁN 5 BƯỚC + CÂU MẪU TRONG LUỒNG AI + CẦN NGƯỜI XỬ LÝ (chủ shop 01/10/2026) ═══
      const cfgOld = { ...parseSalesChatbotConfig(null), allowedTools: ["search_products" as const] };
      assert.ok(PROCESS_TOOLS.every((t) => toolDefsFor(cfgOld).some((d) => d.name === t)), "công cụ quy trình tới cả tổ chức có allowedTools lưu từ trước");
      const qCat = [{ code: "Q1", id: savedQr.id, title: "Hỏi giá chả mực", upsell: true }];
      const tctx = (st: ChatState) => ({ conversationId: "x", channel: "TEST" as const, config: parseSalesChatbotConfig(null), state: st, lastUserText: "", agent: { name: "t", source: "t" }, quickReplies: qCat });
      const sq = await executeTool("send_quick_reply", { code: "q1" }, tctx({}));
      assert.ok(!sq.isError && sq.deliver?.text.includes("400.000") && sq.deliver.imageIds.length === 1 && sq.state.upsellSent === true, JSON.stringify(sq));
      assert.ok((await executeTool("send_quick_reply", { code: "Q1" }, tctx(sq.state))).isError, "câu upsell chỉ gửi MỘT lần mỗi hội thoại");
      assert.ok((await executeTool("send_quick_reply", { code: "Q9" }, tctx({}))).isError, "mã không có trong danh sách ⇒ từ chối");
      assert.equal((await executeTool("set_sales_stage", { stage: "INFO" }, tctx({}))).state.stage, "INFO");
      const dec = await executeTool("mark_declined", { reason: "Khách nói thôi không lấy" }, tctx({}));
      assert.ok(dec.state.declined && dec.state.stage === "DECLINED");
      await db.insert(schema.customers).values({ name: "Nguyễn Thanh Hà", phone: "0975850916", address: "Xóm 8, thôn Văn Tảo, xã Hà Nam, Thành phố Hải Phòng", province: "" });
      const lk = await executeTool("lookup_customer", { phone: "0975 850 916" }, tctx({}));
      const lkData = JSON.parse(lk.content) as { returning_customer: boolean; previous_address_hint: string; name_hint: string };
      assert.ok(lkData.returning_customer && lkData.previous_address_hint === "…, xã Hà Nam, Thành phố Hải Phòng" && !lk.content.includes("Xóm 8") && lkData.name_hint === "Hà", lk.content);
      assert.equal((JSON.parse((await executeTool("lookup_customer", { phone: "0900000001" }, tctx({}))).content) as { returning_customer: boolean }).returning_customer, false);
      // KHÁCH CŨ mua lại (02/10/2026): khớp MÃ FACEBOOK ⇒ đủ thông tin đơn gần nhất; chỉ khớp SĐT ⇒ mức PHONE (địa chỉ che).
      await db.insert(schema.customers).values({ name: "Trần Văn Sang", phone: "0911222333", fbId: "psid-sang", address: "Địa chỉ hồ sơ cũ", province: "", lastOrderAt: new Date("2026-09-24T16:40:00Z") });
      const [sang] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phone, "0911222333"));
      await db.insert(schema.orders).values({ id: "ret-ord-1", insertedAt: new Date("2026-09-24T16:40:00Z"), customerId: sang.id, stage: "DELIVERED", shipFullName: "Trần Văn Sang", shipPhone: "0911222333", shipAddress: "Số 12 ngõ 5 Lê Lợi, phường Hà Đông", shipProvince: "Hà Nội" });
      await db.insert(schema.orders).values({ id: "ret-ord-0", insertedAt: new Date("2026-09-30T10:00:00Z"), customerId: sang.id, stage: "DELETED", shipAddress: "Đơn đã xoá — không được dùng" });
      await db.insert(schema.orderItems).values({ id: "ret-oi-1", orderId: "ret-ord-1", productName: "Chả cá thu", variationDetail: "1kg", quantity: 2 });
      const byFb = await findReturningCustomer({ returning: { fetchedAt: "", phones: [], fbIds: ["psid-sang"], prior: [] } });
      assert.ok(byFb?.trust === "FB_ID" && byFb.address === "Số 12 ngõ 5 Lê Lợi, phường Hà Đông" && byFb.province === "Hà Nội" && byFb.orders === 1 && byFb.lastItems[0] === "Chả cá thu (1kg) × 2", "địa chỉ theo ĐƠN gần nhất còn sống: " + JSON.stringify(byFb));
      const byPh = await findReturningCustomer({ returning: { fetchedAt: "", phones: ["+84911222333"], fbIds: ["psid-nguoi-khac"], prior: [] } });
      assert.equal(byPh?.trust, "PHONE", "mã Facebook khác, chỉ trùng SĐT ⇒ mức PHONE");
      assert.equal((await findReturningCustomer({ customer: { id: null, name: "Lan", phone: "0900000009", address: "5 Lý Thường Kiệt", province: "", simulated: true } }))?.trust, "THREAD");
      assert.equal(await findReturningCustomer({}), null);
      // use_saved_address: CHỈ khi khách vừa xác nhận; máy chủ điền địa chỉ đầy đủ, bot / tóm tắt chỉ thấy bản che.
      const rctx = (st: ChatState, last: string, returning: ReturningCustomer | null = byPh) => ({ ...tctx(st), lastUserText: last, returning });
      const notYet = await executeTool("create_customer", { name: "Sang", use_saved_address: true, customer_confirmation: "đúng rồi" }, rctx({}, "cho anh 2kg chả cá"));
      assert.ok(notYet.isError && !notYet.state.customer, "khách chưa xác nhận ⇒ không tự điền");
      assert.ok((await executeTool("create_customer", { name: "Sang", use_saved_address: true, customer_confirmation: "đúng" }, rctx({}, "đúng", null))).isError, "không có khách cũ ⇒ không điền");
      const savedC = await executeTool("create_customer", { name: "Sang", use_saved_address: true, customer_confirmation: "vẫn địa chỉ đó" }, rctx({}, "Vẫn địa chỉ đó em ạ"));
      assert.ok(!savedC.isError && savedC.state.customer?.address === "Số 12 ngõ 5 Lê Lợi, phường Hà Đông" && savedC.state.customer.phone === "0911222333" && savedC.state.customer.savedAddress === true && !savedC.content.includes("Số 12"), JSON.stringify(savedC));
      // MỜI THÊM MÓN TRƯỚC KHI LÊN ĐƠN (02/10/2026 · ảnh «Nguyễn Nga» / «Xuantra Tâm An»): shop có câu upsell ⇒ chưa gửi thì
      // chặn lên đơn; gửi xong ⇒ lên đơn + tóm tắt NGAY trong cùng lượt; câu upsell thiếu số ERP ⇒ không chặn mãi.
      const draftIn = (st: ChatState) => executeTool("create_draft_order", { items: [{ variant_id: chaMuc, quantity: 1 }] }, rctx(st, "ok em"));
      const noUp = await draftIn(savedC.state);
      assert.ok(noUp.isError && noUp.content.includes("send_quick_reply") && noUp.content.includes("Q1") && !noUp.state.draft, `chưa mời thêm món ⇒ chặn: ${noUp.content}`);
      const upNow = await executeTool("send_quick_reply", { code: "Q1" }, rctx(savedC.state, "ok em"));
      assert.ok(!upNow.isError && upNow.state.upsellSent, JSON.stringify(upNow.state));
      assert.ok(!(await draftIn(upNow.state)).isError, "mời xong ⇒ lên đơn + tóm tắt ngay trong cùng lượt");
      assert.ok(!(await draftIn({ ...savedC.state, upsellUnavailable: true })).isError, "câu upsell không gửi được ⇒ không chặn mãi");
      assert.ok(!(await executeTool("create_draft_order", { items: [{ variant_id: chaMuc, quantity: 1 }] }, { ...rctx(savedC.state, "ok em"), quickReplies: [] })).isError, "shop chưa chọn câu upsell ⇒ không chặn");
      const savedDraft = await executeTool("create_draft_order", { items: [{ variant_id: chaMuc, quantity: 1 }] }, rctx({ ...savedC.state, upsellSent: true }, "ok em"));
      assert.ok(!savedDraft.isError && savedDraft.state.draft?.recipient.address === "Số 12 ngõ 5 Lê Lợi, phường Hà Đông", "đơn mang địa chỉ ĐẦY ĐỦ");
      assert.ok(!savedDraft.content.includes("Số 12") && savedDraft.content.includes("…, phường Hà Đông, Hà Nội"), "tóm tắt bot đọc cho khách chỉ có địa chỉ che: " + savedDraft.content);
      const fbC = await executeTool("create_customer", { name: "Sang", use_saved_address: true, customer_confirmation: "như cũ" }, rctx({}, "như cũ em", byFb));
      assert.ok(!fbC.isError && fbC.state.customer?.savedAddress === undefined, "mức FB_ID: chính người đó ⇒ không cần che");
      // AI chọn câu mẫu giữa luồng ⇒ khách nhận NGUYÊN VĂN câu mẫu (giá ERP) + ảnh, rồi câu hỏi tiếp của AI.
      let flowStep = 0;
      setSalesChatProviderForTests(() => ({
        ...baseBot,
        complete: async (req: AiRequest) => {
          if (!req.tools.length) return { content: [{ type: "text", text: "NONE" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          assert.ok(/CÂU MẪU của shop/.test(req.system) && /Q1: Hỏi giá chả mực/.test(req.system), "lời nhắc có danh sách câu mẫu");
          flowStep += 1;
          const content: AiBlock[] = flowStep === 1 ? [{ type: "tool_use", id: "s1", name: "set_sales_stage", input: { stage: "QUOTE" } }, { type: "tool_use", id: "q1", name: "send_quick_reply", input: { code: "Q1" } }] : [{ type: "text", text: "Mình lấy 1kg hay 2kg ạ?" }];
          return { content, stopReason: flowStep === 1 ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      }));
      await receiveFanpageEvent(ev("m-flow-1", "món mực nhà mình có ngon không em", { id: "cust-fl", name: "Chị Mai" }, "t-flow"));
      const flowFetch = fakeFetchCalls((url) => ({ success: true, id: url.includes("upload_contents") ? "content-flow" : `m-${Math.random().toString(36).slice(2)}` }));
      const rf = await processFanpageThread(PAGE, "t-flow", { fetch: flowFetch.fetch, now: in31s });
      const flowBodies = flowFetch.calls.filter((c) => c.url.includes("/conversations/t-flow/messages") && c.init?.method === "POST").map((c) => String(c.init?.body));
      assert.ok(rf.replies === 2 && flowBodies[0].includes("400.000") && flowBodies[1].includes("content_ids") && flowBodies[2].includes("1kg hay 2kg"), `ảnh của câu mẫu đi NGAY sau chữ của nó, trước câu hỏi tiếp của AI: ${JSON.stringify({ rf, flowBodies })}`);
      const flowConv = (await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-flow"))))[0];
      assert.equal((flowConv.state as ChatState).stage, "QUOTE");
      // KHÁCH CŨ trên fanpage: Pancake trả SĐT đã ghi nhận + tin cũ trước khi bot vào ⇒ lời nhắc có khối KHÁCH CŨ đầy đủ (mã
      // Facebook khớp), bot không cần khách khai lại; hồ sơ Pancake đọc MỘT lần rồi dùng lại.
      const retSystems: string[] = [];
      setSalesChatProviderForTests(() => ({
        ...baseBot,
        complete: async (req: AiRequest) => {
          if (!req.tools.length) return { content: [{ type: "text", text: "NONE" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          retSystems.push(req.system);
          return { content: [{ type: "text", text: "Dạ em gửi về địa chỉ cũ như lần trước nha anh, anh lấy thêm món gì không ạ?" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      }));
      const retFetch = fakeFetchCalls((url, init) =>
        init?.method === "GET" && url.includes("/conversations/t-ret/messages")
          ? { success: true, conv_phone_numbers: ["0911222333"], messages: [{ id: "old-1", message: "Giao về Số 12 ngõ 5 Lê Lợi nhé em", from: { id: "psid-sang", name: "Sang Tran" }, inserted_at: "2026-09-24T16:30:00" }] }
          : { success: true, id: "m-" + Math.random().toString(36).slice(2) },
      );
      await receiveFanpageEvent(ev("m-ret-1", "Lấy như lần trước cho anh nhé", { id: "psid-sang", name: "Sang Tran" }, "t-ret"));
      const rret = await processFanpageThread(PAGE, "t-ret", { fetch: retFetch.fetch, now: in31s });
      assert.ok(rret.replies === 1 && retSystems.length === 1, JSON.stringify(rret));
      for (const k of ["KHÁCH CŨ", "Trần Văn Sang", "Số 12 ngõ 5 Lê Lợi, phường Hà Đông, Hà Nội", "đuôi 2333", "[khách 24/09/2026] Giao về Số 12 ngõ 5 Lê Lợi nhé em"]) assert.ok(retSystems[0].includes(k), "lời nhắc thiếu «" + k + "»");
      const retConv = (await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-ret"))))[0];
      assert.deepEqual((retConv.state as ChatState).returning?.fbIds, ["psid-sang"], "mã Facebook của khách lấy từ tin của khách");
      const getsFirst = retFetch.calls.filter((c) => c.init?.method === "GET").length;
      assert.equal(getsFirst, 2, "Pancake trả lại đúng trang cũ ⇒ dừng đọc ở trang thứ hai, không đọc đủ 3 trang");
      await receiveFanpageEvent(ev("m-ret-2", "ok em", { id: "psid-sang", name: "Sang Tran" }, "t-ret"));
      await processFanpageThread(PAGE, "t-ret", { fetch: retFetch.fetch, now: () => new Date(Date.now() + FOLLOWUP_WAIT_MS + 1000) });
      assert.equal(retSystems.length, 2);
      assert.equal(retFetch.calls.filter((c) => c.init?.method === "GET").length, getsFirst, "hồ sơ Pancake đọc ở lượt đầu, lượt sau dùng lại");
      // Hội thoại này đang chờ khách — gỡ lịch nhắc để khối follow-up bên dưới chỉ thấy hội thoại của nó.
      await db.update(schema.salesChatConversations).set({ nextFollowupAt: null }).where(eq(schema.salesChatConversations.id, retConv.id));
      assert.equal((await listConversations(50)).find((c) => c.id === flowConv.id)?.stage, "QUOTE", "danh sách hội thoại hiện bước bán");
      // Giá BẤT THƯỜNG (mã chưa có giá) ⇒ CẦN NGƯỜI XỬ LÝ do MÁY quyết, bot im lặng; không tự hết hạn; người «Trả lại cho AI» ⇒ bot trả lời lại.
      const noPrice = await mk("Mực khô (chưa có giá)", "MUC-KHO", 100_000, "");
      await db.update(schema.productVariants).set({ retailPrice: 0 }).where(eq(schema.productVariants.id, noPrice));
      let npStep = 0;
      setSalesChatProviderForTests(() => ({
        ...baseBot,
        complete: async (req: AiRequest) => {
          if (!req.tools.length) return { content: [{ type: "text", text: "NONE" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          npStep += 1;
          const content: AiBlock[] = npStep === 1 ? [{ type: "tool_use", id: "c1", name: "calculate_cart", input: { items: [{ variant_id: noPrice, quantity: 1 }] } }] : [{ type: "text", text: "Dạ mực khô giá 0đ ạ" }];
          return { content, stopReason: npStep === 1 ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      }));
      await receiveFanpageEvent(ev("m-np-1", "mực khô bán sao em", { id: "cust-np", name: "Anh Nam" }, "t-np"));
      const npFetch = fakeFetchCalls(() => ({ success: true, id: `m-${Math.random().toString(36).slice(2)}` }));
      const rnp = await processFanpageThread(PAGE, "t-np", { fetch: npFetch.fetch, now: in31s });
      assert.ok(rnp.replies === 0 && !npFetch.calls.some((c) => c.init?.method === "POST"), `giá bất thường ⇒ không nói «0đ», không gửi gì: ${JSON.stringify(rnp)}`);
      assert.equal(npStep, 1, "máy dừng vòng AI ngay khi cần người");
      const npConv = (await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-np"))))[0];
      assert.ok(npConv.status === "HANDOFF" && /Cần người xử lý — Giá bất thường/.test(npConv.handoffReason ?? ""), JSON.stringify(npConv.handoffReason));
      // Nhân viên trả lời trên page KHÔNG đổi lý do thành «nhân viên đang trả lời» (thứ tự hết hạn sau 30 phút).
      await receiveFanpageEvent(ev("m-np-staff", "Dạ để em kiểm giá", { id: PAGE, uid: "u-staff", name: "NV" }, "t-np"));
      assert.match((await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, npConv.id)))[0].handoffReason ?? "", /Giá bất thường/);
      await receiveFanpageEvent(ev("m-np-2", "sao rồi em", { id: "cust-np", name: "Anh Nam" }, "t-np"));
      const rLater = await processFanpageThread(PAGE, "t-np", { fetch: npFetch.fetch, now: () => new Date(Date.now() + 13 * 3_600_000) });
      assert.ok(rLater.replies === 0, "cần người xử lý KHÔNG tự hết hạn sau 13 giờ");
      assert.equal(npStep, 1, "đang cần người ⇒ không gọi AI lần nào (không tốn token, không tự trả lời)");
      assert.equal(await resumeConversationToAi(npConv.id), true);
      assert.equal(await resumeConversationToAi(npConv.id), false, "chỉ trả lại hội thoại đang cần người");
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
      await receiveFanpageEvent(ev("m-np-3", "chả mực bao nhiêu em", { id: "cust-np", name: "Anh Nam" }, "t-np"));
      const rBack = await processFanpageThread(PAGE, "t-np", { fetch: npFetch.fetch, now: () => new Date(Date.now() + 13 * 3_600_000) });
      assert.ok(rBack.replies >= 1, `trả lại cho AI ⇒ bot trả lời lại: ${JSON.stringify(rBack)}`);
      // ═══ FOLLOW-UP TỰ ĐỘNG (0185): khách im lặng ⇒ WAITING ⇒ AI nhắc theo lịch 1 · 6 · 22 giờ, dừng đúng lúc ═══
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
      await receiveFanpageEvent(ev("m-fu-1", "Chả mực bao nhiêu vậy em", { id: "cust-fu", name: "Chị Thu" }, "t-fu"));
      const fuFetch = fakeFetchCalls((url) => ({ success: true, id: url.includes("upload_contents") ? "content-fu" : `m-${Math.random().toString(36).slice(2)}` }));
      const t0 = Date.now();
      assert.ok((await processFanpageThread(PAGE, "t-fu", { fetch: fuFetch.fetch, now: in31s })).replies >= 1);
      const fuConv = async () => (await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-fu"))))[0];
      let fc = await fuConv();
      assert.ok(fc.status === "WAITING" && fc.pageId === PAGE && fc.threadId === "t-fu" && fc.followupsSent === 0 && fc.lastCustomerAt, JSON.stringify({ s: fc.status, p: fc.pageId, t: fc.threadId }));
      const firstDue = fc.nextFollowupAt!.getTime() - fc.waitingSince!.getTime();
      assert.equal(firstDue, 60 * 60_000, "mốc đầu = 1 giờ sau khi bắt đầu im lặng");
      assert.equal((await runSalesFollowups({ fetch: fuFetch.fetch, now: () => new Date(t0 + 30 * 60_000) })).due, 0, "chưa tới mốc ⇒ không gì");
      const fuAi: AiRequest[] = [];
      let fuText = "Dạ chị còn băn khoăn gì về chả mực không ạ, em hỗ trợ chị nhé!";
      setSalesChatProviderForTests(() => ({ ...baseBot, complete: async (req: AiRequest) => { fuAi.push(req); return { content: [{ type: "text", text: fuText }], stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 }; } }));
      const at1h = () => new Date(fc.waitingSince!.getTime() + 61 * 60_000);
      const [fuA, fuB] = await Promise.all([runSalesFollowups({ fetch: fuFetch.fetch, now: at1h }), runSalesFollowups({ fetch: fuFetch.fetch, now: at1h })]);
      assert.equal(fuA.sent + fuB.sent, fuA.due, `hai lượt job chồng nhau ⇒ mỗi hội thoại tới mốc đúng MỘT tin nhắc: ${JSON.stringify([fuA, fuB])}`);
      const fuPosts = fuFetch.calls.filter((c) => c.init?.method === "POST" && c.url.includes("/conversations/t-fu/messages")).filter((c) => String(c.init?.body).includes("băn khoăn"));
      assert.ok(fuPosts.length === 1 && fuPosts[0].url.includes("/conversations/t-fu/messages") && String(fuPosts[0].init?.body).includes("băn khoăn"), JSON.stringify(fuPosts.map((c) => c.init?.body)));
      assert.ok(fuAi[0].tools.length === 0 && /IM LẶNG/.test(fuAi[0].system) && /Lần nhắc 1\/3/.test(fuAi[0].system) && /KHÁCH: Chả mực bao nhiêu/.test(JSON.stringify(fuAi[0].messages)), "AI đọc hội thoại + bước + lần nhắc");
      fc = await fuConv();
      assert.ok(fc.followupsSent === 1 && fc.status === "WAITING" && fc.nextFollowupAt!.getTime() - fc.waitingSince!.getTime() === 360 * 60_000, "mốc kế = 6 giờ");
      assert.match((await conversationView(fc.id))!.messages.at(-1)!.text, /băn khoăn/, "tin nhắc nằm trong hội thoại");
      // Tiếng vọng của tin nhắc KHÔNG làm bot nhường.
      assert.equal((await receiveFanpageEvent(ev("m-fu-echo", fuText, { id: PAGE, uid: "u-bot" }, "t-fu"))).reason, "Tin của chính bot");
      // AI lỡ nêu giá ⇒ BỎ lần nhắc đó (không gửi), sang mốc sau.
      fuText = "Chả mực bên em 400k/kg thôi chị ơi";
      const postsMid = fuFetch.calls.filter((c) => c.init?.method === "POST").length;
      const r2nd = await runSalesFollowups({ fetch: fuFetch.fetch, now: () => new Date(fc.waitingSince!.getTime() + 361 * 60_000) });
      assert.ok(r2nd.sent === 0 && fuFetch.calls.filter((c) => c.init?.method === "POST").length === postsMid && /AI nêu giá/.test(r2nd.detail.join(" ")), JSON.stringify(r2nd));
      assert.ok(!fuFetch.calls.some((c) => String(c.init?.body).includes("400k")), "câu có giá không bao giờ được gửi");
      fc = await fuConv();
      assert.ok(fc.followupsSent === 2 && fc.nextFollowupAt!.getTime() - fc.waitingSince!.getTime() === 1320 * 60_000);
      // Khách nhắn lại ⇒ hết im lặng: dừng lịch, về OPEN (bot trả lời ⇒ lịch mới từ đầu).
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
      await receiveFanpageEvent(ev("m-fu-2", "giá chả mực sao em", { id: "cust-fu", name: "Chị Thu" }, "t-fu"));
      await processFanpageThread(PAGE, "t-fu", { fetch: fuFetch.fetch, now: () => new Date(Date.now() + FOLLOWUP_WAIT_MS + 1000) });
      fc = await fuConv();
      assert.ok(fc.followupsSent === 0 && fc.status === "WAITING" && fc.lastCustomerAt!.getTime() > t0, "khách nhắn lại ⇒ lịch follow-up bắt đầu lại từ lần 1");
      // Điều kiện DỪNG: chốt đơn · từ chối rõ · ngoài khung 24 giờ · follow-up tắt.
      const dueNow = () => new Date(fc.nextFollowupAt!.getTime() + 1000);
      for (const [label, patch] of [
        ["đã chốt đơn", { state: { ...(fc.state as ChatState), confirmed: { orderId: null, simulated: true, total: 1, at: "x" } } }],
        ["khách từ chối rõ", { state: { ...(fc.state as ChatState), declined: { reason: "thôi", at: "x" } } }],
        ["ngoài khung 24 giờ của Facebook", { lastCustomerAt: new Date(Date.now() - 25 * 3_600_000) }],
      ] as const) {
        await db.update(schema.salesChatConversations).set({ ...patch, status: "WAITING", nextFollowupAt: fc.nextFollowupAt }).where(eq(schema.salesChatConversations.id, fc.id));
        const rs = await runSalesFollowups({ fetch: fuFetch.fetch, now: dueNow });
        assert.ok(rs.sent === 0 && rs.stopped === 1 && rs.detail.join(" ").includes(label), `${label}: ${JSON.stringify(rs)}`);
        await db.update(schema.salesChatConversations).set({ state: fc.state, lastCustomerAt: fc.lastCustomerAt }).where(eq(schema.salesChatConversations.id, fc.id));
      }
      // (02/10/2026 · ảnh «Sang Tran») NGƯỜI KHÁC LÊN TIẾNG ⇒ bot thôi nhắc. Nhân viên chốt đơn trên Pancake mà Pancake KHÔNG
      // gắn uid (trông như tin tự động) ⇒ lịch nhắc xoá ngay lúc nhận.
      const rearm = (extra: Partial<typeof schema.salesChatConversations.$inferInsert> = {}) =>
        db.update(schema.salesChatConversations).set({ status: "WAITING", nextFollowupAt: fc.nextFollowupAt, waitingSince: fc.waitingSince, lastBotAt: fc.lastBotAt, lastCustomerAt: fc.lastCustomerAt, ...extra }).where(eq(schema.salesChatConversations.id, fc.id));
      await rearm({ lastBotAt: new Date(Date.now() - 10 * 60_000) });
      assert.match((await receiveFanpageEvent(ev("m-fu-staff", "Vâng ah, nay e giao tiếp ạ", { id: PAGE }, "t-fu"))).reason, /tự động/);
      let fs2 = await fuConv();
      assert.ok(fs2.status === "OPEN" && fs2.nextFollowupAt === null && fs2.waitingSince === null, `tin phía page sau bot ⇒ hết lịch nhắc: ${JSON.stringify({ s: fs2.status, n: fs2.nextFollowupAt })}`);
      // Hội thoại đã XẾP LỊCH trước khi có chặn lúc nhận (dòng phía page nằm sau tin cuối của bot) ⇒ job dừng, không nhắn.
      await rearm({ lastBotAt: new Date(Date.now() - 10 * 60_000) });
      const postsBeforeStaff = fuFetch.calls.filter((c) => c.init?.method === "POST").length;
      const rStaff = await runSalesFollowups({ fetch: fuFetch.fetch, now: dueNow });
      assert.ok(rStaff.sent === 0 && rStaff.stopped === 1 && rStaff.detail.join(" ").includes("nhân viên / page đã nhắn sau bot") && fuFetch.calls.filter((c) => c.init?.method === "POST").length === postsBeforeStaff, JSON.stringify(rStaff));
      // Tin phía page TRƯỚC tin cuối của bot không chặn (bot đã nhắn sau đó, khách im lặng với chính câu ấy).
      await rearm({ lastBotAt: new Date(Date.now() + 60_000) });
      assert.ok(!(await runSalesFollowups({ fetch: fuFetch.fetch, now: dueNow })).detail.join(" ").includes("nhân viên / page"), "tin page cũ hơn tin bot ⇒ không chặn");
      // Khách thả 👍 / ảnh (không chữ — bot không trả lời) ⇒ khách KHÔNG im lặng nữa: hết lịch nhắc, mốc tin khách cập nhật.
      await rearm();
      const likeAt = new Date();
      assert.match((await receiveFanpageEvent(ev("m-fu-like", "", { id: "cust-fu", name: "Chị Thu" }, "t-fu"), likeAt)).reason, /không có chữ/);
      fs2 = await fuConv();
      assert.ok(fs2.status === "OPEN" && fs2.nextFollowupAt === null && fs2.lastCustomerAt!.getTime() >= likeAt.getTime() - 1000, `khách thả 👍 ⇒ hết lịch nhắc: ${JSON.stringify({ s: fs2.status, n: fs2.nextFollowupAt })}`);
      await rearm();
      assert.ok("ok" in (await saveFollowupSettings(admin, { enabled: false, stepsMinutes: [60, 360, 1320] })));
      assert.deepEqual((await runSalesFollowups({ fetch: fuFetch.fetch, now: dueNow })).detail, ["follow-up đang tắt"]);
      assert.ok("error" in (await saveFollowupSettings(admin, { enabled: true, stepsMinutes: [60, 1500] })), "mốc quá 23 giờ ⇒ từ chối (khung 24 giờ của Facebook)");
      assert.ok("ok" in (await saveFollowupSettings(admin, { enabled: true, stepsMinutes: [60, 360, 1320] })));
      // ═══ BÌNH LUẬN (0184): trả lời bằng TIN NHẮN RIÊNG (private reply), không bao giờ công khai ═══
      const evc = (id: string, text: string, from: Record<string, unknown>, thread: string, postId = `${PAGE}_post-1`) =>
        parsePancakeWebhook({ event_type: "messaging", page_id: PAGE, data: { conversation: { id: thread, type: "COMMENT" }, message: { id, type: "COMMENT", message: text, from, post_id: postId } } })!;
      const replied = new Map<string, string>(); // mã bình luận ⇒ hộp thư tin riêng đã mở
      const cmtFetch = fakeFetchCalls((url, init) => {
        const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (init?.method === "POST" && body.action === "private_replies") {
          if (String(body.message_id) === "c-fail") return { success: false, message: "(#10900) Activity already replied to" };
          replied.set(String(body.message_id), `inbox-of-${String(body.message_id)}`);
          return { success: true, id: `pr-${String(body.message_id)}` };
        }
        if (url.includes("upload_contents")) return { success: true, id: "content-cmt" };
        if (init?.method === "POST") return { success: true, id: `m-${Math.random().toString(36).slice(2)}` };
        const thread = /conversations\/([^/]+)\/messages/.exec(url)?.[1] ?? "";
        const ids = thread === "t-c1" ? ["c-1"] : thread === "t-c2" ? ["c-2"] : thread === "t-c4" ? ["c-fail"] : [];
        return { success: true, messages: ids.map((id) => ({ id, private_reply_conversation: replied.get(id) ? { id: replied.get(id) } : null })) };
      });
      const c1 = evc("c-1", "Chả mực bao nhiêu ạ", { id: "cust-c1", name: "Hạnh" }, "t-c1");
      assert.ok(c1.comment && c1.comment.fromId === "cust-c1" && c1.comment.postId === `${PAGE}_post-1`, JSON.stringify(c1));
      assert.deepEqual(await receiveFanpageEvent(c1), { queued: true, reason: "Đã nhận" });
      const rc1 = await processFanpageThread(PAGE, "t-c1", { fetch: cmtFetch.fetch, now: in31s });
      assert.ok(rc1.replies === 1 && !rc1.error, JSON.stringify(rc1));
      const posts = cmtFetch.calls.filter((c) => c.init?.method === "POST" && !c.url.includes("upload_contents")).map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
      const pr = posts.find((b) => b.action === "private_replies");
      assert.ok(pr && pr.message_id === "c-1" && pr.from_id === "cust-c1" && pr.post_id === `${PAGE}_post-1` && String(pr.message).includes("400.000"), JSON.stringify(posts));
      assert.ok(!posts.some((b) => b.action === "reply_comment"), "KHÔNG BAO GIỜ trả lời công khai dưới bình luận");
      assert.ok(!cmtFetch.calls.some((c) => c.init?.method === "POST" && c.url.includes("/conversations/t-c1/") && String(c.init?.body).includes("reply_inbox")), "không gửi tin vào hội thoại bình luận");
      assert.ok(cmtFetch.calls.some((c) => c.url.includes("/conversations/inbox-of-c-1/messages") && String(c.init?.body).includes("content_ids")), "ảnh của câu mẫu vào hộp thư tin riêng vừa mở");
      // Hội thoại đi tiếp ở hộp thư; tiếng vọng tin riêng (có uid) KHÔNG làm bot nhường; khách nhắn tiếp ⇒ trả lời nhanh, đúng mạch.
      const cConv = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "inbox-of-c-1")));
      assert.equal(cConv.length, 1, "hội thoại chuyển sang hộp thư tin riêng");
      assert.equal((await receiveFanpageEvent(ev("m-pr-echo", String(pr.message), { id: PAGE, uid: "u-bot" }, "inbox-of-c-1"))).reason, "Tin của chính bot");
      await receiveFanpageEvent(ev("m-pr-next", "Ship về Hải Phòng bao lâu em", { id: "cust-c1", name: "Hạnh" }, "inbox-of-c-1"));
      const rNext = await processFanpageThread(PAGE, "inbox-of-c-1", { fetch: cmtFetch.fetch, now: () => new Date(Date.now() + FOLLOWUP_WAIT_MS + 1000) });
      assert.ok(rNext.replies >= 1, `khách nhắn tiếp trong hộp thư ⇒ trả lời sau ~5 giây: ${JSON.stringify(rNext)}`);
      assert.notEqual((await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, cConv[0].id)))[0].status, "HANDOFF");
      // ĐUA: tiếng vọng tin riêng tới hộp thư MỚI ngay trong lời gọi gửi (bot chưa biết hộp thư nào) ⇒ vẫn là tin của bot.
      const echoReasons: string[] = [];
      const racingCmt = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (body.action === "private_replies") echoReasons.push((await receiveFanpageEvent(ev("echo-c5", String(body.message), { id: PAGE, uid: "u-bot" }, "inbox-of-c-5"))).reason);
        if (String(input).includes("/conversations/t-c5/messages") && init?.method !== "POST") return new Response(JSON.stringify({ success: true, messages: [{ id: "c-5", private_reply_conversation: replied.get("c-5") ? { id: replied.get("c-5") } : null }] }), { status: 200 });
        return cmtFetch.fetch(input, init);
      }) as typeof fetch;
      await receiveFanpageEvent(evc("c-5", "Chả mực bao nhiêu", { id: "cust-c5", name: "Ba" }, "t-c5"));
      const rc5 = await processFanpageThread(PAGE, "t-c5", { fetch: racingCmt, now: in31s });
      assert.ok(rc5.replies === 1 && echoReasons.length === 1 && echoReasons[0] === "Tin của chính bot", JSON.stringify({ rc5, echoReasons }));
      // Bình luận ĐÃ được nhắn riêng (Pancake tự động / nhân viên) ⇒ không nhắn lần hai.
      replied.set("c-2", "inbox-staff");
      await receiveFanpageEvent(evc("c-2", "Giá chả mực sao shop", { id: "cust-c2", name: "Tuấn" }, "t-c2"));
      const prBefore = cmtFetch.calls.filter((c) => String(c.init?.body).includes("private_replies")).length;
      const rc2 = await processFanpageThread(PAGE, "t-c2", { fetch: cmtFetch.fetch, now: in31s });
      assert.ok(rc2.replies === 0 && cmtFetch.calls.filter((c) => String(c.init?.body).includes("private_replies")).length === prBefore, JSON.stringify(rc2));
      // Page / nhân viên đã trả lời bình luận ⇒ bot không chen.
      await receiveFanpageEvent(evc("c-3", "Còn hàng không", { id: "cust-c3", name: "Minh" }, "t-c3"));
      assert.match((await receiveFanpageEvent(evc("c-3-page", "Dạ còn ạ, chị check inbox nhé", { id: PAGE, uid: "u-staff" }, "t-c3"))).reason, /Page đã trả lời bình luận/);
      const rc3 = await processFanpageThread(PAGE, "t-c3", { fetch: cmtFetch.fetch, now: in31s });
      assert.ok(rc3.replies === 0 && /Page đã trả lời/.test(rc3.skipped ?? ""), JSON.stringify(rc3));
      // Facebook từ chối tin riêng ⇒ báo lỗi, KHÔNG lùi về trả lời công khai.
      await receiveFanpageEvent(evc("c-fail", "Chả mực bao nhiêu", { id: "cust-c4", name: "Lan" }, "t-c4"));
      const rc4 = await processFanpageThread(PAGE, "t-c4", { fetch: cmtFetch.fetch, now: in31s });
      assert.ok(rc4.replies === 0 && /không nhắn riêng được/.test(rc4.error ?? "") && /KHÔNG trả lời công khai/.test(rc4.error ?? ""), JSON.stringify(rc4));
      assert.ok(!cmtFetch.calls.some((c) => String(c.init?.body).includes("reply_comment")), "lỗi tin riêng không lùi về bình luận công khai");
      // ═══ BOT THẤY NHỮNG GÌ PAGE ĐÃ NÓI (01/10/2026: khách «Ship c 1kí» sau trả lời tự động báo giá, bot hỏi lại «món nào») ═══
      const ctxSeen: AiRequest[] = [];
      setSalesChatProviderForTests(() => ({
        ...baseBot,
        complete: async (req: AiRequest) => {
          if (!req.tools.length) return { content: [{ type: "text", text: "NONE" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          ctxSeen.push(req);
          return { content: [{ type: "text", text: "Dạ chị cho em xin SĐT và địa chỉ nhận hàng ạ" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      }));
      await receiveFanpageEvent(ev("m-ctx-1", "Báo giá chả cá thu?", { id: "cust-ctx", name: "Thu Vân" }, "t-ctx"));
      await receiveFanpageEvent(ev("m-ctx-auto", "Dạ em chào anh/chị! Chả cá thu bên em hiện đang có giá 1kg / 2kg ạ", { id: PAGE }, "t-ctx"));
      const ctxFetch = fakeFetchCalls(() => ({ success: true, id: `m-${Math.random().toString(36).slice(2)}` }));
      assert.match((await processFanpageThread(PAGE, "t-ctx", { fetch: ctxFetch.fetch, now: in31s })).skipped ?? "", /Page đã trả lời/);
      await new Promise((r) => setTimeout(r, 5));
      await receiveFanpageEvent(ev("m-ctx-2", "Ship c 1kí", { id: "cust-ctx", name: "Thu Vân" }, "t-ctx"));
      await processFanpageThread(PAGE, "t-ctx", { fetch: ctxFetch.fetch, now: () => new Date(Date.now() + FOLLOWUP_WAIT_MS + 1000) });
      const hist = JSON.stringify(ctxSeen[0]?.messages ?? []);
      const iAsk = hist.indexOf("Báo giá chả cá thu?");
      const iAuto = hist.indexOf("[Shop đã nhắn] Dạ em chào anh/chị! Chả cá thu");
      const iShip = hist.indexOf("Ship c 1kí");
      assert.ok(iAsk >= 0 && iAuto > iAsk && iShip > iAuto, `lịch sử AI: câu khách bị bỏ qua → trả lời tự động của page → câu mới, đúng thứ tự: ${hist.slice(0, 400)}`);
      const ctxPosts = ctxFetch.calls.filter((c) => c.init?.method === "POST").map((c) => String(c.init?.body));
      assert.ok(ctxPosts.length === 1 && !ctxPosts.some((b) => b.includes("Shop đã nhắn") || b.includes("Báo giá chả cá thu")), `ngữ cảnh chép vào lịch sử KHÔNG gửi lại cho khách: ${ctxPosts.join(" | ")}`);
      // Lượt sau không chép lại lần hai.
      await receiveFanpageEvent(ev("m-ctx-3", "Phạm Văn Đồng, Bình Thạnh", { id: "cust-ctx", name: "Thu Vân" }, "t-ctx"));
      await processFanpageThread(PAGE, "t-ctx", { fetch: ctxFetch.fetch, now: () => new Date(Date.now() + FOLLOWUP_WAIT_MS + 1000) });
      const hist2 = JSON.stringify(ctxSeen[1]?.messages ?? []);
      assert.equal(hist2.split("[Shop đã nhắn] Dạ em chào").length - 1, 1, "trả lời tự động chỉ nằm MỘT lần trong lịch sử");
      // Mức suy nghĩ «Nhanh» ⇒ suy luận low; «Kỹ» (mặc định) ⇒ medium + ngân sách rộng.
      assert.equal(ctxSeen[0].reasoning, "medium");
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
      const sleeps: number[] = [];
      await processFanpageThreadDebounced(PAGE, "t-901", { fetch: pancake.fetch, sleep: async (ms) => void sleeps.push(ms) });
      assert.ok(sleeps[0] >= FOLLOWUP_WAIT_MS && sleeps[0] <= FOLLOWUP_WAIT_MS + 2000, `lượt sau webhook chỉ đợi khách gõ xong: ${sleeps.join(",")}`);
      // TRẢ LỜI NHANH (chủ shop 01/10/2026): tin TIẾP THEO chỉ đợi khách gõ xong; tin ĐẦU của hội thoại mới đợi tối đa 10 giây
      // để nhường trả lời tự động của Meta — tới SAU tin khách ⇒ bỏ qua ngay.
      const inMs = (ms: number) => () => new Date(Date.now() + ms);
      await receiveFanpageEvent(ev("m-fast-1", "Shop còn ruốc tôm không", { id: "cust-8", name: "Chị Tám" }, "t-980"));
      assert.equal((await processFanpageThread(PAGE, "t-980", { fetch: pancake.fetch, now: inMs(FOLLOWUP_WAIT_MS + 1000) })).skipped, "Đang đợi xem page có trả lời không", "tin đầu hội thoại mới: 5 giây chưa đủ");
      const f1 = await processFanpageThread(PAGE, "t-980", { fetch: pancake.fetch, now: inMs(FIRST_CONTACT_WAIT_MS + 1000) });
      assert.ok(f1.replies >= 1, `tin đầu, Meta không trả lời sau 10 giây ⇒ bot trả lời: ${JSON.stringify(f1)}`);
      await receiveFanpageEvent(ev("m-fast-2", "Ship Hà Nội mấy ngày em", { id: "cust-8", name: "Chị Tám" }, "t-980"));
      const f2 = await processFanpageThread(PAGE, "t-980", { fetch: pancake.fetch, now: inMs(FOLLOWUP_WAIT_MS + 1000) });
      assert.ok(f2.replies >= 1, `tin tiếp theo trả lời sau ~5 giây, không đợi 10: ${JSON.stringify(f2)}`);
      // Pancake giả trả MỐC TẠO tin (inserted_at, giờ UTC không múi giờ như Pancake thật) cho lượt hỏi «tin page tạo trước hay sau».
      const timed = (msgs: { id: string; at: string }[]) =>
        fakeFetchCalls((url, init) => (init?.method === "GET" && url.includes("/messages") ? { success: true, messages: msgs.map((m) => ({ id: m.id, inserted_at: m.at })) } : { success: true, id: `m-${Math.random().toString(36).slice(2)}` }));
      // Trả lời tự động của Meta tới TRƯỚC tin đầu (ngược thứ tự) nhưng TẠO SAU nó ⇒ page đã trả lời, bỏ qua ngay
      // (03/10/2026 · «Thủy Nguyễn» nhận hai câu báo giá khi khoảng nhìn lùi bị bỏ hẳn).
      await receiveFanpageEvent(ev("m-fast-auto", "Cảm ơn chị đã nhắn tin ạ", { id: PAGE }, "t-981"));
      await new Promise((r) => setTimeout(r, 5));
      await receiveFanpageEvent(ev("m-fast-3", "Shop ơi", { id: "cust-9", name: "Anh Chín" }, "t-981"));
      const metaFetch = timed([{ id: "m-fast-3", at: "2026-10-03T06:00:00.100000" }, { id: "m-fast-auto", at: "2026-10-03T06:00:00.900000" }]);
      const f3 = await processFanpageThread(PAGE, "t-981", { fetch: metaFetch.fetch });
      assert.ok(f3.replies === 0 && /Page đã trả lời/.test(f3.skipped ?? ""), `Meta trả lời tạo SAU tin đầu (tới ngược thứ tự) ⇒ bỏ qua NGAY: ${JSON.stringify(f3)}`);
      assert.equal(metaFetch.calls.filter((c) => c.init?.method === "GET").length, 1, "ca mơ hồ hỏi Pancake MỘT lần");
      // (02/10/2026 · «Nguyễn Oanh») LỜI CHÀO QUẢNG CÁO tới trước tin đầu VÀ TẠO TRƯỚC nó (hội thoại cũ quay lại qua quảng cáo —
      // Meta không tự trả lời) ⇒ KHÔNG phải «page đã trả lời»: vẫn đợi như tin đầu, đủ 10 giây không ai trả lời thì bot trả lời.
      await receiveFanpageEvent(ev("m-ad-greet", "CHẢ CÁ THU NGUYÊN CHẤT 100% NGON KHÁC BIỆT!!! KHÔNG ĂN LÀ THIỆT", { id: PAGE }, "t-982"));
      await new Promise((r) => setTimeout(r, 5));
      await receiveFanpageEvent(ev("m-ad-q", "Báo giá chả cá thu?", { id: "cust-oanh", name: "Nguyễn Oanh" }, "t-982"));
      const adFetch = timed([{ id: "m-ad-greet", at: "2026-10-03T06:00:00.000000" }, { id: "m-ad-q", at: "2026-10-03T06:00:00.400000" }]);
      assert.equal((await processFanpageThread(PAGE, "t-982", { fetch: adFetch.fetch, now: inMs(FOLLOWUP_WAIT_MS + 1000) })).skipped, "Đang đợi xem page có trả lời không", "lời chào quảng cáo không làm bot bỏ qua — vẫn đợi Meta như tin đầu");
      const fAd = await processFanpageThread(PAGE, "t-982", { fetch: adFetch.fetch, now: inMs(FIRST_CONTACT_WAIT_MS + 1000) });
      assert.ok(fAd.replies >= 1 && fAd.processed === 1, `lời chào quảng cáo tạo trước tin khách ⇒ bot vẫn trả lời: ${JSON.stringify(fAd)}`);
      // Không đọc được mốc (Pancake lỗi) ⇒ coi là CHƯA trả lời — khách nhận một câu trùng còn hơn không ai trả lời.
      await receiveFanpageEvent(ev("m-unk-greet", "Chào mừng bạn tới Hải Sản Làng Chài", { id: PAGE }, "t-983"));
      await new Promise((r) => setTimeout(r, 5));
      await receiveFanpageEvent(ev("m-unk-q", "Còn hàng không shop", { id: "cust-unk", name: "Khách Lạ" }, "t-983"));
      assert.ok((await processFanpageThread(PAGE, "t-983", { fetch: pancake.fetch, now: inMs(FIRST_CONTACT_WAIT_MS + 1000) })).replies >= 1, "không đọc được mốc ⇒ bot trả lời");
      // (03/10/2026 · «Thủy Nguyễn») GHI CHÚ TỰ ĐỘNG của Pancake («Đã đặt giai đoạn … Đủ tiêu chuẩn» chèn ngay sau tin có SĐT) KHÔNG
      // phải ai trả lời: không ghi thành «page đã trả lời», bot vẫn trả lời khách. Dòng «X đã trả lời một quảng cáo» phía khách
      // cũng không phải tin khách.
      await receiveFanpageEvent(ev("m-note-q", "sdt. 0378697439", { id: "cust-thuy", name: "Thủy Nguyễn" }, "t-984"));
      assert.match((await receiveFanpageEvent(ev("m-note-1", "Đã đặt giai đoạn của khách hàng tiềm năng thành Đủ tiêu chuẩn", { id: PAGE }, "t-984"))).reason, /Ghi chú tự động của Pancake/);
      assert.match((await receiveFanpageEvent(ev("m-note-2", "Đã thêm nhãn tự động: Đã đánh dấu trạng thái đơn đặt hàng là Đã đặt hàng.", { id: PAGE, uid: "u-x" }, "t-984"))).reason, /Ghi chú tự động/);
      assert.equal((await receiveFanpageEvent(ev("m-note-3", "Thủy Nguyễn đã trả lời một quảng cáo.", { id: "cust-thuy", name: "Thủy Nguyễn" }, "t-984"))).queued, false, "dòng hệ thống phía khách không thành tin chờ bot");
      assert.equal((await db.select().from(schema.salesChatInbound).where(and(eq(schema.salesChatInbound.threadId, "t-984"), eq(schema.salesChatInbound.note, "PAGE_REPLY")))).length, 0, "ghi chú tự động không ghi thành tin page");
      const fNote = await processFanpageThread(PAGE, "t-984", { fetch: pancake.fetch, now: inMs(FIRST_CONTACT_WAIT_MS + 1000) });
      assert.ok(fNote.replies >= 1 && fNote.processed === 1 && !/Page đã trả lời/.test(fNote.skipped ?? ""), `ghi chú tự động ⇒ bot vẫn trả lời khách: ${JSON.stringify(fNote)}`);
      assert.notEqual((await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, "t-984"))))[0]?.status, "HANDOFF", "ghi chú có uid cũng không làm bot nhường");
      // «Bỏ qua N» phải kèm LÝ DO đọc được — chủ shop không có cách nào khác để biết vì sao bot im.
      const counts = await fanpageInboundCounts();
      assert.ok(counts.skipped >= 1 && counts.skippedReasons.some((r) => /nhân viên/i.test(r.reason) && r.count >= 1), JSON.stringify(counts));
      assert.ok(!counts.skippedReasons.some((r) => r.reason === "BOT_SENT" || r.reason === "PAGE_REPLY"), "tin bot tự gửi / tin phía page không phải tin bị bỏ qua");
      assert.ok(counts.skippedReasons.some((r) => /Page đã trả lời/.test(r.reason)), JSON.stringify(counts));
      // Nhà cung cấp OpenAI (BYOK) phải CHUYỂN mức suy luận + ngân sách của lượt gọi xuống Responses API — đo 01/10/2026: cứng
      // «medium» với ngân sách nhỏ ⇒ model suy nghĩ hết ngân sách, trả RỖNG. Thiếu `reasoning` ⇒ giữ «medium» như cũ.
      const oaBodies: Record<string, unknown>[] = [];
      const oaFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        oaBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "r1", object: "response", status: "completed", model: "gpt-x", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Dạ", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const oa = new ByokOpenAiProvider({ apiKey: "sk-test-khong-that", model: "gpt-x", fetch: oaFetch });
      const oaMsg: AiRequest["messages"] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
      await oa.complete({ system: "s", messages: oaMsg, tools: [], maxTokens: 12_000, reasoning: "low" });
      await oa.complete({ system: "s", messages: oaMsg, tools: [] });
      assert.deepEqual(oaBodies.map((b) => [b.reasoning, b.max_output_tokens]), [[{ effort: "low" }, 12_000], [{ effort: "medium" }, 4000]], JSON.stringify(oaBodies.map((b) => b.reasoning)));
      // ═══ HỌC TỪ HỘI THOẠI CŨ: lịch sử Pancake ⇒ làm sạch ⇒ AI của shop ⇒ sổ tay NHÁP ⇒ người xuất bản ⇒ bot dùng ═══
      assert.equal(redactForLearning("Chị Lan ơi SĐT 0912345678, giá 400.000đ, xem https://shop.vn/a", ["Chị Lan"]), "[khách] ơi SĐT [số], giá [số]đ, xem [link]");
      assert.deepEqual(stripPrices("Giá 299k, combo 1.150.000đ, ship 30 nghìn, size 2"), { text: "Giá [giá lấy từ ERP], combo [giá lấy từ ERP], ship [giá lấy từ ERP], size 2", removed: 3 });
      assert.equal(transcriptFor([{ fromShop: false, text: "a" }, { fromShop: false, text: "b" }, { fromShop: false, text: "c" }], []), null, "không có câu nào của shop ⇒ không học");
      // Nhãn KẾT QUẢ (02/10/2026 — học từ hội thoại chốt được): khách để lại SĐT ⇒ chốt được; SĐT của SHOP không tính.
      const conv3 = (cust: string, shop = "Dạ chị") => [{ fromShop: false, text: "Chả cá còn không" }, { fromShop: true, text: shop }, { fromShop: false, text: cust }];
      assert.ok(customerLeftPhone(conv3("SĐT chị 0912 345 678 nhé")) && customerLeftPhone(conv3("+84912345678")) && customerLeftPhone(conv3("0912.345.678")));
      assert.ok(!customerLeftPhone(conv3("lấy 2 hộp", "Hotline shop 0912345678")) && !customerLeftPhone(conv3("12 Hàng Bạc")), "SĐT của shop / số nhà ⇒ chưa chốt");
      assert.ok(transcriptFor(conv3("ok"), [], { closed: true })?.startsWith(CLOSED_TAG) && transcriptFor(conv3("ok"), [], { closed: false })?.startsWith(OPEN_TAG));
      assert.ok(!/\d/.test(CLOSED_TAG + OPEN_TAG), "nhãn không mang chữ số (AI không thấy một chữ số nào)");
      const aiInputs: string[] = [];
      const pbProvider: AiProvider = {
        name: "fake", model: "claude-sonnet-5", schemaDialect: "anthropic",
        async complete(req: AiRequest): Promise<AiResponse> {
          const input = req.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ")).join(" ");
          aiInputs.push(input);
          const isMerge = /Gộp các ghi chú/.test(req.system);
          const qaJson = 'Đây: [{"title":"Hỏi cách bảo quản","triggers":["bảo quản sao","để được bao lâu"],"answer":"Dạ để ngăn đá, dùng trong 3 tháng ạ"},{"title":"Hỏi giá combo","triggers":["combo bao nhiêu"],"answer":"Dạ combo 299k ạ"}]';
          const text = /mảng JSON/.test(req.system) ? qaJson : isMerge ? "1. Giọng điệu & xưng hô: dạ / ạ, gọi khách là chị. 2. Khi khách hỏi giá: giá combo 299k — đọc từ hệ thống." : "- Shop luôn dạ ạ; khi khách chê đắt thì nói hàng làm thủ công, giá 400.000đ là hợp lý.";
          return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      };
      setSalesChatProviderForTests(() => pbProvider);
      const manager = { ...admin, role: "MANAGER" as const, permissions: admin.permissions.filter((x) => x !== "ai_sales:manage") };
      assert.ok("error" in (await startPlaybookLearning(manager, { conversations: 50, days: 90 })), "thiếu ai_sales:manage ⇒ không chạy");
      assert.ok("error" in (await startPlaybookLearning(admin, { conversations: 7, days: 90 })), "số hội thoại ngoài danh sách ⇒ từ chối");
      const started = await startPlaybookLearning(admin, { conversations: 50, days: 90 });
      assert.ok("ok" in started, JSON.stringify(started));
      assert.ok("error" in (await startPlaybookLearning(admin, { conversations: 50, days: 90 })), "đang chạy ⇒ không chạy chồng");
      const recent = new Date().toISOString();
      const history = fakeFetchCalls((url) => {
        if (url.includes("/v2/pages/")) return { success: true, conversations: url.includes("last_conversation_id") ? [] : [1, 2, 3, 4].map((i) => ({ id: `h${i}`, updated_at: recent, from: { name: `Chị Lan ${i}` } })) };
        const conv = /conversations\/(h\d)\/messages/.exec(url)?.[1] ?? "h0";
        return {
          success: true,
          messages: [
            { id: `${conv}-1`, inserted_at: "2026-09-01T01:00:00", from: { id: "cust", name: `Chị Lan ${conv.slice(1)}` }, message: "Chả mực bao nhiêu em? SĐT chị 0912345678" },
            { id: `${conv}-2`, inserted_at: "2026-09-01T01:01:00", from: { id: PAGE, uid: "u1" }, message: `Dạ Chị Lan ${conv.slice(1)} ơi, chả mực 400.000đ/kg ạ, chị lấy mấy kg để em lên đơn?` },
            { id: `${conv}-3`, inserted_at: "2026-09-01T01:02:00", from: { id: "cust", name: `Chị Lan ${conv.slice(1)}` }, message: "Đắt thế em, bớt được không? Giao 12 Hàng Bạc nhé" },
            { id: `${conv}-4`, inserted_at: "2026-09-01T01:03:00", from: { id: PAGE, admin_id: "a1" }, message: "Dạ hàng giã tay chị ơi, em tặng chị túi giữ lạnh nhé" },
          ],
        };
      });
      const done = await runPlaybookLearning({ target: 50, days: 90 }, { id: null, email: ADMIN_EMAIL }, { fetch: history.fetch, sleep: async () => undefined });
      assert.equal(done.state, "DONE", JSON.stringify(done));
      assert.ok(done.state === "DONE" && done.stats.closed === 4 && done.stats.skipped === 0, `4 hội thoại khách để lại SĐT: ${JSON.stringify(done)}`);
      assert.ok(aiInputs.some((x) => x.includes(CLOSED_TAG)), "AI thấy nhãn kết quả của từng hội thoại");
      // Cùng lượt học: AI gợi ý CÂU TRẢ LỜI MẪU (0183) — luôn TẮT, giá bị thay ⇒ phải sửa mới bật được.
      assert.equal(done.state === "DONE" ? done.stats.quickReplies : -1, 2, JSON.stringify(done));
      const sug = (await listQuickReplies()).filter((r) => r.source === "LEARNED");
      assert.ok(sug.length === 2 && sug.every((r) => !r.active), JSON.stringify(sug.map((r) => [r.title, r.active])));
      assert.ok(sug.find((r) => r.title === "Hỏi giá combo")?.needsEdit && !sug.some((r) => r.answer.includes("299")), "giá trong gợi ý bị thay");
      assert.ok(history.calls.every((c) => c.init?.method === "GET" && c.url.startsWith("https://pages.fm/api/public_api/")), "chỉ ĐỌC Pancake");
      // Đầu vào CHỨA HỘI THOẠI (bước đọc từng lô) — bước gộp chỉ nhận ghi chú do AI viết, có số thứ tự «Ghi chú 1».
      const seen = aiInputs.filter((x) => x.includes("--- HỘI THOẠI ---")).join("\n");
      assert.ok(seen.length > 0, "có ít nhất một lô hội thoại tới AI");
      assert.ok(!/\d/.test(seen), `AI không thấy một chữ số nào (giá cũ, SĐT, số nhà): ${seen.slice(0, 200)}`);
      assert.ok(!/Chị Lan/.test(seen) && /\[khách\]/.test(seen), "tên khách bị che");
      assert.ok(!seen.includes(PAGE_TOKEN), "token không đi tới AI");
      const pb = await loadPlaybook();
      assert.ok(pb.draft && !/299k|400\.000/.test(pb.draft.text) && pb.draft.text.includes("[giá lấy từ ERP]"), `sổ tay nháp không mang giá: ${pb.draft?.text}`);
      assert.equal(pb.published, null, "học xong chỉ là NHÁP — bot chưa dùng");
      const pbUsage = await (await getPlatformDb()).select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, ORG), eq(schema.platformAiUsage.feature, "sales_playbook")));
      assert.equal(pbUsage.length, aiInputs.length, "mỗi lời gọi AI một dòng sổ dùng AI");
      // Pancake CHẬM (02/10/2026: một lời gọi hết 30 giây chờ làm hỏng cả lượt học): lỗi nhất thời ⇒ thử lại sau 2 · 5 giây;
      // một hội thoại hỏng mãi ⇒ BỎ QUA, học tiếp; hỏng liền 5 hội thoại ⇒ dừng với câu lỗi nói đúng là Pancake.
      const timeoutErr = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
      let h2Fails = 1;
      const pbSleeps: number[] = [];
      const flakyHistory = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.includes("/conversations/h2/messages") && h2Fails-- > 0) throw timeoutErr();
        if (u.includes("/conversations/h3/messages")) return new Response(JSON.stringify({ success: false, message: "busy" }), { status: 503 });
        return history.fetch(input, init);
      }) as typeof fetch;
      const flakyRun = await runPlaybookLearning({ target: 50, days: 90 }, { id: null, email: ADMIN_EMAIL }, { fetch: flakyHistory, sleep: async (ms) => void pbSleeps.push(ms) });
      assert.ok(flakyRun.state === "DONE" && flakyRun.stats.skipped === 1 && flakyRun.stats.conversations === 3, JSON.stringify(flakyRun));
      assert.ok(pbSleeps.includes(2_000) && pbSleeps.includes(5_000), `thử lại sau 2 giây rồi 5 giây: ${pbSleeps.filter((x) => x > 250).join(",")}`);
      const deadRun = await runPlaybookLearning({ target: 50, days: 90 }, { id: null, email: ADMIN_EMAIL }, { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/messages") ? Promise.reject(timeoutErr()) : history.fetch(input, init))) as typeof fetch, sleep: async () => undefined });
      assert.ok(deadRun.state === "FAILED" && /Không gọi được Pancake sau 3 lần thử/.test(deadRun.error) && !deadRun.error.includes(PAGE_TOKEN), JSON.stringify(deadRun));
      // AI trả RỖNG (model suy luận tiêu hết ngân sách — đo 01/10/2026) ⇒ thử lại một lần với ngân sách gấp đôi; rỗng mãi ⇒
      // lượt học HỎNG có câu nói rõ, bản nháp cũ GIỮ NGUYÊN (không bị ghi đè bằng chuỗi rỗng).
      const draftBefore = (await loadPlaybook()).draft?.text;
      const budgets: (number | undefined)[] = [];
      let emptyFirst = true;
      const reasonings: string[] = [];
      setSalesChatProviderForTests(() => ({ ...pbProvider, complete: async (req: AiRequest) => { budgets.push(req.maxTokens); reasonings.push(`${/Gộp các ghi chú/.test(req.system) ? "gộp" : "đọc"}:${req.reasoning}`); const text = emptyFirst ? "" : "1. Giọng điệu: dạ ạ."; emptyFirst = !emptyFirst; return { content: text ? [{ type: "text", text }] : [], stopReason: text ? "end_turn" : "max_tokens", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 }; } }));
      const retried = await runPlaybookLearning({ target: 50, days: 90 }, { id: null, email: ADMIN_EMAIL }, { fetch: history.fetch, sleep: async () => undefined });
      assert.equal(retried.state, "DONE", JSON.stringify(retried));
      assert.ok(budgets.every((b) => (b ?? 0) >= 12_000) && budgets.includes(24_000), `rỗng ⇒ thử lại với ngân sách gấp đôi: ${budgets.join(",")}`);
      assert.ok(reasonings.includes("gộp:medium") && reasonings.filter((x) => x.startsWith("đọc")).every((x) => x === "đọc:low"), `đọc lô: low · gộp sổ tay: medium — ${reasonings.join(",")}`);
      setSalesChatProviderForTests(() => ({ ...pbProvider, complete: async () => ({ content: [], stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 }) }));
      const keptDraft = (await loadPlaybook()).draft?.text;
      const empty = await runPlaybookLearning({ target: 50, days: 90 }, { id: null, email: ADMIN_EMAIL }, { fetch: history.fetch, sleep: async () => undefined });
      assert.ok(empty.state === "FAILED" && /AI không trả về nội dung/.test(empty.error), JSON.stringify(empty));
      assert.equal((await loadPlaybook()).draft?.text, keptDraft, "AI rỗng ⇒ không ghi đè bản nháp");
      assert.ok(draftBefore, "đã có bản nháp từ lượt trước");
      setSalesChatProviderForTests(() => pbProvider);
      // Sửa tay (vẫn lọc giá) ⇒ xuất bản ⇒ bot dùng trong lời nhắc; quay lại / gỡ được.
      const saved = await savePlaybookDraft(admin, `${pb.draft!.text}\n6. Thêm: combo 2 hộp 500k.`);
      assert.ok("ok" in saved && /gỡ 1 con số/.test(saved.message), JSON.stringify(saved));
      assert.ok("ok" in (await publishPlaybook(admin)));
      assert.equal((await loadPlaybook()).published?.version, 1);
      const systems: string[] = [];
      // Chỉ lượt chatbot ĐẦY ĐỦ (có công cụ) — lời gọi nhỏ chọn câu trả lời mẫu (0183) có ngân sách riêng.
      const chatBudgets: [AiRequest["reasoning"], number | undefined][] = [];
      setSalesChatProviderForTests(() => ({ ...pbProvider, complete: async (req: AiRequest) => { if (req.tools.length) {
            systems.push(req.system);
            chatBudgets.push([req.reasoning, req.maxTokens]);
          } return { content: [{ type: "text", text: "Dạ" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 }; } }));
      const tconv = await openConversation("TEST", { createdBy: ADMIN_EMAIL });
      await chatTurn(tconv.id, "Chào shop", { channel: "TEST" });
      // Ghi lại rồi khẳng định NGOÀI provider — chatTurn nuốt lỗi ném từ provider (coi là AI hỏng) nên assert bên trong không bắt được gì.
      assert.ok(chatBudgets.length > 0 && chatBudgets.every(([r, m]) => r === "medium" && (m ?? 0) >= 8000), `chat mặc định «Kỹ»: suy luận medium, ngân sách ≥ 8000: ${JSON.stringify(chatBudgets)}`);
      assert.ok(systems.some((x) => x.includes("SỔ TAY BÁN HÀNG của shop") && x.includes("Giọng điệu")), "bot dùng sổ tay đã xuất bản");
      assert.ok(systems.every((x) => x.indexOf("LUẬT BẮT BUỘC") < x.indexOf("SỔ TAY BÁN HÀNG")), "sổ tay đứng SAU luật bắt buộc");
      await savePlaybookDraft(admin, "Bản hai: luôn hỏi khách cần bảo quản lạnh không.");
      await publishPlaybook(admin);
      assert.equal((await loadPlaybook()).published?.version, 2);
      // Học lại khi đã có sổ tay đang dùng ⇒ bước gộp nhận sổ tay đó để HỌC TIẾP (giữ câu mẫu tốt), không viết lại từ đầu.
      setSalesChatProviderForTests(() => pbProvider);
      aiInputs.length = 0;
      assert.equal((await runPlaybookLearning({ target: 50, days: 90 }, { id: null, email: ADMIN_EMAIL }, { fetch: history.fetch, sleep: async () => undefined })).state, "DONE");
      assert.ok(aiInputs.some((x) => x.includes("SỔ TAY ĐANG DÙNG") && x.includes("Bản hai: luôn hỏi khách cần bảo quản lạnh")), "bước gộp thấy sổ tay đang dùng");
      assert.equal((await loadPlaybook()).published?.version, 2, "học lại chỉ tạo NHÁP — sổ tay đang dùng giữ nguyên");
      assert.ok("ok" in (await rollbackPlaybook(admin, 1)));
      assert.equal((await loadPlaybook()).published?.version, 1, "quay lại bản 1");
      assert.ok("ok" in (await unpublishPlaybook(admin)));
      assert.equal((await loadPlaybook()).published, null, "gỡ khỏi bot");
      setSalesChatProviderForTests(() => fakeProvider(hslcScript({ chaMuc, ruocTom })));
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
