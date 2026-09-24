import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { buildSupplierIndex, conflictingKeys, matchSupplier, supplierGroupOf, type SupplierEntry } from "@/lib/constants/suppliers";
import { getPurchasingReport } from "@/lib/queries/purchasing";
import { unmatchedSupplierNames } from "@/lib/queries/suppliers";

/**
 * ═══════════ DANH MỤC XƯỞNG ═══════════
 *
 * Ba chỗ một danh mục dễ nói sai nhất:
 *  1. Ghép khi KHÔNG xác định — một cách gõ khớp hai xưởng mà vẫn bốc một (AGENTS.md mục 35).
 *  2. Để chữ gõ thắng khoá đã ghi — lô đã chọn xưởng trong danh mục bị kéo sang xưởng khác vì gõ sai tên.
 *  3. Gộp các cách gõ về một dòng mà giá bình quân lấy của cách gõ CUỐI — thay vì cộng dồn rồi chia.
 */
export function testSuppliersPure() {
  const cat: SupplierEntry[] = [
    { id: "a", name: "Xưởng Hà", aliases: ["Chị Hà may"], active: true },
    { id: "b", name: "Xưởng Minh", aliases: [], active: false },
    { id: "c", name: "May Lan", aliases: ["Lan"], active: true },
    { id: "d", name: "Lan Anh", aliases: ["LAN"], active: true },
  ];
  const idx = buildSupplierIndex(cat);
  const byId = new Map(cat.map((e) => [e.id, e] as const));

  assert.deepEqual(matchSupplier("xuong ha", idx), { state: "MATCHED", id: "a", name: "Xưởng Hà" }, "không phân biệt dấu và hoa thường");
  assert.deepEqual(matchSupplier("  Chị  Hà   MAY ", idx), { state: "MATCHED", id: "a", name: "Xưởng Hà" }, "tên gọi khác quy về đúng xưởng, bỏ khoảng trắng thừa");
  assert.equal(matchSupplier("Xưởng Minh", idx).state, "MATCHED", "xưởng ĐÃ NGỪNG DÙNG vẫn phải nhận lịch sử của nó");
  assert.deepEqual(matchSupplier("lan", idx), { state: "AMBIGUOUS", ids: ["c", "d"] }, "khớp HAI xưởng ⇒ không bốc một (mục 35)");
  assert.deepEqual(matchSupplier("Xưởng lạ", idx), { state: "UNKNOWN" });
  assert.deepEqual(matchSupplier("   ", idx), { state: "EMPTY" }, "ô trống không phải một xưởng lạ");
  assert.deepEqual(conflictingKeys(cat), [{ key: "lan", ids: ["c", "d"] }], "danh mục tự mâu thuẫn phải soi ra được");

  // Khoá ĐÃ GHI thắng chữ gõ: lô chọn Xưởng Minh mà ô chữ gõ "Xưởng Hà" vẫn là của Xưởng Minh.
  const g1 = supplierGroupOf({ supplierId: "b", supplier: "Xưởng Hà" }, idx, byId);
  assert.deepEqual([g1.key, g1.label, g1.trust], ["id:b", "Xưởng Minh", "KEY"], "lời khai lúc ghi thắng mọi phép ghép lúc đọc");
  const g2 = supplierGroupOf({ supplierId: null, supplier: "chi ha may" }, idx, byId);
  assert.deepEqual([g2.key, g2.label, g2.trust], ["id:a", "Xưởng Hà", "NAME_MATCH"]);
  const g3 = supplierGroupOf({ supplierId: null, supplier: "Lan" }, idx, byId);
  assert.equal(g3.trust, "TEXT_ONLY", "nhập nhằng ⇒ đứng riêng trên chữ, không bị nhét vào xưởng nào");
  assert.equal(supplierGroupOf({ supplierId: null, supplier: "" }, idx, byId).trust, "EMPTY");
  // Khoá trỏ tới một xưởng không còn (đã xoá tay ở CSDL) ⇒ lùi về ghép tên, không vỡ.
  assert.equal(supplierGroupOf({ supplierId: "khong-con", supplier: "Xưởng Hà" }, idx, byId).key, "id:a");
  /*
    HAI ĐƯỜNG GHI PHẢI QUY TÊN VỀ DANH MỤC Ở MÁY CHỦ. Server Action đòi phiên đăng nhập nên bài không
    gọi thẳng được; khoá ở mức mã nguồn để một lần "dọn" không lặng lẽ bỏ khoá xưởng khỏi lô mới.
  */
  for (const tep of ["lib/actions/production.ts", "lib/actions/stock.ts"]) {
    const src = readFileSync(tep, "utf8");
    assert.ok(src.includes("matchSupplier(") && src.includes("supplierCatalog()"), `${tep} phải quy tên xưởng về danh mục ở máy chủ`);
    assert.ok(/supplierId: xuong\.state === "MATCHED" \? xuong\.id : null/.test(src), `${tep} phải ghi khoá supplier_id khi khớp đúng một xưởng`);
  }
  console.log("✓ Danh mục xưởng (hàm thuần): không dấu/hoa thường · tên gọi khác · nhập nhằng không ghép · khoá đã ghi thắng chữ gõ");
}

