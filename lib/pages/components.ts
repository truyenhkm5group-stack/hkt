/**
 * ═══════════ SỔ LOẠI KHỐI + KIỂM SCHEMA TRANG (Phase 4 · G2, G3, G7, G9) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Hợp đồng: docs/platform/phase-4-contracts.md. Tệp này KHÔNG đọc CSDL, không import `next` hay `node:*`:
 * máy chủ (lưu nháp / xuất bản — `lib/pages/registry.ts`), trình soạn (giao diện) và bài kiểm gọi CÙNG
 * `validatePageSchema`, nên "trang này hợp lệ không" chỉ có một câu trả lời.
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
 * Field CUSTOM (`custom:<khoá>`) không kiểm được ở đây — định nghĩa của nó nằm trong CSDL tổ chức; registry
 * kiểm tiếp phần đó (`customRefProblems`) sau khi hàm thuần này đạt.
 */
import { z } from "zod";
import { objectDef } from "@/lib/constants/object-registry";
import { MODULE_KEYS, type ModuleKey } from "@/lib/constants/platform-modules";
import { FIELD_REF_PATTERN } from "@/lib/metadata/form-schema";
import { LIST_SOURCES, METRIC_SOURCES, PAGE_ACTIONS, SERIES_SOURCES, TIMELINE_SOURCES } from "@/lib/pages/catalog";
import {
  BLOCK_SPANS,
  BLOCK_TYPES,
  PAGE_MAX_BLOCKS,
  PAGE_MAX_SECTIONS,
  type BlockConfigByType,
  type BlockSpan,
  type BlockType,
  type ChartKind,
  type ListSourceSpec,
  type MetricSourceSpec,
  type PageActionSpec,
  type PageBlock,
  type PageSchema,
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

// ═══ zod cấu hình từng loại khối (đúng `BlockConfigByType`) ═══

const fieldRefZ = z.string().regex(FIELD_REF_PATTERN, "Trường phải có dạng system:<khoá> hoặc custom:<khoá>") as unknown as z.ZodType<`system:${string}` | `custom:${string}`>;
const periodZ = z.enum(PAGE_PERIODS);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const sourceKeyZ = z.string().regex(/^[a-z][a-z0-9_.:-]{0,80}$/, "Khoá nguồn không hợp lệ");
const listFilterZ = z.strictObject({ ref: fieldRefZ, op: z.enum(FILTER_OPS), value: z.unknown().optional() });

const kpiZ = z.strictObject({ metric: sourceKeyZ, period: periodZ.optional(), label: shortText(80).optional() });
const tableZ = z.strictObject({
  source: sourceKeyZ,
  columns: z.array(fieldRefZ).max(20).optional(),
  filters: z.array(listFilterZ).max(10).optional(),
  sort: z.strictObject({ ref: fieldRefZ, dir: z.enum(["asc", "desc"]) }).nullable().optional(),
  pageSize: z.number().int().min(1).max(TABLE_MAX_PAGE_SIZE).optional(),
  rowLink: z.boolean().optional(),
});
const chartZ = z.strictObject({ series: sourceKeyZ, kind: z.enum(CHART_KINDS), period: periodZ.optional() });
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
const buttonZ = z.strictObject({
  action: sourceKeyZ,
  label: shortText(60),
  input: z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= MAX_BUTTON_INPUT_JSON, `Tham số của nút tối đa ${MAX_BUTTON_INPUT_JSON} ký tự`)
    .optional(),
  confirm: shortText(200).optional(),
});
const textZ = z
  .strictObject({ heading: shortText(120).optional(), body: z.string().max(MAX_TEXT_BODY).optional() })
  .refine((v) => Boolean(v.heading) || Boolean(v.body?.trim()), "Khối chữ cần tiêu đề hoặc nội dung");

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

