"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { formatNumber } from "@/lib/format";

const config = {
  quantity: { label: "Số lượng bán", color: "var(--chart-1)" },
  orders: { label: "Số đơn", color: "var(--chart-2)" },
} satisfies ChartConfig;

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

/** Biểu đồ cột số lượng bán theo ngày của một sản phẩm */
export function ProductSalesChart({ data }: { data: { day: string; quantity: number; orders: number }[] }) {
  if (!data.length || data.every((d) => d.quantity === 0)) return <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">Chưa có lượt bán trong 30 ngày qua</div>;
  return (
    <ChartContainer config={config} className="h-[220px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} fontSize={11} />
        <YAxis tickLine={false} axisLine={false} width={30} fontSize={11} allowDecimals={false} />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `Ngày ${shortDay(String(value))}`}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
                  <span className="numeric font-semibold">
                    {formatNumber(Number(value))}
                    {name === "quantity" ? ` sp · ${formatNumber(Number((item?.payload as { orders?: number } | undefined)?.orders ?? 0))} đơn` : ""}
                  </span>
                </div>
              )}
              indicator="dot"
            />
          }
        />
        <Bar dataKey="quantity" fill="var(--color-quantity)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
