/**
 * CÀI ĐẶT BÁO GIÁ SỈ — GỢI Ý TỪ BẢNG GIÁ SỈ (chủ shop 30/10/2026 · lib/wholesale/quotation-settings.ts + quotation-policy.ts).
 *
 *  1. THUẦN: trần CK gợi ý = giảm sâu nhất so với giá lẻ ở bậc «mua từ» lớn nhất (nêu bảng · mẫu mã · bậc); biên LN gợi ý =
 *     biên gộp thấp nhất ở bậc sâu nhất theo giá vốn; giá vốn chưa biết ⇒ đếm «chưa biết», không thành 0 và không kéo min xuống.
 *  2. TỔ CHỨC THẬT (PGlite riêng): mở khung cài đặt KHÔNG ghi settings; gợi ý đọc giá vốn sống (luật 3.13); chỉ `wholesale:config`
 *     ghi được; bắt buộc lý do; thuế suất phải có căn cứ; lưu xong ⇒ bộ tính báo giá đọc đúng chính sách + có dòng nhật ký.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { savePriceListCore } from "@/lib/records/trade";
import { getSettingJson, settingDeclared } from "@/lib/settings";
import { parseQuotationPolicy, QUOTATION_SETTING_KEY } from "@/lib/wholesale/quotation-engine";
import { loadQuotationPolicyView, saveQuotationPolicyCore } from "@/lib/wholesale/quotation-policy";
import { suggestQuotationPolicy, type PolicyVariant } from "@/lib/wholesale/quotation-settings";

const ORG = "bg-cd";
const errOf = (r: object) => ("error" in r ? String((r as { error: string }).error) : "");

function testPure() {
  const tiers = [
    { listId: "def", listName: "Sỉ chung", variantId: "a", minQuantity: 10, unitPrice: 250_000 },
    { listId: "def", listName: "Sỉ chung", variantId: "a", minQuantity: 50, unitPrice: 230_000 },
    { listId: "def", listName: "Sỉ chung", variantId: "b", minQuantity: 5, unitPrice: 150_000 },
    { listId: "def", listName: "Sỉ chung", variantId: "c", minQuantity: 1, unitPrice: 90_000 },
    { listId: "own", listName: "Đại lý", variantId: "a", minQuantity: 100, unitPrice: 210_000 },
  ];
  const variants = new Map<string, PolicyVariant>([
    ["a", { label: "Chả cá 1kg", retailPrice: 300_000, unitCost: 150_000 }],
    ["b", { label: "Chả mực 500g", retailPrice: 160_000, unitCost: 140_000 }],
    ["c", { label: "Mắm", retailPrice: null, unitCost: null }],
  ]);
  const s = suggestQuotationPolicy(tiers, variants);
  assert.equal(s.deepestTiers, 4, "mỗi (bảng, mẫu mã) một bậc sâu nhất");
  assert.deepEqual([s.maxDiscount?.percent, s.maxDiscount?.listName, s.maxDiscount?.variantId, s.maxDiscount?.minQuantity, s.maxDiscount?.unitPrice], [30, "Đại lý", "a", 100, 210_000], "giảm sâu nhất = 1 − 210.000/300.000 ở bậc từ 100");
  assert.deepEqual([s.minMargin?.percent, s.minMargin?.variantId, s.minMargin?.minQuantity], [6.67, "b", 5], "biên thấp nhất = (150.000 − 140.000)/150.000");
  assert.equal(s.noRetail, 1, "mẫu mã không có giá lẻ đếm riêng");
  assert.deepEqual([s.unknownCost.count, s.unknownCost.examples], [1, ["Mắm (Sỉ chung)"]], "giá vốn chưa biết ⇒ «chưa biết», không thành biên 0% hay 100%");
  const none = suggestQuotationPolicy([], new Map());
  assert.deepEqual([none.maxDiscount, none.minMargin, none.deepestTiers], [null, null, 0], "không có bảng giá ⇒ không gợi ý số nào");
  const noCost = suggestQuotationPolicy(tiers.slice(3, 4), variants);
  assert.equal(noCost.minMargin, null, "mọi mẫu mã chưa biết giá vốn ⇒ biên gợi ý null, không phải 0");
  console.log("  ✓ thuần: trần CK = giảm sâu nhất ở bậc sâu nhất (nêu bảng · mẫu · bậc) · biên LN thấp nhất theo giá vốn · chưa biết giá vốn ≠ 0 · không giá lẻ đếm riêng");
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

async function testOrg() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản cài đặt báo giá", plan: "standard", modules: ["customers", "products", "orders", "inventory", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT cài đặt", password: "CaiDat@12345" }, source: "TEST", actor: null });
  try {
    const modules = [...(await getEnabledModules(ORG))];
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản cài đặt báo giá", isHome: false }, modules };
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", ...base };
      const sale: SessionUser = { id: u.id, email: u.email, name: "Sale", role: "CS", permissions: ["wholesale:view", "wholesale:work"], scope: "ALL", ...base };

      await db.insert(schema.products).values({ id: "cd-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values([
        { id: "cd-va", productId: "cd-prod", sku: "CCT-1K", size: "1kg", retailPrice: 300_000, lastImportedPrice: 170_000 },
        { id: "cd-vb", productId: "cd-prod", sku: "CCT-500", size: "500g", retailPrice: 160_000 },
      ]);
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "Nhập", totalQuantity: 10, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: "cd-va", quantity: 10, unitCost: 150_000 });
      const list = await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "cd-va", minQuantity: 10, unitPrice: 250_000 }, { variantId: "cd-va", minQuantity: 50, unitPrice: 225_000 }, { variantId: "cd-vb", minQuantity: 5, unitPrice: 140_000 }] });
      assert.ok(list.ok);

      // ── Mở khung = CHỈ ĐỌC: không tạo dòng settings nào.
      const view = await loadQuotationPolicyView();
      assert.equal(await settingDeclared(QUOTATION_SETTING_KEY), false, "xem gợi ý không ghi settings");
      assert.deepEqual(view.policy, parseQuotationPolicy(undefined));
      assert.deepEqual([view.suggestion.maxDiscount?.percent, view.suggestion.maxDiscount?.variantId, view.suggestion.maxDiscount?.minQuantity], [25, "cd-va", 50], "1 − 225.000/300.000 ở bậc từ 50");
      assert.deepEqual([view.suggestion.minMargin?.percent, view.suggestion.minMargin?.basePrice], [33.33, 150_000], "giá vốn sống = phiếu nhập 150.000 (thắng giá nhập mẫu mã 170.000 — luật 3.13)");
      assert.equal(view.suggestion.unknownCost.count, 1, "cd-vb chưa có giá vốn ⇒ «chưa biết»");

      // ── Quyền, lý do, căn cứ thuế.
      assert.match(errOf(await saveQuotationPolicyCore(sale, { maxDiscountPercent: 5, reason: "theo bảng giá" })), /wholesale:config/);
      assert.equal(await settingDeclared(QUOTATION_SETTING_KEY), false, "bị từ chối thì không ghi");
      assert.match(errOf(await saveQuotationPolicyCore(admin, { maxDiscountPercent: 5, reason: "" })), /lý do/);
      assert.match(errOf(await saveQuotationPolicyCore(admin, { taxRatePercent: 8, reason: "thử thuế" })), /căn cứ/);
      assert.equal(await settingDeclared(QUOTATION_SETTING_KEY), false);

      // ── Lưu: đúng object, bộ tính đọc được, nhật ký có lý do.
      const ok = await saveQuotationPolicyCore(admin, { maxDiscountPercent: 5, minMarginPercent: 30, taxRatePercent: null, taxSource: "", reason: "Theo bảng giá sỉ HSLC 30/10" });
      assert.ok("ok" in ok);
      const stored = parseQuotationPolicy(await getSettingJson<Record<string, unknown>>(QUOTATION_SETTING_KEY, {}));
      assert.deepEqual(stored, { maxDiscountPercent: 5, minMarginPercent: 30, taxRatePercent: null, taxSource: null });
      const [log] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "WHOLESALE_QUOTATION_POLICY_SET"), eq(schema.auditLogs.entityId, QUOTATION_SETTING_KEY)));
      assert.ok(log, "có dòng nhật ký");
      assert.equal(log.reason, "Theo bảng giá sỉ HSLC 30/10");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ tổ chức thật: xem gợi ý không ghi · giá vốn sống theo luật 3.13 · chỉ wholesale:config ghi · bắt buộc lý do · thuế phải có căn cứ · lưu ⇒ đọc lại đúng + nhật ký");
}

export async function testWholesaleQuotationSettings() {
  console.log("\n— Cài đặt báo giá sỉ (gợi ý từ bảng giá sỉ)");
  testPure();
  await testOrg();
}
