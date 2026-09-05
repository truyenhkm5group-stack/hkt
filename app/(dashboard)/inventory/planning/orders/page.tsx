import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { PRODUCTION_STATUS_LABEL, PRODUCTION_STATUS_TONE } from "@/lib/constants/production";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { listProductionOrders } from "@/lib/queries/production";
import { cn } from "@/lib/utils";

export const metadata = { title: "Bảng đặt hàng sản xuất" };

export default async function ProductionOrdersPage() {
  await requirePermission("planning:view");
  const rows = await listProductionOrders();
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Kho & tài chính" title="Bảng chốt đặt hàng sản xuất" description="Các bảng đặt hàng đã chốt theo mã (màu × size) để gửi xưởng may. Tạo bảng mới từ trang Kế hoạch đặt hàng SX." actions={<Link href="/inventory/planning" className="text-sm font-medium text-primary hover:underline">← Kế hoạch đặt hàng</Link>} />
      <SectionCard padded={false}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mã bảng</TableHead>
              <TableHead>Mã hàng</TableHead>
              <TableHead className="text-right">Tổng SL</TableHead>
              <TableHead className="text-right">Giá trị</TableHead>
              <TableHead>Xưởng · ngày cần</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Tạo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">Chưa có bảng đặt hàng nào.</TableCell></TableRow> : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell><Link href={`/inventory/planning/orders/${r.id}`} className="font-mono font-semibold text-primary hover:underline">{r.code}</Link></TableCell>
                <TableCell>{r.productCode ? `${r.productCode} · ` : ""}{r.productName}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatNumber(r.totalQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.unitCost ? formatVND(r.totalQty * r.unitCost, { compact: true }) : "—"}</TableCell>
                <TableCell className="text-sm">{r.supplier || "—"}{r.dueDate ? ` · ${new Date(r.dueDate).toLocaleDateString("vi-VN")}` : ""}</TableCell>
                <TableCell><span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", PRODUCTION_STATUS_TONE[r.status])}>{PRODUCTION_STATUS_LABEL[r.status] ?? r.status}</span></TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}<div>{r.createdBy}</div></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}
