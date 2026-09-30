/**
 * ═══════════ NHẬP SẢN PHẨM HÀNG LOẠT TỪ TỆP (CSV / XLSX) — gap P0 «Import Products» ═══════════
 *
 * Hai tổ chức THẬT (`pi-food`, `pi-other` — mẫu bán buôn, KHÔNG bật Pancake; tự cấp, tự dọn) đi đúng luồng tự phục vụ:
 *  · CSV 6 dòng (tên · quy cách · giá · tồn đầu) ⇒ chạy thử KHÔNG ghi dòng nào ⇒ nhập ⇒ 6 sản phẩm, SKU tự sinh duy nhất,
 *    giá đúng, field tuỳ biến `package_size` được ghi, MỘT phiếu NHẬP HÀNG cho tồn đầu ⇒ sổ kho `stockKnown = true` đúng số;
 *  · nhập lại ⇒ 0 tạo, 6 "đã có", tồn không cộng lần hai;
 *  · cùng dữ liệu dạng XLSX ⇒ đọc được; ở tổ chức B tạo mới (dữ liệu của A không thấy ở B);
 *  · giá sai dạng ⇒ lỗi đúng dòng, dòng đó không ghi; thiếu quyền ⇒ FORBIDDEN; tồn đầu mà thiếu `inventory:write` ⇒ lỗi ô;
 *  · tổ chức NHÀ (bật Pancake) ⇒ từ chối.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { manualProductUnit } from "@/lib/constants/manual-products";
import { createCustomField } from "@/lib/metadata/fields";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { checkProductImport, describeProductImport, detectDelimiter, parseDelimited, readProductImportFile, runProductImport, type ProductImportFile } from "@/lib/products/import";
import { autoSkuBase, guessImportMapping, parseMoneyVnd, parseQuantity, productImportTemplateCsv, type ImportTarget } from "@/lib/products/import-shared";
import { getProductDetail } from "@/lib/queries/products";

const ORG_A = "pi-food";
const ORG_B = "pi-other";

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

/** Sáu món của khách thực phẩm — cột: tên · quy cách · giá · tồn đầu (vài dòng có tồn). */
const FOOD: [string, string, number, number | ""][] = [
  ["Nem hải sản tôm bề bề", "10 cái", 120000, 20],
  ["Chả cá thu", "1kg", 280000, 5],
  ["Chả mực giã tay", "1kg", 400000, ""],
  ["Nước mắm cốt cá cơm", "1 lít", 150000, ""],
  ["Ruốc bông cá thu 100%", "250g", 250000, 12],
  ["Ruốc bông tôm 100%", "250g", 350000, ""],
];
const HEADER = ["Tên sản phẩm", "Quy cách", "Giá", "Tồn đầu"];

