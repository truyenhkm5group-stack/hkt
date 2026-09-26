import { z } from "zod";
import {
  GENE_LABEL,
  GENE_VOCAB,
  IMAGE_MODES,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  CAMPAIGN_NAME_MAX_CHARS,
  MANUAL_DESIGN,
  MANUAL_GEN,
  MANUAL_GEN_RUN,
  MANUAL_UPLOAD_SOURCE_KINDS,
  normalizeCreativeConfig,
  type ConfigProblem,
  type CreativeLoopConfig,
} from "@/lib/constants/creative-loop";
import { IDEA_IMAGE_MAX_BASE64 } from "@/lib/constants/ideas";

/**
 * ═══════════ VÒNG MẪU — LƯỢC ĐỒ ĐẦU VÀO CỦA HAI MÀN HÌNH (nguồn ảnh · cấu hình) ═══════════
 *
 * Tách khỏi `lib/actions/creative-*.ts` vì tệp `"use server"` chỉ được xuất hàm async, còn lược đồ
 * phải đọc được từ ba nơi: Server Action (chặn thật), biểu mẫu phía trình duyệt (báo trước khi bấm),
 * và bài kiểm (`tests/creative-screens.test.ts`). Tệp này KHÔNG import gì phía máy chủ.
 *
 * Mọi con số, mọi trần vẫn ở `lib/constants/creative-loop.ts`. Ở đây chỉ có HÌNH DẠNG đầu vào và
 * phép so "người nhập gõ gì ↔ máy sẽ lưu gì" — trần của từng ô được DÒ bằng chính
 * `normalizeCreativeConfig`, không gõ lại con số nào.
 */

