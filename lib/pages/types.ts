/**
 * Kiểu dùng chung của Dynamic Page Runtime (Phase 4 + schema 1.1 của Phase 5) — client-safe.
 * Hợp đồng: docs/platform/phase-4-contracts.md, docs/platform/phase-5-contracts.md §1. Trang = MỘT schema
 * (section → khối, khối `column` chứa khối con một tầng), MỘT renderer. Không có mã riêng cho từng trang / từng
 * tổ chức; không SQL, không biểu thức, không JavaScript do người khai.
 *
 * Schema 1.1 CHỈ THÊM: mọi trang Phase 4 đã xuất bản vẫn hợp lệ nguyên văn (không migration dữ liệu), `version`
 * vẫn là 1 — khoá mới đều là tuỳ chọn, loại khối mới là loại mới.
 */
import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { FieldRef, ListFilter, ListFilterOp } from "@/lib/metadata/types";
import type { PeriodKey } from "@/lib/search-params";

/** Tám loại Phase 4 GIỮ NGUYÊN THỨ TỰ ở đầu; hai loại Phase 5 nối cuối. */
export const BLOCK_TYPES = ["kpi", "table", "chart", "kanban", "timeline", "form", "button", "text", "filter", "column"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Độ rộng theo lưới 12 cột (desktop); dưới `md` mọi khối rộng hết (không phá mobile). */
export const BLOCK_SPANS = [3, 4, 6, 8, 12] as const;
export type BlockSpan = (typeof BLOCK_SPANS)[number];

/** Trần an toàn: một trang không được thành 50 câu truy vấn nối tiếp. Trần khối ĐẾM CẢ khối con của cột. */
export const PAGE_MAX_BLOCKS = 20;
export const PAGE_MAX_SECTIONS = 8;
/** Cột chứa tối đa 6 khối con, xếp dọc, MỘT tầng (khối con không phải cột / bộ lọc). */
export const COLUMN_MAX_CHILDREN = 6;
/** Bộ lọc tối đa 4 ô — thanh lọc vẫn vừa một hàng trên điện thoại. */
export const FILTER_MAX_FIELDS = 4;
/** Hành động theo dòng tối đa 3 mỗi bảng. */
export const TABLE_MAX_ROW_ACTIONS = 3;
/** Biểu đồ tổng hợp theo nhóm: tối đa 50 nhóm, phần còn lại gộp "Khác". */
export const AGGREGATE_MAX_GROUPS = 50;

/** Khung của section: `card` = NHÓM (Phase 4, mặc định); `plain` = HÀNG (không khung, không tiêu đề). */
export const SECTION_VARIANTS = ["card", "plain"] as const;
export type SectionVariant = (typeof SECTION_VARIANTS)[number];

export const TEXT_VARIANTS = ["heading", "paragraph", "note"] as const;
export type TextVariant = (typeof TEXT_VARIANTS)[number];

// ─── Tổng hợp (KPI / biểu đồ theo field — Phase 5) ───

export const AGGREGATE_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];
export const TIME_BUCKETS = ["day", "week", "month"] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

/**
 * Một phép tổng hợp trên MỘT đối tượng của sổ danh sách. `sum/avg/min/max` chỉ trên field SỐ khai `aggregatable`
 * — field tiền của đơn / vận đơn / hàng hoàn KHÔNG BAO GIỜ (doanh thu chỉ có một công thức: ORDER_OUTCOME qua sổ
 * chỉ số). `count` đếm bản ghi; có `field` thì đếm bản ghi CÓ giá trị field đó.
 */
export type AggregateSpec = { objectKey: string; fn: AggregateFn; field?: FieldRef; filters?: ListFilter[] };

export type MetricKpiConfig = { metric: string; period?: PeriodKey; label?: string };
/** `dateField` có ⇒ chỉ bản ghi có mốc đó trong kỳ; không có ⇒ mọi bản ghi (kỳ không áp). */
export type AggregateKpiConfig = { aggregate: AggregateSpec; period?: PeriodKey; dateField?: FieldRef; label?: string };
export type KpiConfig = MetricKpiConfig | AggregateKpiConfig;

