/**
 * ═══════════ VIDEO SCALE CHO MÃ WIN — HỢP ĐỒNG CHUNG ═══════════
 *
 * Đặc tả: `docs/video-scale.md`. Tệp này giữ MỌI con số, MỌI trần và MỌI từ vựng của module — một cái
 * trần rải ra hai nơi là một cái trần sẽ có hai giá trị (cùng luật với `lib/constants/creative-loop.ts`).
 *
 * Luồng một biến thể:
 *
 *   mã win + ảnh sản phẩm THẬT (người chọn)
 *     → KỊCH BẢN (LLM viết, hàm thuần kiểm: góc bán trong từ vựng đóng, giá = giá ERP, không bịa chất liệu)
 *     → CLIP (Veo image-to-video, mỗi cảnh một lời gọi, ảnh sản phẩm làm khung đầu)
 *     → HẬU KỲ (ffmpeg: ghép cảnh, giọng đọc / nhạc CÓ QUYỀN, chữ bán hàng, CTA, 9:16)
 *     → QC (kỹ thuật: tất định · hình ảnh: mô hình so khung hình với ảnh gốc) → DUYỆT (người, hoặc tự duyệt theo cấu hình)
 *
 * ─── BỐN RANH GIỚI KHÔNG ĐƯỢC XOÁ ───
 *
 *  1. **Điểm ảnh gửi máy sinh video chỉ là ảnh sản phẩm THẬT của shop** (`creative_sources.kind = 'PRODUCT_PHOTO'`,
 *     cùng ranh giới 2–3 của vòng mẫu ảnh). Ảnh SPY / tay / R&D không bao giờ tới Veo. Kiểm lại lúc chạy trong
 *     adapter (`assertVideoPixelSafe`), không tin kiểu TypeScript.
 *  2. **Không giả lập thành công.** Thiếu khoá, thiếu ffmpeg, chạm trần tiền ⇒ việc đứng ở `BLOCKED` kèm câu nói rõ
 *     thiếu gì. Nhà cung cấp lỗi ⇒ `FAILED` kèm lỗi thật. Bộ sinh GIẢ (`FAKE`) chỉ chạy khi `NODE_ENV !== 'production'`
 *     VÀ đặt `VIDEO_PROVIDER_FAKE=1`, và mọi thứ nó sinh ra mang cờ `is_test` — không đăng, không chạy QC hình ảnh.
 *  3. **Không gửi lại một lời gọi tốn tiền mà không biết lượt trước đã tới đâu.** Veo không nhận khoá chống trùng:
 *     `provider_pending_at` ghi NGAY TRƯỚC lời gọi tạo, xoá cùng lúc lưu mã thao tác. Gặp lại dấu ấy mà không có mã ⇒
 *     `FAILED · AMBIGUOUS`, chỉ NGƯỜI bấm "Thử lại" (chấp nhận rủi ro trả tiền hai lần) — máy không tự thử lại.
 *  4. **Video bị QC loại (`FAIL`) không đi tiếp.** Không duyệt được, không đăng được, không thành quảng cáo được — ràng
 *     buộc ở CSDL (`video_scale_variants_approve_check`), không chỉ ở màn hình.
 */

// ───────────────────────────── PHIÊN BẢN ─────────────────────────────

/** Tăng khi đổi câu lệnh viết kịch bản / câu lệnh Veo — lưu vào `video_scale_runs.prompt_version` để học đúng phiên bản. */
export const VIDEO_PROMPT_VERSION = 1;

/** Tăng khi đổi TỪ VỰNG GÓC BÁN. Thống kê học chỉ gộp cùng phiên bản (cùng lý do `GENE_VOCAB_VERSION`). */
export const VIDEO_ANGLE_VOCAB_VERSION = 1;

// ───────────────────────────── GÓC BÁN (TỪ VỰNG ĐÓNG) ─────────────────────────────

