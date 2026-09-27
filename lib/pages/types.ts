/**
 * Kiểu dùng chung của Dynamic Page Runtime (Phase 4) — client-safe.
 * Hợp đồng: docs/platform/phase-4-contracts.md. Trang = MỘT schema (section → khối), MỘT renderer.
 * Không có mã riêng cho từng trang / từng tổ chức; không SQL, không biểu thức, không JavaScript do người khai.
 */
import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { FieldRef, ListFilter } from "@/lib/metadata/types";
import type { PeriodKey } from "@/lib/search-params";

export const BLOCK_TYPES = ["kpi", "table", "chart", "kanban", "timeline", "form", "button", "text"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Độ rộng theo lưới 12 cột (desktop); dưới `md` mọi khối rộng hết (không phá mobile). */
export const BLOCK_SPANS = [3, 4, 6, 8, 12] as const;
export type BlockSpan = (typeof BLOCK_SPANS)[number];

/** Trần an toàn: một trang không được thành 50 câu truy vấn nối tiếp. */
export const PAGE_MAX_BLOCKS = 20;
export const PAGE_MAX_SECTIONS = 8;

export type KpiConfig = { metric: string; period?: PeriodKey; label?: string };
export type TableConfig = {
  /** Khoá nguồn danh sách = khoá đối tượng trong sổ (customer, order, product, shipment, return…). */
  source: string;
  columns?: FieldRef[];
  filters?: ListFilter[];
  sort?: { ref: FieldRef; dir: "asc" | "desc" } | null;
  pageSize?: number;
  rowLink?: boolean;
};
export type ChartKind = "bar" | "line" | "pie";
export type ChartConfig = { series: string; kind: ChartKind; period?: PeriodKey };
export type KanbanConfig = { objectKey: string; statusField: FieldRef; cardFields: FieldRef[]; filters?: ListFilter[]; allowMove: boolean; limit?: number };
export type TimelineConfig = { source: string; recordParam?: string; limit?: number };
export type FormConfig = { objectKey: string; formKey: string; mode: "create" | "edit" | "view"; recordParam?: string };
export type ButtonConfig = { action: string; label: string; input?: Record<string, unknown>; confirm?: string };
export type TextConfig = { heading?: string; body?: string };

export type BlockConfigByType = {
  kpi: KpiConfig;
  table: TableConfig;
  chart: ChartConfig;
  kanban: KanbanConfig;
  timeline: TimelineConfig;
  form: FormConfig;
  button: ButtonConfig;
  text: TextConfig;
};

/** Ẩn/hiện khối — CHỈ là UX; nguồn dữ liệu / action vẫn tự kiểm quyền + module ở máy chủ. */
export type BlockVisibility = { permission?: string; module?: ModuleKey };

export type PageBlock<T extends BlockType = BlockType> = {
  /** Khoá ổn định trong trang (`^[a-z][a-z0-9_]{1,40}$`) — action của nút tra lại cấu hình theo khoá này. */
  id: string;
  type: T;
  span: BlockSpan;
  title?: string;
  config: BlockConfigByType[T];
  visibility?: BlockVisibility;
};

export type PageSection = { key: string; title?: string; blocks: PageBlock[] };
export type PageSchema = { version: 1; sections: PageSection[] };

export type PageNav = {
  enabled: boolean;
  label: string;
  /** Nhóm menu (vùng của `NAV_MODULES`); `null` ⇒ nhóm "Trang tuỳ biến". */
  zone: string | null;
  order: number;
};

export type PageStatus = "ACTIVE" | "ARCHIVED";

export type PageDefinition = {
  id: string;
  /** Đường dẫn `/p/<slug>` — `^[a-z][a-z0-9-]{1,60}$`, duy nhất trong tổ chức, BẤT BIẾN sau lần xuất bản đầu. */
  slug: string;
  name: string;
  /** Module chủ của trang: tắt ⇒ trang không mở được, không lên menu. */
  moduleKey: ModuleKey;
  /** Quyền xem trang (khoá sẵn có); `null` ⇒ chỉ cần đăng nhập + module. */
  requiredPermission: string | null;
  nav: PageNav;
  status: PageStatus;
  publishedVersion: number;
  publishedAt: Date | null;
  publishedBy: string | null;
};

/** Ngữ cảnh một lần dựng trang — máy chủ dựng, KHÔNG nhận từ client. */
export type PageRenderContext = { searchParams: Record<string, string | undefined>; period: PeriodKey };

/** Lỗi cấu hình / dữ liệu của MỘT khối — hiện chỗ giữ an toàn, không làm hỏng cả trang. */
export type BlockIssue = { blockId: string; code: "INVALID_CONFIG" | "MODULE_DISABLED" | "FORBIDDEN" | "NOT_FOUND" | "DATA_ERROR"; message: string };

/** Kết quả kiểm schema (máy chủ, trước khi LƯU NHÁP và trước khi XUẤT BẢN). */
export type PageValidation = { ok: boolean; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] };

