import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { FieldRef, ListFilterOp } from "@/lib/metadata/types";
import { objectDef } from "@/lib/constants/object-registry";
import { AGGREGATE_NUMERIC_TYPES, BLOCK_ID_PATTERN, COMPONENT_REGISTRY, DATE_TYPES, filterOpFits, filterTargetObject, GROUPABLE_TYPES, PAGE_SLUG_PATTERN, ROW_ACTION_KEYS } from "@/lib/pages/components";
import { stripVietnamese, type CatalogField } from "@/lib/platform-ui/metadata-admin-shared";
import {
  BLOCK_SPANS,
  flattenBlocks,
  isAggregateChart,
  isAggregateKpi,
  PAGE_MAX_BLOCKS,
  PAGE_MAX_SECTIONS,
  type AggregateSpec,
  type BlockConfigByType,
  type BlockSpan,
  type BlockType,
  type ChartKind,
  type FormConfig,
  type ListSourceSpec,
  type MetricSourceSpec,
  type PageActionSpec,
  type PageBlock,
  type PageNav,
  type PageSchema,
  type PageStatus,
  type SeriesSourceSpec,
  type TextVariant,
  type TimeBucket,
  type TimelineSourceSpec,
} from "@/lib/pages/types";
import type { PeriodKey } from "@/lib/search-params";

/**
 * ═══════════ TRÌNH SOẠN TRANG TUỲ BIẾN — PHẦN THUẦN, DÙNG CHUNG MÁY CHỦ + TRÌNH DUYỆT (Phase 4) ═══════════
 *
 * `/settings/pages` và lõi `lib/platform-ui/page-admin.ts` cùng đọc tệp này. Không đọc CSDL, không import gì
 * chỉ-máy-chủ. Trình soạn là CẤU HÌNH (ô chọn + nút Lên/Xuống), không có canvas kéo-thả.
 *
 * Kiểm ở đây chỉ để UX (báo sớm trước khi bấm lưu). Kiểm THẬT là `validatePageSchema` ở máy chủ, chạy khi LƯU
 * NHÁP và khi XUẤT BẢN (hợp đồng G3) — lỗi của nó về tới màn hình NGUYÊN VĂN kèm `path`, giao diện không viết
 * lại câu.
 */

/** Một lỗi gắn một vị trí trong schema/thông tin trang (`sections.0.blocks.2.config.metric`, `slug`…). */
export type PagePathError = { path: string; message: string };

/**
 * `notes`: điều máy chủ muốn người soạn BIẾT dù lượt ghi đã thành công — cảnh báo của `validatePageSchema` khi lưu
 * nháp (module tắt chỉ là cảnh báo ở nháp, là lỗi chặn khi xuất bản — G7) và khối mẫu bị bỏ khi tạo từ mẫu.
 */
export type PageWriteResult = { ok: true; id: string; notes: PagePathError[] } | { ok: false; errors: PagePathError[] };

/** Đường dẫn trang chạy thật / tiền tố `/p` (G11). */
export function pageHref(slug: string): string {
  return `/p/${slug}`;
}

/** Hai mẫu khoá — CÙNG hằng số mà `validatePageSchema` dùng (lib/pages/components.ts), không khai lại. */
export { BLOCK_ID_PATTERN, PAGE_SLUG_PATTERN };

// ═══════════ NHÃN ═══════════

export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  kpi: "Chỉ số (KPI)",
  table: "Bảng dữ liệu",
  chart: "Biểu đồ",
  kanban: "Bảng Kanban",
  timeline: "Dòng thời gian",
  form: "Form nhập liệu",
  button: "Nút thao tác",
  text: "Đoạn chữ",
  filter: "Bộ lọc",
  column: "Cột",
};

