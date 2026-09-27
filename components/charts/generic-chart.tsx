"use client";

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { ChartKind, ValueFormat } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BIỂU ĐỒ CHUNG CỦA TRANG ĐỘNG (Phase 4) ═══════════
 *
 * MỘT component cho ba dạng (cột · đường · tròn), nhận dữ liệu ĐÃ PHÂN GIẢI ở máy chủ (`ChartData`) — không đọc
 * CSDL, không nhận hàm từ Server Component (định dạng chọn theo `format`, một chuỗi).
 *
 * CHƯA BIẾT KHÔNG VẼ THÀNH 0 (luật 42): điểm `y = null` giữ nguyên `null` — cột bỏ trống, đường đứt quãng,
 * lát tròn bị loại và SỐ ĐIỂM THIẾU in dưới biểu đồ. Vẽ nó bằng 0 là nói "hôm đó không có đơn" khi sự thật là
 * "hôm đó chưa đo".
 */

const SERIES_COLOR = "var(--chart-2)";
const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function formatChartValue(value: number | null | undefined, format: ValueFormat, compact = false): string {
  if (format === "vnd") return formatVND(value, { compact });
  if (format === "percent") return formatPercent(value);
  return formatNumber(value);
}

/** Nhãn trục X: ngày `YYYY-MM-DD` ⇒ `DD/MM`; còn lại giữ nguyên (nhóm). */
function shortLabel(x: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(x);
  return m ? `${m[2]}/${m[1]}` : x;
}

export type GenericChartProps = {
  kind: ChartKind;
  format: ValueFormat;
  points: { x: string; y: number | null }[];
  label?: string;
  className?: string;
};

export function GenericChart({ kind, format, points, label = "Giá trị", className }: GenericChartProps) {
  const known = points.filter((p) => typeof p.y === "number" && Number.isFinite(p.y));
  const missing = points.length - known.length;
  if (points.length === 0 || known.length === 0) {
    return <div className={cn("flex h-[240px] items-center justify-center text-sm text-muted-foreground", className)}>{points.length === 0 ? "Chưa có dữ liệu trong kỳ này" : "Chưa có điểm nào đo được trong kỳ này"}</div>;
  }
  const config = { y: { label, color: SERIES_COLOR } } satisfies ChartConfig;
  const tooltip = (
    <ChartTooltip
      cursor={false}
      content={
        <ChartTooltipContent
          labelFormatter={(value) => shortLabel(String(value))}
          formatter={(value) => (
            <div className="flex w-full items-center justify-between gap-4">
              <span className="text-muted-foreground">{label}</span>
              <span className="numeric font-semibold">{formatChartValue(typeof value === "number" ? value : null, format)}</span>
            </div>
          )}
          indicator="dot"
        />
      }
    />
  );

  return (
    <div className={className}>
      <ChartContainer config={config} className="h-[240px] w-full">
        {kind === "pie" ? (
          <PieChart>
            {tooltip}
            <Pie data={known} dataKey="y" nameKey="x" innerRadius={48} strokeWidth={2}>
              {known.map((p, i) => (
                <Cell key={p.x} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        ) : kind === "line" ? (
          <LineChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortLabel} fontSize={11} />
            <YAxis tickLine={false} axisLine={false} width={48} fontSize={11} tickFormatter={(v) => formatChartValue(Number(v), format, true)} />
            {tooltip}
            <Line dataKey="y" type="monotone" stroke="var(--color-y)" strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        ) : (
          <BarChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortLabel} fontSize={11} />
            <YAxis tickLine={false} axisLine={false} width={48} fontSize={11} tickFormatter={(v) => formatChartValue(Number(v), format, true)} />
            {tooltip}
            <Bar dataKey="y" fill="var(--color-y)" radius={[4, 4, 0, 0]} />
          </BarChart>
        )}
      </ChartContainer>
      {kind === "pie" ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {known.map((p, i) => (
            <li key={p.x} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} aria-hidden />
              {p.x}: <span className="numeric font-semibold text-foreground">{formatChartValue(p.y, format)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {missing > 0 ? <p className="mt-1 text-xs text-muted-foreground">{missing} điểm chưa có số đo — để trống, không vẽ thành 0.</p> : null}
    </div>
  );
}