// ═══ SỔ (catalog) — hình dạng chốt; nội dung do `lib/pages/catalog.ts` khai ═══

export type ValueFormat = "vnd" | "number" | "percent";

export type MetricSourceSpec = { key: string; label: string; module: ModuleKey; permission: string; format: ValueFormat; periods: PeriodKey[]; why: string };
export type SeriesSourceSpec = { key: string; label: string; module: ModuleKey; permission: string; kinds: ChartKind[]; format: ValueFormat; periods: PeriodKey[]; why: string };
/** Nguồn danh sách = một đối tượng của sổ đối tượng; trường lấy từ field hệ thống `listable` + field custom. */
export type ListSourceSpec = { objectKey: string; label: string; module: ModuleKey; permission: string; why: string };
export type TimelineSourceSpec = { key: string; label: string; module: ModuleKey; permission: string; recordObject: string | null; why: string };
export type PageActionSpec = { key: string; label: string; module: ModuleKey | null; permission: string | null; objectKey?: string; sideEffect: "NONE" | "WRITE"; requiresApproval: boolean; why: string };

// ═══ DỮ LIỆU ĐÃ PHÂN GIẢI của từng loại khối — máy chủ trả, renderer vẽ ═══

export type KpiData = { label: string; value: number | null; format: ValueFormat; note?: string; href?: string };
export type TableColumn = { id: string; label: string; format?: ValueFormat | "text" | "date" | "datetime" | "status" };
export type TableData = { columns: TableColumn[]; rows: { id: string; href?: string; cells: Record<string, unknown> }[]; total: number; page: number; pageSize: number };
export type ChartData = { kind: ChartKind; format: ValueFormat; points: { x: string; y: number | null }[] };
export type KanbanCard = { id: string; title: string; href?: string; fields: { label: string; value: string }[]; moveTargets: string[] };
export type KanbanData = { field: FieldRef; allowMove: boolean; columns: { value: string; label: string; color?: string; cards: KanbanCard[] }[]; truncated: boolean };
export type TimelineData = { entries: { id: string; at: string; title: string; detail?: string; source?: string }[] };
export type ButtonData = { action: string; label: string; confirm?: string; enabled: boolean; reason?: string };
export type TextData = { heading?: string; body?: string };

export type BlockDataByType = {
  kpi: KpiData;
  table: TableData;
  chart: ChartData;
  kanban: KanbanData;
  timeline: TimelineData;
  /** Form dùng lại `DynamicForm` của Phase 2 — dữ liệu là đúng props của nó (chữ ký ở components/metadata/dynamic-form.tsx). */
  form: { objectKey: string; formKey: string; mode: FormConfig["mode"]; recordId: string | null; props: Record<string, unknown> };
  button: ButtonData;
  text: TextData;
};

export type ResolvedBlock = { ok: true; block: PageBlock; data: BlockDataByType[BlockType] } | { ok: false; block: PageBlock; issue: BlockIssue };
