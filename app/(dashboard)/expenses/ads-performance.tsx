import Link from "next/link";
import { Award, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatVND } from "@/lib/format";
import type { AdsPerformance, PerfRating, PerfRow } from "@/lib/queries/ads-performance";
import { cn } from "@/lib/utils";

const RATING: Record<PerfRating, { label: string; cls: string }> = {
  GOOD: { label: "Tốt", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" },
  AVERAGE: { label: "Trung bình", cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" },
  POOR: { label: "Kém", cls: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" },
  NONE: { label: "—", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
};

const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(0)}%`);
const x = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(2)}×`);

function Highlight({ icon: Icon, label, row, tone, metric }: { icon: typeof Award; label: string; row: PerfRow | null; tone: string; metric: (r: PerfRow) => string }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border p-3", tone)}>
      <Icon className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 text-[13px]">
        <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
        {row ? (
          <>
            <div className="truncate font-semibold">{row.code ? `${row.code} · ` : ""}{row.name}</div>
            <div className="opacity-80">{metric(row)}</div>
          </>
        ) : <div className="opacity-70">Chưa đủ dữ liệu</div>}
      </div>
    </div>
  );
}

function PerfTable({ rows, kind, avgRoas, spendTotal }: { rows: PerfRow[]; kind: "marketer" | "product"; avgRoas: number | null; spendTotal: number }) {
  const maxSpend = Math.max(1, ...rows.map((r) => r.spend));
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead>{kind === "marketer" ? "Marketer" : "Mã hàng"}</TableHead>
            <TableHead className="text-right">Chi QC · tỷ trọng</TableHead>
            <TableHead className="text-right">Tin nhắn · giá/tin</TableHead>
            <TableHead className="text-right">Đơn · CPO</TableHead>
            <TableHead className="text-right">Doanh số · ROAS</TableHead>
            <TableHead className="text-right">{kind === "marketer" ? "LN cá nhân · biên" : "LN sau QC · biên"}</TableHead>
            {kind === "product" ? <TableHead className="text-right" title="Giao thành công (COD thực > 100K) / không thành công · tỷ lệ giao thành công trên đơn đã kết thúc · dự kiến">Giao TC / không TC · TL GTC</TableHead> : <TableHead className="text-right">QC test</TableHead>}
            <TableHead>Đánh giá</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">Chưa có chi tiêu quảng cáo trong kỳ.</TableCell></TableRow>
          ) : rows.map((r) => {
            const rt = RATING[r.rating];
            const special = r.id.startsWith("__");
            return (
              <TableRow key={r.id} className={cn(special && "bg-muted/30 text-muted-foreground")}>
                <TableCell>
                  <div className="font-medium">
                    {kind === "product" && !special ? <Link href={`/reports?product=${r.id}`} className="hover:underline">{r.code ? `${r.code} · ` : ""}{r.name}</Link> : r.name}
                  </div>
                  <div className="text-xs text-muted-foreground">{r.campaigns ? `${formatNumber(r.campaigns)} chiến dịch` : "—"}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div className="font-semibold">{formatVND(r.spend)}</div>
                  <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                    <span className="h-1.5 w-20 overflow-hidden rounded bg-muted"><span className="block h-full rounded bg-rose-400" style={{ width: `${Math.round((r.spend / maxSpend) * 100)}%` }} /></span>
                    {pct(r.spendShare)}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div>{formatNumber(r.messages)}</div>
                  <div className="text-xs text-muted-foreground">{r.costPerMessage ? formatVND(r.costPerMessage) : "—"}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div>{formatNumber(r.orders)}</div>
                  <div className="text-xs text-muted-foreground">{r.cpo ? formatVND(r.cpo) : "—"}{r.fbOrders ? ` · FB báo ${formatNumber(r.fbOrders)}` : ""}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div>{formatVND(r.revenue, { compact: true })}</div>
                  <div className={cn("text-xs", r.roas !== null && avgRoas ? (r.roas >= avgRoas * 1.2 ? "text-emerald-700" : r.roas < avgRoas * 0.8 ? "text-rose-600" : "text-muted-foreground") : "text-muted-foreground")}>{x(r.roas)}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div className={cn("font-semibold", r.profit < 0 ? "text-rose-600" : "text-emerald-700")}>{formatVND(r.profit, { compact: true })}</div>
                  <div className="text-xs text-muted-foreground">{pct(r.margin)}</div>
                </TableCell>
                {kind === "product" ? (
                  <TableCell className="text-right tabular-nums text-xs">
                    {r.delivered !== undefined ? <div>{formatNumber(r.delivered)} / {formatNumber(r.returned ?? 0)}</div> : <div>—</div>}
                    <div className={cn((r.successRate ?? r.expectedSuccessRate ?? 1) < 0.65 ? "text-rose-600" : "text-emerald-700")} title="Tỷ lệ giao thành công thực tế trên đơn đã kết thúc · dự kiến (đã trộn đơn chưa kết thúc)">
                      {r.successRate !== null && r.successRate !== undefined ? pct(r.successRate) : "—"}{r.expectedSuccessRate !== undefined ? <span className="text-muted-foreground"> · dự kiến {pct(r.expectedSuccessRate)}</span> : null}
                    </div>
                  </TableCell>
                ) : (
                  <TableCell className="text-right tabular-nums text-xs">
                    <div>{r.testSpend ? formatVND(r.testSpend, { compact: true }) : "—"}</div>
                    <div className="text-muted-foreground">{r.testSpend && r.spend ? pct(r.testSpend / r.spend) : ""}</div>
                  </TableCell>
                )}
                <TableCell className="max-w-[220px]">
                  <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", rt.cls)}>{rt.label}</span>
                  <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{r.reason}</div>
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length ? (
            <TableRow className="bg-muted/40 font-semibold">
              <TableCell>Tổng</TableCell>
              <TableCell className="text-right tabular-nums">{formatVND(spendTotal)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(rows.reduce((s, r) => s + r.messages, 0))}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(rows.reduce((s, r) => s + r.orders, 0))}</TableCell>
              <TableCell className="text-right tabular-nums">{formatVND(rows.reduce((s, r) => s + r.revenue, 0), { compact: true })} · {x(avgRoas)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatVND(rows.reduce((s, r) => s + r.profit, 0), { compact: true })}</TableCell>
              <TableCell />
              <TableCell />
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

export function AdsPerformancePanel({ perf, periodLabel }: { perf: AdsPerformance; periodLabel: string }) {
  const money = (r: PerfRow) => `ROAS ${x(r.roas)} · LN ${formatVND(r.profit, { compact: true })} · chi ${formatVND(r.spend, { compact: true })}`;
  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Highlight icon={Award} label="Marketer hiệu quả nhất" row={perf.bestMarketer} tone="border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" metric={money} />
        <Highlight icon={ThumbsDown} label="Marketer cần xem lại" row={perf.worstMarketer} tone="border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100" metric={money} />
        <Highlight icon={ThumbsUp} label="Mã hàng chạy tốt nhất" row={perf.bestProduct} tone="border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" metric={money} />
        <Highlight icon={TriangleAlert} label="Mã hàng chạy kém nhất" row={perf.worstProduct} tone="border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100" metric={money} />
      </section>
      <SectionCard
        padded={false}
        title="Hiệu quả theo Marketer"
        description="Đơn = đơn đã xác nhận (không tính huỷ) của từng mã chia cho marketer theo ghi nhận của Lương: ad_id tạo đơn → fanpage → tỷ trọng tiền QC → chủ mã; đơn không gắn được ai nằm ở “Chưa gán marketer” nên tổng luôn bằng thẻ Đơn đã xác nhận (đơn landing page chỉ tính khi đã gửi POS thành đơn Pancake). Doanh số = DT giao thành công ước tính của phần đơn đó. LN cá nhân theo Lương (trên đơn giao thành công): LN phân bổ − QC mã hàng − QC test ± % chủ mã, chưa trừ chi phí vận hành. ROAS so với trung bình toàn shop: ≥ +20% Tốt, ≤ −20% hoặc lỗ = Kém."
        actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{periodLabel} · ROAS TB {x(perf.totals.roas)}</span>}
      >
        <PerfTable rows={perf.marketers} kind="marketer" avgRoas={perf.totals.roas} spendTotal={perf.totals.spend} />
      </SectionCard>
      <SectionCard
        padded={false}
        title="Hiệu quả theo mã hàng"
        description="Đơn Pancake đã xác nhận trong kỳ theo mã. Doanh số = DT giao thành công ước tính (đã trừ tỷ lệ hoàn dự kiến). LN sau QC = LN ròng ước tính của Báo cáo lợi nhuận danh nghĩa: đã trừ giá vốn, ship (đơn giao & đơn hoàn), QC, đóng hàng, nhân viên vận đơn, chi phí vận hành & cố định phân bổ, rủi ro tồn kho, thuế, chi phí khác. Giao thành công = đơn có doanh thu COD thực > 100K (không phụ thuộc trạng thái Viettel Post); không thành công = hoàn hoặc giao nhưng COD ≤ 100K. Tỷ lệ giao thành công = giao TC / (giao TC + không TC) trên đơn đã kết thúc, kèm tỷ lệ dự kiến cho đơn chưa kết thúc. Mã có tỷ lệ giao thành công < 65% được cảnh báo dù ROAS tốt."
        actions={<Link href="/reports" className="text-xs font-medium text-primary hover:underline">Xem báo cáo lợi nhuận →</Link>}
      >
        <PerfTable rows={perf.products} kind="product" avgRoas={perf.totals.roas} spendTotal={perf.totals.spend} />
      </SectionCard>
    </div>
  );
}