/**
 * Góc bán của một video — thứ máy HỌC được, nên phải là từ vựng đóng (câu tự do không đếm được).
 *
 * Mỗi góc khai thứ nó được phép nói. KHÔNG góc nào được khẳng định CHẤT LIỆU (thành phần vải) — ảnh nhìn thấy độ
 * rủ, không nhìn thấy "lụa hay polyester". Góc `FABRIC_FLOW` chỉ được nói về CHUYỂN ĐỘNG / độ rủ nhìn thấy.
 */
export const VIDEO_ANGLES = ["FLATTERING_FIT", "COVERS_FLAWS", "FABRIC_FLOW", "OCCASION", "DETAIL_CLOSEUP", "STYLING", "COLOR_OPTIONS", "PRICE_VALUE"] as const;
export type VideoAngle = (typeof VIDEO_ANGLES)[number];

export const VIDEO_ANGLE_LABEL: Record<VideoAngle, string> = {
  FLATTERING_FIT: "Tôn dáng",
  COVERS_FLAWS: "Che khuyết điểm (bắp tay, bụng…)",
  FABRIC_FLOW: "Độ rủ / chuyển động của vải",
  OCCASION: "Dịp mặc",
  DETAIL_CLOSEUP: "Cận chi tiết",
  STYLING: "Phối đồ",
  COLOR_OPTIONS: "Nhiều màu",
  PRICE_VALUE: "Giá tốt",
};

/** Góc cần một điều kiện dữ liệu mới được chọn — không có dữ liệu thì máy không được nói. Hàm THUẦN kiểm ở `planAngles`. */
export const VIDEO_ANGLE_REQUIRES: Partial<Record<VideoAngle, "PRICE" | "MULTI_COLOR">> = {
  PRICE_VALUE: "PRICE",
  COLOR_OPTIONS: "MULTI_COLOR",
};

/** Mô tả tiếng Anh gửi mô hình viết kịch bản — cố định, không để LLM tự hiểu nhãn. */
export const VIDEO_ANGLE_BRIEF: Record<VideoAngle, string> = {
  FLATTERING_FIT: "show how the garment flatters the body shape (waist, silhouette, length) through movement and turning",
  COVERS_FLAWS: "show how the cut covers common concerns (upper arms, belly, hips) — only if the reference photo shows such a cut",
  FABRIC_FLOW: "show how the fabric moves and drapes when walking or turning — never name the material",
  OCCASION: "place the garment in a fitting occasion (office, party, weekend outing, travel) consistent with its style",
  DETAIL_CLOSEUP: "slow close-up camera moves over visible details (neckline, sleeves, waist, hem, buttons, pattern)",
  STYLING: "show one simple styling idea (shoes, bag, jacket) that does not hide the garment",
  COLOR_OPTIONS: "show that the design comes in several colors (only colors that exist in the ERP variant list)",
  PRICE_VALUE: "emphasise good value; the price text is added in post-production by the system, never drawn by the video model",
};

export function isVideoAngle(x: unknown): x is VideoAngle {
  return typeof x === "string" && (VIDEO_ANGLES as readonly string[]).includes(x);
}

// ───────────────────────────── TRẠNG THÁI ─────────────────────────────

/** Một lượt "Tạo chiến dịch media" cho một mã. */
export const VIDEO_RUN_STATUSES = ["SCRIPTING", "PRODUCING", "REVIEW", "DONE", "FAILED", "CANCELLED"] as const;
export type VideoRunStatus = (typeof VIDEO_RUN_STATUSES)[number];

/**
 * Một biến thể video.
 *  · `SCRIPTED` — có kịch bản, chưa sinh clip.        · `GENERATING` — đang sinh clip (Veo).
 *  · `RENDERING` — đang hậu kỳ (ffmpeg).              · `QC` — đang kiểm chất lượng.
 *  · `REVIEW` — chờ người duyệt.                      · `APPROVED` / `REJECTED` — người (hoặc luật tự duyệt) đã quyết.
 *  · `QC_FAILED` — QC loại; KHÔNG duyệt được.         · `FAILED` — một bước sản xuất hỏng hẳn (xem việc).
 *  · `CANCELLED` — người huỷ.
 */
