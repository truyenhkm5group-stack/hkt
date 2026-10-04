/**
 * ═══════════ PHÂN NHÓM KHÁCH SỈ TỪ LOẠI HÌNH ĐỊA ĐIỂM — HÀM THUẦN ═══════════
 *
 * Một địa điểm (Google Places `types` / `primaryType` + tên) ⇒ một NHÓM KHÁCH của HSLC. Nhóm là đầu vào
 * của điểm «phù hợp ngành» và «ý định mua» (`scoring.ts`), và là chiều so sánh ở bảng hiệu quả.
 *
 * Luật: chỉ đọc chứng cứ CÓ THẬT trong dữ liệu (mã loại hình của nguồn, chữ trong tên). Không có chứng
 * cứ nào khớp ⇒ `UNCLASSIFIED`, không đoán. `evidence` ghi lại chính chứng cứ đã dùng để lý do chấm
 * điểm in ra được, và người đọc kiểm lại được.
 *
 * Tệp THUẦN, client-safe.
 */

export const LEAD_SEGMENTS = [
  "SEAFOOD_RESTAURANT",
  "HOTPOT",
  "BBQ",
  "BUFFET",
  "CATERING",
  "PUB_BEER",
  "HOTEL_RESORT",
  "FROZEN_FOOD_STORE",
  "RESTAURANT",
  "SUPERMARKET",
  "OTHER_FOOD",
  "NOT_FIT",
  "UNCLASSIFIED",
] as const;
export type LeadSegment = (typeof LEAD_SEGMENTS)[number];

export function isLeadSegmentKey(v: unknown): v is LeadSegment {
  return typeof v === "string" && (LEAD_SEGMENTS as readonly string[]).includes(v);
}

export const LEAD_SEGMENT_LABEL: Record<LeadSegment, string> = {
  SEAFOOD_RESTAURANT: "Nhà hàng hải sản",
  HOTPOT: "Lẩu",
  BBQ: "Nướng / BBQ",
  BUFFET: "Buffet",
  CATERING: "Tiệc / suất ăn / bếp ăn",
  PUB_BEER: "Quán nhậu / bia",
  HOTEL_RESORT: "Khách sạn / resort",
  FROZEN_FOOD_STORE: "Cửa hàng thực phẩm đông lạnh",
  RESTAURANT: "Nhà hàng (chung)",
  SUPERMARKET: "Siêu thị / cửa hàng thực phẩm",
  OTHER_FOOD: "Ăn uống khác (cà phê, bánh, đồ ngọt…)",
  NOT_FIT: "Không phù hợp",
  UNCLASSIFIED: "Chưa phân loại",
};

/**
 * Hai điểm thành phần theo nhóm: `fit` (0–30) = khả năng cần nhập hải sản / thực phẩm THƯỜNG XUYÊN;
 * `intent` (0–15) = mức ưu tiên mua sỉ theo kinh nghiệm bán hàng của HSLC (hải sản / lẩu / nướng /
 * buffet / tiệc cao nhất). Đây là BẢNG CHẤM của chủ shop — sửa ở đây, có bài kiểm khoá trần.
 */
export const SEGMENT_POINTS: Record<LeadSegment, { fit: number; intent: number }> = {
  SEAFOOD_RESTAURANT: { fit: 30, intent: 15 },
  BUFFET: { fit: 28, intent: 15 },
  HOTPOT: { fit: 27, intent: 14 },
  CATERING: { fit: 26, intent: 14 },
  BBQ: { fit: 25, intent: 13 },
  FROZEN_FOOD_STORE: { fit: 24, intent: 12 },
  PUB_BEER: { fit: 22, intent: 10 },
  HOTEL_RESORT: { fit: 18, intent: 9 },
  RESTAURANT: { fit: 16, intent: 7 },
  SUPERMARKET: { fit: 15, intent: 6 },
  OTHER_FOOD: { fit: 4, intent: 0 },
  NOT_FIT: { fit: 0, intent: 0 },
  UNCLASSIFIED: { fit: 6, intent: 2 },
};

/** Mã loại hình Google Places (Table A) ⇒ nhóm. Thứ tự ưu tiên xử lý ở `classifySegment`. */
const TYPE_SEGMENT: Record<string, LeadSegment> = {
  seafood_restaurant: "SEAFOOD_RESTAURANT",
  buffet_restaurant: "BUFFET",
  barbecue_restaurant: "BBQ",
  korean_barbecue_restaurant: "BBQ",
  catering_service: "CATERING",
  banquet_hall: "CATERING",
  wedding_venue: "CATERING",
  event_venue: "CATERING",
  bar: "PUB_BEER",
  pub: "PUB_BEER",
  beer_garden: "PUB_BEER",
  brewery: "PUB_BEER",
  bar_and_grill: "PUB_BEER",
  hotel: "HOTEL_RESORT",
  resort_hotel: "HOTEL_RESORT",
  lodging: "HOTEL_RESORT",
  motel: "HOTEL_RESORT",
  inn: "HOTEL_RESORT",
  supermarket: "SUPERMARKET",
  grocery_store: "SUPERMARKET",
  food_store: "SUPERMARKET",
  market: "SUPERMARKET",
  asian_grocery_store: "SUPERMARKET",
  convenience_store: "SUPERMARKET",
  restaurant: "RESTAURANT",
  vietnamese_restaurant: "RESTAURANT",
  chinese_restaurant: "RESTAURANT",
  japanese_restaurant: "RESTAURANT",
  korean_restaurant: "RESTAURANT",
  thai_restaurant: "RESTAURANT",
  sushi_restaurant: "RESTAURANT",
  steak_house: "RESTAURANT",
  fine_dining_restaurant: "RESTAURANT",
  asian_restaurant: "RESTAURANT",
  family_restaurant: "RESTAURANT",
  food_court: "RESTAURANT",
  meal_takeaway: "RESTAURANT",
  meal_delivery: "RESTAURANT",
  cafe: "OTHER_FOOD",
  coffee_shop: "OTHER_FOOD",
  tea_house: "OTHER_FOOD",
  bakery: "OTHER_FOOD",
  dessert_shop: "OTHER_FOOD",
  ice_cream_shop: "OTHER_FOOD",
  juice_shop: "OTHER_FOOD",
  donut_shop: "OTHER_FOOD",
  confectionery: "OTHER_FOOD",
  fast_food_restaurant: "OTHER_FOOD",
};

