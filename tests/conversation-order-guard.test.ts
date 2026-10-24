/**
 * ═══ RÀO «HỘI THOẠI ĐÃ CÓ ĐƠN CỦA NGƯỜI» (P0 HSLC 24/10/2026 — #D2A8DE9B → #A5CC67E2, #1BFC04D7 → #6CBDB6B5) ═══
 *
 * Ca thật: nhân viên lên đơn bằng form hộp thư, trả hội thoại cho AI, khách nhắn tiếp ⇒ bot tạo + TỰ CHỐT đơn thứ hai cùng SĐT ·
 * cùng món. Khoá trên tổ chức THẬT `dup-guard` (tự cấp, tự dọn), đơn của người đi ĐÚNG đường form hộp thư (`createOrderFromChatCore`):
 *  1. AI sau người, cùng hội thoại, cùng món ⇒ KHÔNG tạo (kể cả máy tự chốt), câu cho bot nêu đúng mã đơn, không chuyển người;
 *  2. cùng hội thoại, khách nói khác (số lượng) ⇒ không tạo + chuyển người;
 *  3. khách nói RÕ «thêm một đơn riêng» ⇒ tạo, mã lý do trên state, KHÔNG tự chốt (giữ «Mới»);
 *  4. hội thoại KHÁC cùng SĐT ⇒ tạo bình thường (rào theo hội thoại, không theo SĐT);
 *  5. đơn của người đã huỷ / ngoài cửa sổ / ĐÃ GỬI ĐI / khách đã trả lời «đặt thêm» cho đúng đơn đó ⇒ không chặn (khách cũ mua lại);
 *     đơn Pancake cùng page + thread ⇒ chặn; lượt mua MỚI mở đúng lúc bot quay lại (roundStartAt = bây giờ) ⇒ VẪN chặn;
 *  6. bot lên nháp TRƯỚC, người lên đơn SAU ⇒ `confirm_order` KHÔNG chốt nháp, chuyển người;
 *  7. mỗi lần chặn để lại một dòng nhật ký đếm được.
 * Phần thuần: ý định «đơn riêng» (đúng / phủ định / câu thường) · quyết định · câu cho bot.
 * Lớp tạm trước pha 3: SĐT gõ trùng đơn BOT đang mở ở hội thoại khác ⇒ vẫn lên đơn, không tự chốt, cờ POSSIBLE_SAME_CUSTOMER.
 * Mốc theo ĐỒNG HỒ THẬT (AGENTS.md mục 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { CONVERSATION_ORDER_GUARD_HOURS, type DuplicateCandidate } from "@/lib/constants/order-duplicate";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createOrderFromChatCore } from "@/lib/records/chat-order";
import { createOrderAsAgent } from "@/lib/records/order-create";
import { duplicateFlagsFor, strongestFlag } from "@/lib/queries/order-duplicate";
import { createProductCore } from "@/lib/records/product-create";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { blockInstruction, CONVERSATION_ORDER_FIELD, decideConversationOrder, otherConversationOrders, separateOrderIntent, type ConversationOrder } from "@/lib/sales-chatbot/conversation-order-guard";
import { conversationFor } from "@/lib/sales-chatbot/fanpage";
import { executeTool, type ChatState, type ToolContext } from "@/lib/sales-chatbot/tools";

const ORG = "dup-guard";
const ADMIN_EMAIL = "chu@dup-guard.local";
/** Tổ chức thứ hai — cô lập: cùng page + thread, cùng SĐT, đơn của người ở tổ chức KIA không chặn bot ở tổ chức này. */
const ORG_B = "dup-guard-b";
const ADMIN_B = "chu@dup-guard-b.local";
const PAGE = "5550002223";
const PHONE = "0372000111";
const ADDRESS = "12 Hàng Bạc, Hoàn Kiếm, Hà Nội";

