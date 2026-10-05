import { z } from "zod";
import { DEFAULT_GRADE_THRESHOLDS, DEFAULT_LEARNING, type ServiceAreaLevel } from "@/lib/wholesale/scoring";
import type { LeadSegment } from "@/lib/wholesale/segments";
import { SEARCH_PROVINCES } from "@/lib/wholesale/areas";
import { MESSAGING_CONNECTOR_KEYS } from "@/lib/messaging/types";

/**
 * ═══════════ CẤU HÌNH SĂN KHÁCH SỈ — HẰNG SỐ, MẶC ĐỊNH, LƯỢC ĐỒ ═══════════
 *
 * Lưu ở `settings["wholesale.leadHunter"]` của CSDL tổ chức (mỗi tổ chức một bản), sửa ở
 * `/wholesale/settings` (quyền `wholesale:config`). Ghi đè THƯA: thiếu khoá ⇒ lấy mặc định ở đây, nên
 * sửa mặc định trong mã vẫn tới được tổ chức chưa từng lưu (bài học luật 54).
 *
 * Tệp THUẦN, client-safe.
 */

export const LEAD_HUNTER_SETTING_KEY = "wholesale.leadHunter";

/** Mã SKU tính tiền của Places API (New) mà module này gọi tới. */
export const PLACES_SKUS = [
  "TEXT_SEARCH_IDS",
  "TEXT_SEARCH_PRO",
  "TEXT_SEARCH_ENTERPRISE",
  "NEARBY_SEARCH_PRO",
  "NEARBY_SEARCH_ENTERPRISE",
  "DETAILS_PRO",
  "DETAILS_ENTERPRISE",
] as const;
export type PlacesSku = (typeof PLACES_SKUS)[number];

export const PLACES_SKU_LABEL: Record<PlacesSku, string> = {
  TEXT_SEARCH_IDS: "Text Search (chỉ Place ID)",
  TEXT_SEARCH_PRO: "Text Search Pro",
  TEXT_SEARCH_ENTERPRISE: "Text Search Enterprise",
  NEARBY_SEARCH_PRO: "Nearby Search Pro",
  NEARBY_SEARCH_ENTERPRISE: "Nearby Search Enterprise",
  DETAILS_PRO: "Place Details Pro",
  DETAILS_ENTERPRISE: "Place Details Enterprise",
};

/**
 * Đơn giá USD / 1.000 lượt gọi — bảng giá công khai của Google Maps Platform (bậc đầu, áp dụng từ
 * 03/2025, lúc viết mã). ĐÂY LÀ ƯỚC TÍNH: chưa trừ hạn mức miễn phí hằng tháng, chưa trừ chiết khấu bậc
 * số lượng, và Google có thể đổi giá. Chủ shop sửa ở trang cấu hình khi Google đổi giá — hoá đơn Google
 * Cloud mới là con số thật.
 */
export const DEFAULT_SKU_PRICE_USD_PER_1000: Record<PlacesSku, number> = {
  TEXT_SEARCH_IDS: 0,
  TEXT_SEARCH_PRO: 32,
  TEXT_SEARCH_ENTERPRISE: 35,
  NEARBY_SEARCH_PRO: 32,
  NEARBY_SEARCH_ENTERPRISE: 35,
  DETAILS_PRO: 17,
  DETAILS_ENTERPRISE: 20,
};

/**
 * Mức trường dữ liệu lấy ở bước TÌM (Stage A):
 *  · `IDS_ONLY`   — chỉ Place ID (SKU miễn phí). Không lọc được loại hình / trạng thái trước khi lấy chi
 *                   tiết, nên MỌI địa điểm mới đều tốn một lượt Place Details.
 *  · `PRO`        — thêm tên, địa chỉ, loại hình, trạng thái hoạt động, toạ độ. Đủ để lọc sơ bộ trước khi
 *                   lấy chi tiết (luồng mặc định theo đặc tả: tìm gọn → lọc → chi tiết có chọn lọc).
 *  · `ENTERPRISE` — thêm SĐT, website, sao, số đánh giá ngay trong lượt tìm; bỏ hẳn bước chi tiết. Tính
 *                   tiền THEO LƯỢT TÌM (tới 20 địa điểm / lượt), nên thường RẺ HƠN mỗi lead khi tỉ lệ địa
 *                   điểm qua lọc cao — so ở trang Xem trước truy vấn trước khi đổi.
 */
