/**
 * ═══════════ SỔ LOẠI KHỐI + KIỂM SCHEMA TRANG (Phase 4 · G2, G3, G7, G9 + schema 1.1 Phase 5) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Hợp đồng: docs/platform/phase-4-contracts.md, docs/platform/phase-5-contracts.md §1. Tệp này KHÔNG đọc CSDL,
 * không import `next` hay `node:*`: máy chủ (lưu nháp / xuất bản — `lib/pages/registry.ts`), trình soạn (giao diện)
 * và bài kiểm gọi CÙNG `validatePageSchema`, nên "trang này hợp lệ không" chỉ có một câu trả lời.
 *
 * ─── BA ĐIỀU CỐ Ý ───
 *
 *  1. SỔ LÀ THAM SỐ. `validatePageSchema(schema, { modules, catalog })` nhận sổ nguồn/action như tham số,
 *     mặc định là `lib/pages/catalog.ts`. Bài kiểm tiêm một sổ giả để chạy được cả khi sổ thật còn rỗng,
 *     và để đột biến một khoá sổ không cần sửa sổ thật.
 *  2. MODULE TẮT LÀ LỖI CHẶN (G7) — khi phụ thuộc BIẾT TRƯỚC: nguồn / action của khối mang module, đối
 *     tượng của form / kanban mang module. Lượt LƯU NHÁP có thể hạ nó xuống cảnh báo (`moduleIssues:
 *     "warning"`) để người soạn không bị khoá cả bản nháp vì một module sẽ bật sau; lượt XUẤT BẢN luôn chặn.
 *  3. KHÔNG CÓ Ô TỰ DO NÀO THÀNH MÃ. Cấu hình chỉ nhận khoá sổ, `FieldRef`, `ListFilterOp` và chữ hiển thị —
 *     không SQL, không biểu thức, không JavaScript. Kiểm ở đây là lớp CẤU HÌNH; lớp AN NINH là trình phân
 *     giải kiểm module + quyền + phạm vi theo NGƯỜI XEM ở mọi lượt đọc (G4, G8).
 *
 * ─── SCHEMA 1.1 (Phase 5) ───
 *
 *  · Cột (`column`) chứa ≤ 6 khối con, MỘT tầng: con không phải cột / bộ lọc. Trần 20 khối đếm CẢ con.
 *  · Bộ lọc (`filter`) ≤ 4 ô; mỗi đích là id một khối CÓ THẬT trong trang (bảng · kanban · KPI / biểu đồ tổng hợp),
 *    cùng đối tượng với ít nhất một ô; field hệ thống phải `filterable`.
 *  · Tổng hợp: đối tượng phải trong sổ danh sách; `sum/avg/min/max` chỉ trên field SỐ khai `aggregatable` —
 *    field tiền của đơn / vận đơn / hàng hoàn không khai, nên không cộng được (doanh thu chỉ qua sổ chỉ số);
 *    nhóm theo field select / trạng thái / có-không / người dùng; biểu đồ tròn chỉ khi nhóm theo field.
 *  · Hành động theo dòng ≤ 3, action trong sổ, chỉ loại action nhận một bản ghi.
 *
 * Field CUSTOM (`custom:<khoá>`) không kiểm được ở đây — định nghĩa của nó nằm trong CSDL tổ chức; registry
 * kiểm tiếp phần đó (`customRefProblems`) sau khi hàm thuần này đạt.
 */
import { z } from "zod";
import { objectDef, type ObjectDef } from "@/lib/constants/object-registry";
import { MODULE_KEYS, type ModuleKey } from "@/lib/constants/platform-modules";
import { FIELD_REF_PATTERN } from "@/lib/metadata/form-schema";
import type { FieldType, ListFilterOp, SystemFieldDef } from "@/lib/metadata/types";
import { LIST_SOURCES, METRIC_SOURCES, PAGE_ACTIONS, SERIES_SOURCES, TIMELINE_SOURCES } from "@/lib/pages/catalog";
import {
  AGGREGATE_FNS,
  BLOCK_SPANS,
  BLOCK_TYPES,
  COLUMN_MAX_CHILDREN,
  FILTER_MAX_FIELDS,
  flattenBlocks,
  isAggregateChart,
  isAggregateKpi,
  PAGE_MAX_BLOCKS,
  PAGE_MAX_SECTIONS,
  SECTION_VARIANTS,
  TABLE_MAX_ROW_ACTIONS,
  TEXT_VARIANTS,
  TIME_BUCKETS,
  type AggregateSpec,
  type BlockConfigByType,
  type BlockSpan,
  type BlockType,
  type ChartKind,
  type ListSourceSpec,
  type MetricSourceSpec,
  type PageActionSpec,
  type PageBlock,
  type PageSchema,
  type PageSection,
  type PageValidation,
  type SeriesSourceSpec,
  type TimelineSourceSpec,
} from "@/lib/pages/types";
import type { PeriodKey } from "@/lib/search-params";

// ═══ SỔ (tiêm được) ═══

export type PageCatalog = {
  metrics: readonly MetricSourceSpec[];
  series: readonly SeriesSourceSpec[];
  lists: readonly ListSourceSpec[];
  timelines: readonly TimelineSourceSpec[];
  actions: readonly PageActionSpec[];
};

/** Sổ thật (`lib/pages/catalog.ts`). Đọc ở MỖI lượt gọi — không chụp lại ở đây, để sổ là nguồn duy nhất. */
export function defaultPageCatalog(): PageCatalog {
  return { metrics: METRIC_SOURCES, series: SERIES_SOURCES, lists: LIST_SOURCES, timelines: TIMELINE_SOURCES, actions: PAGE_ACTIONS };
}

// ═══ Hằng số hình dạng ═══

/** Khoá khối: action của nút tra lại cấu hình ĐÃ XUẤT BẢN theo `slug + blockId`, nên nó phải ổn định và sạch. */
export const BLOCK_ID_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
export const SECTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
/** Đường dẫn `/p/<slug>`. Trùng với ràng buộc `meta_pages_slug_check` của CSDL. */
export const PAGE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,60}$/;
/** Tham số URL mang id bản ghi cho timeline / form (vd `?id=`). */
export const RECORD_PARAM_PATTERN = /^[a-z][a-zA-Z0-9_]{0,30}$/;

