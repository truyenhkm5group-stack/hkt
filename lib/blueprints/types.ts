/**
 * ═══════════ BLUEPRINT — GÓI METADATA CÓ PHIÊN BẢN (Phase 7) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Hợp đồng: `docs/platform/phase-7-contracts.md` mục 1; quyết định gốc X3 + X4 trong `builder-roadmap.md`.
 *
 * Một blueprint là DỮ LIỆU: module · vai trò · field · trạng thái · form · danh sách · trang · luật · cài đặt an toàn
 * · gợi ý tích hợp · ngữ cảnh AI. Mẫu ngành (Phase 7), AI (Phase 8) và onboarding (Phase 10) cùng sinh ra đúng
 * định dạng này và cùng đi qua MỘT bộ kiểm (`validateBlueprint`), MỘT bộ lập kế hoạch (`planBlueprint`) và MỘT bộ
 * cài (`applyBlueprint`). Bộ cài chỉ gọi dịch vụ metadata sẵn có — không có đường ghi thẳng bảng nào ở đây.
 *
 * Tệp này không import gì chạy được (chỉ `import type`) để màn hình, bài kiểm và máy chủ dùng chung.
 */
import type { Role } from "@/db/schema";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { FieldType, FieldValidation, FormSchema, ListViewSchema } from "@/lib/metadata/types";
import type { PageNav, PageSchema } from "@/lib/pages/types";
import type { WorkflowAction, WorkflowCondition, WorkflowGate, WorkflowTrigger } from "@/lib/workflow/types";

export const BLUEPRINT_FORMAT = "erp-blueprint" as const;
export const BLUEPRINT_FORMAT_VERSION = 1 as const;

/** Khoá gói: mẫu dùng tên đọc được ("fashion-commerce"), AI dùng "ai-<ngẫu nhiên>". */
export const BLUEPRINT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
/** Semver rút gọn `MAJOR.MINOR.PATCH` — so được bằng số, không cần thư viện. */
export const BLUEPRINT_VERSION_PATTERN = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
/** Khoá vai trò trong gói — mã `access_roles.code` = khoá viết HOA. */
export const BLUEPRINT_ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * ═══ CÀI ĐẶT AN TOÀN — DANH SÁCH ĐÓNG ═══
 *
 * Gói chỉ ghi được khoá `settings` nằm ở đây, và mỗi khoá phải khai VÌ SAO nó vô hại. Tiêu chí: không một phép
 * tính tiền / tồn kho / kết quả đơn / lương / quyền nào đọc khoá đó (luật 46: chữ cho người đọc không chạm con số).
 * Không có khoá secret, ngưỡng nghiệp vụ (luật 38: đích là quyết định kinh doanh), hay cấu hình kênh gửi tin ở đây.
 */
export const SAFE_SETTING_KEYS = ["care.notePresets"] as const;
export type SafeSettingKey = (typeof SAFE_SETTING_KEYS)[number];

export const SAFE_SETTING_SPEC: Record<SafeSettingKey, { label: string; module: ModuleKey; why: string }> = {
  "care.notePresets": {
    label: "Mẫu ghi chú chăm sóc kiện hàng",
    module: "logistics",
    why: "Chỉ là các câu gõ sẵn cho ô ghi chú ở bàn chăm sóc kiện (`lib/queries/care-workbench.ts`). Không phép tính nào đọc nó; người dùng vẫn sửa được ở màn hình của chính nó.",
  },
};

/** Khoá `settings` giữ ngữ cảnh AI của tổ chức (Phase 8 đọc). Ghi bằng mục `ai` của gói, không qua `settings`. */
export const AI_PROFILE_SETTING_KEY = "ai.businessProfile";
export type AiBusinessProfile = { businessProfile: string; glossary: { term: string; meaning: string }[] };

// ═══ ĐỊNH DẠNG ═══

