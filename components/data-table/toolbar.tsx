"use client";

import * as React from "react";
import { parseAsArrayOf, parseAsString, useQueryState, useQueryStates } from "nuqs";
import { CalendarDays, Check, ListFilter, Loader2, Search, X } from "lucide-react";
import { PERIOD_OPTIONS, type PeriodKey } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useNavTransition } from "@/components/nav-progress";

export type FacetOption = { value: string; label: string; count?: number; icon?: React.ReactNode };
export type FacetDef = { key: string; label: string; options: FacetOption[]; single?: boolean };

const shallowOff = { shallow: false as const, history: "push" as const };

/**
 * Mọi thay đổi bộ lọc / tìm kiếm đều đi vòng lên máy chủ. Bọc trong transition để React biết đang
 * chờ, nhờ đó nút vừa bấm hiện trạng thái chờ thay vì đứng im — và để thanh tiến trình chung trên
 * đỉnh trang biết có việc đang chạy (xem components/nav-progress.tsx).
 *
 * TRƯỚC ĐÂY chỉ `ResetFilters` dùng transition; kỳ báo cáo, ô tìm kiếm và facet thì không, nên đổi
 * kỳ xong màn hình đứng im vài giây mà không có dấu hiệu nào.
 */
function useShallowOff() {
  const [pending, startTransition] = useNavTransition();
  return { options: { ...shallowOff, startTransition }, pending };
}

