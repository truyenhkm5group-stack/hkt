import { InfoHint } from "@/components/info-hint";
import { MetricCard } from "@/components/metric-card";
import { Money, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatVND } from "@/lib/format";
import { PRECISION_HINT, PRECISION_LABEL, getFinancialTruth } from "@/lib/queries/financial-truth";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Banknote, HandCoins, PackageCheck, ShoppingBag, Truck, Wallet } from "lucide-react";

/**
 * SÁU CON SỐ TIỀN, MỖI CON SỐ MỘT Ý NGHĨA.
 * Trang này tồn tại để không ai còn đọc "doanh thu" mà không biết đang nói doanh thu nào.
 */
export async function FinancialTruthTab({ period }: { period: Period }) {
  const f = await getFinancialTruth(period);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Doanh thu LÊN ĐƠN"
          value={<Money value={f.revenue.booked} />}
          icon={ShoppingBag}
          tone="primary"
          note={`${formatNumber(f.revenue.bookedOrders)} đơn khách đã chốt — chưa nói gì về việc giao được hay thu được tiền`}
        />
        <MetricCard
          label="Doanh thu GIAO THÀNH CÔNG"
          value={<Money value={f.revenue.delivered} />}
          icon={PackageCheck}
          tone="blue"
          note={`${formatNumber(f.revenue.deliveredOrders)} đơn tới tay khách · ${formatVND(f.revenue.returned)} của ${formatNumber(f.revenue.returnedOrders)} đơn hoàn không bao giờ về`}
        />
        <MetricCard
          label="TIỀN THỰC NHẬN"
          value={<Money value={f.cash.total} />}
          icon={Wallet}
          tone="green"
          note={`Bảng kê ${formatVND(f.cash.received)} + khách chuyển trước ${formatVND(f.cash.prepaid)} — đây mới là tiền trong tài khoản`}
        />
        <MetricCard
          label="COD Viettel Post đang cầm"
          value={<Money value={f.cod.collected} />}
          icon={Truck}
          tone="amber"
          note={`${formatNumber(f.cod.collectedCount)} vận đơn ĐVVC khai đã thu — lời khai, chưa phải chứng từ`}
        />
        <MetricCard
          label="COD đã đối soát"
          value={<Money value={f.cod.reconciled} />}
          icon={HandCoins}
          tone="blue"
          note={`${formatNumber(f.cod.reconciledCount)} vận đơn hai bên đã chốt số, chờ chuyển khoản`}
        />
        <MetricCard
          label="Giao xong mà chưa thấy tiền"
          value={<Money value={f.cod.outstanding} />}
          icon={Banknote}
          tone="rose"
          note={`${formatNumber(f.cod.outstandingCount)} đơn giao thành công chưa có đồng nào trên bảng kê`}
        />
      </div>

      <SectionCard
        title="Bậc thang lợi nhuận"
        description="Từ doanh thu giao thành công xuống lợi nhuận, mỗi bậc ghi rõ độ chính xác."
        hint="Dòng ghi 'Chỉ có ở mức kỳ' là chi phí không phân bổ về từng đơn được. Chia nhỏ chúng ra theo đơn là bịa ra độ chính xác không có thật."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Khoản mục</TableHead>
                <TableHead className="text-right">Số tiền</TableHead>
                <TableHead>Độ chính xác</TableHead>
                <TableHead>Ghi chú</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {f.waterfall.map((line) => (
                <TableRow key={line.key} className={cn(line.subtotal && "bg-muted/40 font-semibold")}>
                  <TableCell className={cn(line.subtotal && "font-semibold")}>{line.label}</TableCell>
                  <TableCell className={cn("numeric text-right whitespace-nowrap", line.amount < 0 && "text-destructive")}>
                    {formatVND(line.amount)}
                    {line.known ? null : <span className="ml-1 text-[11px] text-amber-600 dark:text-amber-400">(thiếu dữ liệu)</span>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <Badge variant="outline" className="text-[10px] whitespace-nowrap">{PRECISION_LABEL[line.precision]}</Badge>
                      <InfoHint>{PRECISION_HINT[line.precision]}</InfoHint>
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{line.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Lợi nhuận ước tính so với lợi nhuận thực nhận"
        description="Hai con số khác nhau về bản chất, không phải hai cách làm tròn."
        hint="Ước tính đi theo ĐƠN trong kỳ; thực nhận đi theo TIỀN đã về tài khoản. Chênh lệch chủ yếu là phần Viettel Post còn giữ."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border p-4">
            <p className="text-[13px] text-muted-foreground">Lợi nhuận ƯỚC TÍNH (theo đơn trong kỳ)</p>
            <p className={cn("numeric mt-1 text-2xl font-bold", f.estimatedProfit < 0 && "text-destructive")}>{formatVND(f.estimatedProfit)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Lợi nhuận góp {formatVND(f.contribution)} trừ chi phí vận hành.</p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] text-muted-foreground">Lợi nhuận THỰC NHẬN (theo dòng tiền)</p>
            {f.realizedProfit === null ? (
              <>
                <p className="mt-1 text-2xl font-bold text-muted-foreground">Chưa xác minh</p>
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{f.realizedBlockedBy}</p>
              </>
            ) : (
              <>
                <p className={cn("numeric mt-1 text-2xl font-bold", f.realizedProfit < 0 && "text-destructive")}>{formatVND(f.realizedProfit)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Tiền thực nhận trừ chi quảng cáo và chi phí vận hành trong kỳ.</p>
              </>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
