/**
 * THUẬT NGỮ THEO NGÀNH NGOÀI FORM SẢN PHẨM (chủ shop 10/10/2026, mục J) — `displayVariationText` · `legacyAttributeLabels` ·
 * `variantColumnLabel` trong `lib/constants/experience-profile.ts`.
 *
 * Chữ «Size: Hộp 10 cái» lọt ra ở dòng đơn của shop thực phẩm là DỮ LIỆU ĐÃ LƯU (trước #755 lõi tạo sản phẩm ghi
 * `detail = "Size: …"` cho mọi ngành, lõi đơn chép nguyên vào `order_items.variation_detail`). Giữ ba điều:
 *   (1) thực phẩm ⇒ nhãn «Quy cách», không «Size»; thời trang / bán lẻ chung ⇒ chuỗi in NGUYÊN, nhãn «Size» / «Màu»;
 *   (2) GIÁ TRỊ giữ nguyên từng ký tự (kể cả dấu phẩy thập phân «0,5kg»);
 *   (3) các màn đã sửa không còn ghi cứng chữ «Size» / in thẳng `variationDetail`.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/industry-terms.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displayVariationText, EXPERIENCE_PROFILES, legacyAttributeLabels, relabelVariation, variantColumnLabel, variationSizeLabel, withDisplayVariation } from "@/lib/constants/experience-profile";

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export function testIndustryTerms() {
  const food = EXPERIENCE_PROFILES.FOOD_SEAFOOD;
  const fashion = EXPERIENCE_PROFILES.FASHION;
  const generic = EXPERIENCE_PROFILES.GENERIC_COMMERCE;

  // ── (1)+(2) thực phẩm: đổi TÊN thuộc tính, giữ GIÁ TRỊ ──
  assert.equal(displayVariationText("Size: 1kg (2 túi 0,5kg)", food), "Quy cách: 1kg (2 túi 0,5kg)", "khung «Đơn đang chốt» của HSLC");
  assert.equal(displayVariationText("Size: Hộp 10 cái", food), "Quy cách: Hộp 10 cái", "dòng đơn ở trang chi tiết sản phẩm");
  assert.equal(displayVariationText("Màu: Đỏ, Size: 2kg", food), "Màu: Đỏ, Quy cách: 2kg", "thuộc tính thứ hai sau dấu phẩy cũng đổi; Màu là dữ liệu thật — giữ");
  assert.equal(displayVariationText("SIZE:500g", food), "Quy cách:500g", "không phân biệt hoa thường, không cần khoảng trắng");
  assert.equal(displayVariationText("Kích cỡ: Hộp lớn", food), "Quy cách: Hộp lớn");
  assert.equal(displayVariationText("Quy cách: 500g/gói", food), "Quy cách: 500g/gói", "chữ mới sau #755 giữ nguyên");
  assert.equal(displayVariationText("Hộp size lớn: 2kg", food), "Hộp size lớn: 2kg", "«size» giữa một tên khác không phải tên thuộc tính — không đụng");
  assert.equal(displayVariationText("", food), "");
  assert.ok(!/size/i.test(displayVariationText("Size: 1kg, Size: 2kg", food)), "thực phẩm: không còn chữ Size");
  assert.deepEqual(legacyAttributeLabels(food), { size: "Quy cách", color: "Màu" });
  assert.equal(variantColumnLabel(food), "Quy cách");

  // ── (1) thời trang / bán lẻ chung: chuỗi in NGUYÊN, nhãn Size / Màu ──
  for (const p of [fashion, generic]) {
    assert.equal(displayVariationText("Màu: Đen, Size: M", p), "Màu: Đen, Size: M", `${p.preset}: không đổi một ký tự`);
    assert.deepEqual(legacyAttributeLabels(p), { size: "Size", color: "Màu" });
    assert.equal(variantColumnLabel(p), "Màu / Size");
  }

  // ── chưa đọc được hồ sơ (null) ⇒ in NGUYÊN chữ đã lưu, nhãn cũ — không đoán ngành ──
  assert.equal(displayVariationText("Size: 1kg", null), "Size: 1kg");
  assert.equal(variationSizeLabel(null), null);
  assert.deepEqual(legacyAttributeLabels(null), { size: "Size", color: "Màu" });
  assert.equal(variantColumnLabel(null), "Màu / Size");
  // nhãn truyền xuống client là CHUỖI: thực phẩm «Quy cách», thời trang null (in nguyên)
  assert.equal(variationSizeLabel(food), "Quy cách");
  assert.equal(variationSizeLabel(fashion), null);
  assert.equal(relabelVariation("Size: Hộp 10 cái", "Quy cách"), "Quy cách: Hộp 10 cái");
  assert.equal(relabelVariation("Size: M", null), "Size: M");
  const items = [{ variationDetail: "Size: 1kg", quantity: 2 }, { variationDetail: "", quantity: 1 }];
  assert.deepEqual(withDisplayVariation(items, food), [{ variationDetail: "Quy cách: 1kg", quantity: 2 }, { variationDetail: "", quantity: 1 }]);
  assert.deepEqual(withDisplayVariation(items, fashion), items);
  assert.equal(items[0].variationDetail, "Size: 1kg", "không sửa mảng gốc");

  // ── (3) quét mã nguồn các chỗ đã sửa ──
  const detail = stripComments(readFileSync("app/(dashboard)/products/[id]/page.tsx", "utf8"));
  assert.doesNotMatch(detail, /\$\{i\.variationDetail \|\|/, "trang chi tiết sản phẩm: dòng đơn phải qua displayVariationText");
  assert.match(detail, /displayVariationText\(i\.variationDetail, profile\)/);

  const perf = stripComments(readFileSync("app/(dashboard)/products/performance/page.tsx", "utf8"));
  assert.doesNotMatch(perf, /label: "Size"|label: "Màu"|>Màu \/ Size</, "bộ lọc / cột Hiệu quả mẫu mã: nhãn theo hồ sơ ngành, không ghi cứng");
  assert.match(perf, /legacyAttributeLabels\(profile\)/);

  const summary = stripComments(readFileSync("lib/sales-chatbot/order-summary.ts", "utf8"));
  assert.match(summary, /displayVariationText\(l\.variation, profile\)/, "khung «Đơn đang chốt»: chữ biến thể qua hồ sơ ngành");

  // Mọi màn in chữ biến thể của dòng đơn phải đi qua hồ sơ ngành (đổi trên dữ liệu ở Server Component hoặc nhận nhãn dạng chuỗi).
  const VARIATION_SCREENS: Record<string, RegExp> = {
    "app/(dashboard)/orders/page.tsx": /withDisplayVariation\(r\.items, displayProfile\)/,
    "app/(dashboard)/orders/[id]/page.tsx": /displayVariationText\(item\.variationDetail, displayProfile\)/,
    "app/(dashboard)/customers/[id]/page.tsx": /variationOf\(i\.variationDetail\)/,
    "app/(dashboard)/shipments/[id]/page.tsx": /displayVariationText\(item\.variationDetail, displayProfile\)/,
    "app/(dashboard)/reports/returns/page.tsx": /withDisplayVariation\(rows, displayProfile\)/,
    "app/(dashboard)/returns/columns.tsx": /relabelVariation\(i\.detail, variationLabel\)/,
    "app/(dashboard)/returns/page.tsx": /variationLabel=\{variationSizeLabel\(displayProfile\)\}/,
    "lib/sales-chatbot/new-order-alert.ts": /displayVariationText\(x\.variation, displayProfile\)/,
  };
  for (const [f, re] of Object.entries(VARIATION_SCREENS)) assert.match(stripComments(readFileSync(f, "utf8")), re, `${f}: chữ biến thể phải qua hồ sơ ngành`);
  for (const f of ["app/(dashboard)/orders/[id]/page.tsx", "app/(dashboard)/shipments/[id]/page.tsx"]) {
    assert.doesNotMatch(stripComments(readFileSync(f, "utf8")), /\{item\.variationDetail \|\| "—"\}/, `${f}: không in thẳng variationDetail`);
  }
  assert.doesNotMatch(stripComments(readFileSync("app/(dashboard)/customers/[id]/page.tsx", "utf8")), /` \(\$\{i\.variationDetail\}\)`/, "trang khách: không in thẳng variationDetail");

  // Nhãn Màu / Size ghi cứng đã chuyển sang hồ sơ ngành (khoá dữ liệu size / color giữ nguyên).
  const LABEL_SCREENS = [
    "app/(dashboard)/inventory/returns/inspection-station.tsx",
    "app/(dashboard)/production/topics/[id]/page.tsx",
    "app/api/export/products/route.ts",
    "app/api/export/planning/route.ts",
  ];
  for (const f of LABEL_SCREENS) {
    const src = stripComments(readFileSync(f, "utf8"));
    assert.doesNotMatch(src, /"Size"|label="Màu"|label: "Màu"|"Màu", "Size"/, `${f}: nhãn Màu / Size phải theo hồ sơ ngành`);
    assert.match(src, /legacyAttributeLabels\(/, `${f}: dùng legacyAttributeLabels`);
  }

  // Nhìn-ngược trong tệp mà client component nạp làm sập trang trên Safari < 16.4.
  const profileSrc = readFileSync("lib/constants/experience-profile.ts", "utf8");
  assert.doesNotMatch(profileSrc, /\(\?<[!=]/, "experience-profile.ts được client nạp — không dùng nhìn-ngược");

  console.log("✓ thuật ngữ theo ngành: thực phẩm in «Quy cách» thay «Size» ở dòng đơn / bộ lọc, giá trị giữ nguyên · thời trang giữ Size / Màu");
}

if (process.argv[1] && /industry-terms\.test\.ts$/.test(process.argv[1])) testIndustryTerms();
