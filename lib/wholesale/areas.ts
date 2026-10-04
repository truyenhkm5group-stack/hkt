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
 * lead từ nó. Tỉnh mới sáp nhập có thêm các khu vực nổi bật (thường là thành phố) của tỉnh cũ.
 *
 * Hà Nội, TP.HCM, Đà Nẵng, Thanh Hóa, Hải Phòng, Quảng Ninh chia kỹ tới quận / huyện cũ; 28 tỉnh còn lại
 * chỉ có các đô thị chính — nhà hàng / khách sạn / quán nhậu dồn ở đó. Chủ shop thêm khu vực khác ngay trên
 * form chiến dịch (ô «Khu vực tự khai») — không cần sửa mã.
 *
 * ─── THỨ TỰ QUÉT (chủ shop chốt 04/10/2026) ───
 *
 * Hà Nội + TP.HCM trước, rồi khu vực KHÔNG có biển, rồi khu vực ven biển. «Không có biển» xét theo TỈNH
 * CŨ của khu vực (trước sáp nhập 2025, theo danh sách 28 tỉnh ven biển cũ), không theo tỉnh mới: Pleiku, Buôn Ma Thuột, Đà Lạt, Kon Tum là
 * vùng không giáp biển (khó mua hải sản tươi) dù tỉnh mới của chúng nay giáp biển. Khu vực tự khai ở form
 * coi là KHÔNG có biển — không đoán.
 */

/** `coastal`: tỉnh CŨ của khu vực giáp biển — xem `scanTier`. */
export type SearchArea = { code: string; name: string; coastal: boolean };
export type SearchProvince = { key: string; label: string; queryName: string; areas: SearchArea[] };

/** `coastal`: các tên khu vực ven biển trong `list` (`"ALL"` = cả tỉnh); tên còn lại là KHÔNG có biển. */
function areas(list: string[], coastal: readonly string[] | "ALL" = []): SearchArea[] {
  return list.map((name) => ({ code: areaCode(name), name, coastal: coastal === "ALL" || coastal.includes(name) }));
}

/**
 * Mã khu vực ổn định: bỏ dấu, chữ thường, gạch nối. «Quận 1» ⇒ `quan-1`. KHÔNG dùng `normalizeProvince`
 * (nó gộp bí danh tỉnh: «Vũng Tàu» và «Bà Rịa» cùng thành một khoá) — hai khu vực phải ra hai mã.
 */
export function areaCode(name: string): string {
  return foldVietnamese(name).trim().replace(/\s+/g, "-").slice(0, 60);
}