export type BlueprintRole = { key: string; label: string; description?: string; base: Exclude<Role, "ADMIN">; permissions: string[]; defaultScope?: "SELF" | "ASSIGNED" | "TEAM" | "DEPARTMENT" | "ALL" };

/** Đối tượng tuỳ biến (Phase 6). Phiên bản này TỪ CHỐI mục `objects` — xem `validateBlueprint`. */
export type BlueprintObject = { key: `x_${string}`; label: string; labelPlural: string; icon: string; moduleKey: ModuleKey; titleLabel: string; viewPermission?: string; writePermission?: string };

export type BlueprintFieldOption = { value: string; label: string; color?: string; active?: boolean; position?: number };

export type BlueprintField = {
  objectKey: string;
  key: string;
  label: string;
  type: FieldType;
  options?: BlueprintFieldOption[];
  validation?: FieldValidation;
  /** Chỉ kiểu `status`: `{ "<từ>": ["<tới>", …] }`. */
  transitions?: Record<string, string[]>;
  /** Field quan hệ (Phase 6) — phiên bản này từ chối. */
  relation?: { objectKey: string };
  required?: boolean;
  listable?: boolean;
  filterable?: boolean;
  helpText?: string;
};

export type BlueprintStatusOverride = { objectKey: string; field: string; options: { value: string; label: string; color?: string; position: number; active: boolean }[] };
export type BlueprintForm = { objectKey: string; formKey: string; schema: FormSchema; publish?: boolean };
export type BlueprintListView = { objectKey: string; listKey: string; schema: ListViewSchema; publish?: boolean };
export type BlueprintPage = { slug: string; name: string; moduleKey: ModuleKey; requiredPermission?: string | null; nav: PageNav; schema: PageSchema; publish?: boolean };
export type BlueprintWorkflow = { key: string; name: string; description?: string; trigger: WorkflowTrigger; conditions?: WorkflowCondition | null; actions: WorkflowAction[]; gate?: WorkflowGate };
export type BlueprintSetting = { key: SafeSettingKey; value: unknown };
export type BlueprintIntegration = { connectorKey: string; reason: string };

export type Blueprint = {
  format: typeof BLUEPRINT_FORMAT;
  formatVersion: typeof BLUEPRINT_FORMAT_VERSION;
  key: string;
  version: string;
  name: string;
  description: string;
  industry: string | null;
  modules: ModuleKey[];
  roles?: BlueprintRole[];
  objects?: BlueprintObject[];
  fields?: BlueprintField[];
  statuses?: BlueprintStatusOverride[];
  forms?: BlueprintForm[];
  listViews?: BlueprintListView[];
  pages?: BlueprintPage[];
  workflows?: BlueprintWorkflow[];
  settings?: BlueprintSetting[];
  integrations?: BlueprintIntegration[];
  ai?: { businessProfile: string; glossary?: { term: string; meaning: string }[] };
};

// ═══ KIỂM ═══

export type BlueprintIssue = { path: string; message: string };
export type BlueprintValidation = { ok: boolean; errors: BlueprintIssue[]; warnings: BlueprintIssue[] };

// ═══ KẾ HOẠCH ═══

/** Loại mục, theo ĐÚNG thứ tự ghi (phụ thuộc): module → vai trò → đối tượng → field → trạng thái → form → danh sách → trang → luật → cài đặt → AI. */
export const BLUEPRINT_ITEM_KINDS = ["module", "role", "object", "field", "status", "form", "list", "page", "workflow", "setting", "ai"] as const;
export type BlueprintItemKind = (typeof BLUEPRINT_ITEM_KINDS)[number];

export const BLUEPRINT_ITEM_KIND_LABEL: Record<BlueprintItemKind, string> = {
  module: "Module",
  role: "Vai trò",
  object: "Đối tượng",
  field: "Field",
  status: "Trạng thái",
  form: "Form",
  list: "Danh sách",
  page: "Trang",
  workflow: "Luật tự động",
  setting: "Cài đặt",
  ai: "Ngữ cảnh AI",
};

