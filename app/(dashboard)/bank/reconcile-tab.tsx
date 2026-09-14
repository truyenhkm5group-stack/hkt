import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money, SectionCard } from "@/components/ui-bits";
import { BANK_CASH_CLASS_LABEL, BANK_GROUP_SPEC, BANK_LINK_TYPE_LABEL, BANK_NOT_A_COST_NOTE, type BankGroup } from "@/lib/constants/bank";
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
  const [groups, recon] = await Promise.all([bankByGroup(period), bankReconciliation(period)]);
  const { lines, hasBankData } = recon;
  const totalIn = groups.reduce((t, g) => t + g.moneyIn, 0);
  const totalOut = groups.reduce((t, g) => t + g.moneyOut, 0);

  return (
    <div className="space-y-5">
      <SectionCard
        title="Sao kê so với sổ sách ERP"
        description={
          hasBankData
            ? "Lệch KHÔNG có nghĩa là sai: tiền và hàng thường rơi vào hai kỳ khác nhau. Bảng này để bạn nhìn thấy khoảng lệch, ERP không tự sửa bên nào."
            : "CHƯA NHẬP SAO KÊ cho kỳ này, nên chưa có gì để đối chiếu. Cột bên phải là số ERP đang dùng — đó KHÔNG phải chênh lệch."
        }
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
                  <TableCell className="text-right">
                    {line.bankAmount === null ? <span className="text-muted-foreground">chưa nhập</span> : <Money value={line.bankAmount} />}
                  </TableCell>
                  <TableCell className="text-right"><Money value={line.erpAmount} /></TableCell>
                  <TableCell className="text-[12.5px] text-muted-foreground">{line.erpLabel}</TableCell>
                  {/* CHƯA BIẾT không được trình bày như một khoảng lệch: sổ rỗng mà hiện "−64,5 triệu"
                      là báo động do thiếu dữ liệu, nhìn y hệt báo động do lệch sổ. */}
                  <TableCell className={cn("text-right numeric font-semibold", line.diff !== null && Math.abs(line.diff) > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                    {line.diff === null ? "—" : line.diff === 0 ? "khớp" : formatVND(line.diff, { sign: true })}
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
                <TableHead title={BANK_NOT_A_COST_NOTE}>Loại dòng tiền</TableHead>
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
                  const effect = `${BANK_CASH_CLASS_LABEL[spec.cashClass]}${spec.linkTo ? ` · đối chiếu với ${BANK_LINK_TYPE_LABEL[spec.linkTo].toLowerCase()}` : ""}`;
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