export const VIDEO_VARIANT_STATUSES = ["SCRIPTED", "GENERATING", "RENDERING", "QC", "REVIEW", "APPROVED", "REJECTED", "QC_FAILED", "FAILED", "CANCELLED"] as const;
export type VideoVariantStatus = (typeof VIDEO_VARIANT_STATUSES)[number];

export const VIDEO_VARIANT_STATUS_LABEL: Record<VideoVariantStatus, string> = {
  SCRIPTED: "Có kịch bản",
  GENERATING: "Đang sinh clip",
  RENDERING: "Đang hậu kỳ",
  QC: "Đang kiểm chất lượng",
  REVIEW: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Bị loại",
  QC_FAILED: "QC loại",
  FAILED: "Hỏng",
  CANCELLED: "Đã huỷ",
};

/** Loại việc trong hàng đợi. PR sau thêm `PUBLISH_REEL` · `CREATE_AD` · `METRICS` — mở rộng danh sách, không đổi nghĩa. */
export const VIDEO_JOB_KINDS = ["SCRIPT", "CLIP", "TTS", "RENDER", "QC"] as const;
export type VideoJobKind = (typeof VIDEO_JOB_KINDS)[number];

export const VIDEO_JOB_KIND_LABEL: Record<VideoJobKind, string> = {
  SCRIPT: "Viết kịch bản",
  CLIP: "Sinh clip",
  TTS: "Giọng đọc",
  RENDER: "Hậu kỳ",
  QC: "Kiểm chất lượng",
};

/**
 * Trạng thái việc.
 *  · `QUEUED` — chờ tới lượt (`next_run_at`).        · `RUNNING` — một tiến trình đang cầm (`locked_until`).
 *  · `WAITING` — đã gửi nhà cung cấp, đang chờ kết quả (hỏi lại theo `next_run_at`).
 *  · `SUCCEEDED` · `FAILED` · `CANCELLED`.
 *  · `BLOCKED` — thiếu điều kiện (khoá, ffmpeg, trần tiền). Lượt sau tự xét lại; điều kiện đủ thì về `QUEUED`.
 */
export const VIDEO_JOB_STATUSES = ["QUEUED", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"] as const;
export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];

export const VIDEO_JOB_STATUS_LABEL: Record<VideoJobStatus, string> = {
  QUEUED: "Chờ lượt",
  RUNNING: "Đang chạy",
  WAITING: "Chờ nhà cung cấp",
  SUCCEEDED: "Xong",
  FAILED: "Hỏng",
  BLOCKED: "Bị chặn",
  CANCELLED: "Đã huỷ",
};

/** Loại lỗi — quyết định có tự thử lại hay không. */
export const VIDEO_ERROR_KINDS = ["TRANSIENT", "PERMANENT", "AMBIGUOUS", "TIMEOUT", "BLOCKED"] as const;
export type VideoErrorKind = (typeof VIDEO_ERROR_KINDS)[number];

/** Loại tệp. */
export const VIDEO_ASSET_KINDS = ["SOURCE_CLIP", "VOICE", "MUSIC", "FINAL", "THUMBNAIL"] as const;
export type VideoAssetKind = (typeof VIDEO_ASSET_KINDS)[number];

/** Kết luận QC: `PASS` đi tiếp · `FLAG` chỉ NGƯỜI duyệt được (kể cả khi bật tự duyệt) · `FAIL` không đi tiếp. */
export const VIDEO_QC_VERDICTS = ["PASS", "FLAG", "FAIL"] as const;
export type VideoQcVerdict = (typeof VIDEO_QC_VERDICTS)[number];