// ───────────────────────────── NGUỒN ẢNH ─────────────────────────────

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function httpUrlOrEmpty(s: string): boolean {
  if (s === "") return true;
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Đầu vào của `createCreativeSource`. KHÔNG có băm, KHÔNG có loại ảnh: máy chủ tự băm và tự đọc
 * chữ ký tệp (`storeCreativeImage`) — nhận hai thứ đó từ client là để một ảnh bị tráo lọt qua phiếu
 * duyệt lô với băm cũ.
 *
 * Loại nguồn chỉ nhận `MANUAL_UPLOAD_SOURCE_KINDS` — `OWN_AD` (quảng cáo cũ của shop, được gửi điểm ảnh
 * sang máy sinh ảnh) chỉ vào được qua nút nhập từ Facebook theo `ad_id`, không qua form tải tay.
 */
export const creativeSourceInputSchema = z
  .object({
    kind: z.enum(MANUAL_UPLOAD_SOURCE_KINDS, { message: "Chọn loại ảnh nguồn" }),
    productId: z.string().trim().max(200).default(""),
    title: z.string().trim().max(200, "Tiêu đề tối đa 200 ký tự").default(""),
    note: z.string().trim().max(2000, "Ghi chú tối đa 2.000 ký tự").default(""),
    sourceUrl: z.string().trim().max(2000).default("").refine(httpUrlOrEmpty, "Link nguồn phải là địa chỉ http(s) hợp lệ, hoặc để trống"),
    imageBase64: z
      .string()
      .min(1, "Chưa chọn ảnh")
      .max(IDEA_IMAGE_MAX_BASE64, "Ảnh quá lớn — thu nhỏ trước khi tải lên")
      .regex(BASE64, "Dữ liệu ảnh không hợp lệ"),
  })
  .strict()
  .superRefine((d, ctx) => {
    // Ảnh sản phẩm thật mà không biết là mã nào thì không làm gốc cho mẫu nào được — CSDL cũng chặn
    // (`creative_sources_product_photo_check`), nhưng người nhập phải thấy câu này trước khi bấm.
    if (d.kind === "PRODUCT_PHOTO" && !d.productId) {
      ctx.addIssue({ code: "custom", path: ["productId"], message: "Ảnh sản phẩm thật phải chọn mã hàng — máy chỉ sinh mẫu cho sản phẩm nó nhìn thấy." });
    }
  });

export type CreativeSourceInput = z.infer<typeof creativeSourceInputSchema>;

/**
 * MẪU TỰ LÀM — người tải một mẫu hoàn chỉnh (ảnh + câu chữ) vào lô gần nhất còn hạn duyệt.
 *
 * Sáu gen BẮT BUỘC: mẫu không có gen thì không dạy được máy điều gì (thống kê gen bỏ qua nó). Mã hàng
 * BẮT BUỘC: không có mã thì đơn của mẫu không nối được về sản phẩm, và mẫu thắng không làm cha được.
 * Tiêu đề ≤ 40 và câu chữ ≤ 500 — cùng trần với câu chữ máy viết (`lib/creative/writer.ts`).
 */
const geneField = <K extends keyof typeof GENE_VOCAB>(key: K) => z.enum(GENE_VOCAB[key], { message: `Chọn ${GENE_LABEL[key].toLowerCase()}` });

export const manualCreativeInputSchema = z
  .object({
    productId: z.string().trim().min(1, "Chọn mã hàng của mẫu"),
    primaryText: z.string().trim().min(1, "Nhập nội dung chính của bài quảng cáo").max(500, "Nội dung chính tối đa 500 ký tự"),
    headline: z.string().trim().max(40, "Tiêu đề tối đa 40 ký tự").default(""),
    note: z.string().trim().max(300, "Ghi chú tối đa 300 ký tự").default(""),
    genes: z
      .object({
        angle: geneField("angle"),
        scene: geneField("scene"),
        model: geneField("model"),
        composition: geneField("composition"),
        textOverlay: geneField("textOverlay"),
        palette: geneField("palette"),
      })
      .strict(),
    imageBase64: z
      .string()
      .min(1, "Chưa chọn ảnh mẫu")
      .max(IDEA_IMAGE_MAX_BASE64, "Ảnh quá lớn — thu nhỏ trước khi tải lên")
      .regex(BASE64, "Dữ liệu ảnh không hợp lệ"),
  })
  .strict();

export type ManualCreativeInput = z.infer<typeof manualCreativeInputSchema>;

/**
 * SỬA CÂU CHỮ của một mẫu trước khi duyệt lô (tab Duyệt lô). Cùng trần với câu chữ máy viết và mẫu tự
 * làm: tiêu đề ≤ 40 (được để trống — bài ảnh không có ô tiêu đề), nội dung chính 1…500. Hai trần này
 * đọc từ MỘT chỗ để ô đếm ký tự trên màn hình và máy chủ không nói hai con số khác nhau.
 */
export const VARIANT_COPY_LIMITS = { headlineMaxChars: 40, primaryTextMaxChars: 500 } as const;

export const variantCopyInputSchema = z
  .object({
    variantId: z.string().trim().min(1, "Thiếu mã mẫu"),
    headline: z.string().trim().max(VARIANT_COPY_LIMITS.headlineMaxChars, `Tiêu đề tối đa ${VARIANT_COPY_LIMITS.headlineMaxChars} ký tự`).default(""),
    primaryText: z.string().trim().min(1, "Nhập nội dung chính của bài quảng cáo").max(VARIANT_COPY_LIMITS.primaryTextMaxChars, `Nội dung chính tối đa ${VARIANT_COPY_LIMITS.primaryTextMaxChars} ký tự`),
  })
  .strict();

export type VariantCopyInput = z.infer<typeof variantCopyInputSchema>;

export const creativeSourceToggleSchema = z.object({ id: z.string().trim().min(1, "Thiếu mã nguồn ảnh"), active: z.boolean() }).strict();

// ───────────────────────────── TÊN BÀI · CHỌN BÀI · GEN TAY (chủ shop 25/09/2026, §5i) ─────────────────────────────

/** Một tên chiến dịch / nhóm / quảng cáo. Để TRỐNG = dùng tên mặc định theo khuôn (lượt vòng mẫu điền lại). */
const nameField = (what: string) => z.string().trim().max(CAMPAIGN_NAME_MAX_CHARS, `Tên ${what} tối đa ${CAMPAIGN_NAME_MAX_CHARS} ký tự`).default("");

/** SỬA TÊN chiến dịch · nhóm · quảng cáo của một bài trước khi duyệt lô. */
export const variantNamesInputSchema = z
  .object({ variantId: z.string().trim().min(1, "Thiếu mã mẫu"), campaignName: nameField("chiến dịch"), adsetName: nameField("nhóm quảng cáo"), adName: nameField("quảng cáo") })
  .strict();

export type VariantNamesInputParsed = z.infer<typeof variantNamesInputSchema>;

/** TÍCH CHỌN nhiều bài của lô chờ duyệt rồi loại / giữ. */
export const variantSelectionSchema = z
  .object({
    batchId: z.string().trim().min(1, "Thiếu mã lô"),
    variantIds: z.array(z.string().trim().min(1)).min(1, "Chưa chọn bài nào").max(200),
    mode: z.enum(["REJECT_SELECTED", "KEEP_SELECTED"]),
    reason: z.string().trim().max(1000).default(""),
  })
  .strict();

/** Bấm "Gen ảnh": ảnh sản phẩm thật (bắt buộc) + quảng cáo cũ cùng mã (tuỳ chọn) + ý tưởng tự do (tuỳ chọn). */
/** Số ảnh một lần bấm — người chọn trong khoảng min…max (chủ shop 26/09/2026). */
const runCount = z
  .number()
  .int("Số ảnh phải là số nguyên")
  .min(MANUAL_GEN_RUN.minImagesPerRun, `Ít nhất ${MANUAL_GEN_RUN.minImagesPerRun} ảnh mỗi lượt`)
  .max(MANUAL_GEN_RUN.maxImagesPerRun, `Tối đa ${MANUAL_GEN_RUN.maxImagesPerRun} ảnh mỗi lượt`)
  .default(MANUAL_GEN.imagesPerRun);

/** Ảnh đầu vào người tải lên ngay trong khối gen tay (đã thu nhỏ ở trình duyệt, base64 không tiền tố). */
const runUploads = z
  .array(z.string().min(1).max(IDEA_IMAGE_MAX_BASE64, "Ảnh tải lên quá lớn — thu nhỏ trước khi tải").regex(BASE64, "Dữ liệu ảnh tải lên không hợp lệ"))
  .max(MANUAL_GEN_RUN.maxUploads, `Tải lên tối đa ${MANUAL_GEN_RUN.maxUploads} ảnh đầu vào mỗi lượt`)
  .default([]);

export const manualGenStartSchema = z
  .object({
    productPhotoSourceId: z.string().trim().min(1, "Chọn ảnh sản phẩm thật làm gốc"),
    ownAdSourceId: z.string().trim().max(200).default(""),
    idea: z.string().trim().max(MANUAL_GEN.ideaMaxChars, `Ý tưởng tối đa ${MANUAL_GEN.ideaMaxChars} ký tự`).default(""),
    count: runCount,
    uploads: runUploads,
  })
  .strict();

/** Bấm "Gen thiết kế mới": các mã bán tốt làm cảm hứng (máy chủ kiểm lại điều kiện) + ý tưởng tự do (tuỳ chọn). */
export const manualDesignStartSchema = z
  .object({
    inspirationProductIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1, "Chọn ít nhất một mẫu bán tốt làm cảm hứng")
      .max(MANUAL_DESIGN.maxInspirations, `Chọn tối đa ${MANUAL_DESIGN.maxInspirations} mẫu cảm hứng mỗi lượt`),
    idea: z.string().trim().max(MANUAL_GEN.ideaMaxChars, `Ý tưởng tối đa ${MANUAL_GEN.ideaMaxChars} ký tự`).default(""),
    count: runCount,
    uploads: runUploads,
  })
  .strict();

