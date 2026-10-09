"use client";

import * as React from "react";
import { parseAsArrayOf, parseAsString, useQueryState, useQueryStates } from "nuqs";
import { CalendarDays, Check, ListFilter, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { PERIOD_OPTIONS, type PeriodKey } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose as SheetPrimitiveClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className="h-8 w-full pl-8 sm:w-72" />
      {value ? (
        <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setValue("")} aria-label="Xoá tìm kiếm">
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Một bộ lọc nhiều lựa chọn đọc / ghi đúng một khoá URL. Dùng chung cho nút bộ lọc nhanh (popover) và
 * khu «Bộ lọc khác» (ngăn kéo) — hai chỗ vẽ, MỘT cách ghi, nên chọn ở đâu thì URL cũng ra cùng một dạng.
 */
function useFacetSelection(facet: FacetDef) {
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
  const clear = () => {
    void setSelected(null);
    void setPage(null);
  };
  return { set, toggle, clear };
}

export function FacetFilter({ facet, className }: { facet: FacetDef; className?: string }) {
  const { set, toggle, clear } = useFacetSelection(facet);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8", set.size > 0 ? "border-primary/40 bg-primary/5" : "border-dashed", className)}>
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
      <PopoverContent className="w-[240px] p-0" align="start">
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
                  <CommandItem onSelect={clear} className="justify-center text-center">
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
    <div className="flex flex-wrap items-center gap-1.5">
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
  // Đếm BỘ LỌC đang bật (không đếm số trang): nút nói "Xoá 3 bộ lọc" thì người dùng biết mình đang xem một tập đơn hẹp.
  const count = Object.entries(state).filter(([k, v]) => v && k !== "page" && k !== "from" && k !== "to").length;
  if (!count) return null;
  return (
    <Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground hover:text-foreground" onClick={() => void setState(Object.fromEntries(keys.map((k) => [k, null])))}>
      Xoá lọc{count > 1 ? ` (${count})` : ""} <X className="size-3.5" />
    </Button>
  );
}

/** Một nhóm lựa chọn trong ngăn kéo «Bộ lọc khác»: nút chữ to, bấm thẳng — không popover lồng trong ngăn kéo. */
function FacetSection({ facet }: { facet: FacetDef }) {
  const { set, toggle, clear } = useFacetSelection(facet);
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <legend className="text-sm font-semibold">{facet.label}</legend>
        {set.size > 0 ? (
          <button type="button" className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={clear}>
            Bỏ chọn
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {facet.options.map((option) => {
          const active = set.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(option.value)}
              className={cn(
                "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors",
                active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
              )}
            >
              {active ? <Check className="size-3.5" /> : null}
              {option.label}
              {typeof option.count === "number" ? <span className={cn("font-mono text-xs", active ? "opacity-80" : "text-muted-foreground")}>{option.count}</span> : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Số bộ lọc đang bật trong một tập facet — để nút mở ngăn kéo nói được "đang lọc 2" mà không cần mở ra xem. */
function useActiveCount(facets: FacetDef[]) {
  const [state] = useQueryStates(Object.fromEntries(facets.map((f) => [f.key, parseAsString])));
  return facets.filter((f) => state[f.key]).length;
}

/**
 * ═══════ BỘ LỌC KHÁC — NGĂN KÉO ═══════
 *
 * Trang danh sách lớn từng xếp 8–9 nút lọc thành hai, ba hàng; trên điện thoại chúng chiếm cả màn hình đầu và bảng
 * bị đẩy xuống dưới nếp gấp. Bộ lọc dùng hằng ngày đứng ngoài (tối đa `quickCount`), phần còn lại vào ngăn kéo này.
 * Trên điện thoại MỌI bộ lọc vào ngăn kéo — một nút "Bộ lọc" thay cho cả bức tường nút.
 */
function MoreFilters({ facets, label, className, side }: { facets: FacetDef[]; label: string; className?: string; side: "right" | "bottom" }) {
  const active = useActiveCount(facets);
  if (!facets.length) return null;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8", active > 0 && "border-primary/40 bg-primary/5", className)}>
          <SlidersHorizontal className="size-3.5" />
          {label}
          {active > 0 ? (
            <Badge className="ml-0.5 h-5 min-w-5 rounded-full px-1.5 text-[11px]" aria-label={`${active} bộ lọc đang bật`}>
              {active}
            </Badge>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent side={side} className={cn("gap-0", side === "bottom" ? "max-h-[85dvh] rounded-t-2xl" : "w-full sm:max-w-md")}>
        <SheetHeader className="border-b">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription>Chọn xong là danh sách tự lọc lại.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {facets.map((facet) => (
            <FacetSection key={facet.key} facet={facet} />
          ))}
        </div>
        <SheetFooter className="border-t">
          <SheetCloseButton />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function SheetCloseButton() {
  return (
    <SheetPrimitiveClose asChild>
      <Button className="w-full">Xem kết quả</Button>
    </SheetPrimitiveClose>
  );
}

export function DataTableToolbar({
  searchPlaceholder,
  facets = [],
  period,
  children,
  resultLabel,
  extraResetKeys = [],
  quickCount = 4,
}: {
  searchPlaceholder?: string;
  facets?: FacetDef[];
  period?: { defaultKey?: PeriodKey } | false;
  children?: React.ReactNode;
  resultLabel?: React.ReactNode;
  /**
   * Khoá URL của những bộ lọc KHÔNG phải facet (bộ lọc giá trị đơn, công tắc CPQC…). Nút "Xoá
   * lọc" phải xoá được chúng — một bộ lọc không xoá được bằng nút xoá lọc là bộ lọc người dùng
   * quên mất mình đang bật, rồi đọc con số của một tập đơn khác.
   */
  extraResetKeys?: string[];
  /** Số bộ lọc đứng ngoài trên máy tính; phần còn lại vào ngăn kéo «Bộ lọc khác». Thứ tự `facets` = thứ tự ưu tiên. */
  quickCount?: number;
}) {
  const resetKeys = ["q", "page", ...facets.map((f) => f.key), ...extraResetKeys, ...(period ? ["period", "from", "to"] : [])];
  /*
    BỘ LỌC NHANH ≤ quickCount. Chỉ tách khi phần dư từ HAI bộ lọc trở lên — một nút "Bộ lọc khác" chứa đúng một bộ lọc
    là thêm một cú bấm mà không bớt được chỗ nào.
  */
  const split = facets.length > quickCount + 1;
  const quick = split ? facets.slice(0, quickCount) : facets;
  const more = split ? facets.slice(quickCount) : [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {searchPlaceholder ? <SearchInput placeholder={searchPlaceholder} className="w-full sm:w-auto" /> : null}
        {period ? <PeriodFilter defaultKey={period.defaultKey} /> : null}
        {quick.map((facet) => (
          <FacetFilter key={facet.key} facet={facet} className="hidden sm:inline-flex" />
        ))}
        <MoreFilters facets={more} label="Bộ lọc khác" side="right" className="hidden sm:inline-flex" />
        <MoreFilters facets={facets} label="Bộ lọc" side="bottom" className="sm:hidden" />
        <ResetFilters keys={resetKeys} />
        {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
      </div>
      {resultLabel ? <p className="text-xs text-muted-foreground">{resultLabel}</p> : null}
    </div>
  );
}