const P = "sup-";
const DAY = 86_400_000;

async function donDep(db: Db) {
  const rc = (await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(like(schema.stockReceipts.reference, `${P}%`))).map((r) => r.id);
  if (rc.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, rc));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, rc));
  }
  await db.delete(schema.suppliers).where(like(schema.suppliers.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testSuppliersQueries(db: Db) {
  await donDep(db);
  const at = (d: number) => new Date(Date.now() - d * DAY);
  try {
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Áo kiểm danh mục xưởng" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, sku: "SUP-01", color: "Đen", size: "M", retailPrice: 400_000 });
    await db.insert(schema.suppliers).values([
      { id: `${P}ha`, name: "Xưởng Hà Kiểm", aliases: ["Chị Hà Kiểm may"] },
      { id: `${P}minh`, name: "Xưởng Minh Kiểm" },
      // Hai xưởng cùng giữ khoá "lan kiem" — danh mục cũ tự mâu thuẫn (Server Action không cho tạo, nhưng dữ liệu cũ có thể có).
      { id: `${P}lan1`, name: "May Lan Kiểm", aliases: ["Lan Kiểm"] },
      { id: `${P}lan2`, name: "Lan Anh Kiểm", aliases: ["LAN KIEM"] },
    ]);
    const phieu = async (id: string, supplier: string, supplierId: string | null, qty: number, unitCost: number) => {
      await db.insert(schema.stockReceipts).values({ id: `${P}${id}`, kind: "RECEIPT", receivedAt: at(3), reference: `${P}${id}`, supplier, supplierId, totalQuantity: qty, totalCost: qty * unitCost });
      await db.insert(schema.stockReceiptItems).values({ id: `${P}${id}-i`, receiptId: `${P}${id}`, variantId: `${P}var`, quantity: qty, unitCost });
    };
    await phieu("r1", "xuong ha kiem", null, 10, 100_000);
    await phieu("r2", "Chị Hà Kiểm May", null, 30, 120_000);
    await phieu("r3", "Xưởng Lạ Kiểm", null, 5, 90_000);
    await phieu("r4", "Lan Kiểm", null, 4, 80_000);
    // Đã chọn Xưởng Minh trong danh mục, ô chữ gõ sai thành tên xưởng khác ⇒ KHOÁ thắng.
    await phieu("r5", "Xưởng Hà Kiểm", `${P}minh`, 7, 70_000);

    clearMemo();
    const r = await getPurchasingReport(30);
    const dong = (name: string) => r.suppliers.find((s) => s.supplier === name);

    const ha = dong("Xưởng Hà Kiểm");
    assert.ok(ha, "hai cách gõ của Xưởng Hà phải gộp về MỘT dòng mang tên chuẩn");
    assert.equal(ha.inCatalog, true);
    assert.equal(ha.receipts, 2, "gom r1 (không dấu) và r2 (tên gọi khác) — KHÔNG gồm r5 đã khoá sang Xưởng Minh");
    assert.equal(ha.receivedQty, 40);
    assert.equal(ha.avgUnitCost, Math.round((10 * 100_000 + 30 * 120_000) / 40), "giá bình quân CỘNG DỒN qua các cách gõ rồi mới chia — không lấy giá của cách gõ cuối");
    const minh = dong("Xưởng Minh Kiểm");
    assert.ok(minh && minh.receipts === 1 && minh.receivedQty === 7, "phiếu đã khoá Xưởng Minh đứng ở Xưởng Minh, dù ô chữ gõ tên xưởng khác");
    const la = dong("Xưởng Lạ Kiểm");
    assert.ok(la && la.inCatalog === false, "tên chưa vào danh mục vẫn là một dòng, và nói rõ là chưa vào danh mục");
    const lan = dong("Lan Kiểm");
    assert.ok(lan && lan.inCatalog === false, "cách gõ khớp HAI xưởng đứng riêng — không bị nhét vào xưởng nào");

    const chua = await unmatchedSupplierNames();
    const ten = (n: string) => chua.find((u) => u.name === n);
    assert.ok(ten("Xưởng Lạ Kiểm") && ten("Xưởng Lạ Kiểm")!.receipts === 1 && !ten("Xưởng Lạ Kiểm")!.ambiguous, "tên lạ phải hiện ở danh sách chưa vào danh mục");
    assert.ok(ten("Lan Kiểm")?.ambiguous, "tên khớp nhiều xưởng phải được đánh dấu là do danh mục mâu thuẫn, không phải do thiếu");
    assert.ok(!chua.some((u) => /ha kiem/i.test(u.name.normalize("NFD").replace(/[̀-ͯ]/g, ""))), "tên đã quy về được KHÔNG được nằm trong danh sách việc cần làm");
    console.log("✓ Danh mục xưởng (CSDL): hai cách gõ gộp một dòng · giá bình quân cộng dồn · khoá đã ghi thắng chữ gõ · tên lạ và tên nhập nhằng hiện ở danh sách chưa vào danh mục");
  } finally {
    await donDep(db);
    clearMemo();
  }
}
