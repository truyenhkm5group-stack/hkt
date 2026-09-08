import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatVND } from "@/lib/format";
import { ROAS_HINT, ROAS_LABEL, getAdsRoas } from "@/lib/queries/ads-roas";
import { successTone } from "@/lib/constants/returns";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/** Màu theo mức ROAS: dưới 1 là đang lỗ ở mức đó. */
function roasTone(value: number | null) {
  if (value === null) return "text-muted-foreground";
  if (value >= 2) return "text-emerald-600 dark:text-emerald-400";
  if (value >= 1) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

function Roas({ value }: { value: number | null }) {
  return <span className={cn("numeric", roasTone(value))}>{value === null ? "—" : `${value.toFixed(2)}×`}</span>;
}

/**
 * BỐN MỨC ROAS. Với shop bán COD, ROAS theo doanh thu lên đơn là con số vô nghĩa: đơn có thể hoàn,
 * và tiền còn nằm ở ĐVVC. Bốn cột dưới đây luôn giảm dần, và chỗ tụt nhiều nhất chính là vấn đề.
 */
export async function RoasSection({ period }: { period: Period }) {
  const r = await getAdsRoas(period, "campaign");
  if (!r.rows.length && !r.unmapped.ordersWithoutAd) return null;

  return (
    <SectionCard
      title="ROAS theo kết quả đơn"
      description={`${period.label} · chi ${formatVND(r.totals.spend)} · lợi nhuận góp ${formatVND(r.totals.contribution)}`}
      hint="Bốn mức ROAS trả lời bốn câu hỏi khác nhau và luôn giảm dần: lên đơn → giao thành công → tiền về → lợi nhuận góp. Chỗ tụt nhiều nhất chính là vấn đề cần sửa."
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Chiến dịch</TableHead>
              <TableHead className="text-right">Chi QC</TableHead>
              <TableHead className="text-right">Đơn</TableHead>
              <TableHead className="text-right">GTC</TableHead>
              {(["orderRoas", "deliveredRoas", "cashRoas", "contributionRoas"] as const).map((key) => (
                <TableHead key={key} className="text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {ROAS_LABEL[key]}
                    <InfoHint>{ROAS_HINT[key]}</InfoHint>
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.slice(0, 40).map((row) => (
              <TableRow key={row.key}>
                <TableCell className="max-w-[280px] truncate" title={row.name}>{row.name}</TableCell>
                <TableCell className="numeric text-right whitespace-nowrap">{formatVND(row.spend)}</TableCell>
                <TableCell className="numeric text-right">
                  {formatNumber(row.deliveredOrders)}/{formatNumber(row.bookedOrders)}
                </TableCell>
                <TableCell className={cn("numeric text-right", successTone(row.successRate))}>
                  {row.successRate === null ? "—" : `${row.successRate}%`}
                </TableCell>
                <TableCell className="text-right"><Roas value={row.orderRoas} /></TableCell>
                <TableCell className="text-right"><Roas value={row.deliveredRoas} /></TableCell>
                <TableCell className="text-right"><Roas value={row.cashRoas} /></TableCell>
                <TableCell className="text-right"><Roas value={row.contributionRoas} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="border-t px-5 py-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Phần KHÔNG quy kết được (cố ý không chia đều cho các chiến dịch):</p>
        <ul className="mt-1 space-y-0.5">
          <li>
            {formatNumber(r.unmapped.ordersWithoutAd)} đơn không có ad_id · doanh thu {formatVND(r.unmapped.revenueWithoutAd)} — không biết đến từ quảng cáo nào.
          </li>
          {r.unmapped.ordersWithUnknownAd ? <li>{formatNumber(r.unmapped.ordersWithUnknownAd)} đơn có ad_id nhưng chưa tra được mẩu quảng cáo trên Facebook.</li> : null}
          {r.unmapped.spendWithoutOrders ? <li>{formatVND(r.unmapped.spendWithoutOrders)} tiền quảng cáo của chiến dịch không có đơn nào gắn vào.</li> : null}
        </ul>
      </div>
    </SectionCard>
  );
}
