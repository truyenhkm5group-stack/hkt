import { z } from "zod";
import { POLICY_LINES_MAX, POLICY_LINE_MAX_CHARS, TTS_VOICES, VEO_MODELS, VIDEO_ANGLES, VIDEO_REVIEW_MODES, VIDEO_SCALE_HARD_LIMITS } from "@/lib/constants/video-scale";

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
  model: z.enum(VEO_MODELS),
  resolution: z.enum(["720p", "1080p"]),
  clipSeconds: z.coerce.number().int().refine((n) => [4, 6, 8].includes(n), "4, 6 hoặc 8 giây"),
  scenesPerVariant: z.coerce.number().int().min(1).max(VIDEO_SCALE_HARD_LIMITS.maxScenesPerVariant),
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
});

export const videoSkuModeSchema = z.object({ productId: id, reviewMode: z.enum(VIDEO_REVIEW_MODES) });

/** Nhạc: base64 ≤ ~7 MB (trần thân Server Action 8 MB). */
export const videoMusicUploadSchema = z.object({
  title: z.string().trim().min(1).max(120),
  licenseNote: z.string().trim().min(10, "Khai nguồn + quyền sử dụng (ít nhất 10 ký tự)").max(500),
  contentType: z.enum(["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/x-m4a"]),
  base64: z.string().min(10).max(10_000_000),
});
