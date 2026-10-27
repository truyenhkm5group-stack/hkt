/**
 * ═══════════ CỔNG SẴN SÀNG BÁN SỈ / XUẤT KHẨU (P1c · docs/tech/hslc-b2b-sales-agent.md) — HÀM THUẦN ═══════════
 *
 *  · Đủ mọi dữ kiện ⇒ READY, MOQ = bậc nhỏ nhất của BẢNG MẶC ĐỊNH.
 *  · Thiếu TỪNG trường ⇒ MISSING và đúng một mục thiếu (bậc giá kéo theo MOQ).
 *  · Bậc chỉ ở bảng riêng ⇒ vẫn thiếu (khách mới nhận giá lẻ); không có bảng mặc định ⇒ thiếu.
 *  · Tồn CHƯA BIẾT ≠ 0: chưa có phiếu nhập ⇒ thiếu «Tồn kho», số tồn là null (không phải 0); tồn đã biết = 0 ⇒ chỉ cảnh báo.
 *  · Khối lượng 0 = CHƯA NHẬP.
 *  · Xuất khẩu: chứng nhận / điều kiện / HS luôn UNAVAILABLE kèm `missingWhat`; cổng không bao giờ «sẵn sàng» khi còn
 *    UNAVAILABLE; bảo quản UNAVAILABLE khi tổ chức chưa khai field, có field thì đếm phủ; hạn dùng đọc theo lô.
 *  · Lọc / xếp / phân trang: null đứng cuối ở cả hai chiều.
 */
import assert from "node:assert/strict";
import {
  CATALOG_CHECKS,
  evaluateExportReadiness,
  evaluateVariantReadiness,
  pageReadinessRows,
  summarizeReadiness,
  type ReadinessSources,
  type ReadinessVariantInput,
} from "@/lib/wholesale/catalog-readiness";

const SRC: ReadinessSources = { defaultListName: "Giá sỉ", descriptionFieldKeys: ["co_size", "don_vi_ban"], storageFieldKeys: ["bao_quan"] };

function full(over: Partial<ReadinessVariantInput> = {}): ReadinessVariantInput {
  return {
    variantId: "v1",
    productId: "p1",
    productName: "Chả mực giã tay",
    sku: "CM-500",
    variantLabel: "Túi 500g",
    addOnOnly: false,
    weightGrams: 520,
    imageUrl: "https://example.test/a.jpg",
    defaultTiers: [
      { minQuantity: 20, unitPrice: 150_000 },
      { minQuantity: 10, unitPrice: 160_000 },
    ],
    otherListNames: [],
    stockKnown: true,
    onHand: 40,
    available: 35,
    descriptionFields: ["Đơn vị bán"],
    storageFilled: true,
    lotCount: 2,
    lotEarliestExpiry: "2026-12-01",
    lotLatestExpiry: "2027-02-01",
    ...over,
  };
}