export const SEARCH_PROVINCES: readonly SearchProvince[] = [
  // ── Ưu tiên số 1 ──
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
    key: "ho chi minh",
    label: "TP. Hồ Chí Minh",
    queryName: "Hồ Chí Minh",
    areas: areas(
      [
        "Quận 1", "Quận 3", "Quận 4", "Quận 5", "Quận 6", "Quận 7", "Quận 8", "Quận 10", "Quận 11", "Quận 12",
        "Bình Thạnh", "Gò Vấp", "Phú Nhuận", "Tân Bình", "Tân Phú", "Bình Tân", "Thủ Đức", "Bình Chánh", "Hóc Môn", "Củ Chi",
        "Nhà Bè", "Cần Giờ", "Thủ Dầu Một", "Dĩ An", "Thuận An", "Vũng Tàu", "Bà Rịa",
      ],
      ["Cần Giờ", "Vũng Tàu", "Bà Rịa"],
    ),
  },
  // ── Miền Bắc ──
  { key: "lai chau", label: "Lai Châu", queryName: "Lai Châu", areas: areas(["TP Lai Châu"]) },
  { key: "dien bien", label: "Điện Biên", queryName: "Điện Biên", areas: areas(["Điện Biên Phủ"]) },
  { key: "son la", label: "Sơn La", queryName: "Sơn La", areas: areas(["TP Sơn La", "Mộc Châu"]) },
  { key: "lang son", label: "Lạng Sơn", queryName: "Lạng Sơn", areas: areas(["TP Lạng Sơn"]) },
  { key: "cao bang", label: "Cao Bằng", queryName: "Cao Bằng", areas: areas(["TP Cao Bằng"]) },
  { key: "tuyen quang", label: "Tuyên Quang", queryName: "Tuyên Quang", areas: areas(["TP Tuyên Quang", "Hà Giang"]) },
  { key: "lao cai", label: "Lào Cai", queryName: "Lào Cai", areas: areas(["TP Lào Cai", "Sa Pa", "Yên Bái"]) },
  { key: "thai nguyen", label: "Thái Nguyên", queryName: "Thái Nguyên", areas: areas(["TP Thái Nguyên", "Sông Công", "Bắc Kạn"]) },
  { key: "phu tho", label: "Phú Thọ", queryName: "Phú Thọ", areas: areas(["Việt Trì", "Vĩnh Yên", "Phúc Yên", "Hòa Bình"]) },
  { key: "bac ninh", label: "Bắc Ninh", queryName: "Bắc Ninh", areas: areas(["TP Bắc Ninh", "Từ Sơn", "Bắc Giang"]) },
  { key: "hung yen", label: "Hưng Yên", queryName: "Hưng Yên", areas: areas(["TP Hưng Yên", "Thái Bình"], ["Thái Bình"]) },
  { key: "ninh binh", label: "Ninh Bình", queryName: "Ninh Bình", areas: areas(["TP Ninh Bình", "Phủ Lý", "Nam Định"], ["TP Ninh Bình", "Nam Định"]) },
  {
    key: "hai phong",
    label: "Hải Phòng",
    queryName: "Hải Phòng",
    areas: areas(
      [
        "Hồng Bàng", "Ngô Quyền", "Lê Chân", "Hải An", "Kiến An", "Đồ Sơn", "Dương Kinh", "Thủy Nguyên", "An Dương", "An Lão",
        "Kiến Thụy", "Tiên Lãng", "Vĩnh Bảo", "Cát Hải", "TP Hải Dương", "Chí Linh",
      ],
      ["Hồng Bàng", "Ngô Quyền", "Lê Chân", "Hải An", "Kiến An", "Đồ Sơn", "Dương Kinh", "Thủy Nguyên", "An Dương", "An Lão", "Kiến Thụy", "Tiên Lãng", "Vĩnh Bảo", "Cát Hải"],
    ),
  },
  {
    key: "quang ninh",
    label: "Quảng Ninh",
    queryName: "Quảng Ninh",
    areas: areas(["Hạ Long", "Cẩm Phả", "Uông Bí", "Móng Cái", "Đông Triều", "Quảng Yên", "Vân Đồn", "Cô Tô", "Tiên Yên", "Hải Hà", "Đầm Hà", "Bình Liêu", "Ba Chẽ"], "ALL"),
  },
  // ── Miền Trung · Tây Nguyên ──
  {
    key: "thanh hoa",
    label: "Thanh Hóa",
    queryName: "Thanh Hóa",
    areas: areas(
      [
        "TP Thanh Hóa", "Sầm Sơn", "Bỉm Sơn", "Nghi Sơn", "Hoằng Hóa", "Quảng Xương", "Hậu Lộc", "Nga Sơn", "Hà Trung", "Đông Sơn",
        "Thiệu Hóa", "Yên Định", "Vĩnh Lộc", "Thọ Xuân", "Triệu Sơn", "Nông Cống", "Như Thanh", "Như Xuân", "Ngọc Lặc", "Cẩm Thủy",
        "Thạch Thành", "Lang Chánh", "Bá Thước", "Thường Xuân", "Quan Hóa", "Quan Sơn", "Mường Lát",
      ],
      "ALL",
    ),
  },
  { key: "nghe an", label: "Nghệ An", queryName: "Nghệ An", areas: areas(["Vinh", "Cửa Lò"], "ALL") },
  { key: "ha tinh", label: "Hà Tĩnh", queryName: "Hà Tĩnh", areas: areas(["TP Hà Tĩnh"], "ALL") },
  { key: "quang tri", label: "Quảng Trị", queryName: "Quảng Trị", areas: areas(["Đông Hà", "Đồng Hới"], "ALL") },
  { key: "hue", label: "Huế", queryName: "Huế", areas: areas(["TP Huế"], "ALL") },
  {
    key: "da nang",
    label: "Đà Nẵng",
    queryName: "Đà Nẵng",
    areas: areas(["Hải Châu", "Thanh Khê", "Sơn Trà", "Ngũ Hành Sơn", "Liên Chiểu", "Cẩm Lệ", "Hòa Vang", "Hội An", "Tam Kỳ"], "ALL"),
  },
  { key: "quang ngai", label: "Quảng Ngãi", queryName: "Quảng Ngãi", areas: areas(["TP Quảng Ngãi", "Kon Tum"], ["TP Quảng Ngãi"]) },
  { key: "gia lai", label: "Gia Lai", queryName: "Gia Lai", areas: areas(["Pleiku", "Quy Nhơn"], ["Quy Nhơn"]) },
  { key: "dak lak", label: "Đắk Lắk", queryName: "Đắk Lắk", areas: areas(["Buôn Ma Thuột", "Tuy Hòa"], ["Tuy Hòa"]) },
  { key: "khanh hoa", label: "Khánh Hòa", queryName: "Khánh Hòa", areas: areas(["Nha Trang", "Cam Ranh", "Phan Rang"], "ALL") },
  { key: "lam dong", label: "Lâm Đồng", queryName: "Lâm Đồng", areas: areas(["Đà Lạt", "Bảo Lộc", "Gia Nghĩa", "Phan Thiết"], ["Phan Thiết"]) },
  // ── Miền Nam ──
  { key: "dong nai", label: "Đồng Nai", queryName: "Đồng Nai", areas: areas(["Biên Hòa", "Long Khánh", "Đồng Xoài"]) },
  { key: "tay ninh", label: "Tây Ninh", queryName: "Tây Ninh", areas: areas(["TP Tây Ninh", "Tân An"]) },
  { key: "can tho", label: "Cần Thơ", queryName: "Cần Thơ", areas: areas(["Ninh Kiều", "Cái Răng", "Bình Thủy", "Vị Thanh", "Sóc Trăng"], ["Sóc Trăng"]) },
  { key: "vinh long", label: "Vĩnh Long", queryName: "Vĩnh Long", areas: areas(["TP Vĩnh Long", "Bến Tre", "Trà Vinh"], ["Bến Tre", "Trà Vinh"]) },
  { key: "dong thap", label: "Đồng Tháp", queryName: "Đồng Tháp", areas: areas(["Cao Lãnh", "Sa Đéc", "Mỹ Tho"], ["Mỹ Tho"]) },
  { key: "an giang", label: "An Giang", queryName: "An Giang", areas: areas(["Long Xuyên", "Châu Đốc", "Rạch Giá", "Phú Quốc"], ["Rạch Giá", "Phú Quốc"]) },
  { key: "ca mau", label: "Cà Mau", queryName: "Cà Mau", areas: areas(["TP Cà Mau", "Bạc Liêu"], "ALL") },
];

