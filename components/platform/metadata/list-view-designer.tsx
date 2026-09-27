"use client";

import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { PublishLine } from "@/components/platform/metadata/admin-picker";
import { FieldErrors, MoveButtons, SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publishListAdminAction, saveListDraftAdminAction } from "@/lib/actions/metadata-admin";
import { FIELD_TYPE_LABEL, type FieldError, type FieldRef, type ListFilter, type ListFilterOp, type ListViewSchema } from "@/lib/metadata/types";
import { FILTER_OP_LABEL, filterOpsFor, mergeListColumns, moveItem, sameConfig, sameListLayout, type CatalogField, type PublishInfo } from "@/lib/platform-ui/metadata-admin-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TRÌNH SOẠN DANH SÁCH — NHÁP → XEM TRƯỚC → XUẤT BẢN ═══════════
 *
 * Cột (hiện/ẩn, lên/xuống), sắp xếp mặc định, bộ lọc mặc định (chỉ field `filterable`, phép so hợp
 * kiểu). Chưa xuất bản bao giờ ⇒ trang chạy thật vẫn dùng cột của mã nguồn y như cũ (M9).
 */

type Props = {
  objectKey: string;
  viewKey: string;
  listLabel: string;
  route: string;
  catalog: CatalogField[];
  draft: ListViewSchema;
  published: PublishInfo & { schema: ListViewSchema };
};

const NO_VALUE_OPS: readonly ListFilterOp[] = ["empty", "not_empty"];

