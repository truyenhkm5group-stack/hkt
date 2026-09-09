import Link from "next/link";
import { AlertTriangle, CalendarClock, Factory, TrendingUp } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { PURCHASING_RULE } from "@/lib/constants/purchasing";
import { formatDate, formatNumber } from "@/lib/format";
import { getPurchasingReport } from "@/lib/queries/purchasing";
import { cn } from "@/lib/utils";

export const metadata = { title: "Mua hàng & xưởng" };
export const dynamic = "force-dynamic";

/** Đọc `?days=` trên URL; giá trị lạ thì rơi về cửa sổ mặc định thay vì báo lỗi. */
function readWindow(raw: string | undefined): number {
  const n = Number(raw);
  return PURCHASING_RULE.windowChoices.includes(n as (typeof PURCHASING_RULE.windowChoices)[number]) ? n : PURCHASING_RULE.defaultWindowDays;
}

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requirePermission("planning:view");
  const params = await searchParams;
  const days = readWindow(params.days);
  const r = await getPurchasingReport(days);
  const cov = r.coverage;
  const lowLeadCoverage = cov.leadCoveragePercent !== null && cov.leadCoveragePercent < PURCHASING_RULE.minLeadCoveragePercent;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Mua hàng & xưởng"
        description="Tiền đang cam kết với xưởng, lô nào trễ, xưởng nào giao nhanh, giá nhập đang tăng ở đâu."
        hint="Hai chiều tách bạch: CAM KẾT là đơn đặt xưởng (tiền dự kiến phải trả), HÀNG THẬT là phiếu nhập kho. Đặt 500 cái không có nghĩa là đã nhận 500 cái. Đơn sản xuất không có cột ngày nhận hàng, nên thời gian giao là ƯỚC TÍNH suy từ việc ghép lô đặt với phiếu nhập — chỉ ghép khi một-một, còn lại để CHƯA BIẾT."
        actions={
          <div className="flex items-center gap-1 rounded-lg border p-0.5">
            {PURCHASING_RULE.windowChoices.map((choice) => (
              <Link
                key={choice}
                href={`/inventory/purchasing?days=${choice}`}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  choice === days ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {choice} ngày
              </Link>
            ))}
          </div>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Đang cam kết với xưởng"
          value={<Money value={r.open.committed} />}
          note={`${formatNumber(r.open.count)} lô đã gửi, chưa đánh dấu nhận`}
          hint="Số lượng × đơn giá ghi trên đơn sản xuất. Đây là tiền DỰ KIẾN phải trả, không phải tiền đã trả — ERP không có sổ công nợ xưởng."
          icon={Factory}
          tone={r.open.committed > 0 ? "blue" : "slate"}
        />
        <MetricCard
          label="Quá hạn hẹn"
          value={<Money value={r.open.overdueCommitted} />}
          note={r.open.overdueCount ? `${formatNumber(r.open.overdueCount)} lô · trễ nhiều nhất ${formatNumber(r.open.maxLateDays)} ngày` : "Không lô nào quá hạn"}
          icon={AlertTriangle}
          tone={r.open.overdueCount > 0 ? "rose" : "green"}
        />
        <MetricCard
          label="Ghép được lô ↔ phiếu nhập"
          value={cov.leadCoveragePercent === null ? "—" : `${cov.leadCoveragePercent}%`}
          note={`${formatNumber(cov.leadMatched)} ghép được · ${formatNumber(cov.leadAmbiguous)} nhập nhằng · ${formatNumber(cov.leadUnmatched)} chưa thấy phiếu`}
          hint="Đây là TRẦN độ tin của mọi con số về thời gian giao. Phủ thấp thì thời gian giao chỉ nói về một phần nhỏ số lô."
          icon={CalendarClock}
          tone={lowLeadCoverage ? "amber" : cov.leadCoveragePercent === null ? "slate" : "green"}
        />
        <MetricCard
          label="Mẫu mã tăng giá nhập"
          value={formatNumber(r.priceJumps.length)}
          note={`Tăng từ ${PURCHASING_RULE.priceJumpPercent}% trở lên so với lần nhập trước`}
          icon={TrendingUp}
          tone={r.priceJumps.length > 0 ? "amber" : "slate"}
        />
      </section>

      {r.estimated.length ? (
        <div className="rounded-xl border border-warning/40 bg-warning/8 px-4 py-3 text-xs leading-5">
          <p className="font-semibold">Đọc trước khi tin con số</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {r.estimated.map((e, i) => (
              <li key={i}>• {e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <SectionCard
        title="Lô đang chờ về"
        description="Đã gửi xưởng, chưa đánh dấu nhận — quá hạn xếp lên đầu"
        padded={false}
      >
        {r.openOrders.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Lô</TableHead>
                  <TableHead>Mẫu</TableHead>
                  <TableHead>Xưởng</TableHead>
                  <TableHead className="text-right">Số lượng</TableHead>
                  <TableHead className="text-right">Tiền cam kết</TableHead>
                  <TableHead>Gửi xưởng</TableHead>
                  <TableHead>Hẹn về</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.openOrders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.code}</TableCell>
                    <TableCell className="max-w-[240px] truncate">
                      {o.productName || o.productCode || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{o.supplier}</TableCell>
                    <TableCell className="numeric text-right">{formatNumber(o.totalQty)}</TableCell>
                    <TableCell className="text-right"><Money value={o.committed} /></TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(o.sentAt)}</TableCell>
                    <TableCell>
                      {o.dueDate ? (
                        o.lateDays !== null ? (
                          <Badge variant="destructive">Trễ {formatNumber(o.lateDays)} ngày</Badge>
                        ) : (
                          formatDate(o.dueDate)
                        )
                      ) : (
                        <span className="text-muted-foreground">Không ghi hạn</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Chưa có lô nào đang chờ về" description="Mọi đơn sản xuất đã gửi đều đã được đánh dấu nhận, hoặc chưa có đơn nào được gửi xưởng." />
        )}
      </SectionCard>

      <SectionCard
        title="Xưởng"
        description={`Hàng thật đã nhập trong ${days} ngày, cam kết đang mở, và thời gian giao ước tính`}
        hint={`Thời gian giao chỉ tính trên lô ghép được một-một với phiếu nhập, và chỉ hiện khi xưởng có ít nhất ${PURCHASING_RULE.minLeadSamples} lô ghép được — vài lô lẻ không đủ để nói xưởng nào nhanh hơn.`}
        padded={false}
      >
        {r.suppliers.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Xưởng</TableHead>
                  <TableHead className="text-right">Phiếu nhập</TableHead>
                  <TableHead className="text-right">Đã nhập</TableHead>
                  <TableHead className="text-right">Tiền hàng</TableHead>
                  <TableHead className="text-right">Giá nhập TB</TableHead>
                  <TableHead className="text-right">So kỳ trước</TableHead>
                  <TableHead className="text-right">Giao (ngày)</TableHead>
                  <TableHead className="text-right">Đúng hạn</TableHead>
                  <TableHead className="text-right">Đang cam kết</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.suppliers.map((s) => (
                  <TableRow key={s.supplier}>
                    <TableCell className="font-medium">{s.supplier}</TableCell>
                    <TableCell className="numeric text-right">{formatNumber(s.receipts)}</TableCell>
                    <TableCell className="numeric text-right">{formatNumber(s.receivedQty)}</TableCell>
                    <TableCell className="text-right"><Money value={s.receivedCost} /></TableCell>
                    <TableCell className="text-right">
                      {s.avgUnitCost === null ? <span className="text-muted-foreground">Chưa khai giá</span> : <Money value={s.avgUnitCost} />}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "numeric text-right",
                        s.unitCostChangePercent !== null && s.unitCostChangePercent > 0 && "font-semibold text-rose-600 dark:text-rose-400",
                        s.unitCostChangePercent !== null && s.unitCostChangePercent < 0 && "text-success",
                      )}
                    >
                      {s.unitCostChangePercent === null ? "—" : `${s.unitCostChangePercent > 0 ? "+" : ""}${s.unitCostChangePercent}%`}
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {s.leadDaysP50 === null ? (
                        <span className="text-muted-foreground">Chưa đủ lô</span>
                      ) : (
                        <span title={`p90 ${s.leadDaysP90} ngày · ${s.leadMatched} lô ghép được`}>
                          {s.leadDaysP50}
                          {s.leadDaysP90 !== null ? <span className="text-muted-foreground"> / {s.leadDaysP90}</span> : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {s.onTimeRate === null ? <span className="text-muted-foreground">—</span> : `${s.onTimeRate}%`}
                    </TableCell>
                    <TableCell className="text-right"><Money value={s.committed} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Chưa có dữ liệu xưởng" description="Chưa có đơn sản xuất nào được gửi và chưa có phiếu nhập kho nào trong kỳ." />
        )}
      </SectionCard>

      <SectionCard
        title="Giá nhập tăng"
        description={`So với chính lần nhập trước của cùng mẫu mã, tăng từ ${PURCHASING_RULE.priceJumpPercent}%`}
        hint="Cố ý so với lần nhập TRƯỚC của đúng mẫu mã đó, không so với bình quân toàn kho — bình quân trộn nhiều mẫu khác giá nhau nên tăng giảm ở đó không hành động được."
        padded={false}
      >
        {r.priceJumps.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Mẫu mã</TableHead>
                  <TableHead>Xưởng</TableHead>
                  <TableHead className="text-right">Giá trước</TableHead>
                  <TableHead className="text-right">Giá mới</TableHead>
                  <TableHead className="text-right">Tăng</TableHead>
                  <TableHead>Lần trước</TableHead>
                  <TableHead>Lần mới</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.priceJumps.map((j) => (
                  <TableRow key={j.variantId}>
                    <TableCell>
                      <span className="font-medium">{j.productName || j.sku}</span>
                      {j.variantName ? <span className="ml-1 text-xs text-muted-foreground">{j.variantName}</span> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{j.supplier}</TableCell>
                    <TableCell className="text-right"><Money value={j.previousCost} /></TableCell>
                    <TableCell className="text-right"><Money value={j.latestCost} /></TableCell>
                    <TableCell className="numeric text-right font-semibold text-rose-600 dark:text-rose-400">+{j.changePercent}%</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(j.previousAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(j.latestAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Không có mẫu mã nào tăng giá nhập" description={`Chưa mẫu nào có lần nhập gần nhất cao hơn lần trước từ ${PURCHASING_RULE.priceJumpPercent}% trở lên trong ${days} ngày qua.`} />
        )}
      </SectionCard>

      <SectionCard title="Độ phủ dữ liệu & giới hạn" description="Con số chỉ đáng tin tới mức dữ liệu nền cho phép" padded={false}>
        <div className="overflow-x-auto">
          <Table className="min-w-[620px]">
            <TableHeader>
              <TableRow>
                <TableHead>Dữ liệu nền</TableHead>
                <TableHead className="text-right">Có</TableHead>
                <TableHead className="text-right">Tổng</TableHead>
                <TableHead>Thiếu thì mất gì</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Đơn sản xuất ghi tên xưởng</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.withSupplier)}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.productionOrders)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">Không so sánh được xưởng với nhau</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Đơn sản xuất ghi hạn về</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.withDueDate)}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.productionOrders)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">Không biết lô nào trễ, không tính được đúng hạn</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Đơn sản xuất có mốc gửi xưởng</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.withSentAt)}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.productionOrders)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">Không tính được thời gian giao</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Dòng phiếu nhập có khai đơn giá</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.receiptLinesWithCost)}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(cov.receiptLines)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">Giá nhập bình quân và cảnh báo tăng giá mất căn cứ</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">ERP KHÔNG biết những điều sau:</p>
          <ul className="mt-1 space-y-0.5">
            {r.limitations.map((l, i) => (
              <li key={i}>• {l}</li>
            ))}
          </ul>
        </div>
      </SectionCard>
    </div>
  );
}