export const DISCOVERY_TIERS = ["IDS_ONLY", "PRO", "ENTERPRISE"] as const;
export type DiscoveryTier = (typeof DISCOVERY_TIERS)[number];

export const DISCOVERY_TIER_LABEL: Record<DiscoveryTier, string> = {
  IDS_ONLY: "Chỉ Place ID (miễn phí, mọi địa điểm mới đều phải lấy chi tiết)",
  PRO: "Gọn — tên, địa chỉ, loại hình, trạng thái (lọc trước rồi mới lấy SĐT)",
  ENTERPRISE: "Đầy đủ trong lượt tìm — có luôn SĐT / website, không cần bước chi tiết",
};

/** Mức tự động hoá của hàng đợi liên hệ. Chỉ `MANUAL` và `AUTO_PREPARE` chạy được ở bản này. */
export const OUTREACH_AUTOMATION_LEVELS = ["MANUAL", "AUTO_PREPARE", "AUTO_SEND"] as const;
export type OutreachAutomationLevel = (typeof OUTREACH_AUTOMATION_LEVELS)[number];

export const OUTREACH_AUTOMATION_LABEL: Record<OutreachAutomationLevel, string> = {
  MANUAL: "Thủ công — người bấm «Soạn lời chào» cho từng lead",
  AUTO_PREPARE: "Tự soạn sẵn lời chào cho lead đủ điểm, người duyệt rồi tự gửi",
  AUTO_SEND: "Tự gửi sau khi soạn (CHƯA MỞ — chưa có kênh gửi tự động nào được kết nối)",
};

export type KeywordGroup = { key: string; label: string; keywords: string[]; enabled: boolean };

/**
 * Bộ từ khoá mặc định theo DANH MỤC THẬT của HSLC (đọc 05/10/2026: chả mực giã tay, chả cá thu, nem hải sản tôm bề bề,
 * ruốc bông tôm / cá thu, nước mắm cốt cá cơm — hàng đặc sản đóng gói 120–350 nghìn) và điều kiện bán hiện tại: CHƯA
 * xuất được hoá đơn VAT ⇒ khách là cửa hàng / quán VỪA và NHỎ nhập lại để bán hoặc dùng, không phải chuỗi / khách sạn /
 * bếp ăn công ty (những nơi mua theo hợp đồng có hoá đơn).
 *
 * Tám từ khoá BẬT sẵn là lõi: 8 từ × 57 khu vực đợt ① = 456 lượt tìm trang đầu — nằm trong 1.000 lượt Text Search
 * Enterprise MIỄN PHÍ mỗi tháng của Google (xem `GOOGLE_FREE_MONTHLY_CALLS`). Nhóm «Mở rộng» bật khi còn lượt; nhóm «Lớn»
 * để TẮT cho tới khi xuất được hoá đơn.
 */
