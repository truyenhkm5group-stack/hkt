/**
 * HỒ SƠ TRẢI NGHIỆM THEO NGÀNH (`lib/constants/experience-profile.ts`) — một lõi SaaS, giao diện theo ngành.
 *
 * Giữ bốn điều: (1) tổ chức chưa ai chọn ngành KHÔNG đổi giao diện (vẫn Size / Màu, chữ `detail` y hệt bản cũ);
 * (2) shop thực phẩm thấy Quy cách / Khối lượng, KHÔNG thấy Size / Màu, và "2kg" không bao giờ vào cột size;
 * (3) ghi đè của quản trị thắng mẫu ngành, tổ chức nhà luôn thời trang; (4) không tệp nào rẽ nhánh theo mã tổ chức.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/experience-profile.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXPERIENCE_PROFILES, resolveExperienceProfile, specOf, variantDetailText } from "@/lib/constants/experience-profile";
import { manualVariantSchema } from "@/lib/validation/products";

export function testExperienceProfile() {
  // ── (3) thứ tự phân giải ──
  assert.equal(resolveExperienceProfile({ isHome: true, templateKey: "seafood-commerce", override: "FOOD_SEAFOOD" }).profile.preset, "FASHION", "tổ chức nhà luôn thời trang");
  assert.equal(resolveExperienceProfile({ isHome: false, templateKey: "seafood-commerce" }).profile.preset, "FOOD_SEAFOOD");
  assert.equal(resolveExperienceProfile({ isHome: false, templateKey: "food-commerce" }).profile.preset, "FOOD_SEAFOOD");
  assert.equal(resolveExperienceProfile({ isHome: false, templateKey: "fashion-commerce" }).profile.preset, "FASHION");
  assert.equal(resolveExperienceProfile({ isHome: false, templateKey: "seafood-commerce", override: "FASHION" }).basis, "OVERRIDE", "quản trị chọn tay thắng mẫu ngành");
  assert.equal(resolveExperienceProfile({ isHome: false, templateKey: null, override: "lung tung" }).profile.preset, "GENERIC_COMMERCE", "ghi đè hỏng ⇒ mặc định, không đoán ngành");

  // ── (1) tương thích: bộ mặc định vẫn Size / Màu, chữ detail y như `[Màu: x, Size: y]` cũ ──
  const generic = EXPERIENCE_PROFILES.GENERIC_COMMERCE;
  assert.deepEqual(generic.variantFields.map((f) => f.storage), ["size", "color"]);
  assert.equal(generic.sizeColorMatrix, true);
  assert.equal(variantDetailText(generic.variantFields, { size: "M", color: "Đen" }), "Màu: Đen, Size: M");
  assert.equal(variantDetailText(generic.variantFields, { size: "M", color: "" }), "Size: M");

  // ── (2) thực phẩm ──
  const food = EXPERIENCE_PROFILES.FOOD_SEAFOOD;
  assert.ok(!food.variantFields.some((f) => f.storage === "size" || f.storage === "color"), "thực phẩm không có ô Size / Màu");
  assert.ok(!food.variantFields.some((f) => /size|màu/i.test(f.label)), "không nhãn Size / Màu ở thực phẩm");
  assert.equal(food.variantTerm, "Quy cách");
  assert.equal(food.sizeColorMatrix, false);
  assert.equal(variantDetailText(food.variantFields, { spec: "500g/gói", weight: 500, size: "2kg" }), "Quy cách: 500g/gói", "chữ detail chỉ từ ô của hồ sơ — cột size cũ không lọt vào");
  assert.equal(specOf({ spec: "1kg/hộp", khac: 1 }), "1kg/hộp");
  assert.equal(specOf(null), "");
  assert.equal(specOf(["x"]), "");
  const v = manualVariantSchema.parse({ sku: "CCT500", spec: "500g/gói", weight: 500 });
  assert.equal(v.size, "", "quy cách không vào cột size");
  assert.equal(v.spec, "500g/gói");
  assert.equal(manualVariantSchema.parse({ sku: "A1" }).weight, null, "khối lượng không khai ⇒ null (giữ số cũ), không phải 0");

  // ── đường ghi chỉ ghi ô của hồ sơ: sửa mẫu mã ở shop thực phẩm không xoá trắng size / color cũ ──
  const core = readFileSync("lib/records/product-create.ts", "utf8");
  assert.match(core, /has\("size"\) \? \{ size: v\.size \}/);
  assert.match(core, /has\("color"\) \? \{ color: v\.color \}/);

  // ── (4) không rẽ nhánh theo mã tổ chức trong các tệp giao diện / hồ sơ ──
  for (const f of ["lib/constants/experience-profile.ts", "lib/experience/profile.ts", "app/(dashboard)/products/product-form.tsx", "app/(dashboard)/products/[id]/page.tsx", "app/(dashboard)/products/page.tsx", "app/(dashboard)/products/new/page.tsx"]) {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\bhslc\b|organization\.code\s*===|org\.code\s*===/i, `${f}: không được rẽ nhánh giao diện theo mã tổ chức`);
  }
  console.log("✓ hồ sơ ngành: mặc định giữ Size / Màu như cũ · thực phẩm Quy cách / Khối lượng, không Size / Màu · ghi đè thắng mẫu ngành · không rẽ nhánh theo mã tổ chức");
}

if (process.argv[1] && /experience-profile\.test\.ts$/.test(process.argv[1])) testExperienceProfile();
