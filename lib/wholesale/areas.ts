import { normalizeProvince } from "@/lib/constants/vn-regions";
import { foldVietnamese } from "@/lib/wholesale/segments";

/**
 * ═══════════ KHU VỰC QUÉT — TỈNH / THÀNH × KHU VỰC ═══════════
 *
 * Một lượt Text Search của Google trả tối đa 60 địa điểm (3 trang × 20), nên «nhà hàng hải sản Hà Nội»
 * chỉ thấy một phần rất nhỏ. Bộ phủ (`coverage.ts`) chia nhỏ theo KHU VỰC: mỗi ô quét = từ khoá × tỉnh ×
 * khu vực.
 *
 * ─── VÌ SAO LÀ «KHU VỰC», KHÔNG PHẢI «QUẬN / HUYỆN» ───
 *
 * Từ 01/07/2025 chính quyền địa phương còn hai cấp (tỉnh → xã / phường), cấp huyện không còn. Nhưng
 * người dùng Google Maps và chính dữ liệu Google vẫn gọi theo tên quận / huyện cũ («Quận 1», «Hải
 * Châu»), và đó là cách chia địa bàn đủ nhỏ để một truy vấn không bị trần 60 kết quả. Nên danh sách dưới
 * đây là TÊN KHU VỰC DÙNG ĐỂ TÌM, không phải đơn vị hành chính — và không suy ra địa chỉ hành chính của
 * lead từ nó. Tỉnh mới sáp nhập (TP.HCM + Bình Dương + Bà Rịa – Vũng Tàu, Hải Phòng + Hải Dương, Đà Nẵng
 * + Quảng Nam) có thêm các khu vực nổi bật của tỉnh cũ.
 *
 * Chủ shop thêm tỉnh / khu vực khác ngay trên form chiến dịch (ô «Khu vực tự khai») — không cần sửa mã.
 */

export type SearchArea = { code: string; name: string };
export type SearchProvince = { key: string; label: string; queryName: string; areas: SearchArea[] };

function areas(list: string[]): SearchArea[] {
  return list.map((name) => ({ code: areaCode(name), name }));
}

/**
 * Mã khu vực ổn định: bỏ dấu, chữ thường, gạch nối. «Quận 1» ⇒ `quan-1`. KHÔNG dùng `normalizeProvince`
 * (nó gộp bí danh tỉnh: «Vũng Tàu» và «Bà Rịa» cùng thành một khoá) — hai khu vực phải ra hai mã.
 */
export function areaCode(name: string): string {
  return foldVietnamese(name).trim().replace(/\s+/g, "-").slice(0, 60);
}

