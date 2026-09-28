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

/** Loại việc trong hàng đợi. Mở rộng danh sách, không đổi nghĩa một loại đã có. */
export const VIDEO_JOB_KINDS = ["SCRIPT", "CLIP", "TTS", "RENDER", "QC", "CAPTION", "PUBLISH_REEL", "CREATE_AD", "PAUSE_AD"] as const;
export type VideoJobKind = (typeof VIDEO_JOB_KINDS)[number];

export const VIDEO_JOB_KIND_LABEL: Record<VideoJobKind, string> = {
  SCRIPT: "Viết kịch bản",
  CLIP: "Sinh clip",
  TTS: "Giọng đọc",
  RENDER: "Hậu kỳ",
  QC: "Kiểm chất lượng",
  CAPTION: "Viết content",
  PUBLISH_REEL: "Đăng Reel",
  CREATE_AD: "Tạo quảng cáo",
  PAUSE_AD: "Tắt quảng cáo",
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
 * Nhà cung cấp có API chính thức. `VEO` = Veo trên Gemini API (ai.google.dev). `OMNI` = Gemini Omni Flash trên CÙNG Gemini
 * API, cùng khoá `GEMINI_API_KEY` (Interactions API — ai.google.dev/gemini-api/docs/omni, đọc 28/09/2026). OpenAI Sora KHÔNG có mặt: API video của
 * OpenAI đã đóng ngày 24/09/2026 (developers.openai.com/api/docs/guides/video-generation, đọc 27/09/2026), và kể cả trước
 * đó nó từ chối ảnh đầu vào có mặt người — ảnh người mẫu mặc váy là đúng loại ảnh shop có. `SEEDANCE` để dành chỗ:
 * thêm adapter là thêm một tệp trong `lib/video-scale/providers/` và một dòng ở `videoProviderFor`, không sửa luồng.
 */
export const VIDEO_PROVIDERS = ["VEO", "OMNI", "FAKE"] as const;
/** Nhà cung cấp người chọn được trên màn hình — bộ sinh GIẢ không bao giờ nằm ở đây. */
export const SELECTABLE_VIDEO_PROVIDERS = ["VEO", "OMNI"] as const;
export const VIDEO_PROVIDER_LABEL: Record<VideoProviderId, string> = {
  VEO: "Veo 3.1 (Gemini API)",
  OMNI: "Gemini Omni Flash (Gemini API)",
  FAKE: "Bộ sinh GIẢ (chỉ ngoài production)",
};
export type VideoProviderId = (typeof VIDEO_PROVIDERS)[number];

export const VEO_MODELS = ["veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview", "veo-3.1-generate-preview"] as const;
export type VeoModel = (typeof VEO_MODELS)[number];

export const OMNI_MODELS = ["gemini-omni-1.1-flash"] as const;
export type OmniModel = (typeof OMNI_MODELS)[number];

export type VideoModel = VeoModel | OmniModel;
export const VIDEO_MODELS: readonly VideoModel[] = [...VEO_MODELS, ...OMNI_MODELS];

/** Model thuộc nhà cung cấp nào — model lạ ⇒ `null`. Hàm THUẦN. */
export function providerOfModel(model: string): "VEO" | "OMNI" | null {
  if ((VEO_MODELS as readonly string[]).includes(model)) return "VEO";
  if ((OMNI_MODELS as readonly string[]).includes(model)) return "OMNI";
  return null;
}

/**
 * Omni KHÔNG có tham số độ dài đã công bố (tài liệu ghi 3–10 giây, không có ví dụ trường `duration`) — độ dài mong muốn đi
 * vào câu lệnh, và TIỀN GIỮ CHỖ tính theo độ dài TỐI ĐA để trần ngày không bao giờ bị vượt vì một clip dài hơn dự kiến.
 */
export const OMNI_MAX_CLIP_SECONDS = 10;

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
export const VEO_PRICE_USD_PER_SECOND: Readonly<Record<VideoModel, Readonly<Partial<Record<VideoResolution, number>>>>> = {
  // Omni tính theo TOKEN ra: 5.792 token / giây video 720p × 17,50 USD / 1 triệu token ≈ 0,1014 USD / giây. Bảng chính thức
  // KHÔNG ghi số token của 1080p ⇒ 1080p để trống ⇒ giá CHƯA BIẾT ⇒ không sinh (không áp được trần thì không chi).
  "gemini-omni-1.1-flash": { "720p": 0.1014 },
  "veo-3.1-generate-preview": { "720p": 0.4, "1080p": 0.4 },
  "veo-3.1-fast-generate-preview": { "720p": 0.1, "1080p": 0.12 },
  "veo-3.1-lite-generate-preview": { "720p": 0.05, "1080p": 0.08 },
};

export const VIDEO_PRICE_SOURCE = "Bảng giá công bố Gemini API (ai.google.dev/gemini-api/docs/pricing, đọc 27/09/2026) — ước tính, không phải hoá đơn.";

/**
 * Số giây GIỮ CHỖ trước lời gọi tạo: Veo tính đúng độ dài xin; Omni có thể trả tới 10 giây ⇒ giữ chỗ 10. Hàm THUẦN.
 */
export function reserveSecondsFor(provider: VideoProviderId, clipSeconds: number): number {
  return provider === "OMNI" ? OMNI_MAX_CLIP_SECONDS : clipSeconds;
}

/**
 * Số giây GHI TIỀN sau khi có clip: Veo = độ dài xin; Omni = độ dài ĐO ĐƯỢC của clip (tính tiền theo giây video ra), không đo
 * được ⇒ độ dài tối đa (ước tính phía cao, không bao giờ phía thấp). Hàm THUẦN.
 */
export function billedSecondsFor(provider: VideoProviderId, clipSeconds: number, probedSec: number | null): number {
  if (provider !== "OMNI") return clipSeconds;
  return probedSec !== null && Number.isFinite(probedSec) && probedSec > 0 ? Math.min(probedSec, OMNI_MAX_CLIP_SECONDS) : OMNI_MAX_CLIP_SECONDS;
}

/** Giá một clip theo bảng. `null` = CHƯA BIẾT. Hàm THUẦN. */
export function clipCostUsd(model: string, resolution: VideoResolution, seconds: number): number | null {
  const row = (VEO_PRICE_USD_PER_SECOND as Record<string, Partial<Record<VideoResolution, number>> | undefined>)[model];
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
export const VIDEO_JOB_MAX_ATTEMPTS: Record<VideoJobKind, number> = { SCRIPT: 2, CLIP: 3, TTS: 3, RENDER: 2, QC: 3, CAPTION: 2, PUBLISH_REEL: 4, CREATE_AD: 3, PAUSE_AD: 6 };

/** Trần thời gian MỘT lượt cầm việc (ms). Quá ⇒ lượt sau coi là chết và nhả (`TIMEOUT`). */
export const VIDEO_JOB_LEASE_MS: Record<VideoJobKind, number> = { SCRIPT: 4 * 60_000, CLIP: 3 * 60_000, TTS: 2 * 60_000, RENDER: 8 * 60_000, QC: 3 * 60_000, CAPTION: 3 * 60_000, PUBLISH_REEL: 6 * 60_000, CREATE_AD: 6 * 60_000, PAUSE_AD: 2 * 60_000 };

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
  model: VideoModel;
  resolution: VideoResolution;
  clipSeconds: ClipSeconds;
  scenesPerVariant: number;
  /**
   * Số cảnh ĐẦU mỗi video do AI sinh; các cảnh sau là ẢNH ĐỘNG (dựng bằng ffmpeg từ chính ảnh sản phẩm — miễn phí, đúng
   * sản phẩm tuyệt đối). `null` = mọi cảnh dùng AI; `0` = video miễn phí hoàn toàn.
   */
  aiScenes: number | null;
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
  /** Trần ngân sách ngày của TẤT CẢ quảng cáo Video Scale đang chạy (VND). `null` = CHƯA KHAI ⇒ không bật quảng cáo nào. */
  adsGlobalDailyCapVnd: number | null;
  /**
   * Mẩu quảng cáo MẪU (id Facebook) — máy chép đối tượng / mục tiêu tối ưu / đích tin nhắn / nút kêu gọi từ đây, không tự đoán.
   * Rỗng ⇒ dùng mẩu mẫu của Thư viện Media (`creative.config.templateAdId`).
   */
  adTemplateAdId: string;
  /** Khung chấm một quảng cáo (ngày, từ lúc bật): hết khung mới kết luận theo luật GIỮ; luật TẮT xét mọi lúc. */
  optimizeWindowDays: number;
  /** Bước tăng ngân sách khi quảng cáo tốt (0,05–0,3; cổng vẫn chặn trên 30%). */
  scaleStepPct: number;
  /**
   * Số đơn chốt TỐI THIỂU quy về quảng cáo trước khi máy được TỰ tăng ngân sách (mã phải bật `auto_scale`). `null` =
   * CHƯA KHAI ⇒ máy chỉ ĐỀ NGHỊ tăng, không tự tăng — ít dữ liệu thì không ra quyết định tiêu thêm tiền.
   */
  autoScaleMinOrders: number | null;
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
  aiScenes: null,
  dailyUsdCap: null,
  dailyClipCap: 40,
  providerConcurrency: 2,
  voiceover: false,
  voice: "marin",
  keepNativeAudio: true,
  burnSubtitles: true,
  outputHeight: 1280,
  policyLines: [],
  adsGlobalDailyCapVnd: null,
  adTemplateAdId: "",
  optimizeWindowDays: 3,
  scaleStepPct: 0.2,
  autoScaleMinOrders: null,
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
  const provider: VideoProviderId = r.provider === "FAKE" ? "FAKE" : r.provider === "OMNI" ? "OMNI" : "VEO";
  // Model phải THUỘC nhà cung cấp; lệch ⇒ model mặc định của nhà cung cấp đó (không gửi model Veo sang Omni và ngược lại).
  const want = providerOfModel(String(r.model));
  const model: VideoModel =
    provider === "OMNI" ? (want === "OMNI" ? (r.model as OmniModel) : OMNI_MODELS[0]) : want === "VEO" ? (r.model as VeoModel) : (d.model as VeoModel);
  // Omni: bảng giá chính thức chỉ có 720p ⇒ ép 720p (1080p sẽ là giá CHƯA BIẾT và bị chặn ở từng clip).
  const resolution: VideoResolution =
    provider === "OMNI" ? "720p" : (VIDEO_RESOLUTIONS as readonly string[]).includes(String(r.resolution)) ? (r.resolution as VideoResolution) : d.resolution;
  let clipSeconds = (VEO_CLIP_SECONDS as readonly number[]).includes(Number(r.clipSeconds)) ? (Number(r.clipSeconds) as ClipSeconds) : d.clipSeconds;
  // Veo: 1080p bắt buộc 8 giây — cấu hình trái luật thì theo luật của nhà cung cấp, không gửi một yêu cầu chắc chắn bị từ chối.
  if (provider !== "OMNI" && resolution === "1080p") clipSeconds = 8;
  const cap = typeof r.dailyUsdCap === "number" ? r.dailyUsdCap : typeof r.dailyUsdCap === "string" && r.dailyUsdCap.trim() !== "" ? Number(r.dailyUsdCap) : NaN;
  return {
    enabled: r.enabled === true,
    provider,
    model,
    resolution,
    clipSeconds,
    scenesPerVariant: clampInt(r.scenesPerVariant, 1, L.maxScenesPerVariant, d.scenesPerVariant),
    aiScenes: r.aiScenes === null || r.aiScenes === undefined || r.aiScenes === "" ? null : clampInt(r.aiScenes, 0, L.maxScenesPerVariant, 0),
    dailyUsdCap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, L.maxVideoUsdPerDay) : null,
    dailyClipCap: clampInt(r.dailyClipCap, 1, L.maxClipsPerDay, d.dailyClipCap),
    providerConcurrency: clampInt(r.providerConcurrency, 1, L.maxProviderConcurrency, d.providerConcurrency),
    voiceover: r.voiceover === true,
    voice: (TTS_VOICES as readonly string[]).includes(String(r.voice)) ? String(r.voice) : d.voice,
    keepNativeAudio: r.keepNativeAudio !== false,
    burnSubtitles: r.burnSubtitles !== false,
    outputHeight: Number(r.outputHeight) === 1920 ? 1920 : 1280,
    adsGlobalDailyCapVnd: (() => {
      const g = typeof r.adsGlobalDailyCapVnd === "number" ? r.adsGlobalDailyCapVnd : typeof r.adsGlobalDailyCapVnd === "string" && r.adsGlobalDailyCapVnd.trim() !== "" ? Number(r.adsGlobalDailyCapVnd) : NaN;
      return Number.isFinite(g) && g > 0 ? Math.min(Math.round(g), VIDEO_ADS_HARD_LIMITS.maxGlobalDailyVnd) : null;
    })(),
    adTemplateAdId: typeof r.adTemplateAdId === "string" && /^[0-9]{5,25}$/.test(r.adTemplateAdId.trim()) ? r.adTemplateAdId.trim() : "",
    optimizeWindowDays: clampInt(r.optimizeWindowDays, 1, 14, d.optimizeWindowDays),
    scaleStepPct: typeof r.scaleStepPct === "number" && r.scaleStepPct >= 0.05 && r.scaleStepPct <= VIDEO_ADS_HARD_LIMITS.maxStepPct ? r.scaleStepPct : d.scaleStepPct,
    autoScaleMinOrders: (() => {
      const n = typeof r.autoScaleMinOrders === "number" ? r.autoScaleMinOrders : typeof r.autoScaleMinOrders === "string" && r.autoScaleMinOrders.trim() !== "" ? Number(r.autoScaleMinOrders) : NaN;
      return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
    })(),
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

// ───────────────────────────── CONTENT + ĐĂNG REEL (PR 2) ─────────────────────────────

/** Chế độ đăng của một FANPAGE. Fanpage chưa có dòng cấu hình = `MANUAL_REVIEW` (mặc định an toàn). */
export const VIDEO_PUBLISH_MODES = ["MANUAL_REVIEW", "AUTO_PUBLISH"] as const;
export type VideoPublishMode = (typeof VIDEO_PUBLISH_MODES)[number];

export const VIDEO_PUBLISH_MODE_LABEL: Record<VideoPublishMode, string> = {
  MANUAL_REVIEW: "Chờ người bấm đăng từng bài",
  AUTO_PUBLISH: "Tự đăng video đã duyệt (trong trần bài / ngày)",
};

/**
 * Chế độ đăng THỰC của một mã trên fanpage đã gán. Tự đăng chỉ khi fanpage bật `AUTO_PUBLISH` VÀ mã không ép
 * `MANUAL_REVIEW`. Thiếu dòng cấu hình fanpage ⇒ chờ người. Hàm THUẦN.
 */
export function effectivePublishMode(page: { publishMode: string } | null, sku: { publishMode: string | null } | null): VideoPublishMode {
  if (!page || page.publishMode !== "AUTO_PUBLISH") return "MANUAL_REVIEW";
  if (sku?.publishMode === "MANUAL_REVIEW") return "MANUAL_REVIEW";
  return "AUTO_PUBLISH";
}

export const VIDEO_POST_STATUSES = ["QUEUED", "UPLOADING", "PROCESSING", "SCHEDULED", "PUBLISHED", "FAILED", "CANCELLED"] as const;
export type VideoPostStatus = (typeof VIDEO_POST_STATUSES)[number];

export const VIDEO_POST_STATUS_LABEL: Record<VideoPostStatus, string> = {
  QUEUED: "Chờ đăng",
  UPLOADING: "Đang tải lên",
  PROCESSING: "Facebook đang xử lý",
  SCHEDULED: "Đã hẹn giờ",
  PUBLISHED: "Đã đăng",
  FAILED: "Lỗi",
  CANCELLED: "Đã huỷ",
};

/** Khung Reels của Facebook (developers.facebook.com/docs/video-api/guides/reels-publishing, đọc 27/09/2026). */
export const REEL_LIMITS = {
  minSeconds: 3,
  maxSeconds: 90,
  /** Hẹn giờ: ≥ 10 phút tới, ≤ 29 ngày. */
  scheduleMinLeadMs: 10 * 60_000,
  scheduleMaxLeadMs: 29 * 86_400_000,
  /** Nhịp hỏi trạng thái Reel sau khi gửi. */
  pollMs: 30_000,
  /** Quá thời gian này mà Facebook chưa xử lý xong ⇒ báo lỗi để người xem. */
  processingDeadlineMs: 45 * 60_000,
} as const;

/** Lỗi hẹn giờ, hoặc `null` nếu được. `null` giờ hẹn = đăng ngay. Hàm THUẦN. */
export function scheduleProblem(publishAt: Date | null, now: Date): string | null {
  if (!publishAt) return null;
  const lead = publishAt.getTime() - now.getTime();
  if (lead < REEL_LIMITS.scheduleMinLeadMs) return "Giờ hẹn phải cách hiện tại ít nhất 10 phút (luật Facebook).";
  if (lead > REEL_LIMITS.scheduleMaxLeadMs) return "Facebook chỉ cho hẹn trong vòng 29 ngày.";
  return null;
}

export const CAPTION_LIMITS = { hookMaxChars: 90, bodyMaxChars: 700, ctaMaxChars: 80, hashtagMin: 2, hashtagMax: 6, hashtagMaxChars: 30, totalMaxChars: 1500, options: 3 } as const;

export type CaptionOption = { hook: string; body: string; cta: string; hashtags: string[] };

/** Ghép một phương án thành content đăng. Hàm THUẦN. */
export function composeCaption(o: CaptionOption): string {
  const tags = o.hashtags.map((h) => `#${h.replace(/^#+/, "").replace(/\s+/g, "")}`).filter((h) => h.length > 1);
  return [o.hook.trim(), o.body.trim(), o.cta.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
}

// ───────────────────────────── DỪNG KHẨN CẤP TOÀN MODULE ─────────────────────────────

/**
 * Công tắc DỪNG MỌI TỰ ĐỘNG của Video Scale (đăng Reel, tạo / bật quảng cáo, tăng ngân sách) — `settings` khoá này.
 * Tách khỏi `ads.write.kill` (công tắc của MỌI đường ghi quảng cáo): dừng Video Scale không được dừng vòng mẫu ảnh đang
 * chạy của marketer. Cả hai cùng áp: công tắc quảng cáo kéo thì Video Scale cũng không ghi được Facebook.
 *
 * FAIL-CLOSED: không đọc được / JSON hỏng / `paused` không phải đúng `true`·`false` ⇒ coi như ĐANG DỪNG. Không có dòng
 * nào = chưa ai kéo = chạy.
 */
export const VIDEO_AUTOMATION_KEY = "videoScale.automation";

export type VideoAutomationState = { paused: boolean; reason: string; by: string; at: string; unreadable: boolean };

export function parseVideoAutomation(raw: { ok: true; value: string | null } | { ok: false; error: string }): VideoAutomationState {
  if (!raw.ok) return { paused: true, reason: `Không đọc được công tắc: ${raw.error}`, by: "", at: "", unreadable: true };
  if (raw.value === null) return { paused: false, reason: "", by: "", at: "", unreadable: false };
  try {
    const o = JSON.parse(raw.value) as Record<string, unknown>;
    if (o.paused !== true && o.paused !== false) return { paused: true, reason: "Công tắc hỏng (paused không phải true/false) — coi như ĐANG DỪNG.", by: "", at: "", unreadable: true };
    return { paused: o.paused, reason: typeof o.reason === "string" ? o.reason : "", by: typeof o.by === "string" ? o.by : "", at: typeof o.at === "string" ? o.at : "", unreadable: false };
  } catch {
    return { paused: true, reason: "Công tắc hỏng (JSON) — coi như ĐANG DỪNG.", by: "", at: "", unreadable: true };
  }
}

/** Quyền Facebook mà việc đăng Reel cần (tài liệu Reels Publishing). `read_insights` cho số đo bài (PR 4). */
export const FB_PAGE_PUBLISH_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"] as const;

// ───────────────────────────── QUẢNG CÁO META (PR 3) ─────────────────────────────

/**
 * Chế độ quảng cáo THEO MÃ:
 *  · `DRAFT`          — máy chỉ LẬP bản nháp trong ERP (tên, ngân sách, nội dung); không một lời gọi Facebook nào.
 *  · `PUBLISH_PAUSED` — máy dựng chiến dịch / nhóm / quảng cáo trên Facebook, chiến dịch TẮT; người bấm "Bật".
 *  · `AUTO_LAUNCH`    — máy dựng rồi TỰ BẬT khi video + bài Reel đạt điều kiện, đúng mapping, còn ngân sách, có luật tắt.
 *    Bật chế độ này là MỘT lần duyệt có người đứng tên (ghi nhật ký) cho một phong bì tiền đã khai — không phải AUTO của
 *    nấc quyền quảng cáo (`MAX_ALLOWED_ADS_WRITE_MODE` vẫn là COPILOT; chốt env + công tắc khẩn cấp vẫn áp từng lời ghi).
 */
export const VIDEO_ADS_MODES = ["DRAFT", "PUBLISH_PAUSED", "AUTO_LAUNCH"] as const;
export type VideoAdsMode = (typeof VIDEO_ADS_MODES)[number];

export const VIDEO_ADS_MODE_LABEL: Record<VideoAdsMode, string> = {
  DRAFT: "Chỉ lập nháp trong ERP",
  PUBLISH_PAUSED: "Dựng trên Facebook, TẮT — người bấm bật",
  AUTO_LAUNCH: "Tự dựng + tự bật trong trần ngân sách",
};

export const VIDEO_AD_STATUSES = ["DRAFT", "QUEUED", "CREATING", "PAUSED", "ACTIVE", "FAILED", "STOPPED"] as const;
export type VideoAdStatus = (typeof VIDEO_AD_STATUSES)[number];

export const VIDEO_AD_STATUS_LABEL: Record<VideoAdStatus, string> = {
  DRAFT: "Nháp (chưa lên Facebook)",
  QUEUED: "Chờ dựng",
  CREATING: "Đang dựng",
  PAUSED: "Đã dựng, đang TẮT",
  ACTIVE: "Đang chạy",
  FAILED: "Lỗi",
  STOPPED: "Đã dừng",
};

/**
 * TRẦN CỨNG của quảng cáo Video Scale (VND / NGÀY) — cùng mức với scale mẫu thắng của vòng mẫu ảnh (chủ shop 24/09/2026:
 * 500.000đ / ngày mỗi chiến dịch, tổng 5.000.000đ). Cấu hình theo mã / toàn module chỉ LÀM HẸP. Chưa khai trần mã / trần
 * toàn module ⇒ không bật được quảng cáo nào (máy không đoán ngân sách).
 */
export const VIDEO_ADS_HARD_LIMITS = {
  minDailyBudgetVnd: 20_000,
  maxDailyBudgetPerAdVnd: 500_000,
  maxSkuDailyVnd: 2_000_000,
  maxGlobalDailyVnd: 5_000_000,
  /** Một lần tăng ngân sách tối đa +30% (cùng `ADS_WRITE_LIMITS.maxStepPct`). */
  maxStepPct: 0.3,
  /** Mỗi quảng cáo tối đa một lần đổi ngân sách mỗi ngày. */
  maxBudgetChangesPerDay: 1,
} as const;

export type VideoAdAction = "CREATE" | "ACTIVATE" | "SET_BUDGET" | "PAUSE";

export const VIDEO_AD_DENIALS = [
  "WRITE_CLOSED",
  "AUTOMATION_PAUSED",
  "SKU_PAUSED",
  "PAGE_PAUSED",
  "NOT_APPROVED",
  "TEST_DATA",
  "QC_FAILED",
  "REEL_NOT_PUBLISHED",
  "MAPPING_CHANGED",
  "NO_AD_ACCOUNT",
  "NO_TEMPLATE",
  "NO_KILL_RULES", "NO_OPTIMIZER",
  "NO_BUDGET",
  "BELOW_MIN_BUDGET",
  "OVER_AD_CAP",
  "OVER_SKU_CAP",
  "OVER_GLOBAL_CAP",
  "STEP_TOO_BIG",
  "RATE_LIMIT",
  "NOT_ON_FACEBOOK",
] as const;
export type VideoAdDenial = (typeof VIDEO_AD_DENIALS)[number];

export type VideoAdGateInput = {
  action: VideoAdAction;
  /** Lý do đường ghi Facebook đang đóng (`adsWriteDisabledReason()`), `null` = mở. */
  writeClosed: string | null;
  automationPaused: boolean;
  skuPaused: boolean;
  pagePaused: boolean;
  variant: { approved: boolean; isTest: boolean; qcFailed: boolean };
  reelPublished: boolean;
  mappingOk: boolean;
  adAccountId: string | null;
  templateAdId: string | null;
  killRules: number;
  /** Vòng tối ưu (thứ chạy luật tắt) đã im lặng quá `OPTIMIZER_MAX_SILENCE_MS`, hoặc chưa chạy lần nào. */
  optimizerSilent: boolean;
  /** Đã có id Facebook (chiến dịch) — bật / đổi ngân sách / tắt cần. */
  onFacebook: boolean;
  /** Ngân sách ngày của quảng cáo NÀY sau hành động (VND). */
  budgetVnd: number | null;
  /** Ngân sách ngày hiện tại trên Facebook (đổi ngân sách). */
  currentBudgetVnd: number | null;
  budgetChangesToday: number;
  caps: { perAdVnd: number | null; skuVnd: number | null; globalVnd: number | null };
  /** Tổng ngân sách ngày của quảng cáo ĐANG CHẠY (không tính quảng cáo này). */
  activeSkuVnd: number;
  activeGlobalVnd: number;
};

export type VideoAdGate = { allow: true } | { allow: false; denial: VideoAdDenial; reason: string };

const deny = (denial: VideoAdDenial, reason: string): VideoAdGate => ({ allow: false, denial, reason });
const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;

/**
 * CỔNG GHI QUẢNG CÁO CỦA VIDEO SCALE — hàm THUẦN, thứ tự chốt cố định (kiểm thử khoá cả thứ tự).
 *
 * `PAUSE` luôn được (tắt chỉ làm GIẢM tiền — kể cả khi mọi công tắc đang kéo; `graphPost` cũng để `status=PAUSED` đi qua
 * công tắc khẩn cấp). Mọi hành động khác đi qua: đường ghi mở → không dừng khẩn cấp ở cấp nào → video đã duyệt, không phải
 * dữ liệu thử, QC không loại → bài Reel đã đăng + fanpage chưa đổi → có tài khoản quảng cáo + mẩu mẫu → (bật / đổi ngân sách)
 * có luật tắt → ngân sách hợp lệ và trong ba trần: quảng cáo · mã · toàn module.
 */
export function gateVideoAd(i: VideoAdGateInput): VideoAdGate {
  if (i.action === "PAUSE") return i.onFacebook ? { allow: true } : deny("NOT_ON_FACEBOOK", "Quảng cáo chưa lên Facebook — không có gì để tắt.");
  if (i.writeClosed) return deny("WRITE_CLOSED", `Đường ghi Facebook đang đóng: ${i.writeClosed}`);
  if (i.automationPaused) return deny("AUTOMATION_PAUSED", "Video Scale đang DỪNG mọi tự động.");
  if (i.skuPaused) return deny("SKU_PAUSED", "Mã đang dừng khẩn cấp.");
  if (i.pagePaused) return deny("PAGE_PAUSED", "Fanpage đang dừng khẩn cấp.");
  if (i.variant.isTest) return deny("TEST_DATA", "Video là DỮ LIỆU THỬ — không bao giờ thành quảng cáo.");
  if (!i.variant.approved) return deny("NOT_APPROVED", "Video chưa được duyệt.");
  if (i.variant.qcFailed) return deny("QC_FAILED", "Video bị QC loại.");
  if (!i.reelPublished) return deny("REEL_NOT_PUBLISHED", "Bài Reel của video chưa đăng xong.");
  if (!i.mappingOk) return deny("MAPPING_CHANGED", "Fanpage của mã đã đổi so với bài Reel — không chạy quảng cáo trên fanpage cũ.");
  if (!i.adAccountId) return deny("NO_AD_ACCOUNT", "Mã chưa được gán TÀI KHOẢN QUẢNG CÁO.");
  if (!i.templateAdId) return deny("NO_TEMPLATE", "Chưa khai MẨU QUẢNG CÁO MẪU (đối tượng, mục tiêu tối ưu, nút kêu gọi) — máy không tự đoán.");
  if (i.action === "CREATE") return { allow: true };
  if (i.action === "ACTIVATE" && !i.onFacebook) return deny("NOT_ON_FACEBOOK", "Quảng cáo chưa được dựng trên Facebook.");
  if (i.killRules <= 0) return deny("NO_KILL_RULES", "Chưa khai luật TẮT quảng cáo (Thư viện Media → Cấu hình & luật) — không bật / tăng tiền khi không có gì tự dừng quảng cáo.");
  if (i.optimizerSilent) {
    return deny("NO_OPTIMIZER", "Vòng tối ưu (thứ chạy luật tắt quảng cáo) không chạy trong 3 giờ qua — bật VIDEO_SCALE_EVERY_MINUTES rồi đợi một lượt, không bật / tăng tiền khi không có gì tự dừng quảng cáo thua.");
  }
  const L = VIDEO_ADS_HARD_LIMITS;
  if (i.budgetVnd === null || i.caps.perAdVnd === null || i.caps.skuVnd === null || i.caps.globalVnd === null) {
    return deny("NO_BUDGET", "Chưa khai đủ ngân sách: ngân sách ngày mỗi quảng cáo, trần mã / ngày và trần toàn module / ngày.");
  }
  if (i.budgetVnd < L.minDailyBudgetVnd) return deny("BELOW_MIN_BUDGET", `Ngân sách ngày ${vnd(i.budgetVnd)} dưới sàn ${vnd(L.minDailyBudgetVnd)}.`);
  const perAd = Math.min(i.caps.perAdVnd, L.maxDailyBudgetPerAdVnd);
  if (i.budgetVnd > perAd) return deny("OVER_AD_CAP", `Ngân sách ngày ${vnd(i.budgetVnd)} vượt trần mỗi quảng cáo ${vnd(perAd)}.`);
  if (i.action === "SET_BUDGET") {
    if (i.budgetChangesToday >= L.maxBudgetChangesPerDay) return deny("RATE_LIMIT", "Quảng cáo này đã đổi ngân sách hôm nay.");
    if (i.currentBudgetVnd === null) return deny("STEP_TOO_BIG", "Chưa đọc được ngân sách hiện tại — không đổi.");
    if (i.budgetVnd > i.currentBudgetVnd * (1 + L.maxStepPct) + 0.5) return deny("STEP_TOO_BIG", `Tăng quá ${Math.round(L.maxStepPct * 100)}% một lần (${vnd(i.currentBudgetVnd)} → ${vnd(i.budgetVnd)}).`);
  }
  const skuCap = Math.min(i.caps.skuVnd, L.maxSkuDailyVnd);
  if (i.activeSkuVnd + i.budgetVnd > skuCap) return deny("OVER_SKU_CAP", `Mã đang chạy ${vnd(i.activeSkuVnd)}/ngày; thêm ${vnd(i.budgetVnd)} vượt trần mã ${vnd(skuCap)}.`);
  const globalCap = Math.min(i.caps.globalVnd, L.maxGlobalDailyVnd);
  if (i.activeGlobalVnd + i.budgetVnd > globalCap) return deny("OVER_GLOBAL_CAP", `Toàn module đang chạy ${vnd(i.activeGlobalVnd)}/ngày; thêm ${vnd(i.budgetVnd)} vượt trần ${vnd(globalCap)}.`);
  return { allow: true };
}

/** Tên chiến dịch / nhóm / quảng cáo — MANG MÃ HÀNG để `resolveCampaign` quy tiền ads về đúng mã, KHÔNG chữ TEST. Hàm THUẦN. */
export function videoAdNames(input: { code: string; day: string; pageLabel: string; seq: number; angle: string }): { campaign: string; adset: string; ad: string } {
  const clean = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^A-Za-z0-9]+/g, "").slice(0, 24);
  const d = input.day.replace(/-/g, "").slice(2);
  const base = `VS_${input.code}_${d}_${clean(input.pageLabel) || "PAGE"}_V${input.seq}`;
  return { campaign: base, adset: `${base}_${input.angle}`, ad: `${base}_${input.angle}_VIDEO` };
}

// ───────────────────────────── ĐO LƯỜNG + VÒNG TỐI ƯU (PR 4) ─────────────────────────────

/** Nhịp lượt tối ưu (kéo số đo Meta, chấm, tắt / đề nghị tăng, rút bài học) — chạy trong job `video-scale`. */
export const OPTIMIZE_EVERY_MS = 55 * 60_000;
export const OPTIMIZER_STATE_KEY = "videoScale.optimizer";
/**
 * Vòng tối ưu im lặng quá mức này ⇒ cổng KHÔNG cho bật / tăng tiền quảng cáo. Luật tắt chỉ bảo vệ tiền khi có thứ chạy nó:
 * bộ lập lịch chưa bật (`VIDEO_SCALE_EVERY_MINUTES`) hoặc job chết thì quảng cáo thua cứ tiêu mãi.
 */
export const OPTIMIZER_MAX_SILENCE_MS = 3 * 3_600_000;

export const VIDEO_AD_ACTIONS_TAKEN = ["NONE", "PAUSE", "SCALE", "RECOMMEND_SCALE"] as const;
export type VideoAdActionTaken = (typeof VIDEO_AD_ACTIONS_TAKEN)[number];

export const VIDEO_AD_ACTION_TAKEN_LABEL: Record<VideoAdActionTaken, string> = {
  NONE: "Giữ nguyên",
  PAUSE: "Máy tắt",
  SCALE: "Máy tăng ngân sách",
  RECOMMEND_SCALE: "Đề nghị tăng ngân sách (chờ người)",
};

/**
 * Từ phán quyết ra hành động — hàm THUẦN. Tắt chỉ khi phán quyết là THUA / KÍCH HOẠT LUẬT TẮT (tắt chỉ làm GIẢM tiền).
 * Tăng chỉ khi TỐT (hứa hẹn / thắng) VÀ mã bật tự tăng VÀ đã khai ngưỡng đơn VÀ số đơn chốt đạt ngưỡng; thiếu một điều
 * ⇒ chỉ ĐỀ NGHỊ. Phán quyết chưa kết luận (chưa có số chi, đang trong khung, đợi đơn) ⇒ không làm gì.
 */
export function actionForVerdict(input: { verdict: string; adActive: boolean; autoScale: boolean; minOrders: number | null; bookedOrders: number }): VideoAdActionTaken {
  if (!input.adActive) return "NONE";
  if (input.verdict === "KILL" || input.verdict === "LOSE") return "PAUSE";
  if (input.verdict === "PROMISING" || input.verdict === "WIN") {
    if (input.autoScale && input.minOrders !== null && input.bookedOrders >= input.minOrders) return "SCALE";
    return "RECOMMEND_SCALE";
  }
  return "NONE";
}

/** Ngân sách sau một bước tăng — làm tròn nghìn đồng, không vượt trần mỗi quảng cáo. Hàm THUẦN. */
export function nextScaledBudget(currentVnd: number, stepPct: number): number {
  const raw = currentVnd * (1 + Math.min(stepPct, VIDEO_ADS_HARD_LIMITS.maxStepPct));
  return Math.min(VIDEO_ADS_HARD_LIMITS.maxDailyBudgetPerAdVnd, Math.floor(raw / 1000) * 1000);
}

// ───────────────────────────── CẢNH ẢNH ĐỘNG (MIỄN PHÍ) ─────────────────────────────

/** Nhãn nhà cung cấp của cảnh ảnh động trong hàng đợi (`video_scale_jobs.provider`). */
export const PHOTO_SCENE_PROVIDER = "PHOTO";

/**
 * Cảnh này dựng bằng ẢNH ĐỘNG (không gọi AI)? Hàm THUẦN. Người đã chuyển riêng cảnh sang ảnh động (`mode = PHOTO` trên việc) ⇒
 * luôn ảnh động; không thì theo `aiScenes` của ảnh chụp cấu hình lượt; bộ sinh giả không bao giờ ở nhánh này.
 */
export function isPhotoScene(input: { provider: VideoProviderId; aiScenes: number | null; sceneIndex: number; requestMode: unknown }): boolean {
  if (input.requestMode === "PHOTO") return true;
  if (input.provider === "FAKE" || input.aiScenes === null) return false;
  return input.sceneIndex >= input.aiScenes;
}

/** Tiền GIỮ CHỖ ước tính cho một video (chỉ cảnh AI tốn tiền). `null` = model chưa có giá. Hàm THUẦN. */
export function variantReserveUsd(cfg: Pick<VideoScaleConfig, "provider" | "model" | "resolution" | "clipSeconds" | "scenesPerVariant" | "aiScenes">): number | null {
  const ai = cfg.aiScenes === null ? cfg.scenesPerVariant : Math.min(cfg.aiScenes, cfg.scenesPerVariant);
  if (ai === 0) return 0;
  const per = clipCostUsd(cfg.model, cfg.resolution, reserveSecondsFor(cfg.provider, cfg.clipSeconds));
  return per === null ? null : Math.round(per * ai * 10_000) / 10_000;
}

/**
 * Câu lỗi của nhà cung cấp là BỘ LỌC NỘI DUNG chặn? Hàm THUẦN — để màn hình nói tiếng người và đưa đúng lối ra (đổi cảnh sang
 * ảnh động), thay vì một câu tiếng Anh và nút "thử lại" sẽ bị chặn y như cũ.
 */
export function isContentBlock(error: string): boolean {
  return /prohibited|safety|blocked due to|content guideline|responsible ai|rai|bộ lọc an toàn|chính sách nội dung/i.test(error);
}

// ───────────────────────────── TIẾN TRÌNH CHO NGƯỜI XEM ─────────────────────────────

export type StepTone = "todo" | "run" | "done" | "fail" | "block";
export type StepState = { tone: StepTone; label: string; since: Date | null };

/**
 * Một việc trong hàng đợi → một câu người đọc được + màu. Hàm THUẦN. "Đang tạo trên Google" chỉ khi đã có mã thao tác (clip
 * đang sinh thật, có thể đã tính tiền); "Chờ lượt" khi chưa gửi. Việc HỎNG / BỊ CHẶN mang nguyên câu lỗi để người biết làm gì.
 */
export function jobStepState(j: { status: string; providerRef: string; lockedUntil: Date | null; nextRunAt: Date; updatedAt: Date; error: string; provider: string }, now: Date): StepState {
  const photo = j.provider === PHOTO_SCENE_PROVIDER;
  switch (j.status) {
    case "SUCCEEDED":
      return { tone: "done", label: photo ? "Xong (ảnh động)" : "Xong", since: j.updatedAt };
    case "FAILED":
      return { tone: "fail", label: isContentBlock(j.error) ? "Bị Google chặn (chính sách nội dung)" : "Hỏng", since: j.updatedAt };
    case "BLOCKED":
      return { tone: "block", label: "Đang bị chặn", since: j.updatedAt };
    case "CANCELLED":
      return { tone: "fail", label: "Đã huỷ", since: j.updatedAt };
    case "WAITING":
      return j.providerRef ? { tone: "run", label: "Đang tạo trên Google", since: j.updatedAt } : { tone: "todo", label: "Chờ lượt", since: j.nextRunAt };
    default:
      if (j.status === "RUNNING" || (j.lockedUntil !== null && j.lockedUntil > now)) return { tone: "run", label: "Đang chạy", since: j.updatedAt };
      return { tone: "todo", label: "Chờ lượt", since: j.nextRunAt };
  }
}

/** Câu lỗi nhà cung cấp → câu người đọc được; bộ lọc nội dung chỉ thẳng lối ra. Giữ nguyên câu gốc ở cuối để tra. */
export function humanProviderError(msg: string): string {
  if (!isContentBlock(msg) || msg.startsWith("Google CHẶN")) return msg.slice(0, 1000);
  return `Google CHẶN cảnh này theo chính sách nội dung (thường do câu lệnh nhắc tới cơ thể / người mẫu). Thử lại y nguyên sẽ bị chặn tiếp — bấm "Dùng ảnh động (miễn phí)" cho cảnh này, hoặc "Làm lại" cả video. Câu gốc: ${msg}`.slice(0, 1000);
}

// ───────────────────────────── SỬA VIDEO (DỰNG LẠI TỪ CLIP ĐÃ CÓ) ─────────────────────────────

/**
 * Tuỳ chọn dựng RIÊNG của một video — ghi đè cấu hình của lượt khi dựng lại. Trường vắng = theo lượt. `musicId = null` =
 * KHÔNG nhạc (khác vắng = nhạc của lượt). Chỉ dựng lại từ clip ĐÃ CÓ: không tạo clip AI mới.
 */
export type VideoRenderOptions = {
  musicId?: string | null;
  musicVolume?: number;
  voiceover?: boolean;
  voice?: string;
  burnSubtitles?: boolean;
  keepNativeAudio?: boolean;
  /** Chữ trên hình (móc câu · chữ từng cảnh · CTA). Tắt ⇒ chỉ còn phụ đề (nếu bật). */
  showText?: boolean;
};

export const MUSIC_VOLUME_DEFAULT = 0.18;
export const MUSIC_VOLUMES = [0.08, 0.12, 0.18, 0.25, 0.35] as const;

/** Đọc tuỳ chọn dựng từ jsonb — giá trị lạ bị BỎ (không đoán). Hàm THUẦN. */
export function normalizeRenderOptions(raw: unknown): VideoRenderOptions {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: VideoRenderOptions = {};
  if (r.musicId === null) out.musicId = null;
  else if (typeof r.musicId === "string" && r.musicId.trim()) out.musicId = r.musicId.trim().slice(0, 64);
  if (typeof r.musicVolume === "number" && r.musicVolume > 0 && r.musicVolume <= 0.5) out.musicVolume = Math.round(r.musicVolume * 100) / 100;
  for (const k of ["voiceover", "burnSubtitles", "keepNativeAudio", "showText"] as const) if (typeof r[k] === "boolean") out[k] = r[k];
  if (typeof r.voice === "string" && (TTS_VOICES as readonly string[]).includes(r.voice)) out.voice = r.voice;
  return out;
}

export type EffectiveRender = { musicId: string | null; musicVolume: number; voiceover: boolean; voice: string; burnSubtitles: boolean; keepNativeAudio: boolean; showText: boolean };

/** Tuỳ chọn dựng HIỆU LỰC = cấu hình lượt ⊕ tuỳ chọn riêng của video. Hàm THUẦN. */
export function effectiveRender(snap: Pick<VideoScaleConfig, "voiceover" | "voice" | "burnSubtitles" | "keepNativeAudio">, runMusicId: string | null, opts: VideoRenderOptions): EffectiveRender {
  return {
    musicId: opts.musicId === undefined ? runMusicId : opts.musicId,
    musicVolume: opts.musicVolume ?? MUSIC_VOLUME_DEFAULT,
    voiceover: opts.voiceover ?? snap.voiceover,
    voice: opts.voice ?? snap.voice,
    burnSubtitles: opts.burnSubtitles ?? snap.burnSubtitles,
    keepNativeAudio: opts.keepNativeAudio ?? snap.keepNativeAudio,
    showText: opts.showText ?? true,
  };
}

/** Khoá việc dựng theo lần dựng lại — lần 0 giữ đúng khoá cũ (`render:<id>`) để việc đã có không bị xếp lại. Hàm THUẦN. */
export function renderJobKey(variantId: string, rev: number): string {
  return rev > 0 ? `render:${variantId}:r${rev}` : `render:${variantId}`;
}

/** Video ở trạng thái này thì sửa được (đã có bản hoàn chỉnh, không đang sản xuất). */
export const EDITABLE_VARIANT_STATUSES = ["REVIEW", "APPROVED", "REJECTED", "QC_FAILED"] as const;
// ───────────────────────────── NHẠC NỀN GỐC (LYRIA) ─────────────────────────────

/** Giá công bố một đoạn 30 giây `lyria-3-clip-preview` (ai.google.dev/gemini-api/docs/pricing, đọc 28/09/2026). */
export const LYRIA_CLIP_PRICE_USD = 0.04;

/** Phong cách nhạc nền đang phổ biến trên Reels thời trang — Lyria tạo nhạc GỐC theo MÔ TẢ phong cách, không theo bài nào. */
export const MUSIC_MOODS = {
  TIKTOK_UPBEAT: { label: "Sôi động kiểu TikTok", prompt: "Catchy upbeat modern pop dance groove, 120 BPM, punchy drums, bright synth hook, feel-good energy like a viral short-video trend" },
  CHIC_FASHION: { label: "Sang trọng, thời thượng", prompt: "Chic fashion runway deep house, 118 BPM, elegant groove, warm bass, minimal stylish synths, luxury boutique mood" },
  SOFT_FEMININE: { label: "Nhẹ nhàng, nữ tính", prompt: "Soft feminine acoustic pop, gentle guitar and light percussion, warm and graceful, 95 BPM" },
  SUMMER_TROPICAL: { label: "Vui tươi, mùa hè", prompt: "Sunny tropical house, 110 BPM, marimba and plucked synths, carefree summer vacation vibe" },
  LOFI_CHILL: { label: "Chill lo-fi", prompt: "Chill lo-fi hip hop beat, 85 BPM, dusty drums, mellow electric piano, relaxed cozy afternoon" },
  ROMANTIC: { label: "Lãng mạn", prompt: "Romantic cinematic piano with soft strings, 80 BPM, tender and elegant, wedding-season feeling" },
  RNB_SMOOTH: { label: "Cuốn hút, R&B", prompt: "Smooth modern R&B groove, 90 BPM, silky bass, snaps, sensual confident mood" },
  SALE_HYPE: { label: "Sale sôi nổi", prompt: "High-energy EDM pop, 128 BPM, big build and drop, exciting countdown feeling for a flash sale" },
} as const;
export type MusicMood = keyof typeof MUSIC_MOODS;
export const MUSIC_MOOD_KEYS = Object.keys(MUSIC_MOODS) as MusicMood[];