export const DEFAULT_KEYWORD_GROUPS: readonly KeywordGroup[] = [
  { key: "dac-san", label: "Cửa hàng đặc sản / quà biếu", keywords: ["cửa hàng đặc sản", "chả mực Hạ Long"], enabled: true },
  { key: "thuc-pham", label: "Thực phẩm sạch / đồ khô", keywords: ["cửa hàng thực phẩm sạch"], enabled: true },
  { key: "me-be", label: "Mẹ & bé (ruốc cho bé)", keywords: ["cửa hàng mẹ và bé"], enabled: true },
  { key: "tap-hoa", label: "Tạp hoá", keywords: ["tạp hoá"], enabled: true },
  { key: "hai-san", label: "Quán hải sản", keywords: ["quán hải sản"], enabled: true },
  { key: "nhau", label: "Quán nhậu", keywords: ["quán nhậu"], enabled: true },
  { key: "quan-an", label: "Quán bún chả cá / quán cơm", keywords: ["bún chả cá"], enabled: true },
  { key: "mo-rong", label: "Mở rộng (bật khi còn lượt)", keywords: ["đặc sản Quảng Ninh", "cửa hàng hải sản khô", "thực phẩm đông lạnh", "minimart", "quán cơm", "nhà hàng hải sản", "bia hơi", "quán lẩu"], enabled: false },
  { key: "lon", label: "Nhà hàng lớn / khách sạn / tiệc (thường đòi hoá đơn VAT)", keywords: ["nhà hàng", "buffet", "khách sạn", "catering"], enabled: false },
];

/**
 * Lượt MIỄN PHÍ mỗi tháng theo SKU (bảng giá Google Maps Platform từ 01/03/2025: nhóm Essentials 10.000, Pro 5.000,
 * Enterprise 1.000 lượt / SKU / tài khoản thanh toán / tháng; Text Search chỉ-ID không giới hạn). Chủ shop sửa ở cấu hình
 * khi Google đổi bảng — hoá đơn Google Cloud mới là số thật.
 */
export const GOOGLE_FREE_MONTHLY_CALLS: Record<PlacesSku, number> = {
  TEXT_SEARCH_IDS: 1_000_000,
  TEXT_SEARCH_PRO: 5000,
  TEXT_SEARCH_ENTERPRISE: 1000,
  NEARBY_SEARCH_PRO: 5000,
  NEARBY_SEARCH_ENTERPRISE: 1000,
  DETAILS_PRO: 5000,
  DETAILS_ENTERPRISE: 1000,
};

/**
 * Chuỗi lớn — mua theo hợp đồng, đòi hoá đơn VAT, nên chưa phải khách của HSLC lúc này. Khớp theo TỪ trong tên đã bỏ dấu.
 * Golden Gate · Redsun · chuỗi đồ ăn nhanh / cà phê · siêu thị / cửa hàng tiện lợi chuỗi. Sửa ở cấu hình.
 */
export const DEFAULT_CHAIN_BRANDS: readonly string[] = [
  "Kichi-Kichi", "Kichi Kichi", "Gogi", "Manwah", "Sumo BBQ", "Hutong", "Ashima", "iSushi", "Vuvuzela", "Phố Ngon 37", "Cowboy Jack",
  "Crystal Jade", "Daruma", "Shogun", "Gyu Shige", "K-Pub", "Kpub", "Citea", "Golden Gate",
  "Hotpot Story", "Seoul Garden", "Khao Lao", "Buk Buk", "Thai Express", "Redsun",
  "KFC", "Lotteria", "Jollibee", "McDonald", "Burger King", "Pizza Hut", "Domino", "Texas Chicken", "Popeyes",
  "Highlands", "Phúc Long", "The Coffee House", "Starbucks", "Katinat",
  "WinMart", "Winmart+", "Co.op", "Coopmart", "Co.opmart", "Bách Hóa Xanh", "Lotte Mart", "AEON", "Big C", "GO!", "MM Mega", "Emart",
  "Circle K", "FamilyMart", "7-Eleven", "GS25", "Ministop", "Satrafoods", "Kingfoodmart", "Annam Gourmet", "Tops Market",
];

/** Quy mô khách nhắm tới: `SMALL_MEDIUM` = cửa hàng / quán vừa và nhỏ (chưa xuất được hoá đơn VAT); `ANY` = mọi cỡ. */
export const SIZE_PROFILES = ["SMALL_MEDIUM", "ANY"] as const;
export type SizeProfile = (typeof SIZE_PROFILES)[number];
export const SIZE_PROFILE_LABEL: Record<SizeProfile, string> = {
  SMALL_MEDIUM: "Vừa và nhỏ — ưu tiên quán / cửa hàng độc lập, loại chuỗi lớn và nơi quá đông",
  ANY: "Mọi quy mô — cộng điểm cho nơi đông khách, nhiều chi nhánh",
};