/**
 * Kỳ dùng được trong cấu hình trang. `custom` KHÔNG có: nó cần khoảng ngày do người xem nhập, cấu hình trang
 * không mang được — khai nó là một khối luôn hỏi lại "từ ngày nào".
 */
export const PAGE_PERIODS = ["today", "yesterday", "7d", "30d", "month", "last_month", "90d", "year", "all"] as const satisfies readonly PeriodKey[];
export const CHART_KINDS = ["bar", "line", "pie"] as const satisfies readonly ChartKind[];
const FILTER_OPS = ["eq", "neq", "contains", "gte", "lte", "in", "empty", "not_empty"] as const;

export const TABLE_MAX_PAGE_SIZE = 100;
export const KANBAN_MAX_CARDS = 200;
export const TIMELINE_MAX_ENTRIES = 100;
const MAX_TEXT_BODY = 4000;
const MAX_BUTTON_INPUT_JSON = 2000;

/**
 * Action dùng được làm HÀNH ĐỘNG THEO DÒNG: loại nhận MỘT bản ghi (`recordId` do máy chủ gắn từ dòng đã kiểm phạm
 * vi). Action không nhận bản ghi (mở trang, tạo mới, chạy luật) đặt trên dòng là nói dối về cái nó làm.
 */
export const ROW_ACTION_KEYS: readonly string[] = ["open_record", "update_safe_field", "request_approval"];

/** Kiểu field SỐ (tổng hợp được khi khai `aggregatable`). */
export const AGGREGATE_NUMERIC_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["number", "currency"]);
/** Kiểu field nhóm được (biểu đồ nhóm theo field). */
export const GROUPABLE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["select", "status", "boolean", "user"]);
/** Kiểu field ngày (mốc kỳ / nhóm theo ngày-tuần-tháng). */
export const DATE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["date", "datetime"]);

/** Phép lọc dùng được với từng nhóm kiểu field — thanh lọc và kiểm schema dùng chung. */
export function filterOpFits(type: FieldType, op: ListFilterOp): boolean {
  if (op === "empty" || op === "not_empty") return true;
  if (AGGREGATE_NUMERIC_TYPES.has(type) || DATE_TYPES.has(type)) return op === "eq" || op === "neq" || op === "gte" || op === "lte";
  if (type === "boolean") return op === "eq" || op === "neq";
  if (type === "select" || type === "status" || type === "user") return op === "eq" || op === "neq" || op === "in";
  if (type === "multi_select") return op === "eq" || op === "in";
  if (type === "file" || type === "relation") return false;
  return op === "eq" || op === "neq" || op === "contains";
}

// ═══ zod cấu hình từng loại khối (đúng `BlockConfigByType`) ═══

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Hợp của hai hình (KPI chỉ số | KPI tổng hợp…): chọn nhánh theo khoá có mặt rồi kiểm ĐÚNG nhánh đó, để lỗi trỏ
 * đúng ô (`config.aggregate.fn`) thay vì một câu "không khớp hình nào" của `z.union`.
 */
function either<A, B>(isB: (v: unknown) => boolean, a: z.ZodType<A>, b: z.ZodType<B>): z.ZodType<A | B> {
  return z.unknown().transform((v, ctx) => {
    const r = (isB(v) ? b : a).safeParse(v);
    if (r.success) return r.data as A | B;
    for (const i of r.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: i.path as (string | number)[] });
    return z.NEVER;
  }) as unknown as z.ZodType<A | B>;
}

const fieldRefZ = z.string().regex(FIELD_REF_PATTERN, "Trường phải có dạng system:<khoá> hoặc custom:<khoá>") as unknown as z.ZodType<`system:${string}` | `custom:${string}`>;
const periodZ = z.enum(PAGE_PERIODS);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const sourceKeyZ = z.string().regex(/^[a-z][a-z0-9_.:-]{0,80}$/, "Khoá nguồn không hợp lệ");
const listFilterZ = z.strictObject({ ref: fieldRefZ, op: z.enum(FILTER_OPS), value: z.unknown().optional() });
const pinnedInputZ = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= MAX_BUTTON_INPUT_JSON, `Tham số của nút tối đa ${MAX_BUTTON_INPUT_JSON} ký tự`);

const aggregateZ = z.strictObject({ objectKey: sourceKeyZ, fn: z.enum(AGGREGATE_FNS), field: fieldRefZ.optional(), filters: z.array(listFilterZ).max(10).optional() });
const kpiMetricZ = z.strictObject({ metric: sourceKeyZ, period: periodZ.optional(), label: shortText(80).optional() });
const kpiAggregateZ = z.strictObject({ aggregate: aggregateZ, period: periodZ.optional(), dateField: fieldRefZ.optional(), label: shortText(80).optional() });
const kpiZ = either((v) => isRecord(v) && "aggregate" in v, kpiMetricZ, kpiAggregateZ);
const rowActionZ = z.strictObject({ action: sourceKeyZ, label: shortText(60), input: pinnedInputZ.optional(), confirm: shortText(200).optional() });
const tableZ = z.strictObject({
  source: sourceKeyZ,
  columns: z.array(fieldRefZ).max(20).optional(),
  filters: z.array(listFilterZ).max(10).optional(),
  sort: z.strictObject({ ref: fieldRefZ, dir: z.enum(["asc", "desc"]) }).nullable().optional(),
  pageSize: z.number().int().min(1).max(TABLE_MAX_PAGE_SIZE).optional(),
  rowLink: z.boolean().optional(),
  rowActions: z.array(rowActionZ).max(TABLE_MAX_ROW_ACTIONS, `Tối đa ${TABLE_MAX_ROW_ACTIONS} hành động theo dòng`).optional(),
});
const chartSeriesZ = z.strictObject({ series: sourceKeyZ, kind: z.enum(CHART_KINDS), period: periodZ.optional() });
const groupByZ = either((v) => isRecord(v) && "bucket" in v, z.strictObject({ ref: fieldRefZ }), z.strictObject({ bucket: z.enum(TIME_BUCKETS), dateField: fieldRefZ }));
const chartAggregateZ = z.strictObject({ aggregate: aggregateZ, kind: z.enum(CHART_KINDS), groupBy: groupByZ, period: periodZ.optional() });
const chartZ = either((v) => isRecord(v) && "aggregate" in v, chartSeriesZ, chartAggregateZ);
const kanbanZ = z.strictObject({
  objectKey: sourceKeyZ,
  statusField: fieldRefZ,
  cardFields: z.array(fieldRefZ).max(6),
  filters: z.array(listFilterZ).max(10).optional(),
  allowMove: z.boolean(),
  limit: z.number().int().min(1).max(KANBAN_MAX_CARDS).optional(),
});
const timelineZ = z.strictObject({ source: sourceKeyZ, recordParam: z.string().regex(RECORD_PARAM_PATTERN).optional(), limit: z.number().int().min(1).max(TIMELINE_MAX_ENTRIES).optional() });
const formZ = z.strictObject({ objectKey: sourceKeyZ, formKey: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), mode: z.enum(["create", "edit", "view"]), recordParam: z.string().regex(RECORD_PARAM_PATTERN).optional() });
const buttonZ = z.strictObject({ action: sourceKeyZ, label: shortText(60), input: pinnedInputZ.optional(), confirm: shortText(200).optional() });
const textZ = z
  .strictObject({ heading: shortText(120).optional(), body: z.string().max(MAX_TEXT_BODY).optional(), variant: z.enum(TEXT_VARIANTS).optional() })
  .refine((v) => Boolean(v.heading) || Boolean(v.body?.trim()), "Khối chữ cần tiêu đề hoặc nội dung");