/** Duyệt / loại một ảnh gen tay. */
export const manualGenReviewSchema = z
  .object({ imageId: z.string().trim().min(1, "Thiếu mã ảnh"), decision: z.enum(["APPROVE", "REJECT"]), reason: z.string().trim().max(1000).default("") })
  .strict();

/** Đưa một ảnh gen tay đã duyệt vào lô — câu chữ cùng trần với mẫu tự làm, ba tên sửa được. */
export const manualGenPromoteSchema = z
  .object({
    imageId: z.string().trim().min(1, "Thiếu mã ảnh"),
    headline: z.string().trim().max(VARIANT_COPY_LIMITS.headlineMaxChars, `Tiêu đề tối đa ${VARIANT_COPY_LIMITS.headlineMaxChars} ký tự`).default(""),
    primaryText: z.string().trim().min(1, "Nhập nội dung chính của bài quảng cáo").max(VARIANT_COPY_LIMITS.primaryTextMaxChars, `Nội dung chính tối đa ${VARIANT_COPY_LIMITS.primaryTextMaxChars} ký tự`),
    campaignName: nameField("chiến dịch"),
    adsetName: nameField("nhóm quảng cáo"),
    adName: nameField("quảng cáo"),
    predictedSeq: z.number().int().positive().nullable().default(null),
  })
  .strict();

