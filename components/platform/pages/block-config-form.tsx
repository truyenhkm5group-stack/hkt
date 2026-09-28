"use client";

import { Plus, X } from "lucide-react";
import { MoveButtons, SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FIELD_TYPE_LABEL, type FieldRef, type ListFilter, type ListFilterOp } from "@/lib/metadata/types";
import { FILTER_OP_LABEL, filterOpsFor, moveItem, type CatalogField } from "@/lib/platform-ui/metadata-admin-shared";
import {
  AGGREGATE_FN_LABEL,
  aggregatableFields,
  CHART_KIND_LABEL,
  configOf,
  dateFields,
  defaultColumns,
  filterBarOps,
  FORM_MODE_LABEL,
  formObjects,
  groupableFields,
  kanbanObjects,
  objectOf,
  rowActionOptions,
  statusFieldsOf,
  TEXT_VARIANT_LABEL,
  TIME_BUCKET_LABEL,
  type FilterTargetOption,
  type PageEditorCatalog,
} from "@/lib/platform-ui/page-admin-shared";
import {
  AGGREGATE_FNS,
  FILTER_MAX_FIELDS,
  isAggregateChart,
  isAggregateKpi,
  TABLE_MAX_ROW_ACTIONS,
  TEXT_VARIANTS,
  TIME_BUCKETS,
  type AggregateChartConfig,
  type AggregateKpiConfig,
  type AggregateSpec,
  type BlockConfigByType,
  type BlockType,
  type ChartGroupBy,
  type FilterFieldConfig,
  type FormConfig,
  type MetricKpiConfig,
  type PageBlock,
  type SeriesChartConfig,
  type TableRowAction,
  type TextVariant,
  type TimeBucket,
} from "@/lib/pages/types";
import type { PeriodKey } from "@/lib/search-params";

/**
 * ═══════════ FORM CẤU HÌNH THEO LOẠI KHỐI ═══════════
 *
 * Mọi lựa chọn là Ô CHỌN trên sổ đóng (nguồn số liệu, chuỗi, đối tượng, field, action) — không ô gõ SQL, biểu
 * thức hay mã. Sổ tới qua props (máy chủ đã lọc theo module đang bật); nguồn đã chọn mà không còn trong sổ vẫn
 * hiện ra kèm "(không có trong sổ)" để người soạn thấy và đổi, không bị âm thầm đổi hộ.
 */

/**
 * `part` — trình kéo-thả (Phase 5) chia MỘT form này theo tab của khung thuộc tính: «data» = nguồn, cột, lọc, sắp
 * xếp, tổng hợp, nhóm theo, kỳ, nội dung, bộ lọc; «actions» = thao tác của nút + hành động theo dòng của bảng.
 * Trình soạn bàn phím (Phase 4) không truyền ⇒ «all». Không có form thứ hai cho trình kéo-thả.
 *
 * `filterTargets`: các khối trên CÙNG trang nhận được bộ lọc (bảng · kanban · KPI / biểu đồ tổng hợp) — khối bộ lọc
 * chọn đích trong đó. Trình soạn không truyền ⇒ bộ lọc chỉ sửa được ô lọc.
 */
export type BlockConfigPart = "all" | "data" | "actions";

type Props = {
  block: PageBlock;
  catalog: PageEditorCatalog;
  onChange: (config: BlockConfigByType[BlockType]) => void;
  disabled?: boolean;
  part?: BlockConfigPart;
  filterTargets?: FilterTargetOption[];
};

const LABEL = "grid gap-1 text-xs font-medium text-muted-foreground";
const NO_VALUE_OPS: readonly ListFilterOp[] = ["empty", "not_empty"];

export function BlockConfigForm({ block, catalog, onChange, disabled, part = "all", filterTargets }: Props) {
  const data = part !== "actions";
  const actions = part !== "data";
  switch (block.type) {
    case "kpi":
      return data ? <KpiForm config={configOf(block, "kpi")!} catalog={catalog} onChange={onChange} disabled={disabled} /> : null;
    case "table": {
      const config = configOf(block, "table")!;
      return (
        <div className="space-y-3">
          {data ? <TableForm config={config} catalog={catalog} onChange={onChange} disabled={disabled} /> : null}
          {actions ? <RowActionsForm config={config} catalog={catalog} onChange={onChange} disabled={disabled} /> : null}
        </div>
      );
    }
    case "chart":
      return data ? <ChartForm config={configOf(block, "chart")!} catalog={catalog} onChange={onChange} disabled={disabled} /> : null;
    case "kanban":
      return data ? <KanbanForm config={configOf(block, "kanban")!} catalog={catalog} onChange={onChange} disabled={disabled} /> : null;
    case "timeline":
      return data ? <TimelineForm config={configOf(block, "timeline")!} catalog={catalog} onChange={onChange} disabled={disabled} /> : null;
    case "form":
      return data ? <FormBlockForm config={configOf(block, "form")!} catalog={catalog} onChange={onChange} disabled={disabled} /> : null;
    case "button":
      return actions ? <ButtonForm config={configOf(block, "button")!} catalog={catalog} onChange={onChange} disabled={disabled} /> : null;
    case "filter":
      return data ? <FilterForm config={configOf(block, "filter")!} catalog={catalog} onChange={onChange} disabled={disabled} targets={filterTargets} blockId={block.id} /> : null;
    case "column":
      return data ? <p className="text-xs text-muted-foreground">Cột không có cấu hình riêng — kéo tối đa 6 khối vào để xếp dọc; độ rộng đặt ở tab Hiển thị.</p> : null;
    default:
      return data ? <TextForm config={configOf(block, "text")!} onChange={onChange} disabled={disabled} /> : null;
  }
}

type FormProps<T extends BlockType> = { config: BlockConfigByType[T]; catalog: PageEditorCatalog; onChange: (c: BlockConfigByType[T]) => void; disabled?: boolean };

/** Ô chọn trên một sổ: giá trị đã lưu mà không còn trong sổ vẫn hiện (đánh dấu), không bị đổi hộ. */
function RegistrySelect({ value, items, onChange, disabled, label, empty }: { value: string; items: { value: string; label: string }[]; onChange: (v: string) => void; disabled?: boolean; label: string; empty: string }) {
  const known = items.some((i) => i.value === value);
  return (
    <select className={SELECT_CLASS} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {value === "" ? <option value="">— {empty} —</option> : null}
      {value !== "" && !known ? <option value={value}>{value} (không có trong sổ)</option> : null}
      {items.map((i) => (
        <option key={i.value} value={i.value}>
          {i.label}
        </option>
      ))}
    </select>
  );
}

