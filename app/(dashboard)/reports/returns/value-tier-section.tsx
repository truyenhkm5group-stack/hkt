import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money, SectionCard } from "@/components/ui-bits";
import { DataWarnings } from "@/components/data-warnings";
import { formatNumber } from "@/lib/format";
import { successTone } from "@/lib/constants/returns";
import { MIN_TIER_SAMPLE, type OrderValueTierReport } from "@/lib/queries/return-rate";
import { TIME_BASIS_LABEL, type TimeBasis } from "@/lib/constants/report-time-basis";
import { cn } from "@/lib/utils";

/**
 * ═══════════ GTC / TỶ LỆ HOÀN THEO BẬC GIÁ TRỊ ĐƠN ═══════════
 *
 * Khối này trả lời thẳng câu hỏi "hạ giá xuống bậc thấp hơn thì giao thành công có tăng không" mà
 * không bắt người đọc đổi bộ lọc năm lần rồi tự nhớ năm con số.
 *
 * Hai điều màn hình PHẢI nói ra, không được để người đọc tự suy:
 *  · bậc chưa đủ mẫu in "—", không tô màu, không xếp hạng (mục 39/44);
 *  · bảng này đo TƯƠNG QUAN giữa các bậc, không chứng minh NHÂN QUẢ — đơn rẻ thường là mã khác,
 *    khách khác. Phép thử thật là hạ giá MỘT mã rồi so chính mã đó trước / sau.
 */
export function ValueTierSection({ report, basis }: { report: OrderValueTierReport; basis: TimeBasis }) {
  const { rows, unknownValueOrders } = report;
  const tong = {
    orders: rows.reduce((t, r) => t + r.orders, 0),
    shipped: rows.reduce((t, r) => t + r.shipped, 0),
    delivered: rows.reduce((t, r) => t + r.delivered, 0),
    returned: rows.reduce((t, r) => t + r.returned, 0),
    revenue: rows.reduce((t, r) => t + r.revenue, 0),
    lostRevenue: rows.reduce((t, r) => t + r.lostRevenue, 0),
  };
  const ketThuc = tong.delivered + tong.returned;
  // Bậc tốt nhất chỉ được gọi tên khi có ÍT NHẤT HAI bậc kết luận được — một bậc thì không có gì để so.
  const dungDuoc = rows.filter((r) => r.successRate !== null);
  const totNhat = dungDuoc.length >= 2 ? [...dungDuoc].sort((a, b) => (b.successRate as number) - (a.successRate as number))[0] : null;

  return (
    <SectionCard
      title="Tỷ lệ giao thành công theo bậc giá trị đơn"
      hint={
        <>
          <p className="mb-2">
            Giá trị đơn = <b>tiền hàng khách phải trả sau giảm giá, chưa gồm cước</b>, lấy theo CẢ ĐƠN. Các bậc không chồng nhau nên cộng lại bằng tổng đơn có giá trị. Bậc dưới{" "}
            {MIN_TIER_SAMPLE} đơn đã kết thúc hiện &ldquo;—&rdquo;: đó là <b>chưa đủ dữ liệu</b>, không phải 0%.{" "}
            <b>Bảng này không chứng minh nhân quả</b> — đơn rẻ thường là mã khác, khách khác, vùng khác. Nó nói &ldquo;có đáng thử không&rdquo;; phép thử thật là hạ giá MỘT mã rồi so chính mã đó
            trước / sau. Lọc theo {TIME_BASIS_LABEL[basis].toLowerCase()}; bộ lọc giá trị đơn ở đầu trang KHÔNG áp vào bảng này (bảng này chính là phép phân bậc).
          </p>
          <p>Đơn càng rẻ thì khách nhận hàng nhiều hơn hay ít hơn — số liệu của chính shop, không phải cảm giác.</p>
        </>
      }
      actions={
        unknownValueOrders ? (
          <DataWarnings
            align="end"
            items={[
              <span key="khong-gia-tri">
                {formatNumber(unknownValueOrders)} đơn KHÔNG khai được giá trị (tổng tiền bằng 0) nên nằm ngoài mọi bậc. Chúng không bị nhét vào bậc thấp nhất — một đơn không có giá là{" "}
                <b>chưa biết</b>, không phải &ldquo;đơn 0đ&rdquo;.
              </span>,
            ]}
          />
        ) : undefined
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Bậc giá trị đơn</TableHead>
              <TableHead className="text-right">Đơn trong kỳ</TableHead>
              <TableHead className="text-right">Giá trị TB</TableHead>
              <TableHead className="text-right">Đã gửi ĐVVC</TableHead>
              <TableHead className="text-right">Giao thành công</TableHead>
              <TableHead className="text-right">Hoàn</TableHead>
              <TableHead className="text-right">Đã kết thúc</TableHead>
              <TableHead className="text-right">Tỷ lệ GTC</TableHead>
              <TableHead className="text-right">Tỷ lệ hoàn</TableHead>
              <TableHead className="text-right">Doanh thu giao TC</TableHead>
              <TableHead className="text-right">DT mất do hoàn</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium whitespace-nowrap">
                  {r.label}
                  {totNhat && totNhat.key === r.key ? <span className="ml-1.5 rounded bg-emerald-50 px-1 text-[10.5px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">GTC cao nhất</span> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.orders)}</TableCell>
                <TableCell className="text-right">{r.avgValue === null ? <span className="text-muted-foreground">—</span> : <Money value={r.avgValue} />}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.shipped)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{formatNumber(r.delivered)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.returned)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(r.finished)}</TableCell>
                <TableCell className="text-right">
                  {r.successRate === null ? (
                    <span className="text-muted-foreground" title={`Mới ${formatNumber(r.finished)} đơn kết thúc — dưới ngưỡng ${MIN_TIER_SAMPLE}, chưa đủ để kết luận`}>
                      —
                    </span>
                  ) : (
                    <span className={cn("rounded px-1.5 py-0.5 text-sm font-bold tabular-nums", successTone(r.successRate))}>{r.successRate.toFixed(1)}%</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.returnRate === null ? <span className="text-muted-foreground">—</span> : `${r.returnRate.toFixed(1)}%`}</TableCell>
                <TableCell className="text-right">
                  <Money value={r.revenue} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={r.lostRevenue} className="text-rose-600 dark:text-rose-400" />
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
              <TableCell>Tổng — đơn có khai giá trị</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(tong.orders)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">—</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(tong.shipped)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(tong.delivered)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(tong.returned)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(ketThuc)}</TableCell>
              <TableCell className="text-right tabular-nums">{ketThuc ? `${((tong.delivered / ketThuc) * 100).toFixed(1)}%` : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{ketThuc ? `${((tong.returned / ketThuc) * 100).toFixed(1)}%` : "—"}</TableCell>
              <TableCell className="text-right">
                <Money value={tong.revenue} />
              </TableCell>
              <TableCell className="text-right">
                <Money value={tong.lostRevenue} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