export const BLOCK_TYPE_HINT: Record<BlockType, string> = {
  kpi: "Một con số từ sổ nguồn số liệu — cùng công thức với báo cáo, không tự tính.",
  table: "Danh sách bản ghi của một đối tượng: cột, lọc, sắp xếp, phân trang.",
  chart: "Một chuỗi số theo ngày/nhóm từ sổ nguồn chuỗi.",
  kanban: "Thẻ bản ghi xếp theo một field trạng thái TUỲ BIẾN; đổi cột đi qua luật chuyển của field.",
  timeline: "Nhật ký của một bản ghi (đơn, vận đơn, mẫu…) lấy theo tham số trên URL.",
  form: "Form Phase 2 đã xuất bản của một đối tượng.",
  button: "Một thao tác trong sổ action — máy chủ tra lại cấu hình đã xuất bản trước khi làm.",
  text: "Tiêu đề và đoạn giải thích tĩnh.",
  filter: "Thanh lọc cho người xem (≤ 4 ô, chọn kỳ) — áp lên bảng / kanban / KPI / biểu đồ tổng hợp cùng đối tượng.",
  column: "Xếp dọc tối đa 6 khối con trong một ô của lưới.",
};

export const SPAN_LABEL: Record<BlockSpan, string> = { 3: "1/4 hàng", 4: "1/3 hàng", 6: "1/2 hàng", 8: "2/3 hàng", 12: "Cả hàng" };

export const CHART_KIND_LABEL: Record<ChartKind, string> = { bar: "Cột", line: "Đường", pie: "Tròn" };

export const FORM_MODE_LABEL: Record<FormConfig["mode"], string> = { create: "Tạo mới", edit: "Sửa bản ghi", view: "Chỉ xem" };

export const PAGE_STATUS_LABEL: Record<PageStatus, string> = { ACTIVE: "Đang dùng", ARCHIVED: "Đã lưu trữ" };

/** Trạng thái đọc được của một trang: lưu trữ · chưa xuất bản lần nào · đang xuất bản. */
export type PageState = "ARCHIVED" | "DRAFT_ONLY" | "PUBLISHED";
export const PAGE_STATE_LABEL: Record<PageState, string> = { ARCHIVED: "Đã lưu trữ", DRAFT_ONLY: "Nháp — chưa xuất bản", PUBLISHED: "Đang xuất bản" };
export const PAGE_STATE_TONE: Record<PageState, string> = {
  ARCHIVED: "bg-muted text-muted-foreground",
  DRAFT_ONLY: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  PUBLISHED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
};

export function pageState(p: { status: PageStatus; publishedVersion: number }): PageState {
  if (p.status === "ARCHIVED") return "ARCHIVED";
  return p.publishedVersion > 0 ? "PUBLISHED" : "DRAFT_ONLY";
}

// ═══════════ SỔ CHO TRÌNH SOẠN (máy chủ lọc theo module đang bật, truyền qua props) ═══════════

/** Một đối tượng nhìn từ trình soạn: danh mục field (bảng, lọc, kanban) + form Phase 2 của nó. */
export type PageObjectOption = {
  key: string;
  label: string;
  catalog: CatalogField[];
  forms: { key: string; label: string; purpose: "create" | "edit" }[];
};

export type PageEditorCatalog = {
  metrics: MetricSourceSpec[];
  series: SeriesSourceSpec[];
  lists: ListSourceSpec[];
  timelines: TimelineSourceSpec[];
  actions: PageActionSpec[];
  objects: PageObjectOption[];
  periods: { value: PeriodKey; label: string }[];
};

export type PageMetaOptions = {
  /** Module ĐANG BẬT của tổ chức — trang chỉ gắn được vào module đang bật. */
  modules: { key: ModuleKey; label: string }[];
  permissions: { key: string; label: string }[];
  /** Nhóm menu; khoá rỗng ⇒ `null` = nhóm «Trang tuỳ biến». */
  zones: { key: string; label: string }[];
};

/** Thông tin trang (không gồm nội dung) — đầu vào tạo / sửa. */
export type PageMetaInput = {
  name: string;
  slug: string;
  moduleKey: ModuleKey;
  requiredPermission: string | null;
  nav: PageNav;
};