/** Các điểm QC hình ảnh — đúng thứ chủ shop liệt kê (27/09/2026). */
export const VIDEO_QC_CHECKS = ["COLOR", "NECKLINE", "SLEEVES", "WAIST", "GARMENT_SHAPE", "BODY", "FOREIGN_TEXT_LOGO"] as const;
export type VideoQcCheck = (typeof VIDEO_QC_CHECKS)[number];

export const VIDEO_QC_CHECK_LABEL: Record<VideoQcCheck, string> = {
  COLOR: "Màu đúng ảnh gốc",
  NECKLINE: "Cổ áo đúng",
  SLEEVES: "Tay áo đúng",
  WAIST: "Eo / thân đúng",
  GARMENT_SHAPE: "Váy/áo không biến dạng",
  BODY: "Người mẫu không biến dạng",
  FOREIGN_TEXT_LOGO: "Không có chữ / logo lạ",
};

// ───────────────────────────── NHÀ CUNG CẤP VIDEO ─────────────────────────────

/**
 * Nhà cung cấp có API chính thức. `VEO` = Veo trên Gemini API (ai.google.dev). OpenAI Sora KHÔNG có mặt: API video của
 * OpenAI đã đóng ngày 24/09/2026 (developers.openai.com/api/docs/guides/video-generation, đọc 27/09/2026), và kể cả trước
 * đó nó từ chối ảnh đầu vào có mặt người — ảnh người mẫu mặc váy là đúng loại ảnh shop có. `SEEDANCE` để dành chỗ:
 * thêm adapter là thêm một tệp trong `lib/video-scale/providers/` và một dòng ở `videoProviderFor`, không sửa luồng.
 */
export const VIDEO_PROVIDERS = ["VEO", "FAKE"] as const;
export type VideoProviderId = (typeof VIDEO_PROVIDERS)[number];

export const VEO_MODELS = ["veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview", "veo-3.1-generate-preview"] as const;
export type VeoModel = (typeof VEO_MODELS)[number];

export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

/** Veo image-to-video nhận 4 · 6 · 8 giây (1080p bắt buộc 8). */
export const VEO_CLIP_SECONDS = [4, 6, 8] as const;
export type ClipSeconds = (typeof VEO_CLIP_SECONDS)[number];

/**
 * GIÁ CÔNG BỐ — USD mỗi GIÂY video, bậc trả phí (ai.google.dev/gemini-api/docs/pricing, đọc 27/09/2026). Đây là ƯỚC
 * TÍNH theo bảng giá, không phải hoá đơn: Gemini API không trả số tiền trong phản hồi. Model không có trong bảng ⇒ giá
 * CHƯA BIẾT ⇒ không sinh được (không áp được trần tiền thì không chi).
 */
export const VEO_PRICE_USD_PER_SECOND: Readonly<Record<VeoModel, Readonly<Record<VideoResolution, number>>>> = {
  "veo-3.1-generate-preview": { "720p": 0.4, "1080p": 0.4 },
  "veo-3.1-fast-generate-preview": { "720p": 0.1, "1080p": 0.12 },
  "veo-3.1-lite-generate-preview": { "720p": 0.05, "1080p": 0.08 },
};

export const VIDEO_PRICE_SOURCE = "Bảng giá công bố Gemini API (ai.google.dev/gemini-api/docs/pricing, đọc 27/09/2026) — ước tính, không phải hoá đơn.";

