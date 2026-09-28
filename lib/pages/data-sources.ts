/**
 * ═══════════ TRÌNH PHÂN GIẢI KHỐI CỦA TRANG ĐỘNG (Phase 4 · G4, G6, G8, G9, G10) — CHỈ MÁY CHỦ ═══════════
 *
 * `resolveBlock(block, user, ctx)` biến MỘT khối đã xuất bản thành đúng `BlockDataByType[type]`. Mỗi lượt, theo
 * thứ tự, TRƯỚC khi chạm một truy vấn dữ liệu nào:
 *  1. khoá nguồn phải có trong sổ ĐÓNG (`lib/pages/catalog.ts`) — không có ⇒ `INVALID_CONFIG`;
 *  2. module của nguồn bật cho tổ chức hiện hành — tắt ⇒ `MODULE_DISABLED`;
 *  3. người xem có ĐÚNG khoá quyền cổng vào của trang cũ — thiếu ⇒ `FORBIDDEN`;
 *  4. phạm vi dữ liệu (`decideScope`, như `requireResource` của trang cũ) — `NONE` ⇒ `FORBIDDEN`; `ROWS` ghép vào
 *     `where` (`andScope`) hoặc hỏi lại từng dòng (`rowInScope`); số TỔNG không thu hẹp được theo dòng ⇒ từ chối.
 * Cấu hình trang KHÔNG BAO GIỜ là ranh giới an ninh: nó chỉ chọn nguồn; người xem quyết định được thấy gì.
 *
 * Cô lập tổ chức: mọi truy vấn đi qua `getDb()` = CSDL của tổ chức hiện hành. Cấu hình trỏ id / khoá của tổ chức
 * khác thì không có dòng nào khớp — không có "lọc theo tổ chức" nào để quên.
 *
 * Lỗi bất ngờ ⇒ `DATA_ERROR` với câu chung (không stack, không SQL); chi tiết chỉ in ra log máy chủ.
 *
 * ─── PHASE 5 (schema 1.1) ───
 *  · KPI / biểu đồ TỔNG HỢP (`aggregate`): cùng bốn cổng như bảng — sổ danh sách → module → quyền → phạm vi
 *    (`andScope`, nên người phạm vi hẹp thấy số của ĐÚNG những dòng họ được xem). Chỉ field số khai `aggregatable`
 *    (field tiền của đơn / vận đơn / hàng hoàn không khai — doanh thu chỉ qua sổ chỉ số / ORDER_OUTCOME).
 *  · Khối `filter`: đọc `pf_<id>_<i>` từ URL, parse THEO KIỂU field (giá trị hỏng bị bỏ, không thành lỗi), bỏ ô
 *    trên field không `filterable` / không được xem; áp lên khối đích CÙNG đối tượng qua `ctx.blockFilters`.
 *  · Khối `column`: khối con phân giải SONG SONG, mỗi con một kết quả riêng — con hỏng không kéo con khác.
 */
