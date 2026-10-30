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
  "SPECIALTY_STORE",
  "MOM_BABY",
  "GROCERY",
  "EATERY",
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
  // ── Khách sỉ B2B / quốc tế (27/10/2026) — THÊM vào cuối, khoá cũ giữ nguyên vì `wholesale_leads.segment` đã lưu chúng. ──
  "SEAFOOD_IMPORTER",
  "ASIAN_FOOD_WHOLESALE",
  "FOODSERVICE_DISTRIBUTOR",
  "PRIVATE_LABEL_OEM",
  // ── Khách sỉ Việt Kiều (30/10/2026) — chỉ ô quốc tế, xem `VIET_RULE`. ──
  "VIET_DIASPORA_GROCERY",
  "VIET_FOOD_DISTRIBUTOR",
] as const;
export type LeadSegment = (typeof LEAD_SEGMENTS)[number];

export function isLeadSegmentKey(v: unknown): v is LeadSegment {
  return typeof v === "string" && (LEAD_SEGMENTS as readonly string[]).includes(v);
}

export const LEAD_SEGMENT_LABEL: Record<LeadSegment, string> = {
  SPECIALTY_STORE: "Cửa hàng đặc sản / đồ khô / quà biếu",
  MOM_BABY: "Cửa hàng mẹ & bé",
  GROCERY: "Tạp hoá / cửa hàng thực phẩm nhỏ",
  EATERY: "Quán ăn / quán cơm / bún chả cá",
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
  SEAFOOD_IMPORTER: "Nhập khẩu / bán sỉ hải sản (B2B)",
  ASIAN_FOOD_WHOLESALE: "Bán sỉ / nhập khẩu thực phẩm châu Á (B2B)",
  FOODSERVICE_DISTRIBUTOR: "Nhà cung cấp HORECA / phân phối thực phẩm (B2B)",
  PRIVATE_LABEL_OEM: "Nhãn riêng / OEM thực phẩm (B2B)",
  VIET_DIASPORA_GROCERY: "Cửa hàng / siêu thị / chợ Việt ở nước ngoài (Việt Kiều)",
  VIET_FOOD_DISTRIBUTOR: "Nhà phân phối / bán sỉ thực phẩm Việt ở nước ngoài (Việt Kiều)",
};

/**
 * Hai điểm thành phần theo nhóm: `fit` (0–30) = khả năng bán lại / dùng hàng của HSLC (chả mực, chả cá, nem hải sản,
 * ruốc, nước mắm — đặc sản đóng gói); `intent` (0–15) = khả năng mua sỉ KHÔNG cần hoá đơn VAT lúc này. Chủ shop chốt
 * 05/10/2026: ưu tiên cửa hàng / quán vừa và nhỏ; chuỗi, khách sạn, tiệc, buffet thường đòi hoá đơn nên xuống cuối.
 * Đây là BẢNG CHẤM của chủ shop — sửa ở đây, có bài kiểm khoá trần.
 */