/** Từ khoá trong TÊN (đã bỏ dấu, chữ thường) ⇒ nhóm. Tên nói rõ hơn mã loại hình chung chung. */
/**
 * Từ khoá CÓ DẤU khớp trên tên CÓ DẤU — bỏ dấu thì «lẩu» trùng «lâu», «ốc» trùng «óc», «nhậu» trùng «nhau», nên chữ
 * mơ hồ khi bỏ dấu KHÔNG được khớp trên chuỗi đã bỏ dấu (tên viết không dấu «Lau De 404» thì không nhận — không đoán).
 * Từ khoá KHÔNG dấu (vd «hai san», «buffet») khớp trên chuỗi đã bỏ dấu, nên tên có / không dấu đều nhận.
 */
const NAME_RULES: { segment: LeadSegment; words: string[] }[] = [
  { segment: "SEAFOOD_RESTAURANT", words: ["hai san", "seafood", "ốc", "tom hum", "cua ghe"] },
  { segment: "BUFFET", words: ["buffet"] },
  { segment: "HOTPOT", words: ["lẩu", "hotpot", "hot pot"] },
  { segment: "BBQ", words: ["nuong", "bbq", "barbecue", "grill"] },
  { segment: "CATERING", words: ["tiệc", "catering", "suat an", "bep an", "com cong nghiep", "nấu cỗ"] },
  { segment: "FROZEN_FOOD_STORE", words: ["dong lanh", "frozen", "thuc pham sach", "thuc pham tuoi", "kho lanh"] },
  { segment: "PUB_BEER", words: ["quán nhậu", "nhậu", "beer", "bia hơi", "pub"] },
  { segment: "HOTEL_RESORT", words: ["resort", "hotel", "khach san"] },
  { segment: "SUPERMARKET", words: ["sieu thi", "mart", "minimart", "bach hoa"] },
];

/** Chữ thường, NFC, mọi ký tự không phải chữ / số thành khoảng trắng — giữ nguyên DẤU. */
function lowerKeepMarks(raw: string | null | undefined): string {
  if (!raw) return "";
  return ` ${raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function hasMarks(word: string): boolean {
  return foldVietnamese(word).trim() !== word.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Bỏ dấu, chữ thường, gộp khoảng trắng, thêm khoảng trắng hai đầu để khớp từ ở cuối chuỗi. */
export function foldVietnamese(raw: string | null | undefined): string {
  if (!raw) return "";
  return ` ${raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

export type SegmentInput = { name?: string | null; primaryType?: string | null; types?: readonly string[] | null };
export type SegmentResult = { segment: LeadSegment; evidence: string };

/**
 * Thứ tự: (1) tên chứa từ khoá ngành CỤ THỂ (hải sản, buffet, lẩu, nướng…) — chủ quán gọi tên
 * đúng thứ họ bán, còn mã loại hình thường chỉ là `restaurant`; (2) `primaryType`; (3) các `types`
 * còn lại theo nhóm có điểm cao nhất. Không khớp gì ⇒ `UNCLASSIFIED`.
 */
export function classifySegment(input: SegmentInput): SegmentResult {
  const folded = foldVietnamese(input.name);
  const marked = lowerKeepMarks(input.name);
  for (const rule of NAME_RULES) {
    // Khớp theo RANH GIỚI TỪ. Có dấu ⇒ khớp trên tên có dấu (« lẩu » khớp «Lẩu Dê 404», KHÔNG khớp «Lâu Đài»).
    const hit = rule.words.find((w) => (hasMarks(w) ? marked.includes(` ${lowerKeepMarks(w).trim()} `) : folded.includes(` ${foldVietnamese(w).trim()} `)));
    if (hit) return { segment: rule.segment, evidence: `tên có «${hit}»` };
  }
  const primary = input.primaryType ? TYPE_SEGMENT[input.primaryType] : undefined;
  if (primary) return { segment: primary, evidence: `loại hình chính «${input.primaryType}»` };
  let best: { segment: LeadSegment; type: string } | null = null;
  for (const t of input.types ?? []) {
    const seg = TYPE_SEGMENT[t];
    if (!seg) continue;
    if (!best || SEGMENT_POINTS[seg].fit > SEGMENT_POINTS[best.segment].fit) best = { segment: seg, type: t };
  }
  if (best) return { segment: best.segment, evidence: `loại hình «${best.type}»` };
  return { segment: "UNCLASSIFIED", evidence: "không có loại hình / từ khoá nhận ra được" };
}