/** Nhóm khách mục tiêu mặc định của HSLC (đặc tả mục 21). */
export const DEFAULT_TARGET_SEGMENTS: readonly LeadSegment[] = [
  "SPECIALTY_STORE",
  "FROZEN_FOOD_STORE",
  "MOM_BABY",
  "GROCERY",
  "SEAFOOD_RESTAURANT",
  "PUB_BEER",
  "EATERY",
  "HOTPOT",
  "BBQ",
  "RESTAURANT",
];

/** Tỉnh quét trước (chủ shop chốt 04/10/2026): Hà Nội + TP.HCM; sau đó vùng không có biển, rồi ven biển (`scanTier`). */
export const DEFAULT_FIRST_PROVINCES: readonly string[] = ["ha noi", "ho chi minh"];

/** Tỉnh quét trước là vùng ưu tiên phục vụ; mọi tỉnh khác trong danh sách quét là vùng giao được. */
export const DEFAULT_SERVICE_AREAS: Record<string, ServiceAreaLevel> = Object.fromEntries(
  SEARCH_PROVINCES.map((p) => [p.key, DEFAULT_FIRST_PROVINCES.includes(p.key) ? "PRIORITY" : "SERVED"]),
);

export const DEFAULT_OPENER_TEMPLATE =
  "Em chào {{ten_doanh_nghiep}}, bên em là {{ten_shop}}, chuyên cung cấp {{san_pham}} cho {{nhom_khach}}. Em thấy bên mình kinh doanh {{loai_hinh}}{{khu_vuc}} nên muốn gửi anh/chị bảng giá sỉ để tham khảo ạ.";

const usd = z.number().min(0).max(100_000);