function csvOf(rows: (string | number)[][], delimiter = ","): Uint8Array {
  const esc = (c: string | number) => {
    const s = String(c);
    return s.includes(delimiter) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return new TextEncoder().encode(`\uFEFF${rows.map((r) => r.map(esc).join(delimiter)).join("\r\n")}\r\n`);
}

function xlsxOf(rows: (string | number)[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "San pham");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

const OPTS = (mapping: (ImportTarget | null)[]) => ({ mapping, defaultUnit: "cái" });
const FOOD_MAPPING: ImportTarget[] = ["name", "package_size", "price", "initial_stock"];

// ─────────────────────────── Phần THUẦN ───────────────────────────

function testPure() {
  const money = (s: string) => {
    const r = parseMoneyVnd(s);
    return r.ok ? r.value : "LỖI";
  };
  assert.equal(money("120000"), 120000);
  assert.equal(money("120.000"), 120000);
  assert.equal(money("120,000"), 120000);
  assert.equal(money("120 000"), 120000);
  assert.equal(money("120.000đ"), 120000);
  assert.equal(money("120000 VND"), 120000);
  assert.equal(money("120k"), 120000);
  assert.equal(money("1.200.000"), 1200000);
  assert.equal(money(""), null, "ô trống = CHƯA KHAI, không phải 0");
  assert.equal(money("0"), 0, "0 thật vẫn là 0");
  for (const bad of ["120,5", "1.2tr", "12.00", "-5000", "một trăm", "1,20,000", "120.000,00", "1.5k"]) assert.equal(money(bad), "LỖI", `không đoán: "${bad}"`);
  const q = parseQuantity("1.000");
  assert.ok(q.ok && q.value === 1000);
  assert.ok(!parseQuantity("2,5").ok && !parseQuantity("-3").ok);

  assert.equal(autoSkuBase("Nem hải sản tôm bề bề"), "NEM-HAI-SAN-TOM-BE-BE");
  assert.equal(autoSkuBase("Ruốc bông cá thu 100%"), "RUOC-BONG-CA-THU-100");
  assert.equal(autoSkuBase("Đậu đỏ"), "DAU-DO", "đ ⇒ D");
  assert.equal(autoSkuBase("%%%"), "SP", "tên không còn chữ ⇒ SP");
  assert.ok(autoSkuBase("x".repeat(300)).length <= 40, "gốc SKU tự sinh chừa chỗ cho hậu tố");

  assert.deepEqual(guessImportMapping(["Tên sản phẩm", "Quy cách", "Giá bán", "ĐVT", "Danh mục", "Tồn đầu", "Mã", "Ghi chú"], []), ["name", "package_size", "price", "selling_unit", "category", "initial_stock", "sku", null]);
  assert.deepEqual(guessImportMapping(["ten", "gia", "GIÁ"], []), ["name", "price", null], "hai cột cùng đoán một nơi ⇒ cột sau bỏ trống");
  assert.deepEqual(guessImportMapping(["Hạn dùng"], [{ key: "shelf_life", label: "Hạn dùng" }]), ["custom:shelf_life"], "đoán theo nhãn field tuỳ biến");

  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter('"x,y";b\tc\t\td'), "\t");
  const rows = parseDelimited('Tên;Giá\r\n"Chả ""cá"";\nthu";"120.000"\r\n\r\nNem;1', ";");
  assert.deepEqual(rows.map((r) => r.cells), [["Tên", "Giá"], ['Chả "cá";\nthu', "120.000"], [""], ["Nem", "1"]]);
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 4, 5], "số dòng thật, kể cả ô xuống dòng");

  const semi = readProductImportFile({ fileName: "a.csv", data: csvOf([HEADER, ["Chả; cá", "1kg", "120.000", ""]], ";") });
  assert.ok(!("error" in semi));
  assert.equal(semi.delimiter, ";");
  assert.deepEqual(semi.headers, HEADER, "BOM không dính vào tên cột đầu");
  assert.deepEqual(semi.rows[0].cells, ["Chả; cá", "1kg", "120.000", ""]);
  const cp1258 = readProductImportFile({ fileName: "a.csv", data: new Uint8Array([0x54, 0xea, 0x6e, 0x0a, 0x41]) });
  assert.ok("error" in cp1258 && /UTF-8/.test(cp1258.error), "không phải UTF-8 ⇒ báo, không đọc rác");
  const tooBig = readProductImportFile({ fileName: "a.csv", data: new Uint8Array(2 * 1024 * 1024 + 1).fill(0x41) });
  assert.ok("error" in tooBig && /2 MB/.test(tooBig.error));
  const many = readProductImportFile({ fileName: "a.csv", data: csvOf([["Tên"], ...Array.from({ length: 2001 }, (_, i) => [`SP ${i}`])]) });
  assert.ok("error" in many && /2\.000/.test(many.error), "trần 2.000 dòng");
  assert.ok(productImportTemplateCsv().startsWith("\uFEFFTên sản phẩm,"), "tệp mẫu có BOM + tiêu đề tiếng Việt");
  const tpl = readProductImportFile({ fileName: "mau.csv", data: new TextEncoder().encode(productImportTemplateCsv()) });
  assert.ok(!("error" in tpl) && tpl.rows.length === 2, "tệp mẫu đọc lại được bằng chính bộ đọc");
}

// ─────────────────────────── Tổ chức NHÀ ───────────────────────────