const filterFieldZ = z.strictObject({ objectKey: sourceKeyZ, ref: fieldRefZ, op: z.enum(FILTER_OPS), label: shortText(60).optional() });
const filterZ = z
  .strictObject({
    period: z.boolean().optional(),
    fields: z.array(filterFieldZ).max(FILTER_MAX_FIELDS, `Bộ lọc tối đa ${FILTER_MAX_FIELDS} ô`),
    targets: z.array(z.string().regex(BLOCK_ID_PATTERN, "Đích phải là khoá khối")).max(PAGE_MAX_BLOCKS),
  })
  .refine((v) => v.period === true || v.fields.length > 0, "Bộ lọc cần ít nhất một ô lọc hoặc bộ chọn kỳ");
const columnZ = z.strictObject({});

// ═══ SỔ LOẠI KHỐI ═══

/** Một phụ thuộc biết trước của khối: khoá sổ nó trỏ tới, module + quyền mà sổ khai cho khoá đó. */
export type BlockDependency = {
  kind: "metric" | "series" | "list" | "timeline" | "action" | "object";
  key: string;
  /** Đường dẫn của ô cấu hình trỏ tới khoá này — lỗi tô đúng ô. */
  path: string;
  /** `false` ⇒ khoá không có trong sổ. */
  found: boolean;
  module: ModuleKey | null;
  permission: string | null;
};

export type ComponentSpec<T extends BlockType> = {
  type: T;
  label: string;
  description: string;
  defaultSpan: BlockSpan;
  config: z.ZodType<BlockConfigByType[T]>;
  /** Cấu hình mặc định khi người soạn thêm khối mới (trình soạn đọc). Khoá nguồn rỗng — người soạn phải chọn. */
  example: BlockConfigByType[T];
  /** Phụ thuộc biết trước (G7) — module + quyền lấy từ SỔ, không khai lại ở đây. */
  dependencies: (config: BlockConfigByType[T], catalog: PageCatalog) => BlockDependency[];
};

const dep = (kind: BlockDependency["kind"], key: string, path: string, spec: { module: ModuleKey | null; permission: string | null } | undefined): BlockDependency => ({
  kind,
  key,
  path,
  found: spec !== undefined,
  module: spec?.module ?? null,
  permission: spec?.permission ?? null,
});

function objectDep(key: string, path: string): BlockDependency {
  const def = objectDef(key);
  return { kind: "object", key, path, found: def !== null, module: def?.module ?? null, permission: null };
}

const listDep = (key: string, path: string, cat: PageCatalog) => dep("list", key, path, cat.lists.find((l) => l.objectKey === key));