function testPure() {
  for (const t of ["lên thêm cho chị 1 đơn riêng nhé", "tách làm 2 đơn giúp chị", "đặt thêm 1 đơn nữa giao cho mẹ chị", "em lên đơn thứ 2 cho chị", "Đơn riêng cho em gái chị nhé"]) assert.ok(separateOrderIntent([t]), `phải là ý định đơn riêng: ${t}`);
  for (const t of ["ok em", "chị lấy thêm 1kg", "không cần tách đơn đâu em", "đơn của chị đâu em", "chị đặt đơn rồi mà", "12 Hàng Bạc, Hoàn Kiếm 0372000111"]) assert.ok(!separateOrderIntent([t]), `KHÔNG phải ý định đơn riêng: ${t}`);

  const at = new Date();
  const item = (variantId: string, quantity = 1) => ({ variantId, sku: "", productName: "", variationDetail: "", quantity });
  const staff: ConversationOrder = { orderId: "erp-staff-1", insertedAt: new Date(at.getTime() - 60_000), phone: PHONE, receiverName: "Lan", address: ADDRESS, total: 300_000, items: [item("v1")], stage: "CONFIRMED", origin: "ERP_FORM", agentKey: "chat:c1:req" };
  const same: DuplicateCandidate = { orderId: "(bot)", insertedAt: at, phone: `+84${PHONE.slice(1)}`, receiverName: "Lan", address: ADDRESS, total: 0, items: [item("v1")] };
  assert.deepEqual(decideConversationOrder([], same, []), { kind: "PROCEED" });
  const b = decideConversationOrder([staff], same, ["dạ đúng rồi em"]);
  assert.ok(b.kind === "BLOCK" && b.sameAsProposal && b.order.orderId === staff.orderId, "cùng SĐT (khác dạng 0 / +84) + cùng món ⇒ chặn, cùng đơn");
  const d = decideConversationOrder([staff], { ...same, items: [item("v1", 2)] }, []);
  assert.ok(d.kind === "BLOCK" && !d.sameAsProposal, "khác số lượng ⇒ chặn, khách đang sửa");
  assert.deepEqual(decideConversationOrder([staff], same, ["lên thêm cho chị 1 đơn riêng"]), { kind: "SEPARATE_ALLOWED", reasonCode: "CUSTOMER_EXPLICIT_SEPARATE_ORDER", existingIds: [staff.orderId] });
  const older = { ...staff, orderId: "erp-staff-0", insertedAt: new Date(at.getTime() - 3_600_000) };
  const pick = decideConversationOrder([older, staff], same, []);
  assert.ok(pick.kind === "BLOCK" && pick.order.orderId === staff.orderId, "nhiều đơn ⇒ nêu đơn MỚI NHẤT");
  if (b.kind === "BLOCK") {
    const text = blockInstruction(b, "CREATE");
    assert.ok(text.includes(`#${manualOrderShortCode(staff.orderId)}`) && text.includes("KHÔNG tạo đơn mới") && text.includes("form hộp thư"), text);
  }
  assert.ok(CONVERSATION_ORDER_GUARD_HOURS > 0 && CONVERSATION_ORDER_GUARD_HOURS <= 48);
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(code = ORG, email = ADMIN_EMAIL): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  assert.ok(u);
  const org = await findOrganization(code);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: org?.name ?? code, isHome: false }, modules: [...(await getEnabledModules(code))] };
}

