import { normalizeProvince } from "@/lib/constants/vn-regions";
import type { SearchArea, SearchLocale, SearchProvince } from "@/lib/wholesale/areas";
import { foldVietnamese } from "@/lib/wholesale/segments";

/**
 * ═══════════ KHU VỰC QUÉT QUỐC TẾ — NƯỚC × THÀNH PHỐ TRỌNG ĐIỂM ═══════════
 *
 * Chủ shop chốt 27/10/2026: tìm khách sỉ cả NƯỚC NGOÀI bằng đúng bộ quét Google Places đang chạy cho 34 tỉnh. Cùng cấu
 * trúc `SearchProvince` với `areas.ts` — «tỉnh» là NƯỚC, «khu vực» là THÀNH PHỐ — nên kế hoạch ô, hàng đợi, trần chi tiêu,
 * khử trùng và chấm điểm đi nguyên một đường, không có lõi thứ hai.
 *
 * ─── KHOÁ KHÔNG ĐỤNG Ô TRONG NƯỚC ───
 *
 * Khoá nước = `intl <mã ISO-3166 hai chữ thường>` (vd `intl jp`). Không tỉnh VN nào (khoá `normalizeProvince`, vd `ha noi`)
 * bắt đầu bằng `intl `, và `cellKeyOf` ghép khoá tỉnh vào khoá ô ⇒ ô «seafood importer × Tokyo» KHÔNG BAO GIỜ trùng một ô
 * trong nước, kể cả khi trùng từ khoá. `normalizeProvince(khoá)` trả lại đúng khoá (đã có bài kiểm), nên engine so tỉnh
 * của lead với tỉnh của ô vẫn đúng.
 *
 * ─── NGÔN NGỮ / VÙNG ───
 *
 *  · `regionCode` = mã CLDR của nước — Places API (New) thiên vị kết quả theo vùng.
 *  · `languageCode` = `en` cho MỌI nước: đây là ngôn ngữ của KẾT QUẢ (tên, địa chỉ) — nhân viên HSLC đọc tiếng Anh được,
 *    đọc tiếng Nhật / Hàn / Thái thì không. Từ khoá bản địa vẫn đi trong `textQuery`, Google hiểu mọi ngôn ngữ.
 *  · `keywordLangs` = ngôn ngữ từ khoá áp cho nước đó: luôn có `en`; thêm `ja` / `ko` / `zh-Hant` / `de` / `fr` ở nước
 *    dùng tiếng ấy. Từ khoá bản địa chỉ khai khi chắc nghĩa (keywords-intl.ts).
 *
 * ─── TOẠ ĐỘ ───
 *
 * Mỗi thành phố có tâm (độ thập phân, làm tròn tới ~1 km) + bán kính để engine gửi `locationBias` — chỉ THIÊN VỊ, không
 * giới hạn cứng, nên toạ độ lệch vài km không làm mất kết quả. Tên thành phố vẫn nằm trong câu tìm như ô trong nước.
 * Thành phố Mỹ mang tên bang khi tên dễ nhầm («Westminster» có ở cả London lẫn California).
 *
 * Tệp THUẦN, client-safe.
 */

export const INTL_KEY_PREFIX = "intl ";

/** `true` ⇒ khoá tỉnh là một NƯỚC (quét quốc tế). Khoá chuẩn hoá hay chưa đều nhận. */
export function isIntlProvinceKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.trim().toLowerCase().startsWith(INTL_KEY_PREFIX);
}

type City = { name: string; lat: number; lng: number; radiusM?: number };
type Country = {
  /** ISO-3166 alpha-2 — cũng là `regionCode` của Places API. */
  iso2: string;
  label: string;
  /** Tên nước trong câu tìm (tiếng Anh). */
  queryName: string;
  /** Tên khác người dùng hay gõ ở ô «Khu vực tự khai». */
  aliases: string[];
  nativeLangs: string[];
  cities: City[];
};

const DEFAULT_RADIUS_M = 30_000;