export function blankPageMeta(): PageMetaInput {
  return { name: "", slug: "", moduleKey: "core", requiredPermission: null, nav: { enabled: false, label: "", zone: null, order: 100 } };
}

/** Chuẩn hoá trước khi gửi: cắt khoảng trắng, nhãn menu rỗng ⇒ tên trang, quyền rỗng ⇒ `null`. */
export function normalizePageMeta(input: PageMetaInput): PageMetaInput {
  const name = input.name.trim();
  const permission = input.requiredPermission?.trim() ? input.requiredPermission.trim() : null;
  // Máy chủ nhận số nguyên 0–999 (lib/pages/registry.ts) — kẹp ở đây để ô số không thành một lượt lưu bị từ chối.
  const order = Number.isFinite(input.nav.order) ? Math.min(999, Math.max(0, Math.trunc(input.nav.order))) : 100;
  return {
    name,
    slug: input.slug.trim(),
    moduleKey: input.moduleKey,
    requiredPermission: permission,
    nav: { enabled: input.nav.enabled, label: input.nav.label.trim() || name, zone: input.nav.zone?.trim() ? input.nav.zone.trim() : null, order },
  };
}

/** Kiểm sớm thông tin trang — máy chủ kiểm lại (trùng slug, module tắt, quyền lạ). */
export function checkPageMeta(input: PageMetaInput, opts: { takenSlugs: ReadonlySet<string>; slugLocked: boolean; modules: ReadonlySet<string> }): PagePathError[] {
  const errors: PagePathError[] = [];
  if (!input.name.trim()) errors.push({ path: "name", message: "Tên trang không được để trống." });
  if (!opts.slugLocked) {
    const slug = input.slug.trim();
    if (!PAGE_SLUG_PATTERN.test(slug)) errors.push({ path: "slug", message: "Đường dẫn chỉ gồm chữ thường không dấu, số và «-», bắt đầu bằng chữ, 2–61 ký tự." });
    else if (opts.takenSlugs.has(slug)) errors.push({ path: "slug", message: `Đường dẫn «/p/${slug}» đã có trang khác dùng.` });
  }
  if (!opts.modules.has(input.moduleKey)) errors.push({ path: "moduleKey", message: "Module chủ phải là một module đang bật của tổ chức." });
  return errors;
}

