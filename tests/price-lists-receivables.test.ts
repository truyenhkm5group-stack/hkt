/**
 * BẢNG GIÁ SỈ · HẠN MỨC NỢ · CÔNG NỢ · THU NỢ GỘP (0188 · docs/verticals/price-lists-receivables.md).
 *
 *  1. THUẦN — chọn bậc (bậc lớn nhất ≤ số lượng), thứ tự nguồn giá (bảng của khách → bảng mặc định → giá lẻ → CHƯA CÓ
 *     GIÁ), kiểm bảng (trùng bậc), chấm hạn mức (NULL = chưa khai ≠ 0), nhóm tuổi nợ, chia tiền cũ-trước-mới-sau.
 *  2. TỔ CHỨC THẬT (PGlite riêng, không Pancake): lưu bảng giá có quyền / lỗi đúng ô / một bảng mặc định; điều khoản bán;
 *     hạn mức chặn lượt CHỐT (tạo lẫn sửa) nhưng không chặn đơn Mới, và phần đã thu của chính đơn không bị đếm hai lần;
 *     công nợ tách phải thu (đã giao) / đã chốt chưa giao, quá hạn theo ngày giao + số ngày được nợ, khách chưa khai số
 *     ngày ⇒ chưa biết; thu nợ gộp ghi đúng các phiếu thu theo từng đơn, không thu vượt nợ, không nhận COD.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { agingBucket, allocatePayment, checkCredit, quoteUnitPrice, tierFor, validateTiers, type PriceListBook } from "@/lib/constants/price-lists";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { customerDebt, listReceivables } from "@/lib/queries/receivables";
import { confirmManualDeliveryCore, createManualOrderCore, updateManualOrderCore } from "@/lib/records/order-create";
import { recordManualPaymentCore } from "@/lib/records/order-payments";
import { collectCustomerDebtCore, deactivatePriceListCore, loadActivePriceBooks, manualOrderPricing, savePriceListCore, setCustomerTermsCore } from "@/lib/records/trade";

const ORG = "pl-si";

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

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));

function testPure() {
  const tiers = [
    { variantId: "a", minQuantity: 1, unitPrice: 90 },
    { variantId: "a", minQuantity: 10, unitPrice: 80 },
    { variantId: "a", minQuantity: 50, unitPrice: 70 },
    { variantId: "b", minQuantity: 5, unitPrice: 40 },
  ];
  assert.equal(tierFor(tiers, "a", 9)?.unitPrice, 90);
  assert.equal(tierFor(tiers, "a", 10)?.unitPrice, 80, "bậc đúng bằng số lượng thì khớp");
  assert.equal(tierFor(tiers, "a", 999)?.unitPrice, 70);
  assert.equal(tierFor(tiers, "b", 4), null, "chưa tới bậc thấp nhất ⇒ không bậc nào");
  const own: PriceListBook = { id: "own", name: "Đại lý", isDefault: false, tiers };
  const def: PriceListBook = { id: "def", name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "b", minQuantity: 1, unitPrice: 45 }, { variantId: "c", minQuantity: 1, unitPrice: 30 }] };
  assert.deepEqual(quoteUnitPrice({ variantId: "a", quantity: 12, retailPrice: 100, customerList: own, defaultList: def }), { unitPrice: 80, source: "CUSTOMER_LIST", listName: "Đại lý", minQuantity: 10 });
  assert.equal(quoteUnitPrice({ variantId: "b", quantity: 2, retailPrice: 50, customerList: own, defaultList: def })?.source, "DEFAULT_LIST", "bảng của khách không có bậc khớp ⇒ bảng mặc định");
  assert.equal(quoteUnitPrice({ variantId: "d", quantity: 1, retailPrice: 60, customerList: own, defaultList: def })?.source, "RETAIL");
  assert.equal(quoteUnitPrice({ variantId: "d", quantity: 1, retailPrice: 0, customerList: null, defaultList: null }), null, "giá lẻ 0 = CHƯA CÓ GIÁ, không phải 0đ");
  assert.equal(quoteUnitPrice({ variantId: "d", quantity: 1, retailPrice: null, customerList: null, defaultList: null }), null);
  assert.equal(quoteUnitPrice({ variantId: "a", quantity: Number.NaN, retailPrice: 100, customerList: own, defaultList: null })?.unitPrice, 90, "số lượng chưa nhập ⇒ coi như 1");

  assert.deepEqual(validateTiers([{ variantId: "a", minQuantity: 1, unitPrice: 1 }, { variantId: "a", minQuantity: 1, unitPrice: 2 }]).map((e) => e.field), ["tiers.1.minQuantity"]);
  assert.ok(validateTiers([{ variantId: "a", minQuantity: 0, unitPrice: 0 }]).length === 2);

  assert.deepEqual(checkCredit(null, 9_999_999, 1), { ok: true, limit: null, exposureAfter: 10_000_000 }, "hạn mức chưa khai ⇒ không chặn");
  assert.equal(checkCredit(0, 0, 1).ok, false, "hạn mức 0 là khai THẬT — không cho nợ");
  assert.equal(checkCredit(500, 230, 270).ok, true, "đúng bằng hạn mức vẫn qua");
  const over = checkCredit(500, 231, 270);
  assert.ok(!over.ok && over.overBy === 1);

  assert.deepEqual([-3, 0, 1, 30, 31, 60, 61, 90, 91].map(agingBucket), ["CURRENT", "CURRENT", "D1_30", "D1_30", "D31_60", "D31_60", "D61_90", "D61_90", "D90_PLUS"]);

  const debts = [
    { orderId: "erp-2", outstanding: 300, orderedAt: "2026-09-02" },
    { orderId: "erp-1", outstanding: 100, orderedAt: "2026-09-01" },
    { orderId: "erp-3", outstanding: 50, orderedAt: "2026-09-02" },
  ];
  const a = allocatePayment(350, debts);
  assert.ok(a.ok);
  assert.deepEqual(a.allocations, [
    { orderId: "erp-1", amount: 100 },
    { orderId: "erp-2", amount: 250 },
  ], "cũ nhất trước; cùng ngày thì theo mã đơn");
  assert.ok(!allocatePayment(451, debts).ok, "vượt tổng nợ ⇒ lỗi, không có đơn nào để ghi phần dư");
  assert.ok(!allocatePayment(0, debts).ok);
}

export async function testPriceListsReceivables() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản sỉ thử", plan: "standard", modules: ["customers", "products", "orders", "inventory"], admin: { email: `admin@${ORG}.local`, name: "QT sỉ", password: "GiaSi@12345" }, source: "TEST", actor: null });
  try {
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Hải sản sỉ thử", isHome: false };
      const admin = sessionOf(u, { name: "QT sỉ", organization: org, modules: [...enabled] });
      const viewer = sessionOf(u, { role: "VIEWER", permissions: ["customers:view", "products:view", "orders:read"], organization: org, modules: [...enabled] });

      const [ca] = await db.insert(schema.customers).values({ name: "Đại lý Biển Xanh", phone: "0901000001" }).returning({ id: schema.customers.id });
      const [cb] = await db.insert(schema.customers).values({ name: "Quán Hải Âu", phone: "0901000002" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-pl-prod", name: "Mực khô loại 1", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values([
        { id: "erp-pl-va", productId: "erp-pl-prod", sku: "MK-500", size: "500g", retailPrice: 100_000 },
        { id: "erp-pl-vb", productId: "erp-pl-prod", sku: "MK-1K", size: "1kg", retailPrice: 50_000 },
      ]);

      // ── Bảng giá: quyền, lỗi đúng ô, một bảng mặc định.
      const tiersA = [
        { variantId: "erp-pl-va", minQuantity: 1, unitPrice: 90_000 },
        { variantId: "erp-pl-va", minQuantity: 10, unitPrice: 80_000 },
      ];
      assert.equal(codeOf(await savePriceListCore(viewer, null, { name: "Đại lý", tiers: tiersA })), "FORBIDDEN");
      assert.deepEqual(fieldsOf(await savePriceListCore(admin, null, { name: "Đại lý", tiers: [...tiersA, { variantId: "khong-co", minQuantity: 1, unitPrice: 1 }] })), ["tiers.2.variantId"]);
      assert.deepEqual(fieldsOf(await savePriceListCore(admin, null, { name: "Đại lý", tiers: [...tiersA, { variantId: "erp-pl-va", minQuantity: 10, unitPrice: 1 }] })), ["tiers.2.minQuantity"]);
      const listA = await savePriceListCore(admin, null, { name: "Đại lý", tiers: tiersA });
      assert.ok(listA.ok);
      const def1 = await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "erp-pl-va", minQuantity: 5, unitPrice: 95_000 }] });
      const def2 = await savePriceListCore(admin, null, { name: "Sỉ mùa vụ", isDefault: true, tiers: [{ variantId: "erp-pl-va", minQuantity: 5, unitPrice: 93_000 }] });
      assert.ok(def1.ok && def2.ok);
      assert.deepEqual((await loadActivePriceBooks()).filter((b) => b.isDefault).map((b) => b.name), ["Sỉ mùa vụ"], "bật mặc định cho bảng này ⇒ bảng kia thôi mặc định");
      assert.equal(fieldsOf(await savePriceListCore(admin, null, { name: "Đại lý", tiers: [] }))[0], "name", "trùng tên bảng");

      // ── Điều khoản bán.
      assert.equal(codeOf(await setCustomerTermsCore(viewer, ca.id, { creditLimit: 1 })), "FORBIDDEN");
      assert.ok((await setCustomerTermsCore(admin, ca.id, { priceListId: listA.id, creditLimit: 500_000, paymentTermsDays: 7 })).ok);
      const pricing = await manualOrderPricing();
      const books = pricing.books;
      const own = books.find((b) => b.id === listA.id) ?? null;
      const dflt = books.find((b) => b.isDefault) ?? null;
      assert.equal(quoteUnitPrice({ variantId: "erp-pl-va", quantity: 12, retailPrice: 100_000, customerList: own, defaultList: dflt })?.unitPrice, 80_000);
      assert.equal(quoteUnitPrice({ variantId: "erp-pl-va", quantity: 6, retailPrice: 100_000, customerList: null, defaultList: dflt })?.unitPrice, 93_000, "khách chưa gán bảng ⇒ bảng mặc định");
      assert.equal(pricing.terms[ca.id]?.creditLimit, 500_000);

      // ── Hạn mức: chặn lượt CHỐT, không chặn đơn Mới, không đếm hai lần phần đã thu.
      const line = (q: number) => [{ variantId: "erp-pl-va", quantity: q, unitPrice: 90_000, discount: 0 }];
      const o1 = await createManualOrderCore(admin, { customerId: ca.id, stage: "CONFIRMED", lines: line(3) });
      assert.ok(o1.ok, JSON.stringify(o1));
      const blocked = await createManualOrderCore(admin, { customerId: ca.id, stage: "CONFIRMED", lines: line(3) });
      assert.deepEqual(fieldsOf(blocked), ["customerId"], "270k + 270k > 500k ⇒ chặn ở ô khách");
      const o2 = await createManualOrderCore(admin, { customerId: ca.id, stage: "NEW", lines: line(3) });
      assert.ok(o2.ok, "đơn Mới không chấm hạn mức");
      assert.deepEqual(fieldsOf(await updateManualOrderCore(admin, o2.id, { customerId: ca.id, stage: "CONFIRMED", lines: line(3) })), ["customerId"], "sửa sang Đã xác nhận cũng bị chấm");
      assert.ok((await recordManualPaymentCore(admin, o1.id, { kind: "RECEIPT", method: "CASH", amount: 100_000, paidAt: new Date().toISOString() })).ok);
      assert.ok((await updateManualOrderCore(admin, o2.id, { customerId: ca.id, stage: "CONFIRMED", lines: line(3) })).ok, "thu 100k ⇒ 170k + 270k = 440k ≤ 500k");
      assert.ok((await updateManualOrderCore(admin, o1.id, { customerId: ca.id, stage: "CONFIRMED", lines: line(3) })).ok, "sửa lại đơn đã thu một phần: phần đã thu của CHÍNH đơn không bị đếm hai lần");

      // ── Công nợ: giao o1 mười ngày trước, được nợ 7 ngày ⇒ quá 3 ngày.
      const signedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
      assert.ok((await confirmManualDeliveryCore(admin, o1.id, { signedAt, receiverName: "Anh Biển" })).ok);
      const d = await customerDebt(ca.id);
      assert.ok(d);
      assert.deepEqual([d.summary.receivable, d.summary.committed, d.summary.exposure, d.summary.overdue], [170_000, 270_000, 440_000, 170_000]);
      assert.equal(d.summary.maxDaysOverdue, 3);
      assert.equal(d.summary.buckets.D1_30, 170_000);
      assert.equal(d.summary.termsUnknown, false);
      assert.equal(d.summary.priceListName, "Đại lý");

      // Khách B: đơn đã giao, chưa khai số ngày được nợ ⇒ tuổi nợ CHƯA BIẾT, không đoán.
      const ob = await createManualOrderCore(admin, { customerId: cb.id, stage: "CONFIRMED", lines: [{ variantId: "erp-pl-vb", quantity: 2, unitPrice: 50_000, discount: 0 }] });
      assert.ok(ob.ok);
      assert.ok((await confirmManualDeliveryCore(admin, ob.id, { signedAt, receiverName: "Chị Âu" })).ok);
      const board = await listReceivables();
      assert.deepEqual(board.rows.map((r) => r.name), ["Đại lý Biển Xanh", "Quán Hải Âu"], "quá hạn lâu nhất trước");
      assert.equal(board.rows[1].termsUnknown, true);
      assert.equal(board.rows[1].overdue, 0);
      assert.deepEqual([board.totals.receivable, board.totals.committed, board.totals.overdue, board.totals.termsUnknown], [270_000, 270_000, 170_000, 1]);

      // ── Thu nợ gộp: cũ trước; mỗi đơn một phiếu thu; không vượt nợ; không COD; người không có orders:write bị chặn.
      const collect = { method: "BANK_TRANSFER", paidAt: new Date().toISOString(), reference: "FT-778" } as const;
      assert.equal(codeOf(await collectCustomerDebtCore(viewer, ca.id, { ...collect, amount: 1_000 })), "FORBIDDEN");
      assert.deepEqual(fieldsOf(await collectCustomerDebtCore(admin, ca.id, { ...collect, amount: 440_001 })), ["amount"]);
      assert.equal(codeOf(await collectCustomerDebtCore(admin, ca.id, { ...collect, method: "COD", amount: 1_000 })), "INVALID");
      const paid = await collectCustomerDebtCore(admin, ca.id, { ...collect, amount: 300_000 });
      assert.ok(paid.ok, JSON.stringify(paid));
      assert.deepEqual(paid.allocations, [
        { orderId: o1.id, amount: 170_000 },
        { orderId: o2.id, amount: 130_000 },
      ]);
      const pays = await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.reference, "FT-778"));
      assert.equal(pays.length, 2, "một phiếu thu cho mỗi đơn — không bảng tiền thứ hai");
      const after = await customerDebt(ca.id);
      assert.deepEqual([after!.summary.receivable, after!.summary.committed, after!.summary.overdue], [0, 140_000, 0], "o1 trả đủ ⇒ hết phải thu và hết quá hạn");

      // ── Ngừng dùng bảng ⇒ khách rơi về bảng mặc định; đơn cũ giữ giá đã lưu.
      assert.ok((await deactivatePriceListCore(admin, listA.id)).ok);
      assert.equal((await loadActivePriceBooks()).some((b) => b.id === listA.id), false);
      const [item] = await db.select({ unitPrice: schema.orderItems.unitPrice }).from(schema.orderItems).where(eq(schema.orderItems.orderId, o1.id));
      assert.equal(item.unitPrice, 90_000);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Bảng giá sỉ + công nợ: bậc lớn nhất ≤ số lượng, bảng khách → mặc định → giá lẻ → chưa có giá; một bảng mặc định; hạn mức chặn lượt chốt (tạo / sửa) không chặn đơn Mới, không đếm hai lần phần đã thu; phải thu tách đã chốt chưa giao, quá hạn theo ngày giao + số ngày nợ, chưa khai ⇒ chưa biết; thu nợ gộp cũ-trước, một phiếu thu mỗi đơn, không vượt nợ, không COD");
}
