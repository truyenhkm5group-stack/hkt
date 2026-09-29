/**
 * ═══════════ PILOT BÁN BUÔN — SẢN PHẨM TẠO TAY + NÚT ĐỒNG BỘ THEO NGUỒN + CHỮ TRANG LÕI (P0 #1/#2 · P1 #9/#11–#14) ═══════════
 *
 * Tổ chức THẬT `pp-si` (mẫu bán buôn, KHÔNG bật Pancake; tự cấp, tự dọn) đi đúng luồng pilot:
 *  · tạo sản phẩm + 2 mẫu mã ⇒ id `erp-` · mẫu mã mới "Chưa có phiếu nhập" (stockKnown = false, không hiện số) ⇒ phiếu
 *    NHẬP HÀNG đơn giá khai tay ⇒ sổ kho: tồn thực tế = số nhập, stockKnown = true, giá vốn = đơn giá phiếu (thắng giá khai);
 *  · SKU / mã trùng (không phân biệt hoa thường), SKU sai dạng, lặp trong chính phiếu ⇒ lỗi đúng ô, 0 dòng mới;
 *  · thiếu `products:write` ⇒ FORBIDDEN; sửa sản phẩm đồng bộ (id không `erp-`) ⇒ NOT_SUPPORTED;
 *  · khách tạo tay sửa được tên / SĐT; khách mang `pancake_id` KHÔNG.
 * Tổ chức NHÀ (bật Pancake): không có cổng tạo sản phẩm, action từ chối kể cả Quản trị, định giá phiếu nhập LUÔN giá báo MKT
 * (kể cả khi có ai lưu khoá cài đặt), chữ trang lõi giữ nguyên TỪNG KÝ TỰ, nút đồng bộ còn nguyên.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { brandCopy, HOME_BRAND_PATTERN, HOME_COPY_CONTEXT, type CoreTextKey } from "@/lib/branding/copy";
import { duplicateSkus, isManualRecordId, MANUAL_ID_PREFIX, manualProductUnit } from "@/lib/constants/manual-products";
import { objectDef } from "@/lib/constants/object-registry";
import { RECEIPT_PRICING_SETTING_KEY, resolveReceiptPricingMode } from "@/lib/constants/receipt-pricing-mode";
import { receiptPricingModeFor } from "@/lib/inventory/receipt-pricing";
import { writeStockReceiptCore } from "@/lib/inventory/receipt-create";
import { getEnabledModules, invalidateCapabilities, orgHasSyncedSource, SYNCED_SOURCE_MODULE } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { SYNC_JOB_MODULES, syncJobVisible } from "@/lib/platform-ui/module-visibility";
import { getProductDetail } from "@/lib/queries/products";
import { listVariantsForReceipt } from "@/lib/queries/stock";
import { createCustomerCore, customerBasicsGate, updateCustomerBasicsCore } from "@/lib/records/customer-create";
import { createProductCore, productCreateGate, updateProductCore } from "@/lib/records/product-create";
import { JOB_DEFINITIONS, jobModules } from "@/lib/sync/jobs";

const ORG = "pp-si";

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

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));

// ─────────────────────────── Phần THUẦN + quét mã nguồn ───────────────────────────

function testPure() {
  // Luật chọn đơn giá phiếu nhập: nhà LUÔN giá báo MKT, kể cả khi đã lưu MANUAL.
  assert.deepEqual(resolveReceiptPricingMode({ isHome: true, saved: "MANUAL", hasMarketerPrices: false }), { mode: "MKT_QUOTE", source: "HOME_FIXED" }, "tổ chức nhà không đổi: luôn giá báo MKT");
  assert.deepEqual(resolveReceiptPricingMode({ isHome: false, saved: null, hasMarketerPrices: false }), { mode: "MANUAL", source: "NO_MKT_QUOTES" }, "chưa có giá báo nào ⇒ khai tay");
  assert.deepEqual(resolveReceiptPricingMode({ isHome: false, saved: null, hasMarketerPrices: true }), { mode: "MKT_QUOTE", source: "HAS_MKT_QUOTES" });
  assert.deepEqual(resolveReceiptPricingMode({ isHome: false, saved: "MKT_QUOTE", hasMarketerPrices: false }), { mode: "MKT_QUOTE", source: "SAVED" }, "đã lưu thì theo lưu");
  assert.deepEqual(resolveReceiptPricingMode({ isHome: false, saved: "lung tung", hasMarketerPrices: false }).source, "NO_MKT_QUOTES", "giá trị lạ bỏ qua như chưa lưu");

  assert.ok(isManualRecordId("erp-1") && !isManualRecordId("4f1c-uuid-pancake") && !isManualRecordId(null));
  assert.deepEqual(duplicateSkus(["A-1", " a-1 ", "B", "b", "C"]), ["a-1", "b"], "trùng không phân biệt hoa thường / khoảng trắng");
  assert.equal(manualProductUnit({ origin: "ERP_MANUAL", unit: " thùng " }), "thùng");
  assert.equal(manualProductUnit({ id: "pancake-raw" }), null, "payload Pancake không có đơn vị khai tay");

  // Sổ đối tượng: sản phẩm tạo tay CHỈ khi không bật Pancake — cùng một luật với khách hàng.
  assert.deepEqual(objectDef("product")?.capabilities.create, { requiresModuleOff: "connector_pancake" });
  assert.deepEqual(objectDef("customer")?.capabilities.create, { requiresModuleOff: "connector_pancake" });
  // MỘT câu hỏi "có nguồn đồng bộ không" (`orgHasSyncedSource`): sổ đối tượng và bảng nút đồng bộ phải nói cùng module.
  const offOf = (k: string) => {
    const c = objectDef(k)?.capabilities.create;
    return c ? c.requiresModuleOff : null;
  };
  assert.equal(offOf("product"), SYNCED_SOURCE_MODULE.products);
  assert.equal(offOf("customer"), SYNCED_SOURCE_MODULE.customers);
  assert.deepEqual(SYNC_JOB_MODULES["pancake-products"], [SYNCED_SOURCE_MODULE.products]);
  assert.deepEqual(SYNC_JOB_MODULES["pancake-orders"], [SYNCED_SOURCE_MODULE.orders]);
  assert.deepEqual(SYNC_JOB_MODULES["pancake-customers"], [SYNCED_SOURCE_MODULE.customers]);

  // Nút đồng bộ: bảng khai client-safe PHẢI khớp module của job thật; mọi nút trong app/ khai ở bảng.
  for (const [job, mods] of Object.entries(SYNC_JOB_MODULES)) {
    const def = JOB_DEFINITIONS[job];
    assert.ok(def, `job ${job} có thật`);
    assert.deepEqual([...mods].sort(), jobModules(def).sort(), `SYNC_JOB_MODULES["${job}"] khớp jobModules`);
  }
  const PAGES = ["products/page.tsx", "products/[id]/page.tsx", "customers/page.tsx", "customers/[id]/page.tsx", "inventory/page.tsx", "orders/page.tsx", "returns/page.tsx", "cod/page.tsx", "shipments/page.tsx"];
  for (const f of PAGES) {
    const src = readFileSync(`app/(dashboard)/${f}`, "utf8");
    assert.ok(!/<SyncButton\s+job="(pancake|vtp)-/.test(src), `${f}: nút đồng bộ connector phải đi qua ModuleSyncButton`);
    for (const m of src.matchAll(/<ModuleSyncButton\s+viewer=\{user\}\s+job="([a-z-]+)"/g)) assert.ok(m[1] in SYNC_JOB_MODULES, `${f}: job ${m[1]} chưa khai ở SYNC_JOB_MODULES`);
    assert.ok(/<ModuleSyncButton\s+viewer=\{user\}/.test(src), `${f}: có ModuleSyncButton`);
  }
  assert.equal(syncJobVisible({}, "pancake-products"), true, "người dùng dựng tay (không mang modules) ⇒ không lọc");
  assert.equal(syncJobVisible({ modules: ["products", "connector_pancake"] }, "pancake-products"), true, "nhà bật Pancake ⇒ nút còn");
  assert.equal(syncJobVisible({ modules: ["products", "inventory"] }, "pancake-products"), false, "không Pancake ⇒ ẩn");
  assert.equal(syncJobVisible({ modules: ["connector_pancake", "connector_viettelpost"] }, "job-la"), false, "job lạ ⇒ ẩn (hỏng về phía hẹp)");

  // Chữ trang lõi: nhà giữ NGUYÊN từng ký tự (so với chuỗi cũ trong mã); tổ chức khác không mang dấu nhà / "COD".
  const home = brandCopy(HOME_COPY_CONTEXT);
  const other = brandCopy({ isHome: false, declared: {} });
  const OLD: Partial<Record<CoreTextKey, string>> = {
    "products.notByCod": "không theo tiền COD",
    "products.emptyList": "Thử đổi bộ lọc hoặc từ khoá. Nếu chưa đồng bộ, bấm “Đồng bộ sản phẩm & tồn kho”.",
    "receipts.emptyVariants": "Không có mẫu mã phù hợp. Nếu danh sách trống, hãy đồng bộ sản phẩm từ Pancake trước.",
    "expenses.description": "Kê khai chi phí vận hành kinh doanh ngoài Pancake",
    "expenses.hint": "Kê khai chi phí vận hành kinh doanh ngoài Pancake: lương, mặt bằng, điện nước, phần mềm, đóng gói… Số liệu đưa vào Báo cáo lợi nhuận (dòng tiền & danh nghĩa). Sao kê ngân hàng KHÔNG tạo chi phí: nhập sao kê ở Sổ ngân hàng (tab Nhập sao kê), phân loại, rồi nối dòng tiền với khoản chi để đối chiếu.",
    "expenses.dialog": "Chi phí vận hành ngoài Pancake (lương, mặt bằng, phần mềm, đóng gói…). Số tiền tính bằng VND.",
    "customer.addressBook": "Sổ địa chỉ giao hàng từ Pancake",
    "customer.profileHint": "Trường do tổ chức tự khai. Thông tin hệ thống của khách chỉ đọc ở đây: khách đồng bộ từ Pancake, sửa ở ERP sẽ bị lượt đồng bộ kế tiếp ghi đè.",
    "dataQuality.legacyNote": "Các số đối chiếu vẫn có COD khai báo/fallback và prepaid chưa kiểm chứng chứng từ. Chúng chưa phải tiền thực thu đã xác minh và chưa đủ để chốt doanh thu, lương hoặc đối soát ngân hàng. Cần đối chiếu bảng kê COD, chứng từ thanh toán và chiều giao/hoàn.",
    "finance.carrierHoldingTitle": "Tiền Viettel Post còn giữ",
    "finance.carrierHoldingHint": "Đây là khoản làm một shop bán COD 'lãi trên giấy mà hết tiền mặt': hàng đã tới tay khách nên doanh thu được ghi, còn tiền thì Viettel Post giữ cả tuần, trong khi tiền quảng cáo và tiền hàng phải trả ngay.",
  };
  for (const [k, v] of Object.entries(OLD) as [CoreTextKey, string][]) {
    assert.equal(home.text(k), v, `chữ nhà "${k}" không đổi`);
    const o = other.text(k);
    assert.ok(!HOME_BRAND_PATTERN.test(o) && !/\bCOD\b/.test(o), `chữ tổ chức khác "${k}" không mang dấu nhà: ${o}`);
  }
  // Câu sai luật 4 (P1 #14) đã gỡ khỏi trang Nhập hàng; câu đúng có mặt.
  const receipts = readFileSync("app/(dashboard)/inventory/receipts/page.tsx", "utf8");
  assert.ok(!receipts.includes("hàng hoàn tự động được coi là về kho"), "không còn câu 'hàng hoàn tự động được coi là về kho'");
  assert.match(receipts, /Hàng hoàn <b[^>]*>KHÔNG<\/b> tự về kho/);
  // Đường ghi phiếu nhập: nhà vẫn định giá theo giá báo; chế độ khai tay chỉ khi máy chủ phân giải ra MANUAL.
  const stock = readFileSync("lib/actions/stock.ts", "utf8");
  assert.match(stock, /receiptPricingModeFor\(db, \{ isHome: isHomeOrg\(user\) \}\)/);
  assert.match(stock, /cheDoGia\?\.mode === "MKT_QUOTE" \? await priceReceiptLines\(db, variantIds, vnStartOfDay\(data\.receivedAt\)\)/);
  // /departments: số đo nội bộ nhà chỉ ở nhà.
  const dept = readFileSync("app/(dashboard)/departments/page.tsx", "utf8");
  assert.match(dept, /const home = isHomeOrg\(user\)/);
  assert.match(dept, /\{home \? \(\s*<SectionCard/);
}

// ─────────────────────────── Tổ chức NHÀ (bật Pancake) ───────────────────────────

async function testHome() {
  const admin = sessionOf({ id: "pp-home", email: "pp@home.local" });
  assert.equal(await orgHasSyncedSource("products"), true, "nhà có nguồn đồng bộ sản phẩm");
  const gate = await productCreateGate(admin);
  assert.equal(gate.allowed ? "ALLOWED" : gate.code, "NOT_SUPPORTED", "nhà bật Pancake ⇒ không tạo sản phẩm tay, KỂ CẢ Quản trị");
  const db = await getDb();
  const count = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.products))[0].n);
  const before = await count();
  const denied = await createProductCore(admin, { name: "Hàng tay ở nhà", code: "PP-HOME", unit: "cái", variants: [{ sku: "PP-HOME" }] });
  assert.equal(codeOf(denied), "NOT_SUPPORTED");
  assert.equal(await count(), before, "bị từ chối ⇒ 0 dòng");
  const upd = await updateProductCore(admin, "erp-khong-co", { name: "x", code: "X", unit: "cái", variants: [{ sku: "X" }] });
  assert.equal(codeOf(upd), "NOT_SUPPORTED", "nhà: sửa cũng bị từ chối ở cổng");

  // Định giá phiếu nhập: nhà LUÔN giá báo MKT, kể cả có dòng cài đặt MANUAL.
  await db.insert(schema.settings).values({ key: RECEIPT_PRICING_SETTING_KEY, value: JSON.stringify("MANUAL") }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify("MANUAL") } });
  try {
    assert.deepEqual(await receiptPricingModeFor(db, { isHome: true }), { mode: "MKT_QUOTE", source: "HOME_FIXED" });
  } finally {
    await db.delete(schema.settings).where(eq(schema.settings.key, RECEIPT_PRICING_SETTING_KEY));
  }

  // Khách của nhà (kể cả không mang pancake_id): thông tin cơ bản KHÔNG sửa ở ERP.
  const [c] = await db.insert(schema.customers).values({ name: "PP khách nhà", phone: "0900000001" }).returning({ id: schema.customers.id });
  try {
    assert.equal((await customerBasicsGate(admin, { pancakeId: null })).allowed, false, "nhà bật Pancake ⇒ không sửa");
    const r = await updateCustomerBasicsCore(admin, c.id, { name: "Đổi tên" });
    assert.equal(codeOf(r), "NOT_SUPPORTED");
    assert.equal((await db.query.customers.findFirst({ where: eq(schema.customers.id, c.id) }))?.name, "PP khách nhà");
  } finally {
    await db.delete(schema.customers).where(eq(schema.customers.id, c.id));
  }
}

// ─────────────────────────── Tổ chức bán buôn THẬT (không Pancake) ───────────────────────────

async function testWholesaleOrg() {
  await cleanupOrg(ORG);
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  await provisionOrganization({ code: ORG, name: "Bán buôn thử sản phẩm", plan: "standard", modules, admin: { email: `admin@${ORG}.local`, name: "QT bán buôn", password: "SanPham@12345" }, source: "TEST", actor: null });
  try {
    const enabled = await getEnabledModules(ORG);
    assert.ok(enabled.has("products") && enabled.has("inventory") && !enabled.has("connector_pancake"), "mẫu bán buôn: có Sản phẩm + Kho, không Pancake");
    assert.equal(await orgHasSyncedSource("products", ORG), false, "bán buôn không có nguồn đồng bộ sản phẩm");
    assert.equal(await orgHasSyncedSource("orders", ORG), false);
    const viewerModules = { modules: [...enabled] };
    assert.equal(syncJobVisible(viewerModules, "pancake-products"), false, "tổ chức bán buôn KHÔNG thấy «Đồng bộ sản phẩm»");
    assert.equal(syncJobVisible(viewerModules, "vtp-tracking"), false);

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Bán buôn thử sản phẩm", isHome: false };
      const admin = sessionOf(u, { organization: org, modules: [...enabled] });
      assert.equal((await productCreateGate(admin)).allowed, true, "không Pancake + Quản trị ⇒ được tạo");

      const productCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.products))[0].n);
      const n0 = await productCount();
      // Quyền: thiếu products:write ⇒ từ chối, 0 dòng.
      const viewer = sessionOf(u, { role: "WAREHOUSE", permissions: ["products:view", "inventory:write"], organization: org, modules: [...enabled] });
      assert.equal(codeOf(await createProductCore(viewer, { name: "A", code: "A-1", unit: "cái", variants: [{ sku: "A-1" }] })), "FORBIDDEN", "thiếu products:write ⇒ từ chối");

      const created = await createProductCore(admin, {
        name: "Nước suối 500ml",
        code: "NS-500",
        unit: "thùng",
        retailPrice: 120_000,
        cost: 80_000,
        variants: [
          { sku: "NS-500-24", size: "24 chai" },
          { sku: "NS-500-12", size: "12 chai", retailPrice: 65_000, cost: null },
        ],
      });
      assert.ok(created.ok, JSON.stringify(created));
      assert.ok(created.id.startsWith(MANUAL_ID_PREFIX), "id sản phẩm tiền tố erp-");
      const p = await db.query.products.findFirst({ where: eq(schema.products.id, created.id), with: { variants: true } });
      assert.ok(p);
      assert.equal(p.customId, "NS-500");
      assert.equal(manualProductUnit(p.raw), "thùng", "đơn vị tính lưu ở lời khai gốc");
      assert.equal(p.variants.length, 2);
      assert.ok(p.variants.every((v) => isManualRecordId(v.id)), "id mẫu mã tiền tố erp-");
      const v24 = p.variants.find((v) => v.sku === "NS-500-24")!;
      const v12 = p.variants.find((v) => v.sku === "NS-500-12")!;
      assert.equal(v24.retailPrice, 120_000, "giá bán chung áp cho mẫu mã không khai riêng");
      assert.equal(v24.lastImportedPrice, 80_000, "giá vốn khai tay = bậc giá nhập mẫu mã");
      assert.equal(v12.retailPrice, 65_000);
      assert.equal(v12.lastImportedPrice, 80_000, "giá vốn riêng để trống ⇒ lấy giá vốn chung");
      assert.equal(await productCount(), n0 + 1);
      const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "PRODUCT_CREATE"), eq(schema.auditLogs.entityId, created.id)));
      assert.equal(logs.length, 1, "tạo sản phẩm để lại một dòng nhật ký");

      // Trùng / sai dạng ⇒ lỗi đúng ô, không thêm dòng.
      const dupCode = await createProductCore(admin, { name: "Khác", code: "ns-500", unit: "cái", variants: [{ sku: "KHAC-1" }] });
      assert.ok(fieldsOf(dupCode).includes("code"), "mã sản phẩm trùng (khác hoa thường) ⇒ lỗi ô mã");
      const dupSku = await createProductCore(admin, { name: "Khác", code: "KHAC", unit: "cái", variants: [{ sku: "ns-500-24 " }] });
      assert.ok(fieldsOf(dupSku).includes("variants.0.sku"), "SKU trùng trong tổ chức ⇒ lỗi ô SKU");
      const dupInside = await createProductCore(admin, { name: "Khác", code: "KHAC", unit: "cái", variants: [{ sku: "K-1" }, { sku: "k-1" }] });
      assert.ok(fieldsOf(dupInside).includes("variants.1.sku"), "SKU lặp trong chính sản phẩm ⇒ lỗi");
      const badSku = await createProductCore(admin, { name: "Khác", code: "KHAC", unit: "cái", variants: [{ sku: "có dấu cách" }] });
      assert.ok(fieldsOf(badSku).includes("variants.0.sku"), "SKU có dấu cách / dấu tiếng Việt ⇒ lỗi");
      const noVariant = await createProductCore(admin, { name: "Khác", code: "KHAC", unit: "cái", variants: [] });
      assert.ok(fieldsOf(noVariant).includes("variants"), "phải có ít nhất một mẫu mã");
      assert.equal(await productCount(), n0 + 1, "mọi lượt bị từ chối ⇒ 0 sản phẩm mới");

      // SỔ KHO trước phiếu nhập: CHƯA BIẾT tồn, không phải 0.
      const d0 = await getProductDetail(created.id);
      assert.ok(d0);
      assert.equal(d0.totals.unknownStock, 2, "hai mẫu mã chưa có phiếu nhập ⇒ chưa biết tồn");
      assert.ok(d0.variants.every((v) => v.erpStock === null), "chưa có phiếu nhập ⇒ tồn null, không in số");
      const picker = await listVariantsForReceipt();
      assert.deepEqual(picker.filter((x) => x.productId === created.id).map((x) => x.sku).sort(), ["NS-500-12", "NS-500-24"], "phiếu nhập / kiểm kê nhận mẫu mã mới");

      // Phiếu NHẬP HÀNG với đơn giá khai tay — tổ chức chưa có giá báo ⇒ chế độ MANUAL.
      const pricing = await receiptPricingModeFor(db, { isHome: false });
      assert.deepEqual(pricing, { mode: "MANUAL", source: "NO_MKT_QUOTES" }, "bán buôn không có giá báo ⇒ khai đơn giá trên phiếu");
      const ghi = await writeStockReceiptCore(db, {
        kind: "RECEIPT",
        receipt: { receivedAt: new Date(), reference: "PN-01", supplier: "NCC A", note: "", totalQuantity: 30, totalCost: 30 * 75_000, createdBy: "QT bán buôn" },
        lines: [{ variantId: v24.id, quantity: 30, unitCost: 75_000, shipmentId: null }],
        note: "",
        actor: { id: u.id, label: "QT bán buôn" },
        approver: { id: u.id, email: u.email },
        gate: null,
      });
      assert.ok("receiptId" in ghi, JSON.stringify(ghi));
      const d1 = await getProductDetail(created.id);
      assert.ok(d1);
      const r24 = d1.variants.find((v) => v.id === v24.id)!;
      const r12 = d1.variants.find((v) => v.id === v12.id)!;
      assert.equal(r24.erpStock, 30, "có phiếu RECEIPT ⇒ tồn thực tế = số nhập (sổ kho luật 10)");
      assert.equal(r24.ledger?.stockKnown, true);
      assert.equal(r12.erpStock, null, "mẫu mã chưa nhập vẫn CHƯA BIẾT");
      assert.equal(d1.totals.actual, 30);
      assert.equal(d1.totals.unknownStock, 1);
      const afterPicker = (await listVariantsForReceipt()).find((x) => x.id === v24.id);
      assert.equal(afterPicker?.lastCost, 75_000, "giá vốn = đơn giá phiếu nhập gần nhất, thắng giá khai tay (luật 13)");

      // Khoá cài đặt lưu MKT_QUOTE ⇒ theo lưu.
      await db.insert(schema.settings).values({ key: RECEIPT_PRICING_SETTING_KEY, value: JSON.stringify("MKT_QUOTE") });
      assert.deepEqual(await receiptPricingModeFor(db, { isHome: false }), { mode: "MKT_QUOTE", source: "SAVED" });
      await db.delete(schema.settings).where(eq(schema.settings.key, RECEIPT_PRICING_SETTING_KEY));

      // SỬA: đổi tên + thêm mẫu mã; SKU đụng mẫu mã khác ⇒ lỗi; sửa bản đồng bộ ⇒ từ chối.
      const clash = await updateProductCore(admin, created.id, { name: "Nước suối", code: "NS-500", unit: "thùng", variants: [{ id: v24.id, sku: "NS-500-12" }] });
      assert.ok(fieldsOf(clash).includes("variants.0.sku"), "đổi SKU trùng mẫu mã KHÁC (kể cả cùng sản phẩm, không gửi lên) ⇒ lỗi");
      const upd = await updateProductCore(admin, created.id, {
        name: "Nước suối Lavie 500ml",
        code: "NS-500",
        unit: "thùng",
        variants: [
          { id: v24.id, sku: "NS-500-24", size: "24 chai", retailPrice: 125_000, cost: 80_000 },
          { sku: "NS-500-6", size: "6 chai", retailPrice: 35_000 },
        ],
      });
      assert.ok(upd.ok, JSON.stringify(upd));
      const p2 = await db.query.products.findFirst({ where: eq(schema.products.id, created.id), with: { variants: true } });
      assert.equal(p2?.name, "Nước suối Lavie 500ml");
      assert.equal(p2?.variants.length, 3, "mẫu mã không gửi lên KHÔNG bị xoá; mẫu mới được thêm");
      assert.equal(p2?.variants.find((v) => v.id === v24.id)?.retailPrice, 125_000);
      const [synced] = await db.insert(schema.products).values({ id: "4f1c0000-0000-4000-8000-000000000001", name: "Hàng đồng bộ giả" }).returning({ id: schema.products.id });
      assert.equal(codeOf(await updateProductCore(admin, synced.id, { name: "Đổi", code: "DB-1", unit: "cái", variants: [{ sku: "DB-1" }] })), "NOT_SUPPORTED", "bản đồng bộ ⇒ không sửa ở ERP");
      assert.equal(codeOf(await updateProductCore(viewer, created.id, { name: "Đổi", code: "NS-500", unit: "cái", variants: [{ id: v24.id, sku: "NS-500-24" }] })), "FORBIDDEN");

      // KHÁCH: tạo tay sửa được thông tin cơ bản; khách mang pancake_id KHÔNG.
      const cus = await createCustomerCore(admin, { system: { name: "Đại lý Minh" }, custom: {} });
      assert.ok(cus.ok, JSON.stringify(cus));
      const edited = await updateCustomerBasicsCore(admin, cus.id, { name: "Đại lý Minh Phát", phone: "0912 345.678", address: "12 Hàng Bông" });
      assert.ok(edited.ok, JSON.stringify(edited));
      const c2 = await db.query.customers.findFirst({ where: eq(schema.customers.id, cus.id) });
      assert.equal(c2?.name, "Đại lý Minh Phát");
      assert.equal(c2?.phone, "0912345678", "SĐT chuẩn hoá như lượt tạo");
      assert.equal(c2?.address, "12 Hàng Bông");
      assert.ok(fieldsOf(await updateCustomerBasicsCore(admin, cus.id, { name: "  " })).includes("system:name"), "tên bắt buộc");
      assert.ok(fieldsOf(await updateCustomerBasicsCore(admin, cus.id, { order_count: 9 })).includes("system:order_count"), "field hệ thống không sửa được ⇒ không nhận ghi");
      const custViewer = sessionOf(u, { role: "VIEWER", permissions: ["customers:view"], organization: org, modules: [...enabled] });
      assert.equal(codeOf(await updateCustomerBasicsCore(custViewer, cus.id, { name: "X" })), "FORBIDDEN", "thiếu customers:write ⇒ từ chối");
      const [pc] = await db.insert(schema.customers).values({ name: "Khách Pancake cũ", pancakeId: "pc-123" }).returning({ id: schema.customers.id });
      assert.equal(codeOf(await updateCustomerBasicsCore(admin, pc.id, { name: "Đổi" })), "NOT_SUPPORTED", "khách mang pancake_id giữ chỉ đọc");
      assert.equal((await db.query.customers.findFirst({ where: eq(schema.customers.id, pc.id) }))?.name, "Khách Pancake cũ");
      assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "CUSTOMER_UPDATE_BASICS"), eq(schema.auditLogs.entityId, cus.id)))).length, 1);
      assert.equal((await db.select({ id: schema.products.id }).from(schema.products).where(like(schema.products.id, "erp-%"))).length, 1);
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testPilotProducts() {
  testPure();
  await testHome();
  await testWholesaleOrg();
  console.log("  ✓ pilot bán buôn: sản phẩm + mẫu mã tạo tay (erp-, SKU duy nhất, products:write) ⇒ phiếu nhập đơn giá khai tay ⇒ sổ kho đúng; nhà không đổi (không nút, action từ chối, giá báo MKT, chữ nguyên); nút đồng bộ theo nguồn; khách tạo tay sửa được");
}