/** Gợi ý đường dẫn từ tên: bỏ dấu, chữ thường, ký tự lạ ⇒ `-`, không trùng (thêm `-2`, `-3`…). Chỉ là GỢI Ý. */
export function suggestSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  let base = stripVietnamese(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.length < 2) base = "trang-moi";
  else if (!/^[a-z]/.test(base)) base = `trang-${base}`;
  base = base.slice(0, 61).replace(/-+$/, "");
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const tail = `-${i}`;
    const candidate = `${base.slice(0, 61 - tail.length).replace(/-+$/, "")}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// ═══════════ SCHEMA: THÊM / BỚT / DI CHUYỂN ═══════════

export function blankSchema(): PageSchema {
  return { version: 1, sections: [{ key: "section_1", title: "Tổng quan", blocks: [] }] };
}

/** Tổng số khối — đếm CẢ khối con trong cột (trần 20 là trần câu truy vấn), cùng phép duyệt với máy chủ. */
export function blockCount(schema: PageSchema): number {
  return flattenBlocks(schema).length;
}

export function newSectionKey(schema: PageSchema): string {
  const used = new Set(schema.sections.map((s) => s.key));
  for (let i = schema.sections.length + 1; ; i++) if (!used.has(`section_${i}`)) return `section_${i}`;
}

/** Khoá khối mới không trùng khối nào trong trang (`kpi_1`, `table_2`…). */
export function suggestBlockId(schema: PageSchema, type: BlockType): string {
  const used = new Set(schema.sections.flatMap((s) => s.blocks.map((b) => b.id)));
  for (let i = 1; ; i++) if (!used.has(`${type}_${i}`)) return `${type}_${i}`;
}


/** Cột mặc định của bảng: tối đa 5 field `listable` đầu tiên của đối tượng. */
export function defaultColumns(object: PageObjectOption | undefined): FieldRef[] {
  return (object?.catalog ?? []).filter((c) => c.listable).slice(0, 5).map((c) => c.ref);
}

/** Field custom kiểu `status` — thứ DUY NHẤT Kanban xếp cột theo (G6). */
export function statusFieldsOf(object: PageObjectOption | undefined): CatalogField[] {
  return (object?.catalog ?? []).filter((c) => !c.system && c.type === "status");
}

/** Đối tượng làm được bảng / kanban: phải có nguồn danh sách trong sổ (máy chủ tra `lists` theo `objectKey`). */
export function listObjects(catalog: PageEditorCatalog): PageObjectOption[] {
  const keys = new Set(catalog.lists.map((l) => l.objectKey));
  return catalog.objects.filter((o) => keys.has(o.key));
}

export function kanbanObjects(catalog: PageEditorCatalog): PageObjectOption[] {
  return listObjects(catalog).filter((o) => statusFieldsOf(o).length > 0);
}

/**
 * Field của một đối tượng theo VAI TRÒ trong phép tổng hợp — CÙNG luật với `validatePageSchema` (lib/pages/components):
 * số tổng hợp được (hệ thống phải khai `aggregatable` — tiền của đơn / vận đơn / hàng hoàn không bao giờ; số tuỳ biến
 * mặc định được) · nhóm được (chọn / trạng thái / có-không / người dùng, hoặc trạng thái hệ thống) · ngày.
 * Chỉ để UX (ô chọn không mời chọn thứ máy chủ sẽ từ chối); máy chủ vẫn kiểm lại.
 */
export function aggregatableFields(object: PageObjectOption | undefined): CatalogField[] {
  const def = object ? objectDef(object.key) : null;
  return (object?.catalog ?? []).filter((c) => {
    if (!AGGREGATE_NUMERIC_TYPES.has(c.type)) return false;
    if (!c.system) return true;
    return def?.fields.find((f) => `system:${f.key}` === c.ref)?.aggregatable === true;
  });
}

export function groupableFields(object: PageObjectOption | undefined): CatalogField[] {
  const def = object ? objectDef(object.key) : null;
  return (object?.catalog ?? []).filter((c) => GROUPABLE_TYPES.has(c.type) || (c.system && (def?.statusFields ?? []).some((k) => `system:${k}` === c.ref)));
}

export function dateFields(object: PageObjectOption | undefined): CatalogField[] {
  return (object?.catalog ?? []).filter((c) => DATE_TYPES.has(c.type));
}

/** Phép lọc hợp kiểu cho ô của thanh lọc — đúng `filterOpFits` của máy chủ. */
export function filterBarOps(field: CatalogField | undefined): ListFilterOp[] {
  if (!field) return [];
  return (["eq", "neq", "contains", "gte", "lte", "in", "empty", "not_empty"] as const).filter((op) => filterOpFits(field.type, op));
}

/** Action dùng được làm hành động THEO DÒNG của một bảng: nhận một bản ghi, và (nếu khai) đúng đối tượng của bảng. */
export function rowActionOptions(catalog: PageEditorCatalog, source: string): PageActionSpec[] {
  return catalog.actions.filter((a) => ROW_ACTION_KEYS.includes(a.key) && (!a.objectKey || a.objectKey === source));
}

/** Một khối có thể làm ĐÍCH của bộ lọc (bảng · kanban · KPI / biểu đồ tổng hợp) và đối tượng nó đọc. */
export type FilterTargetOption = { id: string; label: string; objectKey: string };

export function filterTargetsOf(schema: PageSchema): FilterTargetOption[] {
  const out: FilterTargetOption[] = [];
  for (const { block } of flattenBlocks(schema)) {
    const objectKey = filterTargetObject(block.type, block.config);
    if (objectKey) out.push({ id: block.id, label: block.title || BLOCK_TYPE_LABEL[block.type], objectKey });
  }
  return out;
}

export function formObjects(catalog: PageEditorCatalog): PageObjectOption[] {
  return catalog.objects.filter((o) => o.forms.length > 0);
}

export function objectOf(catalog: PageEditorCatalog, key: string): PageObjectOption | undefined {
  return catalog.objects.find((o) => o.key === key);
}

/** Cấu hình khởi đầu của một loại khối: chọn sẵn nguồn ĐẦU TIÊN có trong sổ (rỗng nếu sổ trống — máy chủ sẽ báo). */
export function defaultConfig<T extends BlockType>(type: T, catalog: PageEditorCatalog): BlockConfigByType[T] {
  const make = (): BlockConfigByType[BlockType] => {
    switch (type) {
      case "kpi":
        return { metric: catalog.metrics[0]?.key ?? "" };
      case "table": {
        const source = catalog.lists[0]?.objectKey ?? "";
        return { source, columns: defaultColumns(objectOf(catalog, source)), filters: [], sort: null, pageSize: 20, rowLink: true };
      }
      case "chart": {
        const s = catalog.series[0];
        return { series: s?.key ?? "", kind: s?.kinds[0] ?? "bar" };
      }
      case "kanban": {
        const o = kanbanObjects(catalog)[0];
        const status = statusFieldsOf(o)[0];
        return { objectKey: o?.key ?? "", statusField: status?.ref ?? "custom:", cardFields: [], allowMove: false, limit: 100 };
      }
      case "timeline": {
        const t = catalog.timelines[0];
        return { source: t?.key ?? "", ...(t?.recordObject ? { recordParam: "id" } : {}), limit: 20 };
      }
      case "form": {
        const o = formObjects(catalog)[0];
        const f = o?.forms[0];
        const mode: FormConfig["mode"] = f?.purpose === "edit" ? "edit" : "create";
        return { objectKey: o?.key ?? "", formKey: f?.key ?? "", mode, ...(mode === "create" ? {} : { recordParam: "id" }) };
      }
      case "button": {
        const a = catalog.actions[0];
        return { action: a?.key ?? "", label: a?.label ?? "Thực hiện" };
      }
      case "filter":
        return { period: true, fields: [], targets: [] };
      case "column":
        return {};
      default:
        return {};
    }
  };
  return make() as BlockConfigByType[T];
}

export function newBlock(type: BlockType, schema: PageSchema, catalog: PageEditorCatalog): PageBlock {
  return {
    id: suggestBlockId(schema, type),
    type,
    span: COMPONENT_REGISTRY[type].defaultSpan,
    title: type === "kpi" || type === "text" || type === "filter" || type === "column" ? undefined : BLOCK_TYPE_LABEL[type],
    config: defaultConfig(type, catalog),
    ...(type === "column" ? { children: [] } : {}),
  };
}

/**
 * Khoá sổ chỉ số / chuỗi của KPI / biểu đồ — schema 1.1 thêm nhánh TỔNG HỢP (không có khoá sổ) ⇒ chuỗi rỗng.
 * (Chỉ để trình soạn Phase 4 biên dịch được với kiểu hợp; trình kéo-thả dùng `isAggregateKpi/Chart`.)
 */
export function metricKeyOf(c: BlockConfigByType["kpi"] | null | undefined): string {
  return c && "metric" in c && typeof c.metric === "string" ? c.metric : "";
}
export function seriesKeyOf(c: BlockConfigByType["chart"] | null | undefined): string {
  return c && "series" in c && typeof c.series === "string" ? c.series : "";
}

/** Cấu hình của một khối theo ĐÚNG loại của nó — `null` nếu gọi nhầm loại. */
export function configOf<T extends BlockType>(block: PageBlock, type: T): BlockConfigByType[T] | null {
  return block.type === type ? (block.config as BlockConfigByType[T]) : null;
}

/** Chuyển một khối sang section khác (nối cuối). Chỉ số lạ ⇒ trả nguyên schema (bản sao). */
export function moveBlockToSection(schema: PageSchema, si: number, bi: number, target: number): PageSchema {
  const block = schema.sections[si]?.blocks[bi];
  if (!block || target === si || !schema.sections[target]) return { ...schema, sections: [...schema.sections] };
  return {
    ...schema,
    sections: schema.sections.map((s, i) => (i === si ? { ...s, blocks: s.blocks.filter((_, j) => j !== bi) } : i === target ? { ...s, blocks: [...s.blocks, block] } : s)),
  };
}

export function isBlockSpan(n: number): n is BlockSpan {
  return (BLOCK_SPANS as readonly number[]).includes(n);
}

// ═══════════ KIỂM SỚM (UX) ═══════════

/**
 * Kiểm sớm trước khi gửi — CHỈ những điều chắc chắn sai (trần, khoá khối, chưa chọn nguồn). Lời cuối là
 * `validatePageSchema` ở máy chủ: nó biết thêm module đang bật, field còn tồn tại, loại biểu đồ nguồn hỗ trợ.
 */
export function checkPageDraft(schema: PageSchema): PagePathError[] {
  const errors: PagePathError[] = [];
  if (schema.sections.length === 0) errors.push({ path: "sections", message: "Trang cần ít nhất một nhóm." });
  if (schema.sections.length > PAGE_MAX_SECTIONS) errors.push({ path: "sections", message: `Tối đa ${PAGE_MAX_SECTIONS} nhóm mỗi trang.` });
  if (blockCount(schema) > PAGE_MAX_BLOCKS) errors.push({ path: "sections", message: `Tối đa ${PAGE_MAX_BLOCKS} khối mỗi trang — một trang không được thành hàng chục câu truy vấn.` });
  const seen = new Set<string>();
  // Khối con của cột kiểm như khối thường — cùng phép duyệt phẳng với `validatePageSchema` (`flattenBlocks`).
  for (const { block: b, path: at } of flattenBlocks(schema)) {
    if (!BLOCK_ID_PATTERN.test(b.id)) errors.push({ path: `${at}.id`, message: "Khoá khối chỉ gồm chữ thường không dấu, số và «_», bắt đầu bằng chữ, 2–41 ký tự." });
    else if (seen.has(b.id)) errors.push({ path: `${at}.id`, message: `Khoá khối «${b.id}» bị trùng trong trang.` });
    seen.add(b.id);
    const missing = missingSource(b);
    if (missing) errors.push({ path: `${at}.${missing.field}`, message: missing.message });
  }
  return errors;
}

/** Chỗ còn thiếu của phép tổng hợp (KPI / biểu đồ theo field) — `field` tính từ `config.aggregate`. */
function missingAggregate(a: AggregateSpec, base: string): { field: string; message: string } | null {
  if (!a.objectKey) return { field: `${base}.objectKey`, message: "Chọn đối tượng để tổng hợp." };
  if (a.fn !== "count" && !a.field) return { field: `${base}.field`, message: "Chọn field số để cộng / trung bình / nhỏ nhất / lớn nhất." };
  return null;
}

/** Ô bắt buộc còn trống của một khối; `field` là đường dẫn TỪ KHỐI (`config.metric`, `config.aggregate.field`…). */
function missingSource(b: PageBlock): { field: string; message: string } | null {
  const inner = missingConfig(b);
  return inner ? { field: `config.${inner.field}`, message: inner.message } : null;
}

function missingConfig(b: PageBlock): { field: string; message: string } | null {
  switch (b.type) {
    case "kpi": {
      const c = configOf(b, "kpi");
      if (isAggregateKpi(c)) return missingAggregate(c.aggregate, "aggregate");
      return metricKeyOf(c) ? null : { field: "metric", message: "Chọn nguồn số liệu." };
    }
    case "table": {
      const c = configOf(b, "table");
      if (!c?.source) return { field: "source", message: "Chọn đối tượng của bảng." };
      return c.columns && c.columns.length > 0 ? null : { field: "columns", message: "Bảng cần ít nhất một cột." };
    }
    case "chart": {
      const c = configOf(b, "chart");
      if (isAggregateChart(c)) {
        const miss = missingAggregate(c.aggregate, "aggregate");
        if (miss) return miss;
        if ("ref" in c.groupBy) return c.groupBy.ref ? null : { field: "groupBy.ref", message: "Chọn field để nhóm." };
        return c.groupBy.dateField ? null : { field: "groupBy.dateField", message: "Chọn field ngày cho trục thời gian." };
      }
      return seriesKeyOf(c) ? null : { field: "series", message: "Chọn chuỗi số liệu." };
    }
    case "kanban": {
      const c = configOf(b, "kanban");
      if (!c?.objectKey) return { field: "objectKey", message: "Chọn đối tượng của Kanban." };
      return c.statusField && c.statusField !== "custom:" ? null : { field: "statusField", message: "Chọn field trạng thái tuỳ biến để xếp cột." };
    }
    case "timeline":
      return configOf(b, "timeline")?.source ? null : { field: "source", message: "Chọn nguồn nhật ký." };
    case "form": {
      const c = configOf(b, "form");
      if (!c?.objectKey) return { field: "objectKey", message: "Chọn đối tượng của form." };
      return c.formKey ? null : { field: "formKey", message: "Chọn form." };
    }
    case "button": {
      const c = configOf(b, "button");
      if (!c?.action) return { field: "action", message: "Chọn thao tác trong sổ." };
      return c.label.trim() ? null : { field: "label", message: "Nhãn nút không được để trống." };
    }
    case "filter": {
      const c = configOf(b, "filter");
      if (!c) return null;
      const bad = c.fields.findIndex((f) => !f.objectKey || !f.ref);
      if (bad >= 0) return { field: `fields.${bad}.ref`, message: "Chọn đối tượng và field cho ô lọc." };
      return c.period === true || c.fields.length > 0 ? null : { field: "fields", message: "Bộ lọc cần ít nhất một ô lọc hoặc bộ chọn kỳ." };
    }
    case "column":
      return null;
    case "text": {
      const c = configOf(b, "text");
      return c?.heading?.trim() || c?.body?.trim() ? null : { field: "body", message: "Đoạn chữ trống — nhập tiêu đề hoặc nội dung." };
    }
    default:
      return null;
  }
}

/** Tóm tắt một phép tổng hợp: «Đếm Đơn hàng», «Tổng Số đơn · Khách hàng». */
export function aggregateSummary(a: AggregateSpec, catalog: PageEditorCatalog): string {
  const o = objectOf(catalog, a.objectKey);
  const field = a.field ? (o?.catalog.find((f) => f.ref === a.field)?.label ?? a.field) : null;
  return `${AGGREGATE_FN_LABEL[a.fn]}${field ? ` ${field}` : ""} · ${o?.label ?? (a.objectKey || "chưa chọn đối tượng")}`;
}

export const AGGREGATE_FN_LABEL: Record<AggregateSpec["fn"], string> = { count: "Đếm", sum: "Tổng", avg: "Trung bình", min: "Nhỏ nhất", max: "Lớn nhất" };
export const TIME_BUCKET_LABEL: Record<TimeBucket, string> = { day: "Theo ngày", week: "Theo tuần", month: "Theo tháng" };
export const TEXT_VARIANT_LABEL: Record<TextVariant, string> = { heading: "Tiêu đề", paragraph: "Đoạn văn", note: "Ghi chú" };

// ═══════════ LỖI THEO VỊ TRÍ ═══════════

/** `sections[0].blocks[2]` và `sections.0.blocks.2` là cùng một vị trí — so theo dạng chấm. */
export function normalizePath(path: string): string {
  return path.replace(/\[(\d+)\]/g, ".$1").replace(/^\.+/, "");
}

function under(path: string, prefix: string): boolean {
  const p = normalizePath(path);
  return p === prefix || p.startsWith(`${prefix}.`);
}

/**
 * Chia lỗi theo nơi hiện: dưới từng khối, dưới từng nhóm, còn lại ở đầu trình soạn. Mỗi lỗi hiện ĐÚNG MỘT chỗ,
 * kèm `path` nguyên văn — câu của máy chủ không bị viết lại, cũng không bị nuốt vì không khớp ô nào.
 */
export function splitPageErrors(errors: readonly PagePathError[], schema: PageSchema): { general: PagePathError[]; section: PagePathError[][]; block: PagePathError[][][] } {
  const section = schema.sections.map(() => [] as PagePathError[]);
  const block = schema.sections.map((s) => s.blocks.map(() => [] as PagePathError[]));
  const general: PagePathError[] = [];
  for (const e of errors) {
    let placed = false;
    for (let si = 0; si < schema.sections.length && !placed; si++) {
      for (let bi = 0; bi < schema.sections[si].blocks.length && !placed; bi++) {
        if (under(e.path, `sections.${si}.blocks.${bi}`)) {
          block[si][bi].push(e);
          placed = true;
        }
      }
      if (!placed && under(e.path, `sections.${si}`)) {
        section[si].push(e);
        placed = true;
      }
    }
    if (!placed) general.push(e);
  }
  return { general, section, block };
}

/** Lỗi của một ô thông tin trang (`slug`, `nav.label`…). */
export function metaErrorsFor(errors: readonly PagePathError[], name: string): PagePathError[] {
  return errors.filter((e) => under(e.path, name));
}

/** Tóm tắt một khối cho dòng thu gọn: nguồn đang chọn, đọc bằng nhãn của sổ. */
export function blockSummary(block: PageBlock, catalog: PageEditorCatalog): string {
  const labelOf = <T extends { label: string }>(list: readonly T[], match: (x: T) => boolean, raw: string) => list.find(match)?.label ?? (raw ? `«${raw}» (không có trong sổ)` : "chưa chọn");
  switch (block.type) {
    case "kpi": {
      const c = configOf(block, "kpi");
      if (isAggregateKpi(c)) return aggregateSummary(c.aggregate, catalog);
      const metric = metricKeyOf(c);
      return labelOf(catalog.metrics, (m) => m.key === metric, metric);
    }
    case "table": {
      const c = configOf(block, "table");
      return `${labelOf(catalog.lists, (l) => l.objectKey === c?.source, c?.source ?? "")} · ${c?.columns?.length ?? 0} cột`;
    }
    case "chart": {
      const c = configOf(block, "chart");
      if (isAggregateChart(c)) return `${aggregateSummary(c.aggregate, catalog)} · ${CHART_KIND_LABEL[c.kind]}`;
      const series = seriesKeyOf(c);
      return `${labelOf(catalog.series, (s) => s.key === series, series)} · ${c ? CHART_KIND_LABEL[c.kind] : ""}`;
    }
    case "kanban": {
      const c = configOf(block, "kanban");
      return labelOf(catalog.objects, (o) => o.key === c?.objectKey, c?.objectKey ?? "");
    }
    case "timeline": {
      const c = configOf(block, "timeline");
      return labelOf(catalog.timelines, (t) => t.key === c?.source, c?.source ?? "");
    }
    case "form": {
      const c = configOf(block, "form");
      const o = objectOf(catalog, c?.objectKey ?? "");
      return `${o?.label ?? "chưa chọn"} · ${o?.forms.find((f) => f.key === c?.formKey)?.label ?? c?.formKey ?? ""}`;
    }
    case "button": {
      const c = configOf(block, "button");
      return `${c?.label ?? ""} → ${labelOf(catalog.actions, (a) => a.key === c?.action, c?.action ?? "")}`;
    }
    case "filter": {
      const c = configOf(block, "filter");
      return `${c?.fields.length ?? 0} ô lọc${c?.period ? " + kỳ" : ""} → ${c?.targets.length ? c.targets.join(", ") : "chưa nhắm khối nào"}`;
    }
    case "column":
      return `${block.children?.length ?? 0} khối xếp dọc`;
    default: {
      const c = configOf(block, "text");
      return c?.heading?.trim() || (c?.body ?? "").slice(0, 60) || "trống";
    }
  }
}
