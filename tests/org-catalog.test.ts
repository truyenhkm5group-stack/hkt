/**
 * ═══════════ ops `org-catalog` — danh mục · bảng giá sỉ · câu mẫu · công tắc bot của MỘT tổ chức khách, CHỈ ĐỌC (scripts/org-catalog.ts) ═══════════
 *
 *  · Thuần: giá `null` ⇒ `—` không bao giờ `0 ₫`; quy cách đọc như bot (`detail` thắng, rồi màu · size); kênh tóm tắt chỉ
 *    số đếm + công tắc — không tên sản phẩm, không giá, không chữ câu mẫu; phần mã hoá có id sản phẩm để chủ shop tìm
 *    đúng sản phẩm cần thêm quy cách.
 *  · Mã nguồn: không một câu ghi; ép chỉ đọc; không đọc cột mang dữ liệu NGƯỜI; ops-vps khai thao tác (mã hoá, đọc nặng,
 *    nhánh case).
 *  · CSDL (PGlite, tổ chức thật `os-cat`): gieo sản phẩm tạo tay 1kg có giá + mẫu mã chưa có giá, bảng giá sỉ, câu mẫu, cấu
 *    hình bot ⇒ báo cáo đúng từng dòng; chuỗi bí mật trong tên khách / đơn không lọt ra.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getDbForInspection, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { catalogLines, catalogSummary, collectOrgCatalog, SUMMARY_MAX_CHARS, variantLabel, vnd, type CatalogReport } from "@/scripts/org-catalog";

const ORG = "os-cat";
const BI_MAT = "BI-MAT-ORG-CAT";
const SDT = "0987000111";

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

export function testOrgCatalogPure() {
  assert.equal(vnd(null), "—", "chưa có giá in —, không in 0 ₫");
  assert.equal(vnd(280_000), "280.000 ₫");
  assert.equal(variantLabel({ detail: "Size: 1kg", color: "", size: "1kg" }), "Size: 1kg", "detail thắng");
  assert.equal(variantLabel({ detail: "", color: "Đỏ", size: "L" }), "Đỏ · L");
  assert.equal(variantLabel({ detail: " ", color: "", size: "" }), "(không quy cách)");

  const r: CatalogReport = {
    org: { code: "x", name: "Shop X" },
    syncedProducts: false,
    bot: { enabled: true, wholesalePricing: false, sellWithoutStockCheck: true, productFields: ["net_weight"], extraInstructions: "Giá sỉ hỏi nhân viên" },
    profile: "Hải sản",
    products: [
      { id: "erp-p1", name: "Chả cá thu", code: "CCT", manual: true, removed: false, variants: [{ id: "erp-v1", sku: "CCT-1", label: "Size: 1kg", price: 280_000, weightGrams: 1000, hidden: false, manual: true }, { id: "erp-v2", sku: "CCT-05", label: "Size: 0,5kg", price: null, weightGrams: null, hidden: true, manual: true }] },
      { id: "erp-p9", name: "Đã gỡ", code: null, manual: true, removed: true, variants: [] },
    ],
    priceLists: [{ id: "l1", name: "Sỉ chung", isDefault: true, active: true, tiers: [{ variantId: "erp-v1", variantLabel: "Chả cá thu · Size: 1kg", minQuantity: 10, unitPrice: 250_000 }] }, { id: "l2", name: "Cũ", isDefault: false, active: false, tiers: [] }],
    quickReplies: [{ title: "Bảng giá", triggers: ["giá", "bao nhiêu"], answer: "Chả cá thu 280k/kg\n  ship 25k", upsell: true, images: 1 }],
    quickReplySettings: { enabled: true, upsellSet: true },
  };
  const lines = catalogLines(r);
  const all = lines.join("\n");
  assert.ok(all.includes("· erp-p1 · Chả cá thu · mã CCT · tạo tay"), "có id sản phẩm để chọn khi thêm quy cách");
  assert.ok(all.includes("- erp-v1 · SKU CCT-1 · Size: 1kg · giá lẻ 280.000 ₫ · 1000 g"));
  assert.ok(all.includes("- erp-v2 · SKU CCT-05 · Size: 0,5kg · giá lẻ — · chưa khai gram · ẨN (thôi bán)"), "chưa có giá in —, mẫu mã ẩn có nhãn");
  assert.ok(all.includes("· Đã gỡ · tạo tay · ĐÃ GỠ"));
  assert.ok(all.includes("· Sỉ chung · MẶC ĐỊNH · 1 bậc") && all.includes("- Chả cá thu · Size: 1kg · từ 10: 250.000 ₫") && all.includes("· Cũ · NGỪNG DÙNG · 0 bậc"));
  assert.ok(all.includes("· [UPSELL] Bảng giá (1 ảnh) [giá / bao nhiêu]: Chả cá thu 280k/kg ship 25k"), "câu mẫu gộp một dòng, đánh dấu câu upsell + số ảnh");
  assert.ok(all.includes("câu upsell (mời thêm món kèm ảnh menu): ĐÃ CHỌN"));
  assert.ok(all.includes("Bot: BẬT · báo giá theo bảng giá sỉ TẮT · chốt không kiểm tồn BẬT · field bot đọc: net_weight"));
  assert.ok(all.includes("Hướng dẫn thêm (20 ký tự): Giá sỉ hỏi nhân viên"));

  const sum = catalogSummary(r);
  assert.deepEqual(sum, ["Tổ chức x: 1 sản phẩm · 2 mẫu mã (1 chưa có giá · 1 ẩn) · nguồn tạo tay", "Bot: BẬT · giá sỉ TẮT · chốt không kiểm tồn BẬT · bảng giá sỉ đang dùng 1 (1 bậc) · câu mẫu đang bật 1 · câu upsell ĐÃ CHỌN (1 ảnh)"]);
  for (const s of sum) {
    assert.ok(s.length <= SUMMARY_MAX_CHARS);
    for (const w of ["Chả cá", "280", "250", "Bảng giá [", "Hải sản", "nhân viên"]) assert.ok(!s.includes(w), `kênh tóm tắt không mang tên / giá / chữ của shop: ${w}`);
  }
  const khongCauHinh = catalogSummary({ ...r, bot: null, syncedProducts: null });
  assert.ok(khongCauHinh[0].endsWith("nguồn —") && khongCauHinh[1].startsWith("Bot: — (chưa có cấu hình)"), "chưa đọc được ⇒ —, không phải TẮT");
  assert.ok(catalogLines({ ...r, priceLists: [] }).some((l) => l.includes("chưa có bảng giá nào")), "không bảng giá ⇒ nói thẳng hệ quả");

  const src = readFileSync("scripts/org-catalog.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(insert|update|delete|truncate|alter|drop|create)\b\s*\(/i.test(code), "script không có câu ghi nào");
  for (const col of ["billFullName", "shipPhone", "shipAddress", "customers", "salesChatMessages", "secretsEnc", "lastTestMessage"]) assert.ok(!code.includes(col), `script không đọc dữ liệu người / bí mật: ${col}`);
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-catalog\s+#/, "ops-vps khai lựa chọn org-catalog");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-catalog\b/, "kết quả org-catalog MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-catalog\b/, "org-catalog là thao tác ĐỌC");
  assert.match(ops, /\n\s+org-catalog\)\n[\s\S]*?scripts\/org-catalog\.ts/, "nhánh case chạy đúng script");
}

export async function testOrgCatalogDb() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Danh mục thử", plan: "standard", modules: ["customers", "products", "orders", "inventory"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "DanhMuc@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      await db.insert(schema.settings).values([
        { key: "ai.salesChatbot", value: JSON.stringify({ enabled: true, sellWithoutStockCheck: true, extraInstructions: "Hỏi sỉ thì báo nhân viên" }) },
        { key: "ai.businessProfile", value: JSON.stringify({ businessProfile: "Chả cá thu Nha Trang" }) },
      ]);
      await db.insert(schema.products).values([
        { id: "erp-cat-p1", name: "Chả cá thu", customId: "CCT", raw: { origin: "ERP_MANUAL", unit: "kg" } },
        { id: "erp-cat-p2", name: "Chả mực", customId: "CM", raw: { origin: "ERP_MANUAL", unit: "kg" } },
      ]);
      await db.insert(schema.productVariants).values([
        { id: "erp-cat-v1", productId: "erp-cat-p1", sku: "CCT-1", size: "1kg", detail: "Size: 1kg", retailPrice: 280_000, weight: 1000 },
        { id: "erp-cat-v2", productId: "erp-cat-p2", sku: "CM-1", size: "1kg", detail: "Size: 1kg", retailPrice: 0 },
        { id: "erp-cat-v3", productId: "erp-cat-p2", sku: "CM-X", size: "", detail: "", retailPrice: 100_000, isRemoved: true },
      ]);
      const [pl] = await db.insert(schema.priceLists).values({ name: "Sỉ chung", isDefault: true }).returning({ id: schema.priceLists.id });
      await db.insert(schema.priceListItems).values({ priceListId: pl.id, variantId: "erp-cat-v1", minQuantity: 10, unitPrice: 250_000 });
      await db.insert(schema.salesChatQuickReplies).values([
        { title: "Bảng giá", triggers: ["giá"], answer: "Chả cá thu 280k/kg", active: true },
        { title: "Tắt rồi", triggers: ["x"], answer: `${BI_MAT} câu đã tắt`, active: false },
      ]);
      await db.insert(schema.customers).values({ name: `${BI_MAT} khách`, phone: SDT });

      const view = await getDbForInspection({ code: ORG, isHome: false });
      const r = await collectOrgCatalog({ code: ORG, name: "Danh mục thử", isHome: false }, view);
      assert.equal(r.syncedProducts, false, "tổ chức thử không đồng bộ sản phẩm");
      assert.deepEqual(r.bot && { enabled: r.bot.enabled, w: r.bot.wholesalePricing, s: r.bot.sellWithoutStockCheck }, { enabled: true, w: false, s: true });
      assert.equal(r.profile, "Chả cá thu Nha Trang");
      assert.deepEqual(r.products.map((p) => [p.id, p.manual, p.variants.map((v) => [v.sku, v.label, v.price, v.weightGrams])]), [
        ["erp-cat-p1", true, [["CCT-1", "Size: 1kg", 280_000, 1000]]],
        ["erp-cat-p2", true, [["CM-1", "Size: 1kg", null, null]]],
      ], "mẫu mã đã gỡ không hiện; giá 0 ⇒ null; gram 0 ⇒ null");
      assert.deepEqual(r.priceLists.map((l) => [l.name, l.isDefault, l.tiers.map((t) => [t.variantLabel, t.minQuantity, t.unitPrice])]), [["Sỉ chung", true, [["Chả cá thu · Size: 1kg", 10, 250_000]]]]);
      assert.deepEqual(r.quickReplies, [{ title: "Bảng giá", triggers: ["giá"], answer: "Chả cá thu 280k/kg", upsell: false, images: 0 }], "chỉ câu mẫu đang bật");
      assert.deepEqual(r.quickReplySettings, { enabled: true, upsellSet: false }, "chưa chọn câu upsell ⇒ nói thẳng");
      const all = [...catalogLines(r), ...catalogSummary(r)].join("\n");
      assert.ok(!all.includes(BI_MAT) && !all.includes(SDT), `không dòng nào lộ tên khách / SĐT / câu đã tắt:\n${all}`);
      assert.equal(catalogSummary(r)[0], `Tổ chức ${ORG}: 2 sản phẩm · 2 mẫu mã (1 chưa có giá · 0 ẩn) · nguồn tạo tay`);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ ops org-catalog: danh mục / bảng giá sỉ / câu mẫu / công tắc bot của một tổ chức khách — chỉ đọc, id sản phẩm để thêm quy cách, giá chưa có in —, kênh tóm tắt không mang tên / giá, dữ liệu người không lọt");
}