async function testHome() {
  const admin = sessionOf({ id: "pi-home", email: "pi@home.local" });
  const db = await getDb();
  const count = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.products))[0].n);
  const before = await count();
  const file: ProductImportFile = { fileName: "nha.csv", data: csvOf([HEADER, ...FOOD]) };
  assert.equal(codeOf(await describeProductImport(admin, file)), "NOT_SUPPORTED", "nhà bật Pancake ⇒ không đọc tệp nhập");
  assert.equal(codeOf(await checkProductImport(admin, file, OPTS(FOOD_MAPPING))), "NOT_SUPPORTED");
  const checksum = readProductImportFile(file);
  assert.ok(!("error" in checksum));
  assert.equal(codeOf(await runProductImport(admin, file, OPTS(FOOD_MAPPING), checksum.checksum)), "NOT_SUPPORTED", "nhà ⇒ từ chối kể cả Quản trị");
  assert.equal(await count(), before, "0 dòng mới");
}

// ─────────────────────────── Hai tổ chức thật ───────────────────────────

async function provision(code: string) {
  await cleanupOrg(code);
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  await provisionOrganization({ code, name: `Thực phẩm thử ${code}`, plan: "standard", modules, admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "NhapTep@12345" }, source: "TEST", actor: null });
  const enabled = await getEnabledModules(code);
  assert.ok(enabled.has("products") && enabled.has("inventory") && !enabled.has("connector_pancake"), `${code}: có Sản phẩm + Kho, không Pancake`);
  return enabled;
}

async function tableCounts() {
  const db = await getDb();
  const n = (rows: { n: number }[]) => Number(rows[0].n);
  const c = sql<number>`count(*)`;
  return {
    products: n(await db.select({ n: c }).from(schema.products)),
    variants: n(await db.select({ n: c }).from(schema.productVariants)),
    receipts: n(await db.select({ n: c }).from(schema.stockReceipts)),
    receiptItems: n(await db.select({ n: c }).from(schema.stockReceiptItems)),
    audit: n(await db.select({ n: c }).from(schema.auditLogs)),
    custom: n(await db.select({ n: c }).from(schema.customValues)),
  };
}