export type TableRowAction = { action: string; label: string; input?: Record<string, unknown>; confirm?: string };
export type TableConfig = {
  /** Khoá nguồn danh sách = khoá đối tượng trong sổ (customer, order, product, shipment, return…). */
  source: string;
  columns?: FieldRef[];
  filters?: ListFilter[];
  sort?: { ref: FieldRef; dir: "asc" | "desc" } | null;
  pageSize?: number;
  rowLink?: boolean;
  /** ≤ 3 hành động trên từng dòng — máy chủ đọc lại bản ĐÃ XUẤT BẢN + kiểm bản ghi trong phạm vi người bấm. */
  rowActions?: TableRowAction[];
};
export type ChartKind = "bar" | "line" | "pie";
export type SeriesChartConfig = { series: string; kind: ChartKind; period?: PeriodKey };
export type ChartGroupBy = { ref: FieldRef } | { bucket: TimeBucket; dateField: FieldRef };
export type AggregateChartConfig = { aggregate: AggregateSpec; kind: ChartKind; groupBy: ChartGroupBy; period?: PeriodKey };
export type ChartConfig = SeriesChartConfig | AggregateChartConfig;
export type KanbanConfig = { objectKey: string; statusField: FieldRef; cardFields: FieldRef[]; filters?: ListFilter[]; allowMove: boolean; limit?: number };
export type TimelineConfig = { source: string; recordParam?: string; limit?: number };
export type FormConfig = { objectKey: string; formKey: string; mode: "create" | "edit" | "view"; recordParam?: string };
export type ButtonConfig = { action: string; label: string; input?: Record<string, unknown>; confirm?: string };
export type TextConfig = { heading?: string; body?: string; variant?: TextVariant };
/** Một ô của thanh lọc: người xem nhập giá trị (URL `pf_<id khối lọc>_<i>`), máy chủ parse theo kiểu field. */
export type FilterFieldConfig = { objectKey: string; ref: FieldRef; op: ListFilterOp; label?: string };
export type FilterConfig = {
  /** Hiện bộ chọn kỳ (tham số `period` chung của trang). */
  period?: boolean;
  fields: FilterFieldConfig[];
  /** id khối nhận bộ lọc (bảng · kanban · KPI / biểu đồ tổng hợp) — áp lên khối CÙNG `objectKey`. */
  targets: string[];
};
/** Cột không có cấu hình riêng: nội dung là `children` của khối. */
export type ColumnConfig = Record<string, never>;

export type BlockConfigByType = {
  kpi: KpiConfig;
  table: TableConfig;
  chart: ChartConfig;
  kanban: KanbanConfig;
  timeline: TimelineConfig;
  form: FormConfig;
  button: ButtonConfig;
  text: TextConfig;
  filter: FilterConfig;
  column: ColumnConfig;
};

export function isAggregateKpi(c: KpiConfig | null | undefined): c is AggregateKpiConfig {
  return typeof c === "object" && c !== null && "aggregate" in c;
}
export function isAggregateChart(c: ChartConfig | null | undefined): c is AggregateChartConfig {
  return typeof c === "object" && c !== null && "aggregate" in c;
}

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
  /** CHỈ khối `column`: khối con xếp dọc (≤ 6, một tầng; `span` của con bị bỏ qua — rộng hết cột). */
  children?: PageBlock[];
};

export type PageSection = { key: string; title?: string; blocks: PageBlock[]; variant?: SectionVariant };
export type PageSchema = { version: 1; sections: PageSection[] };

/** Một khối trong phép duyệt phẳng: vị trí trong schema (`path`), section chứa nó, cột cha (nếu là khối con). */
export type FlatBlock = { block: PageBlock; path: string; sectionIndex: number; parentId: string | null };

/**
 * Duyệt PHẲNG mọi khối của trang theo thứ tự hiển thị — khối con của cột đứng ngay sau cột. MỌI chỗ đếm / tra /
 * duyệt khối (kiểm schema, trần khối, tra khối của nút, field custom, phân giải) đi qua đây, để khối con không bao
 * giờ bị "quên" ở một chỗ mà vẫn được đếm ở chỗ khác. Hàm thuần; dữ liệu sai hình (không phải mảng) bị bỏ qua.
 */
export function flattenBlocks(schema: Pick<PageSchema, "sections"> | null | undefined): FlatBlock[] {
  const out: FlatBlock[] = [];
  const sections = Array.isArray(schema?.sections) ? schema.sections : [];
  sections.forEach((s, si) => {
    const blocks = Array.isArray(s?.blocks) ? s.blocks : [];
    blocks.forEach((b, bi) => {
      if (!b || typeof b !== "object") return;
      const path = `sections.${si}.blocks.${bi}`;
      out.push({ block: b, path, sectionIndex: si, parentId: null });
      if (b.type === "column" && Array.isArray(b.children)) {
        b.children.forEach((c, ci) => {
          if (c && typeof c === "object") out.push({ block: c, path: `${path}.children.${ci}`, sectionIndex: si, parentId: b.id });
        });
      }
    });
  });
  return out;
}

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

/**
 * Ngữ cảnh một lần dựng trang — máy chủ dựng, KHÔNG nhận từ client. `blockFilters`: bộ lọc do khối `filter` áp lên
 * từng khối đích (khoá = id khối đích) — `resolvePage` tự dựng từ URL, đã qua parse theo kiểu field + kiểm
 * `filterable`; không bao giờ đọc từ cấu hình client.
 */
export type PageRenderContext = { searchParams: Record<string, string | undefined>; period: PeriodKey; blockFilters?: Readonly<Record<string, readonly ListFilter[]>> };