export function ListViewDesigner({ objectKey, viewKey, listLabel, route, catalog, draft, published }: Props) {
  const initial = (): ListViewSchema => ({ ...draft, columns: mergeListColumns(draft, catalog) });
  const [schema, setSchema] = useState<ListViewSchema>(initial);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const byRef = new Map(catalog.map((c) => [c.ref, c]));
  const filterable = catalog.filter((c) => c.filterable);
  const savedDraft = { ...draft, columns: mergeListColumns(draft, catalog) };
  const dirty = !sameConfig(schema, savedDraft);
  const draftDiffers = !sameListLayout(draft, published.schema);
  const visibleCols = schema.columns.filter((c) => c.visible);

  const setFilters = (fn: (f: ListFilter[]) => ListFilter[]) => setSchema((p) => ({ ...p, defaultFilters: fn(p.defaultFilters) }));

  const save = () =>
    startTransition(async () => {
      const early: FieldError[] = visibleCols.length === 0 ? [{ field: "columns", message: "Danh sách cần ít nhất một cột đang hiện." }] : [];
      setErrors(early);
      if (early.length) return;
      try {
        const r = await saveListDraftAdminAction(objectKey, viewKey, schema);
        if (r.ok) toast.success("Đã lưu nháp — người dùng chưa thấy gì cho tới khi xuất bản.");
        else setErrors(r.errors);
      } catch {
        setErrors([{ field: "", message: "Không lưu được — thử lại." }]);
      }
    });

  const publish = () =>
    startTransition(async () => {
      try {
        const r = await publishListAdminAction(objectKey, viewKey);
        if (r.ok) toast.success(`Đã xuất bản «${listLabel}» — ${route} đổi ở lần tải kế tiếp.`);
        else setErrors(r.errors);
      } catch {
        setErrors([{ field: "", message: "Không xuất bản được — thử lại." }]);
      } finally {
        setConfirming(false);
      }
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PublishLine version={published.version} isDefault={published.isDefault} publishedAt={published.publishedAt} publishedBy={published.publishedBy} draftDiffers={draftDiffers} />
        <div className="flex items-center gap-2">
          {dirty ? <span className="text-xs text-amber-700 dark:text-amber-400">Có thay đổi chưa lưu</span> : null}
          <Button variant="outline" size="sm" onClick={() => setSchema(initial())} disabled={!dirty || pending}>
            Bỏ thay đổi
          </Button>
          <Button variant="outline" size="sm" onClick={save} disabled={!dirty || pending}>
            Lưu nháp
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={pending || dirty || (!published.isDefault && !draftDiffers)}
            title={dirty ? "Lưu nháp trước khi xuất bản" : !published.isDefault && !draftDiffers ? "Nháp giống bản đang xuất bản" : undefined}
          >
            Xuất bản
          </Button>
        </div>
      </div>
      <FieldErrors errors={errors.filter((e) => !e.field.startsWith("defaultFilters") && !schema.defaultFilters.some((f) => f.ref === e.field))} />

      <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]", pending && "opacity-70")}>
        <section className="rounded-xl border bg-surface">
          <header className="border-b border-hairline px-3 py-2 text-sm font-semibold">
            Cột · {visibleCols.length}/{schema.columns.length} đang hiện
          </header>
          {schema.columns.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">Không có field nào làm cột được.</p>
          ) : (
            <ul>
              {schema.columns.map((col, i) => {
                const c = byRef.get(col.ref);
                return (
                  <li key={col.ref} className="flex items-center gap-2 border-t border-hairline px-3 py-1.5 first:border-t-0">
                    <Tick checked={col.visible} label={`Hiện cột ${c?.label ?? col.ref}`} onChange={(v) => setSchema((p) => ({ ...p, columns: p.columns.map((x, j) => (j === i ? { ...x, visible: v } : x)) }))} />
                    <span className={cn("flex-1 text-sm", !col.visible && "text-muted-foreground")}>
                      {c?.label ?? col.ref}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{c ? (c.system ? "hệ thống" : "tuỳ biến") : ""}</span>
                    </span>
                    <MoveButtons index={i} count={schema.columns.length} label={`cột ${c?.label ?? col.ref}`} onMove={(d) => setSchema((p) => ({ ...p, columns: moveItem(p.columns, i, d) }))} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="space-y-4">
          <section className="rounded-xl border bg-surface p-3">
            <h3 className="mb-2 text-sm font-semibold">Sắp xếp mặc định</h3>
            <div className="flex flex-wrap gap-2">
              <select
                className={SELECT_CLASS}
                aria-label="Sắp xếp theo"
                value={schema.defaultSort?.ref ?? ""}
                onChange={(e) => setSchema((p) => ({ ...p, defaultSort: e.target.value ? { ref: e.target.value as FieldRef, dir: p.defaultSort?.dir ?? "desc" } : null }))}
              >
                <option value="">— theo mã nguồn —</option>
                {schema.columns.map((col) => (
                  <option key={col.ref} value={col.ref}>
                    {byRef.get(col.ref)?.label ?? col.ref}
                  </option>
                ))}
              </select>
              <select className={SELECT_CLASS} aria-label="Chiều sắp xếp" disabled={!schema.defaultSort} value={schema.defaultSort?.dir ?? "desc"} onChange={(e) => setSchema((p) => (p.defaultSort ? { ...p, defaultSort: { ...p.defaultSort, dir: e.target.value as "asc" | "desc" } } : p))}>
                <option value="desc">Giảm dần</option>
                <option value="asc">Tăng dần</option>
              </select>
            </div>
          </section>

          <section className="rounded-xl border bg-surface p-3">
            <h3 className="mb-2 text-sm font-semibold">Bộ lọc mặc định</h3>
            {filterable.length === 0 ? (
              <p className="text-xs text-muted-foreground">Không có field nào lọc được — bật «Lọc được» cho field ở màn hình Mô hình dữ liệu.</p>
            ) : (
              <div className="space-y-2">
                {schema.defaultFilters.length === 0 ? <p className="text-xs text-muted-foreground">Chưa có bộ lọc mặc định — danh sách mở ra hiện mọi bản ghi.</p> : null}
                {schema.defaultFilters.map((flt, i) => {
                  const c = byRef.get(flt.ref);
                  const ops = c ? filterOpsFor(c.type) : (Object.keys(FILTER_OP_LABEL) as ListFilterOp[]);
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <select
                        className={SELECT_CLASS}
                        aria-label="Field lọc"
                        value={flt.ref}
                        onChange={(e) => {
                          const ref = e.target.value as FieldRef;
                          const nc = byRef.get(ref);
                          setFilters((fs) => fs.map((x, j) => (j === i ? { ref, op: nc ? filterOpsFor(nc.type)[0] : "eq" } : x)));
                        }}
                      >
                        {filterable.map((f) => (
                          <option key={f.ref} value={f.ref}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <select className={SELECT_CLASS} aria-label="Phép so" value={flt.op} onChange={(e) => {
                          const op = e.target.value as ListFilterOp;
                          // Đổi giữa «một giá trị» và «nhiều giá trị» (hoặc sang phép không cần giá trị) ⇒ bỏ giá trị cũ, vì hình của nó không còn hợp.
                          const reset = NO_VALUE_OPS.includes(op) || (op === "in") !== (flt.op === "in");
                          setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op, ...(reset ? { value: undefined } : {}) } : x)));
                        }}>
                        {ops.map((op) => (
                          <option key={op} value={op}>
                            {FILTER_OP_LABEL[op]}
                          </option>
                        ))}
                      </select>
                      {NO_VALUE_OPS.includes(flt.op) ? null : flt.op === "in" ? (
                        <InValues options={c?.options ?? []} value={flt.value} onChange={(v) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                      ) : c && c.options.length ? (
                        <select className={SELECT_CLASS} aria-label="Giá trị lọc" value={typeof flt.value === "string" ? flt.value : ""} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value || undefined } : x)))}>
                          <option value="">— chọn —</option>
                          {c.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input className="h-8 w-44" aria-label="Giá trị lọc" placeholder={c ? FIELD_TYPE_LABEL[c.type] : ""} value={flt.value === undefined || flt.value === null ? "" : String(flt.value)} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value === "" ? undefined : e.target.value } : x)))} />
                      )}
                      <Button variant="ghost" size="icon-xs" aria-label="Bỏ bộ lọc" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                        <X />
                      </Button>
                      <FieldErrors errors={errors.filter((e) => e.field.startsWith(`defaultFilters.${i}`) || e.field === flt.ref)} className="basis-full" />
                    </div>
                  );
                })}
                <Button variant="outline" size="xs" onClick={() => setFilters((fs) => [...fs, { ref: filterable[0].ref, op: filterOpsFor(filterable[0].type)[0] }])}>
                  <Plus /> Thêm bộ lọc
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="rounded-xl border border-dashed bg-surface-sunken/40 p-4">
        <h3 className="mb-2 text-sm font-semibold">
          Xem trước bản nháp đã lưu {dirty ? <span className="font-normal text-amber-700 dark:text-amber-400">— chưa gồm thay đổi chưa lưu</span> : null}
        </h3>
        <ListPreview schema={savedDraft} catalog={catalog} />
      </div>

      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xuất bản «{listLabel}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Mọi người mở {route} thấy cột, thứ tự và bộ lọc mới NGAY ở lần tải trang kế tiếp — không cần deploy. {published.version > 0 ? `Bản đang xuất bản (phiên bản ${published.version}) được giữ trong lịch sử phiên bản.` : "Đây là lần xuất bản đầu tiên; trước đó trang dùng cột mặc định của hệ thống."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                publish();
              }}
            >
              Xuất bản
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Giá trị của phép «thuộc một trong»: một MẢNG (máy chủ từ chối chuỗi đơn) — ô tích theo tuỳ chọn, hoặc gõ cách nhau bằng dấu phẩy. */
function InValues({ options, value, onChange }: { options: CatalogField["options"]; value: unknown; onChange: (v: string[] | undefined) => void }) {
  const cur = Array.isArray(value) ? value.map(String) : [];
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  if (options.length === 0)
    return <Input className="h-8 w-56" aria-label="Các giá trị, cách nhau bằng dấu phẩy" placeholder="a, b, c" value={cur.join(", ")} onChange={(e) => set(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />;
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {options.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-1.5">
          <Tick checked={cur.includes(o.value)} label={o.label} onChange={(on) => set(on ? [...cur, o.value] : cur.filter((x) => x !== o.value))} />
          {o.label}
        </label>
      ))}
    </span>
  );
}

function ListPreview({ schema, catalog }: { schema: ListViewSchema; catalog: CatalogField[] }) {
  const byRef = new Map(catalog.map((c) => [c.ref, c]));
  const cols = schema.columns.filter((c) => c.visible && byRef.has(c.ref));
  const label = (ref: FieldRef) => byRef.get(ref)?.label ?? ref;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              {cols.length === 0 ? <th className="px-3 py-2">Không có cột nào đang hiện</th> : null}
              {cols.map((c) => (
                <th key={c.ref} className="whitespace-nowrap px-3 py-2">
                  {label(c.ref)}
                  {schema.defaultSort?.ref === c.ref ? (schema.defaultSort.dir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Sắp xếp: {schema.defaultSort ? `${label(schema.defaultSort.ref)} · ${schema.defaultSort.dir === "asc" ? "tăng dần" : "giảm dần"}` : "theo mã nguồn"} · Lọc:{" "}
        {schema.defaultFilters.length ? schema.defaultFilters.map((f) => `${label(f.ref)} ${FILTER_OP_LABEL[f.op]}${f.value !== undefined && f.value !== null && f.value !== "" ? ` «${Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}»` : ""}`).join(" · ") : "không"}
      </p>
    </div>
  );
}
