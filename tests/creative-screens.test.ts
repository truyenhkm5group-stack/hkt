import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CREATIVE_HARD_LIMITS, DEFAULT_CREATIVE_CONFIG, type CreativeRule } from "@/lib/constants/creative-loop";
import { clampedFields, creativeSourceInputSchema, numericBounds, validateCreativeConfigInput } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — HAI MÀN HÌNH ĐẦU (nguồn ảnh · cấu hình) ═══════════
 *
 * Khối này khoá:
 *  1. Lược đồ nguồn ảnh: ảnh sản phẩm thật PHẢI có mã hàng; KHÔNG nhận băm / loại ảnh từ client.
 *  2. Lưu cấu hình: luật hỏng ⇒ TỪ CHỐI cả lần lưu (không lưu bản đã bỏ dòng); vượt trần ⇒ lưu bản
 *     đã kẹp VÀ nói ra ô nào bị kẹp; ô số để trống là lỗi, không rơi về mặc định trong im lặng.
 *  3. Trần hiện trên màn hình DÒ từ `normalizeCreativeConfig`, khớp `CREATIVE_HARD_LIMITS`.
 *  4. Ranh giới client/server ở mức mã nguồn.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/creative-screens.test.ts
 */

const goc = path.resolve(__dirname, "..");
const doc = (rel: string) => readFileSync(path.join(goc, rel), "utf8");

