/**
 * CHỐT ĐƠN SỈ ↔ SỔ NGÂN HÀNG + NHẮC MUA LẠI (P5 · P6 · 0267 · lib/wholesale/order-close.ts + reorder.ts).
 *
 *  1. THUẦN: nhắc mua lại chỉ khi đã khai X, đã có đơn giao thành công, quá X ngày từ đơn gần nhất, chưa có báo giá sau đơn đó,
 *     không có hẹn liên hệ từ hôm nay.
 *  2. TỔ CHỨC THẬT:
 *     · chỉ báo giá CHẤP NHẬN mới tạo đơn; giá đơn = ảnh chụp báo giá; bấm hai lần MỘT đơn; lead chưa là khách ⇒ thành khách + WON;
 *     · đề nghị đối chiếu chỉ giao dịch ĐÚNG số tiền VÀ có mã; nối qua `createLink` loại ORDER; không ghi phiếu thu nào;
 *     · nhắc mua lại chiếu lên /work (phòng SALES); hẹn liên hệ / báo giá mới rời hàng đợi; chưa khai X ⇒ không việc nào.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { createLink } from "@/lib/finance/linkage";
import { addDays, vnDateKey } from "@/lib/format";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { adaptWholesaleReorder } from "@/lib/queries/work-adapters";
import { confirmManualDeliveryCore, createManualOrderCore } from "@/lib/records/order-create";
import { savePriceListCore } from "@/lib/records/trade";
import { bankMatchesForQuotation, createOrderFromQuotationCore, orderForQuotation, quotationOrderKey } from "@/lib/wholesale/order-close";
import { createQuotationCore, markQuotationSentCore, recordQuotationDecisionCore } from "@/lib/wholesale/quotation";
import { saveWholesaleReorderSettingsCore, wholesaleReorderDue, wholesaleReorderDueFrom } from "@/lib/wholesale/reorder";

const ORG = "bg-chot";

function testPure() {
  const f = { lastOrderDay: "2026-09-01", deliveredOrders: 1, lastQuoteDay: null, nextContactOn: null };
  assert.equal(wholesaleReorderDueFrom(f, "2026-10-30", null), null, "chưa khai X ⇒ không nhắc (không số mặc định)");
  assert.equal(wholesaleReorderDueFrom(f, "2026-10-30", 30), "2026-10-01");
  assert.equal(wholesaleReorderDueFrom(f, "2026-09-30", 30), null, "chưa đủ X ngày");
  assert.equal(wholesaleReorderDueFrom({ ...f, deliveredOrders: 0 }, "2026-10-30", 30), null, "chưa có đơn giao thành công ⇒ không nhắc");
  assert.equal(wholesaleReorderDueFrom({ ...f, lastQuoteDay: "2026-10-20" }, "2026-10-30", 30), null, "đã có báo giá sau đơn ⇒ đã có người chăm");
  assert.equal(wholesaleReorderDueFrom({ ...f, nextContactOn: "2026-11-02" }, "2026-10-30", 30), null, "đã hẹn liên hệ ⇒ rời hàng đợi tới ngày hẹn");
  assert.equal(wholesaleReorderDueFrom({ ...f, nextContactOn: "2026-10-01" }, "2026-10-30", 30), "2026-10-01", "hẹn đã qua ⇒ lại đến hạn");
  console.log("  ✓ thuần: nhắc mua lại — không mặc định · cần đơn giao thành công · quá X ngày · báo giá mới / hẹn liên hệ rời hàng đợi");
}

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const errOf = (r: object) => ("error" in r ? String((r as { error: string }).error) : "");
let seq = 0;
const key = () => `oc-${Date.now()}-${++seq}`;

async function testOrg() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản chốt đơn sỉ", plan: "standard", modules: ["customers", "products", "orders", "inventory", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT chốt đơn", password: "ChotDon@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      // Không truyền `modules` ⇒ không cổng module (sổ ngân hàng thuộc module khác) — kiểm thử đường ghi, không kiểm menu.
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản chốt đơn sỉ", isHome: false } };
      const sale: SessionUser = { ...admin, role: "CS", permissions: ["wholesale:view", "wholesale:work"] };

      await db.insert(schema.products).values({ id: "oc-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "oc-va", productId: "oc-prod", sku: "CCT-1K", size: "1kg", retailPrice: 300_000 });
      assert.ok((await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "oc-va", minQuantity: 10, unitPrice: 250_000 }] })).ok);
      const [lead] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: "Nhà hàng Biển Đông", normalizedPhone: "+84905111222", phoneRaw: "0905111222", address: "12 Bạch Đằng, Đà Nẵng", enrichmentStatus: "READY", contactStatus: "INTERESTED" }).returning();
      const now = new Date();
      const today = vnDateKey(now);

      // ── Báo giá → đã gửi; chưa chấp nhận thì chưa tạo đơn.
      const q = await createQuotationCore(admin, { leadId: lead.id, lines: [{ variantId: "oc-va", quantity: 20 }], quoteDiscount: 0, shippingAmount: 120_000, shippingSource: "Báo giá cước nhà xe", validUntil: addDays(today, 7), requestKey: key() }, now);
      assert.ok("ok" in q, errOf(q));
      assert.ok("ok" in (await markQuotationSentCore(admin, q.id, now)));
      assert.match(errOf(await createOrderFromQuotationCore(admin, q.id, now)), /CHẤP NHẬN/);
      assert.ok("ok" in (await recordQuotationDecisionCore(admin, q.id, { decision: "ACCEPTED", reason: "Khách xác nhận qua Zalo" }, now)));
      assert.match(errOf(await createOrderFromQuotationCore(sale, q.id, now)), /orders:write/, "cần quyền tạo đơn");

      // ── Tạo đơn: lõi đơn tạo tay, giá = ảnh chụp, lead ⇒ khách + WON.
      const o = await createOrderFromQuotationCore(admin, q.id, now);
      assert.ok("ok" in o, errOf(o));
      const [ord] = await db.select().from(schema.orders).where(eq(schema.orders.id, o.orderId));
      assert.ok(ord.id.startsWith("erp-"), "đơn tạo tay");
      assert.equal(ord.totalPriceAfterDiscount + ord.shippingFee, 5_120_000, "tổng đơn = tổng báo giá (20 × 250.000 + ship 120.000)");
      assert.equal((ord.raw as { agentKey?: string }).agentKey, quotationOrderKey(q.id));
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, o.orderId));
      assert.deepEqual(items.map((i) => [i.variantId, i.quantity, i.unitPrice]), [["oc-va", 20, 250_000]], "dòng hàng + đơn giá đúng ảnh chụp");
      const [leadAfter] = await db.select().from(schema.wholesaleLeads).where(eq(schema.wholesaleLeads.id, lead.id));
      assert.deepEqual([leadAfter.contactStatus, Boolean(leadAfter.convertedAt), leadAfter.customerId, ord.customerId], ["WON", true, o.customerId, o.customerId]);
      const again = await createOrderFromQuotationCore(admin, q.id, now);
      assert.ok("ok" in again && again.orderId === o.orderId && again.replayed, "bấm hai lần ⇒ cùng một đơn");
      assert.equal((await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(sql`${schema.orders.raw}->>'agentKey' = ${quotationOrderKey(q.id)}`))[0].n, 1);

      // ── Đề nghị đối chiếu: ĐÚNG số tiền VÀ có mã; nối = đối chiếu, không phiếu thu.
      const qrow = (await db.select({ code: schema.wholesaleQuotations.code }).from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, q.id)))[0];
      const txn = async (amount: number, description: string) => (await db.insert(schema.bankTransactions).values({ txnAt: now, amount, description, bankRef: `oc-ref-${++seq}`, source: "MANUAL" }).returning({ id: schema.bankTransactions.id }))[0].id;
      const good = await txn(5_120_000, `CK ${qrow.code} thanh toan don hang`);
      await txn(5_120_000, "CK thanh toan tien hang");
      await txn(5_000_000, `CK ${qrow.code} dat coc`);
      const view = await bankMatchesForQuotation(admin, q.id, qrow.code);
      assert.ok(view);
      assert.deepEqual(view.suggestions.map((s) => s.txnId), [good], "chỉ giao dịch khớp CẢ số tiền lẫn mã");
      assert.equal(await bankMatchesForQuotation(sale, q.id, qrow.code), null, "không có quyền sổ ngân hàng ⇒ không thấy gì");
      const link = await createLink({ txnId: good, targetType: "ORDER", targetId: o.orderId, confidence: "MANUAL", method: "IDENTIFIER_MATCH", confirmedBy: admin.email, note: "đối chiếu từ báo giá sỉ" });
      assert.ok("ok" in link, errOf(link));
      const view2 = await bankMatchesForQuotation(admin, q.id, qrow.code);
      assert.ok(view2 && view2.suggestions.length === 0 && view2.linked.length === 1, "đã nối ⇒ rời danh sách đề nghị");
      assert.equal((await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.orderId, o.orderId))).length, 0, "KHÔNG ghi phiếu thu tự động");
      assert.ok("error" in (await createLink({ txnId: await txn(1_000, "x"), targetType: "ORDER", targetId: "123456", confidence: "MANUAL", method: "MANUAL", confirmedBy: admin.email })), "đơn Pancake / không có thật ⇒ không nối được");
      assert.equal((await orderForQuotation(q.id))?.id, o.orderId);

      // ── Nhắc mua lại: chưa khai X ⇒ không việc nào.
      const [cb] = await db.insert(schema.customers).values({ name: "Quán Hải Âu", phone: "0905333444" }).returning({ id: schema.customers.id });
      await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: "Quán Hải Âu", customerId: cb.id, enrichmentStatus: "READY", contactStatus: "WON" });
      const ob = await createManualOrderCore(admin, { customerId: cb.id, stage: "CONFIRMED", lines: [{ variantId: "oc-va", quantity: 10, unitPrice: 250_000 }] });
      assert.ok(ob.ok);
      assert.ok((await confirmManualDeliveryCore(admin, ob.id, { signedAt: now.toISOString(), receiverName: "Anh Âu" })).ok, "phiếu giao ký nhận ⇒ ORDER_OUTCOME giao thành công");
      await db.execute(sql`update orders set inserted_at = now() - interval '40 days' where id = ${ob.id}`);
      assert.deepEqual(await wholesaleReorderDue(today), []);
      assert.match(errOf(await saveWholesaleReorderSettingsCore(sale, { afterDays: 30, reason: "thử" })), /wholesale:config/);
      assert.ok("ok" in (await saveWholesaleReorderSettingsCore(admin, { afterDays: 30, reason: "Nhắc mua lại sau 30 ngày" })));

      // ── Khai X ⇒ khách B đến hạn (đơn giao thành công 40 ngày trước); khách A vừa đặt hôm nay ⇒ không.
      const due = await wholesaleReorderDue(today);
      assert.deepEqual(due.map((r) => r.customerId), [cb.id]);
      assert.equal(due[0].deliveredOrders, 1);
      const items2 = await adaptWholesaleReorder(now);
      assert.deepEqual(items2.map((i) => [i.sourceType, i.department, i.sourceUrl, i.statusAuthority]), [["WHOLESALE_REORDER", "SALES", `/customers/${cb.id}`, "SOURCE"]], "phép chiếu lên /work, phòng Kinh doanh, nút mở trang khách");

      // ── Hẹn liên hệ ⇒ rời hàng đợi; hết hẹn + có báo giá mới ⇒ vẫn rời.
      await db.insert(schema.customerTouchpoints).values({ customerId: cb.id, kind: "CALL", outcome: "NOT_NOW", nextContactOn: addDays(today, 3), userId: u.id, userName: u.name });
      assert.deepEqual(await wholesaleReorderDue(today), [], "đã hẹn ⇒ không còn việc");
      await db.delete(schema.customerTouchpoints).where(eq(schema.customerTouchpoints.customerId, cb.id));
      const qb = await createQuotationCore(admin, { customerId: cb.id, lines: [{ variantId: "oc-va", quantity: 10 }], validUntil: addDays(today, 7), requestKey: key() }, now);
      assert.ok("ok" in qb, errOf(qb));
      assert.deepEqual(await wholesaleReorderDue(today), [], "đã lập báo giá mới ⇒ không còn việc");

      // ── Tắt ⇒ không việc nào.
      await saveWholesaleReorderSettingsCore(admin, { afterDays: null, reason: "tắt" });
      assert.deepEqual(await adaptWholesaleReorder(now), []);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ tổ chức thật: chỉ báo giá CHẤP NHẬN ⇒ đơn tạo tay, giá = ảnh chụp, bấm hai lần một đơn, lead ⇒ khách + WON · đề nghị đối chiếu khớp số tiền VÀ mã · nối ORDER không ghi phiếu thu · nhắc mua lại /work SALES, hẹn / báo giá mới rời hàng đợi, không mặc định");
}

export async function testWholesaleOrderClose() {
  console.log("\n— Chốt đơn sỉ ↔ sổ ngân hàng + nhắc mua lại (P5 · P6 · 0267)");
  testPure();
  await testOrg();
}
