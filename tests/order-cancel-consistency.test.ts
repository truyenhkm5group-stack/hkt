/**
 * ═══════════ KHÁCH HUỶ ĐƠN — NHẤT QUÁN TỪ HỘI THOẠI TỚI CSDL (sự cố #189A435E, chủ shop 10/10/2026) ═══════════
 *
 * Sự cố: khách HSLC xin huỷ, AI «đồng ý huỷ», khung đơn vẫn «ĐÃ XÁC NHẬN». Nguyên nhân gốc: bot KHÔNG có công cụ huỷ — `mark_declined`
 * chỉ gắn cờ, và chỉ cho đơn nằm trong `state` của bot (đơn nhân viên / bộ ghi đơn lên cho hội thoại thì không gắn gì, trả «khách từ
 * chối» trơn), lời nhắc không cấm nói «đã huỷ», và chữ model viết KÈM lời gọi công cụ tới thẳng khách.
 *
 * Bài này khoá luật mới (rescue thất bại ⇒ tự huỷ khi đủ điều kiện theo vòng đời vận đơn):
 *  1. THUẦN — `customerCancelPlan` (chưa vận đơn · vận đơn ERP chưa lấy · đã bàn giao · xuất kho tay · lượt tạo chưa rõ · vận đơn
 *     lạ · nhiều lần gửi · đơn đồng bộ · đã khép), lời khai huỷ idempotent.
 *  2. CSDL THẬT (tổ chức `oc-cx`, tự cấp, tự dọn) — chưa vận đơn: lượt giữ đơn rồi huỷ; rescue thành công ⇒ không huỷ; tin / webhook
 *     trùng ⇒ đúng MỘT lần huỷ, MỘT dòng nhật ký, MỘT sự kiện; tồn khả dụng trả lại; ORDER_OUTCOME = CANCELLED; vận đơn chưa lấy ⇒
 *     hãng xác nhận huỷ (phong bì OK) mới huỷ đơn; hãng từ chối (HTTP 200 + error) / đứt mạng ⇒ KHÔNG huỷ, hàng ngoại lệ + cảnh báo,
 *     gọi lại không nhân đôi; đã lấy hàng ⇒ không gọi hãng, chuyển người; ghi hỏng ⇒ thử lại rồi ngoại lệ, bot KHÔNG được nói đã huỷ;
 *     đơn #189A435E-dáng (đơn gắn hội thoại, không nằm trong state) ⇒ vẫn tìm thấy.
 *  3. ENGINE THẬT (`chatTurn`, model giả) — chữ model viết cùng tin với `cancel_order` («Dạ em huỷ cho chị rồi ạ») KHÔNG tới khách;
 *     ghi hỏng ⇒ khách nhận câu chuyển người, không có chữ «đã huỷ».
 *  4. ĐỐI SOÁT — chạy thử không ghi gì và đếm đúng dấu vết × phân loại; `--apply` chỉ chạm loại đã rõ; ops-vps khai đủ.
 *
 * Không gọi mạng (luật 65): hãng vận chuyển là máy chủ giả tiêm vào `deps.fetch`. Không mốc tuyệt đối (luật 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { createShipmentCore } from "@/lib/carriers/engine";
import { clearMemo } from "@/lib/cache";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { VTP_PARTNER_API } from "@/lib/constants/carrier-vtp";
import { cancellationLine, customerCancelPlan, orderCancellationOf, withCancelOutcome, withCancelRequest, withRescueResult, type CancelAttemptInput } from "@/lib/constants/order-cancel";
import { orderReviewOf, reviewCodes } from "@/lib/constants/order-review";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { cancelEvidenceOf, reconcileOrderCancels, reconcileSummaryLines } from "@/lib/records/order-cancel-reconcile";
import { executeCustomerCancel } from "@/lib/records/order-cancel";
import { createManualOrderCore, createOrderAsAgent } from "@/lib/records/order-create";
import { stockFor } from "@/lib/sales-chatbot/catalog";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { executeTool, type ChatState } from "@/lib/sales-chatbot/tools";
import { parseReconcileArgs } from "@/scripts/order-cancel-reconcile";
import { runGoldenCases, say, tool, type GoldenCase } from "./sales-agent-golden/harness";

const ORG = "oc-cx";
const ORG_SECRETS_KEY = "khoa-kiem-thu-huy-don-0123456789abcdefghijklmnopqrstuvwxyz-abc";
const VTP_PASSWORD = "MatKhau-VTP-huy-don-4321";
const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };

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

// ─────────────────────────── 1. THUẦN ───────────────────────────

const created = (extra: Partial<CancelAttemptInput> = {}): CancelAttemptInput => ({ stage: "PENDING", raw: { carrierCreate: { state: "CREATED", reference: "R-1", by: null, at: "x" } }, handoffKnown: false, createdByErp: true, createState: "CREATED", hasTrackingCode: true, carrierCancellable: true, ...extra });

export function testOrderCancelPure() {
  const plan = (p: Partial<Parameters<typeof customerCancelPlan>[0]>) => customerCancelPlan({ manual: true, stage: "CONFIRMED", attempts: [], manualIssues: 0, ...p });
  assert.deepEqual(plan({}), { kind: "CANCEL_NOW" }, "chưa tạo vận đơn ⇒ huỷ ngay");
  assert.deepEqual(plan({ stage: "NEW" }), { kind: "CANCEL_NOW" }, "đơn nháp ⇒ huỷ ngay");
  assert.deepEqual(plan({ stage: "CANCELLED" }), { kind: "ALREADY_CANCELLED" }, "đã huỷ ⇒ không làm gì (idempotent)");
  assert.deepEqual(plan({ manual: false }), { kind: "NEEDS_HUMAN", code: "NOT_ERP_ORDER" }, "đơn đồng bộ ⇒ huỷ ở nguồn");
  assert.deepEqual(plan({ stage: "DELIVERED" }), { kind: "NEEDS_HUMAN", code: "FINAL_STAGE" });
  assert.deepEqual(plan({ attempts: [created()] }), { kind: "CARRIER_CANCEL", attemptIndex: 0 }, "vận đơn ERP chưa lấy ⇒ gọi hãng huỷ");
  assert.deepEqual(plan({ attempts: [created({ handoffKnown: true })] }), { kind: "NEEDS_HUMAN", code: "HANDED_TO_CARRIER" }, "có mốc lấy hàng / sự kiện đã-cầm-hàng ⇒ người");
  assert.deepEqual(plan({ attempts: [created({ stage: "IN_TRANSIT" })] }), { kind: "NEEDS_HUMAN", code: "HANDED_TO_CARRIER" }, "chặng trong CARRIER_HANDOFF_STAGES ⇒ người");
  assert.deepEqual(plan({ attempts: [created({ stage: "RETURNING" })] }), { kind: "NEEDS_HUMAN", code: "HANDED_TO_CARRIER" });
  assert.deepEqual(plan({ attempts: [created({ stage: "CANCELLED", handoffKnown: true })] }), { kind: "NEEDS_HUMAN", code: "HANDED_TO_CARRIER" }, "lần gửi đã huỷ SAU khi lấy — hàng có thể đang về ⇒ người");
  assert.deepEqual(plan({ manualIssues: 1 }), { kind: "NEEDS_HUMAN", code: "LEFT_WAREHOUSE_NO_HANDOFF" }, "xuất kho tay chưa bàn giao ⇒ người");
  assert.deepEqual(plan({ attempts: [created({ createState: "UNKNOWN", hasTrackingCode: false })] }), { kind: "NEEDS_HUMAN", code: "ATTEMPT_UNRESOLVED" }, "lượt tạo chưa rõ ⇒ người");
  assert.deepEqual(plan({ attempts: [created({ createdByErp: false, createState: null, raw: {} })] }), { kind: "NEEDS_HUMAN", code: "FOREIGN_SHIPMENT" });
  assert.deepEqual(plan({ attempts: [created(), created()] }), { kind: "NEEDS_HUMAN", code: "MULTIPLE_ATTEMPTS" });
  assert.deepEqual(plan({ attempts: [created({ carrierCancellable: false })] }), { kind: "NEEDS_HUMAN", code: "CARRIER_NOT_CANCELLABLE" });
  assert.deepEqual(plan({ attempts: [created({ raw: { carrierCreate: { state: "CREATED" }, carrierCancel: { state: "ACCEPTED", at: "x", reason: "r", message: "m" } } })] }), { kind: "CANCEL_NOW" }, "hãng ĐÃ nhận lệnh huỷ ⇒ lần gửi thôi giữ đơn ⇒ huỷ đơn");
  assert.deepEqual(plan({ attempts: [created({ stage: "CANCELLED" })] }), { kind: "CANCEL_NOW" }, "vận đơn đã bị hãng huỷ (chưa lấy) ⇒ huỷ đơn");

  // Lời khai huỷ: yêu cầu → giữ đơn → kết cục; gửi lại không đổi.
  const at = new Date().toISOString();
  const r1 = withCancelRequest({ origin: "ERP_MANUAL" }, { at, quote: "huỷ giúp em", reason: "Đổi ý", conversationId: "c1", rescue: true });
  assert.ok(r1.changed);
  assert.equal(withCancelRequest(r1.raw, { at: "khác", quote: "huỷ lần 2", reason: "x", conversationId: "c1", rescue: true }).changed, false, "yêu cầu đang mở ⇒ giữ mốc đầu");
  const r2 = withRescueResult(r1.raw, { result: "FAILED", at, quote: "vẫn huỷ" });
  assert.ok(r2.changed);
  assert.equal(withRescueResult(r2.raw, { result: "SUCCEEDED", at, quote: null }).changed, false, "lượt giữ đã quyết ⇒ không đổi");
  const actor = { kind: "AI" as const, userId: null, name: "bot" };
  const r3 = withCancelOutcome(r2.raw, { status: "CANCELLED", at, actor });
  const c3 = orderCancellationOf(r3.raw);
  assert.ok(c3 && c3.status === "CANCELLED" && c3.cancelledAt === at && c3.requestedAt === at && c3.requestedBy === "CUSTOMER" && c3.rescue.result === "FAILED" && c3.actor?.userId === null && c3.attempts === 1, JSON.stringify(c3));
  assert.equal(withCancelOutcome(r3.raw, { status: "CANCELLED", at: "sau", actor }).changed, false, "huỷ hai lần ⇒ không ghi lại");
  const ex = withCancelOutcome(r1.raw, { status: "EXCEPTION", at, actor, exception: { code: "CARRIER_REJECTED", detail: "hãng từ chối" } });
  assert.equal(withCancelOutcome(ex.raw, { status: "EXCEPTION", at: "sau", actor, exception: { code: "CARRIER_REJECTED", detail: "hãng từ chối" } }).changed, false, "cùng ngoại lệ ⇒ không ghi lại");
  assert.match(cancellationLine(c3) ?? "", /Đã huỷ · khách yêu cầu · AI ghi/);
  console.log("✓ Huỷ đơn — luật thuần: 15 nhánh vòng đời vận đơn · lời khai huỷ idempotent (yêu cầu · giữ đơn · kết cục)");
}

// ─────────────────────────── Máy chủ Viettel Post giả ───────────────────────────

type CancelMode = "ok" | "reject" | "network";
function fakeVtp(state: { cancel: CancelMode; next: number }) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = url.slice(VTP_PARTNER_API.length + 1);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push(path);
    if (path === "user/Login") return json({ status: 200, error: false, message: "OK", data: { token: "tok-ngan" } });
    if (path === "user/ownerconnect") return json({ status: 200, error: false, message: "OK", data: { token: "tok-dai" } });
    if (path === "user/listInventory") return json({ status: 200, error: false, message: "OK", data: [{ groupaddressId: 1, name: "Kho", address: "1 Phố Thử" }] });
    if (path === "order/getPriceAllNlp") return json({ status: 200, error: false, message: "OK", data: [{ MA_DV_CHINH: "PHS", TEN_DICHVU: "Nhanh", GIA_CUOC: 20000 }] });
    if (path === "order/createOrderNlp") return json({ status: 200, error: false, message: "OK", data: { ORDER_NUMBER: String(state.next++), MONEY_COLLECTION: body?.MONEY_COLLECTION, MONEY_TOTAL: 16500 } });
    if (path === "order/UpdateOrder") {
      if (state.cancel === "network") throw new TypeError("fetch failed: socket hang up");
      // HTTP 200 nhưng phong bì báo lỗi — ĐÚNG kiểu Viettel Post từ chối (AGENTS mục 5: đọc error / status, không tin HTTP).
      if (state.cancel === "reject") return json({ status: 204, error: true, message: "Đơn đã được lấy, không thể huỷ", data: null });
      return json({ status: 200, error: false, message: "Hủy đơn thành công", data: null });
    }
    return json({ status: 404, error: true, message: "không có" }, 404);
  };
  return { fetch: fetchImpl, calls, count: (p: string) => calls.filter((c) => c === p).length };
}

// ─────────────────────────── 2. CSDL THẬT ───────────────────────────

export async function testOrderCancelDb() {
  await cleanupOrg(ORG);
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  try {
    await provisionOrganization({ code: ORG, name: "Thử huỷ đơn", plan: "standard", modules: ["customers", "products", "orders", "logistics"], admin: { email: `admin@${ORG}.local`, name: "QT huỷ đơn", password: "HuyDon@12345" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT huỷ đơn", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Thử huỷ đơn", isHome: false }, modules: [...enabled] } as SessionUser;
      const [cust] = await db.insert(schema.customers).values({ name: "Chị Hoa", phone: "0942000311", address: "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội", province: "Hà Nội" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-oc-prod", name: "Chả mực", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-oc-var", productId: "erp-oc-prod", sku: "CM-1KG", size: "1kg", retailPrice: 300_000, weight: 1000 });
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-OC", totalQuantity: 50, createdBy: u.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: "erp-oc-var", quantity: 50, unitCost: 150_000 });

      const input = (stage: "NEW" | "CONFIRMED", qty = 2) => ({ customerId: cust.id, stage, lines: [{ variantId: "erp-oc-var", quantity: qty, unitPrice: 300_000, discount: 0 }], orderDiscount: 0, shippingFee: 30_000, note: "", channel: "Chatbot web", recipient: { name: "Chị Hoa", phone: "0942000311", address: "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội", province: "Hà Nội" } });
      let seq = 0;
      const newOrder = async (stage: "NEW" | "CONFIRMED" = "CONFIRMED", qty = 2) => {
        const r = await createOrderAsAgent(AGENT, input(stage, qty), { pricing: "RETAIL", allowShortStock: true, idempotencyKey: `oc-${++seq}` });
        assert.ok(r.ok, JSON.stringify(r));
        return r.id;
      };
      const row = async (id: string) => (await db.select({ stage: schema.orders.stage, raw: schema.orders.raw }).from(schema.orders).where(eq(schema.orders.id, id)))[0];
      const auditCount = async (action: string, id: string) => (await db.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.entityId, id)))).length;
      const events = async (name: string, id: string) => (await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, name), eq(schema.domainEvents.subjectId, id)))).length;
      const history = async (id: string) => (await db.select({ id: schema.orderStatusHistory.id }).from(schema.orderStatusHistory).where(and(eq(schema.orderStatusHistory.orderId, id), eq(schema.orderStatusHistory.status, 6)))).length;
      const notes = async (id: string) => (await db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.entityType, "ORDER"), eq(schema.notifications.entityId, id)))).length;
      const outcome = async (id: string) =>
        (await db.select({ o: ORDER_OUTCOME }).from(schema.orders).leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT)).where(eq(schema.orders.id, id)).groupBy(schema.orders.id, schema.shipments.id))[0]?.o;
      const available = async () => {
        clearMemo();
        return (await stockFor(["erp-oc-var"])).get("erp-oc-var")?.available ?? null;
      };
      const cfg = parseSalesChatbotConfig(null);
      const ctx = (state: ChatState, last: string, turn: number, conversationId = "conv-oc-1") => ({ conversationId, channel: "WEB" as const, config: cfg, state, lastUserText: last, agent: AGENT, turn });
      const body = (o: { content: string }) => JSON.parse(o.content) as Record<string, unknown>;

      // ── ① CHƯA TẠO VẬN ĐƠN: giữ đơn ⇒ khách vẫn huỷ ⇒ «Đã huỷ» ──
      const before = await available();
      const o1 = await newOrder();
      assert.equal(await available(), (before ?? 0) - 2, "đơn đã xác nhận giữ 2 món ở khả dụng");
      const st1: ChatState = { confirmed: { orderId: o1, simulated: false, total: 630_000, at: new Date().toISOString() } };
      const t1 = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "huỷ đơn giúp em", reason: "Đổi ý" }, ctx(st1, "shop ơi huỷ đơn giúp em nhé", 1));
      assert.ok(!t1.isError && body(t1).cancelled === false && body(t1).step === "RESCUE", t1.content);
      assert.equal((await row(o1)).stage, "CONFIRMED", "lần CANCEL đầu KHÔNG huỷ — giữ đơn trước");
      assert.deepEqual(reviewCodes(orderReviewOf((await row(o1)).raw)), ["CUSTOMER_CANCELLED"], "cờ «khách huỷ» ⇒ khung đơn «CẦN XÁC THỰC», không còn «ĐÃ XÁC NHẬN» trơn");
      assert.equal(orderCancellationOf((await row(o1)).raw)?.rescue.result, "PENDING");
      // Model gọi lại TRONG CÙNG lượt để bỏ qua bước giữ đơn ⇒ vẫn RESCUE, không ghi thêm.
      const t1b = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "huỷ đơn giúp em" }, ctx(t1.state, "shop ơi huỷ đơn giúp em nhé", 1));
      assert.equal(body(t1b).step, "RESCUE");
      assert.equal(await auditCount("ORDER_CANCEL_REQUEST", o1), 1);
      // Lời khách không có trong câu cuối ⇒ từ chối (model không tự huỷ thay khách).
      const fake = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "huỷ luôn đi" }, ctx(t1.state, "để chị nghĩ thêm", 2));
      assert.ok(fake.isError && (await row(o1)).stage === "CONFIRMED", fake.content);
      const t2 = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "vẫn huỷ" }, ctx(t1.state, "thôi em vẫn huỷ nhé", 2));
      assert.ok(!t2.isError && body(t2).cancelled === true && !t2.requireHuman, t2.content);
      const r1 = await row(o1);
      assert.equal(r1.stage, "CANCELLED", "khách vẫn huỷ ⇒ tự «Đã huỷ»");
      const c1 = orderCancellationOf(r1.raw);
      assert.ok(c1 && c1.status === "CANCELLED" && c1.requestedBy === "CUSTOMER" && c1.actor?.kind === "AI" && c1.actor.userId === null && c1.rescue.result === "FAILED" && c1.requestedAt && c1.cancelledAt && c1.reason === "Đổi ý" && c1.conversationId === "conv-oc-1", JSON.stringify(c1));
      assert.equal(orderReviewOf(r1.raw), null, "huỷ ⇒ cờ cần kiểm gỡ, vào vết");
      assert.equal(await available(), before, "huỷ ⇒ tồn khả dụng trả lại (RESERVED_IN_WAREHOUSE bỏ đơn CANCELLED)");
      assert.equal(await outcome(o1), "CANCELLED", "ORDER_OUTCOME = CANCELLED ⇒ ra khỏi giao thành công / doanh thu");
      assert.equal(t2.state.stage, "DECLINED");
      assert.ok(!t2.state.cancelRequest && t2.state.cancelledOrders?.some((x) => x.orderId === o1));

      // ── ② TIN / WEBHOOK TRÙNG: lượt cũ chạy lại (state cũ còn yêu cầu) + hai lượt song song ⇒ đúng MỘT lần huỷ ──
      const dup = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "vẫn huỷ" }, ctx(t1.state, "thôi em vẫn huỷ nhé", 2));
      assert.ok(body(dup).cancelled === true || body(dup).no_open_order === true, dup.content);
      assert.deepEqual([await auditCount("ORDER_MANUAL_CANCEL", o1), await events("order.cancelled", o1), await history(o1)], [1, 1, 1], "một nhật ký · một sự kiện · một dòng lịch sử");
      const o2 = await newOrder();
      const both = await Promise.all([1, 2].map(() => executeCustomerCancel({ orderId: o2, agent: AGENT, actorKind: "AI", conversationId: "conv-oc-2", quote: "huỷ", reason: "Khách huỷ", rescue: "FAILED" })));
      assert.deepEqual(both.map((b) => b.status).sort(), ["ALREADY_CANCELLED", "CANCELLED"], JSON.stringify(both));
      assert.deepEqual([await auditCount("ORDER_MANUAL_CANCEL", o2), await events("order.cancelled", o2), await history(o2)], [1, 1, 1], "song song ⇒ khoá dòng, lượt sau thấy «Đã huỷ»");

      // ── ③ RESCUE THÀNH CÔNG: khách đồng ý giữ ⇒ không huỷ ──
      const o3 = await newOrder();
      const st3: ChatState = { confirmed: { orderId: o3, simulated: false, total: 630_000, at: new Date().toISOString() } };
      const k1 = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "huỷ đơn" }, ctx(st3, "em muốn huỷ đơn", 1, "conv-oc-3"));
      assert.equal(body(k1).step, "RESCUE");
      const k2 = await executeTool("cancel_order", { decision: "KEEP", customer_words: "thôi giữ đơn" }, ctx(k1.state, "ok thôi giữ đơn giao chị nhé", 2, "conv-oc-3"));
      assert.ok(body(k2).kept === true && body(k2).cancelled === false, k2.content);
      const r3 = await row(o3);
      assert.equal(r3.stage, "CONFIRMED", "giữ đơn thành công ⇒ đơn không đổi");
      assert.equal(orderCancellationOf(r3.raw)?.rescue.result, "SUCCEEDED");
      assert.equal(await auditCount("ORDER_CANCEL_RESCUE", o3), 1);
      assert.ok(!k2.state.cancelRequest);

      // ── ④ ĐƠN #189A435E-DÁNG: đơn nhân viên tạo cho hội thoại, KHÔNG nằm trong state bot ⇒ vẫn tìm thấy ──
      const staff = await createManualOrderCore(admin, input("CONFIRMED", 1));
      assert.ok(staff.ok);
      await db.update(schema.orders).set({ salesConversationId: "conv-oc-4" }).where(eq(schema.orders.id, staff.id));
      const d1 = await executeTool("mark_declined", { reason: "Khách huỷ" }, ctx({}, "thôi chị không lấy nữa huỷ giúp chị", 1, "conv-oc-4"));
      assert.ok(Array.isArray(body(d1).order_flagged) && (body(d1).order_flagged as unknown[]).length === 1 && body(d1).step === "RESCUE", `bản cũ trả «khách từ chối» trơn ở đây: ${d1.content}`);
      assert.equal((await row(staff.id)).stage, "CONFIRMED", "mark_declined KHÔNG huỷ — chỉ mở lượt giữ đơn");
      const d2 = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "huỷ đi" }, ctx(d1.state, "huỷ đi em", 2, "conv-oc-4"));
      assert.ok(body(d2).cancelled === true && (await row(staff.id)).stage === "CANCELLED", d2.content);

      // ── ⑤ VẬN ĐƠN: kết nối Viettel Post giả ──
      const vtpState = { cancel: "ok" as CancelMode, next: 700000001 };
      const vtp = fakeVtp(vtpState);
      const deps = { fetch: vtp.fetch };
      const saved = await saveConnection(admin, { connectorKey: "viettelpost-carrier", settings: { username: "0912345678", senderName: "Shop Thử", senderPhone: "0912345678", senderAddress: "1 Phố Thử, Hoàn Kiếm, Hà Nội" }, secrets: { password: VTP_PASSWORD } });
      assert.ok("ok" in saved, JSON.stringify(saved));
      assert.ok("ok" in (await testOrgConnection(admin, "viettelpost-carrier", { tester: { fetch: vtp.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "viettelpost-carrier", "ACTIVE")));
      const shipped = async () => {
        const id = await newOrder("CONFIRMED", 1);
        const s = await createShipmentCore(admin, "VTP", id, { weightGrams: 1000, cod: 330_000, serviceCode: "PHS", note: "" }, deps);
        assert.ok(s.ok, JSON.stringify(s));
        return { id, shipmentId: s.shipmentId };
      };
      const cancelCtx = (orderId: string) => ({ orderId, agent: AGENT, actorKind: "AI" as const, conversationId: "conv-oc-5", quote: "huỷ", reason: "Khách huỷ", rescue: "FAILED" as const, deps });

      // ⑤a đã tạo vận đơn, chưa lấy, hãng XÁC NHẬN huỷ ⇒ huỷ đơn.
      const s1 = await shipped();
      const ok1 = await executeCustomerCancel(cancelCtx(s1.id));
      assert.ok(ok1.status === "CANCELLED" && ok1.carrier?.carrier === "VTP", JSON.stringify(ok1));
      assert.equal(vtp.count("order/UpdateOrder"), 1);
      const [sh1] = await db.select({ raw: schema.shipments.raw, stage: schema.shipments.stage }).from(schema.shipments).where(eq(schema.shipments.id, s1.shipmentId));
      assert.equal((sh1.raw as { carrierCancel?: { by: unknown } }).carrierCancel?.by, null, "lời nhận lệnh huỷ ghi tác nhân MÁY (by = null)");
      assert.equal(sh1.stage, "PENDING", "không tự đặt «Đã huỷ» cho vận đơn — chờ mã huỷ của webhook");
      assert.equal((await row(s1.id)).stage, "CANCELLED");
      // Gọi lại ⇒ không gọi hãng lần hai.
      assert.equal((await executeCustomerCancel(cancelCtx(s1.id))).status, "ALREADY_CANCELLED");
      assert.equal(vtp.count("order/UpdateOrder"), 1, "trùng ⇒ không gửi lệnh huỷ thứ hai");

      // ⑤b hãng TỪ CHỐI (HTTP 200 + error) ⇒ KHÔNG huỷ, hàng ngoại lệ + cảnh báo; gọi lại không nhân đôi.
      const s2 = await shipped();
      vtpState.cancel = "reject";
      const ex2 = await executeCustomerCancel(cancelCtx(s2.id));
      assert.ok(ex2.status === "EXCEPTION" && ex2.code === "CARRIER_REJECTED" && ex2.alerted, JSON.stringify(ex2));
      const r2 = await row(s2.id);
      assert.equal(r2.stage, "CONFIRMED", "hãng chưa xác nhận ⇒ KHÔNG huỷ đơn");
      assert.ok(reviewCodes(orderReviewOf(r2.raw)).includes("CANCEL_BLOCKED"), "vào hàng ngoại lệ «Cần người kiểm»");
      assert.equal(orderCancellationOf(r2.raw)?.exception?.code, "CARRIER_REJECTED");
      assert.equal(await notes(s2.id), 1, "cảnh báo người: một thông báo");
      assert.equal(await auditCount("ORDER_CANCEL_EXCEPTION", s2.id), 1);
      await executeCustomerCancel(cancelCtx(s2.id));
      assert.deepEqual([await notes(s2.id), await auditCount("ORDER_CANCEL_EXCEPTION", s2.id), orderReviewOf((await row(s2.id)).raw)?.entries.filter((e) => e.code === "CANCEL_BLOCKED").length], [1, 1, 1], "gọi lại cùng lỗi ⇒ không thêm dòng nào");

      // ⑤c đứt mạng ⇒ KHÔNG BIẾT hãng đã huỷ chưa ⇒ ngoại lệ, không huỷ đơn.
      const s3 = await shipped();
      vtpState.cancel = "network";
      const ex3 = await executeCustomerCancel(cancelCtx(s3.id));
      assert.ok(ex3.status === "EXCEPTION" && ex3.code === "CARRIER_UNKNOWN" && (await row(s3.id)).stage === "CONFIRMED", JSON.stringify(ex3));
      vtpState.cancel = "ok";

      // ⑤d ĐÃ LẤY HÀNG (mốc lấy hàng của ĐVVC) ⇒ không gọi hãng, chuyển người.
      const s4 = await shipped();
      await db.update(schema.shipments).set({ pickedUpAt: new Date() }).where(eq(schema.shipments.id, s4.shipmentId));
      const calls4 = vtp.count("order/UpdateOrder");
      const ex4 = await executeCustomerCancel(cancelCtx(s4.id));
      assert.ok(ex4.status === "EXCEPTION" && ex4.code === "HANDED_TO_CARRIER", JSON.stringify(ex4));
      assert.equal(vtp.count("order/UpdateOrder"), calls4, "đã bàn giao ⇒ không gọi hãng");
      assert.equal((await row(s4.id)).stage, "CONFIRMED");

      // ── ⑥ GHI HỎNG ⇒ thử lại rồi ngoại lệ; bot KHÔNG được nói đã huỷ ──
      const o6 = await newOrder();
      await db.execute(sql.raw(`create or replace function oc_fail_cancel() returns trigger as $$ begin if new.stage = 'CANCELLED' and old.id = '${o6}' then raise exception 'oc: ghi hỏng thử'; end if; return new; end $$ language plpgsql`));
      await db.execute(sql.raw(`create trigger oc_fail_cancel before update on orders for each row execute function oc_fail_cancel()`));
      try {
        const st6: ChatState = { confirmed: { orderId: o6, simulated: false, total: 630_000, at: new Date().toISOString() } };
        const w1 = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "huỷ đơn" }, ctx(st6, "huỷ đơn giúp chị", 1, "conv-oc-6"));
        const w2 = await executeTool("cancel_order", { decision: "CANCEL", customer_words: "vẫn huỷ" }, ctx(w1.state, "chị vẫn huỷ", 2, "conv-oc-6"));
        const b2 = body(w2);
        assert.ok(b2.cancelled === false && b2.handed_to_staff === true && w2.requireHuman, w2.content);
        assert.match(String(b2.instruction), /KHÔNG nói đã huỷ/, "kết quả công cụ buộc model không khẳng định");
        const r6 = await row(o6);
        assert.equal(r6.stage, "CONFIRMED", "ghi hỏng ⇒ đơn KHÔNG đổi (không hỏng im lặng thành «đã huỷ»)");
        assert.equal(orderCancellationOf(r6.raw)?.exception?.code, "WRITE_FAILED", "lý do vào hàng ngoại lệ");
        assert.equal(await notes(o6), 1, "cảnh báo người");
        assert.ok(w2.state.cancelRequest, "yêu cầu còn mở — lượt sau / người xử lý tiếp");
      } finally {
        await db.execute(sql.raw(`drop trigger if exists oc_fail_cancel on orders`));
      }

      // ── ⑦ ĐỐI SOÁT: chạy thử không ghi gì; --apply chỉ chạm loại đã rõ ──
      // Dáng #189A435E thuần: hội thoại ghi khách từ chối SAU khi đơn lên, đơn không cờ, vẫn «Đã xác nhận».
      const o7 = await newOrder();
      await db.insert(schema.salesChatConversations).values({ id: "conv-oc-7", channel: "FANPAGE", status: "OPEN", state: { declined: { reason: "Khách huỷ", at: new Date(Date.now() + 60_000).toISOString() } } }).onConflictDoNothing();
      await db.update(schema.orders).set({ salesConversationId: "conv-oc-7" }).where(eq(schema.orders.id, o7));
      const auditBefore = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs))[0].n;
      const dry = await reconcileOrderCancels({ apply: false, days: 2 });
      assert.equal((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs))[0].n, auditBefore, "chạy thử: không một dòng nhật ký");
      assert.equal((await row(o7)).stage, "CONFIRMED", "chạy thử: không đổi đơn");
      assert.equal(dry.byEvidence.AI_AGREED, 1, JSON.stringify(dry));
      assert.equal(dry.matrix["AI_AGREED:CANCEL_NOW"], 1);
      assert.ok(dry.byEvidence.EXCEPTION_OPEN >= 3 && (dry.byBlock.HANDED_TO_CARRIER ?? 0) >= 1, JSON.stringify(dry));
      assert.ok(reconcileSummaryLines(ORG, dry).every((l) => !l.includes(o7) && !l.includes("0942000311")), "tóm tắt chỉ số đếm — không mã đơn / SĐT");
      const app = await reconcileOrderCancels({ apply: true, days: 2 });
      assert.equal(app.applied.cancelled, 1, JSON.stringify(app));
      assert.ok(app.applied.skipped >= 3, "ngoại lệ đang có người cầm ⇒ bỏ qua");
      const r7 = await row(o7);
      assert.ok(r7.stage === "CANCELLED" && orderCancellationOf(r7.raw)?.actor?.kind === "SYSTEM", JSON.stringify(orderCancellationOf(r7.raw)));
      assert.equal((await reconcileOrderCancels({ apply: false, days: 2 })).byEvidence.AI_AGREED, 0, "chạy lại sau apply ⇒ hết");
    });
  } finally {
    process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg(ORG);
  }
  console.log("✓ Huỷ đơn — CSDL thật: giữ đơn → huỷ · rescue thành công · trùng = 1 lần · tồn trả lại · ORDER_OUTCOME CANCELLED · hãng xác nhận mới huỷ · từ chối / đứt mạng / đã lấy ⇒ ngoại lệ + cảnh báo · ghi hỏng ⇒ không nói đã huỷ · đối soát chạy thử không ghi");
}

// ─────────────────────────── 3. ENGINE THẬT (model giả) ───────────────────────────

export async function testOrderCancelEngine() {
  let orderOk = "";
  let orderFail = "";
  const seedOrder = (set: (id: string) => void) => async ({ conversationId, ids, admin }: { conversationId: string; ids: ReadonlyMap<string, string>; admin: () => Promise<SessionUser> }) => {
    const db = await getDb();
    const [c] = await db.insert(schema.customers).values({ name: "Chị Thu", phone: "0942000377", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", province: "Hà Nội" }).returning({ id: schema.customers.id });
    const r = await createManualOrderCore(await admin(), { customerId: c.id, stage: "CONFIRMED", channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 0, lines: [{ variantId: ids.get("CHA-MUC")!, quantity: 1, unitPrice: 400_000, discount: 0 }], recipient: { name: "Chị Thu", phone: "0942000377", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", province: "Hà Nội" } });
    assert.ok(r.ok, JSON.stringify(r));
    // Đơn nhân viên lên cho hội thoại — KHÔNG nằm trong state của bot (đúng dáng #189A435E).
    await db.update(schema.orders).set({ salesConversationId: conversationId }).where(eq(schema.orders.id, r.id));
    set(r.id);
  };
  const cases: GoldenCase[] = [
    {
      key: "huy-don-giu-roi-huy",
      title: "Khách huỷ ⇒ giữ đơn ⇒ khách vẫn huỷ ⇒ đơn «Đã huỷ»; chữ viết kèm lời gọi công cụ không tới khách",
      shop: "food",
      channel: "WEB",
      turns: [
        {
          say: "shop oi huy don giup em",
          before: seedOrder((id) => (orderOk = id)),
          ai: [() => [say("Dạ em huỷ đơn cho chị rồi ạ"), tool("cancel_order", { decision: "CANCEL", customer_words: "huy don giup em" })], () => [say("Dạ chị cho em hỏi lý do được không ạ, em đổi ngày giao giúp chị nhé?")]],
        },
        { say: "thoi huy di em", ai: [() => [tool("cancel_order", { decision: "CANCEL", customer_words: "huy di em" })], ({ results }) => [say(results[0]?.cancelled === true ? "Dạ shop đã huỷ đơn theo yêu cầu của chị ạ." : "Dạ shop ghi nhận, nhân viên sẽ xử lý ạ.")]] },
      ],
    },
    {
      key: "huy-don-ghi-hong",
      title: "Ghi huỷ hỏng ⇒ chuyển người; chữ «đã huỷ» model viết kèm lời gọi KHÔNG tới khách",
      shop: "food",
      channel: "WEB",
      turns: [
        { say: "huy don cua chi nhe", before: seedOrder((id) => (orderFail = id)), ai: [() => [tool("cancel_order", { decision: "CANCEL", customer_words: "huy don cua chi" })], () => [say("Dạ chị cho em hỏi lý do ạ?")]] },
        {
          say: "chi van huy",
          before: async () => {
            const db = await getDb();
            await db.execute(sql.raw(`create or replace function oc_fail_cancel2() returns trigger as $$ begin if new.stage = 'CANCELLED' and old.id = '${orderFail}' then raise exception 'oc: ghi hỏng thử'; end if; return new; end $$ language plpgsql`));
            await db.execute(sql.raw(`create trigger oc_fail_cancel2 before update on orders for each row execute function oc_fail_cancel2()`));
          },
          ai: [() => [say("Dạ em đã huỷ đơn cho chị rồi nhé"), tool("cancel_order", { decision: "CANCEL", customer_words: "chi van huy" })]],
        },
      ],
    },
  ];
  const finals = new Map<string, string | null>();
  const got = await runGoldenCases(cases, {
    orgSuffix: "-oc",
    afterCase: async (c) => {
      const db = await getDb();
      const id = c.key === "huy-don-giu-roi-huy" ? orderOk : orderFail;
      finals.set(c.key, (await db.select({ stage: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.id, id)))[0]?.stage ?? null);
    },
  });
  const ok = got.get("huy-don-giu-roi-huy")!;
  assert.ok(!ok.turns[0].shown.some((s) => /huỷ đơn cho chị rồi/.test(s)), `chữ viết kèm cancel_order không tới khách: ${JSON.stringify(ok.turns[0].shown)}`);
  assert.ok(ok.turns[0].shown.some((s) => /lý do/.test(s)), "vòng sau model nói theo kết quả (giữ đơn)");
  assert.ok(ok.turns[1].shown.some((s) => /đã huỷ đơn/.test(s)), JSON.stringify(ok.turns[1].shown));
  assert.equal(finals.get("huy-don-giu-roi-huy"), "CANCELLED");
  const bad = got.get("huy-don-ghi-hong")!;
  assert.ok(!bad.turns[1].shown.some((s) => /huỷ/.test(s)), `ghi hỏng ⇒ khách không nghe «đã huỷ»: ${JSON.stringify(bad.turns[1].shown)}`);
  assert.equal(bad.final.status, "HANDOFF", "ghi hỏng ⇒ chuyển người");
  assert.equal(finals.get("huy-don-ghi-hong"), "CONFIRMED");
  console.log("✓ Huỷ đơn — engine thật: chữ viết kèm lời gọi huỷ bị giữ · «đã huỷ» chỉ sau khi CSDL ghi xong · ghi hỏng ⇒ chuyển người, không khẳng định");
}

// ─────────────────────────── 4. ĐỐI SOÁT — thuần + khai báo ops ───────────────────────────

export function testOrderCancelReconcilePure() {
  const now = Date.now();
  const base = { id: "erp-x", stage: "CONFIRMED", insertedAt: new Date(now - 3_600_000), review: null, reviewLog: null, cancellation: null, declinedAt: null, confirmedAt: null };
  assert.equal(cancelEvidenceOf(base), null, "không dấu vết ⇒ không phải ứng viên");
  assert.equal(cancelEvidenceOf({ ...base, declinedAt: new Date(now).toISOString() }), "AI_AGREED", "khách từ chối SAU khi đơn lên ⇒ dáng #189A435E");
  assert.equal(cancelEvidenceOf({ ...base, declinedAt: new Date(now - 7_200_000).toISOString() }), null, "từ chối TRƯỚC khi lên đơn ⇒ không");
  assert.equal(cancelEvidenceOf({ ...base, declinedAt: new Date(now - 60_000).toISOString(), confirmedAt: new Date(now).toISOString() }), null, "chốt lại sau khi từ chối ⇒ không");
  assert.equal(cancelEvidenceOf({ ...base, cancellation: { rescue: { result: "FAILED" }, requestedAt: "x" } }), "RESCUE_FAILED");
  assert.equal(cancelEvidenceOf({ ...base, cancellation: { status: "EXCEPTION", exception: { code: "CARRIER_REJECTED", detail: "", at: "x" } } }), "EXCEPTION_OPEN");
  assert.equal(cancelEvidenceOf({ ...base, review: { entries: [{ code: "CUSTOMER_CANCELLED", note: "n", at: "x", by: "b" }] } }), "CUSTOMER_FLAG");
  assert.equal(cancelEvidenceOf({ ...base, cancellation: { status: "CANCELLED" } }), null, "đã huỷ ⇒ không");

  assert.deepEqual(parseReconcileArgs(["hslc"]), { ok: true, args: { code: "hslc", all: false, apply: false, days: 30 } }, "mặc định CHẠY THỬ");
  assert.deepEqual(parseReconcileArgs(["hslc", "--days=7", "--apply"]), { ok: true, args: { code: "hslc", all: false, apply: true, days: 7 } });
  assert.ok(parseReconcileArgs(["--all"]).ok);
  for (const bad of [[], ["hslc", "--all"], ["hslc", "--days=0"], ["hslc", "--days=999"], ["hslc", "--xoa"], ["HSLC"], ["hslc", "khac"]]) assert.equal(parseReconcileArgs(bad).ok, false, `từ chối: ${bad.join(" ")}`);

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /\n {10}- order-cancel-reconcile\s+#/, "có trong danh sách thao tác");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\border-cancel-reconcile\b/, "MÃ HOÁ cả lượt");
  assert.match(ops, /DOC_NANG="[^"]*\border-cancel-reconcile\b/, "không --apply ⇒ lớp ĐỌC; có --apply ⇒ tự sang GHI");
  assert.match(ops, /\n\s+order-cancel-reconcile\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/order-cancel-reconcile\.ts ;;/);
  // Hợp đồng mã nguồn: bot chỉ huỷ qua lõi thực thi (không tự ghi stage), engine giữ chữ viết kèm lời gọi huỷ.
  const tools = readFileSync("lib/sales-chatbot/tools.ts", "utf8").replace(/\r\n/g, "\n");
  const i = tools.indexOf('case "cancel_order"');
  const seg = tools.slice(i, tools.indexOf('case "handoff_to_human"', i));
  assert.ok(seg.includes("executeCustomerCancel(") && !/stage:\s*"CANCELLED"/.test(seg) && !/cancelManualOrderCore|cancelOrderAsAgent/.test(seg), "cancel_order chỉ đi qua executeCustomerCancel");
  const engine = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.ok(engine.includes("TOOLS_HOLDING_TEXT.has(b.name)"), "engine giữ chữ viết kèm lời gọi huỷ");
  assert.match(engine, /CHỈ nói «đơn đã huỷ» khi kết quả công cụ có cancelled = true/, "lời nhắc buộc đọc kết quả công cụ");
  console.log("✓ Huỷ đơn — đối soát: dấu vết (AI_AGREED · RESCUE_FAILED · EXCEPTION_OPEN · CUSTOMER_FLAG) · tham số nghiêm, mặc định chạy thử · ops-vps khai đủ · hợp đồng mã nguồn");
}

export async function testOrderCancelConsistency() {
  testOrderCancelPure();
  testOrderCancelReconcilePure();
  await testOrderCancelDb();
  await testOrderCancelEngine();
}