/** Một ảnh PNG 1×1 thật, base64. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const RULE_OK: CreativeRule = { metric: "messages", op: "lt", value: 1, minSpendVnd: 150_000, label: "Không tin nhắn" };

function cfg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...DEFAULT_CREATIVE_CONFIG, ...over };
}

function testSourceSchema() {
  const base = { kind: "SPY", title: "Mẫu đối thủ", note: "", sourceUrl: "", imageBase64: PNG_1X1 };
  assert.ok(creativeSourceInputSchema.safeParse(base).success, "ảnh spy không cần mã hàng");

  const thieuMa = creativeSourceInputSchema.safeParse({ ...base, kind: "PRODUCT_PHOTO" });
  assert.equal(thieuMa.success, false, "ảnh sản phẩm thật thiếu mã hàng phải bị từ chối");
  assert.deepEqual(thieuMa.error?.issues[0]?.path, ["productId"], "lỗi phải trỏ đúng ô mã hàng");
  assert.ok(creativeSourceInputSchema.safeParse({ ...base, kind: "PRODUCT_PHOTO", productId: "  " }).success === false, "mã hàng chỉ có khoảng trắng = thiếu mã");
  assert.ok(creativeSourceInputSchema.safeParse({ ...base, kind: "PRODUCT_PHOTO", productId: "p-1" }).success);

  // Máy chủ tự băm và tự đọc chữ ký tệp — client gửi kèm băm / loại ảnh là bị từ chối nguyên gói.
  assert.equal(creativeSourceInputSchema.safeParse({ ...base, sha256: "a".repeat(64) }).success, false, "không được nhận băm từ client");
  assert.equal(creativeSourceInputSchema.safeParse({ ...base, contentType: "image/png" }).success, false, "không được nhận loại ảnh từ client");

  assert.equal(creativeSourceInputSchema.safeParse({ ...base, kind: "OTHER" }).success, false, "loại nguồn lạ");
  assert.equal(creativeSourceInputSchema.safeParse({ ...base, imageBase64: "" }).success, false, "chưa chọn ảnh");
  assert.equal(creativeSourceInputSchema.safeParse({ ...base, imageBase64: "không phải base64!" }).success, false, "base64 hỏng");
  assert.equal(creativeSourceInputSchema.safeParse({ ...base, sourceUrl: "javascript:alert(1)" }).success, false, "link nguồn phải là http(s)");
  assert.ok(creativeSourceInputSchema.safeParse({ ...base, sourceUrl: "https://www.facebook.com/ads/library/?id=1" }).success);
}

function testConfigSave() {
  // Luật hỏng ⇒ từ chối CẢ lần lưu. Một dòng tốt + một dòng hỏng KHÔNG được lưu thành một dòng tốt.
  const hong = validateCreativeConfigInput(cfg({ killRules: [RULE_OK, { metric: "messages", op: "lt", value: 1 }] }));
  assert.equal(hong.ok, false, "luật thiếu sàn chi phải làm hỏng cả lần lưu");
  assert.ok(!("config" in hong), "bị từ chối thì KHÔNG có bản cấu hình nào để lưu — không lưu bản đã bỏ dòng");
  assert.equal(hong.problems.length, 1);
  assert.match(hong.problems[0].message, /Luật tắt #2/, "phải nói đúng dòng nào hỏng");

  // Dòng trống (người bấm "Thêm luật" rồi chưa điền) cũng là dòng hỏng — không có ngưỡng mặc định.
  const trong = validateCreativeConfigInput(cfg({ keepRules: [{ metric: "", op: "", value: null, minSpendVnd: null }] }));
  assert.equal(trong.ok, false, "dòng luật trống không được lưu thành một luật có ngưỡng đoán");

  const tot = validateCreativeConfigInput(cfg({ killRules: [RULE_OK], keepRules: [{ metric: "costPerOrder", op: "lte", value: 80_000, minSpendVnd: 100_000 }] }));
  assert.ok(tot.ok, "cấu hình đúng phải lưu được");
  if (tot.ok) {
    assert.equal(tot.config.killRules.length, 1);
    assert.equal(tot.config.keepRules.length, 1);
    assert.deepEqual(tot.clamped, [], "không vượt trần thì không kẹp ô nào");
    // Thiếu fanpage / tài khoản… KHÔNG chặn lưu (điền dần), nhưng phải được nói ra.
    assert.ok(tot.problems.some((p) => p.field === "pageId"), "trường còn thiếu phải quay lại để màn hình in");
  }

  // Vượt trần ⇒ LƯU bản đã kẹp và NÓI RA ô nào bị kẹp, từ bao nhiêu về bao nhiêu.
  const vuot = validateCreativeConfigInput(cfg({ budgetPerVariantVnd: 500_000, batchSize: 25, imageDailyCapUsd: 50 }));
  assert.ok(vuot.ok);
  if (vuot.ok) {
    assert.equal(vuot.config.budgetPerVariantVnd, CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd);
    assert.equal(vuot.config.batchSize, CREATIVE_HARD_LIMITS.maxBatchSize);
    const byField = Object.fromEntries(vuot.clamped.map((c) => [c.field, c]));
    assert.deepEqual(byField.budgetPerVariantVnd, { field: "budgetPerVariantVnd", from: 500_000, to: CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd });
    assert.deepEqual(byField.batchSize, { field: "batchSize", from: 25, to: CREATIVE_HARD_LIMITS.maxBatchSize });
    assert.equal(byField.imageDailyCapUsd?.to, CREATIVE_HARD_LIMITS.maxImageUsdPerDay);
  }

  // Ô số để trống là LỖI, không lặng lẽ rơi về mặc định.
  const rong = validateCreativeConfigInput(cfg({ budgetPerVariantVnd: null }));
  assert.equal(rong.ok, false, "ô số để trống không được thay bằng mặc định trong im lặng");
  assert.equal(validateCreativeConfigInput(cfg({ budgetPerVariantVnd: Number.NaN })).ok, false);
  assert.equal(validateCreativeConfigInput(cfg({ unknownField: 1 })).ok, false, "trường lạ bị từ chối — lệch hợp đồng phải lộ ra");

  // So đầu vào với đầu ra chỉ trên ô số, bỏ qua ô không phải số.
  assert.deepEqual(clampedFields({ testDays: 7 }, { ...DEFAULT_CREATIVE_CONFIG, testDays: 1 }), [{ field: "testDays", from: 7, to: 1 }]);
}

function testBoundsProbed() {
  const b = numericBounds(cfg());
  assert.equal(b.batchSize.max, CREATIVE_HARD_LIMITS.maxBatchSize, "trần số mẫu hiện trên màn hình phải là trần của mã nguồn");
  assert.equal(b.budgetPerVariantVnd.max, CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd);
  assert.equal(b.testDays.max, CREATIVE_HARD_LIMITS.maxTestDays);
  assert.equal(b.imageDailyCapUsd.max, CREATIVE_HARD_LIMITS.maxImageUsdPerDay);
  for (const [f, v] of Object.entries(b)) assert.ok(v.min <= v.max, `${f}: cận dưới lớn hơn cận trên`);

  // Màn hình không được gõ lại con số trần nào — nó DÒ từ normalizeCreativeConfig.
  const form = doc("app/(dashboard)/marketing/creatives/config-form.tsx");
  for (const n of ["200000", "200_000", "2_000_000", "2000000"]) assert.ok(!form.includes(n), `config-form.tsx gõ lại con số trần ${n} — phải dò bằng numericBounds()`);
}

/** Tệp client trong thư mục màn hình. */
function clientFiles(): string[] {
  const dir = "app/(dashboard)/marketing/creatives";
  return readdirSync(path.join(goc, dir))
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`)
    .filter((rel) => /^\s*["']use client["']/.test(doc(rel)));
}

function testClientServerBoundary() {
  const files = clientFiles();
  assert.ok(files.length >= 4, `đọc hụt client component của màn hình vòng mẫu (chỉ thấy ${files.length})`);
  for (const rel of files) {
    const src = doc(rel);
    for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
      const [, what, from] = m;
      const chiKieu = /^type\s/.test(what.trim());
      if (from.startsWith("@/lib/queries/")) assert.ok(chiKieu, `${rel} nhập ${from} ngoài \`import type\` — truy vấn chỉ chạy ở máy chủ`);
      assert.ok(!from.startsWith("@/lib/creative/images"), `${rel} nhập ${from} — tệp chỉ-máy-chủ (node:crypto, CSDL)`);
      assert.ok(!from.startsWith("@/db") && !from.startsWith("node:"), `${rel} nhập ${from} ở phía trình duyệt`);
    }
  }
  // Lược đồ dùng chung được client nhập — nó không được kéo theo gì phía máy chủ.
  const v = doc("lib/validation/creative.ts");
  for (const m of v.matchAll(/from\s+["']([^"']+)["']/g)) {
    const from = m[1];
    assert.ok(!from.startsWith("@/db") && !from.startsWith("node:") && !from.startsWith("@/lib/queries") && !from.startsWith("@/lib/creative/"), `lib/validation/creative.ts nhập ${from} — client đang dùng tệp này`);
  }
}