/**
 * "Đăng camp" một ảnh gen tay đã duyệt — cùng câu chữ + ba tên với "Đưa vào lô", thêm giờ chạy: `null` = chạy
 * ngay; chuỗi ISO có múi giờ = hẹn giờ (máy chủ kiểm khoảng hợp lệ ở `instantWindow`).
 */
export const manualGenInstantSchema = manualGenPromoteSchema.extend({
  scheduleAt: z.string().datetime({ offset: true, message: "Giờ hẹn không hợp lệ" }).nullable().default(null),
});

/**
 * Công tắc "Chạy mockup hằng ngày" trên thẻ nguồn (tab Nguồn ảnh). `kind = SOURCE` ⇒ id nguồn `OWN_AD`;
 * `kind = PRODUCT` ⇒ id mã hàng (thẻ ảnh sản phẩm thật). Máy chủ kiểm lại loại nguồn / mã có thật.
 */
export const mockupToggleSchema = z
  .object({ kind: z.enum(["SOURCE", "PRODUCT"]), id: z.string().trim().min(1, "Thiếu mã").max(200), on: z.boolean() })
  .strict();

/** Người đánh dấu một thiết kế "đưa vào sản xuất" — máy không bao giờ tự đặt trạng thái này. */
export const designProductionSchema = z.object({ id: z.string().trim().min(1, "Thiếu mã thiết kế").max(200), on: z.boolean() }).strict();

// ───────────────────────────── CẤU HÌNH ─────────────────────────────

/** Trường số của cấu hình — mỗi ô trên màn hình là một khoá ở đây. */
export const CONFIG_NUMERIC_FIELDS = [
  "batchSize",
  "budgetPerVariantVnd",
  "testDays",
  "startHourVn",
  "approvalLeadMinutes",
  "genHourVn",
  "extraCandidates",
  "designSlots",
  "exploreSlots",
  "winOrdersAbove",
  "verdictSettleHours",
  "imageDailyCapUsd",
  "batchFallbackHourVn",
  "loserImageRetentionDays",
  "scaleDailyBudgetVnd",
] as const satisfies readonly (keyof CreativeLoopConfig)[];
export type ConfigNumericField = (typeof CONFIG_NUMERIC_FIELDS)[number];

export const CONFIG_FIELD_LABEL: Record<Exclude<keyof CreativeLoopConfig, "killRules" | "keepRules">, string> = {
  enabled: "Bật vòng mẫu",
  pageId: "Fanpage đứng tên bài (Page ID)",
  adAccountId: "Tài khoản quảng cáo (số, không kèm act_)",
  testCampaignId: "Chiến dịch TEST (ID)",
  templateAdId: "Mẩu QC mẫu (Ad ID)",
  currency: "Đơn vị tiền của tài khoản QC",
  batchSize: "Số mẫu đăng mỗi lô",
  budgetPerVariantVnd: "Ngân sách một mẫu (trọn khung test)",
  testDays: "Khung test (ngày)",
  startHourVn: "Giờ bắt đầu chạy (giờ VN)",
  approvalLeadMinutes: "Hạn duyệt trước giờ chạy (phút)",
  genHourVn: "Giờ dựng lô cho ngày mai (giờ VN)",
  extraCandidates: "Số ô thiết kế sinh dư để gạt bớt",
  designSlots: "Số ô THIẾT KẾ MỚI mỗi lô",
  exploreSlots: "Số ô thăm dò mỗi lô",
  mockupSourceIds: "Quảng cáo cũ chạy mockup hằng ngày",
  mockupProductIds: "Mã hàng chạy mockup hằng ngày",
  winOrdersAbove: "THẮNG khi đơn chốt vượt",
  verdictSettleHours: "Đợi đơn về sau khung test (giờ)",
  focusProductIds: "Chỉ test các mã này (để trống = mọi mã có ảnh thật)",
  imageModel: "Mô hình sinh ảnh",
  imageSize: "Khổ ảnh",
  imageQuality: "Chất lượng ảnh",
  imageMode: "Cách gửi yêu cầu vẽ",
  batchFallbackHourVn: "Batch chưa xong thì vẽ nốt lúc (giờ VN)",
  fallbackImageQuality: "Chất lượng khi vẽ nốt bằng gọi ngay",
  imageDailyCapUsd: "Trần chi sinh ảnh / ngày (USD)",
  loserImageRetentionDays: "Giữ ảnh mẫu bị loại (ngày)",
  scaleTemplates: "Chiến dịch MẪU scale (ID)",
  scaleDailyBudgetVnd: "Ngân sách ngày mỗi chiến dịch scale nháp",
};

