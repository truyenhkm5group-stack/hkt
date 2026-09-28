"use client";

import * as React from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { ChevronDown, X } from "lucide-react";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { FilterData, FilterFieldData } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ THANH LỌC CỦA TRANG ĐỘNG (Phase 5) ═══════════
 *
 * Người xem nhập giá trị; thanh lọc CHỈ ghi tham số `pf_<khối lọc>_<i>` lên URL (giữ nguyên mọi tham số khác, đưa
 * bảng đích về trang 1) rồi để máy chủ dựng lại — máy chủ parse theo kiểu field và bỏ giá trị hỏng, nên URL gõ tay
 * không làm hỏng trang. Ô chữ / số / ngày gửi sau khi ngừng gõ; ô chọn gửi ngay. Bộ chọn kỳ (nếu khối bật) là
 * đúng bộ chọn kỳ chung của các trang báo cáo.
 *
 * Điện thoại (390px): các ô xếp chồng rộng hết, không cuộn ngang.
 */

const FIELD_CLASS = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

type Setter = (param: string, value: string | null) => void;

function TextLike({ field, set }: { field: FilterFieldData; set: Setter }) {
  const current = typeof field.value === "string" ? field.value : "";
  const [draft, setDraft] = React.useState(current);
  React.useEffect(() => setDraft(current), [current]);
  React.useEffect(() => {
    if (draft === current) return;
    const t = setTimeout(() => set(field.param, draft.trim() ? draft.trim() : null), 500);
    return () => clearTimeout(t);
  }, [draft, current, field.param, set]);
  const type = field.input === "number" ? "number" : field.input === "date" ? "date" : "text";
  return <Input aria-label={field.label} type={type} inputMode={field.input === "number" ? "decimal" : undefined} className="h-8 w-full" value={draft} placeholder={field.input === "text" ? "Nhập để lọc…" : undefined} onChange={(e) => setDraft(e.target.value)} />;
}

function SingleSelect({ field, set }: { field: FilterFieldData; set: Setter }) {
  const current = typeof field.value === "string" ? field.value : "";
  return (
    <select aria-label={field.label} className={FIELD_CLASS} value={current} onChange={(e) => set(field.param, e.target.value || null)}>
      <option value="">Tất cả</option>
      {(field.options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function MultiSelect({ field, set }: { field: FilterFieldData; set: Setter }) {
  const picked = new Set(Array.isArray(field.value) ? field.value : []);
  const labelOf = new Map((field.options ?? []).map((o) => [o.value, o.label]));
  const toggle = (v: string) => {
    const next = new Set(picked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    set(field.param, next.size ? [...next].join(",") : null);
  };
  const summary = picked.size === 0 ? "Tất cả" : picked.size === 1 ? (labelOf.get([...picked][0]) ?? [...picked][0]) : `${picked.size} giá trị`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 w-full justify-between font-normal" aria-label={field.label}>
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1">
        <ul className="max-h-64 overflow-y-auto">
          {(field.options ?? []).map((o) => (
            <li key={o.value}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <input type="checkbox" checked={picked.has(o.value)} onChange={() => toggle(o.value)} />
                <span className="truncate">{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function FieldInput({ field, set }: { field: FilterFieldData; set: Setter }) {
  if (field.input === "presence") {
    return (
      <label className="flex h-8 items-center gap-2 text-sm">
        <input type="checkbox" checked={field.value === "1"} onChange={(e) => set(field.param, e.target.checked ? "1" : null)} />
        {field.op === "empty" ? "Chỉ bản ghi còn trống" : "Chỉ bản ghi đã có giá trị"}
      </label>
    );
  }
  if (field.input === "boolean") return <SingleSelect field={{ ...field, options: field.options ?? [{ value: "true", label: "Có" }, { value: "false", label: "Không" }] }} set={set} />;
  if (field.input === "select") return field.multiple ? <MultiSelect field={field} set={set} /> : <SingleSelect field={field} set={set} />;
  return <TextLike field={field} set={set} />;
}

const OP_HINT: Partial<Record<FilterFieldData["op"], string>> = { gte: "từ", lte: "đến", contains: "chứa", neq: "khác" };

export function PageFilterBar({ data }: { data: FilterData }) {
  const [pending, startTransition] = useNavTransition();
  const parsers = React.useMemo(() => Object.fromEntries([...data.fields.map((f) => f.param), ...data.pageParams].map((k) => [k, parseAsString])), [data.fields, data.pageParams]);
  const [, setState] = useQueryStates(parsers, { shallow: false, history: "push", startTransition });
  const set = React.useCallback<Setter>(
    (param, value) => {
      // Đổi bộ lọc ⇒ bảng đích về trang 1; mọi tham số khác (kỳ, bộ lọc khác, trang của bảng khác) giữ nguyên.
      void setState({ [param]: value, ...Object.fromEntries(data.pageParams.map((p) => [p, null])) });
    },
    [setState, data.pageParams],
  );
  const active = data.fields.filter((f) => f.value !== null && !(Array.isArray(f.value) && f.value.length === 0));
  const clear = () => void setState(Object.fromEntries([...data.fields.map((f) => f.param), ...data.pageParams].map((p) => [p, null])));

  return (
    <div className={cn("space-y-2 rounded-2xl bg-card p-3 text-card-foreground shadow-[var(--shadow-card)]", pending && "opacity-80")} role="search" aria-busy={pending || undefined}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
        {data.period ? (
          <div className="min-w-0 space-y-1 lg:w-auto">
            <span className="block text-[11.5px] font-medium text-muted-foreground">Kỳ</span>
            <PeriodFilter defaultKey="30d" />
          </div>
        ) : null}
        {data.fields.map((f) => (
          <div key={f.param} className="min-w-0 space-y-1 lg:w-52">
            <span className="block truncate text-[11.5px] font-medium text-muted-foreground">
              {f.label}
              {OP_HINT[f.op] ? ` (${OP_HINT[f.op]})` : ""}
            </span>
            <FieldInput field={f} set={set} />
          </div>
        ))}
        {active.length ? (
          <Button type="button" variant="ghost" size="sm" className="h-8 justify-self-start" onClick={clear}>
            <X className="size-3.5" aria-hidden /> Bỏ lọc
          </Button>
        ) : null}
      </div>
      {data.dropped.length ? <p className="text-xs text-muted-foreground">Không hiện {data.dropped.map((d) => `${d.label} (${d.reason})`).join(" · ")}.</p> : null}
    </div>
  );
}
