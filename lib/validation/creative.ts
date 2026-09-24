import { z } from "zod";
import {
  CREATIVE_SOURCE_KINDS,
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
 */
export const creativeSourceInputSchema = z
  .object({
    kind: z.enum(CREATIVE_SOURCE_KINDS, { message: "Chọn loại ảnh nguồn" }),
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

export const creativeSourceToggleSchema = z.object({ id: z.string().trim().min(1, "Thiếu mã nguồn ảnh"), active: z.boolean() }).strict();

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
  "exploreShare",
  "winOrdersAbove",
  "verdictSettleHours",
  "imageDailyCapUsd",
  "loserImageRetentionDays",
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
  extraCandidates: "Số mẫu sinh dư để gạt bớt",
  exploreShare: "Tỷ lệ ô thăm dò (0 – 1)",
  winOrdersAbove: "THẮNG khi đơn chốt vượt",
  verdictSettleHours: "Đợi đơn về sau khung test (giờ)",
  focusProductIds: "Chỉ test các mã này (để trống = mọi mã có ảnh thật)",
  imageModel: "Mô hình sinh ảnh",
  imageSize: "Khổ ảnh",
  imageQuality: "Chất lượng ảnh",
  imageDailyCapUsd: "Trần chi sinh ảnh / ngày (USD)",
  loserImageRetentionDays: "Giữ ảnh mẫu bị loại (ngày)",
};

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
    exploreShare: finiteNumber("exploreShare"),
    winOrdersAbove: finiteNumber("winOrdersAbove"),
    verdictSettleHours: finiteNumber("verdictSettleHours"),
    killRules: z.array(z.unknown()).max(20, "Tối đa 20 luật tắt"),
    keepRules: z.array(z.unknown()).max(20, "Tối đa 20 luật giữ"),
    focusProductIds: z.array(z.string().trim().min(1).max(200)).max(200),
    imageModel: z.string().trim().min(1, "Chưa khai mô hình sinh ảnh").max(100),
    imageSize: z.enum(["1024x1024", "1024x1536"]),
    imageQuality: z.enum(["low", "medium", "high"]),
    imageDailyCapUsd: finiteNumber("imageDailyCapUsd"),
    loserImageRetentionDays: finiteNumber("loserImageRetentionDays"),
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
