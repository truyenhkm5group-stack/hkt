/**
 * ═══════════ CHUẨN HOÁ ĐỊA CHỈ — ĐỊA GIỚI TỪ 01/07/2025 (lib/address/vn-address.ts) ═══════════
 *
 *  · Dữ liệu: đủ 34 tỉnh / 3.321 xã mới, mỗi xã mới mang danh sách (huyện cũ, xã cũ) đã gộp vào nó.
 *  · Địa chỉ MỚI có loại («Phường Bàn Cờ») ⇒ đúng xã; địa chỉ CŨ (xã cũ + huyện cũ, viết tắt «p13 q3», «tphcm») ⇒ quy về xã mới.
 *  · KHÔNG ĐOÁN: xã cũ bị chia ⇒ AMBIGUOUS kèm danh sách; chỉ có tỉnh ⇒ PROVINCE_ONLY; không tỉnh và tên xã trùng ⇒ UNKNOWN.
 *  · «Thạnh» / «Thành» gập về cùng chữ — khớp DÀI hơn thắng, và tên huyện không được nằm chồng trong tên xã.
 *  · Lõi ghi đơn: người đã chọn xã thì giữ; không thì chỉ điền xã khi một đáp án; tỉnh lạ thì giữ nguyên chữ người gõ.
 */
import assert from "node:assert/strict";
import data from "@/lib/address/vn-admin-2025.json";
import { placeGapLine } from "@/lib/sales-chatbot/new-order-alert";
import { adminProvinces, adminWardsOf, findProvince, fullAddressLine, normalizeVnAddress, resolveRecipientPlace, type AddressMatch } from "@/lib/address/vn-address";

const wardOf = (m: AddressMatch) => (m.status === "MATCHED" ? `${m.ward.name} · ${m.province.name}` : m.status);