export const COMPONENT_REGISTRY: { [T in BlockType]: ComponentSpec<T> } = {
  kpi: {
    type: "kpi",
    label: "Chỉ số",
    description: "Một con số từ sổ chỉ số (đơn, doanh thu, tồn…) hoặc phép đếm / cộng trên field của một đối tượng — CHƯA BIẾT in «—», không in 0.",
    defaultSpan: 3,
    config: kpiZ,
    example: { metric: "" },
    dependencies: (c, cat) => (isAggregateKpi(c) ? [listDep(c.aggregate.objectKey, "config.aggregate.objectKey", cat)] : [dep("metric", c.metric, "config.metric", cat.metrics.find((m) => m.key === c.metric))]),
  },
  table: {
    type: "table",
    label: "Bảng",
    description: "Danh sách bản ghi của một đối tượng — luôn phân trang (≤ 100 dòng); tối đa 3 hành động theo dòng.",
    defaultSpan: 12,
    config: tableZ,
    example: { source: "", pageSize: 20, rowLink: true },
    dependencies: (c, cat) => [
      listDep(c.source, "config.source", cat),
      ...(c.rowActions ?? []).map((a, i) => dep("action", a.action, `config.rowActions.${i}.action`, cat.actions.find((x) => x.key === a.action))),
    ],
  },
  chart: {
    type: "chart",
    label: "Biểu đồ",
    description: "Chuỗi số liệu theo ngày / theo nhóm từ sổ chuỗi, hoặc phép tổng hợp trên field — cột, đường hoặc tròn.",
    defaultSpan: 6,
    config: chartZ,
    example: { series: "", kind: "bar" },
    dependencies: (c, cat) => (isAggregateChart(c) ? [listDep(c.aggregate.objectKey, "config.aggregate.objectKey", cat)] : [dep("series", c.series, "config.series", cat.series.find((s) => s.key === c.series))]),
  },
  kanban: {
    type: "kanban",
    label: "Bảng kanban",
    description: "Thẻ xếp theo một field trạng thái CUSTOM; chuyển cột đi qua luật chuyển của field (G6).",
    defaultSpan: 12,
    config: kanbanZ,
    example: { objectKey: "", statusField: "custom:status", cardFields: [], allowMove: false },
    dependencies: (c, cat) => [listDep(c.objectKey, "config.objectKey", cat), objectDep(c.objectKey, "config.objectKey")],
  },
  timeline: {
    type: "timeline",
    label: "Dòng thời gian",
    description: "Các mốc của một bản ghi (đơn, vận đơn, mẫu…) — mỗi mốc mang nguồn của nó.",
    defaultSpan: 6,
    config: timelineZ,
    example: { source: "", recordParam: "id", limit: 30 },
    dependencies: (c, cat) => [dep("timeline", c.source, "config.source", cat.timelines.find((t) => t.key === c.source))],
  },
  form: {
    type: "form",
    label: "Biểu mẫu",
    description: "Form metadata ĐÃ XUẤT BẢN của một đối tượng (Phase 2) — cùng cổng ghi với trang gốc.",
    defaultSpan: 6,
    config: formZ,
    example: { objectKey: "", formKey: "", mode: "view", recordParam: "id" },
    dependencies: (c) => [objectDep(c.objectKey, "config.objectKey")],
  },
  button: {
    type: "button",
    label: "Nút hành động",
    description: "Gọi MỘT action trong sổ action; máy chủ đọc lại cấu hình đã xuất bản rồi mới chạy.",
    defaultSpan: 3,
    config: buttonZ,
    example: { action: "", label: "Mở" },
    dependencies: (c, cat) => [dep("action", c.action, "config.action", cat.actions.find((a) => a.key === c.action))],
  },
  text: {
    type: "text",
    label: "Chữ",
    description: "Tiêu đề, đoạn văn hoặc ghi chú — chữ thuần, không HTML.",
    defaultSpan: 12,
    config: textZ,
    example: { heading: "Tiêu đề", variant: "heading" },
    dependencies: () => [],
  },
  filter: {
    type: "filter",
    label: "Bộ lọc",
    description: "Thanh lọc cho người xem (≤ 4 ô, chọn kỳ) — áp lên bảng / kanban / KPI / biểu đồ tổng hợp cùng đối tượng.",
    defaultSpan: 12,
    config: filterZ,
    example: { period: true, fields: [], targets: [] },
    dependencies: (c, cat) => c.fields.map((f, i) => listDep(f.objectKey, `config.fields.${i}.objectKey`, cat)),
  },
  column: {
    type: "column",
    label: "Cột",
    description: "Xếp dọc tối đa 6 khối con trong một ô của lưới (vd hai KPI chồng nhau cạnh một biểu đồ).",
    defaultSpan: 4,
    config: columnZ as unknown as z.ZodType<BlockConfigByType["column"]>,
    example: {},
    dependencies: () => [],
  },
};

/** Phụ thuộc của một khối đã qua kiểm cấu hình. Khối lạ ⇒ rỗng. */
export function blockDependencies(block: PageBlock, catalog: PageCatalog = defaultPageCatalog()): BlockDependency[] {
  const spec = COMPONENT_REGISTRY[block.type] as ComponentSpec<BlockType> | undefined;
  if (!spec) return [];
  const parsed = spec.config.safeParse(block.config);
  return parsed.success ? spec.dependencies(parsed.data, catalog) : [];
}

// ═══ KIỂM SCHEMA ═══

export type ValidateOptions = {
  /** Module ĐANG BẬT của tổ chức. */
  modules: ReadonlySet<ModuleKey>;
  catalog?: PageCatalog;
  /** Lượt lưu nháp: module tắt là cảnh báo; lượt xuất bản (mặc định): là lỗi chặn (G7). */
  moduleIssues?: "error" | "warning";
  /**
   * Kiểm MỘT PHẦN trang (xem trước một khối): bỏ các phép kiểm tham chiếu sang khối KHÁC (đích của bộ lọc).
   * Lưu nháp / xuất bản không bao giờ bật cờ này.
   */
  partial?: boolean;
};

const MODULE_SET: ReadonlySet<string> = new Set(MODULE_KEYS);
const SECTION_KEYS = ["key", "title", "blocks", "variant"];
const BLOCK_KEYS = ["id", "type", "span", "title", "config", "visibility", "children"];

type Issue = { path: string; message: string };

function zodMessages(error: z.ZodError, base: string): Issue[] {
  return error.issues.map((i) => ({ path: [base, ...i.path.map(String)].filter(Boolean).join("."), message: i.message }));
}

type ParsedBlock = { id: string; type: BlockType; config: unknown; path: string };

/**
 * Kiểm một schema trang. Không dừng ở lỗi đầu tiên: người soạn thấy MỌI ô sai trong một lượt.
 * `ok = errors.length === 0`.
 */