/** Tổ chức B: một đơn của NGƯỜI trên ĐÚNG page + thread `iso`, cùng SĐT, cùng tên sản phẩm. */
async function seedOrgB() {
  await withOrganization(ORG_B, async () => {
    const db = await getDb();
    const admin = await adminOf(ORG_B, ADMIN_B);
    const p = await createProductCore(admin, { name: "Chả cá thu", code: "CA-THU", unit: "kg", retailPrice: 300_000, cost: null, variants: [{ sku: "CA-THU", size: "", color: "", retailPrice: 300_000, cost: null, selling: true }] });
    assert.ok(p.ok, JSON.stringify(p));
    const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
    assert.ok(v);
    const conv = await conversationFor(PAGE, `${PAGE}_iso`);
    assert.ok(conv);
    const r = await createOrderFromChatCore(admin, conv.id, { requestKey: "dupguard-b-req-1", name: "Nguyễn Thị Lan", phone: PHONE, address: ADDRESS, stage: "CONFIRMED", lines: [{ variantId: v.id, quantity: 1, unitPrice: 300_000 }] });
    assert.ok(r.ok, JSON.stringify(r));
  });
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const o = schema.orders;
    const admin = await adminOf();
    const p = await createProductCore(admin, { name: "Chả cá thu", code: "CA-THU", unit: "kg", retailPrice: 300_000, cost: null, variants: [{ sku: "CA-THU", size: "", color: "", retailPrice: 300_000, cost: null, selling: true }] });
    assert.ok(p.ok, JSON.stringify(p));
    const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
    assert.ok(v);
    const agent = { name: "Bot bán hàng (thử)", source: "tests/conversation-order-guard.test.ts" };
    let req = 0;

    const convOf = async (thread: string) => {
      const conv = await conversationFor(PAGE, `${PAGE}_${thread}`);
      assert.ok(conv);
      return conv;
    };
    const staffOrder = async (convId: string) => {
      req += 1;
      const r = await createOrderFromChatCore(admin, convId, { requestKey: `dupguard-req-${req}`, name: "Nguyễn Thị Lan", phone: PHONE, address: ADDRESS, stage: "CONFIRMED", lines: [{ variantId: v.id, quantity: 1, unitPrice: 300_000 }] });
      assert.ok(r.ok, JSON.stringify(r));
      return r.orderId;
    };
    const ctxOf = (convId: string, extra: Partial<ToolContext> = {}): ToolContext => ({ conversationId: convId, channel: "FANPAGE", config: { ...DEFAULT_SALES_CHATBOT_CONFIG }, state: {}, lastUserText: "", agent, now: new Date(), ...extra });
    const botCreate = async (convId: string, opts: { qty?: number; text?: string; autoConfirm?: boolean; phone?: string } = {}) => {
      const ctx = ctxOf(convId, { lastUserText: opts.text ?? "", ...(opts.autoConfirm ? { autoConfirm: true } : {}) });
      const c1 = await executeTool("create_customer", { name: "Nguyễn Thị Lan", phone: opts.phone ?? PHONE, address: ADDRESS }, ctx);
      assert.ok(!c1.isError, c1.content);
      return executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: opts.qty ?? 1 }] }, { ...ctx, state: c1.state });
    };
    /** Đơn của hội thoại: đơn người (khoá hội thoại) + đơn bot (khoá lần mua `sales-chat:<hội thoại>:`). */
    const ordersOf = async (convId: string) => db.select({ id: o.id, stage: o.stage }).from(o).where(or(eq(o.salesConversationId, convId), sql`${o.raw}->>'agentKey' like ${`sales-chat:${convId}:%`}`));
    const blocks = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHAT_DUPLICATE_ORDER_BLOCKED")))[0]?.n ?? 0;

    // ── 1 · Ca thật: người lên đơn, AI tới sau, cùng món, tổ chức bật tự chốt ⇒ KHÔNG tạo, không chuyển người ──
    const a = await convOf("a");
    const staffA = await staffOrder(a.id);
    const r1 = await botCreate(a.id, { autoConfirm: true, text: "Nguyễn Thị Lan 0372000111 12 Hàng Bạc" });
    assert.ok(r1.isError, "bot không được tạo đơn thứ hai");
    assert.equal(r1.summary, "Đơn nháp: hội thoại đã có đơn");
    assert.ok(r1.content.includes(`#${manualOrderShortCode(staffA)}`), "câu cho bot nêu đúng mã đơn của người");
    assert.equal(r1.requireHuman, undefined, "khách nói đúng đơn đã có ⇒ bot báo khách, không chuyển người");
    assert.equal(r1.state.draft, undefined, "không có đơn nháp trong state");
    assert.deepEqual((await ordersOf(a.id)).map((x) => x.id), [staffA], "hội thoại vẫn đúng MỘT đơn");
    assert.equal(await blocks(), 1, "một lần chặn = một dòng nhật ký");

    // ── 2 · Cùng hội thoại, khách nói khác (2 thay vì 1) ⇒ không tạo + chuyển người sửa đúng đơn ──
    const r2 = await botCreate(a.id, { qty: 2 });
    assert.ok(r2.isError && r2.requireHuman?.includes(`#${manualOrderShortCode(staffA)}`), r2.requireHuman ?? r2.content);
    assert.equal((await ordersOf(a.id)).length, 1);

    // ── 3 · Khách nói RÕ «thêm một đơn riêng» ⇒ tạo, KHÔNG tự chốt ──
    const r3 = await botCreate(a.id, { autoConfirm: true, text: "lên thêm cho chị 1 đơn riêng giao cho mẹ chị nhé" });
    assert.ok(!r3.isError, r3.content);
    assert.deepEqual(r3.state.draft?.separateOrder, { reason: "CUSTOMER_EXPLICIT_SEPARATE_ORDER", existingIds: [staffA] });
    assert.equal(r3.state.confirmed, undefined, "đơn riêng không tự chốt");
    const sep = (await ordersOf(a.id)).find((x) => x.id === r3.state.draft?.orderId);
    assert.equal(sep?.stage, "NEW", "đơn riêng giữ «Mới» — khách đồng ý tóm tắt ở tin sau mới chốt");

    // ── 4 · Hội thoại KHÁC, cùng SĐT ⇒ tạo bình thường ──
    const b = await convOf("b");
    const r4 = await botCreate(b.id);
    assert.ok(!r4.isError && r4.state.draft?.orderId, r4.content);

    // ── 5 · Đơn của người đã huỷ / ngoài cửa sổ ⇒ không chặn; đơn Pancake cùng page + thread ⇒ chặn ──
    const c = await convOf("c");
    const staffC = await staffOrder(c.id);
    await db.update(o).set({ stage: "CANCELLED" }).where(eq(o.id, staffC));
    const r5 = await botCreate(c.id);
    assert.ok(!r5.isError, `đơn người đã huỷ không chặn: ${r5.content}`);
    const d = await convOf("d");
    const staffD = await staffOrder(d.id);
    await db.update(o).set({ insertedAt: new Date(Date.now() - (CONVERSATION_ORDER_GUARD_HOURS + 1) * 3_600_000) }).where(eq(o.id, staffD));
    const r6 = await botCreate(d.id);
    assert.ok(!r6.isError, `đơn người ngoài cửa sổ không chặn: ${r6.content}`);
    const e = await convOf("e");
    const staffE = await staffOrder(e.id);
    await db.update(o).set({ salesConversationId: null, pageId: PAGE, conversationId: `${PAGE}_e` }).where(eq(o.id, staffE));
    const r7 = await botCreate(e.id);
    assert.ok(r7.isError && r7.content.includes(`#${manualOrderShortCode(staffE)}`), `đơn Pancake cùng page + thread ⇒ chặn: ${r7.content}`);

    // ── 5b · Khách CŨ mua lại (golden `khach-cu-van-dia-chi-cu`): đơn cũ ĐÃ GỬI cùng thread ⇒ không chặn; đơn của lượt mua TRƯỚC mốc
    // lượt mua bot đang dùng ⇒ không chặn ──
    const sh = await convOf("sh");
    const staffSh = await staffOrder(sh.id);
    await db.update(o).set({ stage: "SHIPPED" }).where(eq(o.id, staffSh));
    const rSh = await botCreate(sh.id);
    assert.ok(!rSh.isError, `đơn đã gửi đi (lượt mua đã kết thúc) không chặn: ${rSh.content}`);
    // Khách TRẢ LỜI «đặt thêm» cho câu hỏi đơn cũ / đơn mới của máy chủ về ĐÚNG đơn đó ⇒ đơn ấy không chặn.
    const rd = await convOf("rd");
    const staffRd = await staffOrder(rd.id);
    const ctxRd = ctxOf(rd.id, { state: { roundCheck: { orderId: staffRd, askedTurn: 1, at: new Date().toISOString(), answer: "NEW" } } });
    const cRd = await executeTool("create_customer", { name: "Nguyễn Thị Lan", phone: PHONE, address: ADDRESS }, ctxRd);
    const rRd = await executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: 1 }] }, { ...ctxRd, state: cRd.state });
    assert.ok(!rRd.isError, `khách trả lời «đặt thêm» cho đúng đơn đó ⇒ không chặn: ${rRd.content}`);

    // ── 5c · TRÌNH TỰ THẬT với state như production: lượt mua MỚI mở đúng lúc bot quay lại (khách im > 7 ngày trong sổ bot ⇒
    // roundStartAt = giờ hiện tại), đơn người lên TRONG lúc giữ nằm trước mốc ⇒ VẪN chặn (mốc lượt mua không phải mốc dưới của rào) ──
    // Mốc lượt mua dựng SAU khi nhân viên lên đơn — đúng thứ tự thật: người lên đơn lúc giữ, rồi bot mở lượt mua mới khi quay lại.
    const sequences: [string, () => ChatState][] = [
      ["seq1", () => ({})],
      ["seq2", () => ({ roundStartAt: new Date().toISOString(), cycleStartTurns: 3, cartRev: new Date().toISOString() })],
      ["seq3", () => ({ pastOrders: [{ orderId: null, simulated: false, total: 280_000, at: new Date(Date.now() - 2 * 86_400_000).toISOString() }], roundStartAt: new Date().toISOString() })],
    ];
    for (const [thread, state] of sequences) {
      const cv = await convOf(thread);
      await staffOrder(cv.id);
      await new Promise((r) => setTimeout(r, 5));
      const ctxS = ctxOf(cv.id, { state: state(), autoConfirm: true });
      const cS = await executeTool("create_customer", { name: "Nguyễn Thị Lan", phone: PHONE, address: ADDRESS }, ctxS);
      const rS = await executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: 1 }] }, { ...ctxS, state: cS.state });
      assert.equal(rS.summary, "Đơn nháp: hội thoại đã có đơn", `[${thread}] đơn người lên trong lúc giữ ⇒ bot KHÔNG tạo dù lượt mua vừa mở: ${rS.content}`);
    }

    // ── 6 · Bot lên nháp TRƯỚC, người lên đơn SAU ⇒ confirm_order không chốt nháp, chuyển người ──
    const f = await convOf("f");
    const r8 = await botCreate(f.id);
    assert.ok(!r8.isError && r8.state.draft?.orderId, r8.content);
    await staffOrder(f.id);
    const r9 = await executeTool("confirm_order", { customer_confirmation: "ok chốt đơn" }, ctxOf(f.id, { state: r8.state, lastUserText: "ok chốt đơn", turn: 9 }));
    assert.equal(r9.summary, "Chốt: hội thoại đã có đơn khác", r9.content);
    assert.ok(r9.requireHuman?.includes("KHÔNG chốt"), r9.requireHuman);
    const [draftF] = await db.select({ stage: o.stage }).from(o).where(eq(o.id, r8.state.draft!.orderId!));
    assert.equal(draftF?.stage, "NEW", "nháp của bot không thành đơn thứ hai «Đã xác nhận»");
    // Đối chứng: hội thoại không có đơn người ⇒ rào chốt không chặn (các cổng khác của confirm_order vẫn có thể từ chối).
    const r10 = await executeTool("confirm_order", { customer_confirmation: "ok chốt đơn" }, ctxOf(b.id, { state: r4.state, lastUserText: "ok chốt đơn", turn: 9 }));
    assert.notEqual(r10.summary, "Chốt: hội thoại đã có đơn khác", r10.content);
    // Đơn riêng khách đã xin (ca 3) ⇒ đơn người đã có KHÔNG chặn bước chốt.
    const r11 = await executeTool("confirm_order", { customer_confirmation: "ok chốt đơn" }, ctxOf(a.id, { state: r3.state, lastUserText: "ok chốt đơn", turn: 9 }));
    assert.notEqual(r11.summary, "Chốt: hội thoại đã có đơn khác", r11.content);

    assert.equal(await blocks(), 7, "bảy lần chặn (ca 1 · 2 · ba trình tự thật 5c · Pancake · chốt) = bảy dòng nhật ký");
    const [log] = await db.select({ entityId: schema.auditLogs.entityId }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHAT_DUPLICATE_ORDER_BLOCKED"), eq(schema.auditLogs.entityId, staffA))).limit(1);
    assert.ok(log, "nhật ký trỏ về đơn của người");

    // ══════ PHA 2 ══════
    const linkOf = async (id: string) => (await db.select({ conv: o.salesConversationId, origin: o.origin }).from(o).where(eq(o.id, id)).limit(1))[0];
    // ── 7 · Khoá hội thoại ghi NGAY lúc chèn (form · bot), không đợi lượt gắn sau giao dịch ──
    assert.deepEqual(await linkOf(staffA), { conv: a.id, origin: "ERP_FORM" }, "đơn form mang khoá hội thoại + nguồn người từ lúc chèn");
    assert.deepEqual(await linkOf(r4.state.draft!.orderId!), { conv: b.id, origin: "AI_AGENT" }, "đơn bot mang khoá hội thoại từ lúc chèn (không chờ linkAgentOrder)");

    // ── 8 · Đơn của người chen vào GIỮA lượt đọc của công cụ và lượt ghi ⇒ rào TRONG giao dịch đã khoá vẫn chặn ──
    const g = await convOf("g");
    const staffG = await staffOrder(g.id);
    const [custG] = await db.select({ id: o.customerId }).from(o).where(eq(o.id, staffG));
    const payload = { customerId: custG!.id!, stage: "NEW" as const, lines: [{ variantId: v.id, quantity: 1, unitPrice: 300_000, discount: 0 }], orderDiscount: 0, shippingFee: 0, note: "", channel: "Fanpage" };
    const raced = await createOrderAsAgent(agent, payload, { pricing: "RETAIL", idempotencyKey: `sales-chat:${g.id}:0`, conversation: { id: g.id, origin: "AI_AGENT", guard: { exclude: [], verifiedCustomerId: null, now: new Date() } } });
    assert.ok(!raced.ok && raced.code === "CONFLICT" && raced.errors[0]?.field === CONVERSATION_ORDER_FIELD, JSON.stringify(raced));
    assert.deepEqual((await ordersOf(g.id)).map((x) => x.id), [staffG], "giao dịch bị rào chặn không ghi gì");
    // Cùng giây: form của người và bot cùng chạy ⇒ không bao giờ có đơn bot ĐẶT SAU đơn người.
    const h = await convOf("h");
    const [, botH] = await Promise.all([staffOrder(h.id), botCreate(h.id)]);
    const hOrders = await db.select({ id: o.id, at: o.insertedAt, origin: o.origin }).from(o).where(eq(o.salesConversationId, h.id));
    const hStaff = hOrders.find((x) => x.origin === "ERP_FORM");
    const hBot = hOrders.find((x) => x.origin === "AI_AGENT");
    assert.ok(hStaff, "đơn của người luôn được ghi (form không bị rào)");
    assert.ok(!hBot || hBot.at.getTime() <= hStaff.at.getTime(), `đơn bot đặt sau đơn người cùng giây ⇒ phải bị chặn: ${botH.content}`);

    // ── 9 · Gọi lại cùng lượt (webhook gửi lại / thử lại) ⇒ đúng MỘT đơn, không bị rào chặn nhầm đơn của chính bot ──
    const i = await convOf("i");
    const ctxI = ctxOf(i.id);
    const ci = await executeTool("create_customer", { name: "Nguyễn Thị Lan", phone: PHONE, address: ADDRESS }, ctxI);
    const t1 = await executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: 1 }] }, { ...ctxI, state: ci.state });
    const t2 = await executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: 1 }] }, { ...ctxI, state: ci.state });
    assert.ok(!t1.isError && !t2.isError, `${t1.content} / ${t2.content}`);
    assert.equal(t2.state.draft?.orderId, t1.state.draft?.orderId, "cùng khoá lần mua ⇒ cùng đơn");
    assert.equal((await ordersOf(i.id)).length, 1);

    // ── 10 · Ghi đơn từ hội thoại (nhân viên chốt trên fanpage, máy ghi hộ) đi cùng không gian khoá và chặn bot ──
    const j = await convOf("j");
    const synced = await createOrderAsAgent({ name: "Ghi đơn từ hội thoại (thử)", source: "tests/conversation-order-guard.test.ts" }, payload, { pricing: "RETAIL", idempotencyKey: `order-sync:${j.id}:m1`, conversation: { id: j.id, origin: "AI_ORDER_SYNC" } });
    assert.ok(synced.ok, JSON.stringify(synced));
    assert.deepEqual(await linkOf(synced.id), { conv: j.id, origin: "AI_ORDER_SYNC" });
    const r12 = await botCreate(j.id);
    assert.ok(r12.isError && r12.content.includes("máy ghi hộ"), r12.content);

    // ── 10b · Chiều NGƯỢC (order-dup-scan 24/10: 6 cặp bot → order_sync): bot lên đơn trước ⇒ order_sync không ghi đơn thứ hai ──
    const jb = await convOf("jb");
    const rb = await botCreate(jb.id);
    assert.ok(!rb.isError && rb.state.draft?.orderId, rb.content);
    const syncGuard = { exclude: [] as string[], verifiedCustomerId: null, now: new Date(), includeBotOrders: true, ownKeyPrefix: `order-sync:${jb.id}:` };
    const liveJb = await otherConversationOrders({ conversationId: jb.id, ...syncGuard });
    assert.deepEqual(liveJb.map((x) => x.orderId), [rb.state.draft!.orderId!], "order_sync thấy đơn bot của hội thoại");
    const syncAfterBot = await createOrderAsAgent({ name: "Ghi đơn từ hội thoại (thử)", source: "tests/conversation-order-guard.test.ts" }, payload, { pricing: "RETAIL", idempotencyKey: `order-sync:${jb.id}:m1`, conversation: { id: jb.id, origin: "AI_ORDER_SYNC", guard: syncGuard } });
    assert.ok(!syncAfterBot.ok && syncAfterBot.errors[0]?.field === CONVERSATION_ORDER_FIELD, `order_sync sau đơn bot ⇒ chặn trong giao dịch: ${JSON.stringify(syncAfterBot)}`);
    assert.equal((await ordersOf(jb.id)).length, 1, "chiều bot → order_sync: vẫn đúng một đơn");
    const syncSrc = readFileSync("lib/sales-chatbot/order-sync.ts", "utf8");
    assert.ok(syncSrc.includes("includeBotOrders: true") && syncSrc.includes("guard: convGuard") && syncSrc.includes("ownKeyPrefix: `order-sync:${conv.id}:`"), "order_sync dùng luật cấp hội thoại tính cả đơn bot, cả trước lẫn trong giao dịch, trừ đơn chính nó ghi");
    // Đơn order_sync TỰ ghi trước đó (khách «1kg nữa» ba giờ sau) KHÔNG chặn lần ghi kế của chính nó — luật mốc cắt của nó lo.
    const syncAgain = await createOrderAsAgent({ name: "Ghi đơn từ hội thoại (thử)", source: "tests/conversation-order-guard.test.ts" }, payload, { pricing: "RETAIL", idempotencyKey: `order-sync:${j.id}:m2`, conversation: { id: j.id, origin: "AI_ORDER_SYNC", guard: { exclude: [], verifiedCustomerId: null, now: new Date(), includeBotOrders: true, ownKeyPrefix: `order-sync:${j.id}:` } } });
    assert.ok(syncAgain.ok, `đơn order_sync trước đó không chặn lần mua mới của chính nó: ${JSON.stringify(syncAgain)}`);

    // ── 11 · Khách C360: đơn người ở hội thoại KHÁC chỉ chặn khi danh tính ĐÃ XÁC MINH (mã Facebook) ──
    const k = await convOf("k");
    const staffK = await staffOrder(k.id);
    const l = await convOf("l");
    const ctxL = ctxOf(l.id);
    const cl = await executeTool("create_customer", { name: "Nguyễn Thị Lan", phone: PHONE, address: ADDRESS }, ctxL);
    assert.ok(!cl.isError, cl.content);
    const verified = { ...cl.state, customer: { ...cl.state.customer!, verifiedIdentity: true } };
    const r13 = await executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: 1 }] }, { ...ctxL, state: verified });
    assert.ok(r13.isError && r13.content.includes("hội thoại khác"), `khách đã xác minh, đơn người ở hội thoại khác ⇒ chặn, nói rõ: ${r13.content}`);
    void staffK;
    const m = await convOf("m");
    const r14 = await botCreate(m.id);
    assert.ok(!r14.isError, `SĐT gõ tay (chưa xác minh) KHÔNG được thấy / bị chặn bởi đơn hội thoại khác: ${r14.content}`);

    // ── 12 · Cô lập tổ chức: đơn người ở tổ chức B cùng page + thread + SĐT không chặn bot ở tổ chức này ──
    const iso = await convOf("iso");
    const r15 = await botCreate(iso.id);
    assert.ok(!r15.isError, `đơn của tổ chức khác không chặn: ${r15.content}`);

    // ── 13 · Cờ «Nghi trùng đơn» trên /orders đọc CHÍNH assessDuplicate ──
    const sepId = r3.state.draft!.orderId!;
    const [staffRow] = await db.select({ at: o.insertedAt, phone: o.billPhone }).from(o).where(eq(o.id, staffA));
    const [sepRow] = await db.select({ at: o.insertedAt, phone: o.billPhone }).from(o).where(eq(o.id, sepId));
    const flags = await duplicateFlagsFor([{ id: staffA, insertedAt: staffRow!.at, billPhone: staffRow!.phone }, { id: sepId, insertedAt: sepRow!.at, billPhone: sepRow!.phone }]);
    const toSep = flags.get(staffA)?.find((f) => f.otherId === sepId);
    assert.ok(toSep && toSep.verdict === "DUPLICATE_SUSPECTED" && toSep.role === "KEEPER", JSON.stringify(flags.get(staffA)));
    const back = flags.get(sepId)?.find((f) => f.otherId === staffA);
    assert.ok(back && back.verdict === "DUPLICATE_SUSPECTED" && back.role === "SUSPECT", JSON.stringify(flags.get(sepId)));
    assert.ok(!(flags.get(staffA) ?? []).some((f) => f.otherId === staffC), "đơn đã huỷ không cờ");
    assert.equal(strongestFlag(flags.get(sepId))?.verdict, "DUPLICATE_SUSPECTED");
    assert.equal(strongestFlag([]), null);

    // ── 14 · LỚP TẠM trước pha 3 (vụ #8639C563 → #E2867CF0): SĐT gõ trùng đơn BOT đang mở ở hội thoại KHÁC ⇒ vẫn lên đơn, KHÔNG tự
    // chốt (giữ «Mới»), cờ POSSIBLE_SAME_CUSTOMER cùng giao dịch, một dòng nhật ký; khách không nghe gì khác thường ──
    const PHONE_SP = "0388000222";
    const holds = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHAT_SAME_PHONE_HOLD")))[0]?.n ?? 0;
    // Các ca trước dùng chung SĐT `PHONE` ở nhiều hội thoại nên lớp tạm đã kích hoạt ở đó — đếm CHÊNH LỆCH từ đây.
    const h0 = await holds();
    const sp1 = await convOf("sp1");
    const b1 = await botCreate(sp1.id, { autoConfirm: true, phone: PHONE_SP });
    assert.ok(!b1.isError && b1.state.confirmed?.auto, `đơn đầu (bình luận) tự chốt bình thường: ${b1.content}`);
    const sp2 = await convOf("sp2");
    const b2 = await botCreate(sp2.id, { autoConfirm: true, phone: PHONE_SP });
    assert.ok(!b2.isError && b2.state.draft?.orderId, `đơn ở hội thoại thứ hai VẪN lên: ${b2.content}`);
    assert.equal(b2.state.confirmed, undefined, "không tự chốt");
    assert.equal(b2.state.draft?.samePhoneOf, b1.state.confirmed!.orderId, "ghi đơn bot trùng SĐT vào state");
    const [o2] = await db.select({ stage: o.stage, raw: o.raw }).from(o).where(eq(o.id, b2.state.draft!.orderId!));
    assert.equal(o2?.stage, "NEW", "đơn giữ «Mới» dù tổ chức bật tự chốt");
    const entries = ((o2?.raw as { review?: { entries?: { code: string; note: string }[] } }).review?.entries ?? []);
    const same = entries.find((e) => e.code === "POSSIBLE_SAME_CUSTOMER");
    assert.ok(same && same.note.includes(`#${manualOrderShortCode(b1.state.confirmed!.orderId!)}`), `cờ cần kiểm nêu đúng đơn kia: ${JSON.stringify(entries)}`);
    assert.ok(!b2.content.includes(manualOrderShortCode(b1.state.confirmed!.orderId!)), "kết quả công cụ (model đọc, có thể nói với khách) KHÔNG nêu đơn của hội thoại kia — chỉ cờ nội bộ nêu");
    assert.equal(await holds(), h0 + 1, "một lần kích hoạt = một dòng nhật ký");
    // Đối chứng: SĐT khác ⇒ tự chốt như cũ; hội thoại CHÍNH nó (đơn bot của sp1) không tự kích hoạt; đơn bot kia đã rời kho ⇒ không.
    const sp3 = await convOf("sp3");
    const b3 = await botCreate(sp3.id, { autoConfirm: true, phone: "0388000333" });
    assert.ok(!b3.isError && b3.state.confirmed?.auto && !b3.state.draft?.samePhoneOf, `SĐT khác ⇒ tự chốt như cũ: ${b3.content}`);
    await db.update(o).set({ stage: "SHIPPED" }).where(eq(o.id, b1.state.confirmed!.orderId!));
    await db.update(o).set({ stage: "SHIPPED" }).where(eq(o.id, b2.state.draft!.orderId!));
    const sp4 = await convOf("sp4");
    const b4 = await botCreate(sp4.id, { autoConfirm: true, phone: PHONE_SP });
    assert.ok(!b4.isError && b4.state.confirmed?.auto && !b4.state.draft?.samePhoneOf, `đơn bot kia đã gửi đi ⇒ không giữ: ${b4.content}`);
    assert.equal(await holds(), h0 + 1);
    const guardSrc = readFileSync("lib/sales-chatbot/conversation-order-guard.ts", "utf8");
    assert.ok(guardSrc.includes("LỚP TẠM") && guardSrc.includes("HẾT HIỆU LỰC KHI PHA 3"), "mã ghi rõ đây là lớp tạm");
  });
}

