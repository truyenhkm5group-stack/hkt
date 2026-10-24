/**
 * ═══ PHA 3 TRÙNG ĐƠN — MUA BỔ SUNG GỘP VÀO ĐƠN BOT ĐANG MỞ CỦA CÙNG DANH TÍNH (vụ HSLC Ngọc #8639C563 → #E2867CF0) ═══
 *
 * Phần thuần: món khách nhắc lại KHÔNG cộng (vụ Ngọc: «chả cá thu thử 1k» trên đơn đã có chả cá thu), chỉ cộng khi chính mệnh đề có lời
 * tăng; không bao giờ bớt dòng. Phần tổ chức thật `dup-merge` (tự cấp, tự dọn; danh tính tiêm qua `setSameCustomerLookupForTests` — bộ
 * nạp thật do bài kiểm của identity-link.ts khoá):
 *  1. hội thoại kia VERIFIED có đơn bot ĐÃ TỰ CHỐT ⇒ gộp, KHÔNG đơn mới, câu máy chủ «gộp thêm … tổng mới …», một dòng nhật ký;
 *     vụ Ngọc: nguyên văn «1l nước mắm và 1k chả mực» ⇒ chuyển người (bộ đọc chưa hiểu «l» / «k», tổng ×3 chạm trần), có đơn vị bộ đọc hiểu
 *     ⇒ gộp đúng 830.000 ₫;
 *  2. khách chỉ nhắc lại món đã có ⇒ không ghi gì;
 *  3. đơn NGƯỜI đang mở / hội thoại kia đang người giữ ⇒ không tạo, chuyển người kèm món × số lượng;
 *  4. khách nói đơn riêng / người nhận khác ⇒ đơn mới; SAME_PHONE_ONLY ⇒ không gộp (lớp tạm giữ «Mới»);
 *  5. đơn CHỐT BẰNG LỜI ĐỒNG Ý của chính hội thoại + khách mua thêm ⇒ gộp thuần thêm; đổi địa chỉ vẫn chuyển người (ca «Đỗ Là»);
 *  6. đơn đích đã gửi đi ⇒ đơn mới.
 * Mốc theo ĐỒNG HỒ THẬT (AGENTS.md mục 50).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createOrderFromChatCore } from "@/lib/records/chat-order";
import { createProductCore } from "@/lib/records/product-create";
import { applyCustomerCartMessage } from "@/lib/sales-chatbot/cart-commitment";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { conversationFor } from "@/lib/sales-chatbot/fanpage";
import type { IdentityVerdict } from "@/lib/sales-chatbot/identity-link";
import { increasedVariants, mergeLinesForAddOn, setSameCustomerLookupForTests } from "@/lib/sales-chatbot/order-merge";
import { executeTool, type ChatState, type ToolContext } from "@/lib/sales-chatbot/tools";

const ORG = "dup-merge";
const ADMIN_EMAIL = "chu@dup-merge.local";
const PAGE = "5550003334";
const PHONE = "0372000555";
const ADDRESS = "12 Hàng Bạc, Hoàn Kiếm, Hà Nội";

function testPure() {
  const cct = { variantId: "cct", quantity: 1 };
  const nm = { variantId: "nm", quantity: 1 };
  const cm = { variantId: "cm", quantity: 1 };
  const ngoc = mergeLinesForAddOn([cct], [cct, nm, cm], new Set());
  assert.deepEqual(ngoc.lines, [cct, nm, cm], "vụ Ngọc: chả cá thu nhắc lại KHÔNG cộng ⇒ 1 + nước mắm + chả mực (830.000 ₫, không 1.110.000 ₫)");
  assert.deepEqual([ngoc.added.map((x) => x.variantId), ngoc.repeated], [["nm", "cm"], ["cct"]]);
  assert.deepEqual(mergeLinesForAddOn([cct], [{ variantId: "cct", quantity: 1 }], new Set(["cct"])).lines, [{ variantId: "cct", quantity: 2 }], "lời tăng tường minh ⇒ cộng");
  assert.deepEqual(mergeLinesForAddOn([{ variantId: "cct", quantity: 3 }, nm], [{ variantId: "cct", quantity: 1 }], new Set()).lines, [{ variantId: "cct", quantity: 3 }, nm], "không bao giờ bớt dòng / hạ số lượng");
  const products = [{ variantId: "cct", name: "Chả cá thu · Size: 1kg" }, { variantId: "nm", name: "Nước mắm" }, { variantId: "cm", name: "Chả mực" }];
  assert.deepEqual([...increasedVariants("lấy thêm nước mắm với chả mực, chả cá thu thử 1k", products)].sort(), ["cm", "nm"], "chỉ mệnh đề mang «thêm» mới tăng");
  assert.deepEqual([...increasedVariants("cho chị thêm 1kg chả cá thu nữa nhé", products)], ["cct"]);
  assert.deepEqual([...increasedVariants("chả cá thu 1k nhé em", products)], []);
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

const VERIFIED: IdentityVerdict = { level: "VERIFIED", evidence: [{ kind: "COMMENT_FROM_ID_IS_PSID", pageId: PAGE }], reason: null, detail: "" };
const PHONE_ONLY: IdentityVerdict = { level: "SAME_PHONE_ONLY", evidence: [{ kind: "SAME_PHONE" }], reason: null, detail: "" };

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const o = schema.orders;
    const admin = await adminOf();
    const mk = async (name: string, code: string, price: number) => {
      const p = await createProductCore(admin, { name, code, unit: "cái", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
      assert.ok(p.ok, JSON.stringify(p));
      const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
      assert.ok(v);
      return v.id;
    };
    const CCT = await mk("Chả cá thu", "CCT", 280_000);
    const NM = await mk("Nước mắm", "NM", 150_000);
    const agent = { name: "Bot bán hàng (thử)", source: "tests/order-merge.test.ts" };
    const links = new Map<string, { conversationId: string; verdict: IdentityVerdict; status: string; heldByHuman: boolean }[]>();
    setSameCustomerLookupForTests(async (id) => links.get(id) ?? []);
    const convOf = async (thread: string) => {
      const conv = await conversationFor(PAGE, `${PAGE}_${thread}`);
      assert.ok(conv);
      return conv;
    };
    const ctxOf = (convId: string, extra: Partial<ToolContext> = {}): ToolContext => ({ conversationId: convId, channel: "FANPAGE", config: { ...DEFAULT_SALES_CHATBOT_CONFIG }, state: {}, lastUserText: "", agent, now: new Date(), ...extra });
    const bot = async (convId: string, items: { variant_id: string; quantity: number }[], opts: { text?: string; autoConfirm?: boolean; phone?: string; state?: ChatState } = {}) => {
      const ctx = ctxOf(convId, { lastUserText: opts.text ?? "", ...(opts.autoConfirm ? { autoConfirm: true } : {}), ...(opts.state ? { state: opts.state } : {}) });
      const c1 = await executeTool("create_customer", { name: "Ngọc", phone: opts.phone ?? PHONE, address: ADDRESS }, ctx);
      assert.ok(!c1.isError, c1.content);
      return executeTool("create_draft_order", { items }, { ...ctx, state: c1.state });
    };
    const itemsOf = async (id: string) => (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, id))).map((x) => [x.v, x.q]).sort();
    const ordersOfConv = async (convId: string) => db.select({ id: o.id }).from(o).where(or(eq(o.salesConversationId, convId), sql`${o.raw}->>'agentKey' like ${`sales-chat:${convId}:%`}`));
    const merges = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHAT_ORDER_MERGED")))[0]?.n ?? 0;
    const link = (from: string, to: string, extra: Partial<{ verdict: IdentityVerdict; status: string; heldByHuman: boolean }> = {}) => links.set(from, [{ conversationId: to, verdict: VERIFIED, status: "OPEN", heldByHuman: false, ...extra }]);

    // ── 1 · Bình luận tự chốt chả cá thu; Messenger (VERIFIED) mua thêm nước mắm + nhắc lại chả cá thu ⇒ GỘP, không đơn mới ──
    const c1 = await convOf("c1");
    // Luồng BÌNH LUẬN thật (có tin kind = COMMENT) — lớp tạm SĐT trùng (#1039) chỉ chạy giữa bình luận ↔ hộp thư (ca SAME_PHONE_ONLY dưới).
    await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: `${PAGE}_c1`, messageId: "cmt-c1", text: "chả cá thu bao nhiêu", status: "DONE", kind: "COMMENT" });
    const a = await bot(c1.id, [{ variant_id: CCT, quantity: 1 }], { autoConfirm: true });
    const aId = a.state.confirmed?.orderId;
    assert.ok(!a.isError && aId && a.state.confirmed?.auto, `đơn bình luận tự chốt: ${a.content}`);
    const m1 = await convOf("m1");
    link(m1.id, c1.id);
    const r1 = await bot(m1.id, [{ variant_id: CCT, quantity: 1 }, { variant_id: NM, quantity: 1 }], { autoConfirm: true, text: "lấy thêm nước mắm nhé, chả cá thu thử 1k" });
    assert.ok(!r1.isError && r1.summary.startsWith(`Gộp vào đơn #${manualOrderShortCode(aId!)}`), `gộp: ${r1.summary} ${r1.content}`);
    const d1 = JSON.parse(r1.content) as { say_to_customer?: string; merged_into_order?: string; cod_total_text?: string };
    assert.equal(d1.merged_into_order, `#${manualOrderShortCode(aId!)}`);
    assert.ok(d1.say_to_customer?.startsWith("Dạ em gộp thêm 1 × Nước mắm") && d1.say_to_customer.includes(`vào đơn #${manualOrderShortCode(aId!)}`) && d1.say_to_customer.includes(`tổng mới ${d1.cod_total_text}`), `câu máy chủ, tổng máy chủ: ${d1.say_to_customer}`);
    assert.deepEqual(await itemsOf(aId!), [[CCT, 1], [NM, 1]].sort(), "chả cá thu GIỮ 1 (nhắc lại không cộng) + nước mắm");
    assert.deepEqual((await ordersOfConv(m1.id)).map((x) => x.id), [], "hội thoại Messenger KHÔNG có đơn mới");
    assert.equal(r1.state.draft?.orderId, aId, "hội thoại này nay cầm đúng đơn đã gộp");
    const [aRow] = await db.select({ stage: o.stage }).from(o).where(eq(o.id, aId!));
    assert.equal(aRow?.stage, "CONFIRMED", "đơn đã chốt giữ «Đã xác nhận»");
    assert.equal(await merges(), 1, "một lần gộp = một dòng nhật ký");

    // ── 1b · VỤ NGỌC trên đơn tự chốt chả cá thu 280.000 ₫, khách mua thêm nước mắm + chả mực ⇒ 830.000 ₫ (×2,96 > CONFIRMED_EDIT_MAX_GROWTH,
    // Tech Lead giữ trần). Giỏ dựng bằng CHÍNH `applyCustomerCartMessage` engine dùng; model gửi cả chả cá thu (như production) ⇒ không cộng.
    //  · NGUYÊN VĂN «1l nước mắm và 1k chả mực»: bộ đọc giỏ chưa hiểu «l» / «k» (đo trước khi dạy — việc riêng) ⇒ không «đã nói đơn vị» ⇒
    //    CART_TOTAL_CONFLICT, chuyển người — KHÔNG đơn thứ hai, KHÔNG ghi sai. Đây cũng là điều production làm với đúng câu ấy.
    //  · «1 chai nước mắm và 1kg chả mực» (đơn vị bộ đọc hiểu) ⇒ gộp, đúng 830.000 ₫. ──
    const CM = await mk("Chả mực", "CM", 400_000);
    const ngoc = async (tag: string, phone: string, text: string) => {
      const cn = await convOf(`ngoc-bl-${tag}`);
      const an = await bot(cn.id, [{ variant_id: CCT, quantity: 1 }], { autoConfirm: true, phone });
      const anId = an.state.confirmed?.orderId;
      assert.ok(!an.isError && anId, an.content);
      const mn = await convOf(`ngoc-ms-${tag}`);
      link(mn.id, cn.id);
      const ctxN = ctxOf(mn.id, { lastUserText: text, autoConfirm: true, turn: 3, customerTexts: [text], roundCustomerTexts: [text] });
      const cN = await executeTool("create_customer", { name: "Ngọc", phone, address: ADDRESS }, ctxN);
      assert.ok(!cN.isError, cN.content);
      const cart = applyCustomerCartMessage(cN.state.cart, text, 3, new Date(), { catalog: ["Chả cá thu", "Nước mắm", "Chả mực"], products: ["Chả cá thu", "Nước mắm", "Chả mực"] });
      const r = await executeTool("create_draft_order", { items: [{ variant_id: CCT, quantity: 1 }, { variant_id: NM, quantity: 1 }, { variant_id: CM, quantity: 1 }] }, { ...ctxN, state: { ...cN.state, ...(cart ? { cart } : {}) } });
      return { r, anId: anId!, mn };
    };
    const verbatim = await ngoc("nv", "0372000560", "1l nước mắm và 1k chả mực");
    assert.ok(verbatim.r.isError && /CART_TOTAL_CONFLICT/.test(verbatim.r.content) && /280\.000 ₫ ⇒ 830\.000 ₫/.test(verbatim.r.requireHuman ?? ""), `nguyên văn ⇒ chuyển người vì tổng tăng ×3: ${verbatim.r.requireHuman} ${verbatim.r.content}`);
    assert.deepEqual(await itemsOf(verbatim.anId), [[CCT, 1]], "đơn đã chốt KHÔNG bị sửa");
    assert.deepEqual(await ordersOfConv(verbatim.mn.id), [], "nguyên văn: Messenger KHÔNG có đơn thứ hai");
    const units = await ngoc("dv", "0372000561", "1 chai nước mắm và 1kg chả mực");
    assert.ok(!units.r.isError && units.r.summary.startsWith(`Gộp vào đơn #${manualOrderShortCode(units.anId)}`), `có đơn vị ⇒ gộp: ${units.r.summary} ${units.r.requireHuman ?? ""} ${units.r.content}`);
    assert.deepEqual(await itemsOf(units.anId), [[CCT, 1], [NM, 1], [CM, 1]].sort(), "chả cá thu GIỮ 1 + nước mắm + chả mực");
    const [nRow] = await db.select({ total: o.totalPriceAfterDiscount }).from(o).where(eq(o.id, units.anId));
    assert.equal(Number(nRow?.total), 830_000, "đúng 830.000 ₫ — không 1.110.000 ₫");
    assert.deepEqual(await ordersOfConv(units.mn.id), [], "Messenger KHÔNG có đơn thứ hai");

    // ── 2 · Chỉ nhắc lại món đã có ⇒ không ghi gì ──
    const c2 = await convOf("c2");
    const b = await bot(c2.id, [{ variant_id: CCT, quantity: 1 }], { autoConfirm: true, phone: "0372000556" });
    const m2 = await convOf("m2");
    link(m2.id, c2.id);
    const r2 = await bot(m2.id, [{ variant_id: CCT, quantity: 1 }], { phone: "0372000556", text: "chả cá thu 1k nhé em" });
    assert.ok(!r2.isError && r2.summary.startsWith("Món đã có trong đơn"), r2.content);
    assert.deepEqual(await itemsOf(b.state.confirmed!.orderId!), [[CCT, 1]]);
    assert.equal(await merges(), 2, "ca 1 + ca 1b (có đơn vị) gộp; nguyên văn bị chặn và ca chỉ nhắc lại không thêm dòng nhật ký");

    // ── 3 · Đơn NGƯỜI đang mở / hội thoại kia người giữ ⇒ không tạo, chuyển người kèm món × số lượng ──
    const c3 = await convOf("c3");
    const staff = await createOrderFromChatCore(admin, c3.id, { requestKey: "dupmerge-req-1", name: "Ngọc", phone: "0372000557", address: ADDRESS, stage: "CONFIRMED", lines: [{ variantId: CCT, quantity: 1, unitPrice: 280_000 }] });
    assert.ok(staff.ok);
    const m3 = await convOf("m3");
    link(m3.id, c3.id);
    const r3 = await bot(m3.id, [{ variant_id: NM, quantity: 2 }], { phone: "0372000557", text: "lấy thêm 2 chai nước mắm" });
    assert.ok(r3.isError && r3.requireHuman?.includes("Nước mắm × 2") && r3.requireHuman.includes(`#${manualOrderShortCode(staff.orderId)}`), `${r3.requireHuman} / ${r3.content}`);
    assert.deepEqual(await ordersOfConv(m3.id), []);
    const c4 = await convOf("c4");
    const held = await bot(c4.id, [{ variant_id: CCT, quantity: 1 }], { autoConfirm: true, phone: "0372000558" });
    const m4 = await convOf("m4");
    link(m4.id, c4.id, { heldByHuman: true });
    const r4 = await bot(m4.id, [{ variant_id: NM, quantity: 1 }], { phone: "0372000558", text: "lấy thêm nước mắm" });
    assert.ok(r4.isError && r4.requireHuman?.includes(`#${manualOrderShortCode(held.state.confirmed!.orderId!)}`), `hội thoại kia người giữ ⇒ coi như đơn người: ${r4.requireHuman}`);

    // ── 4 · Đơn riêng / người nhận khác ⇒ đơn mới; SAME_PHONE_ONLY ⇒ không gộp ──
    const m5 = await convOf("m5");
    link(m5.id, c1.id);
    const r5 = await bot(m5.id, [{ variant_id: NM, quantity: 1 }], { text: "lên cho chị 1 đơn riêng giao cho mẹ nhé" });
    assert.ok(!r5.isError && r5.state.draft?.orderId && r5.state.draft.orderId !== aId, `đơn riêng tường minh ⇒ đơn mới: ${r5.content}`);
    const m6 = await convOf("m6");
    link(m6.id, c1.id);
    const r6 = await bot(m6.id, [{ variant_id: NM, quantity: 1 }], { phone: "0909000999", text: "lấy thêm nước mắm" });
    assert.ok(!r6.isError && r6.state.draft?.orderId && r6.state.draft.orderId !== aId, `người nhận khác (SĐT khác) ⇒ đơn mới: ${r6.content}`);
    const m7 = await convOf("m7");
    link(m7.id, c1.id, { verdict: PHONE_ONLY });
    const r7 = await bot(m7.id, [{ variant_id: NM, quantity: 1 }], { autoConfirm: true, text: "lấy thêm nước mắm" });
    // Lớp tạm trỏ đơn bot đang mở MỚI NHẤT cùng SĐT (lúc này là đơn riêng của ca trên), không nhất thiết đơn A.
    assert.ok(!r7.isError && r7.state.draft?.orderId !== aId && Boolean(r7.state.draft?.samePhoneOf) && !r7.state.confirmed, `SAME_PHONE_ONLY ⇒ không gộp, lớp tạm giữ «Mới»: ${r7.content}`);

    // ── 5 · Đơn chốt bằng LỜI ĐỒNG Ý của chính hội thoại + khách mua thêm ⇒ gộp thuần thêm; đổi địa chỉ vẫn chuyển người (Đỗ Là) ──
    const x = await convOf("x");
    const xa = await bot(x.id, [{ variant_id: CCT, quantity: 1 }], { autoConfirm: true, phone: "0372000559" });
    const consent: ChatState = { ...xa.state, confirmed: { ...xa.state.confirmed!, auto: false } };
    const r8 = await executeTool("create_draft_order", { items: [{ variant_id: NM, quantity: 1 }] }, ctxOf(x.id, { state: consent, lastUserText: "lấy thêm nước mắm nữa nhé", turn: 7 }));
    assert.ok(!r8.isError && r8.summary.startsWith("Gộp vào đơn"), `đơn chốt bằng lời đồng ý + mua thêm ⇒ gộp, không chuyển người: ${r8.summary} ${r8.content}`);
    assert.deepEqual(await itemsOf(xa.state.confirmed!.orderId!), [[CCT, 1], [NM, 1]].sort());
    const r9 = await executeTool("update_draft_order", { address: "99 Lê Lợi, Quận 1, TP HCM" }, ctxOf(x.id, { state: { ...r8.state, confirmed: { ...r8.state.confirmed!, auto: false } }, lastUserText: "đổi địa chỉ giúp chị sang 99 Lê Lợi", turn: 9 }));
    assert.ok(r9.isError && /Sửa đơn đã chốt/.test(r9.requireHuman ?? ""), `đổi địa chỉ đơn chốt bằng lời đồng ý ⇒ vẫn chuyển người: ${r9.requireHuman}`);

    // ── 6 · Đơn đích đã gửi đi ⇒ không còn «đang mở» ⇒ đơn mới ──
    await db.update(o).set({ stage: "SHIPPED" }).where(eq(o.id, aId!));
    const m8 = await convOf("m8");
    link(m8.id, c1.id);
    const r10 = await bot(m8.id, [{ variant_id: NM, quantity: 1 }], { text: "lấy thêm nước mắm" });
    assert.ok(!r10.isError && r10.state.draft?.orderId && r10.state.draft.orderId !== aId, `đơn đích đã gửi ⇒ đơn mới: ${r10.content}`);
    void and;
  });
}

export async function testOrderMerge() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop gộp đơn", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "GopDon@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    setSameCustomerLookupForTests(null);
    await cleanupOrg(ORG);
  }
  console.log("  ✓ pha 3 gộp mua bổ sung: món nhắc lại không cộng (vụ Ngọc) · hội thoại kia VERIFIED + đơn bot tự chốt ⇒ gộp, không đơn mới, câu + tổng máy chủ · chỉ nhắc lại ⇒ không ghi · đơn người / hội thoại người giữ ⇒ chuyển người kèm món × SL · đơn riêng / người nhận khác ⇒ đơn mới · SAME_PHONE_ONLY ⇒ lớp tạm · đơn chốt bằng lời đồng ý + mua thêm ⇒ gộp, đổi địa chỉ vẫn chuyển người · đơn đích đã gửi ⇒ đơn mới");
}
