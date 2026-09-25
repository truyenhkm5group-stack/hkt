/**
 * ═══════════ TỈNH → VÙNG → MIỀN ═══════════
 *
 * Chủ shop yêu cầu (25/09/2026): xem tỷ lệ giao thành công theo VÙNG, MIỀN của khách để biết địa lý
 * ảnh hưởng thế nào tới GTC. ERP chỉ có `orders.ship_province` — CHỮ Pancake gửi, không có mã tỉnh.
 * Tệp này là bản khai DUY NHẤT để quy chữ đó về vùng / miền.
 *
 * ─── HAI THẾ HỆ TÊN TỈNH CÙNG TỒN TẠI ───
 *
 * Từ 01/07/2025 cả nước còn 34 tỉnh/thành. Địa chỉ khách cũ lưu ở Pancake vẫn mang tên của 63 tỉnh
 * trước sáp nhập, địa chỉ mới mang tên sau sáp nhập. Nên bảng nhận CẢ HAI: tên cũ (Hà Giang, Bình
 * Định…) về đúng vùng của nó; tên mới trùng tên một tỉnh cũ (Gia Lai, Tây Ninh…) thì không phân biệt
 * được đó là địa chỉ cũ hay địa chỉ mới.
 *
 * ─── MIỀN LÀ CHÍNH XÁC, VÙNG CÓ CHỖ GẦN ĐÚNG ───
 *
 * Mọi lượt sáp nhập 2025 đều gộp các tỉnh CÙNG MIỀN ⇒ quy về Bắc / Trung / Nam luôn đúng.
 * Nhưng bảy tỉnh mới gộp qua HAI VÙNG (6 vùng kinh tế – xã hội theo cách chia trước sáp nhập):
 *
 *   Phú Thọ   (+ Vĩnh Phúc — ĐB sông Hồng)      Bắc Ninh  (+ Bắc Giang — Trung du miền núi phía Bắc)
 *   Quảng Ngãi (+ Kon Tum — Tây Nguyên)          Gia Lai   (+ Bình Định — Duyên hải miền Trung)
 *   Đắk Lắk   (+ Phú Yên — Duyên hải miền Trung) Lâm Đồng  (+ Bình Thuận — Duyên hải miền Trung)
 *   Tây Ninh  (+ Long An — ĐB sông Cửu Long)
 *
 * Chữ "Gia Lai" không cho biết khách ở Pleiku hay Quy Nhơn. Tệp này xếp theo vùng của TỈNH CŨ CÙNG
 * TÊN và gắn cờ `approxRegion` — màn hình phải đếm và in số đơn rơi vào nhóm này cạnh bảng theo vùng,
 * không được giấu. Bảng theo TỈNH luôn in đúng chữ gốc, nên người đọc vẫn tách được khi cần.
 *
 * Chữ không nhận ra được ⇒ `null` — CHƯA RÕ VÙNG, không phải một vùng nào đó (AGENTS.md mục 42).
 * Không đoán theo huyện / xã: địa chỉ mới hai cấp không còn huyện, và tên xã trùng nhau khắp nước.
 */

export const MIEN = ["BAC", "TRUNG", "NAM"] as const;
export type Mien = (typeof MIEN)[number];

export const MIEN_LABEL: Record<Mien, string> = {
  BAC: "Miền Bắc",
  TRUNG: "Miền Trung",
  NAM: "Miền Nam",
};

/** 6 vùng kinh tế – xã hội (cách chia của Tổng cục Thống kê trước sáp nhập 2025). */
export const VUNG = ["TDMNPB", "DBSH", "BTB_DHMT", "TAY_NGUYEN", "DNB", "DBSCL"] as const;
export type Vung = (typeof VUNG)[number];

export const VUNG_LABEL: Record<Vung, string> = {
  TDMNPB: "Trung du & miền núi phía Bắc",
  DBSH: "Đồng bằng sông Hồng",
  BTB_DHMT: "Bắc Trung Bộ & Duyên hải miền Trung",
  TAY_NGUYEN: "Tây Nguyên",
  DNB: "Đông Nam Bộ",
  DBSCL: "Đồng bằng sông Cửu Long",
};

export const VUNG_MIEN: Record<Vung, Mien> = {
  TDMNPB: "BAC",
  DBSH: "BAC",
  BTB_DHMT: "TRUNG",
  TAY_NGUYEN: "TRUNG",
  DNB: "NAM",
  DBSCL: "NAM",
};

