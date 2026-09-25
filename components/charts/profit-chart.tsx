"use client";

import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { formatVND } from "@/lib/format";

const config = {
  revenue: { label: "Doanh thu giao thành công", color: "var(--chart-2)" },
  grossProfit: { label: "Lãi gộp", color: "var(--chart-3)" },
  netProfit: { label: "Lợi nhuận ròng", color: "var(--chart-1)" },
} satisfies ChartConfig;

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

type Key = keyof typeof config;

/**
 * Doanh thu (cột) so với lãi gộp và lợi nhuận ròng (đường) theo ngày.
 *
 * `labels` đổi TÊN ba chuỗi cho bảng dùng nó (Lợi nhuận danh nghĩa gọi hai đường là "LN danh
 * nghĩa ƯT" / "LN ròng ƯT", không phải "lãi gộp"). Giá trị `null` là CHƯA BIẾT (ngày chưa có số
 * chi quảng cáo): đường ĐỨT tại đó và chú giải in "—", không vẽ một điểm 0 ₫ (AGENTS.md mục 42).
 */
export function ProfitChart({
  data,
  labels,
  height = 280,
}: {
  data: { day: string; revenue: number; grossProfit: number | null; netProfit: number | null }[];
  labels?: Partial<Record<Key, string>>;
  height?: number;
}) {
  const cfg = labels ? (Object.fromEntries((Object.keys(config) as Key[]).map((k) => [k, { ...config[k], label: labels[k] ?? config[k].label }])) as typeof config) : config;
  if (!data.length) return <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>Chưa có dữ liệu trong kỳ này</div>;
  return (
    <ChartContainer config={cfg} className="w-full" style={{ height }}>
      <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} fontSize={11} />
        <YAxis tickLine={false} axisLine={false} width={48} fontSize={11} tickFormatter={(v) => formatVND(Number(v), { compact: true })} />
        <ReferenceLine y={0} stroke="var(--border)" />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `Ngày ${shortDay(String(value))}`}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ backgroundColor: String(item.color ?? "") }} />
                    {cfg[name as Key]?.label ?? name}
                  </span>
                  <span className={`numeric font-semibold ${Number(value) < 0 ? "text-destructive" : ""}`}>{formatVND(value === null || value === undefined ? null : Number(value))}</span>
                </div>
              )}
            />
          }
        />
        <Bar dataKey="revenue" fill="var(--color-revenue)" fillOpacity={0.55} radius={[4, 4, 0, 0]} />
        <Line dataKey="grossProfit" type="monotone" stroke="var(--color-grossProfit)" strokeWidth={2} dot={false} />
        <Line dataKey="netProfit" type="monotone" stroke="var(--color-netProfit)" strokeWidth={2.5} dot={false} />
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}
