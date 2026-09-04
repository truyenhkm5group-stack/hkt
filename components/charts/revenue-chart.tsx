"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { formatVND } from "@/lib/format";

const config = {
  revenue: { label: "Doanh thu lên đơn", color: "var(--chart-2)" },
  successRevenue: { label: "Doanh thu giao thành công", color: "var(--chart-1)" },
  orders: { label: "Số đơn", color: "var(--chart-2)" },
} satisfies ChartConfig;

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

export function RevenueChart({ data }: { data: { day: string; revenue: number; successRevenue: number; orders: number }[] }) {
  if (!data.length) return <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">Chưa có dữ liệu trong kỳ này</div>;
  return (
    <ChartContainer config={config} className="h-[260px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-revenue)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--color-revenue)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fillSuccess" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-successRevenue)" stopOpacity={0.4} />
            <stop offset="95%" stopColor="var(--color-successRevenue)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} fontSize={11} />
        <YAxis tickLine={false} axisLine={false} width={44} fontSize={11} tickFormatter={(v) => formatVND(Number(v), { compact: true })} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(value) => `Ngày ${shortDay(String(value))}`} formatter={(value, name) => (
          <div className="flex w-full items-center justify-between gap-4">
            <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
            <span className="numeric font-semibold">{formatVND(Number(value))}</span>
          </div>
        )} indicator="dot" />} />
        <Area dataKey="revenue" type="monotone" fill="url(#fillRevenue)" stroke="var(--color-revenue)" strokeWidth={2} />
        <Area dataKey="successRevenue" type="monotone" fill="url(#fillSuccess)" stroke="var(--color-successRevenue)" strokeWidth={2} />
        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  );
}

export function OrdersBarChart({ data }: { data: { day: string; orders: number; success: number }[] }) {
  if (!data.length) return null;
  return (
    <ChartContainer config={{ orders: { label: "Đơn lên", color: "var(--chart-2)" }, success: { label: "Giao thành công", color: "var(--chart-3)" } }} className="h-[180px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} fontSize={11} />
        <YAxis tickLine={false} axisLine={false} width={30} fontSize={11} allowDecimals={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(value) => `Ngày ${shortDay(String(value))}`} />} />
        <Bar dataKey="orders" fill="var(--color-orders)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="success" fill="var(--color-success)" radius={[4, 4, 0, 0]} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}
