"use client";

import { useMemo, useState } from "react";
import { Download, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MARKETING_GROUP_LABEL,
  MARKETING_METRICS,
  MARKETING_METRIC_BY_KEY,
  MARKETING_VIEW_COLUMNS,
  MATURITY_HINT,
  MATURITY_LABEL,
  ratioOf,
  type MarketingMetricSpec,
  type MarketingView,
} from "@/lib/constants/marketing-daily";
import type { MarketingDaily, MarketingDailyRow } from "@/lib/queries/marketing-daily";
import { MISSING_TEXT, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ───────────── BẢNG THEO NGÀY ─────────────
 *
 * Ba điều bảng này làm khác một bảng thống kê thường, và cả ba đều là để chống ĐỌC NHẦM:
 *
 *  1. **Mỗi tiêu đề cột mở ra được hợp đồng của chính nó** — nghĩa, tử số, mẫu số, nguồn, thời
 *     điểm đo, và chưa biết thì in gì. Một bảng 28 cột không có sáu câu đó sẽ được đọc bằng phỏng
 *     đoán, và phỏng đoán về tiền thì tốn tiền.
 *  2. **Ô `—` không bao giờ là `0`.** Chi tiêu chưa đồng bộ, mẫu số bằng 0, chi phí vận hành không
 *     chia được — ba tình huống khác nhau nhưng cùng một sự thật: CHƯA BIẾT. In 0 ở đó là mời người
 *     đọc kết luận.
 *  3. **Ngày chưa ngã ngũ không được tô màu và được làm mờ.** Số của nó đúng, nhưng nó chưa phải
 *     kết quả của ngày ấy — tô xanh/đỏ là khẳng định một điều chưa xảy ra.
 */

function toneFor(spec: MarketingMetricSpec, value: number | null, mature: boolean): string {
  if (value === null) return "text-muted-foreground";
  // KHÔNG KẾT LUẬN KHI CHƯA NGÃ NGŨ: ngày mới luôn trông như đang lỗ vì tiền đã tiêu còn hàng chưa tới.
  if (!mature) return "";
  if (spec.direction === "CONTEXT") return "";
  if (spec.group !== "PROFIT") return "";
  // Chỉ tô nhóm LỢI NHUẬN, và chỉ theo DẤU — không có ngưỡng đạt/không đạt nào ghi cứng ở đây:
  // đích là quyết định kinh doanh, sống ở `metric_targets` (AGENTS.md mục 38).
  if (value > 0) return "text-emerald-600 dark:text-emerald-400";
  if (value < 0) return "text-rose-600 dark:text-rose-400";
  return "";
}

function renderValue(spec: MarketingMetricSpec, value: number | null): string {
  if (value === null) return MISSING_TEXT;
  if (spec.unit === "VND") return formatVND(value);
  if (spec.unit === "PERCENT") return formatPercent(value);
  if (spec.unit === "RATIO") return `${Math.round(value * 100) / 100}`;
  return formatNumber(value);
}

/** Giá trị một ô: số cộng được thì đọc thẳng, tỷ lệ thì TÍNH LẠI từ tử/mẫu — một đường duy nhất. */
export function cellValue(spec: MarketingMetricSpec, row: Record<string, unknown>): number | null {
  if (spec.num && spec.den) return ratioOf(spec.key, row as never);
  const v = row[spec.key];
  return v === null || v === undefined ? null : Number(v);
}

function HeaderCell({ spec }: { spec: MarketingMetricSpec }) {
  return (
    <TableHead className="whitespace-nowrap text-right text-[11px]">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help border-b border-dotted border-muted-foreground/50">{spec.label}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm space-y-1 text-left text-xs">
          <p className="font-medium">{spec.label}</p>
          <p>{spec.meaning}</p>
          {spec.numerator ? (
            <p>
              <span className="text-muted-foreground">Công thức: </span>
              {spec.numerator} ÷ {spec.denominator}
            </p>
          ) : null}
          <p>
            <span className="text-muted-foreground">Nguồn: </span>
            {spec.source}
          </p>
          <p>
            <span className="text-muted-foreground">Thời điểm: </span>
            {spec.timing}
          </p>
          <p>
            <span className="text-muted-foreground">Chưa biết: </span>
            {spec.nullRule}
          </p>
        </TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

function csvOf(columns: MarketingMetricSpec[], rows: MarketingDailyRow[]): string {
  const head = ["Ngày", ...columns.map((c) => c.label)].join(",");
  const body = rows.map((r) => [r.day, ...columns.map((c) => {
    const v = cellValue(c, r as unknown as Record<string, unknown>);
    // Ô CHƯA BIẾT xuất ra chuỗi rỗng, KHÔNG xuất 0: tệp CSV rời khỏi ERP và không mang theo tooltip
    // nào, nên một số 0 ở đó sẽ sống mãi như một phép đo thật.
    return v === null ? "" : String(Math.round(v * 100) / 100);
  })].join(","));
  return [head, ...body].join("\n");
}

export function MarketingDailyTable({ data, view }: { data: MarketingDaily; view: MarketingView }) {
  const [custom, setCustom] = useState<string[] | null>(null);
  const keys = custom ?? MARKETING_VIEW_COLUMNS[view];
  const columns = useMemo(() => keys.map((k) => MARKETING_METRIC_BY_KEY[k]).filter(Boolean), [keys]);

  const groups = useMemo(() => {
    const out: { group: string; span: number }[] = [];
    for (const c of columns) {
      const last = out.at(-1);
      if (last && last.group === c.group) last.span += 1;
      else out.push({ group: c.group, span: 1 });
    }
    return out;
  }, [columns]);

  const download = () => {
    const blob = new Blob([`﻿${csvOf(columns, data.rows)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hieu-qua-marketing-${data.period.fromKey ?? "all"}_${data.period.toKey ?? "all"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div className="text-xs text-muted-foreground">{data.rows.length} ngày</div>
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
                <Columns3 className="mr-1 size-3.5" /> Cột
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 overflow-y-auto">
              <DropdownMenuLabel className="text-xs">Chọn cột hiển thị</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {MARKETING_METRICS.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.key}
                  checked={keys.includes(m.key)}
                  onCheckedChange={(on) => {
                    const base = custom ?? MARKETING_VIEW_COLUMNS[view];
                    setCustom(on ? MARKETING_METRICS.filter((x) => base.includes(x.key) || x.key === m.key).map((x) => x.key) : base.filter((k) => k !== m.key));
                  }}
                  className="text-xs"
                >
                  {MARKETING_GROUP_LABEL[m.group]} · {m.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={download}>
            <Download className="mr-1 size-3.5" /> CSV
          </Button>
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 z-20 bg-background">
            <TableRow>
              <TableHead className="sticky left-0 z-30 bg-background" />
              {groups.map((g, i) => (
                <TableHead key={`${g.group}-${i}`} colSpan={g.span} className="border-l text-center text-[10px] uppercase tracking-wide text-muted-foreground">
                  {MARKETING_GROUP_LABEL[g.group as keyof typeof MARKETING_GROUP_LABEL]}
                </TableHead>
              ))}
            </TableRow>
            <TableRow>
              {/* Cột ngày dính trái: cuộn ngang 28 cột mà mất ngày thì không còn đọc được dòng nào. */}
              <TableHead className="sticky left-0 z-30 whitespace-nowrap bg-background">Ngày</TableHead>
              {columns.map((c) => (
                <HeaderCell key={c.key} spec={c} />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => {
              const mature = row.maturity === "FINAL" || row.maturity === "PARTIAL";
              return (
                <TableRow key={row.day} className={cn(!mature && "opacity-70")}>
                  <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-background font-medium">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help">{row.day.slice(8)}/{row.day.slice(5, 7)}</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">
                        <p className="font-medium">{MATURITY_LABEL[row.maturity]}</p>
                        <p>{MATURITY_HINT[row.maturity]}</p>
                        {row.duplicates.orders > 0 ? <p className="mt-1">Đã loại {row.duplicates.orders} đơn trùng khỏi ngày này.</p> : null}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  {columns.map((c) => {
                    const v = cellValue(c, row as unknown as Record<string, unknown>);
                    return (
                      <TableCell key={c.key} className={cn("whitespace-nowrap text-right tabular-nums", toneFor(c, v, mature))}>
                        {renderValue(c, v)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
          <tfoot className="sticky bottom-0 z-20 bg-background">
            <TableRow className="font-semibold">
              <TableCell className="sticky left-0 z-30 bg-background">Tổng</TableCell>
              {columns.map((c) => {
                const v = cellValue(c, data.totals as unknown as Record<string, unknown>);
                return (
                  <TableCell key={c.key} className="whitespace-nowrap text-right tabular-nums">
                    {renderValue(c, v)}
                  </TableCell>
                );
              })}
            </TableRow>
          </tfoot>
        </Table>
      </div>
    </div>
  );
}