export const leadHunterConfigSchema = z.object({
  budget: z.object({
    dailyUsd: usd,
    monthlyUsd: usd,
    dailyRequestLimit: z.number().int().min(0).max(1_000_000),
  }),
  skuPriceUsdPer1000: z.object(Object.fromEntries(PLACES_SKUS.map((k) => [k, z.number().min(0).max(1000)])) as Record<PlacesSku, z.ZodNumber>),
  usdToVnd: z.number().int().min(1000).max(100_000),
  discoveryTier: z.enum(DISCOVERY_TIERS),
  maxPagesPerCell: z.number().int().min(1).max(3),
  /** Trang kế tiếp chỉ lấy khi trang vừa rồi đủ 20 kết quả VÀ tỉ lệ địa điểm mới ≥ ngưỡng này. */
  minNewRatioForNextPage: z.number().min(0).max(1),
  requestIntervalMs: z.number().int().min(0).max(10_000),
  timeoutMs: z.number().int().min(2000).max(60_000),
  maxRetries: z.number().int().min(0).max(5),
  /** Ô quét trong vòng N ngày được coi là còn mới — chiến dịch mới không quét lại. */
  cellFreshDays: z.number().int().min(1).max(365),
  /** Số ngày giữ trường dữ liệu nguồn Google trước khi phải làm mới hoặc xoá (xem docs mục tuân thủ). */
  googleRetentionDays: z.number().int().min(1).max(30),
  serviceAreas: z.record(z.string().min(1).max(60), z.enum(["PRIORITY", "SERVED"])),
  /** CHỈ dùng lượt miễn phí của Google: còn dưới (1 − safetyPct) hạn mức của SKU sắp gọi ⇒ tự dừng, đầu tháng sau tự chạy. */
  freeTier: z.object({
    enabled: z.boolean(),
    safetyPct: z.number().min(0).max(0.5),
    monthlyCalls: z.object(Object.fromEntries(PLACES_SKUS.map((k) => [k, z.number().int().min(0).max(10_000_000)])) as Record<PlacesSku, z.ZodNumber>),
  }),
  /** Loại chuỗi lớn: tên khớp danh sách, hoặc cùng một tên xuất hiện ở hơn `maxSameName` địa điểm. */
  chainFilter: z.object({
    enabled: z.boolean(),
    brands: z.array(z.string().trim().min(2).max(60)).max(300),
    maxSameName: z.number().int().min(1).max(50),
  }),
  sizeProfile: z.enum(SIZE_PROFILES),
  /** Số đánh giá Google trên mức này ⇒ coi là nơi quá lớn (thường đòi hoá đơn) và lọc. `null` = không lọc. */
  maxReviews: z.number().int().min(100).max(1_000_000).nullable(),
  /** Thứ tự quét khi bấm Bắt đầu: tỉnh quét trước ⇒ (tuỳ chọn) không có biển ⇒ ven biển. Xem `scanTier`. */
  scanPriority: z.object({
    firstProvinces: z.array(z.string().min(1).max(60)).max(40),
    inlandBeforeCoastal: z.boolean(),
  }),
  /** Gửi khách tiềm năng cho nhân viên thị trường qua một kết nối nhắn tin của tổ chức (Telegram mặc định). */
  fieldSales: z.object({
    connectorKey: z.enum(MESSAGING_CONNECTOR_KEYS),
    destinations: z
      .array(z.object({ label: z.string().trim().min(1).max(60), chatId: z.string().trim().max(120) }))
      .max(20),
  }),
  gradeThresholds: z.object({ A: z.number().int().min(1).max(100), B: z.number().int().min(1).max(100), C: z.number().int().min(1).max(100) }).refine((t) => t.A > t.B && t.B > t.C, "Ngưỡng hạng phải giảm dần A > B > C"),
  learning: z.object({ minSample: z.number().int().min(5).max(10_000), prior: z.number().int().min(0).max(1000), maxAdjust: z.number().int().min(0).max(10) }),
  /** Điểm tối thiểu để lead tự lên «Đủ điều kiện» (QUALIFIED). */
  qualifyMinScore: z.number().int().min(0).max(100),
  websiteEnrichment: z.object({ enabled: z.boolean(), maxPages: z.number().int().min(1).max(5) }),
  outreach: z.object({
    automationLevel: z.enum(OUTREACH_AUTOMATION_LEVELS),
    useAi: z.boolean(),
    shopName: z.string().max(120),
    productLine: z.string().max(200),
    targetAudience: z.string().max(200),
    catalogNote: z.string().max(1000),
    pricingNote: z.string().max(1000),
    moqNote: z.string().max(300),
    deliveryNote: z.string().max(500),
    promotionNote: z.string().max(500),
    openerTemplate: z.string().min(10).max(1500),
    callScript: z.string().max(3000),
  }),
});

export type LeadHunterConfig = z.infer<typeof leadHunterConfigSchema>;

