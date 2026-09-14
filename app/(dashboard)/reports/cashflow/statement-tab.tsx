import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Landmark, Scale } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CASHFLOW_SECTION_HINT } from "@/lib/constants/cashflow-sections";
import { formatNumber, formatVND } from "@/lib/format";
import { BALANCE_CONFIDENCE_HINT, BALANCE_CONFIDENCE_LABEL, BALANCE_CONFIDENCE_TONE } from "@/lib/queries/cash-position";
import { getCashflowStatement } from "@/lib/queries/cashflow-statement";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * BÁO CÁO DÒNG TIỀN THẬT — có đầu kỳ, cuối kỳ, và một phép kiểm.
 *
 * Trang Dòng tiền trước nay CHỈ có phần dự phóng, và chính nó nói thẳng lý do: "ERP KHÔNG có số dư
 * ngân hàng". Câu đó đúng vào lúc viết và nay đã lỗi thời — `bank_transactions.balance_after` (số
 * dư do chính ngân hàng ghi) đã được lưu từ lâu mà không truy vấn nào đọc.
 *
 * Nên tab này là thứ trang Dòng tiền thiếu: một báo cáo ĐÃ XẢY RA, chia theo bốn khoang kế toán,
 * với đẳng thức `đầu kỳ + phát sinh = cuối kỳ` được KIỂM chứ không chỉ được trình bày.
 */