export function validatePageSchema(schema: unknown, opts: ValidateOptions): PageValidation {
  const catalog = opts.catalog ?? defaultPageCatalog();
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const moduleSink = opts.moduleIssues === "warning" ? warnings : errors;

  if (!isRecord(schema)) return { ok: false, errors: [{ path: "", message: "Schema trang phải là một đối tượng." }], warnings };
  if (schema.version !== 1) errors.push({ path: "version", message: "Phiên bản schema phải là 1." });
  for (const k of Object.keys(schema)) if (k !== "version" && k !== "sections") errors.push({ path: k, message: `Khoá lạ «${k}» — schema trang chỉ có version và sections.` });
  if (!Array.isArray(schema.sections)) return { ok: false, errors: [...errors, { path: "sections", message: "sections phải là một danh sách." }], warnings };

  const sections = schema.sections as unknown[];
  if (sections.length > PAGE_MAX_SECTIONS) errors.push({ path: "sections", message: `Tối đa ${PAGE_MAX_SECTIONS} phần mỗi trang (đang có ${sections.length}).` });

  const sectionKeys = new Set<string>();
  const blockIds = new Set<string>();
  const parsed: ParsedBlock[] = [];
  let blockCount = 0;

  /** Kiểm MỘT khối (khối gốc hoặc khối con của cột). `inColumn` ⇒ không được là cột / bộ lọc. */
  const checkBlock = (rawBlock: unknown, bp: string, inColumn: boolean) => {
    blockCount += 1;
    if (!isRecord(rawBlock)) {
      errors.push({ path: bp, message: "Khối phải là một đối tượng." });
      return;
    }
    for (const k of Object.keys(rawBlock)) if (!BLOCK_KEYS.includes(k)) errors.push({ path: `${bp}.${k}`, message: `Khoá lạ «${k}» trong khối.` });
    const id = rawBlock.id;
    if (typeof id !== "string" || !BLOCK_ID_PATTERN.test(id)) errors.push({ path: `${bp}.id`, message: "Khoá khối phải khớp ^[a-z][a-z0-9_]{1,40}$." });
    else if (blockIds.has(id)) errors.push({ path: `${bp}.id`, message: `Khoá khối «${id}» bị trùng trong trang — nút hành động tra cấu hình theo khoá này.` });
    else blockIds.add(id);

    const type = rawBlock.type;
    if (typeof type !== "string" || !(BLOCK_TYPES as readonly string[]).includes(type)) {
      errors.push({ path: `${bp}.type`, message: `Loại khối «${String(type)}» không có trong sổ (${BLOCK_TYPES.join(", ")}).` });
      return;
    }
    if (inColumn && (type === "column" || type === "filter")) {
      errors.push({ path: `${bp}.type`, message: type === "column" ? "Cột chỉ lồng MỘT tầng — không đặt cột trong cột." : "Bộ lọc là một thanh ngang của trang — không đặt trong cột." });
      return;
    }
    if (!(BLOCK_SPANS as readonly unknown[]).includes(rawBlock.span)) errors.push({ path: `${bp}.span`, message: `Độ rộng phải là một trong ${BLOCK_SPANS.join(", ")}.` });
    if (rawBlock.title !== undefined && (typeof rawBlock.title !== "string" || rawBlock.title.length > 120)) errors.push({ path: `${bp}.title`, message: "Tiêu đề khối tối đa 120 ký tự." });
    if (rawBlock.visibility !== undefined) {
      const v = rawBlock.visibility;
      if (!isRecord(v) || Object.keys(v).some((k) => k !== "permission" && k !== "module")) errors.push({ path: `${bp}.visibility`, message: "visibility chỉ có permission và module." });
      else {
        if (v.permission !== undefined && (typeof v.permission !== "string" || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(v.permission))) errors.push({ path: `${bp}.visibility.permission`, message: "Khoá quyền không hợp lệ." });
        if (v.module !== undefined && (typeof v.module !== "string" || !MODULE_SET.has(v.module))) errors.push({ path: `${bp}.visibility.module`, message: `Module «${String(v.module)}» không có trong sổ module.` });
      }
    }

    if (type === "column") {
      const kids = rawBlock.children;
      if (!Array.isArray(kids)) errors.push({ path: `${bp}.children`, message: "Cột cần danh sách khối con (children)." });
      else {
        if (kids.length === 0) warnings.push({ path: `${bp}.children`, message: "Cột chưa có khối con nào — nó sẽ không hiện gì." });
        if (kids.length > COLUMN_MAX_CHILDREN) errors.push({ path: `${bp}.children`, message: `Cột chứa tối đa ${COLUMN_MAX_CHILDREN} khối con (đang có ${kids.length}).` });
        kids.forEach((kid, ci) => checkBlock(kid, `${bp}.children.${ci}`, true));
      }
    } else if (rawBlock.children !== undefined) {
      errors.push({ path: `${bp}.children`, message: "Chỉ khối Cột mới có khối con." });
    }

    const spec = COMPONENT_REGISTRY[type as BlockType] as ComponentSpec<BlockType>;
    const res = spec.config.safeParse(rawBlock.config);
    if (!res.success) {
      errors.push(...zodMessages(res.error, `${bp}.config`));
      return;
    }
    const config = res.data;

    for (const d of spec.dependencies(config, catalog)) {
      if (!d.found) {
        errors.push({ path: `${bp}.${d.path}`, message: d.kind === "object" ? `Đối tượng «${d.key}» không có trong sổ đối tượng.` : `Khoá «${d.key}» không có trong sổ ${DEP_LABEL[d.kind]}.` });
        continue;
      }
      if (d.module && !opts.modules.has(d.module)) moduleSink.push({ path: `${bp}.${d.path}`, message: `«${d.key}» thuộc module «${d.module}» đang TẮT với tổ chức — bật module trước khi xuất bản.` });
    }

    checkBlockSpecifics(type as BlockType, config, catalog, `${bp}.config`, errors);
    if (typeof id === "string") parsed.push({ id, type: type as BlockType, config, path: bp });
  };

  sections.forEach((rawSection, si) => {
    const sp = `sections.${si}`;
    if (!isRecord(rawSection)) {
      errors.push({ path: sp, message: "Phần trang phải là một đối tượng." });
      return;
    }
    for (const k of Object.keys(rawSection)) if (!SECTION_KEYS.includes(k)) errors.push({ path: `${sp}.${k}`, message: `Khoá lạ «${k}» trong phần trang.` });
    const key = rawSection.key;
    if (typeof key !== "string" || !SECTION_KEY_PATTERN.test(key)) errors.push({ path: `${sp}.key`, message: "Khoá phần phải là chữ thường, số, gạch dưới, bắt đầu bằng chữ." });
    else if (sectionKeys.has(key)) errors.push({ path: `${sp}.key`, message: `Khoá phần «${key}» bị trùng.` });
    else sectionKeys.add(key);
    if (rawSection.title !== undefined && (typeof rawSection.title !== "string" || rawSection.title.length > 120)) errors.push({ path: `${sp}.title`, message: "Tiêu đề phần tối đa 120 ký tự." });
    if (rawSection.variant !== undefined && !(SECTION_VARIANTS as readonly unknown[]).includes(rawSection.variant)) errors.push({ path: `${sp}.variant`, message: `Kiểu phần phải là một trong ${SECTION_VARIANTS.join(", ")}.` });
    if (rawSection.variant === "plain" && typeof rawSection.title === "string" && rawSection.title.trim()) warnings.push({ path: `${sp}.title`, message: "Hàng (không khung) không hiện tiêu đề — tiêu đề này sẽ không hiện." });
    if (!Array.isArray(rawSection.blocks)) {
      errors.push({ path: `${sp}.blocks`, message: "blocks phải là một danh sách." });
      return;
    }
    if (rawSection.blocks.length === 0) warnings.push({ path: `${sp}.blocks`, message: "Phần này chưa có khối nào — nó sẽ không hiện gì." });
    (rawSection.blocks as unknown[]).forEach((rawBlock, bi) => checkBlock(rawBlock, `${sp}.blocks.${bi}`, false));
  });

  if (blockCount > PAGE_MAX_BLOCKS) errors.push({ path: "sections", message: `Tối đa ${PAGE_MAX_BLOCKS} khối mỗi trang, đếm cả khối con trong cột (đang có ${blockCount}) — một trang không được thành hàng chục câu truy vấn.` });
  if (!opts.partial) checkFilterTargets(parsed, errors);
  return { ok: errors.length === 0, errors, warnings };
}