/** Nhãn hai ô id chiến dịch mẫu scale (§5g). */
export const SCALE_TEMPLATE_LABEL = {
  purchaseMessagingCampaignId: "Chiến dịch MẪU · tối đa lượt mua qua tin nhắn (ID)",
  leadsCampaignId: "Chiến dịch MẪU · khách hàng tiềm năng (ID)",
} as const;

const scaleIdText = z
  .string()
  .trim()
  .max(40, "Id chiến dịch mẫu quá dài")
  .refine((s) => s === "" || /^[0-9]{5,25}$/.test(s), "Id chiến dịch mẫu chỉ gồm chữ số (id Facebook), hoặc để trống");

const finiteNumber = (field: ConfigNumericField) =>
  z.number({ message: `Ô "${CONFIG_FIELD_LABEL[field]}" phải là một con số` }).refine(Number.isFinite, `Ô "${CONFIG_FIELD_LABEL[field]}" phải là một con số`);

const idText = (field: keyof typeof CONFIG_FIELD_LABEL) => z.string().trim().max(100, `Ô "${CONFIG_FIELD_LABEL[field]}" quá dài`);

/**
 * Lược đồ THÔ: chỉ kiểm HÌNH DẠNG (kiểu dữ liệu, độ dài). Kẹp trần và đọc luật là việc của
 * `normalizeCreativeConfig` — một bộ luật, không phải hai.
 *
 * Ô số để trống là LỖI chứ không rơi về mặc định: rơi về mặc định trong im lặng là máy đổi số của
 * người nhập mà họ không biết. Luật để `unknown` có chủ ý — dòng luật hỏng phải tới được
 * `normalizeCreativeConfig` để nó nói ĐÚNG dòng nào hỏng.
 */
export const creativeConfigRawSchema = z
  .object({
    enabled: z.boolean(),
    pageId: idText("pageId"),
    adAccountId: idText("adAccountId"),
    testCampaignId: idText("testCampaignId"),
    templateAdId: idText("templateAdId"),
    currency: z.enum(["VND", "USD"]),
    batchSize: finiteNumber("batchSize"),
    budgetPerVariantVnd: finiteNumber("budgetPerVariantVnd"),
    testDays: finiteNumber("testDays"),
    startHourVn: finiteNumber("startHourVn"),
    approvalLeadMinutes: finiteNumber("approvalLeadMinutes"),
    genHourVn: finiteNumber("genHourVn"),
    extraCandidates: finiteNumber("extraCandidates"),
    designSlots: finiteNumber("designSlots"),
    exploreSlots: finiteNumber("exploreSlots"),
    // Hai danh sách mockup được bật / tắt bằng công tắc ở tab Nguồn ảnh, không ở form cấu hình — form
    // không gửi chúng thì server action GIỮ danh sách đang lưu (`saveCreativeConfig`), không xoá.
    mockupSourceIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    mockupProductIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    winOrdersAbove: finiteNumber("winOrdersAbove"),
    verdictSettleHours: finiteNumber("verdictSettleHours"),
    killRules: z.array(z.unknown()).max(20, "Tối đa 20 luật tắt"),
    keepRules: z.array(z.unknown()).max(20, "Tối đa 20 luật giữ"),
    focusProductIds: z.array(z.string().trim().min(1).max(200)).max(200),
    imageModel: z.string().trim().min(1, "Chưa khai mô hình sinh ảnh").max(100),
    imageSize: z.enum(IMAGE_SIZES),
    imageQuality: z.enum(IMAGE_QUALITIES),
    imageMode: z.enum(IMAGE_MODES),
    batchFallbackHourVn: finiteNumber("batchFallbackHourVn"),
    fallbackImageQuality: z.enum(IMAGE_QUALITIES),
    imageDailyCapUsd: finiteNumber("imageDailyCapUsd"),
    loserImageRetentionDays: finiteNumber("loserImageRetentionDays"),
    // Hai trường của scale (§5g) là TUỲ CHỌN để bản lưu cũ / bài kiểm cũ không vỡ — thiếu thì
    // `normalizeCreativeConfig` điền rỗng (không scale được) và ngân sách mặc định 500.000đ.
    scaleTemplates: z.object({ purchaseMessagingCampaignId: scaleIdText, leadsCampaignId: scaleIdText }).strict().optional(),
    scaleDailyBudgetVnd: finiteNumber("scaleDailyBudgetVnd").optional(),
  })
  .strict();