export const PLAN_ACTIONS = ["CREATE", "UPDATE", "UNCHANGED", "SKIP_CUSTOMIZED", "SKIP_DELETED", "CONFLICT", "BLOCKED"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export const PLAN_ACTION_LABEL: Record<PlanAction, string> = {
  CREATE: "Tạo mới",
  UPDATE: "Cập nhật",
  UNCHANGED: "Không đổi",
  SKIP_CUSTOMIZED: "Giữ bản tổ chức đã sửa",
  SKIP_DELETED: "Tổ chức đã bỏ — không dựng lại",
  CONFLICT: "Trùng thứ có sẵn — cần quyết",
  BLOCKED: "Bị chặn",
};

/** Mục người được chọn ghi đè (mặc định BỎ QUA): đã tuỳ biến, hoặc trùng thứ có sẵn mà không do gói sinh ra. */
export const OVERRIDABLE_ACTIONS: readonly PlanAction[] = ["SKIP_CUSTOMIZED", "CONFLICT"];

export type DiffEntry = { path: string; current: unknown; template: unknown };

export type PlanStep = {
  kind: BlueprintItemKind;
  key: string;
  label: string;
  action: PlanAction;
  reason: string | null;
  /** Băm của mục trong gói MỚI. */
  templateHash: string;
  /** Băm của mục trong gói LẦN CÀI TRƯỚC (`null` = mục chưa từng do gói này sinh ra). */
  baseTemplateHash: string | null;
  /** Băm thực thể ngay sau lần cài trước. */
  appliedHash: string | null;
  /** Băm thực thể HIỆN TẠI (`null` = không tồn tại). */
  currentHash: string | null;
  /** Khác biệt giữa bản hiện tại và bản gói (SKIP_CUSTOMIZED / CONFLICT) — để người quyết có ghi đè không. */
  diff: DiffEntry[];
  /** Xuất bản ngay sau khi ghi nháp (chỉ lần cài ĐẦU, và chỉ khi gói khai `publish: true`). */
  publish: boolean;
};

export type StepResolution = "overwrite" | "skip";

export type BlueprintPlan = {
  blueprint: { key: string; version: string; name: string };
  /** Phiên bản của lần cài gần nhất đã XONG (`null` = chưa từng cài). */
  installedVersion: string | null;
  /** Băm ổn định của toàn bộ kế hoạch — lượt cài so với bản người đã xem trước; lệch ⇒ bắt xem lại. */
  planHash: string;
  steps: PlanStep[];
  issues: BlueprintIssue[];
  warnings: BlueprintIssue[];
  integrations: BlueprintIntegration[];
  counts: Record<PlanAction, number>;
  /** Không có bước nào BỊ CHẶN và gói hợp lệ. */
  ok: boolean;
};

// ═══ KẾT QUẢ CÀI ═══

export type StepOutcome = { kind: BlueprintItemKind; key: string; label: string; action: PlanAction; status: "DONE" | "SKIPPED" | "FAILED" | "NOT_RUN"; message: string | null };
export type ApplyResult =
  | { ok: true; installId: string; version: string; outcomes: StepOutcome[] }
  | { ok: false; installId: string | null; failedStep: { kind: BlueprintItemKind; key: string } | null; errors: BlueprintIssue[]; outcomes: StepOutcome[] };

export type InstallHistoryRow = {
  id: string;
  blueprintKey: string;
  version: string;
  status: "RUNNING" | "DONE" | "FAILED";
  installedAt: string;
  finishedAt: string | null;
  installedBy: string | null;
  installedByEmail: string | null;
  counts: Partial<Record<PlanAction, number>>;
  error: string | null;
};

export function stepKey(kind: BlueprintItemKind, key: string): string {
  return `${kind}:${key}`;
}

/** So hai semver `a.b.c`; chuỗi sai dạng coi như 0.0.0 (bộ kiểm đã chặn trước). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