export const DEFAULT_LEAD_HUNTER_CONFIG: LeadHunterConfig = {
  // Trần chi tiêu MẶC ĐỊNH để module không bao giờ chạy mà không có trần — chủ shop đặt lại theo ngân sách thật.
  budget: { dailyUsd: 5, monthlyUsd: 50, dailyRequestLimit: 1000 },
  skuPriceUsdPer1000: { ...DEFAULT_SKU_PRICE_USD_PER_1000 },
  usdToVnd: 26_000,
  // ENTERPRISE: SĐT + website + số đánh giá ngay trong lượt tìm (≤ 20 địa điểm / lượt), 1.000 lượt miễn phí mỗi tháng —
  // rẻ nhất trên mỗi lead và đủ để lọc chuỗi / quy mô mà không cần lượt chi tiết.
  discoveryTier: "ENTERPRISE",
  maxPagesPerCell: 3,
  minNewRatioForNextPage: 0.3,
  requestIntervalMs: 300,
  timeoutMs: 15_000,
  maxRetries: 3,
  cellFreshDays: 30,
  googleRetentionDays: 30,
  serviceAreas: { ...DEFAULT_SERVICE_AREAS },
  scanPriority: { firstProvinces: [...DEFAULT_FIRST_PROVINCES], inlandBeforeCoastal: true },
  freeTier: { enabled: true, safetyPct: 0.05, monthlyCalls: { ...GOOGLE_FREE_MONTHLY_CALLS } },
  chainFilter: { enabled: true, brands: [...DEFAULT_CHAIN_BRANDS], maxSameName: 3 },
  sizeProfile: "SMALL_MEDIUM",
  maxReviews: 5000,
  // Nơi nhận rỗng = chat đã khai ở kết nối Telegram (ô «Chat ID» của trang Kết nối).
  fieldSales: { connectorKey: "telegram-bot", destinations: [] },
  gradeThresholds: { ...DEFAULT_GRADE_THRESHOLDS },
  learning: { ...DEFAULT_LEARNING },
  qualifyMinScore: 65,
  websiteEnrichment: { enabled: true, maxPages: 3 },
  outreach: {
    automationLevel: "MANUAL",
    useAi: false,
    shopName: "Hải Sản Làng Chài",
    productLine: "hải sản đóng gói",
    targetAudience: "nhà hàng, quán ăn",
    catalogNote: "",
    pricingNote: "",
    moqNote: "",
    deliveryNote: "",
    promotionNote: "",
    openerTemplate: DEFAULT_OPENER_TEMPLATE,
    callScript:
      "1. Chào, giới thiệu {{ten_shop}}.\n2. Hỏi bên mình đang nhập hải sản ở đâu, tần suất bao lâu một lần.\n3. Xin Zalo để gửi bảng giá sỉ / catalog.\n4. Hẹn ngày gọi lại hoặc gửi mẫu thử.",
  },
};