export const COMPONENT_REGISTRY: { [T in BlockType]: ComponentSpec<T> } = {
  kpi: {
    type: "kpi",
    label: "Chỉ số",
    description: "Một con số từ sổ chỉ số (đơn, doanh thu, tồn…) — CHƯA BIẾT in «—», không in 0.",
    defaultSpan: 3,
    config: kpiZ,
    example: { metric: "" },
    dependencies: (c, cat) => [dep("metric", c.metric, "config.metric", cat.metrics.find((m) => m.key === c.metric))],
  },
  table: {
    type: "table",
    label: "Bảng",
    description: "Danh sách bản ghi của một đối tượng — luôn phân trang (≤ 100 dòng).",
    defaultSpan: 12,
    config: tableZ,
    example: { source: "", pageSize: 20, rowLink: true },
    dependencies: (c, cat) => [dep("list", c.source, "config.source", cat.lists.find((l) => l.objectKey === c.source))],
  },
  chart: {
    type: "chart",
    label: "Biểu đồ",
    description: "Chuỗi số liệu theo ngày / theo nhóm — cột, đường hoặc tròn.",
    defaultSpan: 6,
    config: chartZ,
    example: { series: "", kind: "bar" },
    dependencies: (c, cat) => [dep("series", c.series, "config.series", cat.series.find((s) => s.key === c.series))],
  },
  kanban: {
    type: "kanban",
    label: "Bảng kanban",
    description: "Thẻ xếp theo một field trạng thái CUSTOM; chuyển cột đi qua luật chuyển của field (G6).",
    defaultSpan: 12,
    config: kanbanZ,
    example: { objectKey: "", statusField: "custom:status", cardFields: [], allowMove: false },
    dependencies: (c, cat) => [dep("list", c.objectKey, "config.objectKey", cat.lists.find((l) => l.objectKey === c.objectKey)), objectDep(c.objectKey, "config.objectKey")],
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
    description: "Tiêu đề và đoạn giải thích — chữ thuần, không HTML.",
    defaultSpan: 12,
    config: textZ,
    example: { heading: "Tiêu đề" },
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
};

const MODULE_SET: ReadonlySet<string> = new Set(MODULE_KEYS);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function zodMessages(error: z.ZodError, base: string): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: [base, ...i.path.map(String)].filter(Boolean).join("."), message: i.message }));
}

/**
 * Kiểm một schema trang. Không dừng ở lỗi đầu tiên: người soạn thấy MỌI ô sai trong một lượt.
 * `ok = errors.length === 0`.
 */