export const SEGMENT_POINTS: Record<LeadSegment, { fit: number; intent: number }> = {
  SPECIALTY_STORE: { fit: 30, intent: 15 },
  SEAFOOD_RESTAURANT: { fit: 28, intent: 13 },
  FROZEN_FOOD_STORE: { fit: 27, intent: 13 },
  PUB_BEER: { fit: 24, intent: 12 },
  MOM_BABY: { fit: 22, intent: 11 },
  GROCERY: { fit: 22, intent: 10 },
  EATERY: { fit: 22, intent: 10 },
  HOTPOT: { fit: 20, intent: 9 },
  BBQ: { fit: 16, intent: 7 },
  RESTAURANT: { fit: 16, intent: 7 },
  BUFFET: { fit: 12, intent: 4 },
  SUPERMARKET: { fit: 12, intent: 4 },
  CATERING: { fit: 10, intent: 3 },
  HOTEL_RESORT: { fit: 6, intent: 2 },
  OTHER_FOOD: { fit: 4, intent: 0 },
  NOT_FIT: { fit: 0, intent: 0 },
  UNCLASSIFIED: { fit: 6, intent: 2 },
  // B2B / quốc tế: nhà nhập khẩu hải sản và nhà bán sỉ thực phẩm châu Á là người MUA LẠI đúng mặt hàng HSLC (đặc sản đóng
  // gói) ⇒ phù hợp ngành gần trần. Ý định mua để dưới nhóm bán lẻ trong nước vì mua xuyên biên giới đòi chứng từ xuất khẩu
  // HSLC chưa có sẵn. Phân phối HORECA / nhãn riêng mua theo hợp đồng ⇒ thấp hơn. Chuỗi nhà hàng / siêu thị nước ngoài
  // KHÔNG có khoá riêng: đi vào RESTAURANT / SUPERMARKET sẵn có (chuỗi nhận ra bằng số điểm cùng thương hiệu, không bằng chữ).
  SEAFOOD_IMPORTER: { fit: 28, intent: 11 },
  ASIAN_FOOD_WHOLESALE: { fit: 27, intent: 11 },
  FOODSERVICE_DISTRIBUTOR: { fit: 20, intent: 8 },
  PRIVATE_LABEL_OEM: { fit: 18, intent: 7 },
  // Việt Kiều (chủ shop 30/10/2026): cửa hàng / chợ Việt ở nước ngoài bán lại ĐÚNG đặc sản Việt đóng gói (chả mực, ruốc,
  // nước mắm) cho cộng đồng người Việt — như cửa hàng đặc sản trong nước nhưng mua xuyên biên giới (cần chứng từ xuất
  // khẩu) nên ý định mua để dưới trần. Nhà phân phối thực phẩm Việt mua theo lô lớn hơn, cùng mặt hàng.
  VIET_DIASPORA_GROCERY: { fit: 30, intent: 12 },
  VIET_FOOD_DISTRIBUTOR: { fit: 29, intent: 12 },
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
  hypermarket: "SUPERMARKET",
  grocery_store: "GROCERY",
  food_store: "GROCERY",
  market: "GROCERY",
  asian_grocery_store: "GROCERY",
  convenience_store: "GROCERY",
  butcher_shop: "FROZEN_FOOD_STORE",
  health_food_store: "FROZEN_FOOD_STORE",
  gift_shop: "SPECIALTY_STORE",
  baby_store: "MOM_BABY",
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

/**
 * Loại hình chỉ đọc ở ô QUỐC TẾ (`classifySegment(…, { b2b: true })`). «wholesaler» của Google (Table A) không nói bán sỉ GÌ —
 * chiến dịch tìm bằng từ khoá thực phẩm nên xếp vào nhóm phân phối thực phẩm chung (điểm vừa), không xếp vào nhập khẩu hải
 * sản (điểm cao) khi tên không nói thế. Ô trong nước KHÔNG đọc bảng này: hành vi trong nước giữ y như trước 27/10/2026.
 */
const B2B_TYPE_SEGMENT: Record<string, LeadSegment> = {
  wholesaler: "FOODSERVICE_DISTRIBUTOR",
};

/** Từ khoá trong TÊN (đã bỏ dấu, chữ thường) ⇒ nhóm. Tên nói rõ hơn mã loại hình chung chung. */
/**
 * Từ khoá CÓ DẤU khớp trên tên CÓ DẤU — bỏ dấu thì «lẩu» trùng «lâu», «ốc» trùng «óc», «nhậu» trùng «nhau», nên chữ
 * mơ hồ khi bỏ dấu KHÔNG được khớp trên chuỗi đã bỏ dấu (tên viết không dấu «Lau De 404» thì không nhận — không đoán).
 * Từ khoá KHÔNG dấu (vd «hai san», «buffet») khớp trên chuỗi đã bỏ dấu, nên tên có / không dấu đều nhận.
 */
/**
 * Luật B2B / quốc tế — CHỈ áp cho ô quốc tế (`{ b2b: true }`), và ở đó ĐỨNG TRƯỚC mọi luật khác: «Ocean Seafood Trading» là nhà
 * buôn, không phải nhà hàng hải sản; «Frozen Seafood Distributor» không phải cửa hàng đông lạnh. Chỉ cụm chữ nói rõ VIỆC BUÔN
 * (import / wholesale / distributor…) mới khớp — chữ «seafood» trơn vẫn đi luật nhà hàng như cũ.
 *
 * Vì sao không áp trong nước (lead review 27/10/2026): bốn khoá B2B không nằm trong `DEFAULT_TARGET_SEGMENTS`, nên một nhà
 * phân phối VN tên «… Food Distributor» — đúng khách sỉ HSLC muốn — sẽ bị lọc `SEGMENT` ở chiến dịch trong nước, trong khi
 * trước đây nó `UNCLASSIFIED` và đi qua. Không đổi hành vi trong nước là cách ít rủi ro nhất.
 *
 * `words` khớp theo RANH GIỚI TỪ như luật trong nước (tiếng Anh, chữ Latin). `stems` khớp CHUỖI CON trên tên đã chữ thường
 * (ß ⇒ ss, ký tự không phải chữ / số ⇒ khoảng trắng): tiếng Nhật / Hàn / Trung viết liền không có khoảng trắng, tiếng Đức ghép
 * từ («Fischgroßhandel»), nên ranh giới từ không bắt được. Từ bản địa chỉ khai khi chắc nghĩa và đủ hẹp — «水産» trơn KHÔNG
 * có mặt vì chuỗi quán nhậu Nhật cũng mang chữ ấy; chỉ «水産卸» (bán sỉ thuỷ sản).
 */
const B2B_RULES: { segment: LeadSegment; words: string[]; stems: string[] }[] = [
  {
    segment: "SEAFOOD_IMPORTER",
    words: [
      "seafood importer", "seafood importers", "seafood import", "seafood imports", "seafood wholesale", "seafood wholesaler", "seafood wholesalers",
      "seafood trading", "seafood supply", "seafood supplies", "seafood supplier", "seafood suppliers", "seafood distributor", "seafood distributors",
      "seafood distribution", "frozen seafood", "fish wholesale", "fish wholesaler", "fish wholesalers", "fish importer", "fish importers",
    ],
    stems: [
      "水産卸", "水産物卸", "鮮魚卸", "수산물도매", "수산물 도매", "수산 도매", "냉동수산", "냉동 수산", "海鮮批發", "海產批發", "水產批發", "冷凍海鮮", "海鮮進口",
      "fischgroßhandel", "fisch großhandel", "fischimport", "meeresfrüchte großhandel", "grossiste produits de la mer", "grossiste poisson", "grossiste en poisson", "grossiste fruits de mer", "mareyeur",
    ],
  },
  {
    segment: "PRIVATE_LABEL_OEM",
    words: ["private label", "oem", "co packer", "co packing", "contract packing", "contract manufacturing"],
    stems: [],
  },
  {
    segment: "ASIAN_FOOD_WHOLESALE",
    words: [
      "asian food wholesale", "asian food wholesaler", "asian grocery wholesale", "asian grocery wholesaler", "asian wholesale", "asian wholesaler",
      "asian food importer", "asian food importers", "asian food import", "oriental food wholesale", "oriental wholesale", "oriental food importer",
      "vietnamese food wholesale", "vietnamese food importer", "vietnamese food import",
    ],
    stems: ["asia großhandel", "asiagroßhandel", "asiatischer großhandel", "grossiste asiatique", "grossiste alimentaire asiatique"],
  },
  {
    segment: "FOODSERVICE_DISTRIBUTOR",
    words: [
      "foodservice", "food service distributor", "food service supplier", "food distributor", "food distributors", "food distribution", "horeca",
      "restaurant supply", "restaurant supplies", "catering supplies", "food wholesale", "food wholesaler", "food wholesalers", "cash and carry", "cash carry",
    ],
    stems: ["食品卸", "食材卸", "식자재", "식품도매", "식품 도매", "食品批發", "食材批發", "gastro großhandel", "gastrogroßhandel", "lebensmittelgroßhandel", "grossiste alimentaire", "fournisseur restauration"],
  },
];

/** Chữ thường, ß ⇒ ss, mọi ký tự không phải chữ / số ⇒ khoảng trắng. KHÔNG bỏ dấu, KHÔNG tách chữ CJK. */
function stemFold(raw: string | null | undefined): string {
  if (!raw) return "";
  return ` ${raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/**
 * ═══ VIỆT KIỀU (chủ shop 30/10/2026) — chỉ ô quốc tế ═══
 *
 * Cần HAI chứng cứ cùng lúc, cả hai đọc từ dữ liệu có thật:
 *  (1) DẤU HIỆU VIỆT trong TÊN — «Viet», «Vietnamese», «Saigon», «Hà Nội», «Phở», «Mekong», hoặc chữ «Việt Nam» ở tiếng
 *      Đức / Pháp / Séc / Ba Lan / Nhật / Hàn / Trung (khớp chuỗi con «vietnam», «wietnam», «ベトナム», «베트남», «越南»);
 *  (2) LOẠI HÌNH KINH DOANH — bán sỉ / phân phối (chữ trong tên hoặc loại hình `wholesaler`) ⇒ `VIET_FOOD_DISTRIBUTOR`;
 *      cửa hàng / siêu thị / chợ (chữ trong tên hoặc loại hình grocery / supermarket / market…) ⇒ `VIET_DIASPORA_GROCERY`.
 * Có dấu hiệu Việt mà không rõ loại hình (vd quán phở chỉ mang loại hình `restaurant`) ⇒ KHÔNG gắn nhóm Việt Kiều, đi
 * tiếp các luật khác — quán phở là nhà hàng, không phải chợ. Chỉ có loại hình mà không có dấu hiệu Việt (một «Asia
 * Markt» bất kỳ) ⇒ cũng không: không đoán chủ là người Việt. `evidence` ghi CẢ HAI chứng cứ.
 */
const VIET_MARKER_WORDS = ["viet", "vietnamese", "vietnam", "viet nam", "saigon", "sai gon", "little saigon", "hanoi", "ha noi", "pho", "mekong", "danang", "da nang"];
const VIET_MARKER_STEMS = ["vietnam", "wietnam", "ベトナム", "베트남", "越南"];
const VIET_DISTRIBUTOR_WORDS = ["wholesale", "wholesaler", "wholesalers", "distributor", "distributors", "distribution", "import", "importer", "importers", "imports", "trading", "cash and carry", "velkoobchod", "hurtownia", "grossiste"];
const VIET_DISTRIBUTOR_STEMS = ["großhandel", "卸", "도매", "批發"];
const VIET_GROCERY_WORDS = ["grocery", "groceries", "supermarket", "supermarkets", "market", "markets", "mart", "minimart", "mini mart", "food store", "epicerie", "markt", "supermarkt", "supermarche", "potraviny", "sklep", "chợ", "siêu thị", "tạp hóa", "tạp hoá"];
const VIET_GROCERY_STEMS = ["食材", "スーパー", "식품", "마트", "超市", "雜貨", "食品行"];
const VIET_GROCERY_TYPES = ["grocery_store", "asian_grocery_store", "supermarket", "hypermarket", "food_store", "market", "convenience_store"];

/** Nhóm Việt Kiều nếu đủ hai chứng cứ (xem trên), không thì `null`. HÀM THUẦN. */
export function vietDiasporaSegment(input: SegmentInput): SegmentResult | null {
  const marker = nameWordHit(input.name, VIET_MARKER_WORDS) ?? nameStemHit(input.name, VIET_MARKER_STEMS);
  if (!marker) return null;
  const types = [input.primaryType ?? "", ...(input.types ?? [])];
  const dist = nameWordHit(input.name, VIET_DISTRIBUTOR_WORDS) ?? nameStemHit(input.name, VIET_DISTRIBUTOR_STEMS) ?? (types.includes("wholesaler") ? "loại hình wholesaler" : null);
  if (dist) return { segment: "VIET_FOOD_DISTRIBUTOR", evidence: `tên có «${marker}» + ${dist.startsWith("loại hình") ? dist : `«${dist}»`}` };
  const shopType = types.find((t) => VIET_GROCERY_TYPES.includes(t));
  const shop = nameWordHit(input.name, VIET_GROCERY_WORDS) ?? nameStemHit(input.name, VIET_GROCERY_STEMS);
  if (shop) return { segment: "VIET_DIASPORA_GROCERY", evidence: `tên có «${marker}» + «${shop}»` };
  if (shopType) return { segment: "VIET_DIASPORA_GROCERY", evidence: `tên có «${marker}» + loại hình «${shopType}»` };
  return null;
}

/** Chuỗi con đầu tiên trong `stems` có mặt trong tên (xem `B2B_RULES`). HÀM THUẦN. */
export function nameStemHit(name: string | null | undefined, stems: readonly string[]): string | null {
  const hay = stemFold(name);
  return (
    stems.find((st) => {
      const needle = stemFold(st).trim();
      return needle.length > 0 && hay.includes(needle);
    }) ?? null
  );
}

const NAME_RULES: { segment: LeadSegment; words: string[] }[] = [
  // Món ăn mang tên mặt hàng («Bánh cuốn chả mực») là QUÁN dùng hàng, không phải cửa hàng đặc sản.
  { segment: "EATERY", words: ["bánh cuốn"] },
  // Đặc sản / đồ khô ĐỨNG TRƯỚC hải sản: «Hải sản khô Hạ Long» là cửa hàng bán lại, không phải nhà hàng.
  { segment: "SPECIALTY_STORE", words: ["dac san", "qua bieu", "qua que", "cha muc", "ruoc", "cha bong", "hai san kho", "do kho", "nuoc mam"] },
  { segment: "MOM_BABY", words: ["me va be", "me be", "mẹ bé", "baby", "an dam"] },
  { segment: "SEAFOOD_RESTAURANT", words: ["hai san", "seafood", "ốc", "tom hum", "cua ghe"] },
  { segment: "BUFFET", words: ["buffet"] },
  { segment: "HOTPOT", words: ["lẩu", "hotpot", "hot pot"] },
  { segment: "BBQ", words: ["nuong", "bbq", "barbecue", "grill"] },
  { segment: "CATERING", words: ["tiệc", "catering", "suat an", "bep an", "com cong nghiep", "nấu cỗ"] },
  { segment: "FROZEN_FOOD_STORE", words: ["dong lanh", "frozen", "thuc pham sach", "thuc pham tuoi", "kho lanh"] },
  { segment: "PUB_BEER", words: ["quán nhậu", "nhậu", "beer", "bia hơi", "pub"] },
  { segment: "HOTEL_RESORT", words: ["resort", "hotel", "khach san"] },
  { segment: "GROCERY", words: ["tạp hoá", "tạp hóa", "minimart", "mini mart", "cua hang thuc pham"] },
  { segment: "EATERY", words: ["quán cơm", "com binh dan", "com van phong", "bun cha ca", "bun ca", "banh da ca", "quán ăn"] },
  { segment: "SUPERMARKET", words: ["sieu thi", "mart", "bach hoa"] },
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
/**
 * Từ đầu tiên trong `words` có mặt trong tên, theo RANH GIỚI TỪ. Có dấu ⇒ khớp trên tên có dấu (« lẩu » khớp «Lẩu Dê 404»,
 * KHÔNG khớp «Lâu Đài»); không dấu ⇒ khớp trên tên đã bỏ dấu. HÀM THUẦN.
 */
export function nameWordHit(name: string | null | undefined, words: readonly string[]): string | null {
  const folded = foldVietnamese(name);
  const marked = lowerKeepMarks(name);
  return words.find((w) => (hasMarks(w) ? marked.includes(` ${lowerKeepMarks(w).trim()} `) : folded.includes(` ${foldVietnamese(w).trim()} `))) ?? null;
}

/**
 * `opts.b2b` = ô / lead QUỐC TẾ: bật luật tên B2B (`B2B_RULES`) và loại hình `B2B_TYPE_SEGMENT`. Mặc định TẮT — mọi đường
 * trong nước (quét tỉnh VN, nhập tệp) phân nhóm đúng như trước 27/10/2026.
 */
export function classifySegment(input: SegmentInput, opts: { b2b?: boolean } = {}): SegmentResult {
  const b2b = opts.b2b === true;
  if (b2b) {
    const viet = vietDiasporaSegment(input);
    if (viet) return viet;
    for (const rule of B2B_RULES) {
      const hit = nameWordHit(input.name, rule.words) ?? nameStemHit(input.name, rule.stems);
      if (hit) return { segment: rule.segment, evidence: `tên có «${hit}»` };
    }
  }
  const typeSeg = (t: string | null | undefined): LeadSegment | undefined => (t ? (TYPE_SEGMENT[t] ?? (b2b ? B2B_TYPE_SEGMENT[t] : undefined)) : undefined);
  for (const rule of NAME_RULES) {
    const hit = nameWordHit(input.name, rule.words);
    if (hit) return { segment: rule.segment, evidence: `tên có «${hit}»` };
  }
  const primary = typeSeg(input.primaryType);
  if (primary) return { segment: primary, evidence: `loại hình chính «${input.primaryType}»` };
  let best: { segment: LeadSegment; type: string } | null = null;
  for (const t of input.types ?? []) {
    const seg = typeSeg(t);
    if (!seg) continue;
    if (!best || SEGMENT_POINTS[seg].fit > SEGMENT_POINTS[best.segment].fit) best = { segment: seg, type: t };
  }
  if (best) return { segment: best.segment, evidence: `loại hình «${best.type}»` };
  return { segment: "UNCLASSIFIED", evidence: "không có loại hình / từ khoá nhận ra được" };
}

/**
 * Bộ lọc «nhóm khách mục tiêu» của chiến dịch — MỘT chỗ cho cả bước tìm lẫn bước chi tiết (engine.ts). Chiến dịch không khai
 * nhóm ⇒ nhận mọi nhóm; `UNCLASSIFIED` luôn qua (không có chứng cứ thì không loại). HÀM THUẦN.
 */
export function passesTargetSegments(targets: readonly string[], segment: LeadSegment): boolean {
  return !targets.length || segment === "UNCLASSIFIED" || targets.includes(segment);
}

/**
 * DẤU HIỆU BUÔN SỈ trong tên / loại hình Google: importer · distributor · wholesale… (và chữ bản địa cùng nghĩa). Đầu vào
 * của hệ số «ý định mua» ở `scoring.ts` — nơi tự gọi mình là nhà nhập khẩu / nhà phân phối thì mua theo lô, không theo món.
 * Trả CHÍNH chứng cứ đã khớp (để lý do chấm điểm in ra được), không khớp ⇒ `null`. Chỉ chữ nước ngoài, và engine chỉ áp
 * cho lead QUỐC TẾ: tên quán trong nước mang «bán sỉ» thường là đối thủ / đầu mối, nên bảng chấm trong nước không đổi.
 * HÀM THUẦN.
 */
const B2B_SIGNAL_WORDS = ["importer", "importers", "import", "imports", "distributor", "distributors", "distribution", "wholesale", "wholesaler", "wholesalers", "foodservice", "horeca"];
const B2B_SIGNAL_STEMS = ["卸", "도매", "批發", "批发", "進口", "großhandel", "grossiste", "distributeur", "importeur", "groothandel"];

export function b2bSignal(input: SegmentInput): string | null {
  if (input.primaryType === "wholesaler" || (input.types ?? []).includes("wholesaler")) return "loại hình «wholesaler»";
  const hit = nameWordHit(input.name, B2B_SIGNAL_WORDS) ?? nameStemHit(input.name, B2B_SIGNAL_STEMS);
  return hit ? `tên có «${hit}»` : null;
}