export function testVnAddress() {
  const provinces = (data as unknown as { provinces: [number, string, string[], [number, string, [string, string][]][]][] }).provinces;
  assert.equal(adminProvinces().length, 34, "34 tỉnh / thành mới");
  assert.equal(provinces.reduce((n, p) => n + p[3].length, 0), 3321, "3.321 xã / phường / đặc khu mới");
  assert.equal(new Set(provinces.flatMap((p) => p[2])).size, 63, "63 tỉnh cũ đều quy về một tỉnh mới");
  assert.ok(provinces.every((p) => p[3].length > 0), "tỉnh nào cũng có xã");

  // Tỉnh: tên mới, tên cũ, viết tắt.
  assert.equal(findProvince("tphcm")?.name, "Thành phố Hồ Chí Minh");
  assert.equal(findProvince("Bình Dương")?.name, "Thành phố Hồ Chí Minh", "tỉnh cũ quy về tỉnh mới");
  assert.equal(findProvince("Kiên Giang")?.name, "Tỉnh An Giang");
  assert.equal(findProvince("Hà Giang")?.name, "Tỉnh Tuyên Quang");
  assert.equal(findProvince("Mars"), null);

  // Địa chỉ mới.
  assert.equal(wardOf(normalizeVnAddress("123 Nguyễn Đình Chiểu, Phường Bàn Cờ, TP Hồ Chí Minh")), "Phường Bàn Cờ · Thành phố Hồ Chí Minh");
  assert.equal(wardOf(normalizeVnAddress("Phường Hạc Thành, Thanh Hóa")), "Phường Hạc Thành · Tỉnh Thanh Hóa");
  const pq = normalizeVnAddress("Phú Quốc, Kiên Giang");
  assert.ok(pq.status === "AMBIGUOUS" && pq.province.name === "Tỉnh An Giang" && pq.candidates[0].name === "Đặc khu Phú Quốc", "huyện cũ Phú Quốc nay là hai đặc khu ⇒ gợi ý, cái cùng tên lên đầu");
  assert.equal(wardOf(normalizeVnAddress("Đặc khu Phú Quốc, Kiên Giang")), "Đặc khu Phú Quốc · Tỉnh An Giang");
  // Địa chỉ cũ: xã cũ + huyện cũ ⇒ xã mới; huyện cũ không bị đọc nhầm thành phường mới cùng tên.
  assert.equal(wardOf(normalizeVnAddress("Thôn 3, xã Ea Tu, TP Buôn Ma Thuột, Đắk Lắk")), "Phường Tân An · Tỉnh Đắk Lắk");
  assert.equal(wardOf(normalizeVnAddress("ấp 2 xã Tân Thạnh Đông huyện Củ Chi")), "Xã Phú Hòa Đông · Thành phố Hồ Chí Minh", "không tỉnh mà xã cũ + huyện cũ duy nhất ⇒ vẫn đọc được");
  const city = normalizeVnAddress("Số 432 Hùng Vương, Việt Trì, Phú Thọ");
  assert.ok(city.status === "AMBIGUOUS" && city.candidates.some((c) => c.name === "Phường Việt Trì"), "«Việt Trì» không tiền tố = thành phố cũ (nay nhiều phường) ⇒ người chọn, không đoán là Phường Việt Trì");
  assert.equal(wardOf(normalizeVnAddress("Số 432 Hùng Vương, phường Việt Trì, Phú Thọ")), "Phường Việt Trì · Tỉnh Phú Thọ", "có tiền tố thì nhận");
  const split = normalizeVnAddress("45/2 Lê Văn Sỹ p13 q3 tphcm");
  assert.equal(split.status, "AMBIGUOUS", "phường cũ bị chia ⇒ người chọn, không chọn hộ");
  assert.ok(split.status === "AMBIGUOUS" && split.candidates.some((c) => c.name === "Phường Nhiêu Lộc") && split.candidates.length <= 8);
  // Không đoán.
  assert.equal(normalizeVnAddress("Hải Phòng").status, "PROVINCE_ONLY");
  assert.equal(normalizeVnAddress("abc xyz").status, "UNKNOWN");
  assert.equal(normalizeVnAddress("").status, "UNKNOWN");

  // Lõi ghi đơn.
  const auto = resolveRecipientPlace({ address: "12 Lê Lợi, Phường Bàn Cờ", province: "HCM" });
  assert.deepEqual([auto.province, auto.ward], ["Thành phố Hồ Chí Minh", "Phường Bàn Cờ"]);
  const chosen = resolveRecipientPlace({ address: "45/2 Lê Văn Sỹ p13 q3", province: "tphcm", ward: "nhiêu lộc" });
  assert.deepEqual([chosen.province, chosen.ward], ["Thành phố Hồ Chí Minh", "Phường Nhiêu Lộc"], "người chọn xã thắng bộ đọc");
  const wrong = resolveRecipientPlace({ address: "45/2 Lê Văn Sỹ p13 q3", province: "tphcm", ward: "Phường Hạc Thành" });
  assert.equal(wrong.ward, "", "xã không thuộc tỉnh ⇒ bỏ, không ghi sai");
  const open = resolveRecipientPlace({ address: "45/2 Lê Văn Sỹ p13 q3 tphcm", province: "" });
  assert.deepEqual([open.province, open.ward], ["Thành phố Hồ Chí Minh", ""], "nhiều đáp án ⇒ tỉnh có, xã trống");
  const keep = resolveRecipientPlace({ address: "số 5 đường A", province: "Tỉnh Lạ" });
  assert.deepEqual([keep.province, keep.ward], ["Tỉnh Lạ", ""], "tỉnh không nhận ra ⇒ giữ nguyên chữ người gõ");
  assert.ok(adminWardsOf(findProvince("Hà Nội")!.code).some((w) => w.name === "Phường Ba Đình"));

  assert.equal(fullAddressLine("12 Lê Lợi, Phường Bàn Cờ", "Phường Bàn Cờ", "Thành phố Hồ Chí Minh"), "12 Lê Lợi, Phường Bàn Cờ, Thành phố Hồ Chí Minh", "không lặp xã đã có trong dòng");
  assert.equal(fullAddressLine("12 Lê Lợi", "", ""), "12 Lê Lợi");
  // Tin báo đơn: địa chỉ chưa ghép được nói rõ thiếu gì; nơi gọi không đọc tỉnh / xã thì không nhắc gì.
  assert.equal(placeGapLine({}), "");
  assert.match(placeGapLine({ province: "", ward: "" }), /tỉnh/);
  assert.match(placeGapLine({ province: "Thành phố Hà Nội", ward: "" }), /xã \/ phường/);
  assert.equal(placeGapLine({ province: "Thành phố Hà Nội", ward: "Phường Ba Đình" }), "");
  console.log("✓ Địa chỉ: 34 tỉnh / 3.321 xã mới + 63 tỉnh cũ · đọc địa chỉ mới / cũ / viết tắt · xã cũ bị chia ⇒ người chọn · người chọn thắng bộ đọc");
}
