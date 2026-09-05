import {
  Calculator,
  Megaphone,
  PackageCheck,
  Percent,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import {
  AssumptionsForm,
  ReturnRateOverride,
} from "@/app/(dashboard)/reports/assumptions-form";
import { MetricCard } from "@/components/metric-card";
import { MarketerNominalRows } from "./marketer-nominal-rows";
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
import { getNominalMarketerBreakdown } from "@/lib/queries/payroll";
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
  const [report, byMarketer] = await Promise.all([getNominalProfitReport(period), getNominalMarketerBreakdown(period)]);
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

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
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
          label="Chi phí ngoài hàng · QC · vận chuyển"
          value={formatVND(t.otherCostsTotal, { compact: true })}
          note={`${formatVND(t.opexPerOrder ?? 0)}/đơn lên · ${formatVND(t.opexPerDelivered ?? 0)}/đơn GTC ước tính · vận hành ${formatVND(t.opexTotal, { compact: true })} + rủi ro TK ${formatVND(t.inventoryRisk, { compact: true })} + thuế ${formatVND(t.tax, { compact: true })} + CP khác ${formatVND(t.otherCost, { compact: true })}`}
          icon={TrendingUp}
          tone="amber"
        />
        <MetricCard
          label="Lợi nhuận danh nghĩa"
          value={
            <span
              className={t.netProfit >= 0 ? "text-success" : "text-destructive"}
            >
              {formatVND(t.netProfit, { compact: true })}
            </span>
          }
          note={`Margin ${t.netMargin !== null ? `${t.netMargin.toFixed(1)}%` : "—"} · = DT GTC ƯT − giá vốn − vận chuyển − CPQC − vận hành ${formatVND(t.opexTotal, { compact: true })} (đã nhập ${formatVND(t.operatingExpenses, { compact: true })} · ${formatNumber(report.operatingCount)} khoản, đóng hàng ${formatVND(t.packingCost, { compact: true })}, NV vận đơn ${formatVND(t.opsStaffCost, { compact: true })} · cứu ước ${formatNumber(t.rescued)} đơn, cố định ${formatVND(t.fixedCost, { compact: true })} · ${report.periodMonths} tháng) − rủi ro TK ${formatVND(t.inventoryRisk, { compact: true })} (${report.assumptions.inventoryRiskPercent ?? 10}% hàng nhập ${formatVND(t.purchaseCost, { compact: true })}) − thuế ${formatVND(t.tax, { compact: true })} − CP khác ${formatVND(t.otherCost, { compact: true })}`}
          icon={Wallet}
          tone={t.netProfit >= 0 ? "green" : "rose"}
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
        description={`${period.label} · mỗi mã: đơn ĐÃ XÁC NHẬN lên trong kỳ, CPQC Facebook ghép theo tên chiến dịch. Tỷ lệ hoàn ước tính trộn theo trạng thái thật: đã hoàn 100%, đã giao 0%, chờ xử lý / chờ phát lại ${t.failedToReturnPct}% (học từ lịch sử), còn lại theo tỷ lệ ${report.assumptions.returnRateWindowDays} ngày của mã. Bấm mã để xem theo ngày.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1500px]">
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
                <TableHead className="text-right" title="Chi phí vận hành đã nhập ở bảng Chi phí trong kỳ (lương, phần mềm, khác; trừ QC & nhập hàng) phân bổ theo tỷ trọng doanh số POS">CP vận hành đã nhập</TableHead>
                <TableHead className="text-right" title={`Đóng hàng = đơn gửi × ${(report.assumptions.packingFeePerOrder ?? 0).toLocaleString("vi-VN")} ₫`}>Đóng hàng</TableHead>
                <TableHead className="text-right" title={`Nhân viên vận đơn = đơn × ${(report.assumptions.opsStaffPerOrder ?? 0).toLocaleString("vi-VN")} ₫ + đơn giao thất bại cứu được thành GTC × ${(report.assumptions.opsStaffPerRescued ?? 0).toLocaleString("vi-VN")} ₫`}>NV vận đơn</TableHead>
                <TableHead className="text-right" title={`Chi phí cố định (văn phòng, điện nước…) ${(report.assumptions.fixedCostMonthly ?? 0).toLocaleString("vi-VN")} ₫/tháng × ${report.periodMonths} tháng của kỳ, phân bổ theo tỷ trọng doanh số POS`}>CP cố định</TableHead>
                <TableHead className="text-right" title="Mọi chi phí ngoài tiền hàng, QC, vận chuyển (vận hành đã nhập + đóng hàng + NV vận đơn + cố định + rủi ro TK + thuế + CP khác) ÷ số đơn lên (trước hoàn huỷ)">CP vận hành/đơn trước hoàn</TableHead>
                <TableHead className="text-right" title="Cùng các chi phí trên ÷ số đơn giao thành công ước tính (sau hoàn huỷ)">CP vận hành/đơn sau hoàn huỷ</TableHead>
                <TableHead className="text-right" title="Dự phòng rủi ro tồn kho = tổng giá trị hàng nhập trong kỳ (phiếu nhập) × % giả định">Rủi ro TK {report.assumptions.inventoryRiskPercent ?? 10}% hàng nhập</TableHead>
                <TableHead className="text-right" title="Dự trù thuế = DT GTC ước tính × %">Thuế {report.assumptions.taxPercent ?? 1.5}%</TableHead>
                <TableHead className="text-right" title="Chi phí khác = CPQC × % (phí thanh toán thẻ ngoại tệ khi Meta thu tiền)">CP khác {report.assumptions.otherCostPercentOfAds ?? 1.1}% QC</TableHead>
                <TableHead className="text-right" title="Lợi nhuận danh nghĩa = DT GTC ước tính − giá vốn − vận chuyển − CPQC − vận hành − rủi ro TK − thuế − CP khác">LN danh nghĩa</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={22}
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
                        <span title={`Đã hoàn ${r.returned} · chờ xử lý / phát lại ${r.failed} (×${t.failedToReturnPct}%) · chưa có kết quả ${Math.max(0, r.orders - r.delivered - r.returned - r.failed)} (×${r.baseReturnRate.toFixed(0)}% lịch sử) · đã giao ${r.delivered}`}>{r.returnRate.toFixed(1)}%</span>
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
                    <TableCell className="text-right"><Money value={r.operatingAlloc} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.packingCost} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right">
                      <Money value={r.opsStaffCost} className="text-muted-foreground" />
                      {r.rescued ? <div className="text-[10.5px] text-muted-foreground">cứu ước {formatNumber(r.rescued)} đơn</div> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={r.fixedAlloc} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.opexPerOrder ?? 0} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.opexPerDelivered ?? 0} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.inventoryRisk} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.tax} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={r.otherCost} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={r.netProfit}
                        className={cn(
                          "font-bold",
                          r.netProfit >= 0 ? "text-success" : "text-destructive",
                        )}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.netMargin} />
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
                  <TableCell className="text-right"><Money value={t.operatingExpenses} /></TableCell>
                  <TableCell className="text-right"><Money value={t.packingCost} /></TableCell>
                  <TableCell className="text-right">
                    <Money value={t.opsStaffCost} />
                    {t.rescued ? <div className="text-[10.5px] font-normal text-muted-foreground">cứu ước {formatNumber(t.rescued)} đơn</div> : null}
                  </TableCell>
                  <TableCell className="text-right"><Money value={t.fixedCost} /></TableCell>
                  <TableCell className="text-right"><Money value={t.opexPerOrder ?? 0} /></TableCell>
                  <TableCell className="text-right"><Money value={t.opexPerDelivered ?? 0} /></TableCell>
                  <TableCell className="text-right"><Money value={t.inventoryRisk} /></TableCell>
                  <TableCell className="text-right"><Money value={t.tax} /></TableCell>
                  <TableCell className="text-right"><Money value={t.otherCost} /></TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={t.netProfit}
                      className={
                        t.netProfit >= 0 ? "text-success" : "text-destructive"
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pct value={t.netMargin} />
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          Công thức mỗi mã: DT GTC ước tính = Doanh số POS × (1 − TL hoàn); Giá
          vốn = SP × giá nhập × (1 − TL hoàn); Vận chuyển = Đơn × cước gửi + Đơn
          × TL hoàn × phí hoàn về (tức Đơn × [(1 − TL hoàn) × cước gửi + TL hoàn
          × cước đơn hoàn đi + về]). LN danh nghĩa = DT − giá vốn − vận chuyển
          − CPQC − CP vận hành đã nhập (bảng Chi phí, trừ QC & nhập hàng, phân
          bổ theo doanh số) − đóng hàng (đơn × đơn giá) − nhân viên vận đơn (đơn
          × đơn giá + đơn cứu được GTC ước theo % × thưởng) − CP cố định (tháng ×
          số tháng của kỳ, phân bổ theo doanh số) − dự phòng rủi ro tồn kho (%
          hàng nhập) − thuế − CP khác. CP vận hành/đơn = mọi chi phí ngoài tiền
          hàng, QC, vận chuyển chia cho số đơn lên (trước hoàn) hoặc số đơn giao
          thành công ước tính (sau hoàn huỷ); sửa đơn giá ở Giả định. Đơn chưa giao vẫn được tính theo tỷ lệ ước tính, nên
          đây là lợi nhuận danh nghĩa; đối chiếu với tab “Dòng tiền thực” khi
          tiền về.
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
                    <TableHead className="text-right" title="Theo ngày chỉ có DT − giá vốn − vận chuyển − CPQC (chưa trừ vận hành, rủi ro TK, thuế, CP khác vì các khoản này tính theo kỳ)">LN gộp sau QC</TableHead>
                    <TableHead className="text-right">Margin gộp</TableHead>
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

      <SectionCard
        title="Lợi nhuận theo tổng giá trị hàng nhập trong kỳ"
        description={`Thay giá vốn hàng giao ước tính bằng TOÀN BỘ giá trị hàng nhập trong kỳ theo phiếu nhập (${formatNumber(t.purchaseQty)} sp · ${formatVND(t.purchaseCost, { compact: true })}). LN = DT GTC ước tính − CPQC − hàng nhập − vận chuyển − tổng vận hành (đã nhập + đóng hàng + NV vận đơn + cố định) − rủi ro TK − thuế − CP khác. Thấp hơn bảng trên đúng bằng phần hàng nhập còn tồn chưa bán; mã nhập hàng mà chưa có đơn vẫn được liệt kê.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1200px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right">SL nhập</TableHead>
                <TableHead className="text-right">Giá trị hàng nhập</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">DT GTC ƯT</TableHead>
                <TableHead className="text-right">CPQC</TableHead>
                <TableHead className="text-right">Vận chuyển</TableHead>
                <TableHead className="text-right" title="Tổng vận hành = CP vận hành đã nhập + đóng hàng + nhân viên vận đơn + chi phí cố định">Vận hành (tổng)</TableHead>
                <TableHead className="text-right">Rủi ro TK</TableHead>
                <TableHead className="text-right">Thuế</TableHead>
                <TableHead className="text-right">CP khác</TableHead>
                <TableHead className="text-right">LN theo hàng nhập</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right" title="Giá vốn hàng giao ước tính (bảng trên) để đối chiếu: hàng nhập − giá vốn ước tính ≈ giá trị còn tồn / chưa bán">Giá vốn ƯT (đối chiếu)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...report.rows].sort((a, b) => b.profitOnPurchase - a.profitOnPurchase).map((r) => (
                <TableRow key={`pur-${r.productId}`} className={cn(!r.orders && "text-muted-foreground")}>
                  <TableCell className="font-medium">{r.code ? `${r.code} · ` : ""}{r.productName}{!r.orders ? <span className="ml-1 text-[11px]">(chưa có đơn)</span> : null}</TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.purchaseQty)}</TableCell>
                  <TableCell className="text-right"><Money value={r.purchaseCost} className={r.purchaseCost ? "text-rose-600" : "text-muted-foreground"} /></TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.orders)}</TableCell>
                  <TableCell className="text-right"><Money value={r.expectedRevenue} /></TableCell>
                  <TableCell className="text-right"><Money value={r.adSpend} className="text-rose-600" /></TableCell>
                  <TableCell className="text-right"><Money value={r.shipCost} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.opexTotal} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.inventoryRisk} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.tax} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.otherCost} className="text-muted-foreground" /></TableCell>
                  <TableCell className="text-right"><Money value={r.profitOnPurchase} className={cn("font-bold", r.profitOnPurchase >= 0 ? "text-success" : "text-destructive")} /></TableCell>
                  <TableCell className="text-right"><Pct value={r.marginOnPurchase} /></TableCell>
                  <TableCell className="text-right"><Money value={r.expectedCogs} className="text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                <TableCell>Tổng{report.unmatchedAdSpend ? <div className="text-[10.5px] font-normal text-muted-foreground">gồm {formatVND(report.unmatchedAdSpend)} QC chưa ghép mã</div> : null}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(t.purchaseQty)}</TableCell>
                <TableCell className="text-right"><Money value={t.purchaseCost} className="text-rose-600" /></TableCell>
                <TableCell className="numeric text-right">{formatNumber(t.orders)}</TableCell>
                <TableCell className="text-right"><Money value={t.expectedRevenue} /></TableCell>
                <TableCell className="text-right"><Money value={t.adSpend} className="text-rose-600" /></TableCell>
                <TableCell className="text-right"><Money value={t.shipCost} /></TableCell>
                <TableCell className="text-right"><Money value={t.opexTotal} /></TableCell>
                <TableCell className="text-right"><Money value={t.inventoryRisk} /></TableCell>
                <TableCell className="text-right"><Money value={t.tax} /></TableCell>
                <TableCell className="text-right"><Money value={t.otherCost} /></TableCell>
                <TableCell className="text-right"><Money value={t.profitOnPurchase} className={t.profitOnPurchase >= 0 ? "text-success" : "text-destructive"} /></TableCell>
                <TableCell className="text-right"><Pct value={t.marginOnPurchase} /></TableCell>
                <TableCell className="text-right"><Money value={t.expectedCogs} /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Lợi nhuận danh nghĩa theo Marketer"
        description={`Cách ghi nhận: đơn & DT GTC ước tính của mỗi mã ghi cho marketer theo AD_ID của đơn (quảng cáo tạo ra đơn → chiến dịch → marketer, đúng từng đơn kể cả chạy chung page); đơn không có ad_id thì theo FANPAGE phát sinh đơn (khai báo ở Lương & hoa hồng: ${byMarketer.pagesMapped}/${byMarketer.pagesTotal} page có đơn đã gán); còn lại chia theo tỷ trọng tiền QC trên mã, không QC → về chủ mã. LN ròng trước QC của mã (đã trừ giá vốn, vận chuyển, vận hành gồm đóng hàng / NV vận đơn / cố định, rủi ro TK, thuế) × tỷ trọng − QC của chính mình − CP khác theo QC − QC test = LN ròng cá nhân; chủ mã hưởng X% LN đơn của mình, người chạy cùng hưởng Y% LN đơn mình tạo và (100 − Y)% về chủ mã (mặc định Y = ${100 - byMarketer.ownerSharePct}%, khai riêng từng mã ở Lương & hoa hồng). Bấm tên marketer để xem chi tiết từng mã hàng có phát sinh số liệu.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">QC mã hàng</TableHead>
                <TableHead className="text-right">QC test</TableHead>
                <TableHead className="text-right">CP khác</TableHead>
                <TableHead className="text-right">Đơn phân bổ</TableHead>
                <TableHead className="text-right">DT GTC ƯT phân bổ</TableHead>
                <TableHead className="text-right">LN ròng trước QC</TableHead>
                <TableHead className="text-right">% chủ mã</TableHead>
                <TableHead className="text-right">LN ròng cá nhân</TableHead>
                <TableHead className="text-right">CPQC/đơn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byMarketer.rows.map((x) => (
                <MarketerNominalRows key={x.marketerId ?? "none"} row={x} ownerSharePct={byMarketer.ownerSharePct} />
              ))}
              {byMarketer.rows.length ? (() => {
                const sum = (f: (x: (typeof byMarketer.rows)[number]) => number) => byMarketer.rows.reduce((t, x) => t + f(x), 0);
                const adSpend = sum((x) => x.adSpend);
                const testSpend = sum((x) => x.testSpend);
                const orders = sum((x) => x.attributedOrders);
                const received = sum((x) => x.ownerBonusReceived);
                const paid = sum((x) => x.ownerBonusPaid);
                const personal = sum((x) => x.personalNet);
                return (
                  <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                    <TableCell>
                      Tổng · {formatNumber(byMarketer.rows.length)} marketer
                      {byMarketer.unattributed || byMarketer.shopRetained ? <div className="text-[10.5px] font-normal text-muted-foreground">chưa gồm phần không phân bổ / shop giữ lại ở các dòng dưới</div> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={adSpend} className="text-rose-600" /></TableCell>
                    <TableCell className="text-right"><Money value={testSpend} className={testSpend ? "text-amber-600" : "text-muted-foreground"} /></TableCell>
                    <TableCell className="text-right"><Money value={sum((x) => x.otherCost)} /></TableCell>
                    <TableCell className="numeric text-right">{formatNumber(orders)}</TableCell>
                    <TableCell className="text-right"><Money value={sum((x) => x.attributedRevenue)} /></TableCell>
                    <TableCell className="text-right"><Money value={sum((x) => x.profitBeforeAds)} /></TableCell>
                    <TableCell className="text-right text-xs font-normal">
                      {received ? <div className="text-emerald-700">+{formatVND(received)}</div> : null}
                      {paid ? <div className="text-rose-600">−{formatVND(paid)}</div> : null}
                      {!received && !paid ? <span className="text-muted-foreground">—</span> : null}
                    </TableCell>
                    <TableCell className="text-right"><Money value={personal} className={personal >= 0 ? "text-success" : "text-destructive"} /></TableCell>
                    <TableCell className="text-right"><Money value={orders ? Math.round((adSpend + testSpend) / orders) : 0} /></TableCell>
                  </TableRow>
                );
              })() : null}
              {byMarketer.unattributed ? (
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={8}>Mã không có quảng cáo và chưa gán người phụ trách (không phân bổ cho ai)</TableCell>
                  <TableCell className="text-right"><Money value={byMarketer.unattributed} /></TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
              {byMarketer.shopRetained ? (
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={8}>Shop giữ lại (chủ mã chỉ hưởng X% &lt; 100% LN đơn của mình)</TableCell>
                  <TableCell className="text-right"><Money value={byMarketer.shopRetained} /></TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