function PeriodSelect({ value, allowed, catalog, onChange, disabled }: { value: PeriodKey | undefined; allowed: readonly PeriodKey[] | null; catalog: PageEditorCatalog; onChange: (v: PeriodKey | undefined) => void; disabled?: boolean }) {
  const options = catalog.periods.filter((p) => !allowed || allowed.includes(p.value));
  return (
    <select className={SELECT_CLASS} aria-label="Kỳ" value={value ?? ""} disabled={disabled} onChange={(e) => onChange((e.target.value || undefined) as PeriodKey | undefined)}>
      <option value="">Theo kỳ đang chọn trên trang</option>
      {value && !options.some((p) => p.value === value) ? <option value={value}>{value} (nguồn không hỗ trợ)</option> : null}
      {options.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

function Why({ text }: { text: string | undefined }) {
  return text ? <p className="basis-full text-[11.5px] text-muted-foreground">{text}</p> : null;
}

// ─────────── KPI ───────────

function KpiForm({ config, catalog, onChange, disabled }: FormProps<"kpi">) {
  const aggregate = isAggregateKpi(config);
  const firstList = catalog.lists[0]?.objectKey ?? "";
  return (
    <div className="space-y-2">
      <SourceModeToggle
        aggregate={aggregate}
        disabled={disabled}
        onChange={(agg) => onChange(agg ? { aggregate: { objectKey: firstList, fn: "count" }, ...(config.label ? { label: config.label } : {}) } : { metric: catalog.metrics[0]?.key ?? "", ...(config.label ? { label: config.label } : {}) })}
      />
      {isAggregateKpi(config) ? <AggregateKpiForm config={config} catalog={catalog} onChange={onChange} disabled={disabled} /> : <MetricKpiForm config={config} catalog={catalog} onChange={onChange} disabled={disabled} />}
    </div>
  );
}

/** Nguồn của KPI / biểu đồ: SỔ (một công thức có sẵn — doanh thu, tỷ lệ hoàn…) hay TỔNG HỢP theo field của một đối tượng. */
function SourceModeToggle({ aggregate, onChange, disabled }: { aggregate: boolean; onChange: (aggregate: boolean) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-full bg-muted p-0.5 text-xs" role="radiogroup" aria-label="Nguồn số liệu">
      {[
        { v: false, label: "Từ sổ chỉ số" },
        { v: true, label: "Tổng hợp theo field" },
      ].map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={aggregate === o.v}
          disabled={disabled}
          className={aggregate === o.v ? "rounded-full bg-background px-2.5 py-1 font-medium shadow-sm" : "rounded-full px-2.5 py-1 text-muted-foreground"}
          onClick={() => aggregate !== o.v && onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MetricKpiForm({ config, catalog, onChange, disabled }: { config: MetricKpiConfig; catalog: PageEditorCatalog; onChange: (c: BlockConfigByType["kpi"]) => void; disabled?: boolean }) {
  const spec = catalog.metrics.find((m) => m.key === config.metric);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={LABEL}>
        Nguồn số liệu
        <RegistrySelect label="Nguồn số liệu" empty="chọn chỉ số" value={config.metric} items={catalog.metrics.map((m) => ({ value: m.key, label: m.label }))} disabled={disabled} onChange={(metric) => onChange({ ...config, metric, period: undefined })} />
      </label>
      <label className={LABEL}>
        Kỳ
        <PeriodSelect value={config.period} allowed={spec?.periods ?? null} catalog={catalog} disabled={disabled} onChange={(period) => onChange({ ...config, period })} />
      </label>
      <label className={LABEL}>
        Nhãn (tuỳ chọn)
        <Input className="h-8 w-48" value={config.label ?? ""} placeholder={spec?.label ?? ""} maxLength={60} disabled={disabled} onChange={(e) => onChange({ ...config, label: e.target.value || undefined })} />
      </label>
      <Why text={spec?.why} />
    </div>
  );
}

function AggregateKpiForm({ config, catalog, onChange, disabled }: { config: AggregateKpiConfig; catalog: PageEditorCatalog; onChange: (c: BlockConfigByType["kpi"]) => void; disabled?: boolean }) {
  const object = objectOf(catalog, config.aggregate.objectKey);
  const dates = dateFields(object);
  return (
    <div className="space-y-2">
      <AggregateEditor
        spec={config.aggregate}
        catalog={catalog}
        disabled={disabled}
        onChange={(aggregate) => onChange({ ...config, aggregate, ...(aggregate.objectKey !== config.aggregate.objectKey ? { dateField: undefined, period: undefined } : {}) })}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Mốc thời gian (field ngày)
          <select
            className={SELECT_CLASS}
            aria-label="Field ngày của kỳ"
            value={config.dateField ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...config, dateField: (e.target.value || undefined) as FieldRef | undefined, ...(e.target.value ? {} : { period: undefined }) })}
          >
            <option value="">Không lọc theo kỳ (mọi bản ghi)</option>
            {dates.map((f) => (
              <option key={f.ref} value={f.ref}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL} title={config.dateField ? undefined : "Kỳ chỉ áp khi chọn field ngày — không có mốc thì không biết bản ghi nào thuộc kỳ."}>
          Kỳ
          <PeriodSelect value={config.period} allowed={null} catalog={catalog} disabled={disabled || !config.dateField} onChange={(period) => onChange({ ...config, period })} />
        </label>
        <label className={LABEL}>
          Nhãn (tuỳ chọn)
          <Input className="h-8 w-48" value={config.label ?? ""} maxLength={60} disabled={disabled} onChange={(e) => onChange({ ...config, label: e.target.value || undefined })} />
        </label>
      </div>
      {!config.dateField ? <p className="text-[11.5px] text-muted-foreground">Kỳ chỉ áp khi chọn field ngày — không có mốc thì KPI đếm mọi bản ghi, bộ chọn kỳ của trang không đổi được nó.</p> : null}
    </div>
  );
}

/**
 * Phép tổng hợp trên MỘT đối tượng: đối tượng · phép (đếm / tổng / trung bình / nhỏ nhất / lớn nhất) · field số ·
 * lọc cố định. Field số chỉ gồm field khai tổng hợp được — tiền của đơn / vận đơn / hàng hoàn KHÔNG có ở đây (một
 * công thức doanh thu duy nhất qua sổ chỉ số).
 */
function AggregateEditor({ spec, catalog, onChange, disabled }: { spec: AggregateSpec; catalog: PageEditorCatalog; onChange: (s: AggregateSpec) => void; disabled?: boolean }) {
  const object = objectOf(catalog, spec.objectKey);
  const numeric = aggregatableFields(object);
  const filterable = (object?.catalog ?? []).filter((c) => c.filterable);
  const needsField = spec.fn !== "count";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Đối tượng
          <RegistrySelect label="Đối tượng tổng hợp" empty="chọn đối tượng" value={spec.objectKey} items={catalog.lists.map((l) => ({ value: l.objectKey, label: l.label }))} disabled={disabled} onChange={(objectKey) => onChange({ objectKey, fn: "count" })} />
        </label>
        <label className={LABEL}>
          Phép tính
          <select
            className={SELECT_CLASS}
            aria-label="Phép tổng hợp"
            value={spec.fn}
            disabled={disabled}
            onChange={(e) => {
              const fn = e.target.value as AggregateSpec["fn"];
              const keep = fn === "count" || numeric.some((f) => f.ref === spec.field);
              onChange({ ...spec, fn, field: keep ? spec.field : numeric[0]?.ref });
            }}
          >
            {AGGREGATE_FNS.map((fn) => (
              <option key={fn} value={fn} disabled={fn !== "count" && numeric.length === 0}>
                {AGGREGATE_FN_LABEL[fn]}
                {fn !== "count" && numeric.length === 0 ? " (không có field số tổng hợp được)" : ""}
              </option>
            ))}
          </select>
        </label>
        {needsField ? (
          <label className={LABEL}>
            Field số
            <RegistrySelect label="Field số" empty="chọn field" value={spec.field ?? ""} items={numeric.map((f) => ({ value: f.ref, label: f.label }))} disabled={disabled} onChange={(v) => onChange({ ...spec, field: (v || undefined) as FieldRef | undefined })} />
          </label>
        ) : null}
      </div>
      {object && numeric.length === 0 ? <p className="text-[11.5px] text-muted-foreground">{object.label} không có field số tổng hợp được — chỉ đếm bản ghi. Tiền của đơn / vận đơn / hàng hoàn chỉ đọc qua sổ chỉ số.</p> : null}
      {object ? (
        <details className="rounded-lg border border-hairline p-2">
          <summary className="cursor-pointer text-xs font-semibold">Lọc cố định ({spec.filters?.length ?? 0})</summary>
          <div className="mt-2">
            <FilterRows filters={spec.filters ?? []} fields={filterable} disabled={disabled} onChange={(filters) => onChange({ ...spec, filters: filters.length ? filters : undefined })} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ─────────── BẢNG ───────────

function TableForm({ config, catalog, onChange, disabled }: FormProps<"table">) {
  const object = objectOf(catalog, config.source);
  const fields = object?.catalog ?? [];
  const byRef = new Map(fields.map((c) => [c.ref, c]));
  const columns = config.columns ?? [];
  const listable = fields.filter((c) => c.listable);
  const remaining = listable.filter((c) => !columns.includes(c.ref));
  const filterable = fields.filter((c) => c.filterable);
  const spec = catalog.lists.find((l) => l.objectKey === config.source);
  const setColumns = (next: FieldRef[]) => onChange({ ...config, columns: next });

  return (
    <div className="@container space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Đối tượng
          <RegistrySelect
            label="Đối tượng của bảng"
            empty="chọn đối tượng"
            value={config.source}
            items={catalog.lists.map((l) => ({ value: l.objectKey, label: l.label }))}
            disabled={disabled}
            onChange={(source) => onChange({ source, columns: defaultColumns(objectOf(catalog, source)), filters: [], sort: null, pageSize: config.pageSize ?? 20, rowLink: config.rowLink ?? true })}
          />
        </label>
        <label className={LABEL}>
          Dòng mỗi trang
          <Input className="h-8 w-20" type="number" min={1} max={100} value={config.pageSize ?? 20} disabled={disabled} onChange={(e) => onChange({ ...config, pageSize: Math.max(1, Math.min(100, Number(e.target.value) || 20)) })} />
        </label>
        <label className={LABEL}>
          Sắp xếp theo
          <select
            className={SELECT_CLASS}
            value={config.sort?.ref ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...config, sort: e.target.value ? { ref: e.target.value as FieldRef, dir: config.sort?.dir ?? "desc" } : null })}
          >
            <option value="">Mặc định của nguồn</option>
            {listable.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {config.sort ? (
          <label className={LABEL}>
            Chiều
            <select className={SELECT_CLASS} value={config.sort.dir} disabled={disabled} onChange={(e) => config.sort && onChange({ ...config, sort: { ...config.sort, dir: e.target.value === "asc" ? "asc" : "desc" } })}>
              <option value="desc">Giảm dần</option>
              <option value="asc">Tăng dần</option>
            </select>
          </label>
        ) : null}
        <label className="inline-flex items-center gap-2 self-center text-sm">
          <Tick checked={config.rowLink ?? true} disabled={disabled} label="Bấm dòng mở bản ghi" onChange={(v) => onChange({ ...config, rowLink: v })} />
          Bấm dòng mở bản ghi
        </label>
        <Why text={spec?.why} />
      </div>

      <div className="grid gap-3 @2xl:grid-cols-2">
        <div className="rounded-lg border border-hairline p-2">
          <div className="mb-1 text-xs font-semibold">Cột ({columns.length})</div>
          {columns.length === 0 ? <p className="text-xs text-muted-foreground">Chưa có cột nào.</p> : null}
          <ul className="space-y-0.5">
            {columns.map((ref, i) => (
              <li key={ref} className="flex items-center gap-1.5 text-sm">
                <MoveButtons index={i} count={columns.length} label={byRef.get(ref)?.label ?? ref} disabled={disabled} onMove={(d) => setColumns(moveItem(columns, i, d))} />
                <span className="min-w-0 flex-1 truncate">{byRef.get(ref)?.label ?? `${ref} (không còn)`}</span>
                <span className="text-[11px] text-muted-foreground">{byRef.get(ref)?.system === false ? "tuỳ biến" : "hệ thống"}</span>
                <Button variant="ghost" size="icon-xs" aria-label="Bỏ cột" disabled={disabled} onClick={() => setColumns(columns.filter((x) => x !== ref))}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          {remaining.length ? (
            <select className={`${SELECT_CLASS} mt-1`} value="" aria-label="Thêm cột" disabled={disabled} onChange={(e) => e.target.value && setColumns([...columns, e.target.value as FieldRef])}>
              <option value="">+ Thêm cột ({remaining.length} còn lại)</option>
              {remaining.map((c) => (
                <option key={c.ref} value={c.ref}>
                  {c.label} · {c.system ? "hệ thống" : "tuỳ biến"}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="rounded-lg border border-hairline p-2">
          <div className="mb-1 text-xs font-semibold">Bộ lọc cố định</div>
          <FilterRows filters={config.filters ?? []} fields={filterable} disabled={disabled} onChange={(filters) => onChange({ ...config, filters })} />
        </div>
      </div>
    </div>
  );
}

/** Bộ lọc: chỉ field `filterable`, phép so hợp kiểu (cùng luật với trình soạn danh sách Phase 2). */
function FilterRows({ filters, fields, onChange, disabled }: { filters: ListFilter[]; fields: CatalogField[]; onChange: (f: ListFilter[]) => void; disabled?: boolean }) {
  const byRef = new Map(fields.map((c) => [c.ref, c]));
  if (fields.length === 0) return <p className="text-xs text-muted-foreground">Không có field nào lọc được — bật «Lọc được» ở Mô hình dữ liệu.</p>;
  const set = (i: number, patch: Partial<ListFilter>) => onChange(filters.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-1.5">
      {filters.length === 0 ? <p className="text-xs text-muted-foreground">Không lọc — bảng hiện mọi bản ghi người xem được phép thấy.</p> : null}
      {filters.map((flt, i) => {
        const c = byRef.get(flt.ref);
        const ops = c ? filterOpsFor(c.type) : (Object.keys(FILTER_OP_LABEL) as ListFilterOp[]);
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              className={SELECT_CLASS}
              aria-label="Field lọc"
              value={flt.ref}
              disabled={disabled}
              onChange={(e) => {
                const ref = e.target.value as FieldRef;
                const nc = byRef.get(ref);
                onChange(filters.map((x, j) => (j === i ? { ref, op: nc ? filterOpsFor(nc.type)[0] : "eq" } : x)));
              }}
            >
              {c ? null : <option value={flt.ref}>{flt.ref} (không lọc được)</option>}
              {fields.map((f) => (
                <option key={f.ref} value={f.ref}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              className={SELECT_CLASS}
              aria-label="Phép so"
              value={flt.op}
              disabled={disabled}
              onChange={(e) => {
                const op = e.target.value as ListFilterOp;
                const reset = NO_VALUE_OPS.includes(op) || (op === "in") !== (flt.op === "in");
                set(i, { op, ...(reset ? { value: undefined } : {}) });
              }}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {FILTER_OP_LABEL[op]}
                </option>
              ))}
            </select>
            {NO_VALUE_OPS.includes(flt.op) ? null : flt.op === "in" ? (
              <Input
                className="h-8 w-44"
                aria-label="Các giá trị, cách nhau bằng dấu phẩy"
                placeholder={c?.options.length ? c.options.map((o) => o.value).join(", ") : "a, b, c"}
                value={Array.isArray(flt.value) ? flt.value.map(String).join(", ") : ""}
                disabled={disabled}
                onChange={(e) => {
                  const list = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                  set(i, { value: list.length ? list : undefined });
                }}
              />
            ) : c && c.options.length ? (
              <select className={SELECT_CLASS} aria-label="Giá trị lọc" value={typeof flt.value === "string" ? flt.value : ""} disabled={disabled} onChange={(e) => set(i, { value: e.target.value || undefined })}>
                <option value="">— chọn —</option>
                {c.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input className="h-8 w-40" aria-label="Giá trị lọc" placeholder={c ? FIELD_TYPE_LABEL[c.type] : ""} value={flt.value === undefined || flt.value === null ? "" : String(flt.value)} disabled={disabled} onChange={(e) => set(i, { value: e.target.value === "" ? undefined : e.target.value })} />
            )}
            <Button variant="ghost" size="icon-xs" aria-label="Bỏ bộ lọc" disabled={disabled} onClick={() => onChange(filters.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
        );
      })}
      <Button variant="outline" size="xs" disabled={disabled} onClick={() => onChange([...filters, { ref: fields[0].ref, op: filterOpsFor(fields[0].type)[0] }])}>
        <Plus /> Thêm bộ lọc
      </Button>
    </div>
  );
}

// ─────────── BIỂU ĐỒ ───────────

function ChartForm({ config, catalog, onChange, disabled }: FormProps<"chart">) {
  const aggregate = isAggregateChart(config);
  const firstList = catalog.lists[0]?.objectKey ?? "";
  return (
    <div className="space-y-2">
      <SourceModeToggle
        aggregate={aggregate}
        disabled={disabled}
        onChange={(agg) => {
          if (!agg) {
            const s0 = catalog.series[0];
            onChange({ series: s0?.key ?? "", kind: s0?.kinds[0] ?? "bar" });
            return;
          }
          const o = objectOf(catalog, firstList);
          const g = groupableFields(o)[0];
          const d = dateFields(o)[0];
          onChange({ aggregate: { objectKey: firstList, fn: "count" }, kind: "bar", groupBy: g ? { ref: g.ref } : { bucket: "day", dateField: d?.ref ?? ("" as FieldRef) } });
        }}
      />
      {isAggregateChart(config) ? <AggregateChartForm config={config} catalog={catalog} onChange={onChange} disabled={disabled} /> : <SeriesChartForm config={config} catalog={catalog} onChange={onChange} disabled={disabled} />}
    </div>
  );
}

function AggregateChartForm({ config, catalog, onChange, disabled }: { config: AggregateChartConfig; catalog: PageEditorCatalog; onChange: (c: BlockConfigByType["chart"]) => void; disabled?: boolean }) {
  const object = objectOf(catalog, config.aggregate.objectKey);
  const groups = groupableFields(object);
  const dates = dateFields(object);
  const byTime = "bucket" in config.groupBy;
  const setGroup = (groupBy: ChartGroupBy) => {
    const time = "bucket" in groupBy;
    // Tròn chỉ khi nhóm theo field; kỳ chỉ khi nhóm theo thời gian — đổi cách nhóm thì bỏ thứ không còn áp.
    onChange({ ...config, groupBy, kind: time && config.kind === "pie" ? "bar" : config.kind, period: time ? config.period : undefined });
  };
  return (
    <div className="space-y-2">
      <AggregateEditor
        spec={config.aggregate}
        catalog={catalog}
        disabled={disabled}
        onChange={(aggregate) => {
          if (aggregate.objectKey === config.aggregate.objectKey) return onChange({ ...config, aggregate });
          const o = objectOf(catalog, aggregate.objectKey);
          const g = groupableFields(o)[0];
          const d = dateFields(o)[0];
          onChange({ aggregate, kind: "bar", groupBy: g ? { ref: g.ref } : { bucket: "day", dateField: d?.ref ?? ("" as FieldRef) } });
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Nhóm theo
          <select
            className={SELECT_CLASS}
            aria-label="Nhóm theo"
            value={byTime ? `time:${(config.groupBy as { bucket: string }).bucket}` : `field:${(config.groupBy as { ref: string }).ref}`}
            disabled={disabled}
            onChange={(e) => {
              const at = e.target.value.indexOf(":");
              const kind = e.target.value.slice(0, at);
              const v = e.target.value.slice(at + 1);
              if (kind === "time") setGroup({ bucket: v as TimeBucket, dateField: (byTime ? (config.groupBy as { dateField: FieldRef }).dateField : dates[0]?.ref) ?? ("" as FieldRef) });
              else setGroup({ ref: v as FieldRef });
            }}
          >
            {groups.length ? (
              <optgroup label="Theo field">
                {groups.map((f) => (
                  <option key={f.ref} value={`field:${f.ref}`}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {dates.length ? (
              <optgroup label="Theo thời gian">
                {TIME_BUCKETS.map((b) => (
                  <option key={b} value={`time:${b}`}>
                    {TIME_BUCKET_LABEL[b]}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        {byTime ? (
          <label className={LABEL}>
            Field ngày
            <RegistrySelect
              label="Field ngày của trục thời gian"
              empty="chọn field ngày"
              value={(config.groupBy as { dateField: string }).dateField}
              items={dates.map((f) => ({ value: f.ref, label: f.label }))}
              disabled={disabled}
              onChange={(v) => setGroup({ bucket: (config.groupBy as { bucket: TimeBucket }).bucket, dateField: v as FieldRef })}
            />
          </label>
        ) : null}
        <label className={LABEL}>
          Kiểu
          <select className={SELECT_CLASS} aria-label="Kiểu biểu đồ" value={config.kind} disabled={disabled} onChange={(e) => onChange({ ...config, kind: e.target.value as typeof config.kind })}>
            {(["bar", "line", "pie"] as const).map((k) => (
              <option key={k} value={k} disabled={k === "pie" && byTime}>
                {CHART_KIND_LABEL[k]}
                {k === "pie" && byTime ? " (chỉ khi nhóm theo field)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL} title={byTime ? undefined : "Kỳ chỉ áp khi nhóm theo ngày / tuần / tháng."}>
          Kỳ
          <PeriodSelect value={config.period} allowed={null} catalog={catalog} disabled={disabled || !byTime} onChange={(period) => onChange({ ...config, period })} />
        </label>
      </div>
      {!byTime ? <p className="text-[11.5px] text-muted-foreground">Kỳ chỉ áp khi nhóm theo ngày / tuần / tháng — nhóm theo field thì đếm mọi bản ghi.</p> : null}
    </div>
  );
}

function SeriesChartForm({ config, catalog, onChange, disabled }: { config: SeriesChartConfig; catalog: PageEditorCatalog; onChange: (c: BlockConfigByType["chart"]) => void; disabled?: boolean }) {
  const spec = catalog.series.find((s) => s.key === config.series);
  const kinds = spec?.kinds ?? [];
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={LABEL}>
        Chuỗi số liệu
        <RegistrySelect
          label="Chuỗi số liệu"
          empty="chọn chuỗi"
          value={config.series}
          items={catalog.series.map((s) => ({ value: s.key, label: s.label }))}
          disabled={disabled}
          onChange={(series) => {
            const next = catalog.series.find((s) => s.key === series);
            onChange({ series, kind: next && !next.kinds.includes(config.kind) ? (next.kinds[0] ?? config.kind) : config.kind, period: undefined });
          }}
        />
      </label>
      <label className={LABEL}>
        Kiểu
        <select className={SELECT_CLASS} value={config.kind} disabled={disabled || kinds.length === 0} onChange={(e) => onChange({ ...config, kind: e.target.value as typeof config.kind })}>
          {kinds.includes(config.kind) ? null : <option value={config.kind}>{CHART_KIND_LABEL[config.kind]} (nguồn không hỗ trợ)</option>}
          {kinds.map((k) => (
            <option key={k} value={k}>
              {CHART_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Kỳ
        <PeriodSelect value={config.period} allowed={spec?.periods ?? null} catalog={catalog} disabled={disabled} onChange={(period) => onChange({ ...config, period })} />
      </label>
      <Why text={spec?.why} />
    </div>
  );
}

// ─────────── KANBAN ───────────

function KanbanForm({ config, catalog, onChange, disabled }: FormProps<"kanban">) {
  const objects = kanbanObjects(catalog);
  const object = objectOf(catalog, config.objectKey);
  const statuses = statusFieldsOf(object);
  const cardable = (object?.catalog ?? []).filter((c) => c.listable && c.ref !== config.statusField);
  const byRef = new Map((object?.catalog ?? []).map((c) => [c.ref, c]));
  const remaining = cardable.filter((c) => !config.cardFields.includes(c.ref));
  return (
    <div className="space-y-2">
      {objects.length === 0 ? <p className="text-xs text-muted-foreground">Chưa có đối tượng nào có field trạng thái TUỲ BIẾN — tạo field kiểu «Trạng thái» ở Mô hình dữ liệu trước. Kanban không đổi trạng thái hệ thống.</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Đối tượng
          <RegistrySelect
            label="Đối tượng của Kanban"
            empty="chọn đối tượng"
            value={config.objectKey}
            items={objects.map((o) => ({ value: o.key, label: o.label }))}
            disabled={disabled}
            onChange={(objectKey) => onChange({ ...config, objectKey, statusField: statusFieldsOf(objectOf(catalog, objectKey))[0]?.ref ?? "custom:", cardFields: [] })}
          />
        </label>
        <label className={LABEL}>
          Xếp cột theo field
          <select className={SELECT_CLASS} value={config.statusField} disabled={disabled || statuses.length === 0} onChange={(e) => onChange({ ...config, statusField: e.target.value as FieldRef, cardFields: config.cardFields.filter((r) => r !== e.target.value) })}>
            {statuses.some((s) => s.ref === config.statusField) ? null : <option value={config.statusField}>— chọn field trạng thái —</option>}
            {statuses.map((s) => (
              <option key={s.ref} value={s.ref}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Tối đa thẻ
          <Input className="h-8 w-20" type="number" min={1} max={200} value={config.limit ?? 100} disabled={disabled} onChange={(e) => onChange({ ...config, limit: Math.max(1, Math.min(200, Number(e.target.value) || 100)) })} />
        </label>
        <label className="inline-flex items-center gap-2 self-center text-sm">
          <Tick checked={config.allowMove} disabled={disabled} label="Cho đổi cột" onChange={(v) => onChange({ ...config, allowMove: v })} />
          Cho đổi cột (theo luật chuyển của field)
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Field trên thẻ:</span>
        {config.cardFields.map((ref) => (
          <span key={ref} className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[12px]">
            {byRef.get(ref)?.label ?? `${ref} (không còn)`}
            <Button variant="ghost" size="icon-xs" aria-label="Bỏ field khỏi thẻ" disabled={disabled} onClick={() => onChange({ ...config, cardFields: config.cardFields.filter((r) => r !== ref) })}>
              <X />
            </Button>
          </span>
        ))}
        {remaining.length && config.cardFields.length < 6 ? (
          <select className={SELECT_CLASS} value="" aria-label="Thêm field lên thẻ" disabled={disabled} onChange={(e) => e.target.value && onChange({ ...config, cardFields: [...config.cardFields, e.target.value as FieldRef] })}>
            <option value="">+ Thêm field</option>
            {remaining.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

// ─────────── DÒNG THỜI GIAN ───────────

function TimelineForm({ config, catalog, onChange, disabled }: FormProps<"timeline">) {
  const spec = catalog.timelines.find((t) => t.key === config.source);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={LABEL}>
        Nguồn nhật ký
        <RegistrySelect
          label="Nguồn nhật ký"
          empty="chọn nguồn"
          value={config.source}
          items={catalog.timelines.map((t) => ({ value: t.key, label: t.label }))}
          disabled={disabled}
          onChange={(source) => {
            const next = catalog.timelines.find((t) => t.key === source);
            onChange({ source, limit: config.limit ?? 20, ...(next?.recordObject ? { recordParam: config.recordParam || "id" } : {}) });
          }}
        />
      </label>
      {spec?.recordObject || config.recordParam ? (
        <label className={LABEL}>
          Tham số URL mang mã bản ghi
          <div className="flex items-center gap-1 font-mono text-[12.5px] text-foreground">
            ?<Input className="h-8 w-28 font-mono text-[12.5px]" value={config.recordParam ?? ""} maxLength={30} disabled={disabled} onChange={(e) => onChange({ ...config, recordParam: e.target.value.trim() || undefined })} />=…
          </div>
        </label>
      ) : null}
      <label className={LABEL}>
        Tối đa dòng
        <Input className="h-8 w-20" type="number" min={1} max={100} value={config.limit ?? 20} disabled={disabled} onChange={(e) => onChange({ ...config, limit: Math.max(1, Math.min(100, Number(e.target.value) || 20)) })} />
      </label>
      <Why text={spec?.why} />
    </div>
  );
}

// ─────────── FORM ───────────

function FormBlockForm({ config, catalog, onChange, disabled }: FormProps<"form">) {
  const objects = formObjects(catalog);
  const object = objectOf(catalog, config.objectKey);
  const forms = object?.forms ?? [];
  const setMode = (mode: FormConfig["mode"]) => onChange({ ...config, mode, recordParam: mode === "create" ? undefined : config.recordParam || "id" });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={LABEL}>
        Đối tượng
        <RegistrySelect
          label="Đối tượng của form"
          empty="chọn đối tượng"
          value={config.objectKey}
          items={objects.map((o) => ({ value: o.key, label: o.label }))}
          disabled={disabled}
          onChange={(objectKey) => {
            const f = objectOf(catalog, objectKey)?.forms[0];
            const mode: FormConfig["mode"] = f?.purpose === "edit" ? "edit" : "create";
            onChange({ objectKey, formKey: f?.key ?? "", mode, ...(mode === "create" ? {} : { recordParam: "id" }) });
          }}
        />
      </label>
      <label className={LABEL}>
        Form
        <RegistrySelect label="Form" empty="chọn form" value={config.formKey} items={forms.map((f) => ({ value: f.key, label: f.label }))} disabled={disabled} onChange={(formKey) => onChange({ ...config, formKey })} />
      </label>
      <label className={LABEL}>
        Chế độ
        <select className={SELECT_CLASS} value={config.mode} disabled={disabled} onChange={(e) => setMode(e.target.value as FormConfig["mode"])}>
          {(Object.keys(FORM_MODE_LABEL) as FormConfig["mode"][]).map((m) => (
            <option key={m} value={m}>
              {FORM_MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      {config.mode === "create" ? null : (
        <label className={LABEL}>
          Tham số URL mang mã bản ghi
          <div className="flex items-center gap-1 font-mono text-[12.5px] text-foreground">
            ?<Input className="h-8 w-28 font-mono text-[12.5px]" value={config.recordParam ?? ""} maxLength={30} disabled={disabled} onChange={(e) => onChange({ ...config, recordParam: e.target.value.trim() || undefined })} />=…
          </div>
        </label>
      )}
    </div>
  );
}

// ─────────── NÚT ───────────

function ButtonForm({ config, catalog, onChange, disabled }: FormProps<"button">) {
  const spec = catalog.actions.find((a) => a.key === config.action);
  const input = Object.entries(config.input ?? {});
  const setInput = (entries: [string, unknown][]) => {
    const next = Object.fromEntries(entries.filter(([k]) => k.trim() !== ""));
    onChange({ ...config, input: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Thao tác
          <RegistrySelect
            label="Thao tác"
            empty="chọn thao tác"
            value={config.action}
            items={catalog.actions.map((a) => ({ value: a.key, label: `${a.label}${a.sideEffect === "WRITE" ? " · ghi dữ liệu" : ""}${a.requiresApproval ? " · cần duyệt" : ""}` }))}
            disabled={disabled}
            onChange={(action) => onChange({ ...config, action, input: undefined, confirm: catalog.actions.find((a) => a.key === action)?.sideEffect === "WRITE" ? config.confirm || "Chắc chắn thực hiện?" : config.confirm })}
          />
        </label>
        <label className={LABEL}>
          Nhãn nút
          <Input className="h-8 w-44" value={config.label} maxLength={40} disabled={disabled} onChange={(e) => onChange({ ...config, label: e.target.value })} />
        </label>
        <label className={LABEL}>
          Câu xác nhận (trống = không hỏi)
          <Input className="h-8 w-64" value={config.confirm ?? ""} maxLength={160} disabled={disabled} onChange={(e) => onChange({ ...config, confirm: e.target.value || undefined })} />
        </label>
        <Why text={spec?.why} />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Đầu vào cố định (tối thiểu — máy chủ kiểm theo lược đồ của thao tác)</div>
        {input.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input className="h-8 w-36 font-mono text-[12.5px]" aria-label="Khoá đầu vào" value={k} maxLength={40} disabled={disabled} onChange={(e) => setInput(input.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
            <span className="text-muted-foreground">=</span>
            <Input className="h-8 w-56" aria-label="Giá trị đầu vào" value={typeof v === "string" ? v : JSON.stringify(v)} maxLength={200} disabled={disabled} onChange={(e) => setInput(input.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
            <Button variant="ghost" size="icon-xs" aria-label="Bỏ đầu vào" disabled={disabled} onClick={() => setInput(input.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="xs" disabled={disabled} onClick={() => onChange({ ...config, input: { ...(config.input ?? {}), [`khoa_${input.length + 1}`]: "" } })}>
          <Plus /> Thêm đầu vào
        </Button>
      </div>
    </div>
  );
}

// ─────────── ĐOẠN CHỮ ───────────

function TextForm({ config, onChange, disabled }: { config: BlockConfigByType["text"]; onChange: (c: BlockConfigByType["text"]) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2">
      <label className={LABEL}>
        Kiểu chữ
        <select className={SELECT_CLASS} aria-label="Kiểu chữ" value={config.variant ?? ""} disabled={disabled} onChange={(e) => onChange({ ...config, variant: (e.target.value || undefined) as TextVariant | undefined })}>
          <option value="">Thẻ (mặc định)</option>
          {TEXT_VARIANTS.map((v) => (
            <option key={v} value={v}>
              {TEXT_VARIANT_LABEL[v]}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Tiêu đề
        <Input className="h-8" value={config.heading ?? ""} maxLength={120} disabled={disabled} onChange={(e) => onChange({ ...config, heading: e.target.value || undefined })} />
      </label>
      <label className={LABEL}>
        Đoạn chữ (văn bản thuần — không HTML, không mã)
        <Textarea rows={3} value={config.body ?? ""} maxLength={2000} disabled={disabled} onChange={(e) => onChange({ ...config, body: e.target.value || undefined })} />
      </label>
    </div>
  );
}

// ─────────── HÀNH ĐỘNG THEO DÒNG (bảng) ───────────

/**
 * ≤ 3 hành động trên TỪNG dòng. Máy chủ tự ghim đối tượng của bảng và lấy bản ghi từ DÒNG được bấm — ở đây không có
 * ô nào cho đối tượng hay mã bản ghi. `update_safe_field` phải ghim field (tuỳ biến) + giá trị; `request_approval`
 * phải ghim luật.
 */
function RowActionsForm({ config, catalog, onChange, disabled }: FormProps<"table">) {
  const actions = rowActionOptions(catalog, config.source);
  const list = config.rowActions ?? [];
  const object = objectOf(catalog, config.source);
  const customFields = (object?.catalog ?? []).filter((c) => !c.system && !c.lockedReadOnly);
  const set = (next: TableRowAction[]) => onChange({ ...config, rowActions: next.length ? next : undefined });
  const patch = (i: number, p: Partial<TableRowAction>) => set(list.map((a, j) => (j === i ? { ...a, ...p } : a)));
  return (
    <div className="rounded-lg border border-hairline p-2">
      <div className="mb-1 text-xs font-semibold">Hành động theo dòng ({list.length}/{TABLE_MAX_ROW_ACTIONS})</div>
      {!config.source ? <p className="text-xs text-muted-foreground">Chọn đối tượng của bảng trước.</p> : null}
      {config.source && actions.length === 0 ? <p className="text-xs text-muted-foreground">Không có thao tác nào nhận một bản ghi của đối tượng này.</p> : null}
      <ul className="space-y-2">
        {list.map((a, i) => {
          const pinned = a.input ?? {};
          const field = customFields.find((f) => f.ref === `custom:${String(pinned.field ?? "")}`);
          return (
            <li key={i} className="space-y-1.5 rounded-md bg-muted/40 p-2" data-row-action={i}>
              <div className="flex flex-wrap items-end gap-2">
                <label className={LABEL}>
                  Thao tác
                  <RegistrySelect label="Thao tác theo dòng" empty="chọn thao tác" value={a.action} items={actions.map((x) => ({ value: x.key, label: x.label }))} disabled={disabled} onChange={(action) => patch(i, { action, input: undefined, label: actions.find((x) => x.key === action)?.label ?? a.label })} />
                </label>
                <label className={LABEL}>
                  Nhãn
                  <Input className="h-8 w-32" value={a.label} maxLength={40} disabled={disabled} onChange={(e) => patch(i, { label: e.target.value })} />
                </label>
                <Button variant="ghost" size="icon-xs" aria-label="Bỏ hành động" disabled={disabled} onClick={() => set(list.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
              {a.action === "update_safe_field" ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className={LABEL}>
                    Field tuỳ biến (ghim)
                    <RegistrySelect
                      label="Field được sửa"
                      empty="chọn field"
                      value={typeof pinned.field === "string" ? `custom:${pinned.field}` : ""}
                      items={customFields.map((f) => ({ value: f.ref, label: f.label }))}
                      disabled={disabled}
                      onChange={(ref) => patch(i, { input: { field: ref.slice("custom:".length) } })}
                    />
                  </label>
                  {typeof pinned.field === "string" ? (
                    <label className={LABEL}>
                      Giá trị đặt
                      {field?.options.length ? (
                        <select className={SELECT_CLASS} aria-label="Giá trị đặt" value={typeof pinned.value === "string" ? pinned.value : ""} disabled={disabled} onChange={(e) => patch(i, { input: { ...pinned, value: e.target.value || undefined } })}>
                          <option value="">— chọn —</option>
                          {field.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input className="h-8 w-36" aria-label="Giá trị đặt" value={pinned.value === undefined ? "" : String(pinned.value)} disabled={disabled} onChange={(e) => patch(i, { input: { ...pinned, value: e.target.value === "" ? undefined : e.target.value } })} />
                      )}
                    </label>
                  ) : null}
                </div>
              ) : null}
              {a.action === "request_approval" ? (
                <label className={LABEL}>
                  Luật có cửa duyệt (khoá luật, ghim)
                  <Input className="h-8 w-48 font-mono text-[12.5px]" value={typeof pinned.ruleKey === "string" ? pinned.ruleKey : ""} maxLength={60} disabled={disabled} onChange={(e) => patch(i, { input: e.target.value.trim() ? { ruleKey: e.target.value.trim() } : undefined })} />
                </label>
              ) : null}
              <label className={LABEL}>
                Câu xác nhận (trống = không hỏi)
                <Input className="h-8" value={a.confirm ?? ""} maxLength={160} disabled={disabled} onChange={(e) => patch(i, { confirm: e.target.value || undefined })} />
              </label>
            </li>
          );
        })}
      </ul>
      {list.length < TABLE_MAX_ROW_ACTIONS && actions.length > 0 ? (
        <Button variant="outline" size="xs" className="mt-2" disabled={disabled} onClick={() => set([...list, { action: actions[0].key, label: actions[0].label }])}>
          <Plus /> Thêm hành động theo dòng
        </Button>
      ) : null}
    </div>
  );
}

// ─────────── BỘ LỌC ───────────

/**
 * Thanh lọc cho người xem: bộ chọn kỳ + ≤ 4 ô (đối tượng · field lọc được · phép hợp kiểu · nhãn) + các khối ĐÍCH
 * trên cùng trang. Đích chỉ nhận ô lọc CÙNG đối tượng; đích khác đối tượng hiện mờ kèm lý do.
 */
function FilterForm({ config, catalog, onChange, disabled, targets, blockId }: FormProps<"filter"> & { targets?: FilterTargetOption[]; blockId: string }) {
  const objects = new Set(config.fields.map((f) => f.objectKey));
  const setFields = (fields: FilterFieldConfig[]) => onChange({ ...config, fields });
  const firstObject = targets?.find((t) => config.targets.includes(t.id))?.objectKey ?? targets?.[0]?.objectKey ?? catalog.lists[0]?.objectKey ?? "";
  const addField = () => {
    const o = objectOf(catalog, firstObject);
    const f = (o?.catalog ?? []).find((c) => c.filterable);
    setFields([...config.fields, { objectKey: firstObject, ref: f?.ref ?? ("" as FieldRef), op: filterBarOps(f)[0] ?? "eq" }]);
  };
  return (
    <div className="space-y-3">
      <label className="inline-flex items-center gap-2 text-sm">
        <Tick checked={config.period === true} disabled={disabled} label="Hiện bộ chọn kỳ" onChange={(v) => onChange({ ...config, period: v || undefined })} />
        Hiện bộ chọn kỳ (kỳ chung của trang)
      </label>
      <div className="rounded-lg border border-hairline p-2">
        <div className="mb-1 text-xs font-semibold">
          Ô lọc ({config.fields.length}/{FILTER_MAX_FIELDS})
        </div>
        <ul className="space-y-2">
          {config.fields.map((f, i) => {
            const o = objectOf(catalog, f.objectKey);
            const filterable = (o?.catalog ?? []).filter((c) => c.filterable);
            const field = filterable.find((c) => c.ref === f.ref);
            const ops = filterBarOps(field);
            return (
              <li key={i} className="flex flex-wrap items-end gap-2 rounded-md bg-muted/40 p-2" data-filter-field={i}>
                <label className={LABEL}>
                  Đối tượng
                  <RegistrySelect
                    label="Đối tượng của ô lọc"
                    empty="chọn đối tượng"
                    value={f.objectKey}
                    items={catalog.lists.map((l) => ({ value: l.objectKey, label: l.label }))}
                    disabled={disabled}
                    onChange={(objectKey) => {
                      const nf = (objectOf(catalog, objectKey)?.catalog ?? []).find((c) => c.filterable);
                      setFields(config.fields.map((x, j) => (j === i ? { objectKey, ref: nf?.ref ?? ("" as FieldRef), op: filterBarOps(nf)[0] ?? "eq" } : x)));
                    }}
                  />
                </label>
                <label className={LABEL}>
                  Field
                  <RegistrySelect
                    label="Field lọc"
                    empty="chọn field"
                    value={f.ref}
                    items={filterable.map((c) => ({ value: c.ref, label: c.label }))}
                    disabled={disabled}
                    onChange={(ref) => {
                      const nf = filterable.find((c) => c.ref === ref);
                      setFields(config.fields.map((x, j) => (j === i ? { ...x, ref: ref as FieldRef, op: filterBarOps(nf).includes(x.op) ? x.op : (filterBarOps(nf)[0] ?? "eq") } : x)));
                    }}
                  />
                </label>
                <label className={LABEL}>
                  Phép so
                  <select className={SELECT_CLASS} aria-label="Phép so của ô lọc" value={f.op} disabled={disabled || ops.length === 0} onChange={(e) => setFields(config.fields.map((x, j) => (j === i ? { ...x, op: e.target.value as ListFilterOp } : x)))}>
                    {ops.includes(f.op) ? null : <option value={f.op}>{FILTER_OP_LABEL[f.op]} (không hợp field)</option>}
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {FILTER_OP_LABEL[op]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={LABEL}>
                  Nhãn (tuỳ chọn)
                  <Input className="h-8 w-28" value={f.label ?? ""} placeholder={field?.label ?? ""} maxLength={40} disabled={disabled} onChange={(e) => setFields(config.fields.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)))} />
                </label>
                <Button variant="ghost" size="icon-xs" aria-label="Bỏ ô lọc" disabled={disabled} onClick={() => setFields(config.fields.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
        {config.fields.length < FILTER_MAX_FIELDS ? (
          <Button variant="outline" size="xs" className="mt-2" disabled={disabled || !firstObject} onClick={addField}>
            <Plus /> Thêm ô lọc
          </Button>
        ) : null}
      </div>
      {targets ? (
        <fieldset className="rounded-lg border border-hairline p-2">
          <legend className="px-1 text-xs font-semibold">Khối nhận bộ lọc</legend>
          {targets.filter((t) => t.id !== blockId).length === 0 ? <p className="text-xs text-muted-foreground">Trang chưa có bảng, kanban hay KPI / biểu đồ tổng hợp nào để lọc.</p> : null}
          <ul className="space-y-1">
            {targets
              .filter((t) => t.id !== blockId)
              .map((t) => {
                const checked = config.targets.includes(t.id);
                const mismatch = config.fields.length > 0 && !objects.has(t.objectKey);
                return (
                  <li key={t.id}>
                    <label className="inline-flex items-center gap-2 text-sm" title={mismatch ? `Khối đọc «${t.objectKey}» — chưa có ô lọc nào cùng đối tượng` : undefined}>
                      <Tick
                        checked={checked}
                        disabled={disabled || (!checked && mismatch)}
                        label={`Lọc khối ${t.label}`}
                        onChange={(v) => onChange({ ...config, targets: v ? [...config.targets, t.id] : config.targets.filter((x) => x !== t.id) })}
                      />
                      <span>{t.label}</span>
                      <code className="font-mono text-[11px] text-muted-foreground">{t.id}</code>
                      {mismatch ? <span className="text-[11px] text-muted-foreground">(khác đối tượng)</span> : null}
                    </label>
                  </li>
                );
              })}
            {config.targets
              .filter((id) => !targets.some((t) => t.id === id))
              .map((id) => (
                <li key={id} className="text-xs text-destructive">
                  «{id}» không còn trên trang (hoặc không nhận bộ lọc){" "}
                  <Button variant="ghost" size="xs" disabled={disabled} onClick={() => onChange({ ...config, targets: config.targets.filter((x) => x !== id) })}>
                    Bỏ
                  </Button>
                </li>
              ))}
          </ul>
        </fieldset>
      ) : null}
    </div>
  );
}