export async function StatementTab({ period }: { period: Period }) {
  const r = await getCashflowStatement(period);

  if (!r.hasData) {
    return (
      <EmptyState
        icon={Landmark}
        title="Kỳ này chưa có giao dịch ngân hàng nào"
        description={
          <>
            Đây là CHƯA NHẬP, không phải &ldquo;kỳ này không có tiền vào ra&rdquo;. Báo cáo dòng tiền thật đọc từ sao kê, nên phải có sao kê trước. Nối SePay hoặc nhập
            sao kê ở{" "}
            <Link href="/bank?tab=nhap-sao-ke" className="font-medium text-primary hover:underline">
              Sổ ngân hàng
            </Link>
            . Trong lúc chờ, tab <span className="font-medium">Dự phóng kỳ tới</span> vẫn chạy được vì nó suy từ đơn hàng và nhịp chi, không cần sao kê.
          </>
        }
      />
    );
  }

  const pct = (now: number, before: number | null) => (before === null || before === 0 ? null : ((now - before) / before) * 100);

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Số dư đầu kỳ"
          value={r.opening === null ? <span className="text-muted-foreground">Chưa biết</span> : <Money value={r.opening} />}
          note={r.opening === null ? "Chưa có mốc số dư nào trước ngày đầu kỳ" : BALANCE_CONFIDENCE_LABEL[r.openingConfidence]}
          hint="Số dư của giao dịch cuối cùng TRƯỚC ngày đầu kỳ. Chưa có mốc nào thì là CHƯA BIẾT — không thay bằng 0đ, vì 0đ nghĩa là tài khoản rỗng và đó là một khẳng định khác hẳn."
          icon={Landmark}
          tone="slate"
        />
        <MetricCard
          label="Tiền vào"
          value={<Money value={r.moneyIn} />}
          change={pct(r.moneyIn, r.previous?.moneyIn ?? null)}
          note="Đã loại chuyển giữa tài khoản của mình"
          icon={ArrowUpRight}
          tone="green"
        />
        <MetricCard
          label="Tiền ra"
          value={<Money value={r.moneyOut} />}
          change={pct(r.moneyOut, r.previous?.moneyOut ?? null)}
          changeLabel="so với kỳ trước — tăng là xấu"
          icon={ArrowDownRight}
          tone="rose"
        />
        <MetricCard
          label="Số dư cuối kỳ"
          value={r.closing === null ? <span className="text-muted-foreground">Chưa biết</span> : <Money value={r.closing} />}
          note={`Dòng tiền ròng ${formatVND(r.net, { sign: true })} · ${BALANCE_CONFIDENCE_LABEL[r.closingConfidence]}`}
          icon={Scale}
          tone={r.net < 0 ? "amber" : "primary"}
        />
      </section>

      {/* ───── PHÉP KIỂM: đầu kỳ + phát sinh = cuối kỳ ───── */}
      <div
        className={cn(
          "rounded-xl border px-4 py-3 text-xs leading-5",
          r.integrityGap === null
            ? "bg-surface-sunken/40"
            : r.integrityGap === 0
              ? "border-success/30 bg-success/5"
              : "border-warning/40 bg-warning/5",
        )}
      >
        {r.integrityGap === null ? (
          <p>
            <span className="font-semibold">Chưa kiểm được tính liền mạch của sổ.</span> Phép kiểm cần mốc số dư ngân hàng ở CẢ hai đầu kỳ.{" "}
            {r.opening === null ? "Chưa có mốc nào trước ngày đầu kỳ." : "Kỳ đang chọn không có biên thời gian (kỳ “Toàn bộ”)."}
          </p>
        ) : r.integrityGap === 0 ? (
          <p>
            <span className="font-semibold text-success">Sổ liền mạch.</span> {formatVND(r.opening ?? 0)} đầu kỳ {r.movementAll >= 0 ? "+" : "−"}{" "}
            {formatVND(Math.abs(r.movementAll))} phát sinh = {formatVND(r.closing ?? 0)} cuối kỳ. Số dư ngân hàng ghi và tổng giao dịch ERP có khớp nhau tới từng đồng.
          </p>
        ) : (
          <p>
            <span className="font-semibold">Sổ lệch {formatVND(Math.abs(r.integrityGap))}.</span>{" "}
            {formatVND(r.opening ?? 0)} đầu kỳ {r.movementAll >= 0 ? "+" : "−"} {formatVND(Math.abs(r.movementAll))} phát sinh ={" "}
            {formatVND((r.opening ?? 0) + r.movementAll)}, nhưng ngân hàng ghi cuối kỳ là {formatVND(r.closing ?? 0)}.{" "}
            {r.integrityGap > 0
              ? "ERP cộng được NHIỀU hơn mức ngân hàng thật sự đổi ⇒ sổ thiếu một khoản tiền RA, hoặc thừa một dòng tiền vào (nhập sao kê hai lần)."
              : "ERP cộng được ÍT hơn mức ngân hàng thật sự đổi ⇒ sổ thiếu một khoản tiền VÀO, hoặc thừa một dòng tiền ra."}{" "}
            Mọi con số của kỳ đang sai theo đúng chừng đó.{" "}
            <Link href="/bank?tab=doi-chieu" className="font-medium text-primary hover:underline">
              Mở trang đối chiếu
            </Link>
          </p>
        )}
      </div>

      {/* ───── BỐN KHOANG ───── */}
      {r.sections.map((s) => (
        <SectionCard
          key={s.section}
          title={s.label}
          description={`${formatNumber(s.count)} giao dịch · ròng ${formatVND(s.net, { sign: true })}`}
          hint={CASHFLOW_SECTION_HINT[s.section]}
          padded={false}
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Nhóm</TableHead>
                  <TableHead className="text-right">Tiền vào</TableHead>
                  <TableHead className="text-right">Tiền ra</TableHead>
                  <TableHead className="text-right">Ròng</TableHead>
                  <TableHead className="text-right">Số GD</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.lines.map((l) => (
                  <TableRow key={l.group}>
                    <TableCell>
                      {/* Bấm vào mở đúng tập giao dịch đã sinh ra con số này, mang theo kỳ đang xem. */}
                      <Link
                        href={`/bank?tab=giao-dich&group=${l.group}${period.key !== "all" ? `&period=${period.key}` : ""}${period.key === "custom" && period.fromKey ? `&from=${period.fromKey}&to=${period.toKey}` : ""}`}
                        className="font-medium hover:text-primary hover:underline"
                        title={l.hint}
                      >
                        {l.label}
                      </Link>
                      {l.reconcileOnly ? (
                        <span
                          className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
                          title="Khoản này đã có nguồn chuyên biệt trong lợi nhuận (tài khoản QC / phiếu kho / vận đơn). Dòng sao kê chỉ để đối chiếu tiền ra, KHÔNG trừ lần thứ hai vào lãi lỗ."
                        >
                          chỉ đối chiếu
                        </span>
                      ) : null}
                      {l.group === "UNCLASSIFIED" ? (
                        <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">cần phân loại</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{l.moneyIn ? <Money value={l.moneyIn} /> : "—"}</TableCell>
                    <TableCell className="text-right">{l.moneyOut ? <Money value={l.moneyOut} /> : "—"}</TableCell>
                    <TableCell className={cn("text-right font-semibold", l.net < 0 && "text-rose-600 dark:text-rose-400")}>
                      <Money value={l.net} sign />
                    </TableCell>
                    <TableCell className="numeric text-right text-xs text-muted-foreground">{formatNumber(l.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ))}

      <p className="text-xs leading-5 text-muted-foreground">
        <span className={cn("mr-1.5 rounded px-1.5 py-0.5 font-medium", BALANCE_CONFIDENCE_TONE.DERIVED)}>{BALANCE_CONFIDENCE_LABEL.DERIVED}</span>
        {BALANCE_CONFIDENCE_HINT.DERIVED}
      </p>
    </div>
  );
}
