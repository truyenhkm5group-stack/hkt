/**
 * ═══════════ AI ERP BUILDER — KIỂU DỮ LIỆU (Phase 8) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Hợp đồng: `docs/platform/phase-8-contracts.md`. AI SOẠN một blueprint (hoặc một blueprint MẢNH), người DUYỆT từng
 * mục, bộ cài Phase 7 GHI. Tệp này chỉ `import type` để màn hình, bài kiểm và máy chủ dùng chung.
 */
import type { BlueprintIssue, BlueprintItemKind } from "@/lib/blueprints/types";

export const AI_BUILDER_MODES = ["new", "edit"] as const;
export type AiBuilderMode = (typeof AI_BUILDER_MODES)[number];

export const AI_BUILDER_MODE_LABEL: Record<AiBuilderMode, string> = { new: "Dựng mới", edit: "Sửa lặp" };

export const AI_DRAFT_STATUSES = ["DRAFT", "APPLIED", "DISCARDED"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

export const AI_DRAFT_STATUS_LABEL: Record<AiDraftStatus, string> = { DRAFT: "Nháp", APPLIED: "Đã áp dụng", DISCARDED: "Đã bỏ" };

/**
 * `ORG_CONNECTION` = khoá của chính tổ chức (sổ AI ghi nguồn `BYOK`); `HOME` = khoá `.env` của tổ chức nhà (chỉ tổ chức
 * nhà); `PLATFORM` = khoá của NỀN TẢNG, trừ credit theo gói — mặc định TẮT (`lib/ai-usage/platform-ai.ts`).
 */
export type AiSourceKind = "ORG_CONNECTION" | "HOME" | "PLATFORM";

export const AI_SOURCE_LABEL: Record<AiSourceKind, string> = { ORG_CONNECTION: "Khoá AI của tổ chức", HOME: "AI của tổ chức nhà", PLATFORM: "Credit AI của nền tảng" };

/**
 * Trần của MỘT tổ chức. Lượt soạn = tối đa `1 + maxRepairRounds` lời gọi AI; trần theo ngày đếm LƯỢT SOẠN (bản nháp)
 * trong CSDL của tổ chức. Hạn mức theo gói (Phase 10) sẽ nối vào đây sau.
 */
export const AI_BUILDER_LIMITS = {
  maxPromptChars: 4_000,
  maxRepairRounds: 2,
  maxTokensPerCall: 16_000,
  maxDraftsPerDay: 20,
  /** Số lỗi tối đa gửi lại cho AI trong một lượt sửa — gói hỏng nặng không được thổi phồng lời gọi sau. */
  maxErrorsFedBack: 40,
} as const;

export const AI_BUILDER_EXAMPLES: readonly string[] = [
  "Công ty bán buôn có CRM, đơn hàng, mua hàng, kho và tài chính. Khách là đại lý được nợ theo hạn mức.",
  "Cửa hàng thời trang bán online, cần theo dõi size / màu, đơn theo trạng thái và kho.",
  "Công ty dịch vụ vệ sinh công nghiệp: quản lý khách, việc theo phòng ban và thu chi.",
];

export const AI_BUILDER_EDIT_EXAMPLES: readonly string[] = [
  "Thêm bước trưởng phòng duyệt đơn trên 20 triệu.",
  "Thêm field mã số thuế cho khách hàng và hiện trong danh sách khách.",
];

/** Loại mục chọn được: mục của blueprint + gợi ý tích hợp. */
export type SelectableKind = BlueprintItemKind | "integration";

export const SELECTABLE_KIND_LABEL: Record<SelectableKind, string> = {
  module: "Module",
  role: "Vai trò",
  object: "Đối tượng",
  field: "Field",
  status: "Trạng thái",
  form: "Form",
  list: "Danh sách",
  page: "Trang",
  workflow: "Luật tự động (NHÁP)",
  setting: "Cài đặt",
  ai: "Ngữ cảnh AI",
  integration: "Gợi ý tích hợp",
};

/**
 * Một mục của bản nháp. `key` = `<loại>:<khoá>` (cùng `stepKey` của kế hoạch). `context` = mục MÁY CHỦ thêm vào mảnh
 * (module đang bật, field đã có mà mảnh tham chiếu) để bộ kiểm thấy đúng tập sau khi cài — không bỏ chọn được.
 */
export type SelectableItem = { key: string; kind: SelectableKind; label: string; detail: string; context: boolean; issues: string[] };
export type SummaryGroup = { kind: SelectableKind; label: string; items: SelectableItem[] };

export type AiDraftView = {
  id: string;
  mode: AiBuilderMode;
  prompt: string;
  status: AiDraftStatus;
  name: string | null;
  valid: boolean;
  error: string | null;
  errors: BlueprintIssue[];
  warnings: BlueprintIssue[];
  groups: SummaryGroup[];
  excludedKeys: string[];
  installId: string | null;
  aiSource: AiSourceKind | null;
  provider: string | null;
  model: string | null;
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD ước tính; `null` = CHƯA BIẾT (model không có trong bảng giá), không phải 0. */
  costUsd: number | null;
  createdAt: string;
  createdByEmail: string | null;
  appliedAt: string | null;
  discardedAt: string | null;
  /** Chỉ có ngay sau lượt tạo: chi phí AI đã vượt ngưỡng cảnh báo của gói (lượt vẫn chạy). */
  quotaWarning?: string | null;
};

export type AiDraftListRow = Pick<AiDraftView, "id" | "mode" | "prompt" | "status" | "name" | "valid" | "aiCalls" | "costUsd" | "createdAt" | "createdByEmail">;

export type AiBuilderView = {
  organization: { code: string; name: string; isHome: boolean };
  ai: { available: boolean; source: AiSourceKind | null; provider: string | null; model: string | null; reason: string | null };
  usedToday: number;
  limits: typeof AI_BUILDER_LIMITS;
  drafts: AiDraftListRow[];
};

export type AiBuilderResult<T> = { ok: true; value: T } | { ok: false; error: string };
