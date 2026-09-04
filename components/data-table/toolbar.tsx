"use client";

import * as React from "react";
import { parseAsArrayOf, parseAsString, useQueryState, useQueryStates } from "nuqs";
import { CalendarDays, Check, ListFilter, Search, X } from "lucide-react";
import { PERIOD_OPTIONS, type PeriodKey } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

export type FacetOption = { value: string; label: string; count?: number; icon?: React.ReactNode };
export type FacetDef = { key: string; label: string; options: FacetOption[]; single?: boolean };

const shallowOff = { shallow: false as const, history: "push" as const };

export function SearchInput({ placeholder = "Tìm kiếm…", className }: { placeholder?: string; className?: string }) {
  const [q, setQ] = useQueryState("q", parseAsString.withDefault("").withOptions(shallowOff));
  const [, setPage] = useQueryState("page", parseAsString.withOptions(shallowOff));
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
  const [selected, setSelected] = useQueryState(facet.key, parseAsArrayOf(parseAsString, ",").withDefault([]).withOptions(shallowOff));
  const [, setPage] = useQueryState("page", parseAsString.withOptions(shallowOff));
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

export function PeriodFilter({ defaultKey = "all", options = PERIOD_OPTIONS }: { defaultKey?: PeriodKey; options?: { value: PeriodKey; label: string }[] }) {
  const [state, setState] = useQueryStates(
    { period: parseAsString.withDefault(defaultKey), from: parseAsString.withDefault(""), to: parseAsString.withDefault(""), page: parseAsString.withDefault("") },
    shallowOff,
  );
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
          <Input type="date" className="h-8 w-[140px]" value={state.from} onChange={(e) => void setState({ from: e.target.value || null, page: null })} />
          <span className="text-xs text-muted-foreground">→</span>
          <Input type="date" className="h-8 w-[140px]" value={state.to} onChange={(e) => void setState({ to: e.target.value || null, page: null })} />
        </>
      ) : null}
    </div>
  );
}

export function ResetFilters({ keys }: { keys: string[] }) {
  const [state, setState] = useQueryStates(Object.fromEntries(keys.map((k) => [k, parseAsString])), shallowOff);
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