export function validatePageSchema(schema: unknown, opts: ValidateOptions): PageValidation {
  const catalog = opts.catalog ?? defaultPageCatalog();
  const errors: { path: string; message: string }[] = [];
  const warnings: { path: string; message: string }[] = [];
  const moduleSink = opts.moduleIssues === "warning" ? warnings : errors;

  if (!isRecord(schema)) return { ok: false, errors: [{ path: "", message: "Schema trang phải là một đối tượng." }], warnings };
  if (schema.version !== 1) errors.push({ path: "version", message: "Phiên bản schema phải là 1." });
  for (const k of Object.keys(schema)) if (k !== "version" && k !== "sections") errors.push({ path: k, message: `Khoá lạ «${k}» — schema trang chỉ có version và sections.` });
  if (!Array.isArray(schema.sections)) return { ok: false, errors: [...errors, { path: "sections", message: "sections phải là một danh sách." }], warnings };

  const sections = schema.sections as unknown[];
  if (sections.length > PAGE_MAX_SECTIONS) errors.push({ path: "sections", message: `Tối đa ${PAGE_MAX_SECTIONS} phần mỗi trang (đang có ${sections.length}).` });

  const sectionKeys = new Set<string>();
  const blockIds = new Set<string>();
  let blockCount = 0;

  sections.forEach((rawSection, si) => {
    const sp = `sections.${si}`;
    if (!isRecord(rawSection)) {
      errors.push({ path: sp, message: "Phần trang phải là một đối tượng." });
      return;
    }
    for (const k of Object.keys(rawSection)) if (!["key", "title", "blocks"].includes(k)) errors.push({ path: `${sp}.${k}`, message: `Khoá lạ «${k}» trong phần trang.` });
    const key = rawSection.key;
    if (typeof key !== "string" || !SECTION_KEY_PATTERN.test(key)) errors.push({ path: `${sp}.key`, message: "Khoá phần phải là chữ thường, số, gạch dưới, bắt đầu bằng chữ." });
    else if (sectionKeys.has(key)) errors.push({ path: `${sp}.key`, message: `Khoá phần «${key}» bị trùng.` });
    else sectionKeys.add(key);
    if (rawSection.title !== undefined && (typeof rawSection.title !== "string" || rawSection.title.length > 120)) errors.push({ path: `${sp}.title`, message: "Tiêu đề phần tối đa 120 ký tự." });
    if (!Array.isArray(rawSection.blocks)) {
      errors.push({ path: `${sp}.blocks`, message: "blocks phải là một danh sách." });
      return;
    }
    if (rawSection.blocks.length === 0) warnings.push({ path: `${sp}.blocks`, message: "Phần này chưa có khối nào — nó sẽ không hiện gì." });

    (rawSection.blocks as unknown[]).forEach((rawBlock, bi) => {
      blockCount += 1;
      const bp = `${sp}.blocks.${bi}`;
      if (!isRecord(rawBlock)) {
        errors.push({ path: bp, message: "Khối phải là một đối tượng." });
        return;
      }
      for (const k of Object.keys(rawBlock)) if (!["id", "type", "span", "title", "config", "visibility"].includes(k)) errors.push({ path: `${bp}.${k}`, message: `Khoá lạ «${k}» trong khối.` });
      const id = rawBlock.id;
      if (typeof id !== "string" || !BLOCK_ID_PATTERN.test(id)) errors.push({ path: `${bp}.id`, message: "Khoá khối phải khớp ^[a-z][a-z0-9_]{1,40}$." });
      else if (blockIds.has(id)) errors.push({ path: `${bp}.id`, message: `Khoá khối «${id}» bị trùng trong trang — nút hành động tra cấu hình theo khoá này.` });
      else blockIds.add(id);

      const type = rawBlock.type;
      if (typeof type !== "string" || !(BLOCK_TYPES as readonly string[]).includes(type)) {
        errors.push({ path: `${bp}.type`, message: `Loại khối «${String(type)}» không có trong sổ (${BLOCK_TYPES.join(", ")}).` });
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

      const spec = COMPONENT_REGISTRY[type as BlockType] as ComponentSpec<BlockType>;
      const parsed = spec.config.safeParse(rawBlock.config);
      if (!parsed.success) {
        errors.push(...zodMessages(parsed.error, `${bp}.config`));
        return;
      }
      const config = parsed.data;

      for (const d of spec.dependencies(config, catalog)) {
        if (!d.found) {
          errors.push({ path: `${bp}.${d.path}`, message: d.kind === "object" ? `Đối tượng «${d.key}» không có trong sổ đối tượng.` : `Khoá «${d.key}» không có trong sổ ${DEP_LABEL[d.kind]}.` });
          continue;
        }
        if (d.module && !opts.modules.has(d.module)) moduleSink.push({ path: `${bp}.${d.path}`, message: `«${d.key}» thuộc module «${d.module}» đang TẮT với tổ chức — bật module trước khi xuất bản.` });
      }

      checkBlockSpecifics(type as BlockType, config, catalog, `${bp}.config`, errors);
    });
  });

  if (blockCount > PAGE_MAX_BLOCKS) errors.push({ path: "sections", message: `Tối đa ${PAGE_MAX_BLOCKS} khối mỗi trang (đang có ${blockCount}) — một trang không được thành hàng chục câu truy vấn.` });
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

/** Luật riêng từng loại mà zod không nói được: kỳ / loại biểu đồ nguồn hỗ trợ, field hệ thống có thật, kanban chỉ trên field custom. */
function checkBlockSpecifics(type: BlockType, config: unknown, catalog: PageCatalog, base: string, errors: { path: string; message: string }[]) {
  const systemRefProblems = (objectKey: string, refs: { ref: string; path: string; needFilterable?: boolean }[]) => {
    const def = objectDef(objectKey);
    if (!def) return;
    for (const r of refs) {
      if (!r.ref.startsWith("system:")) continue;
      const f = def.fields.find((x) => x.key === r.ref.slice("system:".length));
      if (!f) errors.push({ path: r.path, message: `${def.label} không có field hệ thống «${r.ref}».` });
      else if (r.needFilterable && !f.filterable) errors.push({ path: r.path, message: `Field «${f.label}» không lọc được.` });
    }
  };
  if (type === "kpi") {
    const c = config as BlockConfigByType["kpi"];
    const spec = catalog.metrics.find((m) => m.key === c.metric);
    if (spec && c.period && !spec.periods.includes(c.period)) errors.push({ path: `${base}.period`, message: `Chỉ số «${spec.label}» không hỗ trợ kỳ «${c.period}» (hỗ trợ: ${spec.periods.join(", ")}).` });
  } else if (type === "chart") {
    const c = config as BlockConfigByType["chart"];
    const spec = catalog.series.find((s) => s.key === c.series);
    if (spec && !spec.kinds.includes(c.kind)) errors.push({ path: `${base}.kind`, message: `Chuỗi «${spec.label}» không vẽ được dạng «${c.kind}» (hỗ trợ: ${spec.kinds.join(", ")}).` });
    if (spec && c.period && !spec.periods.includes(c.period)) errors.push({ path: `${base}.period`, message: `Chuỗi «${spec.label}» không hỗ trợ kỳ «${c.period}» (hỗ trợ: ${spec.periods.join(", ")}).` });
  } else if (type === "table") {
    const c = config as BlockConfigByType["table"];
    systemRefProblems(c.source, [
      ...(c.columns ?? []).map((ref, i) => ({ ref, path: `${base}.columns.${i}` })),
      ...(c.filters ?? []).map((f, i) => ({ ref: f.ref, path: `${base}.filters.${i}.ref`, needFilterable: true })),
      ...(c.sort ? [{ ref: c.sort.ref, path: `${base}.sort.ref` }] : []),
    ]);
    if (new Set(c.columns ?? []).size !== (c.columns ?? []).length) errors.push({ path: `${base}.columns`, message: "Cột bị trùng." });
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
  }
}

/**
 * Mọi `custom:<khoá>` của schema, theo đối tượng — registry đối chiếu với định nghĩa field của tổ chức.
 * `status` = ref là `statusField` của kanban (phải là field kiểu trạng thái).
 */
export function customRefsOf(schema: PageSchema): { objectKey: string; ref: string; path: string; role: "column" | "filter" | "status" }[] {
  const out: { objectKey: string; ref: string; path: string; role: "column" | "filter" | "status" }[] = [];
  schema.sections.forEach((s, si) =>
    s.blocks.forEach((b, bi) => {
      const base = `sections.${si}.blocks.${bi}.config`;
      if (b.type === "table") {
        const c = b.config as BlockConfigByType["table"];
        (c.columns ?? []).forEach((ref, i) => ref.startsWith("custom:") && out.push({ objectKey: c.source, ref, path: `${base}.columns.${i}`, role: "column" }));
        (c.filters ?? []).forEach((f, i) => f.ref.startsWith("custom:") && out.push({ objectKey: c.source, ref: f.ref, path: `${base}.filters.${i}.ref`, role: "filter" }));
        if (c.sort?.ref.startsWith("custom:")) out.push({ objectKey: c.source, ref: c.sort.ref, path: `${base}.sort.ref`, role: "column" });
      } else if (b.type === "kanban") {
        const c = b.config as BlockConfigByType["kanban"];
        if (c.statusField.startsWith("custom:")) out.push({ objectKey: c.objectKey, ref: c.statusField, path: `${base}.statusField`, role: "status" });
        c.cardFields.forEach((ref, i) => ref.startsWith("custom:") && out.push({ objectKey: c.objectKey, ref, path: `${base}.cardFields.${i}`, role: "column" }));
        (c.filters ?? []).forEach((f, i) => f.ref.startsWith("custom:") && out.push({ objectKey: c.objectKey, ref: f.ref, path: `${base}.filters.${i}.ref`, role: "filter" }));
      }
    }),
  );
  return out;
}

/**
 * Chuẩn hoá một schema ĐÃ ĐẠT `validatePageSchema`: cấu hình đi qua zod của loại khối (bỏ khoảng trắng thừa,
 * giữ đúng khoá khai), khoá lạ không bao giờ vào CSDL. Schema chưa đạt ⇒ `null`.
 */
export function normalizePageSchema(schema: unknown, opts: ValidateOptions): PageSchema | null {
  if (!validatePageSchema(schema, { ...opts, moduleIssues: "warning" }).ok) return null;
  const s = schema as PageSchema;
  return {
    version: 1,
    sections: s.sections.map((sec) => ({
      key: sec.key,
      ...(sec.title ? { title: sec.title } : {}),
      blocks: sec.blocks.map((b) => {
        const spec = COMPONENT_REGISTRY[b.type] as ComponentSpec<BlockType>;
        const config = spec.config.parse(b.config);
        return {
          id: b.id,
          type: b.type,
          span: b.span,
          ...(b.title ? { title: b.title } : {}),
          config,
          ...(b.visibility && (b.visibility.permission || b.visibility.module) ? { visibility: { ...(b.visibility.permission ? { permission: b.visibility.permission } : {}), ...(b.visibility.module ? { module: b.visibility.module } : {}) } } : {}),
        } as PageBlock;
      }),
    })),
  };
}

export const EMPTY_PAGE_SCHEMA: PageSchema = { version: 1, sections: [] };

/** Tổng số khối — trang không có khối nào thì không xuất bản (không có gì để người dùng mở). */
export function blockCountOf(schema: PageSchema): number {
  return schema.sections.reduce((n, s) => n + s.blocks.length, 0);
}