/** Giá một clip theo bảng. `null` = CHƯA BIẾT. Hàm THUẦN. */
export function clipCostUsd(model: string, resolution: VideoResolution, seconds: number): number | null {
  const row = (VEO_PRICE_USD_PER_SECOND as Record<string, Record<VideoResolution, number> | undefined>)[model];
  const per = row?.[resolution];
  if (per === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(per * seconds * 1_000_000) / 1_000_000;
}

// ───────────────────────────── TRẦN CỨNG ─────────────────────────────

/**
 * Trần của MÃ NGUỒN. Cấu hình (`settings["videoScale.config"]`) chỉ LÀM HẸP, không nới. Nâng một trần là một lần sửa mã
 * có người đọc.
 */
export const VIDEO_SCALE_HARD_LIMITS = {
  /** Biến thể mỗi lượt "Tạo chiến dịch media". */
  maxVariantsPerRun: 6,
  /** Cảnh (= số clip Veo) mỗi biến thể. 3 × 8 giây = 24 giây — đủ cho Reel bán hàng, trong khung 3–90 giây của Reels. */
  maxScenesPerVariant: 3,
  /** Trần chi sinh video mỗi ngày (USD). Cấu hình phải KHAI một số ≤ trần này; chưa khai ⇒ không sinh (không đoán ngân sách). */
  maxVideoUsdPerDay: 30,
  /** Clip mỗi ngày — chặn vòng lặp hỏng kể cả khi giá lỗi. */
  maxClipsPerDay: 120,
  /** Lời gọi Veo cùng lúc (đang tạo + đang chờ). */
  maxProviderConcurrency: 3,
  /** ffmpeg cùng lúc — VPS 2 nhân đang chạy Postgres + ERP; một lượt hậu kỳ là đủ. */
  maxRenderConcurrency: 1,
  /** Một tệp video (byte). */
  maxAssetBytes: 60 * 1024 * 1024,
  /** Tổng dung lượng tệp của module (byte) — cùng lý do trần 3 GB của tệp topic: tệp nằm trong CSDL và bản sao lưu. */
  maxTotalAssetBytes: 4 * 1024 * 1024 * 1024,
} as const;

/** Khúc lưu tệp — cùng cỡ với tệp topic sản xuất. */
export const VIDEO_ASSET_CHUNK_BYTES = 2 * 1024 * 1024;

/** Số lần thử TỰ ĐỘNG tối đa, theo loại việc. Chỉ lỗi `TRANSIENT` / `TIMEOUT` được tự thử lại. */
export const VIDEO_JOB_MAX_ATTEMPTS: Record<VideoJobKind, number> = { SCRIPT: 2, CLIP: 3, TTS: 3, RENDER: 2, QC: 3 };

/** Trần thời gian MỘT lượt cầm việc (ms). Quá ⇒ lượt sau coi là chết và nhả (`TIMEOUT`). */
export const VIDEO_JOB_LEASE_MS: Record<VideoJobKind, number> = { SCRIPT: 4 * 60_000, CLIP: 3 * 60_000, TTS: 2 * 60_000, RENDER: 8 * 60_000, QC: 3 * 60_000 };

/** Trần tổng thời gian chờ nhà cung cấp cho một clip — Veo thường 1–6 phút; quá 20 phút coi như hỏng. */
export const VIDEO_CLIP_DEADLINE_MS = 20 * 60_000;

/** Nhịp hỏi lại Veo khi thao tác chưa xong. */
export const VIDEO_POLL_INTERVAL_MS = 20_000;

/** Lùi dần khi lỗi tạm thời: 1 → 4 → 16 phút, trần 30 phút. Hàm THUẦN. */
export function retryDelayMs(attempt: number): number {
  const a = Math.max(1, Math.floor(attempt));
  return Math.min(30 * 60_000, 60_000 * 4 ** (a - 1));
}

// ───────────────────────────── CẤU HÌNH ─────────────────────────────

export const VIDEO_SCALE_CONFIG_KEY = "videoScale.config";

export type VideoScaleConfig = {
  /** Công tắc mềm: tắt ⇒ lượt chạy không bắt đầu việc tốn tiền mới (việc đang chờ Veo vẫn được hỏi kết quả để không mất clip đã trả tiền). */
  enabled: boolean;
  provider: VideoProviderId;
  model: VeoModel;
  resolution: VideoResolution;
  clipSeconds: ClipSeconds;
  scenesPerVariant: number;
  /** Trần chi sinh video mỗi ngày (USD). `null` = CHƯA KHAI ⇒ không sinh. */
  dailyUsdCap: number | null;
  dailyClipCap: number;
  providerConcurrency: number;
  /** Giọng đọc (OpenAI TTS). Tắt ⇒ chỉ phụ đề + âm thanh gốc của clip / nhạc. */
  voiceover: boolean;
  voice: string;
  /** Giữ âm thanh Veo tự sinh. Có giọng đọc / nhạc thì âm gốc được hạ nhỏ. */
  keepNativeAudio: boolean;
  /** Phụ đề đốt vào hình (từ lời đọc). */
  burnSubtitles: boolean;
  /** Kích thước bản hoàn chỉnh. Reels khuyên 1080×1920, tối thiểu 540×960. */
  outputHeight: 1280 | 1920;
  /**
   * Câu CHÍNH SÁCH BÁN HÀNG người đã khai (vd "Mua 2 sản phẩm miễn phí vận chuyển"). Là nguồn DUY NHẤT cho mọi khuyến
   * mãi / miễn ship / quà tặng trên kịch bản và câu chữ — không có dòng nào ⇒ không câu khuyến mãi nào được viết.
   */
  policyLines: string[];
};

export const DEFAULT_VIDEO_SCALE_CONFIG: VideoScaleConfig = {
  enabled: false,
  provider: "VEO",
  model: "veo-3.1-fast-generate-preview",
  resolution: "720p",
  clipSeconds: 8,
  scenesPerVariant: 2,
  dailyUsdCap: null,
  dailyClipCap: 40,
  providerConcurrency: 2,
  voiceover: false,
  voice: "marin",
  keepNativeAudio: true,
  burnSubtitles: true,
  outputHeight: 1280,
  policyLines: [],
};

export const POLICY_LINES_MAX = 5;
export const POLICY_LINE_MAX_CHARS = 160;

/** Giọng OpenAI TTS (developers.openai.com/api/docs/guides/text-to-speech, đọc 27/09/2026). */
export const TTS_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
export const TTS_MODEL = "gpt-4o-mini-tts";

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Đọc cấu hình từ nguồn không tin được (settings JSON). Giá trị lạ ⇒ mặc định; số ⇒ kẹp vào trần cứng (chỉ LÀM HẸP).
 * `dailyUsdCap` không số dương ⇒ `null` (CHƯA KHAI), không bao giờ 0 giả. Hàm THUẦN.
 */
export function normalizeVideoScaleConfig(raw: unknown): VideoScaleConfig {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_VIDEO_SCALE_CONFIG;
  const L = VIDEO_SCALE_HARD_LIMITS;
  const model = (VEO_MODELS as readonly string[]).includes(String(r.model)) ? (r.model as VeoModel) : d.model;
  const resolution = (VIDEO_RESOLUTIONS as readonly string[]).includes(String(r.resolution)) ? (r.resolution as VideoResolution) : d.resolution;
  let clipSeconds = (VEO_CLIP_SECONDS as readonly number[]).includes(Number(r.clipSeconds)) ? (Number(r.clipSeconds) as ClipSeconds) : d.clipSeconds;
  // Veo: 1080p bắt buộc 8 giây — cấu hình trái luật thì theo luật của nhà cung cấp, không gửi một yêu cầu chắc chắn bị từ chối.
  if (resolution === "1080p") clipSeconds = 8;
  const cap = typeof r.dailyUsdCap === "number" ? r.dailyUsdCap : typeof r.dailyUsdCap === "string" && r.dailyUsdCap.trim() !== "" ? Number(r.dailyUsdCap) : NaN;
  return {
    enabled: r.enabled === true,
    provider: r.provider === "FAKE" ? "FAKE" : "VEO",
    model,
    resolution,
    clipSeconds,
    scenesPerVariant: clampInt(r.scenesPerVariant, 1, L.maxScenesPerVariant, d.scenesPerVariant),
    dailyUsdCap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, L.maxVideoUsdPerDay) : null,
    dailyClipCap: clampInt(r.dailyClipCap, 1, L.maxClipsPerDay, d.dailyClipCap),
    providerConcurrency: clampInt(r.providerConcurrency, 1, L.maxProviderConcurrency, d.providerConcurrency),
    voiceover: r.voiceover === true,
    voice: (TTS_VOICES as readonly string[]).includes(String(r.voice)) ? String(r.voice) : d.voice,
    keepNativeAudio: r.keepNativeAudio !== false,
    burnSubtitles: r.burnSubtitles !== false,
    outputHeight: Number(r.outputHeight) === 1920 ? 1920 : 1280,
    policyLines: Array.isArray(r.policyLines)
      ? r.policyLines
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.replace(/\s+/g, " ").trim().slice(0, POLICY_LINE_MAX_CHARS))
          .filter(Boolean)
          .slice(0, POLICY_LINES_MAX)
      : [],
  };
}