import { and, eq, getTableName, type SQL } from "drizzle-orm";
import type { Permission } from "@/lib/auth/permissions";
import { andScope, rowInScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { memo, periodKey } from "@/lib/cache";
import { statusTargets } from "@/components/metadata/runtime-core";
import { SCOPE_RESOURCE_BY_KEY } from "@/lib/constants/data-scope-policy";
import { objectDef, type ObjectDef } from "@/lib/constants/object-registry";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { getDb, schema } from "@/db";
import { recordExists } from "@/lib/metadata/common";
import { customValueText } from "@/lib/metadata/display";
import { listFields } from "@/lib/metadata/fields";
import { parseRef } from "@/lib/metadata/form-schema";
import { getPublishedForm } from "@/lib/metadata/forms";
import { filterShapeOk, LIST_MAX_FILTERS } from "@/lib/metadata/list-schema";
import { OBJECT_RECORD_PERMISSIONS } from "@/lib/metadata/permissions";
import type { CustomFieldDef, CustomValues, FieldRef, ListFilter, SystemFieldDef } from "@/lib/metadata/types";
import { canEditField, canViewField, customValuesFilterSql, getCustomValues } from "@/lib/metadata/values";
import { actionAvailability } from "@/lib/pages/actions";
import { CUSTOM_RECORD_TIMELINE_PREFIX, LIST_SOURCES, listSource, METRIC_SOURCES, metricSource, PAGE_ACTIONS, pageAction, SERIES_SOURCES, seriesSource, TIMELINE_SOURCES, timelineSource } from "@/lib/pages/catalog";
import { gateSource, OBJECT_SCOPE_RESOURCE, pageDetailHref } from "@/lib/pages/runtime-common";
import { AGGREGATE_NUMERIC_TYPES, DATE_TYPES, filterOpFits, filterTargetObject, GROUPABLE_TYPES, ROW_ACTION_KEYS } from "@/lib/pages/components";
import {
  AGGREGATE_FNS,
  AGGREGATE_MAX_GROUPS,
  COLUMN_MAX_CHILDREN,
  FILTER_MAX_FIELDS,
  flattenBlocks,
  isAggregateChart,
  isAggregateKpi,
  PAGE_MAX_BLOCKS,
  TABLE_MAX_ROW_ACTIONS,
  type AggregateChartConfig,
  type AggregateKpiConfig,
  type AggregateSpec,
  type BlockDataByType,
  type BlockIssue,
  type BlockType,
  type ButtonConfig,
  type ChartConfig,
  type FilterConfig,
  type FilterData,
  type FilterFieldData,
  type FormConfig,
  type KanbanCard,
  type KanbanConfig,
  type KpiConfig,
  type ListSourceSpec,
  type MetricSourceSpec,
  type PageActionSpec,
  type PageBlock,
  type PageRenderContext,
  type PageSchema,
  type ResolvedBlock,
  type SeriesSourceSpec,
  type TableColumn,
  type TableConfig,
  type TableRowActionData,
  type TextConfig,
  type TimelineConfig,
  type TimelineSourceSpec,
  type ValueFormat,
} from "@/lib/pages/types";
import { record as recordPerf } from "@/lib/perf/registry";
import { orderKpis } from "@/lib/queries/dashboard";
import { pageAggregateBuckets, pageAggregateGroups, pageAggregateTotal, type AggregateFieldRef, type AggregatePeriod } from "@/lib/queries/page-aggregate";
import { getOrderTimeline } from "@/lib/queries/entity-timeline";
import { getSystemStatusOptions } from "@/lib/queries/metadata-lists";
import { resolveMetric } from "@/lib/queries/metric-resolver";
import { getModelTimeline } from "@/lib/queries/models";
import { pageAvailableStock, pageDefaultSort, pageObjectRows, pageObjectTable, pageOrderSeriesByDay, pageOrderStageCounts, pageSystemFilterSql } from "@/lib/queries/page-data";
import { getRecordTimeline } from "@/lib/queries/record-timeline";
import { getShipmentTimeline } from "@/lib/queries/shipment-timeline";
import { userLabelsByIds, userPickOptions } from "@/lib/queries/users";
import { addDays, vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { resolvePeriod, type Period, type PeriodKey } from "@/lib/search-params";

// ─────────────────────────── Khung chung ───────────────────────────

export type BlockResult<T extends BlockType = BlockType> = { ok: true; data: BlockDataByType[T] } | { ok: false; issue: BlockIssue };

/**
 * Đếm số lần trình phân giải THỰC SỰ gọi xuống một nguồn dữ liệu (sau mọi cổng). Bài kiểm dùng để chứng minh
 * "module tắt / thiếu quyền ⇒ 0 truy vấn" — không phải để đo hiệu năng.
 */
export const pageDataProbe = { sourceCalls: 0 };

class BlockStop extends Error {
  constructor(
    readonly code: BlockIssue["code"],
    message: string,
  ) {
    super(message);
    this.name = "BlockStop";
  }
}

const stop = (code: BlockIssue["code"], message: string): never => {
  throw new BlockStop(code, message);
};

async function gateOrStop(user: SessionUser, spec: { module: MetricSourceSpec["module"] | null; permission: string | null; label: string }, resource: string | null): Promise<ScopeDecision> {
  const g = await gateSource(user, spec, resource);
  if (!g.ok) stop(g.code, g.message);
  return (g as { ok: true; decision: ScopeDecision }).decision;
}

/** Số TỔNG không thu hẹp theo dòng được: phạm vi `ROWS` ⇒ từ chối thay vì in con số của cả tổ chức. */
function requireWholeScope(decision: ScopeDecision, label: string) {
  if (decision.allow !== "ALL") stop("FORBIDDEN", `${label} là số tổng của cả tổ chức — phạm vi dữ liệu của bạn không cho xem số tổng.`);
}

function periodFor(spec: { periods: PeriodKey[] }, configured: PeriodKey | undefined, ctx: PageRenderContext): Period {
  if (configured && !spec.periods.includes(configured)) stop("INVALID_CONFIG", `Nguồn này không hỗ trợ kỳ "${configured}".`);
  const wanted = configured ?? ctx.period;
  const key = spec.periods.includes(wanted) ? wanted : spec.periods.includes("30d") ? "30d" : spec.periods[0];
  return resolvePeriod({ ...ctx.searchParams, period: key }, key);
}

function probe() {
  pageDataProbe.sourceCalls += 1;
}

// ─────────────────────────── KPI ───────────────────────────

type MetricReading = { value: number | null; note?: string };

/** Loại dữ liệu của sổ phạm vi mà TRANG CŨ của từng số dùng trong `requireResource`. */
const METRIC_SCOPE: Record<string, string> = {
  orders_today: "ORDERS",
  booked_revenue: "ORDERS",
  delivered_orders: "ORDERS",
  delivered_revenue: "REPORTS",
  returns_in_period: "RETURNS",
  return_rate: "REPORTS",
  delivery_success_rate: "REPORTS",
  available_stock: "INVENTORY",
  return_inspection_backlog: "RETURNS",
  cod_outstanding: "FINANCE",
  unclassified_bank_txns: "FINANCE",
  ads_spend: "ADS",
};

const METRIC_HREF: Record<string, string> = {
  orders_today: "/orders",
  booked_revenue: "/orders",
  delivered_orders: "/orders",
  delivered_revenue: "/reports",
  returns_in_period: "/reports/returns",
  return_rate: "/reports/returns",
  delivery_success_rate: "/reports/returns",
  available_stock: "/inventory",
  return_inspection_backlog: "/inventory/returns",
  cod_outstanding: "/cod",
  unclassified_bank_txns: "/bank",
  ads_spend: "/ads",
};

/** Đọc một khoá của METRIC_BINDINGS qua `resolveMetric`. Hàm đọc hỏng ⇒ ném (khối thành `DATA_ERROR`), không in `null` như thể chưa có dữ liệu. */
async function viaBinding(key: string, period: Period): Promise<MetricReading> {
  const v = await resolveMetric(key, { period });
  if (v.state === "UNKNOWN" && typeof v.note === "string" && /^(Chưa đọc được|Chỉ số đã khai nhưng chưa có hàm đọc|Chỉ số không có trong sổ)/.test(v.note)) {
    throw new Error(`resolveMetric(${key}) không đọc được`);
  }
  const note = v.state === "DATA_INSUFFICIENT" ? `Mẫu ${v.sample ?? 0} — chưa đủ để kết luận` : v.note || undefined;
  return { value: v.value, ...(note ? { note } : {}) };
}

const METRIC_RUNNERS: Record<string, (period: Period) => Promise<MetricReading>> = {
  orders_today: async (period) => ({ value: (await orderKpis(period.from, period.to)).orders }),
  booked_revenue: async (period) => ({ value: (await orderKpis(period.from, period.to)).revenue }),
  returns_in_period: async (period) => ({ value: (await orderKpis(period.from, period.to)).returnedOrders }),
  delivered_orders: (period) => viaBinding("delivered_orders", period),
  delivered_revenue: (period) => viaBinding("delivered_revenue", period),
  return_rate: (period) => viaBinding("return_rate", period),
  delivery_success_rate: (period) => viaBinding("delivery_success_rate", period),
  return_inspection_backlog: (period) => viaBinding("return_inspection_backlog", period),
  cod_outstanding: (period) => viaBinding("cod_outstanding", period),
  unclassified_bank_txns: (period) => viaBinding("unclassified_bank_txns", period),
  ads_spend: (period) => viaBinding("ads_spend", period),
  available_stock: async () => {
    const s = await pageAvailableStock();
    const notes = [
      s.unknownVariants > 0 ? `${s.unknownVariants} mẫu mã chưa có phiếu nhập — không cộng (chưa biết, không phải 0)` : "",
      s.oversoldRows > 0 ? `${s.oversoldRows} mẫu mã đã chốt nhiều hơn tồn` : "",
    ].filter(Boolean);
    return { value: s.available, ...(notes.length ? { note: notes.join(" · ") } : {}) };
  },
};

/** Khoá có trong sổ mà thiếu hàm đọc / thiếu khai phạm vi (và ngược lại) — bài kiểm khoá bằng 0. */
export const METRIC_WIRING_GAPS = [
  ...METRIC_SOURCES.filter((s) => !METRIC_RUNNERS[s.key] || !METRIC_SCOPE[s.key]).map((s) => s.key),
  ...Object.keys(METRIC_RUNNERS).filter((k) => !metricSource(k)),
];

async function resolveKpi(block: PageBlock<"kpi">, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["kpi"]> {
  const cfg = block.config as KpiConfig;
  if (isAggregateKpi(cfg)) return resolveAggregateKpi(block.id, cfg, user, ctx);
  const spec = metricSource(String(cfg?.metric ?? "")) ?? stop("INVALID_CONFIG", `Chỉ số "${String(cfg?.metric)}" không có trong sổ nguồn.`);
  const run = METRIC_RUNNERS[spec.key] ?? stop("INVALID_CONFIG", `Chỉ số "${spec.key}" chưa có hàm đọc.`);
  const period = periodFor(spec, cfg.period, ctx);
  const decision = await gateOrStop(user, spec, METRIC_SCOPE[spec.key] ?? stop("INVALID_CONFIG", `Chỉ số "${spec.key}" chưa khai phạm vi.`));
  requireWholeScope(decision, spec.label);
  probe();
  const r = await memo(`pageMetric:${spec.key}:${periodKey(period)}`, 60_000, () => run(period));
  return { label: cfg.label?.trim() || spec.label, value: r.value === null || r.value === undefined || !Number.isFinite(r.value) ? null : r.value, format: spec.format, ...(r.note ? { note: r.note } : {}), ...(METRIC_HREF[spec.key] ? { href: METRIC_HREF[spec.key] } : {}) };
}

// ─────────────────────────── Biểu đồ ───────────────────────────

async function stagePoints(period: Period): Promise<{ x: string; y: number | null }[]> {
  const [counts, options] = await Promise.all([pageOrderStageCounts(period), getSystemStatusOptions("order", "stage")]);
  const byStage = new Map(counts.map((c) => [c.stage, c.n]));
  const ordered = (options ?? []).slice().sort((a, b) => a.position - b.position);
  const out: { x: string; y: number | null }[] = [];
  for (const o of ordered) if (byStage.has(o.value)) out.push({ x: o.label, y: byStage.get(o.value)! });
  // Giai đoạn chưa có trong cấu hình (dữ liệu lạ) vẫn phải hiện — không được biến mất khỏi tổng.
  for (const [stage, n] of byStage) if (!ordered.some((o) => o.value === stage)) out.push({ x: ORDER_STAGE_LABEL[stage as keyof typeof ORDER_STAGE_LABEL] ?? stage, y: n });
  return out;
}

const SERIES_RUNNERS: Record<string, (period: Period) => Promise<{ x: string; y: number | null }[]>> = {
  orders_by_day: (period) => pageOrderSeriesByDay(period, "count"),
  booked_revenue_by_day: (period) => pageOrderSeriesByDay(period, "revenue"),
  orders_by_stage: (period) => stagePoints(period),
};
const SERIES_SCOPE: Record<string, string> = { orders_by_day: "ORDERS", booked_revenue_by_day: "ORDERS", orders_by_stage: "ORDERS" };

export const SERIES_WIRING_GAPS = [...SERIES_SOURCES.filter((s) => !SERIES_RUNNERS[s.key] || !SERIES_SCOPE[s.key]).map((s) => s.key), ...Object.keys(SERIES_RUNNERS).filter((k) => !seriesSource(k))];

async function resolveChart(block: PageBlock<"chart">, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["chart"]> {
  const cfg = block.config as ChartConfig;
  if (isAggregateChart(cfg)) return resolveAggregateChart(block.id, cfg, user, ctx);
  const spec = seriesSource(String(cfg?.series ?? "")) ?? stop("INVALID_CONFIG", `Chuỗi "${String(cfg?.series)}" không có trong sổ nguồn.`);
  if (!spec.kinds.includes(cfg.kind)) stop("INVALID_CONFIG", `Chuỗi "${spec.label}" không vẽ được dạng "${String(cfg.kind)}".`);
  const run = SERIES_RUNNERS[spec.key] ?? stop("INVALID_CONFIG", `Chuỗi "${spec.key}" chưa có hàm đọc.`);
  const period = periodFor(spec, cfg.period, ctx);
  const decision = await gateOrStop(user, spec, SERIES_SCOPE[spec.key] ?? null);
  requireWholeScope(decision, spec.label);
  probe();
  const points = await memo(`pageSeries:${spec.key}:${periodKey(period)}`, 60_000, () => run(period));
  return { kind: cfg.kind, format: spec.format, points };
}

// ─────────────────────────── Bảng + Kanban: trường và bộ lọc ───────────────────────────

type ObjectFields = { def: ObjectDef; system: SystemFieldDef[]; custom: CustomFieldDef[]; viewable: CustomFieldDef[] };

async function objectFields(def: ObjectDef, user: SessionUser): Promise<ObjectFields> {
  const f = await listFields(def.key);
  const custom = f.custom.filter((c) => c.status === "ACTIVE");
  return { def, system: f.system, custom, viewable: custom.filter((c) => canViewField(user, def, c)) };
}

type Ref = { kind: "system"; field: SystemFieldDef } | { kind: "custom"; field: CustomFieldDef; viewable: boolean };

function resolveRef(of: ObjectFields, ref: unknown): Ref | null {
  const p = typeof ref === "string" ? parseRef(ref) : null;
  if (!p) return null;
  if (p.kind === "system") {
    const field = of.system.find((s) => s.key === p.key);
    return field ? { kind: "system", field } : null;
  }
  const field = of.custom.find((c) => c.key === p.key);
  return field ? { kind: "custom", field, viewable: of.viewable.includes(field) } : null;
}

/**
 * Bộ lọc cố định của cấu hình + bộ lọc thanh lọc áp lên khối này (`ctx.blockFilters`, đã parse + kiểm ở
 * `resolveFilter`). Cấu hình không phải danh sách ⇒ để `buildWhere` báo lỗi như cũ.
 */
function withViewerFilters(configured: unknown, blockId: string, ctx: PageRenderContext): unknown {
  const extra = ctx.blockFilters?.[blockId] ?? [];
  if (extra.length === 0) return configured;
  if (configured !== undefined && configured !== null && !Array.isArray(configured)) return configured;
  return [...((configured as ListFilter[] | undefined) ?? []), ...extra];
}

/** `where` của bảng / kanban: bộ lọc field hệ thống + field custom + phạm vi. Mọi lỗi cấu hình ⇒ dừng, KHÔNG chạy truy vấn. */
function buildWhere(of: ObjectFields, filters: unknown, decision: ScopeDecision, resource: string | null): SQL | undefined {
  const list = Array.isArray(filters) ? (filters as ListFilter[]) : filters === undefined || filters === null ? [] : stop("INVALID_CONFIG", "Bộ lọc phải là danh sách.");
  if (list.length > LIST_MAX_FILTERS) stop("INVALID_CONFIG", `Tối đa ${LIST_MAX_FILTERS} bộ lọc.`);
  const { columns } = pageObjectTable(of.def);
  const parts: SQL[] = [];
  const customFilters: ListFilter[] = [];
  for (const f of list) {
    const r = resolveRef(of, f?.ref) ?? stop("INVALID_CONFIG", `Bộ lọc trỏ field không tồn tại: "${String(f?.ref)}".`);
    if (!r.field.filterable) stop("INVALID_CONFIG", `Field "${r.field.label}" không lọc được.`);
    if (!filterShapeOk(f)) stop("INVALID_CONFIG", `Bộ lọc "${String(f.op)}" trên "${r.field.label}" thiếu hoặc sai giá trị.`);
    if (r.kind === "system") {
      const col = columns[r.field.column] ?? stop("INVALID_CONFIG", `Field "${r.field.label}" không có cột.`);
      parts.push(pageSystemFilterSql(r.field, col, f) ?? stop("INVALID_CONFIG", `Bộ lọc "${f.op}" không dùng được với field "${r.field.label}".`));
    } else {
      // Lọc theo field người xem không được xem thì sự có mặt của một dòng đã nói ra giá trị của field ấy.
      if (!r.viewable) stop("FORBIDDEN", `Khối lọc theo field "${r.field.label}" mà bạn không được xem.`);
      customFilters.push(f);
    }
  }
  if (customFilters.length) {
    const c = customValuesFilterSql(of.def.key, customFilters);
    if (c) parts.push(c);
  }
  if (decision.allow === "ROWS") {
    const res = resource ? SCOPE_RESOURCE_BY_KEY[resource] : null;
    if (!res || res.table !== getTableName(pageObjectTable(of.def).table)) stop("FORBIDDEN", "Phạm vi dữ liệu của bạn không áp được lên danh sách này.");
  }
  return andScope(parts.length ? and(...parts) : undefined, decision);
}

function systemFormat(f: SystemFieldDef): TableColumn["format"] {
  if (f.type === "currency") return "vnd";
  if (f.type === "number") return "number";
  if (f.type === "datetime") return "datetime";
  if (f.type === "date") return "date";
  if (f.type === "select" || f.type === "status") return "status";
  return "text";
}

function customFormat(f: CustomFieldDef): TableColumn["format"] {
  if (f.type === "currency") return "vnd";
  if (f.type === "number") return "number";
  if (f.type === "datetime") return "datetime";
  if (f.type === "date") return "date";
  if (f.type === "status" || f.type === "select") return "status";
  return "text";
}

function systemCell(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  return v;
}

function customCell(f: CustomFieldDef, v: unknown, users: Record<string, string>): unknown {
  if (v === undefined || v === null) return null;
  if (f.type === "number" || f.type === "currency") return typeof v === "number" ? v : null;
  if (f.type === "date" || f.type === "datetime") return typeof v === "string" ? v : null;
  if (f.type === "user" && typeof v === "string") return users[v] ?? v;
  const text = customValueText(f, v);
  return text === "" ? null : text;
}

async function statusLabels(def: ObjectDef): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const key of def.statusFields) {
    const opts = (await getSystemStatusOptions(def.key, key)) ?? def.fields.find((f) => f.key === key)?.options ?? [];
    out.set(key, new Map(opts.map((o) => [o.value, o.label])));
  }
  return out;
}

async function customFor(objectKey: string, fields: CustomFieldDef[], ids: string[], user: SessionUser): Promise<{ values: Map<string, CustomValues>; users: Record<string, string> }> {
  if (!fields.length || !ids.length) return { values: new Map(), users: {} };
  const values = await getCustomValues(objectKey, ids, user);
  const userKeys = fields.filter((f) => f.type === "user").map((f) => f.key);
  const userIds = userKeys.length ? [...values.values()].flatMap((v) => userKeys.map((k) => v[k]).filter((x): x is string => typeof x === "string")) : [];
  return { values, users: userIds.length ? await userLabelsByIds(userIds) : {} };
}

function sourceForObject(objectKey: string): ListSourceSpec {
  return listSource(objectKey) ?? stop("INVALID_CONFIG", `"${objectKey}" không có trong sổ nguồn danh sách.`);
}

// ─────────────────────────── Bảng ───────────────────────────

const TABLE_DEFAULT_PAGE_SIZE = 25;
const TABLE_MAX_PAGE_SIZE = 100;

async function resolveTable(block: PageBlock<"table">, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["table"]> {
  const cfg = block.config as TableConfig;
  const src = sourceForObject(String(cfg?.source ?? ""));
  const def = objectDef(src.objectKey) ?? stop("INVALID_CONFIG", "Đối tượng không có trong sổ.");
  const resource = OBJECT_SCOPE_RESOURCE[def.key] ?? null;
  const decision = await gateOrStop(user, { module: src.module, permission: src.permission, label: src.label }, resource);
  const of = await objectFields(def, user);

  // Cột: chỉ field `listable`; field custom người xem không được xem thì KHÔNG có cột (không lỗi — như danh sách Phase 2).
  const refs: FieldRef[] = cfg.columns?.length ? cfg.columns : [...of.system.filter((f) => f.listable).map((f) => `system:${f.key}` as FieldRef), ...of.viewable.filter((f) => f.listable).map((f) => `custom:${f.key}` as FieldRef)];
  const sysCols: SystemFieldDef[] = [];
  const cusCols: CustomFieldDef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const r = resolveRef(of, ref) ?? stop("INVALID_CONFIG", `Cột trỏ field không tồn tại: "${String(ref)}".`);
    if (!r.field.listable) stop("INVALID_CONFIG", `Field "${r.field.label}" không hiển thị được thành cột.`);
    if (r.kind === "system") sysCols.push(r.field);
    else if (r.viewable) cusCols.push(r.field);
  }

  let sort = pageDefaultSort(def);
  if (cfg.sort) {
    const r = resolveRef(of, cfg.sort.ref) ?? stop("INVALID_CONFIG", `Không sắp xếp được theo "${String(cfg.sort.ref)}".`);
    if (r.kind !== "system" || !r.field.listable) stop("INVALID_CONFIG", `Chỉ sắp xếp được theo cột hệ thống hiển thị được.`);
    sort = { field: r.field as SystemFieldDef, dir: cfg.sort.dir === "asc" ? "asc" : "desc" };
  }
  const where = buildWhere(of, withViewerFilters(cfg.filters, block.id, ctx), decision, resource);
  const pageSize = Math.max(1, Math.min(TABLE_MAX_PAGE_SIZE, Math.floor(Number(cfg.pageSize ?? TABLE_DEFAULT_PAGE_SIZE)) || TABLE_DEFAULT_PAGE_SIZE));
  const page = Math.max(1, Math.min(10_000, Math.floor(Number(ctx.searchParams[`${block.id}_page`] ?? 1)) || 1));

  probe();
  const { rows, total } = await pageObjectRows(def, { fields: sysCols, where, sort, limit: pageSize, offset: (page - 1) * pageSize });
  const ids = rows.map((r) => r.id);
  const [{ values, users }, labels, rowActions] = await Promise.all([customFor(def.key, cusCols, ids, user), statusLabels(def), rowActionsFor(cfg, def, user)]);
  const columns: TableColumn[] = [...sysCols.map((f) => ({ id: `system:${f.key}`, label: f.label, format: systemFormat(f) })), ...cusCols.map((f) => ({ id: `custom:${f.key}`, label: f.label, format: customFormat(f) }))];
  return {
    columns,
    rows: rows.map((r) => {
      const cells: Record<string, unknown> = {};
      for (const f of sysCols) {
        const raw = systemCell(r.values[f.key]);
        const label = typeof raw === "string" ? labels.get(f.key)?.get(raw) : undefined;
        cells[`system:${f.key}`] = label ?? raw;
      }
      const cv = values.get(r.id) ?? {};
      for (const f of cusCols) cells[`custom:${f.key}`] = customCell(f, cv[f.key], users);
      const href = cfg.rowLink ? pageDetailHref(def.key, r.id) : undefined;
      return { id: r.id, ...(href ? { href } : {}), cells };
    }),
    total,
    page,
    pageSize,
    ...(rowActions.length ? { rowActions } : {}),
    ...(ctx.blockFilters?.[block.id]?.length ? { appliedFilters: ctx.blockFilters[block.id].length } : {}),
  };
}

/**
 * Hành động theo dòng như NGƯỜI XEM thấy (bật / tắt + lý do). Chỉ để vẽ — `executePageAction` đọc lại bản ĐÃ XUẤT
 * BẢN và kiểm bản ghi trong phạm vi người bấm. Đối tượng luôn là đối tượng của bảng (ghim ở máy chủ).
 */
async function rowActionsFor(cfg: TableConfig, def: ObjectDef, user: SessionUser): Promise<TableRowActionData[]> {
  const list = Array.isArray(cfg.rowActions) ? cfg.rowActions.slice(0, TABLE_MAX_ROW_ACTIONS) : [];
  return Promise.all(
    list.map(async (a, index): Promise<TableRowActionData> => {
      const label = typeof a?.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : "Thao tác";
      const confirm = typeof a?.confirm === "string" && a.confirm.trim() ? { confirm: a.confirm.slice(0, 300) } : {};
      const spec = pageAction(String(a?.action ?? ""));
      if (!spec || !ROW_ACTION_KEYS.includes(spec.key)) return { index, label, ...confirm, enabled: false, reason: "Hành động không có trong sổ hành động theo dòng." };
      const pinned = { ...(a.input && typeof a.input === "object" && !Array.isArray(a.input) ? a.input : {}), objectKey: def.key };
      const av = await actionAvailability(spec, pinned, user);
      return { index, label, ...confirm, enabled: av.enabled, ...(av.reason ? { reason: av.reason } : {}) };
    }),
  );
}

// ─────────────────────────── Kanban (G6) ───────────────────────────

const KANBAN_MAX_CARDS = 200;
const KANBAN_MAX_CARD_FIELDS = 6;

async function resolveKanban(block: PageBlock<"kanban">, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["kanban"]> {
  const cfg = block.config as KanbanConfig;
  const src = sourceForObject(String(cfg?.objectKey ?? ""));
  const def = objectDef(src.objectKey) ?? stop("INVALID_CONFIG", "Đối tượng không có trong sổ.");
  const resource = OBJECT_SCOPE_RESOURCE[def.key] ?? null;
  const decision = await gateOrStop(user, { module: src.module, permission: src.permission, label: src.label }, resource);
  const of = await objectFields(def, user);

  // CHỈ field custom kiểu `status` — trạng thái HỆ THỐNG (đơn, vận đơn…) không bao giờ thành cột kéo thả.
  const st = resolveRef(of, cfg.statusField);
  if (!st || st.kind !== "custom" || st.field.type !== "status") stop("INVALID_CONFIG", "Kanban chỉ chạy trên field bổ sung kiểu trạng thái.");
  const status = (st as { field: CustomFieldDef; viewable: boolean }).field;
  if (!(st as { viewable: boolean }).viewable) stop("FORBIDDEN", `Bạn không được xem "${status.label}".`);

  const cardRefs = Array.isArray(cfg.cardFields) ? cfg.cardFields.slice(0, KANBAN_MAX_CARD_FIELDS) : [];
  const title = of.system.find((f) => f.key === def.titleField);
  const sysFields: SystemFieldDef[] = title ? [title] : [];
  const cusFields: CustomFieldDef[] = [status];
  const shown: Ref[] = [];
  for (const ref of cardRefs) {
    const r = resolveRef(of, ref) ?? stop("INVALID_CONFIG", `Thẻ trỏ field không tồn tại: "${String(ref)}".`);
    if (r.kind === "custom" && !r.viewable) continue;
    shown.push(r);
    if (r.kind === "system" && !sysFields.includes(r.field)) sysFields.push(r.field);
    if (r.kind === "custom" && !cusFields.includes(r.field)) cusFields.push(r.field);
  }
  const where = buildWhere(of, withViewerFilters(cfg.filters, block.id, ctx), decision, resource);
  const limit = Math.max(1, Math.min(KANBAN_MAX_CARDS, Math.floor(Number(cfg.limit ?? KANBAN_MAX_CARDS)) || KANBAN_MAX_CARDS));

  probe();
  const { rows } = await pageObjectRows(def, { fields: sysFields, where, sort: pageDefaultSort(def), limit: limit + 1, offset: 0 });
  const truncated = rows.length > limit;
  const cards = rows.slice(0, limit);
  const { values, users } = await customFor(def.key, cusFields, cards.map((c) => c.id), user);
  const allowMove = cfg.allowMove === true && canEditField(user, def, status);
  const options = [...status.options].sort((a, b) => a.position - b.position);

  const byValue = new Map<string, KanbanCard[]>();
  for (const r of cards) {
    const cv = values.get(r.id) ?? {};
    const current = typeof cv[status.key] === "string" ? (cv[status.key] as string) : "";
    const card: KanbanCard = {
      id: r.id,
      title: String(title ? (systemCell(r.values[title.key]) ?? r.id) : r.id),
      ...(pageDetailHref(def.key, r.id) ? { href: pageDetailHref(def.key, r.id) } : {}),
      fields: shown.map((s) => ({
        label: s.field.label,
        value: String((s.kind === "system" ? systemCell(r.values[s.field.key]) : customCell(s.field, cv[s.field.key], users)) ?? "—"),
      })),
      // Đích kéo theo ĐÚNG luật chuyển của field (hàm thuần dùng chung với form) — máy chủ vẫn kiểm lại khi ghi.
      moveTargets: allowMove ? statusTargets(options, status.transitions, current || null).map((o) => o.value).filter((v) => v !== current) : [],
    };
    const list = byValue.get(current) ?? [];
    list.push(card);
    byValue.set(current, list);
  }
  const columns: BlockDataByType["kanban"]["columns"] = [];
  if (byValue.has("")) columns.push({ value: "", label: "Chưa đặt", cards: byValue.get("")! });
  for (const o of options) {
    if (!o.active && !byValue.has(o.value)) continue;
    columns.push({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), cards: byValue.get(o.value) ?? [] });
  }
  // Giá trị không còn trong tuỳ chọn (dữ liệu cũ) vẫn phải có cột — thẻ không được biến mất.
  for (const [v, list] of byValue) if (v && !options.some((o) => o.value === v)) columns.push({ value: v, label: v, cards: list });
  return { field: `custom:${status.key}`, allowMove, columns, truncated };
}

// ─────────────────────────── Dòng thời gian ───────────────────────────

const TIMELINE_MAX = 200;

function recordParamValue(cfg: { recordParam?: string }, ctx: PageRenderContext): string {
  const param = cfg.recordParam?.trim() || stop("INVALID_CONFIG", "Khối cần khai tham số bản ghi (recordParam).");
  const id = ctx.searchParams[param];
  if (typeof id !== "string" || id.length === 0 || id.length > 200) stop("NOT_FOUND", "Chưa chọn bản ghi.");
  return id as string;
}

async function requireRecordInScope(objectKey: string, id: string, decision: ScopeDecision, resource: string | null) {
  if (objectKey === "model") {
    const db = await getDb();
    const found = await db.select({ id: schema.productModels.id }).from(schema.productModels).where(eq(schema.productModels.id, id)).limit(1);
    if (!found.length) stop("NOT_FOUND", "Bản ghi không tồn tại.");
    return;
  }
  const def = objectDef(objectKey) ?? stop("INVALID_CONFIG", "Đối tượng không có trong sổ.");
  if (!(await recordExists(def, id))) stop("NOT_FOUND", "Bản ghi không tồn tại.");
  if (decision.allow === "ROWS") {
    const res = resource ? SCOPE_RESOURCE_BY_KEY[resource] : null;
    const { table, id: idCol } = pageObjectTable(def);
    if (!res || res.table !== getTableName(table) || !(await rowInScope(decision, res.table, idCol.name, id))) stop("NOT_FOUND", "Bản ghi không tồn tại.");
  }
}

async function resolveTimeline(block: PageBlock<"timeline">, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["timeline"]> {
  const cfg = block.config as TimelineConfig;
  const spec: TimelineSourceSpec = timelineSource(String(cfg?.source ?? "")) ?? stop("INVALID_CONFIG", `Dòng thời gian "${String(cfg?.source)}" không có trong sổ nguồn.`);
  const recordObject = spec.recordObject ?? stop("INVALID_CONFIG", "Nguồn dòng thời gian thiếu đối tượng bản ghi.");
  const id = recordParamValue(cfg, ctx);
  const resource = OBJECT_SCOPE_RESOURCE[recordObject] ?? null;
  const decision = await gateOrStop(user, spec, resource);
  const limit = Math.max(1, Math.min(TIMELINE_MAX, Math.floor(Number(cfg.limit ?? 50)) || 50));
  await requireRecordInScope(recordObject, id, decision, resource);
  probe();

  if (spec.key === "order") {
    const list = await getOrderTimeline(id);
    return { entries: list.slice(0, limit).map((e) => ({ id: e.id, at: e.at.toISOString(), title: e.title, ...(e.detail ? { detail: e.detail } : {}), source: e.source })) };
  }
  if (spec.key === "shipment") {
    const t = await getShipmentTimeline(id, { limit });
    return { entries: t.entries.slice(0, limit).map((e) => ({ id: e.id, at: e.at.toISOString(), title: e.title, ...(e.detail ? { detail: e.detail } : {}), source: e.source || e.actorName })) };
  }
  if (spec.key === "model") {
    const list = await getModelTimeline(id);
    return { entries: list.slice(0, limit).map((e) => ({ id: e.id, at: e.at.toISOString(), title: e.title, ...(e.detail ? { detail: e.detail } : {}), source: e.source })) };
  }
  if (spec.key.startsWith(CUSTOM_RECORD_TIMELINE_PREFIX)) {
    const def = objectDef(recordObject) ?? stop("INVALID_CONFIG", "Đối tượng không có trong sổ.");
    const of = await objectFields(def, user);
    const byKey = new Map(of.custom.map((c) => [c.key, c]));
    const viewable = new Set(of.viewable.map((c) => c.key));
    const raw = await getRecordTimeline(def.key, id, limit);
    const entries: BlockDataByType["timeline"]["entries"] = [];
    for (const e of raw) {
      // Mốc chạm field người xem không được xem ⇒ không hiện field đó; không còn field nào ⇒ không hiện mốc.
      const keys = e.fieldKeys.filter((k) => viewable.has(k));
      if (e.fieldKeys.length && !keys.length) continue;
      let detail = keys.map((k) => byKey.get(k)?.label ?? k).join(", ");
      if (e.kind === "EVENT" && keys.length === 1) {
        const f = byKey.get(keys[0])!;
        const [, change = ""] = e.detail.split(": ");
        const [from = "—", to = "—"] = change.split(" → ");
        const label = (v: string) => (v === "—" ? v : (f.options.find((o) => o.value === v)?.label ?? v));
        detail = `${f.label}: ${label(from)} → ${label(to)}`;
      }
      entries.push({ id: e.id, at: e.at.toISOString(), title: e.title, ...(detail ? { detail } : {}), source: e.source });
    }
    return { entries };
  }
  return stop("INVALID_CONFIG", `Nguồn "${spec.key}" chưa có hàm đọc.`);
}

export const TIMELINE_WIRING_GAPS = TIMELINE_SOURCES.filter((s) => !["order", "shipment", "model"].includes(s.key) && !s.key.startsWith(CUSTOM_RECORD_TIMELINE_PREFIX)).map((s) => s.key);

// ─────────────────────────── Form (props của DynamicForm) ───────────────────────────

async function resolveForm(block: PageBlock<"form">, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["form"]> {
  const cfg = block.config as FormConfig;
  const def = objectDef(String(cfg?.objectKey ?? "")) ?? stop("INVALID_CONFIG", `Đối tượng "${String(cfg?.objectKey)}" không có trong sổ.`);
  if (!def.capabilities.forms) stop("INVALID_CONFIG", `${def.label} chưa có form metadata.`);
  const form = def.forms.find((f) => f.key === cfg.formKey) ?? stop("INVALID_CONFIG", `${def.label} không có form "${String(cfg.formKey)}".`);
  const mode = cfg.mode;
  if (mode !== "create" && mode !== "edit" && mode !== "view") stop("INVALID_CONFIG", "Chế độ form không hợp lệ.");
  if ((mode === "create") !== (form.purpose === "create")) stop("INVALID_CONFIG", `Form "${form.label}" dùng cho ${form.purpose === "create" ? "tạo mới" : "sửa / xem"}, không dùng được ở chế độ "${mode}".`);
  const resource = OBJECT_SCOPE_RESOURCE[def.key] ?? null;
  const decision = await gateOrStop(user, { module: def.module, permission: OBJECT_RECORD_PERMISSIONS[def.key].view, label: def.labelPlural }, resource);

  if (mode === "create") {
    if (def.key !== "customer" || !def.capabilities.create) stop("INVALID_CONFIG", `${def.label} không tạo được qua form.`);
    const { customerCreateGate } = await import("@/lib/records/customer-create");
    const gate = await customerCreateGate(user);
    if (!gate.allowed) stop(gate.code === "NOT_SUPPORTED" ? "INVALID_CONFIG" : gate.code, gate.reason);
  }
  const recordId = mode === "create" ? null : recordParamValue(cfg, ctx);
  if (recordId) await requireRecordInScope(def.key, recordId, decision, resource);

  probe();
  const [published, fields] = await Promise.all([getPublishedForm(def.key, form.key), listFields(def.key)]);
  const custom = fields.custom.filter((c) => c.status === "ACTIVE");
  let systemValues: Record<string, unknown> = {};
  let customValues: CustomValues = {};
  if (recordId) {
    const { id: idCol } = pageObjectTable(def);
    const { rows } = await pageObjectRows(def, { fields: fields.system, where: eq(idCol, recordId), sort: null, limit: 1, offset: 0 });
    systemValues = Object.fromEntries(fields.system.map((f) => [f.key, systemCell(rows[0]?.values[f.key])]));
    customValues = (await getCustomValues(def.key, [recordId], user)).get(recordId) ?? {};
  }
  const editable = mode === "view" ? [] : custom.filter((f) => (mode === "create" ? f.type !== "file" : true) && canEditField(user, def, f)).map((f) => f.key);
  const users = custom.some((f) => f.type === "user") ? await userPickOptions() : undefined;
  return {
    objectKey: def.key,
    formKey: form.key,
    mode,
    recordId,
    props: {
      schema: published.schema,
      system: fields.system,
      // Field người xem không được xem KHÔNG lên trình duyệt — kể cả định nghĩa của nó.
      custom: custom.filter((f) => canViewField(user, def, f)),
      values: { system: systemValues, custom: customValues },
      customEditable: editable,
      ...(mode === "create" ? { customLockedReason: Object.fromEntries(custom.filter((f) => f.type === "file").map((f) => [f.key, "Tải tệp ở trang chi tiết sau khi tạo"])) } : {}),
      systemReadOnlyReason: mode === "create" ? null : "Thông tin hệ thống chỉ đọc ở form này — chỉ field bổ sung sửa được",
      ...(users ? { users } : {}),
      submitLabel: mode === "create" ? `Tạo ${def.label.toLowerCase()}` : "Lưu",
    },
  };
}

// ─────────────────────────── Nút + chữ ───────────────────────────

async function resolveButton(block: PageBlock<"button">, user: SessionUser): Promise<BlockDataByType["button"]> {
  const cfg = block.config as ButtonConfig;
  const spec: PageActionSpec = pageAction(String(cfg?.action ?? "")) ?? stop("INVALID_CONFIG", `Action "${String(cfg?.action)}" không có trong sổ.`);
  const label = typeof cfg.label === "string" && cfg.label.trim() ? cfg.label.trim().slice(0, 80) : spec.label;
  const pinned = cfg.input && typeof cfg.input === "object" && !Array.isArray(cfg.input) ? cfg.input : {};
  const a = await actionAvailability(spec, pinned, user);
  return { action: spec.key, label, ...(cfg.confirm ? { confirm: String(cfg.confirm).slice(0, 300) } : {}), enabled: a.enabled, ...(a.reason ? { reason: a.reason } : {}) };
}

function resolveText(block: PageBlock<"text">): BlockDataByType["text"] {
  const cfg = (block.config ?? {}) as TextConfig;
  const variant = cfg.variant === "heading" || cfg.variant === "paragraph" || cfg.variant === "note" ? cfg.variant : undefined;
  // Chữ THÔ — renderer in như văn bản, không HTML, không Markdown thực thi.
  return {
    ...(typeof cfg.heading === "string" ? { heading: cfg.heading.slice(0, 200) } : {}),
    ...(typeof cfg.body === "string" ? { body: cfg.body.slice(0, 5_000) } : {}),
    ...(variant ? { variant } : {}),
  };
}

// ─────────────────────────── Tổng hợp theo field (Phase 5) ───────────────────────────

/** Mốc thời gian tối đa của biểu đồ theo ngày / tuần / tháng — hơn thế thì giữ các mốc GẦN NHẤT và nói ra. */
const AGGREGATE_MAX_BUCKETS = 366;

type AggregatePlan = {
  def: ObjectDef;
  of: ObjectFields;
  decision: ScopeDecision;
  where: SQL | undefined;
  field: AggregateFieldRef | null;
  format: ValueFormat;
  /** Khoá memo: cấu hình đã chuẩn hoá + bộ lọc + phạm vi (ALL dùng chung; ROWS theo người). */
  cacheScope: string;
};

function toAggregateRef(r: Ref): AggregateFieldRef {
  return r.kind === "system" ? { kind: "system", field: r.field } : { kind: "custom", field: r.field };
}

/** Một field trong một vai trò của phép tổng hợp — field custom người xem không được xem ⇒ FORBIDDEN (không lộ qua số). */
function aggregateRef(of: ObjectFields, ref: unknown, role: "aggregate" | "count" | "group" | "date"): AggregateFieldRef {
  const r = resolveRef(of, ref) ?? stop("INVALID_CONFIG", `Tổng hợp trỏ field không tồn tại: "${String(ref)}".`);
  if (r.kind === "custom" && !r.viewable) stop("FORBIDDEN", `Khối tổng hợp theo field "${r.field.label}" mà bạn không được xem.`);
  const t = r.field.type;
  if (role === "aggregate") {
    // Field SỐ khai tổng hợp: hệ thống phải khai `aggregatable` (tiền của đơn / vận đơn / hàng hoàn không bao giờ);
    // field số tuỳ biến tổng hợp được mặc định.
    const ok = AGGREGATE_NUMERIC_TYPES.has(t) && (r.kind === "custom" || (r.field as SystemFieldDef).aggregatable === true);
    if (!ok) stop("INVALID_CONFIG", AGGREGATE_NUMERIC_TYPES.has(t) ? `Field "${r.field.label}" không khai tổng hợp — số tiền đơn / vận đơn / hàng hoàn chỉ đọc qua sổ chỉ số (ORDER_OUTCOME).` : `Field "${r.field.label}" không phải số — chỉ đếm được.`);
  } else if (role === "group") {
    const status = r.kind === "system" && of.def.statusFields.includes(r.field.key);
    if (!GROUPABLE_TYPES.has(t) && !status) stop("INVALID_CONFIG", `Field "${r.field.label}" không nhóm được.`);
  } else if (role === "date" && !DATE_TYPES.has(t)) stop("INVALID_CONFIG", `Field "${r.field.label}" không phải ngày / ngày giờ.`);
  return toAggregateRef(r);
}

/** Bốn cổng + field + `where` của một phép tổng hợp — TRƯỚC mọi truy vấn dữ liệu. */
async function planAggregate(spec: AggregateSpec, user: SessionUser, extra: readonly ListFilter[]): Promise<AggregatePlan> {
  if (!spec || typeof spec !== "object") stop("INVALID_CONFIG", "Khối tổng hợp thiếu cấu hình.");
  const src = sourceForObject(String(spec.objectKey ?? ""));
  const def = objectDef(src.objectKey) ?? stop("INVALID_CONFIG", "Đối tượng không có trong sổ.");
  if (!(AGGREGATE_FNS as readonly string[]).includes(spec.fn)) stop("INVALID_CONFIG", `Phép tổng hợp "${String(spec.fn)}" không có trong sổ.`);
  const resource = OBJECT_SCOPE_RESOURCE[def.key] ?? null;
  const decision = await gateOrStop(user, { module: src.module, permission: src.permission, label: src.label }, resource);
  const of = await objectFields(def, user);
  let field: AggregateFieldRef | null = null;
  if (spec.field) field = aggregateRef(of, spec.field, spec.fn === "count" ? "count" : "aggregate");
  else if (spec.fn !== "count") stop("INVALID_CONFIG", `Phép "${spec.fn}" cần một field số.`);
  const configured = spec.filters === undefined ? [] : spec.filters;
  const where = buildWhere(of, Array.isArray(configured) ? [...configured, ...extra] : configured, decision, resource);
  const format: ValueFormat = spec.fn === "count" || !field ? "number" : field.field.type === "currency" ? "vnd" : "number";
  return { def, of, decision, where, field, format, cacheScope: decision.allow === "ALL" ? "all" : `u:${user.id}` };
}

function periodOf(configured: PeriodKey | undefined, ctx: PageRenderContext): Period {
  const key = configured ?? ctx.period;
  return resolvePeriod({ ...ctx.searchParams, period: key }, key);
}

function aggregatePeriod(field: AggregateFieldRef, period: Period): AggregatePeriod | null {
  if (!period.from && !period.to) return null;
  return { field, from: period.from, to: period.to, fromKey: period.fromKey, toKey: period.toKey };
}

const fieldLabel = (r: AggregateFieldRef | null) => (r ? r.field.label : "");

async function resolveAggregateKpi(blockId: string, cfg: AggregateKpiConfig, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["kpi"]> {
  const extra = ctx.blockFilters?.[blockId] ?? [];
  const plan = await planAggregate(cfg.aggregate, user, extra);
  const dateField = cfg.dateField ? aggregateRef(plan.of, cfg.dateField, "date") : null;
  if (cfg.period && !dateField) stop("INVALID_CONFIG", "Kỳ chỉ áp khi chọn field ngày.");
  const period = dateField ? periodOf(cfg.period, ctx) : null;
  const key = `pageAgg:kpi:${plan.def.key}:${JSON.stringify([cfg.aggregate.fn, cfg.aggregate.field ?? null, cfg.aggregate.filters ?? [], extra, cfg.dateField ?? null])}:${period ? periodKey(period) : "-"}:${plan.cacheScope}`;
  probe();
  const r = await memo(key, 60_000, () => pageAggregateTotal({ def: plan.def, where: plan.where, fn: cfg.aggregate.fn, field: plan.field, period: dateField && period ? aggregatePeriod(dateField, period) : null }));
  const fnLabel = AGGREGATE_LABEL[cfg.aggregate.fn];
  const label = cfg.label?.trim() || `${fnLabel}${plan.field ? ` ${fieldLabel(plan.field).toLowerCase()}` : ""} · ${plan.def.labelPlural.toLowerCase()}`;
  const notes = [
    r.value === null && cfg.aggregate.fn !== "count" ? (r.records === 0 ? "Không có bản ghi nào" : `Chưa bản ghi nào có «${fieldLabel(plan.field)}» — chưa biết, không phải 0`) : "",
    period && dateField ? `${period.label} theo «${fieldLabel(dateField)}»` : "",
    extra.length ? `Đang lọc ${extra.length} điều kiện` : "",
  ].filter(Boolean);
  return { label, value: r.value === null || !Number.isFinite(r.value) ? null : r.value, format: plan.format, ...(notes.length ? { note: notes.join(" · ") } : {}) };
}

const AGGREGATE_LABEL: Record<AggregateSpec["fn"], string> = { count: "Số", sum: "Tổng", avg: "Trung bình", min: "Nhỏ nhất", max: "Lớn nhất" };

/** Nhãn của một khoá nhóm: nhãn trạng thái đã cấu hình (Phase 2) · nhãn tuỳ chọn · Có/Không · tên người. */
async function groupLabeler(def: ObjectDef, group: AggregateFieldRef, keys: string[]): Promise<(k: string) => string> {
  if (group.field.type === "boolean") return (k) => (k === "true" ? "Có" : k === "false" ? "Không" : k);
  if (group.field.type === "user") {
    const names = await userLabelsByIds(keys);
    return (k) => names[k] ?? k;
  }
  if (group.kind === "system") {
    const byStatus = def.statusFields.includes(group.field.key) ? (await statusLabels(def)).get(group.field.key) : undefined;
    const opts = new Map((group.field.options ?? []).map((o) => [o.value, o.label]));
    return (k) => byStatus?.get(k) ?? opts.get(k) ?? k;
  }
  const opts = new Map(group.field.options.map((o) => [o.value, o.label]));
  return (k) => opts.get(k) ?? k;
}

function mondayOf(key: string): string {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
  return addDays(key, -((dow + 6) % 7));
}

/** Mọi mốc của kỳ (ngày / thứ Hai / tháng) — kỳ không có hai đầu ⇒ `null` (chỉ vẽ mốc có dữ liệu). */
function bucketKeys(bucket: "day" | "week" | "month", period: Period | null): string[] | null {
  if (!period?.fromKey || !period.toKey) return null;
  const out: string[] = [];
  if (bucket === "month") {
    let [y, m] = period.fromKey.split("-").map(Number);
    const [ty, tm] = period.toKey.split("-").map(Number);
    while ((y < ty || (y === ty && m <= tm)) && out.length < 1000) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  const step = bucket === "week" ? 7 : 1;
  for (let d = bucket === "week" ? mondayOf(period.fromKey) : period.fromKey; d <= period.toKey && out.length < 5000; d = addDays(d, step)) out.push(d);
  return out;
}

function bucketLabel(bucket: "day" | "week" | "month", key: string): string {
  if (bucket !== "month") return key;
  const [y, m] = key.split("-");
  return `${m}/${y}`;
}

async function resolveAggregateChart(blockId: string, cfg: AggregateChartConfig, user: SessionUser, ctx: PageRenderContext): Promise<BlockDataByType["chart"]> {
  const kind = cfg.kind;
  if (kind !== "bar" && kind !== "line" && kind !== "pie") stop("INVALID_CONFIG", "Dạng biểu đồ không hợp lệ.");
  const g = cfg.groupBy as unknown;
  if (!g || typeof g !== "object") stop("INVALID_CONFIG", "Biểu đồ tổng hợp cần nhóm theo field hoặc theo thời gian.");
  const extra = ctx.blockFilters?.[blockId] ?? [];
  const plan = await planAggregate(cfg.aggregate, user, extra);
  const base = { def: plan.def, where: plan.where, fn: cfg.aggregate.fn, field: plan.field };
  const sig = JSON.stringify([cfg.aggregate.fn, cfg.aggregate.field ?? null, cfg.aggregate.filters ?? [], extra, cfg.groupBy]);

  if ("ref" in (g as object)) {
    if (cfg.period) stop("INVALID_CONFIG", "Kỳ chỉ áp khi nhóm theo thời gian.");
    const group = aggregateRef(plan.of, (g as { ref: unknown }).ref, "group");
    probe();
    const rows = await memo(`pageAgg:group:${plan.def.key}:${sig}:${plan.cacheScope}`, 60_000, () => pageAggregateGroups({ ...base, group, maxGroups: AGGREGATE_MAX_GROUPS }));
    const label = await groupLabeler(plan.def, group, rows.filter((r) => r.key !== null && !r.other).map((r) => r.key!));
    const points = rows.map((r) => ({ x: r.other ? "Khác" : r.key === null ? "Chưa đặt" : label(r.key), y: r.value }));
    const other = rows.find((r) => r.other);
    return { kind, format: plan.format, points, ...(other ? { note: `Hiện ${AGGREGATE_MAX_GROUPS} nhóm đông nhất; ${other.records} bản ghi còn lại gộp vào «Khác».` } : {}) };
  }

  if (kind === "pie") stop("INVALID_CONFIG", "Biểu đồ tròn chỉ dùng khi nhóm theo field.");
  const bucket = (g as { bucket?: unknown }).bucket;
  if (bucket !== "day" && bucket !== "week" && bucket !== "month") stop("INVALID_CONFIG", "Nhóm thời gian phải là ngày / tuần / tháng.");
  const b = bucket as "day" | "week" | "month";
  const dateField = aggregateRef(plan.of, (g as { dateField?: unknown }).dateField, "date");
  const period = periodOf(cfg.period, ctx);
  probe();
  const res = await memo(`pageAgg:time:${plan.def.key}:${sig}:${periodKey(period)}:${plan.cacheScope}`, 60_000, () =>
    pageAggregateBuckets({ ...base, period: aggregatePeriod(dateField, period), dateField, bucket: b, limit: AGGREGATE_MAX_BUCKETS }),
  );
  const byKey = new Map(res.buckets.map((x) => [x.key, x.value]));
  // Kỳ có hai đầu: mốc không có bản ghi vẫn hiện — ĐẾM được là 0 thật; cộng / trung bình không có giá trị là CHƯA BIẾT.
  let keys = bucketKeys(b, period) ?? res.buckets.map((x) => x.key);
  let truncated = res.truncated;
  if (keys.length > AGGREGATE_MAX_BUCKETS) {
    keys = keys.slice(-AGGREGATE_MAX_BUCKETS);
    truncated = true;
  }
  const empty = cfg.aggregate.fn === "count" ? 0 : null;
  const points = keys.map((k) => ({ x: bucketLabel(b, k), y: byKey.has(k) ? (byKey.get(k) ?? null) : empty }));
  const notes = [truncated ? `Chỉ hiện ${AGGREGATE_MAX_BUCKETS} mốc gần nhất.` : "", res.undated > 0 ? `${res.undated} bản ghi chưa có «${dateField.field.label}» — không vẽ.` : ""].filter(Boolean);
  return { kind, format: plan.format, points, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

// ─────────────────────────── Thanh lọc (Phase 5) ───────────────────────────

const FILTER_TEXT_MAX = 200;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Tham số URL của ô lọc thứ `i` của khối lọc `blockId`. */
export function filterParamName(blockId: string, i: number): string {
  return `pf_${blockId}_${i}`;
}

function filterInput(type: CustomFieldDef["type"], op: ListFilter["op"]): FilterFieldData["input"] {
  if (op === "empty" || op === "not_empty") return "presence";
  if (type === "number" || type === "currency") return "number";
  if (type === "date" || type === "datetime") return "date";
  if (type === "boolean") return "boolean";
  if (type === "select" || type === "status" || type === "user" || type === "multi_select") return "select";
  return "text";
}

async function filterOptions(of: ObjectFields, r: Ref): Promise<{ value: string; label: string }[] | undefined> {
  const t = r.field.type;
  if (t === "user") return (await userPickOptions()).map((u) => ({ value: u.id, label: u.label }));
  if (t === "boolean") return [{ value: "true", label: "Có" }, { value: "false", label: "Không" }];
  if (t !== "select" && t !== "status" && t !== "multi_select") return undefined;
  if (r.kind === "system") {
    const byStatus = of.def.statusFields.includes(r.field.key) ? await getSystemStatusOptions(of.def.key, r.field.key) : null;
    const opts = byStatus ?? r.field.options ?? [];
    return [...opts].sort((a, b) => a.position - b.position).map((o) => ({ value: o.value, label: o.label }));
  }
  return [...r.field.options].filter((o) => o.active).sort((a, b) => a.position - b.position).map((o) => ({ value: o.value, label: o.label }));
}

/**
 * Giá trị người xem nhập ⇒ bộ lọc, THEO KIỂU field. Hỏng ⇒ `null` (bỏ qua, không lỗi): URL là chữ ai cũng sửa
 * được, một giá trị lạ không được làm hỏng trang cũng không được lọt vào câu truy vấn.
 */
function parseFilterValue(r: Ref, op: ListFilter["op"], raw: string | undefined, options: { value: string }[] | undefined): { shown: string | string[]; filters: ListFilter[] } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_000) return null;
  const ref: FieldRef = `${r.kind}:${r.field.key}` as FieldRef;
  const t = r.field.type;
  if (op === "empty" || op === "not_empty") return raw === "1" ? { shown: "1", filters: [{ ref, op }] } : null;
  if (t === "number" || t === "currency") {
    const n = Number(raw.trim());
    return raw.trim() !== "" && Number.isFinite(n) ? { shown: raw.trim(), filters: [{ ref, op, value: n }] } : null;
  }
  if (t === "date" || t === "datetime") {
    const key = raw.trim();
    if (!DATE_KEY.test(key) || vnDateKey(vnStartOfDay(key)) !== key) return null;
    // Ngày trên field NGÀY là chuỗi ngày VN; trên field NGÀY GIỜ là mốc đầu / cuối ngày VN (không trôi múi giờ).
    const start = t === "date" ? key : vnStartOfDay(key).toISOString();
    const end = t === "date" ? key : vnEndOfDay(key).toISOString();
    if (op === "gte") return { shown: key, filters: [{ ref, op, value: start }] };
    if (op === "lte") return { shown: key, filters: [{ ref, op, value: end }] };
    if (op === "eq") return { shown: key, filters: t === "date" ? [{ ref, op, value: key }] : [{ ref, op: "gte", value: start }, { ref, op: "lte", value: end }] };
    return null;
  }
  if (t === "boolean") return raw === "true" || raw === "false" ? { shown: raw, filters: [{ ref, op, value: raw === "true" }] } : null;
  if (options) {
    const allowed = new Set(options.map((o) => o.value));
    if (op === "in") {
      const picked = [...new Set(raw.split(",").map((x) => x.trim()).filter((x) => allowed.has(x)))];
      return picked.length ? { shown: picked, filters: [{ ref, op, value: picked }] } : null;
    }
    return allowed.has(raw) ? { shown: raw, filters: [{ ref, op, value: raw }] } : null;
  }
  const text = raw.trim().slice(0, FILTER_TEXT_MAX);
  return text ? { shown: text, filters: [{ ref, op, value: text }] } : null;
}

type FilterOutcome = { data: FilterData; applied: Map<string, ListFilter[]> };

/**
 * Dựng thanh lọc cho NGƯỜI XEM + bộ lọc áp lên từng khối đích. `targetObjects` (id khối → đối tượng nó đọc) do
 * `resolvePage` truyền; xem trước một khối lẻ không có ⇒ không áp lên khối nào. Ô trên nguồn / field người xem
 * không dùng được bị BỎ (kèm lý do) — không làm hỏng cả thanh lọc.
 */
async function resolveFilter(block: PageBlock<"filter">, user: SessionUser, ctx: PageRenderContext, targetObjects: ReadonlyMap<string, string | null> | null): Promise<FilterOutcome> {
  const cfg = block.config as FilterConfig;
  const fields = Array.isArray(cfg?.fields) ? cfg.fields.slice(0, FILTER_MAX_FIELDS) : stop("INVALID_CONFIG", "Bộ lọc thiếu danh sách ô.");
  const targets = Array.isArray(cfg.targets) ? cfg.targets.filter((t): t is string => typeof t === "string") : [];
  const applied = new Map<string, ListFilter[]>();
  const out: FilterFieldData[] = [];
  const dropped: FilterData["dropped"] = [];
  const objects = new Map<string, Promise<ObjectFields | string>>();
  const load = (objectKey: string) => {
    if (!objects.has(objectKey)) {
      objects.set(
        objectKey,
        (async () => {
          const src = listSource(objectKey);
          const def = src ? objectDef(src.objectKey) : null;
          if (!src || !def) return "nguồn không có trong sổ danh sách";
          const g = await gateSource(user, { module: src.module, permission: src.permission, label: src.label }, OBJECT_SCOPE_RESOURCE[def.key] ?? null);
          if (!g.ok) return g.message;
          return objectFields(def, user);
        })(),
      );
    }
    return objects.get(objectKey)!;
  };
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    const label = typeof f?.label === "string" && f.label.trim() ? f.label.trim() : null;
    const of = await load(String(f?.objectKey ?? ""));
    if (typeof of === "string") {
      dropped.push({ label: label ?? `Ô lọc ${i + 1}`, reason: of });
      continue;
    }
    const r = resolveRef(of, f.ref);
    if (!r) {
      dropped.push({ label: label ?? `Ô lọc ${i + 1}`, reason: "field không tồn tại" });
      continue;
    }
    // Field không được xem: không hiện cả nhãn của nó — sự có mặt của ô lọc đã nói ra field ấy.
    if (r.kind === "custom" && !r.viewable) {
      dropped.push({ label: `Ô lọc ${i + 1}`, reason: "bạn không được xem field này" });
      continue;
    }
    if (!r.field.filterable) {
      dropped.push({ label: label ?? r.field.label, reason: "field không bật lọc" });
      continue;
    }
    if (!filterOpFits(r.field.type, f.op)) {
      dropped.push({ label: label ?? r.field.label, reason: `phép «${String(f.op)}» không dùng được với field này` });
      continue;
    }
    const param = filterParamName(block.id, i);
    const options = await filterOptions(of, r);
    const parsed = parseFilterValue(r, f.op, ctx.searchParams[param], options);
    out.push({
      param,
      label: label ?? r.field.label,
      op: f.op,
      input: filterInput(r.field.type, f.op),
      ...(options ? { options } : {}),
      ...(f.op === "in" ? { multiple: true } : {}),
      value: parsed ? parsed.shown : null,
    });
    if (!parsed || !targetObjects) continue;
    for (const t of targets) {
      if (t === block.id || targetObjects.get(t) !== of.def.key) continue;
      applied.set(t, [...(applied.get(t) ?? []), ...parsed.filters]);
    }
  }
  return { data: { period: cfg.period === true, periodValue: ctx.period, fields: out, dropped, pageParams: targets.map((t) => `${t}_page`) }, applied };
}

// ─────────────────────────── Cột (Phase 5) ───────────────────────────

/** Khối con của cột phân giải SONG SONG; mỗi con một kết quả — con hỏng thành chỗ giữ riêng. */
async function resolveColumn(block: PageBlock<"column">, user: SessionUser, ctx: PageRenderContext, allowed: ReadonlySet<PageBlock> | null): Promise<BlockDataByType["column"]> {
  const kids = Array.isArray(block.children) ? block.children : [];
  const children = await Promise.all(
    kids.map(async (child, i): Promise<ResolvedBlock> => {
      const id = typeof child?.id === "string" ? child.id : `${block.id}_${i}`;
      if (i >= COLUMN_MAX_CHILDREN) return { ok: false, block: child, issue: { blockId: id, code: "INVALID_CONFIG", message: `Cột chứa tối đa ${COLUMN_MAX_CHILDREN} khối con.` } };
      if (child?.type === "column" || child?.type === "filter") return { ok: false, block: child, issue: { blockId: id, code: "INVALID_CONFIG", message: "Cột chỉ lồng một tầng; bộ lọc không đặt trong cột." } };
      if (allowed && !allowed.has(child)) return { ok: false, block: child, issue: { blockId: id, code: "INVALID_CONFIG", message: `Trang vượt trần ${PAGE_MAX_BLOCKS} khối.` } };
      const r = await guarded(child, () => resolveData(child, user, ctx, allowed));
      return r.ok ? { ok: true, block: child, data: r.data as BlockDataByType[BlockType] } : { ok: false, block: child, issue: r.issue };
    }),
  );
  return { children };
}

// ─────────────────────────── Cửa vào ───────────────────────────

/** Chạy MỘT khối trong rào lỗi: dừng có chủ ý ⇒ mã của nó; lỗi bất ngờ ⇒ `DATA_ERROR` câu chung; luôn đo thời gian. */
async function guarded<T>(block: PageBlock | null | undefined, run: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; issue: BlockIssue }> {
  const blockId = typeof block?.id === "string" ? block.id : "";
  const started = performance.now();
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (error instanceof BlockStop) return { ok: false, issue: { blockId, code: error.code, message: error.message } };
    // Lỗi bất ngờ: một câu chung cho người xem; chi tiết chỉ ở log máy chủ.
    console.error(`[page-block] ${blockId} (${String(block?.type)}) lỗi:`, error instanceof Error ? error.message : String(error));
    return { ok: false, issue: { blockId, code: "DATA_ERROR", message: "Không đọc được dữ liệu của khối này." } };
  } finally {
    recordPerf(`pageblock:${String(block?.type)}`, performance.now() - started, false);
  }
}

async function resolveData(block: PageBlock, user: SessionUser, ctx: PageRenderContext, allowed: ReadonlySet<PageBlock> | null): Promise<unknown> {
  switch (block?.type as BlockType) {
    case "kpi":
      return resolveKpi(block as PageBlock<"kpi">, user, ctx);
    case "chart":
      return resolveChart(block as PageBlock<"chart">, user, ctx);
    case "table":
      return resolveTable(block as PageBlock<"table">, user, ctx);
    case "kanban":
      return resolveKanban(block as PageBlock<"kanban">, user, ctx);
    case "timeline":
      return resolveTimeline(block as PageBlock<"timeline">, user, ctx);
    case "form":
      return resolveForm(block as PageBlock<"form">, user, ctx);
    case "button":
      return resolveButton(block as PageBlock<"button">, user);
    case "text":
      return resolveText(block as PageBlock<"text">);
    case "filter":
      return (await resolveFilter(block as PageBlock<"filter">, user, ctx, null)).data;
    case "column":
      return resolveColumn(block as PageBlock<"column">, user, ctx, allowed);
    default:
      return stop("INVALID_CONFIG", `Loại khối "${String(block?.type)}" không có trong sổ.`);
  }
}

/**
 * MỘT khối (xem trước khối lẻ, và bên trong `resolvePage`). Bộ lọc của thanh lọc chỉ có khi `ctx.blockFilters` do
 * `resolvePage` dựng; khối `filter` gọi lẻ trả thanh lọc nhưng không áp lên khối nào.
 */
export async function resolveBlock<T extends BlockType>(block: PageBlock<T>, user: SessionUser, ctx: PageRenderContext): Promise<BlockResult<T>> {
  const r = await guarded(block, () => resolveData(block as PageBlock, user, ctx, null));
  return r.ok ? { ok: true, data: r.data as BlockDataByType[T] } : r;
}

export type ResolvedPage = { sections: { key: string; title?: string; variant?: PageSchema["sections"][number]["variant"]; blocks: ResolvedBlock[] }[] };

/**
 * Dựng MỌI khối SONG SONG (G10) — tổng thời gian bằng khối chậm nhất, không phải tổng các khối. Trần 20 khối ĐẾM
 * CẢ khối con của cột, theo thứ tự hiển thị (`flattenBlocks`) — khối vượt trần hiện lỗi cấu hình, không chạy truy
 * vấn. Hai lượt: (1) thanh lọc (chỉ đọc định nghĩa field) dựng bộ lọc cho từng khối đích; (2) mọi khối còn lại song
 * song với bộ lọc đó. Ghi thời gian dựng vào `page:<slug>`.
 */
export async function resolvePage(schemaIn: PageSchema, user: SessionUser, ctx: PageRenderContext, slug = "unknown"): Promise<ResolvedPage> {
  const started = performance.now();
  const sections = Array.isArray(schemaIn?.sections) ? schemaIn.sections : [];
  const flat = flattenBlocks(schemaIn);
  const allowed: ReadonlySet<PageBlock> = new Set(flat.slice(0, PAGE_MAX_BLOCKS).map((f) => f.block));
  const overCap = (block: PageBlock): ResolvedBlock => ({ ok: false, block, issue: { blockId: block.id, code: "INVALID_CONFIG", message: `Trang vượt trần ${PAGE_MAX_BLOCKS} khối.` } });

  // Lượt 1 — thanh lọc: khối đích → đối tượng nó đọc (chỉ khối nhận bộ lọc).
  const targetObjects = new Map<string, string | null>();
  for (const f of flat) if (f.block && typeof f.block.id === "string") targetObjects.set(f.block.id, filterTargetObject(f.block.type, f.block.config));
  const filterBlocks = flat.filter((f) => f.parentId === null && f.block?.type === "filter" && allowed.has(f.block)).map((f) => f.block as PageBlock<"filter">);
  const blockFilters: Record<string, ListFilter[]> = {};
  const filterResults = new Map<PageBlock, ResolvedBlock>();
  await Promise.all(
    filterBlocks.map(async (block) => {
      let applied = new Map<string, ListFilter[]>();
      const r = await guarded(block, async () => {
        const o = await resolveFilter(block, user, ctx, targetObjects);
        applied = o.applied;
        return o.data;
      });
      for (const [t, list] of applied) blockFilters[t] = [...(blockFilters[t] ?? []), ...list];
      filterResults.set(block, r.ok ? { ok: true, block, data: r.data } : { ok: false, block, issue: r.issue });
    }),
  );
  const ctx2: PageRenderContext = { ...ctx, blockFilters };

  // Lượt 2 — mọi khối còn lại, song song.
  const resolved = await Promise.all(
    sections.map((s) =>
      Promise.all(
        (Array.isArray(s?.blocks) ? s.blocks : []).map(async (block): Promise<ResolvedBlock> => {
          if (!allowed.has(block)) return overCap(block);
          const pre = filterResults.get(block);
          if (pre) return pre;
          const r = await guarded(block, () => resolveData(block, user, ctx2, allowed));
          return r.ok ? { ok: true, block, data: r.data as BlockDataByType[BlockType] } : { ok: false, block, issue: r.issue };
        }),
      ),
    ),
  );
  recordPerf(`page:${slug}`, performance.now() - started, false);
  return { sections: sections.map((s, i) => ({ key: s.key, ...(s.title ? { title: s.title } : {}), ...(s.variant ? { variant: s.variant } : {}), blocks: resolved[i] })) };
}

// ─────────────────────────── Cho trình soạn ───────────────────────────

/** Nguồn + action NGƯỜI NÀY dùng được (module + quyền) — chỉ để trình soạn gợi ý; trình phân giải vẫn kiểm lại. */
export function listDataSources(user: SessionUser): { metrics: MetricSourceSpec[]; series: SeriesSourceSpec[]; lists: ListSourceSpec[]; timelines: TimelineSourceSpec[]; actions: PageActionSpec[] } {
  const ok = (m: string | null, p: string | null) => (!m || !user.modules || user.modules.includes(m)) && (!p || can(user, p as Permission));
  return {
    metrics: METRIC_SOURCES.filter((s) => ok(s.module, s.permission)),
    series: SERIES_SOURCES.filter((s) => ok(s.module, s.permission)),
    lists: LIST_SOURCES.filter((s) => ok(s.module, s.permission)),
    timelines: TIMELINE_SOURCES.filter((s) => ok(s.module, s.permission)),
    actions: PAGE_ACTIONS.filter((a) => ok(a.module, a.permission)),
  };
}