const PROVINCE_BY_KEY = new Map(SEARCH_PROVINCES.map((p) => [p.key, p]));

export function searchProvince(key: string): SearchProvince | null {
  return PROVINCE_BY_KEY.get(normalizeProvince(key)) ?? null;
}

// ─── Thứ tự quét ───

export type ScanTier = 1 | 2 | 3;
export type ScanPriority = { firstProvinces: readonly string[]; inlandBeforeCoastal: boolean };

export const SCAN_TIER_LABEL: Record<ScanTier, string> = {
  1: "Ưu tiên 1 · tỉnh quét trước",
  2: "Ưu tiên 2 · không có biển",
  3: "Ưu tiên 3 · ven biển",
};

/**
 * Cờ ven biển của một khu vực. Ảnh chụp tỉnh trong chiến dịch CŨ không mang cờ ⇒ tra lại danh sách chuẩn
 * theo mã khu vực; khu vực tự khai không có trong danh sách ⇒ coi là KHÔNG có biển.
 */
export function areaIsCoastal(provinceKey: string, area: { code: string; coastal?: boolean }): boolean {
  if (typeof area.coastal === "boolean") return area.coastal;
  return PROVINCE_BY_KEY.get(provinceKey)?.areas.find((a) => a.code === area.code)?.coastal ?? false;
}

/** Hạng quét: 1 = tỉnh quét trước · 2 = không có biển · 3 = ven biển. HÀM THUẦN. */
export function scanTier(provinceKey: string, area: { code: string; coastal?: boolean }, p: ScanPriority): ScanTier {
  if (p.firstProvinces.includes(provinceKey)) return 1;
  if (!p.inlandBeforeCoastal) return 2;
  return areaIsCoastal(provinceKey, area) ? 3 : 2;
}

const TIER_STEP = 100_000;

/**
 * Độ ưu tiên của một ô trong hàng đợi chiến dịch (số lớn quét trước): HẠNG quyết định trước, kinh nghiệm từ khoá
 * (`keywordYield` ≥ 0, lead mới / lượt quét × 10) chỉ xếp thứ tự TRONG cùng một hạng — một từ khoá ra nhiều lead ở ven
 * biển không được vượt lên trước Hà Nội.
 */
export function cellScanPriority(tier: ScanTier, keywordYield: number): number {
  const y = Number.isFinite(keywordYield) ? Math.min(Math.max(Math.round(keywordYield), 0), TIER_STEP - 1) : 0;
  return (3 - tier) * TIER_STEP + y;
}

/** Hạng của cả TỈNH (để nhóm ô chọn trên form): hạng nhỏ nhất trong các khu vực của nó. */
export function provinceScanTier(p: SearchProvince, prio: ScanPriority): ScanTier {
  return p.areas.reduce<ScanTier>((min, a) => Math.min(min, scanTier(p.key, a, prio)) as ScanTier, 3);
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
      if (code && !prov.areas.some((a) => a.code === code)) prov.areas.push({ code, name, coastal: areaIsCoastal(key, { code }) });
    }
    out.set(key, prov);
  }
  return { provinces: [...out.values()], invalid };
}
