/**
 * ═══════════ NƯỚC CỦA LEAD — MỘT THANG CHỨNG CỨ (lib/wholesale/lead-country.ts) ═══════════
 *
 * Đo đủ thang: người xác nhận › khoá tỉnh (quốc tế / tỉnh VN) › mã nước SĐT (mã dùng chung không kết luận) › đuôi tên miền quốc
 * gia của website rồi email (đuôi chung / đuôi «mượn» không kết luận) › CHƯA BIẾT. Và đo rằng bất đồng cũ không còn: cổng nước
 * / làn kênh và ngôn ngữ AI soạn email đọc CÙNG một hàm, không tệp nào còn luật suy nước riêng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callingCodeOf, countryConfirmationOf, countryOfDomain, COUNTRY_CONFIRM_OUTCOME, leadCountryOf, type LeadCountryInput } from "@/lib/wholesale/lead-country";

function lc(over: Partial<LeadCountryInput>) {
  return leadCountryOf({ confirmedCountry: null, provinceKey: null, phoneCountryCode: null, phones: [], websiteDomain: null, email: null, ...over });
}

function testLadder() {
  // 1. Người xác nhận đè mọi suy luận.
  assert.deepEqual([lc({ confirmedCountry: "CA", provinceKey: "intl us", phones: ["+49 30 1234567"], websiteDomain: "x.de" }).country, lc({ confirmedCountry: "CA" }).source], ["CA", "CONFIRMED"]);
  assert.equal(lc({ confirmedCountry: "XX", websiteDomain: "x.de" }).country, "DE", "mã xác nhận lạ ⇒ bỏ, đi tiếp thang");

  // 2. Khoá tỉnh.
  assert.deepEqual([lc({ provinceKey: "intl jp", phones: ["+84905123456"] }).country, lc({ provinceKey: "intl jp" }).source], ["JP", "PROVINCE"], "ô quét quốc tế thắng SĐT");
  assert.deepEqual([lc({ provinceKey: "da nang" }).country, lc({ provinceKey: "da nang" }).source], ["VN", "PROVINCE"], "tỉnh VN trong danh sách chuẩn");
  assert.equal(lc({ provinceKey: "intl xx", websiteDomain: "a.fr" }).country, "FR", "khoá quốc tế không nhận ra ⇒ bỏ, đi tiếp thang");
  assert.equal(lc({ provinceKey: "tinh khong co that" }).country, null, "khoá tỉnh lạ (tệp nhập) không phải chứng cứ VN");

  // 3. SĐT.
  assert.deepEqual([lc({ phoneCountryCode: "84" }).country, lc({ phoneCountryCode: "84" }).source], ["VN", "PHONE"]);
  assert.equal(lc({ phones: ["+84905123456"] }).country, "VN");
  assert.equal(lc({ phones: ["+49 30 1234567"], websiteDomain: "x.fr" }).country, "DE", "SĐT đứng trước tên miền");
  assert.equal(lc({ phones: ["0049 30 1234567"] }).country, "DE", "tiền tố 00 như +");
  assert.equal(lc({ phones: ["+852 2123 4567"] }).country, "HK", "mã 3 chữ số khớp trước mã ngắn");
  assert.equal(lc({ phones: ["030 1234567"] }).country, null, "số nội địa không mã nước ⇒ không kết luận");
  const nanp = lc({ phones: ["+1 415 555 0100"] });
  assert.deepEqual([nanp.country, nanp.source], [null, null], "+1 dùng chung Mỹ / Canada ⇒ CHƯA BIẾT (luật thư chào hàng hai nước khác nhau)");
  assert.match(nanp.detail, /\+1 dùng chung/);
  assert.equal(lc({ phones: ["+1 604 555 0100"], websiteDomain: "seafood.ca" }).country, "CA", "+1 không kết luận ⇒ tên miền quyết");
  assert.deepEqual(callingCodeOf("+7 495 123 4567"), { code: "7", country: null });
  assert.equal(callingCodeOf("+84"), null, "quá ngắn ⇒ không phải số");

  // 4. Đuôi tên miền quốc gia.
  assert.deepEqual([lc({ websiteDomain: "fisch.de" }).country, lc({ websiteDomain: "fisch.de" }).source], ["DE", "DOMAIN"]);
  assert.equal(lc({ websiteDomain: "haisan.com.vn" }).country, "VN");
  assert.equal(lc({ websiteDomain: "shop.co.uk" }).country, "GB", ".uk ⇒ GB");
  assert.deepEqual([lc({ email: "buyer@fresh.fr" }).country, lc({ email: "buyer@fresh.fr" }).source], ["FR", "EMAIL_DOMAIN"]);
  assert.equal(lc({ websiteDomain: "shop.de", email: "a@b.fr" }).country, "DE", "website trước email");
  for (const d of ["shop.com", "shop.net", "brand.io", "brand.co", "brand.ai", "brand.me", "brand.eu"]) assert.equal(countryOfDomain(d), null, `${d} không kết luận`);

  // 5. Còn lại ⇒ CHƯA BIẾT, không mặc định trong nước.
  assert.equal(lc({}).country, null);
  assert.equal(lc({ email: "chu@gmail.com", websiteDomain: "quan.com" }).country, null);

  // Xác nhận của người: dòng mới nhất thắng.
  const t = (m: number) => new Date(Date.UTC(2026, 9, 30, 3, m));
  assert.equal(countryConfirmationOf([]), null);
  assert.equal(countryConfirmationOf([{ outcome: COUNTRY_CONFIRM_OUTCOME, meta: { country: "US" }, createdAt: t(1) }, { outcome: COUNTRY_CONFIRM_OUTCOME, meta: { country: "CA" }, createdAt: t(2) }]), "CA");
  assert.equal(countryConfirmationOf([{ outcome: "KHAC", meta: { country: "US" }, createdAt: t(3) }]), null);
}

/** Không tệp nào còn luật suy nước thứ hai (bất đồng cũ: contact-plan đọc khoá tỉnh, AI đọc SĐT + tên miền). */
function testSingleRule() {
  const plan = readFileSync("lib/wholesale/contact-plan.ts", "utf8");
  const ai = readFileSync("lib/wholesale/email-ai-draft.ts", "utf8");
  const guard = readFileSync("lib/wholesale/email-ai-draft-guard.ts", "utf8");
  const outbox = readFileSync("lib/wholesale/email-outbox.ts", "utf8");
  assert.ok(!/recipientCountryOf|isIntlProvinceKey/.test(plan), "contact-plan không tự đọc khoá tỉnh");
  assert.ok(!/draftLanguageFor\(/.test(ai + guard), "AI soạn email không còn hàm suy nước riêng");
  assert.ok(!/phoneCountryCode|websiteDomain/.test(guard), "hàng rào AI không đọc SĐT / tên miền để đoán nước");
  assert.match(ai, /leadCountryForLead\(/, "AI soạn email hỏi thang nước chung");
  assert.match(outbox, /leadCountryForLead\(/, "cổng nước của hộp thư đi hỏi thang nước chung");
}

export function testWholesaleLeadCountry() {
  testLadder();
  testSingleRule();
  console.log("✓ Nước của lead: một thang — người xác nhận › ô quét › SĐT (+1 / +7 không kết luận) › đuôi tên miền quốc gia (.com / .io không kết luận) › CHƯA BIẾT; cổng nước · làn kênh · ngôn ngữ AI cùng đọc một hàm");
}
