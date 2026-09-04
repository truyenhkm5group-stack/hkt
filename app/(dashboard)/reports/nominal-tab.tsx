import {
  Calculator,
  Megaphone,
  PackageCheck,
  Percent,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import {
  AssumptionsForm,
  ReturnRateOverride,
} from "@/app/(dashboard)/reports/assumptions-form";
import { MetricCard } from "@/components/metric-card";
import { Button } from "@/components/ui/button";
import { Money, SectionCard } from "@/components/ui-bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber, formatVND } from "@/lib/format";
import {
  getNominalDailyForProduct,
  getNominalProfitReport,
} from "@/lib/queries/profit-nominal";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

function Pct({
  value,
  digits = 1,
  tone = true,
}: {
  value: number | null;
  digits?: number;
  tone?: boolean;
}) {
  if (value === null || !Number.isFinite(value))
    return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "numeric",
        tone &&
          (value < 0 ? "text-destructive" : value >= 15 ? "text-success" : ""),
      )}
    >
      {value.toFixed(digits)}%
    </span>
  );
}

export async function NominalTab({
  period,
  productId,
  tabQuery,
  canWrite,
}: {
  period: Period;
  productId: string;
  tabQuery: string;
  canWrite: boolean;
}) {
  const report = await getNominalProfitReport(period);
  const selected = productId
    ? report.rows.find((r) => r.productId === productId)
    : null;
  const daily = selected
    ? await getNominalDailyForProduct(
        selected.productId,
        period,
        selected.returnRate,
        report.assumptions,
      )
    : [];
  const t = report.totals;

  return (
    <div className="space-y-5">
      <AssumptionsForm assumptions={report.assumptions} canWrite={canWrite} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Doanh số POS (đơn lên)"
          value={formatVND(t.grossSales, { compact: true })}
          note={`${formatNumber(t.orders)} đơn · ${formatNumber(t.items)} sản phẩm · không tính đơn huỷ`}
          icon={PackageCheck}
          tone="blue"
        />
        <MetricCard
          label="Doanh thu GTC ước tính"
          value={formatVND(t.expectedRevenue, { compact: true })}
          note={`Doanh số × (1 − tỷ lệ hoàn) · thực tế đã giao ${formatVND(t.actualRevenue, { compact: true })}`}
          icon={Calculator}
          tone="primary"
        />
        <MetricCard
          label="Chi phí quảng cáo"
          value={formatVND(t.adSpend, { compact: true })}
          note={
            report.unmatchedAdSpend
              ? `${formatVND(report.unmatchedAdSpend, { compact: true })} chưa ghép được mã hàng (trừ vào tổng)`
              : "Đã ghép hết theo mã hàng"
          }
          icon={Megaphone}
          tone="rose"
        />
        <MetricCard
          label="Lợi nhuận danh nghĩa"
          value={
            <span
              className={
                t.expectedProfit >= 0 ? "text-success" : "text-destructive"
              }
            >
              {formatVND(t.expectedProfit, { compact: true })}
            </span>
          }
          note={
            t.margin !== null
              ? `Margin ${t.margin.toFixed(1)}% trên doanh thu GTC ước tính`
              : "—"
          }
          icon={TrendingUp}
          tone={t.expectedProfit >= 0 ? "green" : "rose"}
        />
        <MetricCard
          label="Tỷ lệ hoàn ước tính"
          value={
            t.weightedReturnRate !== null
              ? `${t.weightedReturnRate.toFixed(1)}%`
              : "—"
          }
          note={`Bình quân theo số đơn · thực tế: ${formatNumber(t.delivered)} giao thật, ${formatNumber(t.returned)} hoàn, ${formatNumber(t.inTransit)} đang giao`}
          icon={Percent}
          tone="amber"
        />
      </section>

      <SectionCard
        title="Lợi nhuận danh nghĩa theo mã hàng"
        description={`${period.label} · mỗi mã: đơn lên trong kỳ, CPQC Facebook ghép theo tên chiến dịch, tỷ lệ hoàn ước tính từ lịch sử ${report.assumptions.returnRateWindowDays} ngày · bấm mã để xem theo ngày`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1180px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">SP</TableHead>
                <TableHead className="text-right">Doanh số POS</TableHead>
                <TableHead className="text-right">CPQC</TableHead>
                <TableHead className="text-right">TL hoàn ƯT</TableHead>
                <TableHead className="text-right">DT GTC ƯT</TableHead>
                <TableHead className="text-right">Giá vốn</TableHead>
                <TableHead className="text-right">Vận chuyển</TableHead>
                <TableHead className="text-right">CPQC/đơn</TableHead>
                <TableHead className="text-right">DT/đơn</TableHead>
                <TableHead className="text-right">LN ước tính</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={13}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    Không có đơn trong kỳ.
                  </TableCell>
                </TableRow>
              ) : (
                report.rows.map((r) => (
                  <TableRow
                    key={r.productId}
                    className={cn(
                      selected?.productId === r.productId && "bg-primary/5",
                    )}
                  >
                    <TableCell>
                      <Link
                        href={`/reports?${tabQuery}&product=${encodeURIComponent(r.productId)}#ma-hang`}
                        className="flex items-center gap-2.5 hover:text-primary"
                      >
                        {r.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.image}
                            alt=""
                            className="size-9 shrink-0 rounded-md border object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="size-9 shrink-0 rounded-md border bg-muted" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-semibold">
                            {r.productName}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {r.code ? `${r.code} · ` : ""}giao thật{" "}
                            {r.delivered} · hoàn {r.returned} · đang giao{" "}
                            {r.inTransit}
                          </div>
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="numeric text-right font-semibold">
                      {formatNumber(r.orders)}
                    </TableCell>
                    <TableCell className="numeric text-right text-muted-foreground">
                      {formatNumber(r.items)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={r.grossSales} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.adSpend}
                        className={
                          r.adSpend ? "text-rose-600" : "text-muted-foreground"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={cn(
                          "numeric font-semibold",
                          r.returnRate >= 40
                            ? "text-destructive"
                            : r.returnRate >= 25
                              ? "text-amber-600"
                              : "",
                        )}
                      >
                        {r.returnRate.toFixed(1)}%
                      </span>
                      <div className="text-[10.5px] text-muted-foreground">
                        {r.returnRateSource === "override"
                          ? "ghi đè"
                          : r.returnRateSource === "history"
                            ? `${r.historyFinished} đơn`
                            : "mặc định"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.expectedRevenue}
                        className="font-semibold"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.expectedCogs}
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.shipCost}
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.cpo === null ? 0 : Math.round(r.cpo)}
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={
                          r.revenuePerOrder === null
                            ? 0
                            : Math.round(r.revenuePerOrder)
                        }
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.expectedProfit}
                        className={cn(
                          "font-bold",
                          r.expectedProfit >= 0
                            ? "text-success"
                            : "text-destructive",
                        )}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.margin} />
                    </TableCell>
                  </TableRow>
                ))
              )}
              {report.rows.length ? (
                <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                  <TableCell>
                    Tổng
                    {report.unmatchedAdSpend ? (
                      <div className="text-[10.5px] font-normal text-muted-foreground">
                        gồm {formatVND(report.unmatchedAdSpend)} QC chưa ghép mã
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="numeric text-right">
                    {formatNumber(t.orders)}
                  </TableCell>
                  <TableCell className="numeric text-right">
                    {formatNumber(t.items)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.grossSales} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.adSpend} className="text-rose-600" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pct value={t.weightedReturnRate} tone={false} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.expectedRevenue} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.expectedCogs} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={t.shipCost} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={t.orders ? Math.round(t.adSpend / t.orders) : 0}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={
                        t.orders ? Math.round(t.expectedRevenue / t.orders) : 0
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={t.expectedProfit}
                      className={
                        t.expectedProfit >= 0
                          ? "text-success"
                          : "text-destructive"
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pct value={t.margin} />
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          Công thức mỗi mã: DT GTC ước tính = Doanh số POS × (1 − TL hoàn); Giá
          vốn = SP × giá nhập × (1 − TL hoàn); Vận chuyển = Đơn × [(1 − TL hoàn)
          × cước giao thật + TL hoàn × chi phí đơn hoàn]; LN = DT − giá vốn −
          vận chuyển − CPQC. Đơn chưa giao vẫn được tính theo tỷ lệ ước tính,
          nên số này là lợi nhuận danh nghĩa; đối chiếu với tab “Dòng tiền thực”
          khi tiền về.
        </div>
      </SectionCard>

      {selected ? (
        <div id="ma-hang">
          <SectionCard
            title={`${selected.productName}${selected.code ? ` (${selected.code})` : ""} · theo ngày`}
            description={`Tỷ lệ hoàn ước tính ${selected.returnRate.toFixed(1)}% (${selected.returnRateSource === "override" ? "ghi đè" : selected.returnRateSource === "history" ? `lịch sử ${selected.historyFinished} đơn kết thúc` : "mặc định"}) · giá vốn ${selected.items ? formatVND(Math.round(selected.expectedCogs / Math.max(1 - selected.returnRate / 100, 0.01) / selected.items)) : "—"}/sp`}
            actions={
              <div className="flex items-center gap-3">
                <ReturnRateOverride
                  productId={selected.productId}
                  assumptions={report.assumptions}
                  current={selected.returnRate}
                  source={selected.returnRateSource}
                  canWrite={canWrite}
                />
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/reports?${tabQuery}`}>Đóng</Link>
                </Button>
              </div>
            }
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead className="text-right">Đơn</TableHead>
                    <TableHead className="text-right">SP</TableHead>
                    <TableHead className="text-right">CPQC</TableHead>
                    <TableHead className="text-right">Doanh số POS</TableHead>
                    <TableHead className="text-right">DT GTC ƯT</TableHead>
                    <TableHead className="text-right">Giá vốn</TableHead>
                    <TableHead className="text-right">Vận chuyển</TableHead>
                    <TableHead className="text-right">CPQC/đơn</TableHead>
                    <TableHead className="text-right">LN ước tính</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                    <TableHead className="text-right">Thực tế</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {daily.map((d) => (
                    <TableRow key={d.day}>
                      <TableCell className="font-medium">
                        {d.day.split("-").reverse().join("/")}
                      </TableCell>
                      <TableCell className="numeric text-right">
                        {formatNumber(d.orders)}
                      </TableCell>
                      <TableCell className="numeric text-right text-muted-foreground">
                        {formatNumber(d.items)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.adSpend}
                          className={
                            d.adSpend
                              ? "text-rose-600"
                              : "text-muted-foreground"
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={d.grossSales} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.expectedRevenue}
                          className="font-semibold"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.expectedCogs}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.shipCost}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.cpo === null ? 0 : Math.round(d.cpo)}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={d.expectedProfit}
                          className={cn(
                            "font-bold",
                            d.expectedProfit >= 0
                              ? "text-success"
                              : "text-destructive",
                          )}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Pct value={d.margin} />
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        giao {d.delivered} · hoàn {d.returned}
                      </TableCell>
                    </TableRow>
                  ))}
                  {daily.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={12}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Không có dữ liệu trong kỳ.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