const COUNTRIES: readonly Country[] = [
  { iso2: "SG", label: "Singapore", queryName: "Singapore", aliases: ["sing", "sin"], nativeLangs: [], cities: [{ name: "Singapore", lat: 1.3521, lng: 103.8198, radiusM: 25_000 }] },
  {
    iso2: "MY",
    label: "Malaysia",
    queryName: "Malaysia",
    aliases: ["ma lai", "malay"],
    nativeLangs: [],
    cities: [
      { name: "Kuala Lumpur", lat: 3.139, lng: 101.6869 },
      { name: "Klang", lat: 3.0449, lng: 101.4455 },
      { name: "George Town Penang", lat: 5.4141, lng: 100.3288 },
      { name: "Johor Bahru", lat: 1.4927, lng: 103.7414 },
    ],
  },
  {
    iso2: "TH",
    label: "Thái Lan",
    queryName: "Thailand",
    aliases: ["thai lan", "thai"],
    nativeLangs: [],
    cities: [
      { name: "Bangkok", lat: 13.7563, lng: 100.5018 },
      { name: "Samut Sakhon", lat: 13.5475, lng: 100.2744 },
      { name: "Chiang Mai", lat: 18.7883, lng: 98.9853 },
      { name: "Pattaya", lat: 12.9236, lng: 100.8825 },
    ],
  },
  {
    iso2: "JP",
    label: "Nhật Bản",
    queryName: "Japan",
    aliases: ["nhat", "nhat ban"],
    nativeLangs: ["ja"],
    cities: [
      { name: "Tokyo", lat: 35.6762, lng: 139.6503 },
      { name: "Osaka", lat: 34.6937, lng: 135.5023 },
      { name: "Yokohama", lat: 35.4437, lng: 139.638 },
      { name: "Nagoya", lat: 35.1815, lng: 136.9066 },
      { name: "Fukuoka", lat: 33.5904, lng: 130.4017 },
    ],
  },
  {
    iso2: "KR",
    label: "Hàn Quốc",
    queryName: "South Korea",
    aliases: ["han quoc", "korea", "han"],
    nativeLangs: ["ko"],
    cities: [
      { name: "Seoul", lat: 37.5665, lng: 126.978 },
      { name: "Busan", lat: 35.1796, lng: 129.0756 },
      { name: "Incheon", lat: 37.4563, lng: 126.7052 },
      { name: "Daegu", lat: 35.8714, lng: 128.6014 },
    ],
  },
  {
    iso2: "TW",
    label: "Đài Loan",
    queryName: "Taiwan",
    aliases: ["dai loan"],
    nativeLangs: ["zh-Hant"],
    cities: [
      { name: "Taipei", lat: 25.033, lng: 121.5654 },
      { name: "New Taipei", lat: 25.012, lng: 121.4657 },
      { name: "Taichung", lat: 24.1477, lng: 120.6736 },
      { name: "Kaohsiung", lat: 22.6273, lng: 120.3014 },
      { name: "Tainan", lat: 22.9999, lng: 120.227 },
    ],
  },
  {
    iso2: "HK",
    label: "Hồng Kông",
    queryName: "Hong Kong",
    aliases: ["hong kong", "huong cang"],
    nativeLangs: ["zh-Hant"],
    cities: [
      { name: "Hong Kong Island", lat: 22.2783, lng: 114.1747, radiusM: 10_000 },
      { name: "Kowloon", lat: 22.3193, lng: 114.1694, radiusM: 10_000 },
      { name: "New Territories", lat: 22.45, lng: 114.1667, radiusM: 20_000 },
    ],
  },
  {
    iso2: "AU",
    label: "Úc",
    queryName: "Australia",
    aliases: ["uc", "australia", "oxtraylia"],
    nativeLangs: [],
    cities: [
      { name: "Sydney", lat: -33.8688, lng: 151.2093 },
      { name: "Melbourne", lat: -37.8136, lng: 144.9631 },
      { name: "Brisbane", lat: -27.4698, lng: 153.0251 },
      { name: "Perth", lat: -31.9505, lng: 115.8605 },
      { name: "Adelaide", lat: -34.9285, lng: 138.6007 },
    ],
  },
  {
    iso2: "US",
    label: "Mỹ",
    queryName: "USA",
    aliases: ["my", "hoa ky", "united states", "usa"],
    nativeLangs: [],
    cities: [
      { name: "Los Angeles", lat: 34.0522, lng: -118.2437 },
      { name: "Westminster California", lat: 33.7513, lng: -117.994, radiusM: 15_000 },
      { name: "San Jose California", lat: 37.3382, lng: -121.8863 },
      { name: "Houston", lat: 29.7604, lng: -95.3698 },
      { name: "Dallas", lat: 32.7767, lng: -96.797 },
      { name: "Seattle", lat: 47.6062, lng: -122.3321 },
      { name: "New York", lat: 40.7128, lng: -74.006 },
      { name: "Chicago", lat: 41.8781, lng: -87.6298 },
      { name: "Atlanta", lat: 33.749, lng: -84.388 },
    ],
  },
  {
    iso2: "CA",
    label: "Canada",
    queryName: "Canada",
    aliases: ["ca na da"],
    nativeLangs: [],
    cities: [
      { name: "Toronto", lat: 43.6532, lng: -79.3832 },
      { name: "Vancouver", lat: 49.2827, lng: -123.1207 },
      { name: "Montreal", lat: 45.5017, lng: -73.5673 },
      { name: "Calgary", lat: 51.0447, lng: -114.0719 },
    ],
  },
  {
    iso2: "GB",
    label: "Anh",
    queryName: "United Kingdom",
    aliases: ["anh quoc", "uk", "united kingdom", "england"],
    nativeLangs: [],
    cities: [
      { name: "London", lat: 51.5074, lng: -0.1278 },
      { name: "Birmingham", lat: 52.4862, lng: -1.8904 },
      { name: "Manchester", lat: 53.4808, lng: -2.2426 },
      { name: "Leeds", lat: 53.8008, lng: -1.5491 },
    ],
  },
  {
    iso2: "DE",
    label: "Đức",
    queryName: "Germany",
    aliases: ["duc", "germany", "deutschland"],
    nativeLangs: ["de"],
    cities: [
      { name: "Berlin", lat: 52.52, lng: 13.405 },
      { name: "Hamburg", lat: 53.5511, lng: 9.9937 },
      { name: "Frankfurt", lat: 50.1109, lng: 8.6821 },
      { name: "Munich", lat: 48.1351, lng: 11.582 },
      { name: "Leipzig", lat: 51.3397, lng: 12.3731 },
    ],
  },
  {
    iso2: "FR",
    label: "Pháp",
    queryName: "France",
    aliases: ["phap", "france"],
    nativeLangs: ["fr"],
    cities: [
      { name: "Paris", lat: 48.8566, lng: 2.3522 },
      { name: "Rungis", lat: 48.747, lng: 2.349, radiusM: 10_000 },
      { name: "Marseille", lat: 43.2965, lng: 5.3698 },
      { name: "Lyon", lat: 45.764, lng: 4.8357 },
    ],
  },
  {
    iso2: "NL",
    label: "Hà Lan",
    queryName: "Netherlands",
    aliases: ["ha lan", "netherlands", "holland"],
    nativeLangs: [],
    cities: [
      { name: "Amsterdam", lat: 52.3676, lng: 4.9041 },
      { name: "Rotterdam", lat: 51.9244, lng: 4.4777 },
      { name: "The Hague", lat: 52.0705, lng: 4.3007 },
    ],
  },
  {
    iso2: "AE",
    label: "UAE (Các Tiểu vương quốc Ả Rập)",
    queryName: "United Arab Emirates",
    aliases: ["uae", "a rap", "dubai", "tieu vuong quoc a rap thong nhat"],
    nativeLangs: [],
    cities: [
      { name: "Dubai", lat: 25.2048, lng: 55.2708 },
      { name: "Abu Dhabi", lat: 24.4539, lng: 54.3773 },
      { name: "Sharjah", lat: 25.3463, lng: 55.4209 },
    ],
  },
];