export function testWholesaleCatalogReadiness() {
  // 1. Đủ dữ kiện ⇒ READY, MOQ = bậc nhỏ nhất của bảng mặc định.
  const ok = evaluateVariantReadiness(full(), SRC);
  assert.equal(ok.status, "READY");
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.moq, 10);
  assert.equal(ok.moqUnitPrice, 160_000);
  assert.equal(ok.tierCount, 2);

  // 2. Thiếu TỪNG trường ⇒ đúng mục đó.
  const keysOf = (over: Partial<ReadinessVariantInput>, src = SRC) => evaluateVariantReadiness(full(over), src).missing.map((m) => m.key);
  assert.deepEqual(keysOf({ defaultTiers: [] }), ["PRICE_TIER", "MOQ"], "không bậc ⇒ thiếu bậc giá và MOQ");
  assert.deepEqual(keysOf({ weightGrams: 0 }), ["WEIGHT"], "khối lượng 0 = CHƯA NHẬP");
  assert.deepEqual(keysOf({ weightGrams: null }), ["WEIGHT"]);
  assert.deepEqual(keysOf({ imageUrl: null }), ["IMAGE"]);
  assert.deepEqual(keysOf({ imageUrl: "   " }), ["IMAGE"], "chuỗi trắng không phải ảnh");
  assert.deepEqual(keysOf({ descriptionFields: [] }), ["DESCRIPTION"]);
  assert.deepEqual(keysOf({}, { ...SRC, descriptionFieldKeys: [] }), ["DESCRIPTION"], "tổ chức chưa khai field mô tả ⇒ thiếu, không đoán khoá khác");
  assert.deepEqual(keysOf({ defaultTiers: [{ minQuantity: 0, unitPrice: 1 }, { minQuantity: 5, unitPrice: 0 }] }), ["PRICE_TIER", "MOQ"], "bậc hỏng không được tính là bậc");

  // 3. Bậc chỉ ở bảng riêng ⇒ vẫn thiếu, và câu lý do nêu tên bảng; không có bảng mặc định ⇒ thiếu.
  const other = evaluateVariantReadiness(full({ defaultTiers: [], otherListNames: ["Đại lý cấp 1"] }), SRC);
  assert.equal(other.status, "MISSING");
  assert.match(other.missing[0]!.detail, /Đại lý cấp 1/);
  assert.match(other.missing[0]!.detail, /giá lẻ/);
  const noDefault = evaluateVariantReadiness(full({ defaultTiers: [] }), { ...SRC, defaultListName: null });
  assert.match(noDefault.missing[0]!.detail, /chưa có bảng giá MẶC ĐỊNH/);

  // 4. Tồn CHƯA BIẾT ≠ 0.
  const unknown = evaluateVariantReadiness(full({ stockKnown: false, onHand: -3, available: -3 }), SRC);
  assert.deepEqual(unknown.missing.map((m) => m.key), ["STOCK"]);
  assert.equal(unknown.onHand, null, "chưa có phiếu nhập ⇒ tồn null, không đưa «0 − đã xuất» ra");
  assert.equal(unknown.available, null);
  assert.match(unknown.missing[0]!.detail, /không phải 0/);
  const zero = evaluateVariantReadiness(full({ onHand: 0, available: 0 }), SRC);
  assert.equal(zero.status, "READY", "tồn đã biết = 0 là dữ kiện ĐỦ — chỉ cảnh báo, không phải thiếu");
  assert.equal(zero.available, 0);
  assert.ok(zero.warnings.some((w) => /khả dụng 0/.test(w)));

  // Tóm tắt đếm đúng từng hạng mục; một mẫu thiếu nhiều thứ đếm ở nhiều hạng mục.
  const rows = [ok, other, unknown, zero, evaluateVariantReadiness(full({ variantId: "v9", weightGrams: 0, imageUrl: null, addOnOnly: true }), SRC)];
  const s = summarizeReadiness(rows);
  assert.equal(s.total, 5);
  assert.equal(s.ready, 2);
  assert.equal(s.missing, 3);
  assert.equal(s.missingBy.PRICE_TIER, 1);
  assert.equal(s.missingBy.MOQ, 1);
  assert.equal(s.missingBy.STOCK, 1);
  assert.equal(s.missingBy.WEIGHT, 1);
  assert.equal(s.missingBy.IMAGE, 1);
  assert.equal(s.addOnOnly, 1);
  assert.equal(s.outOfStock, 1, "tồn chưa biết KHÔNG bị đếm là hết hàng");
  assert.deepEqual(Object.keys(s.missingBy), [...CATALOG_CHECKS]);

  // 5. Xuất khẩu: ba hạng mục không có nguồn ⇒ UNAVAILABLE + missingWhat; cổng không sẵn sàng.
  const ex = evaluateExportReadiness(rows, SRC);
  assert.equal(ex.ready, false);
  for (const key of ["CERTIFICATION", "EXPORT_TERMS", "HS_CODE"] as const) {
    const it = ex.items.find((i) => i.key === key)!;
    assert.equal(it.status, "UNAVAILABLE", `${key} không có nguồn trong ERP`);
    assert.equal(it.covered, null, "không có nguồn ⇒ phủ là null, không phải 0/N");
    assert.ok(it.missingWhat && it.missingWhat.length > 40, `${key} phải nói thiếu ĐÚNG cái gì`);
  }
  assert.equal(ex.unavailable, 3);
  const storage = ex.items.find((i) => i.key === "STORAGE")!;
  assert.equal(storage.status, "AVAILABLE");
  assert.equal(storage.covered, 5);
  const shelf = ex.items.find((i) => i.key === "SHELF_LIFE")!;
  assert.equal(shelf.status, "AVAILABLE");
  assert.match(shelf.note ?? "", /hạn của LÔ/);

  // Tổ chức chưa khai field bảo quản ⇒ UNAVAILABLE; có field mà một phần trống ⇒ PARTIAL; chưa lô nào ⇒ MISSING.
  const noStorageSrc: ReadinessSources = { ...SRC, storageFieldKeys: [] };
  const noLots = [evaluateVariantReadiness(full({ storageFilled: null, lotCount: 0, lotEarliestExpiry: null, lotLatestExpiry: null }), noStorageSrc)];
  const ex2 = evaluateExportReadiness(noLots, noStorageSrc);
  assert.equal(ex2.items.find((i) => i.key === "STORAGE")!.status, "UNAVAILABLE");
  assert.equal(ex2.items.find((i) => i.key === "STORAGE")!.covered, null);
  assert.equal(ex2.items.find((i) => i.key === "SHELF_LIFE")!.status, "MISSING");
  assert.equal(ex2.unavailable, 4);
  const partial = evaluateExportReadiness([ok, evaluateVariantReadiness(full({ variantId: "v2", storageFilled: false, lotCount: 0 }), SRC)], SRC);
  assert.equal(partial.items.find((i) => i.key === "STORAGE")!.status, "PARTIAL");
  assert.equal(partial.items.find((i) => i.key === "SHELF_LIFE")!.status, "PARTIAL");
  assert.equal(evaluateExportReadiness([], SRC).ready, false, "danh mục rỗng không bao giờ «sẵn sàng»");

  // 6. Lọc / xếp / phân trang — null đứng cuối ở cả hai chiều.
  const base = { page: 1, pageSize: 50, q: "", filters: {} as Record<string, string[]> };
  const asc = pageReadinessRows(rows, { ...base, sort: "available", dir: "asc" }).rows.map((r) => r.available);
  const desc = pageReadinessRows(rows, { ...base, sort: "available", dir: "desc" }).rows.map((r) => r.available);
  assert.equal(asc[asc.length - 1], null);
  assert.equal(desc[desc.length - 1], null);
  assert.equal(asc[0], 0);
  assert.equal(pageReadinessRows(rows, { ...base, sort: "missingCount", dir: "desc", filters: { status: ["READY"] } }).total, 2);
  assert.equal(pageReadinessRows(rows, { ...base, sort: "missingCount", dir: "desc", filters: { missing: ["STOCK"] } }).total, 1);
  const paged = pageReadinessRows(rows, { ...base, pageSize: 2, page: 3, sort: "productName", dir: "asc" });
  assert.equal(paged.pageCount, 3);
  assert.equal(paged.rows.length, 1);
  assert.equal(pageReadinessRows(rows, { ...base, q: "cm-500", sort: "", dir: "desc" }).total, 5, "tìm theo SKU không phân biệt hoa thường");

  console.log("✓ Sẵn sàng bán sỉ: đủ ⇒ READY · thiếu từng trường · bậc chỉ ở bảng riêng vẫn thiếu · tồn chưa biết ≠ 0 · xuất khẩu UNAVAILABLE kèm missingWhat");
}