/** Kích thước khung ra (9:16) theo chiều cao. Hàm THUẦN. */
export function outputSize(height: 1280 | 1920): { width: number; height: number } {
  return height === 1920 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}

// ───────────────────────────── CẤU HÌNH THEO MÃ ─────────────────────────────

/**
 * Duyệt video theo mã: `MANUAL` (mặc định — người duyệt từng video) · `AUTO_ON_PASS` (QC hình ảnh `PASS` thì máy tự
 * duyệt; `FLAG` vẫn chờ người). Bật `AUTO_ON_PASS` là một quyết định có người, ghi nhật ký.
 */
export const VIDEO_REVIEW_MODES = ["MANUAL", "AUTO_ON_PASS"] as const;
export type VideoReviewMode = (typeof VIDEO_REVIEW_MODES)[number];

export const VIDEO_REVIEW_MODE_LABEL: Record<VideoReviewMode, string> = {
  MANUAL: "Người duyệt từng video",
  AUTO_ON_PASS: "Tự duyệt khi QC đạt (QC nghi ngờ vẫn chờ người)",
};

// ───────────────────────────── KỊCH BẢN ─────────────────────────────

export const SCRIPT_LIMITS = {
  hookMaxChars: 60,
  overlayMaxChars: 48,
  voiceoverMaxCharsPerScene: 160,
  ctaMaxChars: 40,
  scenePromptMaxChars: 900,
} as const;

