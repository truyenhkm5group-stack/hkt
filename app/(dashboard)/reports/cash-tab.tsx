import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Hourglass,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
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
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export async function CashTab({ period }: { period: Period }) {
  const r = await getCashProfitReport(period);
  const lines: {
    label: string;
    note: string;
    value: number;
    kind: "in" | "out" | "total";
  }[] = [
    {
      label: "COD Viettel Post đã về ngân hàng",
      note: `${formatNumber(r.cashIn.codPaidCount)} vận đơn đánh dấu đã về trong kỳ (Đối soát COD)`,
      value: r.cashIn.codPaidToBank,
      kind: "in",
    },
    {
      label: "Khách thanh toán trước / chuyển khoản",
      note: `${formatNumber(r.cashIn.prepaidOrders)} đơn giao thành công thật trong kỳ có tiền trả trước`,
      value: r.cashIn.prepaid,
      kind: "in",
    },
    { label: "= Tiền vào", note: "", value: r.cashIn.total, kind: "total" },
    {
      label: "(–) Tiền nhập hàng",
      note: `${formatNumber(r.cashOut.purchaseReceipts)} phiếu nhập trong kỳ × giá nhập (Nhập hàng & kiểm kê)`,
      value: r.cashOut.purchases,
      kind: "out",
    },
    {
      label: "(–) Cước ship đơn giao thành công thật",
      note: `${formatNumber(r.finished.delivered)} đơn kết thúc giao thật trong kỳ`,
      value: r.cashOut.shippingDelivered,
      kind: "out",
    },
    {
      label: "(–) Cước ship + phí hoàn của đơn hoàn",
      note: `${formatNumber(r.finished.returned)} đơn hoàn trong kỳ (cước đi ${formatVND(r.cashOut.shippingReturned)} + phí hoàn ${formatVND(r.cashOut.returnFees)})`,
      value: r.cashOut.shippingReturned + r.cashOut.returnFees,
      kind: "out",
    },
    {
      label: "(–) Chi phí quảng cáo",
      note: "Facebook Ads tự động + nhập tay, theo ngày chi",
      value: r.cashOut.adSpend,
      kind: "out",
    },
    {
      label: "(–) Chi phí vận hành",
      note: "Lương, mặt bằng, phần mềm, đóng gói, khác (không tính nhóm Quảng cáo / Nhập hàng để tránh trùng)",
      value: r.cashOut.operating,
      kind: "out",
    },
    { label: "= Tiền ra", note: "", value: r.cashOut.total, kind: "total" },
    {
      label: "= Lợi nhuận dòng tiền",
      note: "Tiền vào − tiền ra trong kỳ",
      value: r.net,
      kind: "total",
    },
  ];
  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Tiền vào"
          value={formatVND(r.cashIn.total, { compact: true })}
          note={`COD về ${formatVND(r.cashIn.codPaidToBank, { compact: true })} · trả trước ${formatVND(r.cashIn.prepaid, { compact: true })}`}
          icon={ArrowDownToLine}
          tone="green"
        />
        <MetricCard
          label="Tiền ra"
          value={formatVND(r.cashOut.total, { compact: true })}
          note={`Nhập hàng ${formatVND(r.cashOut.purchases, { compact: true })} · ship ${formatVND(r.cashOut.shippingDelivered + r.cashOut.shippingReturned + r.cashOut.returnFees, { compact: true })} · QC ${formatVND(r.cashOut.adSpend, { compact: true })}`}
          icon={ArrowUpFromLine}
          tone="rose"
        />
        <MetricCard
          label="Lợi nhuận dòng tiền"
          value={
            <span className={r.net >= 0 ? "text-success" : "text-destructive"}>
              {formatVND(r.net, { compact: true })}
            </span>
          }
          note="Tiền thực vào − tiền thực ra trong kỳ"
          icon={Banknote}
          tone={r.net >= 0 ? "primary" : "rose"}
        />
        <MetricCard
          label="Tiền chưa về"
          value={formatVND(
            r.pending.codCollectedWaiting + r.pending.codInTransit,
            { compact: true },
          )}
          note={`ĐVVC đã thu ${formatVND(r.pending.codCollectedWaiting, { compact: true })} (${formatNumber(r.pending.codCollectedCount)} VĐ) · đang giao ${formatVND(r.pending.codInTransit, { compact: true })} (${formatNumber(r.pending.inTransitCount)} VĐ)`}
          icon={Hourglass}
          tone="amber"
        />
      </section>

      <SectionCard
        title="Dòng tiền thực"
        description={`${period.label} · tiền được gán vào kỳ theo ngày thực nhận / thực chi, không theo ngày lên đơn`}
        padded={false}
      >
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead>Khoản mục</TableHead>
              <TableHead className="text-right">Số tiền</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow
                key={l.label}
                className={cn(
                  l.kind === "total" &&
                    "bg-muted/40 hover:bg-muted/40 font-bold",
                )}
              >
                <TableCell
                  className={cn("py-2.5", l.kind !== "total" && "pl-6")}
                >
                  <div>{l.label}</div>
                  {l.note ? (
                    <div className="text-[11px] font-normal text-muted-foreground">
                      {l.note}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <Money
                    value={l.value}
                    className={cn(
                      "font-semibold",
                      l.kind === "total" && "text-base",
                      l.label.includes("Lợi nhuận") &&
                        (l.value >= 0 ? "text-success" : "text-destructive"),
                      l.kind === "out" && "text-destructive",
                    )}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          COD chỉ tính khi được đánh dấu “Đã về ngân hàng” trong Đối soát COD.
          Nếu chưa đối soát, tiền vào sẽ thấp hơn thực tế; mục “Tiền chưa về”
          cho biết phần đang chờ.
        </div>
      </SectionCard>
    </div>
  );
}
