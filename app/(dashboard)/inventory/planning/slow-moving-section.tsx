import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/ui-bits";
import { STOCK_RISK_ACTION, STOCK_RISK_LABEL, STOCK_RISK_TONE, SLOW_MOVING_RULES } from "@/lib/constants/slow-moving";
import { formatNumber } from "@/lib/format";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import { cn } from "@/lib/utils";

/**
 * ĐỐI TRỌNG CỦA KẾ HOẠCH SẢN XUẤT.
 *
 * Bảng bên trên chỉ nhìn cái SẮP HẾT. Nếu chỉ có nó thì shop luôn thấy chỗ cần đổ thêm tiền vào và
 * không bao giờ thấy chỗ tiền đang nằm chết — đó là cách một shop vừa thiếu hàng bán vừa hết vốn.
 */
export async function SlowMovingSection() {
  const report = await getSlowMoving();
  const risky = report.rows.filter((r) => r.risk !== "HEALTHY");
  if (!risky.length) return null;

  return (
    <SectionCard
      title={`Vốn đang nằm chết — ${formatNumber(risky.length)} mẫu mã`}
      description={`${Math.round(report.totalExcessValue).toLocaleString("vi-VN")}đ vượt mức cần thiết trên tổng ${Math.round(report.totalStockValue).toLocaleString("vi-VN")}đ vốn tồn · ${report.byRisk.DEAD.count} mẫu chết · ${report.byRisk.EXCESS.count} mẫu thừa`}
      hint={`Giá trị tính theo GIÁ NHẬP — đây là tiền đã bỏ ra và chưa thu lại, không phải doanh thu có thể thu. Hàng chết = không bán được cái nào trong ${SLOW_MOVING_RULES.deadDays} ngày. Vốn nằm chết = tồn đủ bán quá ${SLOW_MOVING_RULES.excessCoverDays} ngày. Phần "vượt mức" là số vốn nhiều hơn mức đủ bán ${SLOW_MOVING_RULES.healthyCoverDays} ngày. Mẫu mã chưa có phiếu nhập KHÔNG có mặt ở đây: chưa biết tồn thì không kết luận được gì.`}
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mẫu mã</TableHead>
              <TableHead className="text-right">Còn</TableHead>
              <TableHead className="text-right">Bán/ngày</TableHead>
              <TableHead className="text-right">Đủ bán</TableHead>
              <TableHead className="text-right">Vốn tồn</TableHead>
              <TableHead className="text-right">Vượt mức</TableHead>
              <TableHead>Tình trạng</TableHead>
              <TableHead>Nên làm</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {risky.slice(0, 40).map((r) => (
              <TableRow key={r.variantId}>
                <TableCell className="max-w-[240px] truncate" title={`${r.productName} · ${r.sku}`}>
                  {r.productName}
                  <span className="block text-[10.5px] text-muted-foreground">{[r.color, r.size].filter(Boolean).join(" · ") || r.sku}</span>
                </TableCell>
                <TableCell className="numeric text-right">{formatNumber(r.available)}</TableCell>
                <TableCell className="numeric text-right">{r.velocity}</TableCell>
                <TableCell className="numeric text-right">{r.daysOfCover === null ? "—" : `${r.daysOfCover} ngày`}</TableCell>
                <TableCell className="text-right"><Money value={r.stockValue} /></TableCell>
                <TableCell className="text-right font-semibold"><Money value={r.excessValue} /></TableCell>
                <TableCell>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", STOCK_RISK_TONE[r.risk])} title={r.reason}>
                    {STOCK_RISK_LABEL[r.risk]}
                  </span>
                </TableCell>
                <TableCell className="max-w-[280px] text-xs text-muted-foreground">{STOCK_RISK_ACTION[r.risk]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