const DEP_LABEL: Record<BlockDependency["kind"], string> = {
  metric: "chỉ số",
  series: "chuỗi biểu đồ",
  list: "nguồn danh sách",
  timeline: "dòng thời gian",
  action: "action",
  object: "đối tượng",
};

/** Đối tượng mà một khối đích của bộ lọc đọc — `null` ⇒ khối không nhận bộ lọc (KPI / biểu đồ từ sổ, chữ, nút…). */
export function filterTargetObject(type: BlockType, config: unknown): string | null {
  if (type === "table") return (config as BlockConfigByType["table"]).source ?? null;
  if (type === "kanban") return (config as BlockConfigByType["kanban"]).objectKey ?? null;
  if (type === "kpi" && isAggregateKpi(config as BlockConfigByType["kpi"])) return (config as { aggregate: AggregateSpec }).aggregate.objectKey;
  if (type === "chart" && isAggregateChart(config as BlockConfigByType["chart"])) return (config as { aggregate: AggregateSpec }).aggregate.objectKey;
  return null;
}

/** Đích của mọi bộ lọc: khối CÓ THẬT, nhận được bộ lọc, cùng đối tượng với ít nhất một ô lọc. */
function checkFilterTargets(blocks: ParsedBlock[], errors: Issue[]) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const f of blocks) {
    if (f.type !== "filter") continue;
    const c = f.config as BlockConfigByType["filter"];
    const objects = new Set(c.fields.map((x) => x.objectKey));
    if (c.fields.length > 0 && c.targets.length === 0) errors.push({ path: `${f.path}.config.targets`, message: "Bộ lọc có ô lọc nhưng chưa nhắm khối nào." });
    if (new Set(c.targets).size !== c.targets.length) errors.push({ path: `${f.path}.config.targets`, message: "Đích bị trùng." });
    c.targets.forEach((t, i) => {
      const at = `${f.path}.config.targets.${i}`;
      const target = byId.get(t);
      if (!target || t === f.id) {
        errors.push({ path: at, message: `Không có khối «${t}» trong trang để lọc.` });
        return;
      }
      const obj = filterTargetObject(target.type, target.config);
      if (!obj) errors.push({ path: at, message: `Khối «${t}» không nhận bộ lọc — chỉ bảng, kanban, KPI / biểu đồ tổng hợp.` });
      else if (c.fields.length > 0 && !objects.has(obj)) errors.push({ path: at, message: `Khối «${t}» đọc «${obj}», không ô lọc nào cùng đối tượng.` });
    });
  }
}

function systemField(def: ObjectDef, ref: string): SystemFieldDef | null | undefined {
  if (!ref.startsWith("system:")) return undefined;
  return def.fields.find((x) => x.key === ref.slice("system:".length)) ?? null;
}

