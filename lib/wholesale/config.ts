import { z } from "zod";
import { DEFAULT_GRADE_THRESHOLDS, DEFAULT_LEARNING, type ServiceAreaLevel } from "@/lib/wholesale/scoring";
import type { LeadSegment } from "@/lib/wholesale/segments";

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

/** Bộ từ khoá mặc định «HSLC – Nhà hàng / F&B» — chủ shop bật / tắt từng nhóm trên form chiến dịch. */
export const DEFAULT_KEYWORD_GROUPS: readonly KeywordGroup[] = [
  { key: "hai-san", label: "Hải sản", keywords: ["nhà hàng hải sản", "hải sản", "buffet hải sản", "lẩu hải sản"], enabled: true },
  { key: "buffet", label: "Buffet", keywords: ["buffet"], enabled: true },
  { key: "lau-nuong", label: "Lẩu / nướng / BBQ", keywords: ["nhà hàng lẩu", "nhà hàng nướng", "BBQ"], enabled: true },
  { key: "nhau", label: "Quán nhậu / bia", keywords: ["quán nhậu", "beer garden"], enabled: true },
  { key: "nha-hang", label: "Nhà hàng chung", keywords: ["nhà hàng"], enabled: true },
  { key: "luu-tru", label: "Khách sạn / resort", keywords: ["khách sạn", "resort"], enabled: true },
  { key: "tiec", label: "Tiệc / catering / bếp ăn", keywords: ["catering", "dịch vụ tiệc", "bếp ăn"], enabled: true },
  { key: "thuc-pham", label: "Thực phẩm / siêu thị", keywords: ["cửa hàng thực phẩm đông lạnh", "thực phẩm sạch", "siêu thị thực phẩm", "siêu thị mini"], enabled: true },
];

/** Nhóm khách mục tiêu mặc định của HSLC (đặc tả mục 21). */
export const DEFAULT_TARGET_SEGMENTS: readonly LeadSegment[] = [
  "SEAFOOD_RESTAURANT",
  "HOTPOT",
  "BBQ",
  "BUFFET",
  "RESTAURANT",
  "PUB_BEER",
  "HOTEL_RESORT",
  "CATERING",
  "FROZEN_FOOD_STORE",
];

export const DEFAULT_SERVICE_AREAS: Record<string, ServiceAreaLevel> = {
  "ho chi minh": "PRIORITY",
  "ha noi": "PRIORITY",
  "da nang": "PRIORITY",
  "thanh hoa": "PRIORITY",
  "hai phong": "PRIORITY",
  "quang ninh": "PRIORITY",
};

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
  discoveryTier: "PRO",
  maxPagesPerCell: 3,
  minNewRatioForNextPage: 0.3,
  requestIntervalMs: 300,
  timeoutMs: 15_000,
  maxRetries: 3,
  cellFreshDays: 30,
  googleRetentionDays: 30,
  serviceAreas: { ...DEFAULT_SERVICE_AREAS },
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
    gradeThresholds: obj(r.gradeThresholds, base.gradeThresholds),
    learning: obj(r.learning, base.learning),
    websiteEnrichment: obj(r.websiteEnrichment, base.websiteEnrichment),
    outreach: obj(r.outreach, base.outreach),
  };
  const parsed = leadHunterConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
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
