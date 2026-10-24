/**
 * ═══ RÀO «HỘI THOẠI ĐÃ CÓ ĐƠN CỦA NGƯỜI» (P0 HSLC 24/10/2026 — #D2A8DE9B → #A5CC67E2, #1BFC04D7 → #6CBDB6B5) ═══
 *
 * Ca thật: nhân viên lên đơn bằng form hộp thư, trả hội thoại cho AI, khách nhắn tiếp ⇒ bot tạo + TỰ CHỐT đơn thứ hai cùng SĐT ·
 * cùng món. Khoá trên tổ chức THẬT `dup-guard` (tự cấp, tự dọn), đơn của người đi ĐÚNG đường form hộp thư (`createOrderFromChatCore`):
 *  1. AI sau người, cùng hội thoại, cùng món ⇒ KHÔNG tạo (kể cả máy tự chốt), câu cho bot nêu đúng mã đơn, không chuyển người;
 *  2. cùng hội thoại, khách nói khác (số lượng) ⇒ không tạo + chuyển người;
 *  3. khách nói RÕ «thêm một đơn riêng» ⇒ tạo, mã lý do trên state, KHÔNG tự chốt (giữ «Mới»);
 *  4. hội thoại KHÁC cùng SĐT ⇒ tạo bình thường (rào theo hội thoại, không theo SĐT);
 *  5. đơn của người đã huỷ / ngoài cửa sổ ⇒ không chặn; đơn Pancake cùng page + thread ⇒ chặn;
 *  6. bot lên nháp TRƯỚC, người lên đơn SAU ⇒ `confirm_order` KHÔNG chốt nháp, chuyển người;
 *  7. mỗi lần chặn để lại một dòng nhật ký đếm được.
 * Phần thuần: ý định «đơn riêng» (đúng / phủ định / câu thường) · quyết định · câu cho bot.
 * Mốc theo ĐỒNG HỒ THẬT (AGENTS.md mục 50).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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
import { createProductCore } from "@/lib/records/product-create";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { blockInstruction, decideConversationOrder, separateOrderIntent, type ConversationOrder } from "@/lib/sales-chatbot/conversation-order-guard";
import { conversationFor } from "@/lib/sales-chatbot/fanpage";
import { executeTool, type ToolContext } from "@/lib/sales-chatbot/tools";

const ORG = "dup-guard";
const ADMIN_EMAIL = "chu@dup-guard.local";
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

    assert.equal(await blocks(), 4, "bốn lần chặn (ca 1 · 2 · Pancake · chốt) = bốn dòng nhật ký");
    const [log] = await db.select({ entityId: schema.auditLogs.entityId }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHAT_DUPLICATE_ORDER_BLOCKED"), eq(schema.auditLogs.entityId, staffA))).limit(1);
    assert.ok(log, "nhật ký trỏ về đơn của người");
  });
}

export async function testConversationOrderGuard() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop rào đơn trùng", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "RaoDonTrung@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
  console.log("  ✓ rào hội thoại đã có đơn của người: AI sau người cùng món ⇒ không tạo (kể cả tự chốt) · khác món ⇒ chuyển người · «đơn riêng» tường minh ⇒ tạo, không tự chốt · hội thoại khác ⇒ tạo · huỷ / ngoài cửa sổ không chặn · đơn Pancake cùng thread chặn · nháp trước người ⇒ không chốt · mỗi lần chặn một dòng nhật ký");
}
