import Link from "next/link";
import { OrderOutcomeBadge, OrderStageBadge } from "@/components/status-badge";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { ReturnSummaryBucket, ReturnSummaryOrderRow } from "@/lib/queries/return-rate";

/** Tên nhóm — đúng chữ đang in trên thẻ / dòng ghi chú của khối KPI. */
export const KPI_BUCKET_LABEL: Record<ReturnSummaryBucket, string> = {
  shipped: "Đơn đã gửi",
  delivered: "Giao thành công",
  returned: "Không thành công (hoàn)",
  returnedByRule: "Hoàn theo luật COD (giao thành công nhưng COD thấp)",
  inTransit: "Chưa kết thúc",
  failed: "Chờ phát lại",
  pending: "Chờ xử lý, chưa gửi",
  cancelled: "Huỷ (không tính)",
};

/**
 * DANH SÁCH ĐƠN CẤU THÀNH MỘT SỐ TRÊN THẺ (OD-UX-04).
 *
 * `total` đến từ `listReturnSummaryOrders`, cùng phạm vi + vị từ với thẻ, nên tiêu đề in ĐÚNG con số
 * trên thẻ. SĐT chỉ hiện khi người xem có quyền xem đơn (`orders:read`) — đúng chuẩn bảng đơn, không
 * mở rộng ai thấy SĐT.
 */
export function KpiOrdersSection({
  bucket,
  data,
  basisLabel,
  canSeePhone,
  closeHref,
  pageHref,
}: {
  bucket: ReturnSummaryBucket;
  data: { total: number; page: number; pageCount: number; rows: ReturnSummaryOrderRow[] };
  basisLabel: string;
  canSeePhone: boolean;
  closeHref: string;
  pageHref: (page: number) => string;
}) {
  return (
    <div id="kpi-don">
      <SectionCard
        title={`${formatNumber(data.total)} đơn · ${KPI_BUCKET_LABEL[bucket]}`}
        description="Danh sách theo đúng bộ lọc của thẻ: kỳ · mốc · ô tìm · giá trị đơn. Bộ lọc mã hàng / marketer / lý do hoàn không áp lên thẻ nên cũng không áp ở đây."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={closeHref}>Đóng</Link>
          </Button>
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Đơn</TableHead>
                <TableHead>Khách</TableHead>
                <TableHead>Trạng thái Pancake</TableHead>
                <TableHead>Kết quả</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead>Vận đơn</TableHead>
                <TableHead>{basisLabel}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Không có đơn nào trong nhóm này.
                  </TableCell>
                </TableRow>
              ) : (
                data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/orders/${r.id}`} className="font-semibold hover:text-primary hover:underline">
                        #{r.systemId ?? r.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[160px] truncate">{r.billFullName || "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {canSeePhone ? r.billPhone || "—" : <span title="Cần quyền xem đơn">—</span>}
                        {r.shipProvince ? ` · ${r.shipProvince}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <OrderStageBadge stage={r.stage} />
                    </TableCell>
                    <TableCell>
                      <OrderOutcomeBadge outcome={r.outcome} />
                      {r.provisional ? <div className="text-[11px] text-amber-700 dark:text-amber-300">tạm tính · chưa có chứng từ tiền</div> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={r.revenue} />
                    </TableCell>
                    <TableCell className="text-xs">{r.vtpOrderNumber ?? "—"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{r.at ? formatDateTime(r.at) : "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {data.pageCount > 1 ? (
          <div className="flex items-center justify-between border-t px-5 py-2.5 text-xs text-muted-foreground">
            <span>
              Trang {formatNumber(data.page)} / {formatNumber(data.pageCount)}
            </span>
            <div className="flex gap-2">
              {data.page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={pageHref(data.page - 1)}>Trang trước</Link>
                </Button>
              ) : null}
              {data.page < data.pageCount ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={pageHref(data.page + 1)}>Trang sau</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