export function SearchInput({ placeholder = "Tìm kiếm…", className }: { placeholder?: string; className?: string }) {
  const { options } = useShallowOff();
  const [q, setQ] = useQueryState("q", parseAsString.withDefault("").withOptions(options));
  const [, setPage] = useQueryState("page", parseAsString.withOptions(options));
  const [value, setValue] = React.useState(q);
  React.useEffect(() => setValue(q), [q]);
  React.useEffect(() => {
    if (value === q) return;
    const t = setTimeout(() => {
      void setQ(value || null);
      void setPage(null);
    }, 400);
    return () => clearTimeout(t);
  }, [value, q, setQ, setPage]);
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className="h-8 w-full pl-8 sm:w-64" />
      {value ? (
        <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setValue("")} aria-label="Xoá tìm kiếm">
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function FacetFilter({ facet }: { facet: FacetDef }) {
  const { options } = useShallowOff();
  const [selected, setSelected] = useQueryState(facet.key, parseAsArrayOf(parseAsString, ",").withDefault([]).withOptions(options));
  const [, setPage] = useQueryState("page", parseAsString.withOptions(options));
  const set = new Set(selected);
  const toggle = (value: string) => {
    const next = new Set(set);
    if (facet.single) {
      next.clear();
      if (!set.has(value)) next.add(value);
    } else if (next.has(value)) next.delete(value);
    else next.add(value);
    void setSelected(next.size ? [...next] : null);
    void setPage(null);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <ListFilter className="size-3.5" />
          {facet.label}
          {set.size > 0 ? (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <div className="flex gap-1">
                {set.size > 2 ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {set.size} mục
                  </Badge>
                ) : (
                  facet.options
                    .filter((o) => set.has(o.value))
                    .map((o) => (
                      <Badge key={o.value} variant="secondary" className="rounded-sm px-1 font-normal">
                        {o.label}
                      </Badge>
                    ))
                )}
              </div>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <Command>
          {facet.options.length > 8 ? <CommandInput placeholder={facet.label} /> : null}
          <CommandList>
            <CommandEmpty>Không có kết quả.</CommandEmpty>
            <CommandGroup>
              {facet.options.map((option) => {
                const active = set.has(option.value);
                return (
                  <CommandItem key={option.value} value={option.label} onSelect={() => toggle(option.value)}>
                    <div className={cn("flex size-4 items-center justify-center rounded-[4px] border border-primary", active ? "bg-primary text-primary-foreground" : "opacity-50 [&_svg]:invisible")}>
                      <Check className="size-3.5" />
                    </div>
                    {option.icon}
                    <span className="flex-1 truncate">{option.label}</span>
                    {typeof option.count === "number" ? <span className="ml-auto font-mono text-xs text-muted-foreground">{option.count}</span> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {set.size > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      void setSelected(null);
                      void setPage(null);
                    }}
                    className="justify-center text-center"
                  >
                    Bỏ lọc
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * CHỌN KỲ BÁO CÁO — chỗ người dùng bấm nhiều nhất và cũng là chỗ chậm nhất.
 *
 * Ba việc phải đúng ở đây:
 *  1. Đổi kỳ đi qua transition ⇒ nội dung CŨ vẫn hiện trong lúc chờ (không màn hình trắng, không
 *     nháy về 0) và thanh tiến trình chung biết có việc đang chạy.
 *  2. Ô ngày tuỳ chọn gõ đến đâu KHÔNG bắn điều hướng đến đó. `<input type="date">` phát sự kiện
 *     cho từng ký tự ngày/tháng/năm, nên gõ một ngày trước đây bắn ba lần dựng lại trang trên máy
 *     chủ, hai lần đầu là công toi. Nay chờ 500 ms sau khi ngừng gõ, và chỉ gửi khi ngày HỢP LỆ.
 *  3. Yêu cầu cũ tự bị bỏ: `startTransition` của React luôn lấy lần điều hướng MỚI NHẤT làm kết
 *     quả, nên bấm Tháng 8 → Tháng 9 → 7 ngày qua thì màn hình chắc chắn hiện 7 ngày qua, không
 *     phụ thuộc câu trả lời nào về trước.
 */
export function PeriodFilter({ defaultKey = "all", options = PERIOD_OPTIONS }: { defaultKey?: PeriodKey; options?: { value: PeriodKey; label: string }[] }) {
  const { options: navOptions, pending } = useShallowOff();
  const [state, setState] = useQueryStates(
    { period: parseAsString.withDefault(defaultKey), from: parseAsString.withDefault(""), to: parseAsString.withDefault(""), page: parseAsString.withDefault("") },
    navOptions,
  );
  // Bản nháp cục bộ của hai ô ngày: hiện ngay khi gõ, chỉ gửi lên máy chủ khi đã ngừng gõ.
  const [draft, setDraft] = React.useState({ from: state.from, to: state.to });
  React.useEffect(() => setDraft({ from: state.from, to: state.to }), [state.from, state.to]);
  React.useEffect(() => {
    if (draft.from === state.from && draft.to === state.to) return;
    const valid = (v: string) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!valid(draft.from) || !valid(draft.to)) return;
    const timer = setTimeout(() => void setState({ from: draft.from || null, to: draft.to || null, page: null }), 500);
    return () => clearTimeout(timer);
  }, [draft, state.from, state.to, setState]);
  return (
    <div className="flex items-center gap-1.5">
      <Select value={state.period} onValueChange={(v) => void setState({ period: v === defaultKey ? null : v, page: null })}>
        <SelectTrigger size="sm" className="h-8 w-[150px]">
          <CalendarDays className="size-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {state.period === "custom" ? (
        <>
          <Input type="date" className="h-8 w-[140px]" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
          <span className="text-xs text-muted-foreground">→</span>
          <Input type="date" className="h-8 w-[140px]" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
        </>
      ) : null}
      {pending ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Đang tải kỳ báo cáo" /> : null}
    </div>
  );
}

export function ResetFilters({ keys }: { keys: string[] }) {
  const { options: shallowOffTx } = useShallowOff();
  const [state, setState] = useQueryStates(Object.fromEntries(keys.map((k) => [k, parseAsString])), shallowOffTx);
  const active = Object.values(state).some((v) => v);
  if (!active) return null;
  return (
    <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => void setState(Object.fromEntries(keys.map((k) => [k, null])))}>
      Xoá lọc <X className="size-3.5" />
    </Button>
  );
}

export function DataTableToolbar({
  searchPlaceholder,
  facets = [],
  period,
  children,
  resultLabel,
}: {
  searchPlaceholder?: string;
  facets?: FacetDef[];
  period?: { defaultKey?: PeriodKey } | false;
  children?: React.ReactNode;
  resultLabel?: React.ReactNode;
}) {
  const resetKeys = ["q", "page", ...facets.map((f) => f.key), ...(period ? ["period", "from", "to"] : [])];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {searchPlaceholder ? <SearchInput placeholder={searchPlaceholder} /> : null}
        {period ? <PeriodFilter defaultKey={period.defaultKey} /> : null}
        {facets.map((facet) => (
          <FacetFilter key={facet.key} facet={facet} />
        ))}
        <ResetFilters keys={resetKeys} />
        {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
      </div>
      {resultLabel ? <p className="text-xs text-muted-foreground">{resultLabel}</p> : null}
    </div>
  );
}
