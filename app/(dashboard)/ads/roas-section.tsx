import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { getAdsAttributionAudit } from "@/lib/queries/ads-attribution";
import { LOW_COVERAGE_PCT } from "@/lib/constants/sales-funnel";
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

/**
 * ĐỘ PHỦ QUY KẾT — đứng ngay cạnh ROAS, cố ý.
 *
 * Nếu chỉ 30% đơn có mã quảng cáo thì "ROAS 4,2" là ROAS của 30% đó. Con số vẫn đúng, nhưng đọc nó
 * như thể nó nói về toàn shop là tự lừa mình. Đặc tả: docs/ads-attribution-audit.md.
 */
export async function AdsCoverageSection({ period }: { period: Period }) {
  const audit = await getAdsAttributionAudit(period);
  const ceiling = audit.rows.find((r) => r.key === "order.ad");
  if (!ceiling || ceiling.total === 0) return null;
  const low = ceiling.coverage * 100 < LOW_COVERAGE_PCT;

  return (
    <SectionCard
      title="Độ phủ quy kết — đọc trước khi tin con số ROAS"
      description={`${formatPercent(ceiling.coverage * 100)} đơn trong kỳ có mã quảng cáo. Đây là TRẦN của mọi chỉ số ROAS ở trên.`}
      hint="Quy kết không nối được thì KHÔNG chia đều cho các chiến dịch — chia đều làm tổng khớp trong khi từng dòng đều sai. Ba cấp phân tích không có dữ liệu được nêu tên ở cuối khối này để không ai mất công đi tìm rồi tự dựng số thay thế."
      padded={false}
    >
      {low ? (
        <p className="border-b bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Độ phủ dưới {LOW_COVERAGE_PCT}%: bảng ROAS ở trên mô tả đúng phần đơn có mã quảng cáo, KHÔNG mô tả toàn shop.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mắt xích</TableHead>
              <TableHead className="text-right">Nối được</TableHead>
              <TableHead className="text-right">Độ phủ</TableHead>
              <TableHead>Phần còn lại là gì</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {audit.rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.matched)} / {formatNumber(r.total)}
                  <span className="ml-1 text-xs text-muted-foreground">{r.unit === "spend" ? "dòng chi" : "đơn"}</span>
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", r.total > 0 && r.coverage * 100 < LOW_COVERAGE_PCT && "font-semibold text-amber-600 dark:text-amber-400")}>
                  {r.total > 0 ? formatPercent(r.coverage * 100) : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="border-t px-5 py-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Ba cấp KHÔNG phân tích được (nêu tên để không ai đi tìm):</p>
        <ul className="mt-1 space-y-0.5">
          {audit.unavailableLevels.map((l) => (
            <li key={l.level}>
              <span className="font-medium">{l.level}</span> — {l.reason}
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}