/** Một cảnh = một clip Veo. `overlay` là chữ bán hàng đốt vào hình; `voiceover` là lời đọc (và phụ đề) của cảnh. */
export type VideoScene = { prompt: string; overlay: string; voiceover: string };

export type VideoScript = {
  angle: VideoAngle;
  hook: string;
  scenes: VideoScene[];
  cta: string;
};

/**
 * Dấu vân tay chống lặp: chữ thường, bỏ dấu, bỏ ký tự lạ, gom từ. Hai kịch bản có Jaccard ≥ `DUPLICATE_THRESHOLD` trên
 * tập từ của (móc câu + chữ trên hình + lời đọc) coi là "gần giống" ⇒ không sinh lần hai. Hàm THUẦN.
 */
export function scriptTokens(s: Pick<VideoScript, "hook" | "scenes" | "cta">): Set<string> {
  const text = [s.hook, s.cta, ...s.scenes.flatMap((c) => [c.overlay, c.voiceover])].join(" ");
  const plain = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase();
  return new Set(plain.split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
}

export const DUPLICATE_THRESHOLD = 0.6;

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Bộ sinh giả chỉ được bật ngoài production (ranh giới 2). Hàm THUẦN trên các biến truyền vào. */
export function fakeProviderAllowed(nodeEnv: string | undefined, flag: string | undefined): boolean {
  return nodeEnv !== "production" && flag === "1";
}