export type CreativeConfigRaw = z.infer<typeof creativeConfigRawSchema>;

/** Một ô bị máy đổi so với số người nhập — màn hình phải NÓI RA, không lưu im lặng. */
export type ClampNote = { field: ConfigNumericField; from: number; to: number };

/** So đầu vào với đầu ra của `normalizeCreativeConfig`, từng ô số. */
export function clampedFields(raw: Partial<Record<ConfigNumericField, unknown>>, config: CreativeLoopConfig): ClampNote[] {
  const out: ClampNote[] = [];
  for (const f of CONFIG_NUMERIC_FIELDS) {
    const v = raw[f];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v !== config[f]) out.push({ field: f, from: v, to: config[f] });
  }
  return out;
}

/**
 * Cận dưới / cận trên THẬT của từng ô số, DÒ bằng `normalizeCreativeConfig` trên chính bản nháp.
 * Không chép một con số trần nào sang đây: trần rải ra hai nơi là trần có hai giá trị. Dò trên bản
 * nháp vì có trần phụ thuộc ô khác (số mẫu/lô bị kẹp theo tổng cam kết một ngày ÷ ngân sách một mẫu).
 */
export function numericBounds(draft: Record<string, unknown>): Record<ConfigNumericField, { min: number; max: number }> {
  const out = {} as Record<ConfigNumericField, { min: number; max: number }>;
  for (const f of CONFIG_NUMERIC_FIELDS) {
    const max = normalizeCreativeConfig({ ...draft, [f]: 1e15 }).config[f];
    const min = normalizeCreativeConfig({ ...draft, [f]: -1e15 }).config[f];
    out[f] = { min, max };
  }
  return out;
}

export type ConfigValidation =
  | { ok: true; config: CreativeLoopConfig; problems: ConfigProblem[]; clamped: ClampNote[] }
  | { ok: false; error: string; problems: ConfigProblem[] };

/**
 * Kiểm cấu hình người nhập, KHÔNG ghi gì. Ba tầng:
 *  1. Lược đồ thô — sai kiểu thì dừng.
 *  2. `normalizeCreativeConfig` — kẹp trần, đọc luật.
 *  3. Luật hỏng ⇒ TỪ CHỐI CẢ LẦN LƯU. `normalizeCreativeConfig` bỏ nguyên dòng hỏng (đúng cho lúc
 *     ĐỌC từ `settings`), nhưng lưu bản đã bỏ dòng là lặng lẽ xoá một luật người ta vừa gõ — mà một
 *     luật tắt bị mất là tiền chảy tiếp. Người nhập phải thấy lỗi và sửa.
 *
 * Trường còn thiếu (fanpage, tài khoản…) KHÔNG chặn lưu: điền dần là cách người ta làm, và vòng
 * vẫn lập lô + sinh ảnh được để xem trước. Chúng quay lại dưới dạng `problems` để màn hình in ra.
 */
export function validateCreativeConfigInput(input: unknown): ConfigValidation {
  const parsed = creativeConfigRawSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Cấu hình không hợp lệ", problems: [] };
  const { config, problems } = normalizeCreativeConfig(parsed.data);
  const ruleProblems = problems.filter((p) => p.field === "rules");
  if (ruleProblems.length) {
    return { ok: false, error: `Có ${ruleProblems.length} dòng luật chưa đủ (chỉ số · phép so · giá trị · sàn chi) — chưa lưu gì. Sửa hoặc xoá dòng đó rồi lưu lại.`, problems: ruleProblems };
  }
  return { ok: true, config, problems, clamped: clampedFields(parsed.data, config) };
}