/** Cùng công thức `areaCode` của areas.ts (bỏ dấu, gạch nối) — viết lại ở đây để không có vòng import. */
function cityCode(name: string): string {
  return foldVietnamese(name).trim().replace(/\s+/g, "-").slice(0, 60);
}

function toProvince(c: Country): SearchProvince {
  const locale: SearchLocale = { languageCode: "en", regionCode: c.iso2, keywordLangs: ["en", ...c.nativeLangs] };
  const areas: SearchArea[] = c.cities.map((x) => ({ code: cityCode(x.name), name: x.name, coastal: false, center: { lat: x.lat, lng: x.lng, radiusM: x.radiusM ?? DEFAULT_RADIUS_M } }));
  return { key: `${INTL_KEY_PREFIX}${c.iso2.toLowerCase()}`, label: c.label, queryName: c.queryName, areas, locale };
}

/** 15 nước, mỗi nước là một «tỉnh» theo cấu trúc của areas.ts. */
export const INTL_SEARCH_PROVINCES: readonly SearchProvince[] = COUNTRIES.map(toProvince);

const INTL_BY_KEY = new Map(INTL_SEARCH_PROVINCES.map((p) => [p.key, p]));

export function intlSearchProvince(key: string | null | undefined): SearchProvince | null {
  if (!key) return null;
  return INTL_BY_KEY.get(key.trim().toLowerCase().replace(/\s+/g, " ")) ?? null;
}

const NAME_INDEX: Map<string, SearchProvince> = (() => {
  const m = new Map<string, SearchProvince>();
  COUNTRIES.forEach((c, i) => {
    const p = INTL_SEARCH_PROVINCES[i]!;
    for (const n of [c.label, c.queryName, ...c.aliases]) m.set(normalizeProvince(n), p);
  });
  return m;
})();

/** Ô «Khu vực tự khai»: «Nhật Bản» / «Japan» / «nhat» ⇒ nước tương ứng; không nhận ra ⇒ `null` (không đoán). */
export function intlCountryByName(raw: string | null | undefined): SearchProvince | null {
  const k = normalizeProvince(raw);
  return k ? (NAME_INDEX.get(k) ?? null) : null;
}

export type IntlCellContext = { languageCode: string; regionCode: string; bias: { lat: number; lng: number; radiusM: number } | null };

/**
 * Ngữ cảnh gửi kèm lượt tìm cho một ô: ô trong nước ⇒ `null` (client gửi `vi` / `VN`, không thiên vị — y như trước).
 * Ô quốc tế ⇒ ngôn ngữ / vùng của nước, và tâm thiên vị nếu thành phố có trong danh sách chuẩn (khu vực tự khai thì không).
 * HÀM THUẦN — engine gọi lúc quét, đọc từ khoá tỉnh + mã khu vực đã lưu trong `wholesale_search_cells`.
 */
export function intlCellContext(provinceKey: string | null | undefined, areaCode: string | null | undefined): IntlCellContext | null {
  const p = intlSearchProvince(provinceKey);
  if (!p?.locale) return null;
  const center = p.areas.find((a) => a.code === areaCode)?.center ?? null;
  return { languageCode: p.locale.languageCode, regionCode: p.locale.regionCode, bias: center };
}