/** Luật riêng từng loại mà zod không nói được: kỳ / loại biểu đồ nguồn hỗ trợ, field hệ thống có thật, kanban chỉ trên field custom. */
function checkBlockSpecifics(type: BlockType, config: unknown, catalog: PageCatalog, base: string, errors: Issue[]) {
  const systemRefProblems = (objectKey: string, refs: { ref: string; path: string; needFilterable?: boolean }[]) => {
    const def = objectDef(objectKey);
    if (!def) return;
    for (const r of refs) {
      const f = systemField(def, r.ref);
      if (f === undefined) continue;
      if (!f) errors.push({ path: r.path, message: `${def.label} không có field hệ thống «${r.ref}».` });
      else if (r.needFilterable && !f.filterable) errors.push({ path: r.path, message: `Field «${f.label}» không lọc được.` });
    }
  };
  /** Field hệ thống trong vai trò: số tổng hợp được · nhóm được · ngày. Field custom kiểm ở registry. */
  const roleProblem = (objectKey: string, ref: string, path: string, role: "aggregate" | "group" | "date") => {
    const def = objectDef(objectKey);
    if (!def) return;
    const f = systemField(def, ref);
    if (f === undefined) return;
    if (!f) errors.push({ path, message: `${def.label} không có field hệ thống «${ref}».` });
    else if (role === "aggregate" && !(AGGREGATE_NUMERIC_TYPES.has(f.type) && f.aggregatable === true))
      errors.push({
        path,
        message: AGGREGATE_NUMERIC_TYPES.has(f.type)
          ? `Field «${f.label}» không khai tổng hợp — ${f.type === "currency" ? "tiền của đơn / vận đơn / hàng hoàn chỉ đọc qua sổ chỉ số (ORDER_OUTCOME), không cộng thẳng" : "chưa khai aggregatable trong sổ đối tượng"}.`
          : `Field «${f.label}» không phải số — chỉ đếm được.`,
      });
    else if (role === "group" && !(GROUPABLE_TYPES.has(f.type) || def.statusFields.includes(f.key))) errors.push({ path, message: `Field «${f.label}» không nhóm được — chỉ field chọn / trạng thái / có-không / người dùng.` });
    else if (role === "date" && !DATE_TYPES.has(f.type)) errors.push({ path, message: `Field «${f.label}» không phải ngày / ngày giờ.` });
  };
  const checkAggregate = (a: AggregateSpec, at: string) => {
    if (a.fn !== "count" && !a.field) errors.push({ path: `${at}.field`, message: `Phép «${a.fn}» cần một field số.` });
    if (a.field && a.fn !== "count") roleProblem(a.objectKey, a.field, `${at}.field`, "aggregate");
    if (a.field && a.fn === "count") systemRefProblems(a.objectKey, [{ ref: a.field, path: `${at}.field` }]);
    systemRefProblems(a.objectKey, (a.filters ?? []).map((f, i) => ({ ref: f.ref, path: `${at}.filters.${i}.ref`, needFilterable: true })));
  };

  if (type === "kpi") {
    const c = config as BlockConfigByType["kpi"];
    if (isAggregateKpi(c)) {
      checkAggregate(c.aggregate, `${base}.aggregate`);
      if (c.dateField) roleProblem(c.aggregate.objectKey, c.dateField, `${base}.dateField`, "date");
      if (c.period && !c.dateField) errors.push({ path: `${base}.period`, message: "Kỳ chỉ áp khi chọn field ngày (dateField) — không có mốc thì không biết bản ghi nào thuộc kỳ." });
    } else {
      const spec = catalog.metrics.find((m) => m.key === c.metric);
      if (spec && c.period && !spec.periods.includes(c.period)) errors.push({ path: `${base}.period`, message: `Chỉ số «${spec.label}» không hỗ trợ kỳ «${c.period}» (hỗ trợ: ${spec.periods.join(", ")}).` });
    }
  } else if (type === "chart") {
    const c = config as BlockConfigByType["chart"];
    if (isAggregateChart(c)) {
      checkAggregate(c.aggregate, `${base}.aggregate`);
      if ("ref" in c.groupBy) roleProblem(c.aggregate.objectKey, c.groupBy.ref, `${base}.groupBy.ref`, "group");
      else roleProblem(c.aggregate.objectKey, c.groupBy.dateField, `${base}.groupBy.dateField`, "date");
      if (c.kind === "pie" && !("ref" in c.groupBy)) errors.push({ path: `${base}.kind`, message: "Biểu đồ tròn chỉ dùng khi nhóm theo field — chuỗi thời gian vẽ cột hoặc đường." });
      if (c.period && "ref" in c.groupBy) errors.push({ path: `${base}.period`, message: "Kỳ chỉ áp khi nhóm theo ngày / tuần / tháng." });
    } else {
      const spec = catalog.series.find((s) => s.key === c.series);
      if (spec && !spec.kinds.includes(c.kind)) errors.push({ path: `${base}.kind`, message: `Chuỗi «${spec.label}» không vẽ được dạng «${c.kind}» (hỗ trợ: ${spec.kinds.join(", ")}).` });
      if (spec && c.period && !spec.periods.includes(c.period)) errors.push({ path: `${base}.period`, message: `Chuỗi «${spec.label}» không hỗ trợ kỳ «${c.period}» (hỗ trợ: ${spec.periods.join(", ")}).` });
    }
  } else if (type === "table") {
    const c = config as BlockConfigByType["table"];
    systemRefProblems(c.source, [
      ...(c.columns ?? []).map((ref, i) => ({ ref, path: `${base}.columns.${i}` })),
      ...(c.filters ?? []).map((f, i) => ({ ref: f.ref, path: `${base}.filters.${i}.ref`, needFilterable: true })),
      ...(c.sort ? [{ ref: c.sort.ref, path: `${base}.sort.ref` }] : []),
    ]);
    if (new Set(c.columns ?? []).size !== (c.columns ?? []).length) errors.push({ path: `${base}.columns`, message: "Cột bị trùng." });
    (c.rowActions ?? []).forEach((a, i) => {
      const at = `${base}.rowActions.${i}`;
      const spec = catalog.actions.find((x) => x.key === a.action);
      if (!spec) return; // phụ thuộc đã báo
      if (!ROW_ACTION_KEYS.includes(spec.key)) errors.push({ path: `${at}.action`, message: `«${spec.label}» không nhận một bản ghi — không đặt được trên từng dòng.` });
      if (spec.objectKey && spec.objectKey !== c.source) errors.push({ path: `${at}.action`, message: `«${spec.label}» chỉ dùng cho «${spec.objectKey}», bảng đang đọc «${c.source}».` });
      const pinned = a.input ?? {};
      if (pinned.objectKey !== undefined && pinned.objectKey !== c.source) errors.push({ path: `${at}.input.objectKey`, message: "Hành động theo dòng luôn chạy trên đối tượng của bảng — không ghim đối tượng khác." });
      if (pinned.recordId !== undefined) errors.push({ path: `${at}.input.recordId`, message: "Bản ghi lấy từ DÒNG được bấm — không ghim sẵn." });
      if (spec.key === "update_safe_field" && typeof pinned.field !== "string") errors.push({ path: `${at}.input.field`, message: "Sửa field bổ sung cần ghim field (input.field)." });
      if (spec.key === "request_approval" && typeof pinned.ruleKey !== "string") errors.push({ path: `${at}.input.ruleKey`, message: "Gửi yêu cầu duyệt cần ghim luật (input.ruleKey)." });
    });
  } else if (type === "kanban") {
    const c = config as BlockConfigByType["kanban"];
    if (!c.statusField.startsWith("custom:")) errors.push({ path: `${base}.statusField`, message: "Kanban chỉ chạy trên field CUSTOM kiểu trạng thái — không đổi trạng thái HỆ THỐNG từ một trang (G6)." });
    systemRefProblems(c.objectKey, [...c.cardFields.map((ref, i) => ({ ref, path: `${base}.cardFields.${i}` })), ...(c.filters ?? []).map((f, i) => ({ ref: f.ref, path: `${base}.filters.${i}.ref`, needFilterable: true }))]);
  } else if (type === "timeline") {
    const c = config as BlockConfigByType["timeline"];
    const spec = catalog.timelines.find((t) => t.key === c.source);
    if (spec && spec.recordObject && !c.recordParam) errors.push({ path: `${base}.recordParam`, message: `Dòng thời gian «${spec.label}» cần tham số URL mang id bản ghi (vd «id»).` });
  } else if (type === "form") {
    const c = config as BlockConfigByType["form"];
    const def = objectDef(c.objectKey);
    if (def) {
      if (!def.capabilities.forms) errors.push({ path: `${base}.objectKey`, message: `${def.label} không có form metadata.` });
      else if (!def.forms.some((f) => f.key === c.formKey)) errors.push({ path: `${base}.formKey`, message: `${def.label} không có form «${c.formKey}».` });
      if (c.mode !== "create" && !c.recordParam) errors.push({ path: `${base}.recordParam`, message: "Form xem / sửa cần tham số URL mang id bản ghi." });
    }
  } else if (type === "filter") {
    const c = config as BlockConfigByType["filter"];
    const seen = new Set<string>();
    c.fields.forEach((f, i) => {
      const at = `${base}.fields.${i}`;
      const k = `${f.objectKey}|${f.ref}|${f.op}`;
      if (seen.has(k)) errors.push({ path: at, message: "Ô lọc bị trùng." });
      seen.add(k);
      const def = objectDef(f.objectKey);
      if (!def) return;
      const sf = systemField(def, f.ref);
      if (sf === undefined) return;
      if (!sf) errors.push({ path: `${at}.ref`, message: `${def.label} không có field hệ thống «${f.ref}».` });
      else if (!sf.filterable) errors.push({ path: `${at}.ref`, message: `Field «${sf.label}» không lọc được.` });
      else if (!filterOpFits(sf.type, f.op)) errors.push({ path: `${at}.op`, message: `Phép «${f.op}» không dùng được với field «${sf.label}».` });
    });
  }
}

