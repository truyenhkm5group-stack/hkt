import { z } from "zod";
import { CAPTION_LIMITS, SCRIPT_LIMITS, POLICY_LINES_MAX, POLICY_LINE_MAX_CHARS, SELECTABLE_VIDEO_PROVIDERS, TTS_VOICES, VIDEO_ANGLES, VIDEO_MODELS, VIDEO_ADS_HARD_LIMITS, VIDEO_ADS_MODES, VIDEO_PUBLISH_MODES, VIDEO_REVIEW_MODES, VIDEO_SCALE_HARD_LIMITS } from "@/lib/constants/video-scale";

const id = z.string().trim().min(1).max(80);

export const videoRunCreateSchema = z.object({
  productId: id,
  sourceIds: z.array(id).min(1, "Chọn ít nhất một ảnh sản phẩm").max(6, "Tối đa 6 ảnh gốc"),
  variants: z.coerce.number().int().min(1).max(VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun),
  angles: z.array(z.enum(VIDEO_ANGLES)).max(VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun).default([]),
  brief: z.string().max(600).default(""),
  musicId: z.string().trim().max(80).default(""),
});

export const videoReviewSchema = z.object({
  variantId: id,
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(500).default(""),
});

export const videoIdSchema = z.object({ id });

export const videoConfigSchema = z.object({
  enabled: z.boolean(),
  /** Không có FAKE: bộ sinh giả không chọn được từ màn hình. */
  provider: z.enum(SELECTABLE_VIDEO_PROVIDERS).optional(),
  model: z.string().refine((m) => (VIDEO_MODELS as readonly string[]).includes(m), "Model không có trong danh sách"),
  resolution: z.enum(["720p", "1080p"]),
  clipSeconds: z.coerce.number().int().refine((n) => [4, 6, 8].includes(n), "4, 6 hoặc 8 giây"),
  scenesPerVariant: z.coerce.number().int().min(1).max(VIDEO_SCALE_HARD_LIMITS.maxScenesPerVariant),
  /** `null` = mọi cảnh AI; 0 = toàn ảnh động (miễn phí). */
  aiScenes: z.union([z.null(), z.coerce.number().int().min(0).max(VIDEO_SCALE_HARD_LIMITS.maxScenesPerVariant)]).default(null),
  /** Chuỗi rỗng = CHƯA KHAI (không sinh). */
  dailyUsdCap: z.union([z.literal(""), z.coerce.number().positive().max(VIDEO_SCALE_HARD_LIMITS.maxVideoUsdPerDay)]),
  dailyClipCap: z.coerce.number().int().min(1).max(VIDEO_SCALE_HARD_LIMITS.maxClipsPerDay),
  providerConcurrency: z.coerce.number().int().min(1).max(VIDEO_SCALE_HARD_LIMITS.maxProviderConcurrency),
  voiceover: z.boolean(),
  voice: z.enum(TTS_VOICES),
  keepNativeAudio: z.boolean(),
  burnSubtitles: z.boolean(),
  outputHeight: z.union([z.literal(1280), z.literal(1920)]),
  policyLines: z.array(z.string().trim().max(POLICY_LINE_MAX_CHARS)).max(POLICY_LINES_MAX),
  /** Chuỗi rỗng = CHƯA KHAI ⇒ không bật quảng cáo nào. */
  adsGlobalDailyCapVnd: z.union([z.literal(""), z.coerce.number().int().min(VIDEO_ADS_HARD_LIMITS.minDailyBudgetVnd).max(VIDEO_ADS_HARD_LIMITS.maxGlobalDailyVnd)]).default(""),
  adTemplateAdId: z.string().trim().regex(/^([0-9]{5,25})?$/, "Id mẩu quảng cáo mẫu chỉ gồm chữ số").default(""),
  optimizeWindowDays: z.coerce.number().int().min(1).max(14).default(3),
  scaleStepPct: z.coerce.number().min(0.05).max(VIDEO_ADS_HARD_LIMITS.maxStepPct).default(0.2),
  /** Chuỗi rỗng = CHƯA KHAI ⇒ máy chỉ ĐỀ NGHỊ tăng, không tự tăng. */
  autoScaleMinOrders: z.union([z.literal(""), z.coerce.number().int().min(1).max(1000)]).default(""),
});

