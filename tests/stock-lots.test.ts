/**
 * LÔ & HẠN DÙNG (module `lots`, 0199 · docs/verticals/food-lots.md) + mẫu thực phẩm / hải sản bản 1.1.0.
 *
 *  1. THUẦN — ngày hết hạn vẫn dùng được, cận hạn theo cửa sổ người xem chọn; ước tính rải tồn vào lô theo dòng nhập MỚI NHẤT
 *     trước (lô hạn xa giữ trước, phần chưa gắn lô giữ sau cùng), tồn chưa biết ⇒ null, tồn âm ⇒ 0; thứ tự lấy hàng hạn gần
 *     trước và bỏ lô đã hết hạn.
 *  2. TỔ CHỨC THẬT (`lt-food`, cài mẫu thực phẩm): quyền lots:write; gắn lô vượt phần còn của dòng ⇒ chặn; trùng mã trên một
 *     dòng ⇒ chặn; dòng xuất kho ⇒ không gắn được; NSX sau HSD ⇒ chặn; gắn / gỡ lô KHÔNG đổi tồn thực tế; lô cận hạn / hết hạn
 *     đúng theo ước tính; mẫu mã chưa có phiếu nhập ⇒ «còn» chưa biết; lựa chọn của form chỉ dòng còn phần chưa gắn.
 *
 * Mốc ngày đi theo ĐỒNG HỒ THẬT (luật 50): mọi ngày dựng tương đối từ hôm nay.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { FOOD_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/food-commerce";
import { SEAFOOD_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/seafood-commerce";
import { estimateLotRemaining, fefoPickOrder, lotExpiryState, parseLotWindow } from "@/lib/constants/lots";
import { moduleDef } from "@/lib/constants/platform-modules";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { lotBoard, lotItemOptions } from "@/lib/queries/stock-lots";
import { createStockLotCore, deleteStockLotCore } from "@/lib/records/stock-lots";

const ORG = "lt-food";

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

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));
const vnDay = (offsetDays = 0) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const vnStart = (offsetDays: number) => new Date(`${vnDay(offsetDays)}T00:00:00+07:00`);

function testPure() {
  assert.deepEqual(lotExpiryState("2026-10-10", "2026-10-10", 7), { state: "NEAR", daysLeft: 0 }, "ngày hết hạn vẫn còn dùng được");
  assert.deepEqual(lotExpiryState("2026-10-09", "2026-10-10", 7), { state: "EXPIRED", daysLeft: -1 });
  assert.equal(lotExpiryState("2026-10-18", "2026-10-10", 7).state, "OK");
  assert.equal(lotExpiryState("2026-10-17", "2026-10-10", 7).state, "NEAR");
  assert.equal(parseLotWindow("14"), 14);
  assert.equal(parseLotWindow("13"), 30, "cửa sổ lạ ⇒ mặc định 30");

  const lines = [
    { itemId: "r1", receivedAt: "2026-08-01", quantity: 10, lots: [{ id: "A1", expiresOn: "2026-10-01", quantity: 10 }] },
    { itemId: "r2", receivedAt: "2026-09-10", quantity: 10, lots: [{ id: "B1", expiresOn: "2026-10-20", quantity: 6 }] },
    { itemId: "r3", receivedAt: "2026-09-25", quantity: 5, lots: [{ id: "C1", expiresOn: "2027-01-01", quantity: 3 }, { id: "C2", expiresOn: "2026-12-01", quantity: 2 }] },
  ];
  const e13 = estimateLotRemaining(lines, 13);
  assert.deepEqual([...e13.remaining.entries()].sort(), [["A1", 0], ["B1", 6], ["C1", 3], ["C2", 2]], "dòng mới nhất giữ hàng trước");
  assert.equal(e13.untracked, 2, "phần chưa gắn lô của dòng r2 giữ 2");
  assert.equal(e13.unexplained, 0);
  const e4 = estimateLotRemaining(lines, 4);
  assert.deepEqual([e4.remaining.get("C1"), e4.remaining.get("C2"), e4.remaining.get("B1")], [3, 1, 0], "trong một dòng lô hạn XA giữ trước — hạn gần đi trước (FEFO)");
  assert.equal(estimateLotRemaining(lines, null).remaining.get("A1"), null, "tồn chưa biết ⇒ null, không phải 0");
  assert.equal(estimateLotRemaining(lines, -5).remaining.get("C1"), 0, "tồn âm ⇒ lô còn 0");
  assert.equal(estimateLotRemaining(lines, 30).unexplained, 5, "tồn vượt mọi dòng nhập ⇒ phần dư không quy về lô nào");
  const pick = fefoPickOrder(
    [
      { id: "x", expiresOn: "2026-10-01", remaining: 5 },
      { id: "y", expiresOn: "2026-12-01", remaining: 1 },
      { id: "z", expiresOn: "2026-10-20", remaining: 2 },
      { id: "w", expiresOn: "2026-10-15", remaining: 0 },
    ],
    "2026-10-10",
  );
  assert.deepEqual(pick.map((p) => p.id), ["z", "y"], "hạn gần trước; bỏ lô đã hết hạn và lô không còn hàng");

  assert.ok(FOOD_COMMERCE_BLUEPRINT.modules.includes("lots") && SEAFOOD_COMMERCE_BLUEPRINT.modules.includes("lots"));
  assert.equal(FOOD_COMMERCE_BLUEPRINT.version, "1.1.0");
  assert.equal(moduleDef("lots")?.homeOptIn, true, "module lô TẮT ở tổ chức nhà");
}

export async function testStockLots() {
  testPure();
  const home = await getHomeOrganization();
  assert.ok(!(await getEnabledModules(home.code)).has("lots"), "0199: tổ chức nhà KHÔNG bật lô");
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Thực phẩm thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT thực phẩm", password: "ThucPham@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (over: Partial<SessionUser> = {}): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT thực phẩm", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Thực phẩm thử", isHome: false }, modules: [...(await getEnabledModules(ORG))], ...over });
      let admin = await sessionOf();
      const plan = await planForOrg(FOOD_COMMERCE_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      assert.ok((await installBlueprint(FOOD_COMMERCE_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      assert.ok((await getEnabledModules(ORG)).has("lots"), "mẫu thực phẩm 1.1.0 bật module lô");
      admin = await sessionOf();
      const viewer = await sessionOf({ role: "VIEWER", permissions: ["lots:view"] });

      await db.insert(schema.products).values([
        { id: "erp-lt-p1", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } },
        { id: "erp-lt-p2", name: "Mực khô", raw: { origin: "ERP_MANUAL" } },
      ]);
      await db.insert(schema.productVariants).values([
        { id: "erp-lt-v1", productId: "erp-lt-p1", sku: "CCT-500", size: "500 g", retailPrice: 180_000 },
        { id: "erp-lt-v2", productId: "erp-lt-p2", sku: "MK-250", size: "250 g", retailPrice: 250_000 },
      ]);
      const receipt = async (kind: string, daysAgo: number, variantId: string, quantity: number) => {
        const [rc] = await db.insert(schema.stockReceipts).values({ kind, receivedAt: vnStart(-daysAgo), totalQuantity: quantity, createdBy: "QT", reference: `${kind}-${daysAgo}` }).returning({ id: schema.stockReceipts.id });
        const [it] = await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId, quantity }).returning({ id: schema.stockReceiptItems.id });
        return it.id;
      };
      const r1 = await receipt("RECEIPT", 60, "erp-lt-v1", 10);
      const r2 = await receipt("RECEIPT", 20, "erp-lt-v1", 10);
      const r3 = await receipt("RECEIPT", 5, "erp-lt-v1", 5);
      const out = await receipt("ISSUE", 2, "erp-lt-v1", -12);
      const ret2 = await receipt("RETURN", 3, "erp-lt-v2", 5); // mẫu mã chỉ có phiếu TÁI NHẬP ⇒ tồn chưa biết
      const lot = (over: Record<string, unknown>) => ({ receiptItemId: r1, lotCode: "A1", expiresOn: vnDay(-2), quantity: 10, ...over });

      const before = await lotBoard(vnDay(0), 30);
      assert.equal(before.variants.length, 0, "chưa có lô ⇒ bảng trống");

      assert.equal(codeOf(await createStockLotCore(viewer, lot({}))), "FORBIDDEN");
      assert.ok((await createStockLotCore(admin, lot({}))).ok);
      assert.ok((await createStockLotCore(admin, lot({ receiptItemId: r2, lotCode: "B1", expiresOn: vnDay(10), quantity: 6 }))).ok);
      assert.deepEqual(fieldsOf(await createStockLotCore(admin, lot({ receiptItemId: r2, lotCode: "B2", expiresOn: vnDay(12), quantity: 5 }))), ["quantity"], "vượt phần còn của dòng (4) ⇒ chặn");
      assert.deepEqual(fieldsOf(await createStockLotCore(admin, lot({ receiptItemId: r2, lotCode: " b1 ", expiresOn: vnDay(12), quantity: 1 }))), ["lotCode"], "trùng mã lô trên một dòng (khác hoa thường) ⇒ chặn");
      assert.deepEqual(fieldsOf(await createStockLotCore(admin, lot({ receiptItemId: out, lotCode: "X", quantity: 1 }))), ["receiptItemId"], "dòng xuất kho không gắn lô");
      assert.deepEqual(fieldsOf(await createStockLotCore(admin, lot({ receiptItemId: r3, lotCode: "C1", expiresOn: vnDay(90), producedOn: vnDay(91), quantity: 5 }))), ["producedOn"]);
      assert.ok((await createStockLotCore(admin, lot({ receiptItemId: r3, lotCode: "C1", expiresOn: vnDay(90), producedOn: vnDay(-10), quantity: 5 }))).ok);
      assert.ok((await createStockLotCore(admin, lot({ receiptItemId: ret2, lotCode: "M1", expiresOn: vnDay(3), quantity: 5 }))).ok);

      const board = await lotBoard(vnDay(0), 30);
      const v1 = board.variants.find((v) => v.variantId === "erp-lt-v1")!;
      assert.equal(v1.onHand, 13, "tồn thực tế = 25 nhập − 12 xuất — gắn lô KHÔNG đổi tồn");
      const rem = Object.fromEntries(v1.lots.map((x) => [x.lotCode, x.remaining]));
      assert.deepEqual(rem, { A1: 0, B1: 6, C1: 5 }, "ước tính: dòng mới nhất giữ hàng trước, lô cũ đã đi hết");
      assert.equal(v1.untracked, 2, "phần chưa gắn lô của phiếu thứ hai");
      assert.deepEqual(v1.pickOrder.map((id) => v1.lots.find((x) => x.id === id)!.lotCode), ["B1", "C1"], "lấy hàng hạn gần trước");
      assert.equal(board.expired.length, 0, "lô hết hạn đã xuất hết ⇒ không cảnh báo");
      assert.deepEqual(board.near.map((x) => x.lotCode), ["B1"], "cận hạn trong 30 ngày còn hàng");
      const v2 = board.variants.find((v) => v.variantId === "erp-lt-v2")!;
      assert.ok(!v2.stockKnown && v2.onHand === null && v2.lots[0].remaining === null, "mẫu mã chưa có phiếu nhập ⇒ «còn» chưa biết, không phải 0");
      assert.ok(!board.near.some((x) => x.lotCode === "M1"), "lô không biết còn bao nhiêu không vào danh sách cận hạn còn hàng");
      assert.equal((await lotBoard(vnDay(0), 7)).near.length, 0, "cửa sổ 7 ngày ⇒ B1 (còn 10 ngày) chưa cận");

      const opts = await lotItemOptions(vnDay(0));
      assert.deepEqual(opts.map((o) => [o.itemId, o.free]), [[r2, 4]], "form chỉ đưa dòng còn phần chưa gắn lô");

      // Gỡ lô.
      const a1 = v1.lots.find((x) => x.lotCode === "A1")!;
      assert.deepEqual(fieldsOf(await deleteStockLotCore(admin, a1.id, "x")), ["reason"]);
      assert.ok((await deleteStockLotCore(admin, a1.id, "Gắn nhầm phiếu")).ok);
      const after = await lotBoard(vnDay(0), 30);
      assert.equal(after.variants.find((v) => v.variantId === "erp-lt-v1")!.onHand, 13, "gỡ lô KHÔNG đổi tồn");
      assert.ok((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "STOCK_LOT"))).length >= 5, "mọi lượt ghi có nhật ký");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ lô & hạn dùng: ngày hết hạn còn dùng được, cận hạn theo cửa sổ; ước tính rải tồn vào lô theo dòng nhập mới nhất (lô hạn xa giữ trước), tồn chưa biết ⇒ null; lấy hàng hạn gần trước; gắn vượt / trùng mã / dòng xuất / NSX sau HSD ⇒ chặn; gắn và gỡ lô KHÔNG đổi tồn; mẫu thực phẩm & hải sản 1.1.0 bật lô; nhà TẮT");
}