function testWiring() {
  const src = doc("lib/actions/creative-sources.ts");
  assert.ok(src.includes('can(user, "ideas:write")'), "thêm nguồn ảnh cần quyền ideas:write");
  assert.ok(src.includes("storeCreativeImage("), "ảnh phải đi qua đường lưu DUY NHẤT storeCreativeImage");
  assert.ok(!/\.insert\(\s*schema\.creativeImages/.test(src), "không được tự ghi creative_images — dùng storeCreativeImage");
  assert.ok(/createdByUserId:\s*user\.id/.test(src), "quy kết đi bằng khoá tài khoản (AGENTS.md mục 34)");
  assert.ok(/createdByName(,|\s*:\s*createdByName)/.test(src) && src.includes("schema.users.id"), "tên người tạo do MÁY CHỦ đọc từ users");
  assert.ok(src.includes("audit(") && src.includes("revalidatePath("), "ghi phải có nhật ký và làm mới trang");

  const cfgSrc = doc("lib/actions/creative-config.ts");
  assert.ok(cfgSrc.includes('can(user, "settings:manage")'), "sửa cấu hình vòng mẫu cần settings:manage");
  assert.ok(cfgSrc.includes("validateCreativeConfigInput("), "lưu cấu hình phải qua cùng bộ kiểm với màn hình");
  assert.ok(cfgSrc.includes("setSettingJson(CREATIVE_CONFIG_KEY, v.config)"), "chỉ lưu bản đã chuẩn hoá (đã kẹp)");
  assert.ok(/before:/.test(cfgSrc) && /after:/.test(cfgSrc), "nhật ký lưu cấu hình phải có bản trước/sau");

  const route = doc("app/api/creative/images/[id]/route.ts");
  assert.ok(route.includes('can(user, "ideas:view")') && route.includes("readCreativeImage("), "route ảnh: đòi quyền và đọc qua đường đọc duy nhất");
  assert.ok(route.includes("private, max-age=31536000, immutable"));
  assert.ok(/status:\s*404/.test(route), "ảnh đã xoá điểm ảnh phải trả 404");
}

export function testCreativeScreens() {
  testSourceSchema();
  testConfigSave();
  testBoundsProbed();
  testClientServerBoundary();
  testWiring();
  console.log("✓ Vòng mẫu · màn hình: ảnh thật bắt buộc mã hàng, không nhận băm từ client · luật hỏng ⇒ không lưu gì · vượt trần ⇒ lưu bản kẹp và nói ra · ranh giới client/server");
}

if (process.argv[1] && /creative-screens\.test\.ts$/.test(process.argv[1])) {
  testCreativeScreens();
}
