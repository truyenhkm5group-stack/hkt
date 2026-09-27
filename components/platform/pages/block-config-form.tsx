"use client";

import { Plus, X } from "lucide-react";
import { MoveButtons, SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FIELD_TYPE_LABEL, type FieldRef, type ListFilter, type ListFilterOp } from "@/lib/metadata/types";
import { FILTER_OP_LABEL, filterOpsFor, moveItem, type CatalogField } from "@/lib/platform-ui/metadata-admin-shared";
import {
  CHART_KIND_LABEL,
  configOf,
  defaultColumns,
  FORM_MODE_LABEL,
  formObjects,
  kanbanObjects,
  objectOf,
  statusFieldsOf,
  type PageEditorCatalog,
} from "@/lib/platform-ui/page-admin-shared";
import type { BlockConfigByType, BlockType, FormConfig, PageBlock } from "@/lib/pages/types";
import type { PeriodKey } from "@/lib/search-params";

/**
 * ═══════════ FORM CẤU HÌNH THEO LOẠI KHỐI ═══════════
 *
 * Mọi lựa chọn là Ô CHỌN trên sổ đóng (nguồn số liệu, chuỗi, đối tượng, field, action) — không ô gõ SQL, biểu
 * thức hay mã. Sổ tới qua props (máy chủ đã lọc theo module đang bật); nguồn đã chọn mà không còn trong sổ vẫn
 * hiện ra kèm "(không có trong sổ)" để người soạn thấy và đổi, không bị âm thầm đổi hộ.
 */

type Props = { block: PageBlock; catalog: PageEditorCatalog; onChange: (config: BlockConfigByType[BlockType]) => void; disabled?: boolean };

const LABEL = "grid gap-1 text-xs font-medium text-muted-foreground";
const NO_VALUE_OPS: readonly ListFilterOp[] = ["empty", "not_empty"];

export function BlockConfigForm({ block, catalog, onChange, disabled }: Props) {
  switch (block.type) {
    case "kpi":
      return <KpiForm config={configOf(block, "kpi")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    case "table":
      return <TableForm config={configOf(block, "table")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    case "chart":
      return <ChartForm config={configOf(block, "chart")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    case "kanban":
      return <KanbanForm config={configOf(block, "kanban")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    case "timeline":
      return <TimelineForm config={configOf(block, "timeline")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    case "form":
      return <FormBlockForm config={configOf(block, "form")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    case "button":
      return <ButtonForm config={configOf(block, "button")!} catalog={catalog} onChange={onChange} disabled={disabled} />;
    default:
      return <TextForm config={configOf(block, "text")!} onChange={onChange} disabled={disabled} />;
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
    <div className="space-y-3">
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

      <div className="grid gap-3 lg:grid-cols-2">
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
