"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

const dailyConfig = {
  erpWaiting: { label: "ERP: chờ hàng (phân bổ tồn)", color: "var(--chart-1)" },
  pancakeWaiting: { label: "Pancake: trạng thái “Chờ hàng”", color: "var(--chart-2)" },
} satisfies ChartConfig;

/**
 * Số đơn chờ hàng theo ngày — hai nguồn, hai cột cạnh nhau, KHÔNG chồng (một đơn có thể nằm ở cả hai
 * nguồn, cộng lại là đếm hai lần). Ngày ERP chưa đo thì không có cột ERP và tooltip in "chưa đo".
 */
export function DailyWaitingChart({ data }: { data: { day: string; erpWaiting: number | null; pancakeWaiting: number }[] }) {
  if (!data.length) return <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">Không có ngày nào trong kỳ</div>;
  return (
    <ChartContainer config={dailyConfig} className="h-[220px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }} barGap={2}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={20} tickFormatter={shortDay} fontSize={11} />
        <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} allowDecimals={false} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `Ngày ${shortDay(String(value))}`}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ backgroundColor: String(item.color ?? "") }} />
                    {dailyConfig[name as keyof typeof dailyConfig]?.label ?? name}
                  </span>
                  <span className="numeric font-semibold">{value === null || value === undefined ? "chưa đo" : `${Number(value)} đơn`}</span>
                </div>
              )}
            />
          }
        />
        <Bar dataKey="erpWaiting" fill="var(--color-erpWaiting)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="pancakeWaiting" fill="var(--color-pancakeWaiting)" radius={[4, 4, 0, 0]} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}

const rateConfig = { rate: { label: "Tỷ lệ giao thành công", color: "var(--chart-1)" } } satisfies ChartConfig;

/**
 * GTC theo khoảng ngày chờ — một chuỗi, một màu. Khoảng chưa đủ mẫu KHÔNG có cột (không vẽ 0%), và
 * tooltip nói rõ số đơn đã kết thúc đứng sau mỗi cột.
 */
export function WaitRateChart({ data }: { data: { label: string; rate: number | null; finished: number }[] }) {
  return (
    <ChartContainer config={rateConfig} className="h-[220px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={0} />
        <YAxis tickLine={false} axisLine={false} width={40} fontSize={11} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const finished = Number((item.payload as { finished?: number })?.finished ?? 0);
                return (
                  <div className="flex w-full items-center justify-between gap-4">
                    <span className="text-muted-foreground">GTC · {finished} đơn đã kết thúc</span>
                    <span className="numeric font-semibold">{value === null || value === undefined ? "chưa đủ mẫu" : `${Number(value).toFixed(1)}%`}</span>
                  </div>
                );
              }}
            />
          }
        />
        <Bar dataKey="rate" fill="var(--color-rate)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
