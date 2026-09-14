"use client";

import { Bar, BarChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { ThroughputDay } from "@/lib/queries/return-warehouse-kpi";

/**
 * ═══════════ MỘT BIỂU ĐỒ, KHÔNG PHẢI SÁU ═══════════
 *
 * Yêu cầu nói rõ: ưu tiên 2–3 biểu đồ RA QUYẾT ĐỊNH, không nhồi. Ở đây chỉ cần MỘT, vì câu hỏi vận
 * hành duy nhất của kho hàng hoàn là *đếm có kịp nhận không?* — và câu đó chỉ đọc được khi hai
 * đường nằm CẠNH NHAU trên cùng một trục thời gian.
 *
 * NHẬN vẽ bằng CỘT, ĐẾM vẽ bằng ĐƯỜNG. Cố ý khác hình: hai dãy cột cạnh nhau bắt mắt phải so từng
 * cặp, còn một đường cắt qua các cột thì chỗ nào đường tụt xuống dưới cột là chỗ tồn đọng dâng lên
 * — thấy được ngay mà không phải đọc số.
 *
 * Số MÓN vào lại tồn cố ý KHÔNG vẽ ở đây: nó là đơn vị khác (món, không phải kiện) và đặt chung một
 * trục sẽ làm hai đường kia dẹt xuống thành vô nghĩa.
 */
const config = {
  receivedParcels: { label: "Kiện nhận", color: "var(--chart-2)" },
  inspectedParcels: { label: "Kiện đếm xong", color: "var(--chart-1)" },
} satisfies ChartConfig;

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

export function WarehouseTrendChart({ data }: { data: ThroughputDay[] }) {
  if (!data.some((d) => d.receivedParcels || d.inspectedParcels)) {
    return <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">Chưa có lượt nhận hay đếm nào trong kỳ này</div>;
  }
  return (
    <ChartContainer config={config} className="h-[220px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="receivedParcels" fill="var(--color-receivedParcels)" radius={[3, 3, 0, 0]} maxBarSize={22} />
        <Line dataKey="inspectedParcels" stroke="var(--color-inspectedParcels)" strokeWidth={2} dot={false} type="monotone" />
      </BarChart>
    </ChartContainer>
  );
}