export const videoSkuModeSchema = z.object({ productId: id, reviewMode: z.enum(VIDEO_REVIEW_MODES) });

/** Nhạc: base64 ≤ ~7 MB (trần thân Server Action 8 MB). */
export const videoMusicUploadSchema = z.object({
  title: z.string().trim().min(1).max(120),
  licenseNote: z.string().trim().min(10, "Khai nguồn + quyền sử dụng (ít nhất 10 ký tự)").max(500),
  contentType: z.enum(["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/x-m4a"]),
  base64: z.string().min(10).max(10_000_000),
});

export const videoCaptionSchema = z.object({ variantId: id, caption: z.string().max(CAPTION_LIMITS.totalMaxChars) });

/** `publishAt` rỗng = đăng ngay; có giá trị = ISO (trình duyệt đổi giờ địa phương sang ISO trước khi gửi). */
export const videoPublishSchema = z.object({ variantId: id, caption: z.string().max(CAPTION_LIMITS.totalMaxChars), publishAt: z.string().max(40).default("") });

export const videoSkuPublishingSchema = z.object({ productId: id, pageId: z.string().trim().max(40).default(""), publishMode: z.enum(["", "MANUAL_REVIEW"]).default("") });

export const videoPageConfigSchema = z.object({ pageId: id, publishMode: z.enum(VIDEO_PUBLISH_MODES), maxPostsPerDay: z.coerce.number().int().min(1).max(10) });

/** Dừng khẩn cấp: `scope` = mã / fanpage / toàn module. Kéo bắt buộc lý do; nhả cũng bắt buộc lý do. */
export const videoPauseSchema = z.object({ scope: z.enum(["SKU", "PAGE", "ALL"]), id: z.string().trim().max(80).default(""), paused: z.boolean(), reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự)").max(300) });

const vndOrEmpty = (max: number) => z.union([z.literal(""), z.coerce.number().int().min(VIDEO_ADS_HARD_LIMITS.minDailyBudgetVnd).max(max)]);

export const videoSkuAdsSchema = z.object({
  productId: id,
  adAccountId: z.string().trim().regex(/^([0-9]{5,25})?$/, "Tài khoản quảng cáo không hợp lệ").default(""),
  adsMode: z.enum(VIDEO_ADS_MODES),
  dailyBudgetPerAdVnd: vndOrEmpty(VIDEO_ADS_HARD_LIMITS.maxDailyBudgetPerAdVnd),
  skuDailyCapVnd: vndOrEmpty(VIDEO_ADS_HARD_LIMITS.maxSkuDailyVnd),
  autoScale: z.boolean().default(false),
  autoNextRound: z.boolean().default(false),
});

export const videoAdIdSchema = z.object({ adId: id });
export const videoAdCreateSchema = z.object({ adId: id, activate: z.boolean() });
export const videoAdPauseSchema = z.object({ adId: id, reason: z.string().trim().min(3, "Ghi lý do tắt").max(300) });
export const videoAdBudgetSchema = z.object({ adId: id, budgetVnd: z.coerce.number().int().min(VIDEO_ADS_HARD_LIMITS.minDailyBudgetVnd).max(VIDEO_ADS_HARD_LIMITS.maxDailyBudgetPerAdVnd) });

/** Sửa video = dựng lại từ clip đã có. Giới hạn độ dài lấy từ CÙNG `SCRIPT_LIMITS` của kịch bản. */
export const videoEditSchema = z.object({
  variantId: id,
  hook: z.string().max(SCRIPT_LIMITS.hookMaxChars),
  cta: z.string().max(SCRIPT_LIMITS.ctaMaxChars),
  scenes: z
    .array(z.object({ overlay: z.string().max(SCRIPT_LIMITS.overlayMaxChars), voiceover: z.string().max(SCRIPT_LIMITS.voiceoverMaxCharsPerScene) }))
    .min(1)
    .max(VIDEO_SCALE_HARD_LIMITS.maxScenesPerVariant),
  options: z.object({
    musicId: z.union([z.null(), z.string().max(64)]).optional(),
    musicVolume: z.number().min(0.01).max(0.5).optional(),
    voiceover: z.boolean().optional(),
    voice: z.enum(TTS_VOICES).optional(),
    burnSubtitles: z.boolean().optional(),
    keepNativeAudio: z.boolean().optional(),
    showText: z.boolean().optional(),
  }),
});