async function testOrgs() {
  const enabledA = await provision(ORG_A);
  const enabledB = await provision(ORG_B);
  try {
    const csv: ProductImportFile = { fileName: "thuc-pham.csv", data: csvOf([HEADER, ...FOOD]) };
    const xlsx: ProductImportFile = { fileName: "thuc-pham.xlsx", data: xlsxOf([HEADER, ...FOOD]) };

    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG_A}.local`) });
      assert.ok(u);
      const org = { code: ORG_A, name: "Thực phẩm thử", isHome: false };
      const admin = sessionOf(u, { organization: org, modules: [...enabledA] });

      // Field tuỳ biến `package_size` khai bằng dịch vụ metadata có sẵn.
      const field = await createCustomField("product", { key: "package_size", type: "text", label: "Quy cách" }, { id: u.id, email: u.email });
      assert.ok(field.ok, JSON.stringify(field));

      // Quyền: thiếu products:write ⇒ FORBIDDEN ở cả ba lượt.
      const viewer = sessionOf(u, { role: "WAREHOUSE", permissions: ["products:view", "inventory:write"], organization: org, modules: [...enabledA] });
      assert.equal(codeOf(await describeProductImport(viewer, csv)), "FORBIDDEN");
      assert.equal(codeOf(await checkProductImport(viewer, csv, OPTS(FOOD_MAPPING))), "FORBIDDEN");
      assert.equal(codeOf(await runProductImport(viewer, csv, OPTS(FOOD_MAPPING), "x")), "FORBIDDEN");

      // Bước 1: đọc + gợi ý ghép cột.
      const desc = await describeProductImport(admin, csv);
      assert.ok(desc.ok, JSON.stringify(desc));
      assert.equal(desc.kind, "CSV");
      assert.equal(desc.totalRows, 6);
      assert.deepEqual(desc.suggested, FOOD_MAPPING, "đoán ghép cột theo tên cột tiếng Việt");
      assert.ok(desc.customFields.some((f) => f.key === "package_size"), "field tuỳ biến của Sản phẩm có trong danh sách ghép");

      // Bước 2: CHẠY THỬ — không ghi dòng nào.
      const c0 = await tableCounts();
      const check = await checkProductImport(admin, csv, OPTS(desc.suggested));
      assert.ok(check.ok, JSON.stringify(check));
      assert.deepEqual(check.counts, { ready: 6, exists: 0, error: 0 }, JSON.stringify(check.rows.filter((r) => r.errors.length)));
      assert.deepEqual(check.mappingErrors, []);
      assert.equal(check.receiptPricing, "MANUAL", "tổ chức chưa có giá báo ⇒ đơn giá khai tay");
      assert.ok(check.rows.every((r) => r.skuGenerated), "không cột SKU ⇒ tự sinh, có đánh dấu");
      const skus = check.rows.map((r) => r.sku);
      assert.equal(new Set(skus.map((s) => s.toLowerCase())).size, 6, "SKU tự sinh duy nhất");
      assert.equal(skus[0], "NEM-HAI-SAN-TOM-BE-BE");
      assert.deepEqual(check.rows.map((r) => r.price), FOOD.map((f) => f[2]), "giá đúng từng dòng");
      assert.deepEqual(check.rows.map((r) => r.line), [2, 3, 4, 5, 6, 7], "số dòng theo tệp (tiêu đề là dòng 1)");
      assert.equal(check.rows[0].custom.package_size, "10 cái");
      assert.ok(check.rows.every((r) => r.unit === "cái" && r.unitFromDefault), "không cột đơn vị ⇒ đơn vị mặc định, có đánh dấu");
      assert.deepEqual(await tableCounts(), c0, "chạy thử KHÔNG ghi một dòng nào (kể cả nhật ký)");

      // Checksum sai ⇒ không nhập.
      assert.equal(codeOf(await runProductImport(admin, csv, OPTS(desc.suggested), "khong-khop")), "CONFLICT");
      assert.deepEqual(await tableCounts(), c0);

      // Bước 3: NHẬP.
      const run = await runProductImport(admin, csv, OPTS(desc.suggested), check.checksum);
      assert.ok(run.ok, JSON.stringify(run));
      assert.deepEqual(run.counts, { created: 6, exists: 0, error: 0 }, JSON.stringify(run.rows));
      assert.ok(run.receiptId, `có phiếu tồn đầu: ${run.receiptError}`);
      assert.deepEqual(run.missingPrice.sort(), skus.filter((_, i) => FOOD[i][3] !== "").sort(), "tồn đầu không có giá vốn ⇒ nói ra SKU chưa biết giá");
      const c1 = await tableCounts();
      assert.equal(c1.products, c0.products + 6);
      assert.equal(c1.variants, c0.variants + 6, "một sản phẩm + một mẫu mã");
      assert.equal(c1.receipts, c0.receipts + 1, "MỘT phiếu nhập cho cả lượt");
      assert.equal(c1.receiptItems, c0.receiptItems + 3, "chỉ dòng có tồn đầu");
      assert.equal(c1.custom, c0.custom + 6, "field tuỳ biến ghi cho 6 sản phẩm");
      for (const [i, r] of run.rows.entries()) {
        assert.equal(r.status, "CREATED");
        assert.ok(r.productId);
        const p = await db.query.products.findFirst({ where: eq(schema.products.id, r.productId), with: { variants: true } });
        assert.ok(p);
        assert.equal(p.name, FOOD[i][0]);
        assert.equal(p.customId, skus[i], "mã sản phẩm = SKU");
        assert.equal(p.variants.length, 1);
        assert.equal(p.variants[0].sku, skus[i], "SKU mẫu mã = mã sản phẩm");
        assert.equal(p.variants[0].retailPrice, FOOD[i][2]);
        assert.equal(manualProductUnit(p.raw), "cái");
        const [cv] = await db.select().from(schema.customValues).where(and(eq(schema.customValues.objectKey, "product"), eq(schema.customValues.recordId, r.productId)));
        assert.equal(cv?.values.package_size, FOOD[i][1], "quy cách ghi vào field tuỳ biến package_size");
      }
      // Sổ kho: tồn đầu qua phiếu RECEIPT ⇒ stockKnown = true đúng số; dòng không tồn đầu vẫn CHƯA BIẾT.
      const stockOf = async (i: number) => (await getProductDetail(run.rows[i].productId!))!.variants[0];
      const s0 = await stockOf(0);
      assert.equal(s0.erpStock, 20);
      assert.equal(s0.ledger?.stockKnown, true);
      assert.equal((await stockOf(1)).erpStock, 5);
      assert.equal((await stockOf(4)).erpStock, 12);
      const s2 = await stockOf(2);
      assert.equal(s2.erpStock, null, "không tồn đầu ⇒ «Chưa có phiếu nhập», không in 0");
      const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "PRODUCT_IMPORT"));
      assert.equal(logs.length, 1, "một dòng nhật ký tổng cho lượt nhập");
      assert.equal(logs[0].entityId, check.checksum, "nhật ký mang checksum sha256 nội dung");
      assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "PRODUCT_CREATE"))).length, 6, "mỗi sản phẩm vẫn có nhật ký riêng");

      // Nhập lại (bấm hai lần) ⇒ 0 tạo, 6 "đã có", tồn không cộng lần hai.
      const again = await runProductImport(admin, csv, OPTS(desc.suggested), check.checksum);
      assert.ok(again.ok, JSON.stringify(again));
      assert.deepEqual(again.counts, { created: 0, exists: 6, error: 0 });
      assert.equal(again.receiptId, null, "không phiếu tồn đầu thứ hai");
      assert.deepEqual(again.rows.map((r) => r.productId), run.rows.map((r) => r.productId), "«đã có» trỏ đúng sản phẩm cũ");
      const c2 = await tableCounts();
      assert.equal(c2.products, c1.products);
      assert.equal(c2.receipts, c1.receipts);
      assert.equal((await stockOf(0)).erpStock, 20, "tồn đầu không cộng lần hai");

      // Cùng dữ liệu dạng XLSX ⇒ đọc được, và đều «đã có».
      const xd = await describeProductImport(admin, xlsx);
      assert.ok(xd.ok, JSON.stringify(xd));
      assert.equal(xd.kind, "XLSX");
      assert.deepEqual(xd.suggested, FOOD_MAPPING);
      const xc = await checkProductImport(admin, xlsx, OPTS(xd.suggested));
      assert.ok(xc.ok);
      assert.deepEqual(xc.counts, { ready: 0, exists: 6, error: 0 }, "XLSX cùng dữ liệu ⇒ cùng SKU tự sinh ⇒ đã có");

      // Giá sai dạng ⇒ lỗi ĐÚNG dòng, dòng đó không ghi; dòng hợp lệ vẫn nhập.
      const bad: ProductImportFile = { fileName: "gia-sai.csv", data: csvOf([["Tên", "Giá", "SKU"], ["Mắm tôm Thanh Hoá", "35.000", ""], ["Mắm tép", "28o000", ""], ["Chả cá thu giả", "10000", "cha-ca-thu"]]) };
      const bc = await checkProductImport(admin, bad, OPTS(["name", "price", "sku"]));
      assert.ok(bc.ok);
      assert.deepEqual(bc.rows.map((r) => r.status), ["READY", "ERROR", "ERROR"]);
      assert.equal(bc.rows[1].line, 3);
      assert.deepEqual(bc.rows[1].errors.map((e) => e.field), ["price"], "lỗi ở ô giá");
      assert.deepEqual(bc.rows[2].errors.map((e) => e.field), ["sku"], "SKU đã có cho sản phẩm TÊN KHÁC ⇒ lỗi, không coi là «đã có»");
      const br = await runProductImport(admin, bad, OPTS(["name", "price", "sku"]), bc.checksum);
      assert.ok(br.ok);
      assert.deepEqual(br.counts, { created: 1, exists: 0, error: 2 });
      assert.equal((await db.select().from(schema.products).where(eq(schema.products.name, "Mắm tép"))).length, 0, "dòng giá sai không ghi");

      // Lỗi ghép cột: thiếu cột tên / hai cột một đích ⇒ không dòng nào nhập được.
      const noName = await checkProductImport(admin, csv, OPTS([null, "package_size", "price", "initial_stock"]));
      assert.ok(noName.ok && noName.mappingErrors.length === 1 && noName.counts.ready === 0);
      const dup = await checkProductImport(admin, csv, OPTS(["name", "custom:package_size", "price", "package_size"]));
      assert.ok(dup.ok && dup.mappingErrors.some((m) => /cùng ghép/.test(m)));
      assert.equal(codeOf(await runProductImport(admin, csv, OPTS([null, "package_size", "price", "initial_stock"]), noName.checksum)), "INVALID");

      // Có products:write mà thiếu inventory:write ⇒ ô Tồn đầu lỗi (tồn chỉ đổi qua phiếu kho của người có quyền).
      const clerk = sessionOf(u, { role: "VIEWER", permissions: ["products:view", "products:write"], organization: org, modules: [...enabledA] });
      const fresh: ProductImportFile = { fileName: "moi.csv", data: csvOf([HEADER, ["Bánh đa cua", "gói", "25000", "10"], ["Bánh đa đỏ", "gói", "20000", ""]]) };
      const kc = await checkProductImport(clerk, fresh, OPTS(["name", null, "price", "initial_stock"]));
      assert.ok(kc.ok);
      assert.deepEqual(kc.rows.map((r) => r.status), ["ERROR", "READY"]);
      assert.deepEqual(kc.rows[0].errors.map((e) => e.field), ["initial_stock"]);
      // Và thiếu metadata:manage mà ghép field tuỳ biến ⇒ lỗi ghép cột, không nhập nửa vời.
      const kf = await checkProductImport(clerk, fresh, OPTS(["name", "package_size", "price", null]));
      assert.ok(kf.ok && kf.mappingErrors.some((m) => /quyền ghi field/.test(m)));
    });

    // Tổ chức B: dữ liệu nhập ở A KHÔNG thấy ở B — cùng tệp XLSX ở B là 6 dòng MỚI.
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      assert.equal((await db.select().from(schema.products).where(like(schema.products.id, "erp-%"))).length, 0, "B không thấy sản phẩm của A");
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG_B}.local`) });
      assert.ok(u);
      const admin = sessionOf(u, { organization: { code: ORG_B, name: "Thực phẩm thử B", isHome: false }, modules: [...enabledB] });
      const xc = await checkProductImport(admin, xlsx, OPTS(FOOD_MAPPING));
      assert.ok(xc.ok);
      assert.deepEqual(xc.counts, { ready: 6, exists: 0, error: 0 });
      assert.ok(xc.warnings.some((w) => /package_size/.test(w)), "B chưa khai field package_size ⇒ cảnh báo, không lưu");
      const xr = await runProductImport(admin, xlsx, OPTS(FOOD_MAPPING), xc.checksum);
      assert.ok(xr.ok, JSON.stringify(xr));
      assert.equal(xr.counts.created, 6, "XLSX nhập được");
      const p = await db.query.products.findFirst({ where: eq(schema.products.id, xr.rows[1].productId!), with: { variants: true } });
      assert.equal(p?.variants[0].retailPrice, 280000, "giá từ ô số của Excel");
      assert.equal((await getProductDetail(xr.rows[1].productId!))?.variants[0].erpStock, 5);
    });
    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      // A: 6 món + «Mắm tôm» (lượt thủ kho chỉ là chạy thử). Lượt nhập ở B không chen vào A.
      assert.equal((await db.select().from(schema.products).where(like(schema.products.id, "erp-%"))).length, 7, "A giữ đúng 7 sản phẩm của A");
    });
  } finally {
    await cleanupOrg(ORG_A);
    await cleanupOrg(ORG_B);
  }
}

export async function testProductImport() {
  testPure();
  await testHome();
  await testOrgs();
  console.log("  ✓ nhập sản phẩm từ tệp: CSV (BOM, , ; tab, nháy kép) + XLSX ⇒ chạy thử 0 dòng ghi ⇒ nhập 6 món SKU tự sinh duy nhất, giá đúng, field package_size, MỘT phiếu tồn đầu (stockKnown đúng số); nhập lại 0 tạo / 6 đã có; giá sai lỗi đúng dòng; quyền; nhà từ chối; hai tổ chức tách rời");
}
