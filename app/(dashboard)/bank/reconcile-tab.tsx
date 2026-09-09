import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money, SectionCard } from "@/components/ui-bits";
import { BANK_GROUP_SPEC, type BankGroup } from "@/lib/constants/bank";
import { formatNumber, formatVND } from "@/lib/format";
import { bankByGroup, bankReconciliation } from "@/lib/queries/bank";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * Đối chiếu sao kê với sổ sách ERP.
 *
 * Điểm quan trọng nhất của trang này là điều nó KHÔNG làm: không tự sửa bên nào cho khớp. Tiền và
 * hàng vốn dĩ lệch kỳ — trả tiền xưởng tháng này cho hàng nhập tháng trước là chuyện bình thường.
 * Cái ERP làm được là cho chủ shop NHÌN THẤY khoảng lệch để tự phán đoán, thay vì âm thầm chọn một
 * con số rồi trình bày như sự thật.
 */
export async function BankReconcileTab({ period }: { period: Period }) {
  const [groups, lines] = await Promise.all([bankByGroup(period), bankReconciliation(period)]);
  const totalIn = groups.reduce((t, g) => t + g.moneyIn, 0);
  const totalOut = groups.reduce((t, g) => t + g.moneyOut, 0);

  return (
    <div className="space-y-5">
      <SectionCard
        title="Sao kê so với sổ sách ERP"
        description="Lệch KHÔNG có nghĩa là sai: tiền và hàng thường rơi vào hai kỳ khác nhau. Bảng này để bạn nhìn thấy khoảng lệch, ERP không tự sửa bên nào."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[820px]">
            <TableHeader>
              <TableRow>
                <TableHead>Khoản mục</TableHead>
                <TableHead className="text-right">Tiền thật trên sao kê</TableHead>
                <TableHead className="text-right">Số ERP đang dùng</TableHead>
                <TableHead>Nguồn ERP</TableHead>
                <TableHead className="text-right">Chênh lệch</TableHead>
                <TableHead>Vì sao có thể lệch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.key}>
                  <TableCell className="font-medium">{line.label}</TableCell>
                  <TableCell className="text-right"><Money value={line.bankAmount} /></TableCell>
                  <TableCell className="text-right"><Money value={line.erpAmount} /></TableCell>
                  <TableCell className="text-[12.5px] text-muted-foreground">{line.erpLabel}</TableCell>
                  <TableCell className={cn("text-right numeric font-semibold", Math.abs(line.diff) > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                    {line.diff === 0 ? "khớp" : formatVND(line.diff, { sign: true })}
                  </TableCell>
                  <TableCell className="max-w-[320px] text-[11.5px] text-muted-foreground">{line.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Tiền thật đi đâu trong kỳ"
        description={`Tổng tiền vào ${formatVND(totalIn)} · tiền ra ${formatVND(totalOut)} theo NGÀY GIAO DỊCH trên sao kê (không phân bổ theo kỳ hiệu lực).`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Nhóm kế toán</TableHead>
                <TableHead className="text-right">Số GD</TableHead>
                <TableHead className="text-right">Tiền vào</TableHead>
                <TableHead className="text-right">Tiền ra</TableHead>
                <TableHead>Ảnh hưởng báo cáo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">Chưa có giao dịch nào trong kỳ.</TableCell>
                </TableRow>
              ) : (
                groups.map((g) => {
                  const spec = BANK_GROUP_SPEC[g.group as BankGroup];
                  const effect =
                    spec.pnl.kind === "NONE"
                      ? "Không vào lãi lỗ"
                      : spec.pnl.kind === "REVENUE"
                        ? "Doanh thu (nguồn: đơn hàng / bảng kê)"
                        : spec.authority === "EXPENSES"
                          ? "Chi phí vận hành — đẩy sang bảng Chi phí để vào lợi nhuận"
                          : "Đã vào lợi nhuận từ nguồn khác — chỉ đối chiếu";
                  return (
                    <TableRow key={g.group} className={cn(g.group === "UNCLASSIFIED" && "bg-amber-50/60 dark:bg-amber-950/20")}>
                      <TableCell className="font-medium">{g.label}</TableCell>
                      <TableCell className="numeric text-right">{formatNumber(g.count)}</TableCell>
                      <TableCell className="text-right">{g.moneyIn ? <Money value={g.moneyIn} className="text-emerald-600" /> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-right">{g.moneyOut ? <Money value={g.moneyOut} className="text-rose-600" /> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-[11.5px] text-muted-foreground">{effect}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
