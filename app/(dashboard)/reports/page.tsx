import { Banknote, Boxes, Download, PackageCheck, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { ProfitChart } from "@/components/charts/profit-chart";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SourceBadge } from "@/components/status-badge";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatVND, pct } from "@/lib/format";
import { getProfitReport, parseBasis, REPORT_BASIS_LABEL, type PnlLines } from "@/lib/queries/reports";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Báo cáo lợi nhuận" };

function change(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Nhãn thay đổi so với kỳ trước; `invert` cho các dòng chi phí (tăng = xấu) */
function Delta({ current, previous, invert = false }: { current: number; previous: number | null | undefined; invert?: boolean }) {
  const value = change(current, previous);
  if (value === null || !Number.isFinite(value)) return <span className="text-xs text-muted-foreground">—</span>;
  const good = invert ? value <= 0 : value >= 0;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold", good ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
      {value >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

type LineDef = { label: string; key: keyof PnlLines; kind: "revenue" | "cost" | "subtotal" | "total"; note?: string };

const PNL_LINES: LineDef[] = [
  { label: "Doanh thu đơn giao thành công", key: "revenue", kind: "revenue", note: "Đơn ở trạng thái Đã nhận / Đã thu tiền" },
  { label: "(–) Giá vốn hàng bán", key: "cogs", kind: "cost", note: "Giá vốn của các đơn giao thành công" },
  { label: "= Lãi gộp", key: "grossProfit", kind: "subtotal" },
  { label: "(–) Phí vận chuyển", key: "shipping", kind: "cost", note: "Phí ĐVVC của đơn đã gửi hàng (không tính đơn huỷ)" },
  { label: "(–) Phí hoàn hàng", key: "returnFee", kind: "cost" },
  { label: "(–) Phí sàn TMĐT", key: "marketplaceFee", kind: "cost" },
  { label: "(–) Chi phí quảng cáo", key: "adSpend", kind: "cost", note: "Chi tiêu quảng cáo + chi phí nhóm Quảng cáo" },
  { label: "(–) Chi phí vận hành", key: "operating", kind: "cost", note: "Lương, mặt bằng, phần mềm, đóng gói, nhập hàng, khác" },
  { label: "= Lợi nhuận ròng", key: "netProfit", kind: "total" },
];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const period = resolvePeriod(raw, "month");
  const basis = parseBasis(param(raw, "basis"));
  const report = await getProfitReport(period, basis);
  const { current, previous, cash } = report;
  const exportQuery = new URLSearchParams({ period: period.key, basis, ...(period.key === "custom" ? { from: period.fromKey ?? "", to: period.toKey ?? "" } : {}) }).toString();
  const grossMargin = current.revenue ? (current.grossProfit / current.revenue) * 100 : 0;
  const totalOrders = current.orders + current.cancelled;
  const roas = current.adSpend ? current.adRevenue / current.adSpend : 0;
  const chartData = report.daily.map((d) => ({ day: d.day, revenue: d.revenue, grossProfit: d.grossProfit, netProfit: d.netProfit }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title="Báo cáo lợi nhuận"
        description={`${period.label} · ${REPORT_BASIS_LABEL[basis].toLowerCase()} · ${formatNumber(current.orders)} đơn · ${formatNumber(current.successOrders)} giao thành công (${pct(current.successOrders, current.orders).toFixed(1)}%)`}
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/api/export/report?${exportQuery}`}>
              <Download className="size-4" /> Xuất CSV theo ngày
            </a>
          </Button>
        }
      />

      <DataTableToolbar
        period={{ defaultKey: "month" }}
        facets={[{ key: "basis", label: "Cơ sở tính", options: [{ value: "created", label: REPORT_BASIS_LABEL.created }, { value: "delivered", label: REPORT_BASIS_LABEL.delivered }], single: true }]}
        resultLabel={basis === "delivered" ? "Đơn được gán vào kỳ theo ngày Viettel Post phát thành công (đơn chưa giao tính theo ngày lên đơn)." : "Đơn được gán vào kỳ theo ngày lên đơn trên Pancake."}
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Doanh thu giao thành công" value={formatVND(current.revenue, { compact: true })} change={change(current.revenue, previous?.revenue)} note={`${formatNumber(current.successOrders)} đơn · TB ${formatVND(current.successOrders ? Math.round(current.revenue / current.successOrders) : 0, { compact: true })}/đơn`} icon={PackageCheck} tone="blue" />
        <MetricCard label="Lãi gộp" value={formatVND(current.grossProfit, { compact: true })} change={change(current.grossProfit, previous?.grossProfit)} note={`Biên gộp ${grossMargin.toFixed(1)}% · giá vốn ${formatVND(current.cogs, { compact: true })}`} icon={Boxes} tone="green" />
        <MetricCard label="Lợi nhuận ròng" value={formatVND(current.netProfit, { compact: true })} change={change(current.netProfit, previous?.netProfit)} note={`Biên ròng ${current.margin.toFixed(1)}% trên doanh thu giao thành công`} icon={TrendingUp} tone={current.netProfit >= 0 ? "primary" : "rose"} />
        <MetricCard label="COD đã về ngân hàng" value={formatVND(cash.codPaid.amount, { compact: true })} note={`${formatNumber(cash.codPaid.count)} vận đơn trong kỳ · chờ về ${formatVND(cash.codWaiting.amount, { compact: true })}`} icon={Banknote} tone="amber" />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.8fr)]">
        <SectionCard title="Bảng kết quả kinh doanh" description={`So sánh với kỳ liền trước có cùng độ dài · ${REPORT_BASIS_LABEL[basis].toLowerCase()}`} padded={false}>
          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Khoản mục</TableHead>
                  <TableHead className="text-right">Kỳ này</TableHead>
                  <TableHead className="text-right">% doanh thu</TableHead>
                  <TableHead className="text-right">Kỳ trước</TableHead>
                  <TableHead className="text-right">Thay đổi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PNL_LINES.map((line) => {
                  const value = current[line.key];
                  const prev = previous?.[line.key];
                  const emphasis = line.kind === "subtotal" || line.kind === "total";
                  return (
                    <TableRow key={line.key} className={cn(emphasis && "bg-muted/40 hover:bg-muted/40", line.kind === "total" && "border-t-2")}>
                      <TableCell className={cn("py-2.5", emphasis && "font-bold")}>
                        <div className={cn(!emphasis && "pl-3")}>{line.label}</div>
                        {line.note ? <div className="pl-3 text-[11px] text-muted-foreground">{line.note}</div> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={value} className={cn("font-semibold", emphasis && "text-base font-bold", line.kind === "total" && (value >= 0 ? "text-success" : "text-destructive"))} />
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{current.revenue ? `${((value / current.revenue) * 100).toFixed(1)}%` : "—"}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{previous ? formatVND(prev ?? 0) : "—"}</TableCell>
                      <TableCell className="text-right">
                        <Delta current={value} previous={prev} invert={line.kind === "cost"} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-t px-5 py-3 text-xs text-muted-foreground">
            <span>
              Biên lợi nhuận ròng: <strong className={current.netProfit >= 0 ? "text-success" : "text-destructive"}>{current.margin.toFixed(1)}%</strong>
            </span>
            <span>
              Lợi nhuận / đơn giao thành công: <strong className="text-foreground">{formatVND(current.successOrders ? Math.round(current.netProfit / current.successOrders) : 0)}</strong>
            </span>
            {current.adSpend ? (
              <span>
                ROAS ghi nhận: <strong className="text-foreground">{roas ? `${roas.toFixed(2)}×` : "—"}</strong> · CPO: <strong className="text-foreground">{current.adOrders ? formatVND(Math.round(current.adSpend / current.adOrders)) : "—"}</strong>
              </span>
            ) : null}
          </div>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Tiền thực về" description="Dòng tiền thực tế thay vì doanh thu ghi nhận" padded={false}>
            <div className="divide-y">
              <CashRow icon={Banknote} tone="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" title="COD đã về ngân hàng trong kỳ" note={`${formatNumber(cash.codPaid.count)} vận đơn · theo ngày ghi nhận tiền về`} amount={cash.codPaid.amount} />
              <CashRow icon={Wallet} tone="bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300" title="COD đã thu, chờ về tài khoản" note={`${formatNumber(cash.codWaiting.count)} vận đơn ĐVVC đã thu / đã đối soát (toàn bộ)`} amount={cash.codWaiting.amount} />
              <CashRow icon={PackageCheck} tone="bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300" title="Đã thanh toán trước" note="Chuyển khoản, tiền mặt, trả trước của đơn giao thành công trong kỳ" amount={cash.prepaid} />
            </div>
            <div className="border-t px-5 py-3 text-xs text-muted-foreground">
              Tổng tiền thực về trong kỳ: <strong className="text-foreground">{formatVND(cash.codPaid.amount + cash.prepaid)}</strong>
            </div>
          </SectionCard>

          <SectionCard title="Tỷ lệ hoàn / huỷ" description="Đơn hoàn và huỷ trong kỳ, kèm phí ship mất trắng">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-background p-3">
                <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Đơn hoàn</p>
                <p className="numeric mt-1 text-xl font-bold">{formatNumber(current.returned)}</p>
                <p className="text-xs text-muted-foreground">{pct(current.returned, current.orders).toFixed(1)}% đơn không huỷ</p>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Đơn huỷ</p>
                <p className="numeric mt-1 text-xl font-bold">{formatNumber(current.cancelled)}</p>
                <p className="text-xs text-muted-foreground">{pct(current.cancelled, totalOrders).toFixed(1)}% tổng đơn lên</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-destructive/5 px-3 py-2 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Phí ship + phí hoàn mất trắng</span>
              <Money value={current.lostShipping} className="font-bold text-destructive" />
            </div>
            {previous ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Kỳ trước: {formatNumber(previous.returned)} hoàn ({pct(previous.returned, previous.orders).toFixed(1)}%) · {formatNumber(previous.cancelled)} huỷ · mất {formatVND(previous.lostShipping, { compact: true })}
              </p>
            ) : null}
          </SectionCard>
        </div>
      </section>

      <SectionCard title="Doanh thu & lợi nhuận theo ngày" description="Doanh thu giao thành công (cột), lãi gộp và lợi nhuận ròng sau chi phí quảng cáo, vận hành (đường)" actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{period.label}</span>}>
        <ProfitChart data={chartData} />
      </SectionCard>

      <section className="grid gap-5 xl:grid-cols-2">
        <SectionCard title="Theo kênh bán" description="Đơn không huỷ, giao thành công và lãi gộp theo nguồn đơn" padded={false}>
          <BreakdownTable rows={report.channels} firstHeader="Kênh" renderKey={(key) => <SourceBadge source={key} />} />
        </SectionCard>
        <SectionCard title="Theo nhân viên chốt đơn" description="Xếp theo doanh thu giao thành công" padded={false}>
          <BreakdownTable rows={report.sellers} firstHeader="Nhân viên" renderKey={(key) => <span className="font-medium">{key}</span>} />
        </SectionCard>
      </section>

      <SectionCard title="Sản phẩm lãi nhất" description="Top 15 theo lãi gộp (doanh thu dòng hàng − giá vốn × số lượng) trên đơn giao thành công" padded={false}>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Sản phẩm</TableHead>
                <TableHead className="text-right">SL bán</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">Giá vốn</TableHead>
                <TableHead className="text-right">Lãi gộp</TableHead>
                <TableHead className="text-right">Biên</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.products.length ? (
                report.products.map((p, i) => (
                  <TableRow key={p.productName}>
                    <TableCell>
                      <span className="flex size-7 items-center justify-center rounded-md bg-muted text-xs font-bold text-muted-foreground">{i + 1}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {p.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.image} alt="" className="size-9 shrink-0 rounded-md border object-cover" />
                        ) : (
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                            <Boxes className="size-4" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{p.productName || "—"}</p>
                          <p className="text-xs text-muted-foreground">{formatNumber(p.skus)} mẫu mã</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right"><span className="numeric font-semibold">{formatNumber(p.quantity)}</span></TableCell>
                    <TableCell className="text-right"><span className="numeric text-muted-foreground">{formatNumber(p.orders)}</span></TableCell>
                    <TableCell className="text-right"><Money value={p.revenue} /></TableCell>
                    <TableCell className="text-right"><Money value={p.cogs} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={p.profit} className={cn("font-bold", p.profit < 0 && "text-destructive")} /></TableCell>
                    <TableCell className="text-right">
                      <span className={cn("numeric text-xs font-semibold", p.margin >= 40 ? "text-success" : p.margin < 15 ? "text-destructive" : "")}>{p.margin.toFixed(1)}%</span>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">Chưa có đơn giao thành công trong kỳ.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

function CashRow({ icon: Icon, tone, title, note, amount }: { icon: typeof Banknote; tone: string; title: string; note: string; amount: number }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      </div>
      <Money value={amount} className="shrink-0 text-sm font-bold" />
    </div>
  );
}

function BreakdownTable({ rows, firstHeader, renderKey }: { rows: { key: string; orders: number; success: number; revenue: number; cogs: number; grossProfit: number }[]; firstHeader: string; renderKey: (key: string) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[560px]">
        <TableHeader>
          <TableRow>
            <TableHead>{firstHeader}</TableHead>
            <TableHead className="text-right">Đơn</TableHead>
            <TableHead className="text-right">Giao TC</TableHead>
            <TableHead className="text-right">Tỷ lệ</TableHead>
            <TableHead className="text-right">Doanh thu TC</TableHead>
            <TableHead className="text-right">Giá vốn</TableHead>
            <TableHead className="text-right">Lãi gộp</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((r) => {
              const rate = pct(r.success, r.orders);
              return (
                <TableRow key={r.key}>
                  <TableCell>{renderKey(r.key)}</TableCell>
                  <TableCell className="text-right"><span className="numeric">{formatNumber(r.orders)}</span></TableCell>
                  <TableCell className="text-right"><span className="numeric font-semibold">{formatNumber(r.success)}</span></TableCell>
                  <TableCell className="text-right">
                    <span className={cn("numeric text-xs font-semibold", rate >= 70 ? "text-success" : rate < 50 ? "text-destructive" : "")}>{rate.toFixed(0)}%</span>
                  </TableCell>
                  <TableCell className="text-right"><Money value={r.revenue} /></TableCell>
                  <TableCell className="text-right"><Money value={r.cogs} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.grossProfit} className={cn("font-bold", r.grossProfit < 0 && "text-destructive")} /></TableCell>
                </TableRow>
              );
            })
          ) : (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">Chưa có dữ liệu trong kỳ.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