export type CustomRefRole = "column" | "filter" | "status" | "aggregate" | "group" | "date";

/**
 * Mọi `custom:<khoá>` của schema (kể cả khối con của cột), theo đối tượng — registry đối chiếu với định nghĩa field
 * của tổ chức. `status` = `statusField` của kanban; `aggregate` = field số của phép tổng hợp; `group` = nhóm của
 * biểu đồ; `date` = mốc kỳ / trục thời gian.
 */
export function customRefsOf(schema: PageSchema): { objectKey: string; ref: string; path: string; role: CustomRefRole }[] {
  const out: { objectKey: string; ref: string; path: string; role: CustomRefRole }[] = [];
  const push = (objectKey: string, ref: string | undefined, path: string, role: CustomRefRole) => {
    if (typeof ref === "string" && ref.startsWith("custom:")) out.push({ objectKey, ref, path, role });
  };
  const aggregate = (a: AggregateSpec, base: string) => {
    push(a.objectKey, a.field, `${base}.field`, a.fn === "count" ? "column" : "aggregate");
    (a.filters ?? []).forEach((f, i) => push(a.objectKey, f.ref, `${base}.filters.${i}.ref`, "filter"));
  };
  for (const { block: b, path } of flattenBlocks(schema)) {
    const base = `${path}.config`;
    if (b.type === "table") {
      const c = b.config as BlockConfigByType["table"];
      (c.columns ?? []).forEach((ref, i) => push(c.source, ref, `${base}.columns.${i}`, "column"));
      (c.filters ?? []).forEach((f, i) => push(c.source, f.ref, `${base}.filters.${i}.ref`, "filter"));
      push(c.source, c.sort?.ref, `${base}.sort.ref`, "column");
    } else if (b.type === "kanban") {
      const c = b.config as BlockConfigByType["kanban"];
      push(c.objectKey, c.statusField, `${base}.statusField`, "status");
      c.cardFields.forEach((ref, i) => push(c.objectKey, ref, `${base}.cardFields.${i}`, "column"));
      (c.filters ?? []).forEach((f, i) => push(c.objectKey, f.ref, `${base}.filters.${i}.ref`, "filter"));
    } else if (b.type === "kpi") {
      const c = b.config as BlockConfigByType["kpi"];
      if (isAggregateKpi(c)) {
        aggregate(c.aggregate, `${base}.aggregate`);
        push(c.aggregate.objectKey, c.dateField, `${base}.dateField`, "date");
      }
    } else if (b.type === "chart") {
      const c = b.config as BlockConfigByType["chart"];
      if (isAggregateChart(c)) {
        aggregate(c.aggregate, `${base}.aggregate`);
        if ("ref" in c.groupBy) push(c.aggregate.objectKey, c.groupBy.ref, `${base}.groupBy.ref`, "group");
        else push(c.aggregate.objectKey, c.groupBy.dateField, `${base}.groupBy.dateField`, "date");
      }
    } else if (b.type === "filter") {
      const c = b.config as BlockConfigByType["filter"];
      c.fields.forEach((f, i) => push(f.objectKey, f.ref, `${base}.fields.${i}.ref`, "filter"));
    }
  }
  return out;
}

/** Chuẩn hoá MỘT khối đã đạt kiểm (đệ quy cho con của cột). */
function normalizeBlock(b: PageBlock): PageBlock {
  const spec = COMPONENT_REGISTRY[b.type] as ComponentSpec<BlockType>;
  const config = spec.config.parse(b.config);
  return {
    id: b.id,
    type: b.type,
    span: b.span,
    ...(b.title ? { title: b.title } : {}),
    config,
    ...(b.visibility && (b.visibility.permission || b.visibility.module) ? { visibility: { ...(b.visibility.permission ? { permission: b.visibility.permission } : {}), ...(b.visibility.module ? { module: b.visibility.module } : {}) } } : {}),
    ...(b.type === "column" ? { children: (b.children ?? []).map(normalizeBlock) } : {}),
  } as PageBlock;
}

/**
 * Chuẩn hoá một schema ĐÃ ĐẠT `validatePageSchema`: cấu hình đi qua zod của loại khối (bỏ khoảng trắng thừa,
 * giữ đúng khoá khai), khoá lạ không bao giờ vào CSDL. Schema chưa đạt ⇒ `null`. Section `card` (mặc định) không
 * ghi `variant` — schema Phase 4 đi qua chuẩn hoá ra ĐÚNG nguyên văn.
 */
export function normalizePageSchema(schema: unknown, opts: ValidateOptions): PageSchema | null {
  if (!validatePageSchema(schema, { ...opts, moduleIssues: "warning" }).ok) return null;
  const s = schema as PageSchema;
  return {
    version: 1,
    sections: s.sections.map(
      (sec): PageSection => ({
        key: sec.key,
        ...(sec.title ? { title: sec.title } : {}),
        ...(sec.variant === "plain" ? { variant: "plain" as const } : {}),
        blocks: sec.blocks.map(normalizeBlock),
      }),
    ),
  };
}

export const EMPTY_PAGE_SCHEMA: PageSchema = { version: 1, sections: [] };

/** Tổng số khối, ĐẾM CẢ khối con của cột — trang không có khối nào thì không xuất bản. */
export function blockCountOf(schema: PageSchema): number {
  return flattenBlocks(schema).length;
}