/** Ghép bản lưu (có thể thiếu khoá, có thể từ phiên bản cũ) với mặc định — sai lược đồ ⇒ mặc định, không ném. */
export function mergeLeadHunterConfig(raw: unknown): LeadHunterConfig {
  const base = DEFAULT_LEAD_HUNTER_CONFIG;
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<Record<keyof LeadHunterConfig, unknown>>;
  const obj = <T extends object>(v: unknown, d: T): T => (v && typeof v === "object" && !Array.isArray(v) ? { ...d, ...(v as Partial<T>) } : d);
  const merged = {
    ...base,
    ...r,
    budget: obj(r.budget, base.budget),
    skuPriceUsdPer1000: obj(r.skuPriceUsdPer1000, base.skuPriceUsdPer1000),
    serviceAreas: r.serviceAreas && typeof r.serviceAreas === "object" ? (r.serviceAreas as Record<string, ServiceAreaLevel>) : base.serviceAreas,
    scanPriority: obj(r.scanPriority, base.scanPriority),
    freeTier: (() => {
      const f = obj(r.freeTier, base.freeTier);
      return { ...f, monthlyCalls: obj((r.freeTier as { monthlyCalls?: unknown } | undefined)?.monthlyCalls, base.freeTier.monthlyCalls) };
    })(),
    chainFilter: obj(r.chainFilter, base.chainFilter),
    fieldSales: obj(r.fieldSales, base.fieldSales),
    gradeThresholds: obj(r.gradeThresholds, base.gradeThresholds),
    learning: obj(r.learning, base.learning),
    websiteEnrichment: obj(r.websiteEnrichment, base.websiteEnrichment),
    outreach: obj(r.outreach, base.outreach),
  };
  const parsed = leadHunterConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

/** Lượt miễn phí còn dùng được của một SKU trong tháng (đã trừ biên an toàn). HÀM THUẦN. */
export function freeTierLeft(cfg: Pick<LeadHunterConfig, "freeTier">, sku: PlacesSku, usedThisMonth: number): number {
  const cap = Math.floor((cfg.freeTier.monthlyCalls[sku] ?? 0) * (1 - cfg.freeTier.safetyPct));
  return Math.max(0, cap - usedThisMonth);
}

/**
 * CHI PHÍ SAU KHI TRỪ PHẦN MIỄN PHÍ (HÀM THUẦN). Google không tính tiền N lượt đầu mỗi tháng của từng SKU
 * (`freeTier.monthlyCalls` — áp cho mọi tài khoản, bật hay tắt chế độ «chỉ dùng miễn phí»). Đo 05/10/2026: 328 lượt
 * (305 chi tiết + 23 tìm) đều nằm trong phần miễn phí mà ERP ghi 5 US$ theo giá niêm yết rồi tự chặn «chạm trần NGÀY» —
 * trần chi tiêu phải so với TIỀN THẬT, không phải giá niêm yết.
 *
 * `monthCalls` = lượt ĐÃ TÍNH TIỀN (2xx) trong tháng tính tới giờ, gồm cả hôm nay; `todayCalls` = phần của hôm nay.
 */
export function paidCostMicros(
  cfg: Pick<LeadHunterConfig, "freeTier" | "skuPriceUsdPer1000">,
  monthCalls: Partial<Record<PlacesSku, number>>,
  todayCalls: Partial<Record<PlacesSku, number>>,
): { monthMicros: number; todayMicros: number; bySku: Partial<Record<PlacesSku, number>> } {
  let monthMicros = 0;
  let todayMicros = 0;
  const bySku: Partial<Record<PlacesSku, number>> = {};
  for (const sku of PLACES_SKUS) {
    const month = monthCalls[sku] ?? 0;
    const today = Math.min(todayCalls[sku] ?? 0, month);
    const free = cfg.freeTier.monthlyCalls[sku] ?? 0;
    const paidMonth = Math.max(0, month - free);
    const paidBeforeToday = Math.max(0, month - today - free);
    const unit = skuCostMicros(sku, cfg);
    bySku[sku] = paidMonth * unit;
    monthMicros += paidMonth * unit;
    todayMicros += (paidMonth - paidBeforeToday) * unit;
  }
  return { monthMicros, todayMicros, bySku };
}

/** Giá của lượt gọi KẾ TIẾP của một SKU: 0 khi còn trong phần miễn phí của tháng. */
export function nextCallCostMicros(cfg: Pick<LeadHunterConfig, "freeTier" | "skuPriceUsdPer1000">, sku: PlacesSku, usedThisMonth: number): number {
  return usedThisMonth < (cfg.freeTier.monthlyCalls[sku] ?? 0) ? 0 : skuCostMicros(sku, cfg);
}

/**
 * Google báo hết hạn mức (429). Hạn mức «per day» của Google đặt lại lúc 0 giờ giờ Thái Bình Dương (07:00–08:00 UTC tuỳ
 * mùa) — hỏi lại sau 10 phút chỉ đẻ thêm lỗi (đo 05/10/2026: 107 lỗi 429 «GetPlaceRequest per day» trong 2 giờ). Hạn
 * mức ngày ⇒ chờ tới 08:05 UTC kế tiếp; còn lại (theo phút) ⇒ 10 phút.
 */
export function quotaRetryAt(now: Date, message: string): Date {
  if (!/per day|PerDay|daily/i.test(message)) return new Date(now.getTime() + 10 * 60_000);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 5, 0));
  return next.getTime() > now.getTime() ? next : new Date(next.getTime() + 86_400_000);
}

/** Đơn giá một lượt gọi theo cấu hình, đơn vị micro-USD (số nguyên) để cộng dồn không sai số. */
export function skuCostMicros(sku: PlacesSku, cfg: Pick<LeadHunterConfig, "skuPriceUsdPer1000">): number {
  return Math.round((cfg.skuPriceUsdPer1000[sku] ?? 0) * 1000); // USD/1000 lượt ⇒ micro-USD/lượt = ×1e6/1e3
}

export function microsToUsd(micros: number | null | undefined): number | null {
  return micros == null ? null : micros / 1_000_000;
}

export function microsToVnd(micros: number | null | undefined, usdToVnd: number): number | null {
  return micros == null ? null : Math.round((micros / 1_000_000) * usdToVnd);
}
