"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { AD_PLATFORM_COLOR } from "@/lib/constants/expenses";
import { formatVND } from "@/lib/format";

const FALLBACK_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

/**
 * Cột chồng: chi tiêu quảng cáo theo ngày, mỗi màu một nền tảng.
 * `data` là các dòng { day, [platform]: spend }.
 */
export function AdsChart({ data, platforms }: { data: Record<string, number | string>[]; platforms: string[] }) {
  const { config, rows, keys } = useMemo(() => {
    const keys = platforms.map((p, i) => ({ platform: p, key: `s${i}` }));
    const config = Object.fromEntries(keys.map(({ platform, key }, i) => [key, { label: platform, color: AD_PLATFORM_COLOR[platform] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] }])) satisfies ChartConfig;
    const rows = data.map((row) => {
      const out: Record<string, number | string> = { day: String(row.day) };
      for (const { platform, key } of keys) out[key] = Number(row[platform] ?? 0);
      return out;
    });
    return { config, rows, keys };
  }, [data, platforms]);

  if (!rows.length) return <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">Chưa có chi tiêu quảng cáo trong kỳ này</div>;

  return (
    <ChartContainer config={config} className="h-[240px] w-full">
      <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} fontSize={11} />
        <YAxis tickLine={false} axisLine={false} width={44} fontSize={11} tickFormatter={(v) => formatVND(Number(v), { compact: true })} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `Ngày ${shortDay(String(value))}`}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ backgroundColor: String(item.color ?? "") }} />
                    {config[name as keyof typeof config]?.label ?? name}
                  </span>
                  <span className="numeric font-semibold">{formatVND(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        {keys.map(({ key }, i) => (
          <Bar key={key} dataKey={key} stackId="spend" fill={`var(--color-${key})`} radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} />
        ))}
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}
