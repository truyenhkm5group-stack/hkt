/**
 * ═══════════ PRODUCTS-SHELL-V2: TRANG «SẢN PHẨM» GỌN CHO KHÁCH VỎ · SỐ GỌN DẤU PHẨY · «0 KHO» (production HSLC 10/10/2026) ═══════════
 *
 *  · Thuần: số tiền dạng gọn dùng DẤU PHẨY thập phân («1,62 tỷ», «2,5 tr») ở CẢ `formatVND` lẫn `<Money compact>` — dấu chấm là dấu
 *    NGHÌN trong tiếng Việt, «1.62 tỷ» đọc thành một con số khác. Tiêu đề phụ khi 0 kho in câu đúng nghĩa, không in «0 kho».
 *  · Thuần: dòng gọn của khách vỏ lấy LẠI số của `listProducts()`; chưa có phiếu nhập ⇒ tồn `null` ⇒ «Chưa có phiếu nhập», không 0.
 *  · Mã nguồn: nhánh khách vỏ của `page.tsx` không vẽ bảng / thẻ sổ kho ERP; `shell-product-list.tsx` không có cột nhập mới · tái
 *    nhập · điều chỉnh · GTC; người dùng ERP vẫn thấy `ProductsTable` như cũ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Money } from "@/components/ui-bits";
import { formatVND } from "@/lib/format";
import {
  SHELL_PRODUCT_GAP_LABEL,
  STOCK_UNKNOWN_TEXT,
  shellGapText,
  shellProductGaps,
  shellProductGroup,
  shellProductRow,
  shellStockText,
  warehouseHeadline,
} from "@/lib/constants/products-shell";
import type { ProductListRow } from "@/lib/queries/products";

const DIR = "app/(dashboard)/products";
// Luật 65: cắt mã nguồn theo "\n" thì phải chuẩn hoá CRLF trước.
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const strip = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

function testCompactFormat() {
  // Thành phần .tsx biên dịch theo JSX cổ điển dưới tsx ⇒ cần `React` toàn cục (cùng cách tests/legal-registers.test.ts).
  (globalThis as { React?: typeof React }).React ??= React;
  const cases: [number, string][] = [
    [1_620_000_000, "1,62 tỷ"],
    [1_500_000_000, "1,5 tỷ"],
    [1_000_000_000, "1 tỷ"],
    [2_500_000, "2,5 tr"],
    [2_000_000, "2 tr"],
    [-2_500_000, "-2,5 tr"],
    [-1_620_000_000, "-1,62 tỷ"],
    [12_000, "12k"],
    [0, "0"],
  ];
  for (const [n, out] of cases) {
    assert.equal(formatVND(n, { compact: true }), out, `formatVND(${n}, compact)`);
    // <Money compact> từng có bản chép riêng (dấu chấm) — nay phải ra ĐÚNG chuỗi của bộ định dạng chung.
    assert.equal(renderToStaticMarkup(createElement(Money, { value: n, compact: true })).replace(/<[^>]+>/g, ""), out, `<Money compact value=${n}>`);
  }
  assert.equal(formatVND(2_500_000, { compact: true, sign: true }), "+2,5 tr", "dấu + khi xin sign");
  assert.equal(formatVND(1_620_000_000, { compact: true, sign: true }), "+1,62 tỷ");
  assert.equal(formatVND(-2_500_000, { compact: true, sign: true }), "-2,5 tr", "số âm giữ dấu -, không thành +");
  assert.equal(renderToStaticMarkup(createElement(Money, { value: 2_500_000, compact: true, sign: true })).replace(/<[^>]+>/g, ""), "+2,5 tr");
  assert.equal(formatVND(1_620_000_000), "1.620.000.000 ₫", "bản đầy đủ vẫn dùng dấu chấm NGHÌN");
  // Không còn bản tự ghép trong ui-bits.
  assert.ok(!/toFixed\(/.test(strip(read("components/ui-bits.tsx"))), "ui-bits.tsx không tự ghép số gọn bằng toFixed — đi qua formatVND");
  console.log("  ✓ số gọn: «1,62 tỷ» · «2,5 tr» · «2 tr» · âm / dấu + — formatVND ≡ <Money compact>");
}

function testWarehouseHeadline() {
  assert.equal(warehouseHeadline(0), "Chưa khai kho — tồn tính chung theo phiếu kho", "0 kho ⇒ câu đúng nghĩa, không «0 kho»");
  assert.ok(!/^0\b/.test(warehouseHeadline(0)), "không bắt đầu bằng số 0");
  assert.equal(warehouseHeadline(Number.NaN), warehouseHeadline(0), "không hữu hạn ⇒ như chưa khai");
  assert.equal(warehouseHeadline(1), "1 kho");
  assert.equal(warehouseHeadline(1200), "1.200 kho");
  const page = read(`${DIR}/page.tsx`);
  assert.match(page, /description=\{warehouseHeadline\(warehouses\.length\)\}/, "tiêu đề phụ ERP đi qua warehouseHeadline");
  assert.ok(!/\$\{formatNumber\(warehouses\.length\)\} kho/.test(page), "không còn ghép «${n} kho» tại trang");
  assert.match(page, /đơn vị hàng × giá nhập gần nhất/, "giá trị tồn ghi rõ là số ĐƠN VỊ hàng, không phải số sản phẩm");
  assert.ok(!/stockUnits\)\} sản phẩm/.test(page), "không gọi số đơn vị là «sản phẩm»");
  console.log("  ✓ tiêu đề kho: 0 kho ⇒ «Chưa khai kho — tồn tính chung theo phiếu kho» · «8.808 đơn vị hàng × giá nhập gần nhất»");
}

function row(over: Partial<ProductListRow> = {}): ProductListRow {
  return {
    id: "v1", productId: "p1", productName: "Chả mực", productImage: null, categories: [], sku: "CM-500", barcode: null, color: "", size: "500g", detail: "", images: [],
    retailPrice: 180_000, lastImportedPrice: 0, avgImportedPrice: 0, remainQuantity: 0, actualRemainQuantity: 0, selling: true, updatedAtExternal: null, sold30: 0, stockValue: 0, stocks: [],
    received: 0, receiptIn: 0, returnIn: 0, adjust: 0, manualOut: 0, shipped: 0, inTransit: 0, awaitingReturn: 0, shrinkage: 0, reserved: 0, delivered: 0, returned: 0,
    deliveredOrders: 0, returnedOrders: 0, successRate: null, productDeliveredOrders: 0, productReturnedOrders: 0, productSuccessRate: null,
    erpStock: 12, available: 10, stockKnown: true, unitCost: 0, receiptCount: 1,
    ...over,
  };
}

function testShellRows() {
  const ok = shellProductRow(row());
  assert.equal(ok.available, 10, "lấy LẠI tồn khả dụng của listProducts, không tính lại");
  assert.deepEqual(ok.gaps, [], "đủ giá + có tồn + đang bán ⇒ không thiếu gì");
  assert.equal(ok.variantLabel, "500g");

  // Chưa có phiếu nhập: erpStock/available của sổ là số vô nghĩa (có thể âm) ⇒ CHƯA BIẾT, không phải 0, không phải «hết hàng».
  const unknown = shellProductRow(row({ id: "v2", stockKnown: false, available: -3, erpStock: -3, receiptCount: 0 }));
  assert.equal(unknown.available, null, "chưa có phiếu nhập ⇒ null");
  assert.equal(shellStockText(unknown), STOCK_UNKNOWN_TEXT);
  assert.equal(STOCK_UNKNOWN_TEXT, "Chưa có phiếu nhập");
  assert.notEqual(shellStockText(unknown), "0");
  assert.deepEqual(shellProductGaps(row({ stockKnown: false, available: 0 })), ["NO_STOCK_RECORD"], "chưa biết tồn ≠ hết hàng");
  assert.equal(shellStockText({ available: 0 }), "0", "0 THẬT (đã có phiếu, bán hết) vẫn in 0");

  assert.deepEqual(shellProductGaps(row({ retailPrice: 0 })), ["NO_PRICE"]);
  assert.deepEqual(shellProductGaps(row({ available: 0 })), ["OUT_OF_STOCK"]);
  assert.deepEqual(shellProductGaps(row({ selling: false, retailPrice: 0, stockKnown: false })), ["REMOVED", "NO_PRICE", "NO_STOCK_RECORD"]);
  assert.equal(SHELL_PRODUCT_GAP_LABEL.NO_PRICE, "Chưa có giá bán");

  // Dòng cha: cộng tồn của mẫu ĐÃ BIẾT; không mẫu nào biết ⇒ null; lỗ hổng kèm số mẫu.
  const g = shellProductGroup([ok, unknown, shellProductRow(row({ id: "v3", retailPrice: 200_000, available: 0 }))]);
  assert.equal(g.id, "group:p1");
  assert.equal(g.available, 10, "10 + 0 (mẫu chưa biết KHÔNG cộng như 0)");
  assert.equal(g.unknownVariants, 1);
  assert.equal(g.variantCount, 3);
  assert.deepEqual([g.priceMin, g.priceMax], [180_000, 200_000]);
  assert.deepEqual(g.gaps.map((x) => shellGapText(x, g.variantCount)), ["Chưa nhập tồn (1/3 mẫu)", "Hết hàng (1/3 mẫu)"]);
  assert.equal(shellProductGroup([unknown, shellProductRow(row({ id: "v4", stockKnown: false }))]).available, null, "mọi mẫu chưa biết ⇒ cha chưa biết, không 0");
  assert.equal(shellGapText({ gap: "NO_PRICE", count: 2 }, 2), "Chưa có giá bán", "cả mã cùng thiếu ⇒ không kèm số mẫu");
  console.log("  ✓ dòng gọn khách vỏ: tồn lấy lại từ listProducts · chưa có phiếu nhập ⇒ «Chưa có phiếu nhập», không 0 · cha cộng mẫu đã biết");
}

function testShellSource() {
  const page = read(`${DIR}/page.tsx`);
  const start = page.indexOf("if (shell) {");
  const end = page.indexOf('eyebrow="Kho"');
  assert.ok(start > 0 && end > start, "page.tsx có nhánh khách vỏ đứng TRƯỚC bản ERP");
  const shellBranch = strip(page.slice(start, end));
  const erpBranch = strip(page.slice(end));
  assert.match(shellBranch, /<ShellProductList\b/, "khách vỏ thấy danh sách gọn");
  assert.match(shellBranch, /rows\.map\(shellProductRow\)/, "dòng gọn rút từ CHÍNH kết quả listProducts — không truy vấn mới");
  for (const bad of [/<ProductsTable\b/, /<MetricCard\b/, /Giá trị tồn kho/, /Đã xuất kho/, /Hoàn chờ kho nhận/, /key: "warehouse"/, /key: "category"/]) {
    assert.ok(!bad.test(shellBranch), `nhánh khách vỏ không vẽ ${bad}`);
  }
  assert.match(shellBranch, /Thêm sản phẩm/, "một nút chính «Thêm sản phẩm»");
  assert.match(shellBranch, /createGate\.allowed && shellAllows\(user, "\/products\/new"\)/, "nút chính theo đúng cổng tạo tay");
  assert.match(shellBranch, /Nhập từ tệp/, "«Nhập từ tệp» vẫn còn ở hàng phụ");
  assert.match(shellBranch, /Nhập hàng \/ kiểm kê/, "«Nhập hàng / kiểm kê» vẫn còn ở hàng phụ");
  assert.match(erpBranch, /<ProductsTable\b/, "người dùng ERP vẫn thấy bảng sổ kho đầy đủ");
  assert.match(erpBranch, /label="Giá trị tồn kho"/, "ERP vẫn có thẻ giá trị tồn");

  const list = strip(read(`${DIR}/shell-product-list.tsx`));
  assert.match(read(`${DIR}/shell-product-list.tsx`), /^"use client";/, "client wrapper");
  for (const bad of [/Nhập mới/, /Tái nhập/, /Điều chỉnh/, /GTC/, /\breceiptIn\b/, /\breturnIn\b/, /\badjust\b/, /\bdeliveredOrders\b/, /\bsuccessRate\b/, /\bsold30\b/, /\bstockValue\b/, /buildProductColumns/]) {
    assert.ok(!bad.test(list), `shell-product-list.tsx không có cột ERP ${bad}`);
  }
  assert.match(list, /r\.available === null\) return [^\n]*shellStockText\(r\)/, "ô tồn: CHƯA BIẾT ⇒ shellStockText («Chưa có phiếu nhập»)");
  assert.ok(!/formatNumber\(r\.available\)/.test(list), "ô tồn không tự in số (sẽ ra 0 khi chưa biết)");
  assert.ok(!/from "@\/lib\/queries\//.test(list.replace(/import type[^\n]*\n/g, "")), "client không import truy vấn chỉ-server");
  console.log("  ✓ mã nguồn: nhánh khách vỏ = danh sách gọn (tên · SKU · giá · tồn · thiếu gì) + «Thêm sản phẩm»; ERP giữ nguyên bảng 15 cột");
}

export async function testProductsShellV2() {
  testCompactFormat();
  testWarehouseHeadline();
  testShellRows();
  testShellSource();
}
