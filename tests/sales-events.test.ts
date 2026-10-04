/**
 * SỔ SỰ KIỆN HỘI THOẠI BÁN HÀNG (0199 · lib/sales-chatbot/events*.ts · docs/productization/MIGRATION_PLAN.md M2).
 *
 * Phần THUẦN: so ảnh chụp trước / sau lượt ⇒ đúng sự kiện, đúng khoá chống trùng; mã lý do chuyển người; upsell nhận / từ chối.
 * Phần TỔ CHỨC THẬT `se-events`: khách web hỏi giá → để lại SĐT → đơn nháp → chốt — mỗi bước một sự kiện có mốc, đơn của AI
 * mang khoá về hội thoại (`orders.sales_conversation_id` + `origin = AI_AGENT`); chuyển người bằng công cụ (actor AI, mã
 * WHOLESALE); AI hỏng (actor SYSTEM, mã AI_DOWN); ghi lại không đẻ dòng thứ hai; lỗi ghi sổ KHÔNG làm hỏng lượt.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createProductCore } from "@/lib/records/product-create";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { insertSalesEvents, recordConversationEvent, withTurnEvents } from "@/lib/sales-chatbot/events";
import { classifyHandoffReason, deriveTurnEvents, draftValue, HANDOFF_REASON_CODES, purchaseCycle, SALES_EVENT_TYPES, type TurnMessage, type TurnSnapshot } from "@/lib/sales-chatbot/events-shared";
import { foldVi } from "@/lib/sales-chatbot/catalog";
import { loadAiSalesPerformance, savePerformanceSettings } from "@/lib/sales-chatbot/performance";
import { AI_SALES_METRICS, cohortTable, estimatedStaffSaving, parsePerformanceSettings, percentileOrNull, rateOrNull } from "@/lib/sales-chatbot/performance-shared";
import { confirmManualDeliveryCore } from "@/lib/records/order-create";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";

const ORG = "se-events";
const ADMIN_EMAIL = "chu@se-events.local";

// ─────────────────────────── 1 · THUẦN ───────────────────────────

const T0 = new Date("2026-10-04T08:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const snap = (p: Partial<TurnSnapshot> = {}): TurnSnapshot => ({ status: "OPEN", handoffReason: null, state: {}, maxSeq: 1, turns: 0, quickReplies: 0, aiCalls: 0, ...p });
const userText = (seq: number, s: number, text: string): TurnMessage => ({ seq, role: "user", content: [{ type: "text", text }], at: at(s) });
const botText = (seq: number, s: number, text: string): TurnMessage => ({ seq, role: "assistant", content: [{ type: "text", text }], at: at(s) });
const draft = (lines: [string, number, number][], orderId: string | null = "erp-x", simulated = false): NonNullable<ChatState["draft"]> => ({
  orderId,
  lines: lines.map(([variantId, quantity]) => ({ variantId, quantity })),
  unitPrices: Object.fromEntries(lines.map(([v, , p]) => [v, p])),
  recipient: { name: "A", phone: "0912345678", address: "x", province: "" },
  note: "",
  simulated,
});

function testPure() {
  // Danh sách loại trong mã = danh sách trong CHECK của CSDL (hai bản khai, phải khớp từng chữ).
  const schemaSrc = readFileSync("db/schema.ts", "utf8");
  const migration = readFileSync("drizzle/0199_sales_conversation_events.sql", "utf8");
  const list = SALES_EVENT_TYPES.map((t) => `'${t}'`).join(",");
  assert.ok(schemaSrc.includes(list), "CHECK loại sự kiện trong db/schema.ts phải khớp SALES_EVENT_TYPES");
  assert.ok(migration.includes(list), "CHECK loại sự kiện trong migration phải khớp SALES_EVENT_TYPES");

  // Lượt đầu, AI trả lời có gọi công cụ báo giá.
  const first = deriveTurnEvents({
    before: snap({ maxSeq: 1 }),
    after: snap({ maxSeq: 5, turns: 1, aiCalls: 2 }),
    messages: [
      userText(2, 0, "chả mực bao nhiêu"),
      { seq: 3, role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calculate_cart", input: {} }], at: at(2) },
      { seq: 4, role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "{}" }], at: at(2) },
      botText(5, 4, "Dạ 400.000 ₫ ạ"),
    ],
    acceptedInCycle: false,
  });
  const types = first.map((e) => e.type);
  assert.deepEqual(types, ["conversation.opened", "message.received", "ai.replied", "quote.given"]);
  const reply = first.find((e) => e.type === "ai.replied")!;
  assert.equal(reply.payload?.mode, "AI");
  assert.equal(reply.payload?.responseMs, 4000, "thời gian phản hồi = mốc tin trả lời − mốc tin khách");
  assert.equal(reply.occurredAt.getTime(), at(4).getTime(), "mốc của TIN, không phải lúc ghi sổ");
  assert.equal(first.find((e) => e.type === "message.received")!.payload?.chars, 17, "không lưu nội dung tin — chỉ độ dài");
  // Cùng đầu vào ⇒ cùng khoá (ghi lại không đẻ dòng thứ hai).
  const again = deriveTurnEvents({ before: snap({ maxSeq: 1 }), after: snap({ maxSeq: 5, turns: 1, aiCalls: 2 }), messages: [userText(2, 0, "chả mực bao nhiêu"), botText(5, 4, "Dạ")], acceptedInCycle: false });
  assert.equal(again.find((e) => e.type === "message.received")!.key, first.find((e) => e.type === "message.received")!.key);

  // Lỗi công cụ báo giá ⇒ KHÔNG tính là đã báo giá.
  const failedQuote = deriveTurnEvents({
    before: snap({ turns: 1 }),
    after: snap({ maxSeq: 4, turns: 2, aiCalls: 1 }),
    messages: [userText(2, 0, "giá?"), { seq: 3, role: "assistant", content: [{ type: "tool_use", id: "q", name: "get_current_price", input: {} }], at: at(1) }, { seq: 4, role: "user", content: [{ type: "tool_result", toolUseId: "q", content: "{}", isError: true }], at: at(1) }],
    acceptedInCycle: false,
  });
  assert.ok(!failedQuote.some((e) => e.type === "quote.given"));
  assert.ok(!failedQuote.some((e) => e.type === "conversation.opened"), "lượt thứ hai không mở hội thoại lần nữa");

  // Câu mẫu khớp chữ (0 token) và câu dựng sẵn của máy (đang chuyển người) — hai chế độ khác AI.
  const quick = deriveTurnEvents({ before: snap({ turns: 1 }), after: snap({ maxSeq: 3, turns: 2, quickReplies: 1 }), messages: [userText(2, 0, "ship không"), botText(3, 1, "Dạ ship 30k")], acceptedInCycle: false });
  assert.equal(quick.find((e) => e.type === "ai.replied")?.payload?.mode, "QUICK_REPLY");
  const sys = deriveTurnEvents({ before: snap({ turns: 1, status: "HANDOFF" }), after: snap({ maxSeq: 3, turns: 2, status: "HANDOFF" }), messages: [userText(2, 0, "alo"), botText(3, 1, "Nhân viên đang tiếp nhận")], acceptedInCycle: false });
  const sysReply = sys.find((e) => e.type === "ai.replied")!;
  assert.equal(sysReply.payload?.mode, "SYSTEM");
  assert.equal(sysReply.actorKind, "SYSTEM");
  assert.ok(!sys.some((e) => e.type === "handoff.requested"), "đã ở HANDOFF ⇒ không ghi chuyển người lần nữa");

  // Chuyển bước, khách để lại SĐT, đơn nháp, chuyển người do MODEL gọi công cụ.
  const a1: ChatState = { stage: "CONFIRM", customer: { id: "c1", name: "A", phone: "0912345678", address: "x", province: "", simulated: false }, draft: draft([["v1", 2, 400_000]]) };
  const mid = deriveTurnEvents({
    before: snap({ turns: 2, state: { stage: "INFO" } }),
    after: snap({ maxSeq: 5, turns: 3, aiCalls: 1, state: a1, status: "HANDOFF", handoffReason: "Khách sỉ — 30kg" }),
    messages: [userText(2, 0, "lấy 30kg"), { seq: 3, role: "assistant", content: [{ type: "tool_use", id: "h", name: "handoff_to_human", input: {} }], at: at(1) }, { seq: 4, role: "user", content: [{ type: "tool_result", toolUseId: "h", content: "{}" }], at: at(1) }, botText(5, 2, "Dạ em chuyển nhân viên")],
    acceptedInCycle: false,
  });
  const byType = new Map(mid.map((e) => [e.type, e]));
  assert.deepEqual(byType.get("stage.changed")?.payload, { from: "INFO", to: "CONFIRM" });
  assert.equal(byType.get("customer.identified")?.actorKind, "CUSTOMER");
  assert.equal(byType.get("order.drafted")?.amountVnd, 800_000);
  assert.equal(byType.get("order.drafted")?.orderId, "erp-x");
  const ho = byType.get("handoff.requested")!;
  assert.equal(ho.actorKind, "AI", "model gọi handoff_to_human ⇒ actor AI");
  assert.equal(ho.reasonCode, "WHOLESALE");

  // Upsell: mời ⇒ đơn nháp tăng giá trị ⇒ nhận (số tiền = phần tăng); đơn chốt mà chưa nhận ⇒ từ chối.
  const invited: ChatState = { upsellSent: true, draft: draft([["v1", 2, 400_000]]) };
  const grown: ChatState = { upsellSent: true, draft: draft([["v1", 2, 400_000], ["v2", 1, 350_000]]) };
  const acc = deriveTurnEvents({ before: snap({ turns: 3, state: invited }), after: snap({ maxSeq: 3, turns: 4, aiCalls: 1, state: grown }), messages: [userText(2, 0, "thêm ruốc"), botText(3, 1, "Dạ")], acceptedInCycle: false });
  const up = acc.find((e) => e.type === "upsell.accepted")!;
  assert.equal(up.amountVnd, 350_000);
  assert.ok(!acc.some((e) => e.type === "order.drafted"), "cùng đơn nháp (cùng mã) ⇒ không ghi nháp lần nữa");
  const confirmed: ChatState = { ...grown, confirmed: { orderId: "erp-x", simulated: false, total: 1_150_000, at: at(9).toISOString() } };
  const conf = deriveTurnEvents({ before: snap({ turns: 4, state: grown }), after: snap({ maxSeq: 3, turns: 5, aiCalls: 1, state: confirmed }), messages: [userText(2, 8, "ok chốt"), botText(3, 9, "Dạ")], acceptedInCycle: true });
  assert.equal(conf.find((e) => e.type === "order.confirmed")?.amountVnd, 1_150_000);
  assert.ok(!conf.some((e) => e.type === "upsell.declined"), "đã nhận trong lượt mua ⇒ không ghi từ chối");
  const decl = deriveTurnEvents({ before: snap({ turns: 4, state: invited }), after: snap({ maxSeq: 3, turns: 5, aiCalls: 1, state: { ...invited, confirmed: { orderId: "erp-x", simulated: false, total: 800_000, at: at(9).toISOString() } } }), messages: [userText(2, 8, "ok"), botText(3, 9, "Dạ")], acceptedInCycle: false });
  assert.ok(decl.some((e) => e.type === "upsell.declined"));
  // Shop không có câu mẫu upsell ⇒ không có cờ ⇒ KHÔNG có sự kiện upsell nào (chưa đo, không phải «từ chối»).
  const noFlag = deriveTurnEvents({ before: snap({ turns: 4, state: { draft: draft([["v1", 2, 400_000]]) } }), after: snap({ maxSeq: 3, turns: 5, aiCalls: 1, state: { draft: draft([["v1", 2, 400_000]]), confirmed: { orderId: "erp-x", simulated: false, total: 800_000, at: at(9).toISOString() } } }), messages: [userText(2, 8, "ok"), botText(3, 9, "Dạ")], acceptedInCycle: false });
  assert.ok(!noFlag.some((e) => e.type.startsWith("upsell.")));

  // Lượt mua: đơn chốt của lượt trước sang `pastOrders` ⇒ chu kỳ +1.
  assert.equal(purchaseCycle({}), 0);
  assert.equal(purchaseCycle({ pastOrders: [{ orderId: "erp-a", simulated: false, total: 1, at: "x" }] }), 1);
  // Đơn nháp thiếu đơn giá ⇒ giá trị CHƯA BIẾT (null), không phải 0.
  assert.equal(draftValue({ ...draft([["v1", 1, 100]]), unitPrices: {} }), null);
  assert.equal(draftValue(undefined), null);

  // Mã lý do: lý do của máy chủ trước, nhóm của model sau; câu lạ ⇒ OTHER (không đoán).
  assert.equal(classifyHandoffReason("AI tạm không trả lời được — nhân viên liên hệ lại khách"), "AI_DOWN");
  assert.equal(classifyHandoffReason("Khách nhắn sau khi đã chốt đơn — nhân viên xử lý"), "AFTER_ORDER");
  assert.equal(classifyHandoffReason("Cần người xử lý — giá thiếu"), "TOOL_REQUIRES_HUMAN");
  assert.equal(classifyHandoffReason("Khiếu nại — hàng hỏng"), "COMPLAINT");
  assert.equal(classifyHandoffReason("Giá / tồn bất thường"), "PRICE_STOCK_ANOMALY");
  assert.equal(classifyHandoffReason("Nhân viên đang trả lời trên fanpage"), "STAFF_REPLIED");
  assert.equal(classifyHandoffReason("abc"), "OTHER");
  assert.equal(classifyHandoffReason(null), "OTHER");
  assert.ok(HANDOFF_REASON_CODES.includes("OTHER"));

  // APPEND-ONLY ở mức mã nguồn: không đường nào UPDATE / DELETE sổ sự kiện.
  const files = execFileSync("git", ["ls-files", "lib", "app", "scripts"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx|mts)$/.test(f));
  const offenders = files.filter((f) => /\.(update|delete)\(\s*schema\.salesConversationEvents\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "sổ sự kiện là APPEND-ONLY — không UPDATE / DELETE");

  // ── Màn hiệu quả: sổ chỉ số + phép tính thuần ──
  const keys = AI_SALES_METRICS.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, "khoá chỉ số không trùng");
  for (const m of AI_SALES_METRICS) {
    assert.ok(m.key.startsWith("ai_sales."), m.key);
    if (m.availability === "UNAVAILABLE") assert.ok((m.missingWhat ?? "").length > 40, `${m.key}: UNAVAILABLE phải nói thiếu ĐÚNG cái gì`);
    else assert.ok(m.source !== "—" && !m.missingWhat, `${m.key}: đo được thì phải có nguồn thật`);
  }
  assert.ok(AI_SALES_METRICS.some((m) => m.key === "ai_sales.per_staff_conversion" && m.availability === "UNAVAILABLE"), "so AI với TỪNG nhân viên chưa đo được — phải khai, không giấu");
  const ct = cohortTable([
    { quoted: true, identified: true, drafted: true, confirmed: true, human: false, upsellOffered: false, upsellAccepted: false },
    { quoted: true, identified: false, drafted: false, confirmed: false, human: true, upsellOffered: false, upsellAccepted: false },
    { quoted: false, identified: false, drafted: false, confirmed: false, human: false, upsellOffered: false, upsellAccepted: false },
  ]);
  assert.deepEqual(ct.aiOnly, { conversations: 2, quoted: 1, identified: 1, drafted: 1, confirmed: 1 });
  assert.deepEqual(ct.aiThenHuman, { conversations: 1, quoted: 1, identified: 0, drafted: 0, confirmed: 0 });
  assert.equal(ct.total.conversations, ct.aiOnly.conversations + ct.aiThenHuman.conversations, "hai nhóm cộng lại = tổng");
  assert.equal(rateOrNull(3, 9), null, "dưới mẫu tối thiểu ⇒ chưa đủ dữ liệu, không phải 33%");
  assert.equal(rateOrNull(5, 10), 0.5);
  assert.equal(rateOrNull(0, 0, 1), null, "mẫu 0 ⇒ null");
  assert.equal(percentileOrNull([1, 2, 3], 0.5), null);
  assert.equal(percentileOrNull([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5);
  assert.equal(estimatedStaffSaving(12, null), null, "chưa khai chi phí người ⇒ không có tiết kiệm (không đặt mặc định)");
  assert.equal(estimatedStaffSaving(12, 15_000), 180_000);
  assert.deepEqual(parsePerformanceSettings({ humanCostPerConversationVnd: 1.5 }).humanCostPerConversationVnd, null, "không phải số nguyên đồng ⇒ không nhận");
  console.log("✓ Hiệu quả AI bán hàng · thuần: khoá chỉ số không trùng, UNAVAILABLE nói rõ thiếu gì · phễu hai nhóm cộng đúng tổng · tỷ lệ / phân vị dưới mẫu ⇒ trống · tiết kiệm chỉ khi chủ shop khai");
  console.log("✓ Sổ sự kiện bán hàng · thuần: loại khớp CHECK · mở / nhận / trả lời (AI · câu mẫu · máy) + thời gian phản hồi · báo giá chỉ khi công cụ không lỗi · chuyển bước · SĐT · đơn nháp · chuyển người (actor + mã) · upsell nhận / từ chối / chưa đo · lượt mua · append-only");
}

// ─────────────────────────── 2 · TỔ CHỨC THẬT ───────────────────────────

function fakeProvider(script: (lastUser: string, results: Record<string, unknown>[]) => AiBlock[]): AiProvider {
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

function shopScript(ids: { chaMuc: string; ruocTom: string }) {
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
      if (r.handed_off) return [{ type: "text", text: "Dạ em chuyển nhân viên báo giá sỉ ạ." }];
      return [{ type: "text", text: "Dạ." }];
    }
    if (u.includes("bao nhieu")) return [use("search_products", { query: "chả mực" })];
    if (u.includes("2 goi")) return [use("check_inventory", { items })];
    if (u.includes("0912345678")) return [use("create_customer", { name: "Nguyễn Thị Lan", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" })];
    if (u.includes("ok chot")) return [use("confirm_order", { customer_confirmation: "ok chốt đơn" })];
    if (u.includes("lay si")) return [use("handoff_to_human", { reason: "Khách sỉ — 30kg" })];
    return [{ type: "text", text: "Dạ em nghe ạ." }];
  };
}

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

async function adminOf(): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
  assert.ok(u);
  const org = await findOrganization(ORG);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: org?.name ?? ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const admin = await adminOf();
    const mk = async (name: string, code: string, price: number) => {
      const p = await createProductCore(admin, { name, code, unit: "gói", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
      assert.ok(p.ok, JSON.stringify(p));
      const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
      assert.ok(v);
      return v.id;
    };
    const chaMuc = await mk("Chả mực giã tay", "SE-CHA-MUC", 400_000);
    const ruocTom = await mk("Ruốc bông tôm", "SE-RUOC-TOM", 350_000);
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-SE-1", totalQuantity: 20, createdBy: ADMIN_EMAIL }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values([
      { receiptId: rc.id, variantId: chaMuc, quantity: 10, unitCost: 250_000 },
      { receiptId: rc.id, variantId: ruocTom, quantity: 10, unitCost: 200_000 },
    ]);
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });
    const events = async (convId: string) => db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, convId)).orderBy(asc(schema.salesConversationEvents.occurredAt), asc(schema.salesConversationEvents.createdAt));

    setSalesChatProviderForTests(() => fakeProvider(shopScript({ chaMuc, ruocTom })));
    try {
      // ── Khách WEB: hỏi giá → giỏ → SĐT + đơn nháp → chốt ──
      const vk = visitorKeyOf("se-khach-web-1-abcdefghijklmn");
      const w = await openConversation("WEB", { visitorKey: vk });
      for (const text of ["Chả mực bao nhiêu?", "Cho chị 2 gói, thêm 1 ruốc tôm.", "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội", "ok chốt đơn"]) {
        const r = await chatTurn(w.id, text, { channel: "WEB", visitorKey: vk });
        assert.ok(r.ok, r.ok ? "" : r.error);
      }
      const ev = await events(w.id);
      const count = (t: string) => ev.filter((e) => e.type === t).length;
      assert.equal(count("conversation.opened"), 1);
      assert.equal(count("message.received"), 4, "mỗi tin khách một dòng");
      assert.equal(count("ai.replied"), 4);
      assert.ok(ev.filter((e) => e.type === "ai.replied").every((e) => typeof (e.payload as { responseMs?: unknown }).responseMs === "number" && e.actorKind === "AI"));
      assert.ok(count("quote.given") >= 1, "calculate_cart ⇒ đã báo giá");
      assert.equal(count("customer.identified"), 1);
      const drafted = ev.find((e) => e.type === "order.drafted")!;
      const confirmed = ev.find((e) => e.type === "order.confirmed")!;
      assert.ok(drafted.orderId?.startsWith("erp-"), "đơn nháp thật mang mã đơn ERP");
      assert.equal(drafted.amountVnd, 1_150_000, "2 × 400.000 + 1 × 350.000");
      assert.equal(confirmed.orderId, drafted.orderId);
      assert.equal(confirmed.amountVnd, 1_150_000);
      assert.ok(ev.every((e) => e.channel === "WEB" && e.cycle === 0 && e.schemaVersion === 1));
      // Khoá đơn ↔ hội thoại (thay cho chuỗi `source`).
      const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, confirmed.orderId!) });
      assert.equal(order?.salesConversationId, w.id);
      assert.equal(order?.origin, "AI_AGENT");
      // Ghi lại đúng các sự việc ấy ⇒ 0 dòng mới.
      const replay = ev.map((e) => ({ type: e.type as (typeof SALES_EVENT_TYPES)[number], actorKind: e.actorKind as "AI", occurredAt: e.occurredAt, key: e.dedupeKey.slice(w.id.length + 1) }));
      assert.equal(await insertSalesEvents(w.id, "WEB", 0, replay), 0, "khoá chống trùng: ghi lại không đẻ dòng");
      assert.equal((await events(w.id)).length, ev.length);

      // ── Khách sỉ: model gọi handoff_to_human ⇒ chuyển người, actor AI, mã WHOLESALE ──
      const vk2 = visitorKeyOf("se-khach-web-2-abcdefghijklmn");
      const w2 = await openConversation("WEB", { visitorKey: vk2 });
      assert.ok((await chatTurn(w2.id, "chị lấy sỉ 30kg", { channel: "WEB", visitorKey: vk2 })).ok);
      const ho = (await events(w2.id)).find((e) => e.type === "handoff.requested");
      assert.ok(ho && ho.actorKind === "AI" && ho.reasonCode === "WHOLESALE", JSON.stringify(ho));
      // Người xử lý xong ⇒ trả lại AI: actor HUMAN mang users.id (luật 34).
      await recordConversationEvent(w2.id, { type: "ai.resumed", actorKind: "HUMAN", actorUserId: admin.id, occurredAt: new Date(), key: "resume:test" });
      const resumed = (await events(w2.id)).find((e) => e.type === "ai.resumed");
      assert.equal(resumed?.actorUserId, admin.id);

      // ── AI hỏng ⇒ chuyển người do MÁY (SYSTEM, AI_DOWN), câu xin lỗi là trả lời SYSTEM ──
      setSalesChatProviderForTests(() => ({ ...fakeProvider(() => []), complete: async () => { throw new Error("HTTP 529 overloaded"); } }));
      const vk3 = visitorKeyOf("se-khach-web-3-abcdefghijklmn");
      const w3 = await openConversation("WEB", { visitorKey: vk3 });
      assert.ok((await chatTurn(w3.id, "alo shop", { channel: "WEB", visitorKey: vk3 })).ok);
      const ev3 = await events(w3.id);
      const down = ev3.find((e) => e.type === "handoff.requested");
      assert.ok(down && down.actorKind === "SYSTEM" && down.reasonCode === "AI_DOWN", JSON.stringify(down));

      // ── Lỗi ghi sổ KHÔNG làm hỏng lượt: hàm gốc trả kết quả nguyên vẹn dù hội thoại không tồn tại ──
      const wrapped = withTurnEvents(async (id: string) => ({ ok: true as const, id }));
      assert.deepEqual(await wrapped("khong-co-hoi-thoai-nay"), { ok: true, id: "khong-co-hoi-thoai-nay" });

      // ── Khung THỬ: sự kiện vẫn ghi (kênh TEST, cờ simulated) nhưng KHÔNG gắn đơn nào ──
      setSalesChatProviderForTests(() => fakeProvider(shopScript({ chaMuc, ruocTom })));
      const t = await openConversation("TEST", { createdBy: ADMIN_EMAIL });
      for (const text of ["Chả mực bao nhiêu?", "Cho chị 2 gói, thêm 1 ruốc tôm.", "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội"]) assert.ok((await chatTurn(t.id, text, { channel: "TEST" })).ok);
      const evT = await events(t.id);
      const simDraft = evT.find((e) => e.type === "order.drafted");
      assert.ok(simDraft && simDraft.orderId === null && (simDraft.payload as { simulated?: boolean }).simulated === true && simDraft.channel === "TEST");
      const linked = await db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.salesConversationId, t.id)));
      assert.equal(linked.length, 0, "khung thử không tạo / không gắn đơn");

      // ── Màn hiệu quả trên đúng ba hội thoại thật (khung thử bị loại) ──
      const p0 = await loadAiSalesPerformance(ORG, { withMoney: true });
      assert.ok(p0.measuredSince, "sổ đã có số");
      assert.equal(p0.cohorts.total.conversations, 3, "w (chốt) · w2 (sỉ ⇒ người) · w3 (AI hỏng ⇒ người); khung thử KHÔNG tính");
      assert.deepEqual(p0.cohorts.aiOnly, { conversations: 1, quoted: 1, identified: 1, drafted: 1, confirmed: 1 });
      assert.equal(p0.cohorts.aiThenHuman.conversations, 2);
      assert.equal(p0.rates.aiResolution, null, "3 hội thoại < mẫu tối thiểu ⇒ để trống");
      assert.deepEqual(p0.handoffReasons.map((h) => h.code).sort(), ["AI_DOWN", "WHOLESALE"]);
      assert.equal(p0.orders.confirmed, 1);
      assert.equal(p0.orders.confirmedValueVnd, 1_150_000);
      assert.equal(p0.orders.delivered, 0);
      assert.equal(p0.orders.pending, 1, "chưa giao ⇒ đang giao / chưa rõ, không phải hoàn");
      assert.equal(p0.orders.deliveryRate, null, "chưa đơn nào ngã ngũ ⇒ không có tỷ lệ");
      assert.equal(p0.upsell.offered, 0);
      assert.equal(p0.coverage.conversationsWithEvents, p0.coverage.conversationsActive, "mọi hội thoại có lượt đều có dòng trong sổ");
      assert.ok(p0.cost && (p0.cost.sellingVnd !== null || p0.cost.unknownCost > 0), "chi phí AI bán hàng đọc từ sổ AI");
      assert.equal(p0.human?.estimatedSavingVnd, null, "chưa khai chi phí người ⇒ trống");
      // Người không có quyền thấy tiền ⇒ không có ô tiền nào.
      assert.equal((await loadAiSalesPerformance(ORG, { withMoney: false })).cost, null);

      // Giao bằng phiếu ký nhận ⇒ ORDER_OUTCOME = DELIVERED ⇒ doanh thu giao thành công, chi phí / đơn giao có số.
      const delivered = await confirmManualDeliveryCore(admin, confirmed.orderId!, { signedAt: new Date().toISOString(), receiverName: "Nguyễn Thị Lan" });
      assert.ok(delivered.ok, JSON.stringify(delivered));
      assert.ok("ok" in (await savePerformanceSettings(admin, { humanCostPerConversationVnd: 15_000, reason: "lương 9 triệu ÷ 600 hội thoại" })));
      assert.ok("error" in (await savePerformanceSettings(admin, { humanCostPerConversationVnd: 15_000, reason: "" })), "khai số phải kèm cách tính");
      const p1 = await loadAiSalesPerformance(ORG, { withMoney: true });
      assert.equal(p1.orders.delivered, 1);
      assert.equal(p1.orders.deliveredRevenueVnd, 1_150_000);
      assert.equal(p1.orders.deliveryRate, 1);
      assert.equal(p1.human?.estimatedSavingVnd, 15_000, "1 hội thoại AI tự xử lý × 15.000 ₫");
      if (p1.cost?.sellingVnd !== null && p1.cost) assert.equal(p1.cost.perDeliveredOrderVnd, p1.cost.sellingVnd, "1 đơn giao ⇒ chi phí / đơn = tổng chi phí bán hàng");
    } finally {
      setSalesChatProviderForTests(null);
    }
  });
  console.log("✓ Hiệu quả AI bán hàng · tổ chức thật: phễu hai nhóm trên đúng 3 hội thoại thật (khung thử loại) · lý do chuyển người · đơn bot chốt chưa giao ⇒ đang giao, giao bằng phiếu ⇒ DELIVERED + doanh thu · chi phí / đơn giao · tiền ẩn với người không quyền · tiết kiệm chỉ khi chủ shop khai kèm cách tính");
  console.log("✓ Sổ sự kiện bán hàng · tổ chức thật: web hỏi giá → SĐT → nháp → chốt (mỗi bước một dòng có mốc, đơn mang khoá hội thoại + origin AI_AGENT) · ghi lại 0 dòng mới · chuyển người do AI (WHOLESALE) / do máy (AI_DOWN) · trả lại AI mang users.id · lỗi ghi sổ không hỏng lượt · khung thử không gắn đơn");
}

export async function testSalesEvents() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop sổ sự kiện", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "SoSuKien@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}