export const SEARCH_PROVINCES: readonly SearchProvince[] = [
  {
    key: "ho chi minh",
    label: "TP. Hồ Chí Minh",
    queryName: "Hồ Chí Minh",
    areas: areas([
      "Quận 1", "Quận 3", "Quận 4", "Quận 5", "Quận 6", "Quận 7", "Quận 8", "Quận 10", "Quận 11", "Quận 12",
      "Bình Thạnh", "Gò Vấp", "Phú Nhuận", "Tân Bình", "Tân Phú", "Bình Tân", "Thủ Đức", "Bình Chánh", "Hóc Môn", "Củ Chi",
      "Nhà Bè", "Cần Giờ", "Thủ Dầu Một", "Dĩ An", "Thuận An", "Vũng Tàu", "Bà Rịa",
    ]),
  },
  {
    key: "ha noi",
    label: "Hà Nội",
    queryName: "Hà Nội",
    areas: areas([
      "Ba Đình", "Hoàn Kiếm", "Tây Hồ", "Long Biên", "Cầu Giấy", "Đống Đa", "Hai Bà Trưng", "Hoàng Mai", "Thanh Xuân", "Nam Từ Liêm",
      "Bắc Từ Liêm", "Hà Đông", "Sơn Tây", "Ba Vì", "Chương Mỹ", "Đan Phượng", "Đông Anh", "Gia Lâm", "Hoài Đức", "Mê Linh",
      "Mỹ Đức", "Phú Xuyên", "Phúc Thọ", "Quốc Oai", "Sóc Sơn", "Thạch Thất", "Thanh Oai", "Thanh Trì", "Thường Tín", "Ứng Hòa",
    ]),
  },
  {
    key: "da nang",
    label: "Đà Nẵng",
    queryName: "Đà Nẵng",
    areas: areas(["Hải Châu", "Thanh Khê", "Sơn Trà", "Ngũ Hành Sơn", "Liên Chiểu", "Cẩm Lệ", "Hòa Vang", "Hội An", "Tam Kỳ"]),
  },
  {
    key: "thanh hoa",
    label: "Thanh Hóa",
    queryName: "Thanh Hóa",
    areas: areas([
      "TP Thanh Hóa", "Sầm Sơn", "Bỉm Sơn", "Nghi Sơn", "Hoằng Hóa", "Quảng Xương", "Hậu Lộc", "Nga Sơn", "Hà Trung", "Đông Sơn",
      "Thiệu Hóa", "Yên Định", "Vĩnh Lộc", "Thọ Xuân", "Triệu Sơn", "Nông Cống", "Như Thanh", "Như Xuân", "Ngọc Lặc", "Cẩm Thủy",
      "Thạch Thành", "Lang Chánh", "Bá Thước", "Thường Xuân", "Quan Hóa", "Quan Sơn", "Mường Lát",
    ]),
  },
  {
    key: "hai phong",
    label: "Hải Phòng",
    queryName: "Hải Phòng",
    areas: areas([
      "Hồng Bàng", "Ngô Quyền", "Lê Chân", "Hải An", "Kiến An", "Đồ Sơn", "Dương Kinh", "Thủy Nguyên", "An Dương", "An Lão",
      "Kiến Thụy", "Tiên Lãng", "Vĩnh Bảo", "Cát Hải", "TP Hải Dương", "Chí Linh",
    ]),
  },
  {
    key: "quang ninh",
    label: "Quảng Ninh",
    queryName: "Quảng Ninh",
    areas: areas(["Hạ Long", "Cẩm Phả", "Uông Bí", "Móng Cái", "Đông Triều", "Quảng Yên", "Vân Đồn", "Cô Tô", "Tiên Yên", "Hải Hà", "Đầm Hà", "Bình Liêu", "Ba Chẽ"]),
  },
];

const PROVINCE_BY_KEY = new Map(SEARCH_PROVINCES.map((p) => [p.key, p]));

export function searchProvince(key: string): SearchProvince | null {
  return PROVINCE_BY_KEY.get(normalizeProvince(key)) ?? null;
}

/**
 * Ô «Khu vực tự khai» của form: mỗi dòng `Tỉnh: khu vực 1, khu vực 2`. Tỉnh có sẵn ⇒ thêm khu vực vào
 * tỉnh đó; tỉnh mới ⇒ tạo tỉnh mới với đúng các khu vực đã khai. Dòng không có dấu «:» ⇒ cả tỉnh là một
 * khu vực (tìm theo tên tỉnh). Trả `invalid` cho dòng không đọc được — không đoán.
 */
export function parseCustomAreas(text: string | null | undefined): { provinces: SearchProvince[]; invalid: string[] } {
  const out = new Map<string, SearchProvince>();
  const invalid: string[] = [];
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [provPart, areaPart] = line.includes(":") ? [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)] : [line, ""];
    const label = provPart.trim();
    const key = normalizeProvince(label);
    if (!key || label.length > 60) {
      invalid.push(line.slice(0, 80));
      continue;
    }
    const known = PROVINCE_BY_KEY.get(key);
    const prov = out.get(key) ?? { key, label: known?.label ?? label, queryName: known?.queryName ?? label, areas: [] };
    const names = areaPart
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 60);
    for (const name of names.length ? names : [prov.queryName]) {
      const code = areaCode(name);
      if (code && !prov.areas.some((a) => a.code === code)) prov.areas.push({ code, name });
    }
    out.set(key, prov);
  }
  return { provinces: [...out.values()], invalid };
}
