import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/ui-bits";
import { BANK_ACCOUNT_STATUS_TONE } from "@/lib/constants/bank";
import { formatNumber, formatTimeAgo } from "@/lib/format";
import { BALANCE_CONFIDENCE_HINT, BALANCE_CONFIDENCE_LABEL, BALANCE_CONFIDENCE_TONE, type CashPosition } from "@/lib/queries/cash-position";
import { cn } from "@/lib/utils";

/**
 * TIỀN ĐANG NẰM Ở TÀI KHOẢN NÀO.
 *
 * Cột "Nguồn số dư" là cột quan trọng nhất của bảng và cũng là cột dễ bị cho là thừa nhất. Không
 * có nó thì ba con số hoàn toàn khác nhau — số ngân hàng ghi, số ERP cộng thêm, và số không tồn
 * tại — trông y hệt nhau. Chủ shop sẽ lấy con số thứ hai để quyết định nhập hàng.
 *
 * Tài khoản CHƯA BIẾT số dư hiện dấu "—" chứ không hiện 0đ, và vẫn đứng trong bảng: giấu nó đi thì
 * tiền biến mất khỏi màn hình mà không ai biết vì sao.
 */
export function AccountsPanel({ cash }: { cash: CashPosition }) {
  if (!cash.accounts.length) {
    return (
      <div className="px-5 py-8 text-center">
        <p className="text-sm font-semibold">Chưa có tài khoản ngân hàng nào</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
          Số dư đọc từ chính con số ngân hàng ghi trên mỗi giao dịch. Nối SePay hoặc nhập sao kê ở{" "}
          <Link href="/bank?tab=nhap-sao-ke" className="font-medium text-primary hover:underline">
            Sổ ngân hàng
          </Link>{" "}
          thì phần này mới có số.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead>Tài khoản</TableHead>
            <TableHead className="text-right">Số dư</TableHead>
            <TableHead>Nguồn số dư</TableHead>
            <TableHead className="text-right">Giao dịch</TableHead>
            <TableHead>Cập nhật</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cash.accounts.map((a) => (
            <TableRow key={a.accountId} className={cn(a.status === "DISABLED" && "opacity-60")}>
              <TableCell>
                <Link href={`/bank?tab=giao-dich&account=${a.accountId}`} className="font-medium hover:text-primary hover:underline">
                  {a.label}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="numeric">{a.accountMasked}</span>
                  {a.subAccount ? <span className="numeric">· VA {a.subAccount}</span> : null}
                  {a.status !== "ACTIVE" ? (
                    <span className={cn("rounded px-1.5 py-0.5 font-medium", BANK_ACCOUNT_STATUS_TONE[a.status])}>{a.statusLabel}</span>
                  ) : null}
                  {a.chainBreaks > 0 ? (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive" title="Bước nhảy số dư không bằng số tiền giao dịch — sổ đang thiếu hoặc trùng dòng">
                      {formatNumber(a.chainBreaks)} chỗ số dư đứt
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right font-semibold">
                {/* CHƯA BIẾT hiện dấu gạch, TUYỆT ĐỐI không hiện 0đ. */}
                {a.balance === null ? <span className="text-muted-foreground">—</span> : <Money value={a.balance} />}
              </TableCell>
              <TableCell>
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", BALANCE_CONFIDENCE_TONE[a.confidence])} title={BALANCE_CONFIDENCE_HINT[a.confidence]}>
                  {BALANCE_CONFIDENCE_LABEL[a.confidence]}
                </span>
                {a.derivedFrom > 0 ? <span className="ml-1.5 text-[11px] text-muted-foreground">+{formatNumber(a.derivedFrom)} giao dịch</span> : null}
              </TableCell>
              <TableCell className="numeric text-right text-xs">
                {formatNumber(a.txnCount)}
                {a.unclassified > 0 ? (
                  <Link href={`/bank?tab=giao-dich&account=${a.accountId}&unclassified=1`} className="ml-1.5 text-amber-700 hover:underline dark:text-amber-300" title="Giao dịch chưa phân loại">
                    ({formatNumber(a.unclassified)} chưa phân loại)
                  </Link>
                ) : null}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{a.lastTxnAt ? formatTimeAgo(a.lastTxnAt) : "Chưa có giao dịch"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {cash.unknownAccounts > 0 ? (
        <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Tổng tiền ở trên là CẬN DƯỚI.</span> {formatNumber(cash.unknownAccounts)} tài khoản chưa bao giờ có số dư từ ngân hàng nên không
          được cộng vào — cộng dồn từ 0 sẽ cho ra một con số trông thuyết phục mà hoàn toàn bịa.
        </p>
      ) : null}
    </div>
  );
}
