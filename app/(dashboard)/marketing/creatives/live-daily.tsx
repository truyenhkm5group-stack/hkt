"use client";

import { useState } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatNumber, formatVND } from "@/lib/format";
import type { VariantDayPoint } from "@/lib/queries/creative-loop";

/**
 * ═══════════ "THEO NGÀY" — MỘT CAMP, TỪNG NGÀY ═══════════
 *
 * Hai biểu đồ NHỎ chứ không một biểu đồ hai trục: chi là ĐỒNG, tin nhắn / đơn là SỐ ĐẾM — hai thang đo trên một khung là
 * mời người đọc so hai thứ không so được. Ngày không có dòng chi để TRỐNG cột (CHƯA BIẾT), không vẽ cột 0. Bảng số bên
 * dưới là bản đọc được của cùng dữ liệu (mọi ngày, kể cả ngày trống) và dòng cộng khớp với dòng camp trên bảng chính.
 * Kỳ lấy từ URL của trang — cùng kỳ với bảng.
 */

type Series = { ok: true; periodLabel: string; points: VariantDayPoint[]; truncated: boolean } | { ok: false; error: string };

const spendConfig = { spend: { label: "Chi", color: "var(--chart-1)" } } satisfies ChartConfig;
const countConfig = { messages: { label: "Tin nhắn", color: "var(--chart-1)" }, orders: { label: "Đơn chốt", color: "var(--chart-2)" } } satisfies ChartConfig;

const shortDay = (day: string) => {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
};

function sumOf(points: VariantDayPoint[], pick: (p: VariantDayPoint) => number | null): number | null {
  return points.reduce<number | null>((s, p) => (pick(p) === null ? s : (s ?? 0) + (pick(p) as number)), null);
}

export function DailyButton({ variantId, name }: { variantId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(false);

  const mo = async () => {
    setOpen(true);
    setLoading(true);
    try {
      const cur = new URLSearchParams(window.location.search);
      const q = new URLSearchParams({ variant: variantId });
      for (const k of ["period", "from", "to"]) {
        const v = cur.get(k);
        if (v) q.set(k, v);
      }
      const res = await fetch(`/api/creative/live-daily?${q.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as Series;
      setData(res.ok ? json : { ok: false, error: "error" in json ? json.error : `Lỗi ${res.status}` });
    } catch {
      setData({ ok: false, error: "Không tải được số theo ngày." });
    } finally {
      setLoading(false);
    }
  };

  const points = data?.ok ? data.points : [];
  const rows = points.map((p) => ({ day: p.day, spend: p.spendVnd, messages: p.messages, orders: p.bookedOrders }));

  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => void mo()}>
        <BarChart3 className="size-3.5" />
        Theo ngày
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-6">{name || "Camp"}</DialogTitle>
            <DialogDescription>{data?.ok ? `Theo ngày · kỳ “${data.periodLabel}”${data.truncated ? " · chỉ 90 ngày gần nhất" : ""}. Chi theo ngày chi, đơn theo ngày lên đơn.` : "Theo ngày"}</DialogDescription>
          </DialogHeader>
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Đang tải…
            </div>
          ) : data && !data.ok ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{data.error}</p>
          ) : data?.ok && points.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Kỳ này camp chưa chạy ngày nào.</p>
          ) : data?.ok ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <figure>
                  <figcaption className="mb-1 text-[12px] font-medium text-muted-foreground">Chi theo ngày</figcaption>
                  <ChartContainer config={spendConfig} className="h-[180px] w-full">
                    <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={20} tickFormatter={shortDay} fontSize={11} />
                      <YAxis tickLine={false} axisLine={false} width={44} fontSize={11} tickFormatter={(v) => formatVND(Number(v), { compact: true })} />
                      <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent labelFormatter={(v) => `Ngày ${shortDay(String(v))}`} formatter={(v) => <span className="numeric font-semibold">{formatVND(v === null || v === undefined ? null : Number(v))}</span>} />} />
                      <Bar dataKey="spend" fill="var(--color-spend)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    </BarChart>
                  </ChartContainer>
                </figure>
                <figure>
                  <figcaption className="mb-1 text-[12px] font-medium text-muted-foreground">Tin nhắn · đơn chốt theo ngày</figcaption>
                  <ChartContainer config={countConfig} className="h-[180px] w-full">
                    <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }} barGap={2}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={20} tickFormatter={shortDay} fontSize={11} />
                      <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} allowDecimals={false} />
                      <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent labelFormatter={(v) => `Ngày ${shortDay(String(v))}`} />} />
                      <Bar dataKey="messages" fill="var(--color-messages)" radius={[4, 4, 0, 0]} maxBarSize={16} />
                      <Bar dataKey="orders" fill="var(--color-orders)" radius={[4, 4, 0, 0]} maxBarSize={16} />
                      <ChartLegend content={<ChartLegendContent />} />
                    </BarChart>
                  </ChartContainer>
                </figure>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-muted/60 text-[11.5px] text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Ngày</th>
                      <th className="px-2 py-1.5 text-right font-medium">Chi</th>
                      <th className="px-2 py-1.5 text-right font-medium">Hiển thị</th>
                      <th className="px-2 py-1.5 text-right font-medium">Nhấp</th>
                      <th className="px-2 py-1.5 text-right font-medium">Tin</th>
                      <th className="px-2 py-1.5 text-right font-medium">Đơn</th>
                      <th className="px-2 py-1.5 text-right font-medium">Giao / hoàn</th>
                      <th className="px-2 py-1.5 text-right font-medium">DT lên đơn</th>
                    </tr>
                  </thead>
                  <tbody className="numeric">
                    {[...points].reverse().map((p) => (
                      <tr key={p.day} className="border-t border-hairline">
                        <td className="px-2 py-1">{shortDay(p.day)}</td>
                        <td className="px-2 py-1 text-right">{formatVND(p.spendVnd)}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(p.impressions)}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(p.clicks)}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(p.messages)}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(p.bookedOrders)}</td>
                        <td className="px-2 py-1 text-right">
                          {formatNumber(p.deliveredOrders)} / {formatNumber(p.returnedOrders)}
                        </td>
                        <td className="px-2 py-1 text-right">{formatVND(p.bookedRevenueVnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="sticky bottom-0 bg-muted/60 font-semibold numeric">
                    <tr className="border-t">
                      <td className="px-2 py-1.5">Cộng</td>
                      <td className="px-2 py-1.5 text-right">{formatVND(sumOf(points, (p) => p.spendVnd))}</td>
                      <td className="px-2 py-1.5 text-right">{formatNumber(sumOf(points, (p) => p.impressions))}</td>
                      <td className="px-2 py-1.5 text-right">{formatNumber(sumOf(points, (p) => p.clicks))}</td>
                      <td className="px-2 py-1.5 text-right">{formatNumber(sumOf(points, (p) => p.messages))}</td>
                      <td className="px-2 py-1.5 text-right">{formatNumber(sumOf(points, (p) => p.bookedOrders))}</td>
                      <td className="px-2 py-1.5 text-right">
                        {formatNumber(sumOf(points, (p) => p.deliveredOrders))} / {formatNumber(sumOf(points, (p) => p.returnedOrders))}
                      </td>
                      <td className="px-2 py-1.5 text-right">{formatVND(sumOf(points, (p) => p.bookedRevenueVnd))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