/**
 * Tên chuẩn (không dấu, chữ thường) → vùng. Mỗi tên xuất hiện ĐÚNG MỘT lần; bài kiểm khoá điều đó
 * và khoá đủ 63 tỉnh cũ.
 */
const PROVINCES: Record<Vung, string[]> = {
  TDMNPB: ["ha giang", "cao bang", "bac kan", "tuyen quang", "lao cai", "yen bai", "thai nguyen", "lang son", "bac giang", "phu tho", "dien bien", "lai chau", "son la", "hoa binh"],
  DBSH: ["ha noi", "vinh phuc", "bac ninh", "quang ninh", "hai duong", "hai phong", "hung yen", "thai binh", "ha nam", "nam dinh", "ninh binh"],
  BTB_DHMT: ["thanh hoa", "nghe an", "ha tinh", "quang binh", "quang tri", "hue", "da nang", "quang nam", "quang ngai", "binh dinh", "phu yen", "khanh hoa", "ninh thuan", "binh thuan"],
  TAY_NGUYEN: ["kon tum", "gia lai", "dak lak", "dak nong", "lam dong"],
  DNB: ["binh phuoc", "tay ninh", "binh duong", "dong nai", "ba ria vung tau", "ho chi minh"],
  DBSCL: ["long an", "tien giang", "ben tre", "tra vinh", "vinh long", "dong thap", "an giang", "kien giang", "can tho", "hau giang", "soc trang", "bac lieu", "ca mau"],
};

/** Tên mới sau 01/07/2025 mà địa bàn trải qua HAI vùng — xem đầu tệp. */
export const APPROX_REGION_PROVINCES: readonly string[] = ["phu tho", "bac ninh", "quang ngai", "gia lai", "dak lak", "lam dong", "tay ninh"];

/** Cách viết khác của cùng một tỉnh → tên chuẩn. */
const ALIASES: Record<string, string> = {
  "thua thien hue": "hue",
  "thua thien": "hue",
  "ba ria": "ba ria vung tau",
  "vung tau": "ba ria vung tau",
  "brvt": "ba ria vung tau",
  "hcm": "ho chi minh",
  "tphcm": "ho chi minh",
  "tp hcm": "ho chi minh",
  "sai gon": "ho chi minh",
  "dac lac": "dak lak",
  "daklak": "dak lak",
  "dak lac": "dak lak",
  "dac nong": "dak nong",
  "daknong": "dak nong",
  "kontum": "kon tum",
  "hanoi": "ha noi",
  "danang": "da nang",
  "haiphong": "hai phong",
  "cantho": "can tho",
};

const INDEX: Map<string, Vung> = (() => {
  const m = new Map<string, Vung>();
  for (const vung of VUNG) for (const name of PROVINCES[vung]) m.set(name, vung);
  return m;
})();

/** Chữ tỉnh → khoá chuẩn: bỏ dấu, bỏ tiền tố "Tỉnh" / "Thành phố" / "TP.", gộp khoảng trắng. */
export function normalizeProvince(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[.,\-–_/()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(tinh|thanh pho|tp)\s+/, "").trim();
  return ALIASES[s] ?? s;
}

export type ProvinceRegion = {
  /** Khoá chuẩn — dùng để gộp nhiều cách viết của cùng một tỉnh. */
  key: string;
  vung: Vung;
  mien: Mien;
  /** Tên mới 2025 trải qua hai vùng: vùng là GẦN ĐÚNG (miền vẫn đúng). */
  approxRegion: boolean;
};

/** `null` = CHƯA RÕ VÙNG (trống hoặc chữ không nhận ra) — không bao giờ đoán. */
export function provinceRegion(raw: string | null | undefined): ProvinceRegion | null {
  const key = normalizeProvince(raw);
  if (!key) return null;
  const vung = INDEX.get(key);
  if (!vung) return null;
  return { key, vung, mien: VUNG_MIEN[vung], approxRegion: APPROX_REGION_PROVINCES.includes(key) };
}

/** Để bài kiểm đếm được: đủ 63 tỉnh cũ, không tên nào khai hai lần. */
export function provinceCatalog(): { vung: Vung; names: string[] }[] {
  return VUNG.map((vung) => ({ vung, names: [...PROVINCES[vung]] }));
}