/** Lỗi cấu hình / dữ liệu của MỘT khối — hiện chỗ giữ an toàn, không làm hỏng cả trang. */
export type BlockIssue = { blockId: string; code: "INVALID_CONFIG" | "MODULE_DISABLED" | "FORBIDDEN" | "NOT_FOUND" | "DATA_ERROR"; message: string };

/** Kết quả kiểm schema (máy chủ, trước khi LƯU NHÁP và trước khi XUẤT BẢN). */
export type PageValidation = { ok: boolean; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] };

// ═══ SỔ (catalog) — hình dạng chốt; nội dung do `lib/pages/catalog.ts` khai ═══

export type ValueFormat = "vnd" | "number" | "percent";

export type MetricSourceSpec = { key: string; label: string; module: ModuleKey; permission: string; format: ValueFormat; periods: PeriodKey[]; why: string };
export type SeriesSourceSpec = { key: string; label: string; module: ModuleKey; permission: string; kinds: ChartKind[]; format: ValueFormat; periods: PeriodKey[]; why: string };
/**
 * Nguồn danh sách = một đối tượng của sổ đối tượng; trường lấy từ field hệ thống `listable` + field custom.
 * `permissions` (Phase 6 — đối tượng tuỳ biến): MỌI khoá người xem phải có (`records:view` + khoá siết của đối tượng);
 * vắng ⇒ chỉ `permission`. `permission` luôn là khoá đầu tiên của danh sách đó.
 */
export type ListSourceSpec = { objectKey: string; label: string; module: ModuleKey; permission: string; permissions?: string[]; why: string };
export type TimelineSourceSpec = { key: string; label: string; module: ModuleKey; permission: string; permissions?: string[]; recordObject: string | null; why: string };
export type PageActionSpec = { key: string; label: string; module: ModuleKey | null; permission: string | null; objectKey?: string; sideEffect: "NONE" | "WRITE"; requiresApproval: boolean; why: string };

// ═══ DỮ LIỆU ĐÃ PHÂN GIẢI của từng loại khối — máy chủ trả, renderer vẽ ═══

export type KpiData = { label: string; value: number | null; format: ValueFormat; note?: string; href?: string };
export type TableColumn = { id: string; label: string; format?: ValueFormat | "text" | "date" | "datetime" | "status" };
/** Hành động theo dòng như người xem thấy — `index` là vị trí trong `rowActions` ĐÃ XUẤT BẢN (máy chủ tra lại theo nó). */
export type TableRowActionData = { index: number; label: string; confirm?: string; enabled: boolean; reason?: string };
export type TableData = {
  columns: TableColumn[];
  rows: { id: string; href?: string; cells: Record<string, unknown> }[];
  total: number;
  page: number;
  pageSize: number;
  rowActions?: TableRowActionData[];
  /** Số bộ lọc của thanh lọc đang áp lên bảng này (để người xem biết bảng đang bị thu hẹp). */
  appliedFilters?: number;
};
export type ChartData = { kind: ChartKind; format: ValueFormat; points: { x: string; y: number | null }[]; note?: string };
/** Một ô của thanh lọc đã phân giải: `param` là tên tham số URL, `value` là giá trị ĐÃ PARSE (hỏng ⇒ `null`). */
export type FilterFieldData = {
  param: string;
  label: string;
  op: ListFilterOp;
  input: "text" | "number" | "date" | "select" | "boolean" | "presence";
  options?: { value: string; label: string }[];
  multiple?: boolean;
  value: string | string[] | null;
};
/** `pageParams`: tham số lật trang của khối đích — đổi bộ lọc thì về trang 1 (không đứng ở trang 7 của một tập đã đổi). */
export type FilterData = { period: boolean; periodValue: PeriodKey; fields: FilterFieldData[]; dropped: { label: string; reason: string }[]; pageParams: string[] };
/** Cột: kết quả của TỪNG khối con — con hỏng thành chỗ giữ riêng, không kéo con khác. */
export type ColumnData = { children: ResolvedBlock[] };
export type KanbanCard = { id: string; title: string; href?: string; fields: { label: string; value: string }[]; moveTargets: string[] };
export type KanbanData = { field: FieldRef; allowMove: boolean; columns: { value: string; label: string; color?: string; cards: KanbanCard[] }[]; truncated: boolean };
export type TimelineData = { entries: { id: string; at: string; title: string; detail?: string; source?: string }[] };
export type ButtonData = { action: string; label: string; confirm?: string; enabled: boolean; reason?: string };
export type TextData = { heading?: string; body?: string; variant?: TextVariant };

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
  filter: FilterData;
  column: ColumnData;
};

export type ResolvedBlock = { ok: true; block: PageBlock; data: BlockDataByType[BlockType] } | { ok: false; block: PageBlock; issue: BlockIssue };
