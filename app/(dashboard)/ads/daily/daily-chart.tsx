"use client";

import { useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { ratioOf } from "@/lib/constants/marketing-daily";
import { formatVND } from "@/lib/format";
import type { MarketingDailyRow } from "@/lib/queries/marketing-daily";
import { cn } from "@/lib/utils";

/**
 * ───────────── XU HƯỚNG THEO NGÀY ─────────────
 *
 * Bốn cách nhìn, một khung: chi vs doanh thu · lợi nhuận · đơn · các tỷ lệ. Người xem chỉ nhìn
 * được một chuyện một lúc; chồng cả bảy đường lên một khung là biểu đồ không đọc được.
 *
 * ─── ĐƯỜNG TRUNG BÌNH 7 NGÀY LUÔN CÓ MẶT ─────
 *
 * Một ngày xấu có thể chỉ là một ngày xấu. Quyết định cắt ngân sách dựa trên một cột đơn lẻ là
 * loại quyết định đắt nhất của bảng này, nên đường trung bình động đứng ngay cạnh cột — không
 * phải một tuỳ chọn phải đi bật.
 */

const VIEWS = [
  { key: "money", label: "Chi & doanh thu" },
  { key: "profit", label: "Lợi nhuận" },
  { key: "orders", label: "Đơn" },
  { key: "rates", label: "Tỷ lệ" },
] as const;
type ChartView = (typeof VIEWS)[number]["key"];

function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

/** Trung bình động 7 ngày. Chưa đủ 7 ngày thì trả `null` — vẽ một trung bình 2 ngày là vẽ một lời hứa. */
function rolling(values: (number | null)[], window = 7): (number | null)[] {
  return values.map((_, i) => {
    if (i + 1 < window) return null;
    const slice = values.slice(i + 1 - window, i + 1);
    if (slice.some((v) => v === null)) return null;
    return (slice as number[]).reduce((s, v) => s + v, 0) / window;
  });
}

export function MarketingDailyChart({ rows }: { rows: MarketingDailyRow[] }) {
  const [view, setView] = useState<ChartView>("money");

  const data = useMemo(() => {
    const asRecord = (r: MarketingDailyRow) => r as unknown as Record<string, unknown>;
    const profit = rows.map((r) => r.contributionProfit);
    const profitAvg = rolling(profit);
    const cpo = rows.map((r) => ratioOf("costPerOrder", asRecord(r)));
    const cpoAvg = rolling(cpo);
    return rows.map((r, i) => ({
      day: r.day,
      adSpend: r.adSpend,
      deliveredRevenue: r.deliveredRevenue,
      posRevenue: r.posRevenue,
      profit: r.contributionProfit,
      profitAvg: profitAvg[i],
      orders: r.orders,
      deliveredOrders: r.deliveredOrders,
      cpo: cpo[i],
      cpoAvg: cpoAvg[i],
      margin: ratioOf("margin", asRecord(r)),
      roas: ratioOf("roasDelivered", asRecord(r)),
      deliveryRate: ratioOf("deliveryRate", asRecord(r)),
      closeRate: ratioOf("closeRate", asRecord(r)),
    }));
  }, [rows]);

  const config = {
    adSpend: { label: "Chi QC", color: "var(--chart-4)" },
    deliveredRevenue: { label: "Doanh thu thực", color: "var(--chart-1)" },
    posRevenue: { label: "Doanh số POS", color: "var(--chart-2)" },
    profit: { label: "Lợi nhuận góp", color: "var(--chart-1)" },
    profitAvg: { label: "TB 7 ngày", color: "var(--chart-3)" },
    orders: { label: "Đơn xác nhận", color: "var(--chart-2)" },
    deliveredOrders: { label: "Giao thành công", color: "var(--chart-1)" },
    cpo: { label: "CPQC/đơn", color: "var(--chart-4)" },
    cpoAvg: { label: "CPQC/đơn TB 7 ngày", color: "var(--chart-3)" },
    margin: { label: "Margin %", color: "var(--chart-1)" },
    roas: { label: "ROAS thực", color: "var(--chart-2)" },
    deliveryRate: { label: "Tỷ lệ giao %", color: "var(--chart-5)" },
    closeRate: { label: "Tỷ lệ chốt %", color: "var(--chart-3)" },
  } satisfies ChartConfig;

  if (!rows.length) return <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">Chưa có dữ liệu trong kỳ này</div>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <Button key={v.key} variant={v.key === view ? "default" : "ghost"} size="sm" className={cn("h-7 px-2 text-xs")} onClick={() => setView(v.key)}>
            {v.label}
          </Button>
        ))}
      </div>
      <ChartContainer config={config} className="h-[280px] w-full">
        <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} fontSize={11} />
          <YAxis tickLine={false} axisLine={false} width={48} fontSize={11} tickFormatter={(v) => (view === "orders" || view === "rates" ? String(v) : formatVND(Number(v), { compact: true }))} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => `Ngày ${shortDay(String(v))}`} />} />
          {/* Mốc 0 hiện rõ ở khung lợi nhuận: phân biệt "lãi mỏng" với "đang lỗ" là việc của một đường kẻ. */}
          {view === "profit" ? <ReferenceLine y={0} stroke="var(--border)" /> : null}

          {view === "money" ? (
            <>
              <Bar dataKey="adSpend" fill="var(--color-adSpend)" radius={2} />
              <Line dataKey="deliveredRevenue" stroke="var(--color-deliveredRevenue)" dot={false} strokeWidth={2} />
              <Line dataKey="posRevenue" stroke="var(--color-posRevenue)" dot={false} strokeWidth={1} strokeDasharray="4 3" />
            </>
          ) : null}
          {view === "profit" ? (
            <>
              <Bar dataKey="profit" fill="var(--color-profit)" radius={2} />
              <Line dataKey="profitAvg" stroke="var(--color-profitAvg)" dot={false} strokeWidth={2} />
            </>
          ) : null}
          {view === "orders" ? (
            <>
              <Bar dataKey="orders" fill="var(--color-orders)" radius={2} />
              <Bar dataKey="deliveredOrders" fill="var(--color-deliveredOrders)" radius={2} />
            </>
          ) : null}
          {view === "rates" ? (
            <>
              <Line dataKey="margin" stroke="var(--color-margin)" dot={false} strokeWidth={2} connectNulls={false} />
              <Line dataKey="deliveryRate" stroke="var(--color-deliveryRate)" dot={false} strokeWidth={2} connectNulls={false} />
              <Line dataKey="closeRate" stroke="var(--color-closeRate)" dot={false} strokeWidth={2} connectNulls={false} />
            </>
          ) : null}
        </ComposedChart>
      </ChartContainer>
      {/*
        `connectNulls={false}` là một quyết định, không phải mặc định: ngày không có mẫu số (0 tin
        nhắn, 0 đơn kết thúc) phải để ĐỨT đoạn. Nối liền qua nó là vẽ ra một giá trị chưa từng đo.
      */}
      <p className="text-[11px] text-muted-foreground">Đường đứt đoạn = ngày chưa đo được tỷ lệ đó (mẫu số bằng 0). Cố ý không nối liền — nối là vẽ ra một giá trị chưa từng tồn tại.</p>
    </div>
  );
}
