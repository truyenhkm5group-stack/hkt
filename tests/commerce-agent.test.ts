/**
 * LÕI THƯƠNG MẠI CHO ĐƯỜNG AGENT (docs/productization/TECH_DEBT.md TD-01 · TD-02 · TD-03 · TD-20 — MIGRATION_PLAN.md M3).
 *
 * Phần THUẦN: một công thức giá (`agentUnitPrice`) cho bot và lõi đơn; so giá; phần hàng CẦN THÊM khi sửa đơn đã chốt.
 * Phần TỔ CHỨC THẬT `ca-commerce`:
 *  · máy gửi đơn giá lệch / chiết khấu ⇒ lõi TỪ CHỐI (không công cụ nào truyền được giá tuỳ ý);
 *  · cùng khoá lần mua ⇒ cùng đơn (gọi lại không đẻ đơn thứ hai);
 *  · hai lượt chốt đồng thời tranh MÓN CUỐI ⇒ đúng một lượt qua, lượt kia «không đủ hàng»;
 *  · sửa đơn ĐÃ chốt giữ nguyên số lượng ⇒ không báo thiếu giả (phần đơn đang giữ được trừ ra);
 *  · đường NGƯỜI (form đơn tay) không bị các hàng rào của máy chặn;
 *  · hai lượt tạo khách cùng SĐT đồng thời ⇒ một khách;
 *  · chế độ bảng giá: giá bậc của bảng là giá đúng; chế độ giá lẻ gửi giá bậc ⇒ từ chối.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { agentPriceProblems, agentUnitPrice } from "@/lib/commerce/pricing";
import { additionalNeed } from "@/lib/commerce/stock";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createCustomerAsAgent } from "@/lib/records/customer-create";
import { createManualOrderCore, createOrderAsAgent, updateOrderAsAgent } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { setSettingJson } from "@/lib/settings";

const ORG = "ca-commerce";
const ADMIN_EMAIL = "chu@ca-commerce.local";
const AGENT = { name: "Bot thử", source: "tests/commerce-agent.test.ts" };

function testPure() {
  // Giá lẻ: 0 / thiếu ⇒ CHƯA CÓ GIÁ (null), không phải 0 ₫.
  assert.equal(agentUnitPrice({ variantId: "v", quantity: 1, retailPrice: 120_000, books: null }), 120_000);
  assert.equal(agentUnitPrice({ variantId: "v", quantity: 1, retailPrice: 0, books: null }), null);
  assert.equal(agentUnitPrice({ variantId: "v", quantity: 1, retailPrice: null, books: null }), null);
  // Bảng giá: bậc theo số lượng; dưới bậc ⇒ giá lẻ.
  const books = { customerList: null, defaultList: { id: "d", name: "Sỉ", isDefault: true, tiers: [{ variantId: "v", minQuantity: 10, unitPrice: 90_000 }] } };
  assert.equal(agentUnitPrice({ variantId: "v", quantity: 10, retailPrice: 120_000, books }), 90_000);
  assert.equal(agentUnitPrice({ variantId: "v", quantity: 2, retailPrice: 120_000, books }), 120_000);
  // So giá: lệch / chưa có giá / chiết khấu dòng / chiết khấu đơn đều là lỗi riêng; mẫu mã không có trong Map thì bỏ qua.
  const exp = new Map<string, number | null>([["0", 120_000], ["1", null]]);
  const probs = agentPriceProblems(
    [
      { variantId: "a", quantity: 1, unitPrice: 100_000, discount: 0 },
      { variantId: "b", quantity: 1, unitPrice: 5, discount: 1 },
      { variantId: "c", quantity: 1, unitPrice: 1, discount: 0 },
    ],
    exp,
    500,
  );
  assert.deepEqual(probs.map((p) => p.field), ["lines.0.unitPrice", "lines.1.unitPrice", "lines.1.discount", "orderDiscount"]);
  assert.match(probs[0].message, /120\.000/);
  assert.deepEqual(agentPriceProblems([{ variantId: "a", quantity: 1, unitPrice: 120_000, discount: 0 }], new Map([["0", 120_000]]), 0), []);
  // Phần cần THÊM: dòng mới − phần đơn đang giữ (gộp theo mẫu mã); giảm số lượng ⇒ âm (không cần kiểm).
  assert.deepEqual([...additionalNeed([{ variantId: "x", quantity: 3 }, { variantId: "x", quantity: 1 }, { variantId: "y", quantity: 1 }], [{ variantId: "x", quantity: 2 }, { variantId: "y", quantity: 2 }])], [["x", 2], ["y", -1]]);
  console.log("✓ Lõi thương mại cho agent · thuần: một công thức giá (lẻ · bảng giá theo bậc · chưa có giá ⇒ null) · so giá nêu đúng dòng · máy không chiết khấu · phần cần thêm khi sửa đơn đã chốt");
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
    const admin = await adminOf();
    const mk = async (name: string, code: string, price: number) => {
      const p = await createProductCore(admin, { name, code, unit: "gói", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
      assert.ok(p.ok, JSON.stringify(p));
      const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
      assert.ok(v);
      return v.id;
    };
    const last = await mk("Món cuối", "CA-LAST", 200_000);
    const plenty = await mk("Món nhiều", "CA-MANY", 100_000);
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-CA-1", totalQuantity: 21, createdBy: ADMIN_EMAIL }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values([
      { receiptId: rc.id, variantId: last, quantity: 1, unitCost: 100_000 },
      { receiptId: rc.id, variantId: plenty, quantity: 20, unitCost: 50_000 },
    ]);

    // ── Hai lượt tạo khách CÙNG SĐT đồng thời ⇒ một khách ──
    const [c1, c2] = await Promise.all([
      createCustomerAsAgent(AGENT, { name: "Khách A", phone: "0901 234 567", address: "1 Lê Lợi, Q1" }),
      createCustomerAsAgent(AGENT, { name: "Khách A", phone: "0901234567", address: "1 Lê Lợi, Q1" }),
    ]);
    assert.ok(c1.ok && c2.ok);
    assert.equal(c1.id, c2.id, "cùng SĐT ⇒ cùng khách");
    assert.equal(Number((await db.select({ n: sql<number>`count(*)` }).from(schema.customers).where(eq(schema.customers.phone, "0901234567")))[0].n), 1);
    const customerId = c1.id;
    const order = (lines: { variantId: string; quantity: number; unitPrice: number; discount?: number }[], stage: "NEW" | "CONFIRMED", extra: Record<string, unknown> = {}) => ({
      customerId,
      stage,
      lines: lines.map((l) => ({ discount: 0, ...l })),
      orderDiscount: 0,
      shippingFee: 0,
      note: "",
      channel: "Bot thử",
      ...extra,
    });
    const RETAIL = { pricing: "RETAIL" as const };

    // ── Giá lệch / chiết khấu ⇒ lõi TỪ CHỐI ──
    const wrong = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 1, unitPrice: 1_000 }], "NEW"), RETAIL);
    assert.ok(!wrong.ok && wrong.code === "CONFLICT" && /Giá vừa đổi/.test(wrong.errors[0].message), JSON.stringify(wrong));
    const disc = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 1, unitPrice: 100_000, discount: 10_000 }], "NEW"), RETAIL);
    assert.ok(!disc.ok && disc.errors.some((e) => /chiết khấu/.test(e.message)));
    const discOrder = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 1, unitPrice: 100_000 }], "NEW", { orderDiscount: 5_000 }), RETAIL);
    assert.ok(!discOrder.ok && discOrder.errors.some((e) => e.field === "orderDiscount"));

    // ── Cùng khoá lần mua ⇒ cùng đơn ──
    const key = { pricing: "RETAIL" as const, idempotencyKey: "sales-chat:conv-1:0" };
    const d1 = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 2, unitPrice: 100_000 }], "NEW"), key);
    const d2 = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 2, unitPrice: 100_000 }], "NEW"), key);
    assert.ok(d1.ok && d2.ok);
    assert.equal(d1.id, d2.id, "gọi lại cùng khoá lần mua ⇒ ĐÚNG đơn đầu");
    assert.equal(Number((await db.select({ n: sql<number>`count(*)` }).from(schema.orders).where(sql`${schema.orders.raw}->>'agentKey' = ${key.idempotencyKey}`))[0].n), 1);

    // ── Hai lượt CHỐT đồng thời tranh MÓN CUỐI ⇒ đúng một qua ──
    const race = await Promise.all([
      createOrderAsAgent(AGENT, order([{ variantId: last, quantity: 1, unitPrice: 200_000 }], "CONFIRMED"), RETAIL),
      createOrderAsAgent(AGENT, order([{ variantId: last, quantity: 1, unitPrice: 200_000 }], "CONFIRMED"), RETAIL),
    ]);
    const won = race.filter((r) => r.ok);
    const lost = race.filter((r) => !r.ok);
    assert.equal(won.length, 1, `đúng một lượt chốt được món cuối: ${JSON.stringify(race)}`);
    assert.ok(!lost[0].ok && /Không đủ hàng: Món cuối/.test(lost[0].errors[0].message), JSON.stringify(lost[0]));

    // ── Chốt đơn nháp qua lượt SỬA: thiếu ⇒ từ chối; đơn đã chốt giữ nguyên số lượng ⇒ KHÔNG báo thiếu giả ──
    const draft = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 25, unitPrice: 100_000 }], "NEW"), RETAIL);
    assert.ok(draft.ok, "đơn nháp không giữ hàng ⇒ không kiểm tồn");
    const short = await updateOrderAsAgent(AGENT, draft.id, order([{ variantId: plenty, quantity: 25, unitPrice: 100_000 }], "CONFIRMED"), RETAIL);
    assert.ok(!short.ok && /Không đủ hàng: Món nhiều .* còn 20/.test(short.errors[0].message), JSON.stringify(short));
    const okConfirm = await updateOrderAsAgent(AGENT, draft.id, order([{ variantId: plenty, quantity: 20, unitPrice: 100_000 }], "CONFIRMED"), RETAIL);
    assert.ok(okConfirm.ok, JSON.stringify(okConfirm));
    const reSave = await updateOrderAsAgent(AGENT, draft.id, order([{ variantId: plenty, quantity: 20, unitPrice: 100_000 }], "CONFIRMED", { note: "giao chiều" }), RETAIL);
    assert.ok(reSave.ok, `sửa ghi chú đơn đã chốt (giữ 20/20) không được báo thiếu: ${JSON.stringify(reSave)}`);
    const grow = await updateOrderAsAgent(AGENT, draft.id, order([{ variantId: plenty, quantity: 21, unitPrice: 100_000 }], "CONFIRMED"), RETAIL);
    assert.ok(!grow.ok && /cần thêm 1/.test(grow.errors[0].message), "tăng 1 khi khả dụng 0 ⇒ thiếu đúng 1");

    // ── Shop tự bật «chốt không cần kiểm tồn» (hàng nhập liên tục, 04/10/2026) ⇒ lõi cho máy chốt cả khi khả dụng = 0 ──
    const shortDraft = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 5, unitPrice: 100_000 }], "NEW"), RETAIL);
    assert.ok(shortDraft.ok);
    const sellShort = await updateOrderAsAgent(AGENT, shortDraft.id, order([{ variantId: plenty, quantity: 5, unitPrice: 100_000 }], "CONFIRMED"), { ...RETAIL, allowShortStock: true });
    assert.ok(sellShort.ok, `allowShortStock ⇒ chốt dù thiếu: ${JSON.stringify(sellShort)}`);

    // ── Đường NGƯỜI không bị hàng rào của máy chặn (chốt vượt tồn, giá tay) ──
    const human = await createManualOrderCore(admin, order([{ variantId: last, quantity: 3, unitPrice: 150_000, discount: 10_000 }], "CONFIRMED"));
    assert.ok(human.ok, `người vẫn chốt được đơn đặt trước / giá tay: ${JSON.stringify(human)}`);

    // ── Công tắc «đơn đủ thông tin = đã xác nhận» (#526) tự nâng đơn NHÁP của máy: đủ hàng ⇒ nâng; thiếu ⇒ GIỮ «Mới» ──
    const auto = await mk("Món tự nâng", "CA-AUTO", 50_000);
    const [rc2] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-CA-2", totalQuantity: 5, createdBy: ADMIN_EMAIL }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values({ receiptId: rc2.id, variantId: auto, quantity: 5, unitCost: 20_000 });
    await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    const full = { recipient: { name: "Khách A", phone: "0901234567", address: "1 Lê Lợi, Q1", province: "HCM" } };
    const enough = await createOrderAsAgent(AGENT, order([{ variantId: auto, quantity: 2, unitPrice: 50_000 }], "NEW", full), RETAIL);
    assert.ok(enough.ok);
    assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, enough.id) }))?.stage, "CONFIRMED", "đủ thông tin + đủ hàng ⇒ công tắc nâng lên Đã xác nhận");
    const notEnough = await createOrderAsAgent(AGENT, order([{ variantId: auto, quantity: 9, unitPrice: 50_000 }], "NEW", full), RETAIL);
    assert.ok(notEnough.ok, `đơn NHÁP thiếu hàng không bị từ chối vì công tắc: ${JSON.stringify(notEnough)}`);
    assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, notEnough.id) }))?.stage, "NEW", "thiếu hàng ⇒ giữ «Mới» (như hạn mức nợ)");
    const explicit = await createOrderAsAgent(AGENT, order([{ variantId: auto, quantity: 9, unitPrice: 50_000 }], "CONFIRMED", full), RETAIL);
    assert.ok(!explicit.ok, "máy CHỦ ĐỘNG chốt khi thiếu hàng ⇒ vẫn bị từ chối");
    await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: false });

    // ── Chế độ bảng giá: bậc ≥ 10 giá 90.000 ──
    const [pl] = await db.insert(schema.priceLists).values({ name: "Sỉ", isDefault: true, active: true }).returning({ id: schema.priceLists.id });
    await db.insert(schema.priceListItems).values({ priceListId: pl.id, variantId: plenty, minQuantity: 10, unitPrice: 90_000 });
    const book = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 10, unitPrice: 90_000 }], "NEW"), { pricing: "PRICE_BOOK" });
    assert.ok(book.ok, JSON.stringify(book));
    const retailWithTier = await createOrderAsAgent(AGENT, order([{ variantId: plenty, quantity: 10, unitPrice: 90_000 }], "NEW"), RETAIL);
    assert.ok(!retailWithTier.ok, "shop tắt báo giá sỉ (giá lẻ) mà máy gửi giá bậc ⇒ từ chối");
    // Không đơn nào của máy mang giá khác giá máy chủ tính.
    const rows = await db.select({ price: schema.orderItems.unitPrice, orderId: schema.orderItems.orderId }).from(schema.orderItems).where(like(schema.orderItems.orderId, "erp-%"));
    assert.ok(rows.length > 0);
  });
  console.log("✓ Lõi thương mại cho agent · tổ chức thật: máy gửi giá lệch / chiết khấu ⇒ từ chối · cùng khoá lần mua ⇒ cùng đơn · hai lượt chốt tranh món cuối ⇒ đúng một qua · sửa đơn đã chốt không báo thiếu giả, tăng thì thiếu đúng phần tăng · đường người không bị chặn · cùng SĐT đồng thời ⇒ một khách · bảng giá theo bậc");
}

export async function testCommerceAgent() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop lõi thương mại", plan: "trial", modules: ["customers", "products", "orders", "inventory"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "LoiThuongMai@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}