/** Cờ phải tới ĐÚNG hai màn hình nhân viên làm đơn — và đọc hàm chung, không tự so SĐT. Ba đường tạo đơn chung một khoá. */
function testUiFences() {
  const list = readFileSync("app/(dashboard)/orders/columns.tsx", "utf8");
  const detail = readFileSync("app/(dashboard)/orders/[id]/page.tsx", "utf8");
  const query = readFileSync("lib/queries/orders.ts", "utf8");
  assert.ok(list.includes('data-testid="order-duplicate-flag"') && list.includes("Nghi trùng đơn"), "danh sách /orders có cờ");
  assert.ok(detail.includes('data-testid="order-duplicate"') && detail.includes("duplicateFlagsFor("), "chi tiết đơn có cờ, đọc duplicateFlagsFor");
  assert.ok(query.includes("duplicateFlagsFor(") && query.includes("strongestFlag("), "listOrders đọc duplicateFlagsFor");
  const flagSrc = readFileSync("lib/queries/order-duplicate.ts", "utf8");
  const body = flagSrc.slice(flagSrc.indexOf("export async function duplicateFlagsFor"));
  assert.ok(body.includes("assessDuplicate(") && body.includes("orderPair("), "cờ đọc CHÍNH assessDuplicate + orderPair");
  const core = readFileSync("lib/records/order-create.ts", "utf8");
  assert.match(core, /if \(conv\) await lockConversation\(tx, conv\.id\);\s*if \(key\)/, "khoá hội thoại TRƯỚC khoá lần mua (một thứ tự, không kẹt chéo)");
  for (const f of ["lib/records/chat-order.ts", "lib/sales-chatbot/order-sync.ts"]) assert.ok(readFileSync(f, "utf8").includes("conversation: { id: conv.id, origin: "), `${f} đi chung không gian khoá hội thoại`);
}

export async function testConversationOrderGuard() {
  testPure();
  await cleanupOrg(ORG);
  await cleanupOrg(ORG_B);
  await provisionOrganization({ code: ORG_B, name: "Shop rào đơn trùng B", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_B, name: "Chủ shop B", password: "RaoDonTrungB@2026!" }, source: "TEST", actor: null });
  await provisionOrganization({ code: ORG, name: "Shop rào đơn trùng", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "RaoDonTrung@2026!" }, source: "TEST", actor: null });
  try {
    await seedOrgB();
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
    await cleanupOrg(ORG_B);
  }
  testUiFences();
  console.log("  ✓ rào hội thoại đã có đơn của người: AI sau người cùng món ⇒ không tạo (kể cả tự chốt) · khác món ⇒ chuyển người · «đơn riêng» tường minh ⇒ tạo, không tự chốt · hội thoại khác ⇒ tạo · huỷ / ngoài cửa sổ không chặn · đơn Pancake cùng thread chặn · nháp trước người ⇒ không chốt · mỗi lần chặn một dòng nhật ký");
}
