import Link from "next/link";
import { Banknote, Coins, Landmark, PiggyBank, Scale, TrendingDown, TrendingUp } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { PROFIT_GATE_LOSS_MESSAGE } from "@/lib/constants/payroll-profit-gate";
import { formatVND } from "@/lib/format";
import { PROFIT_GATE_STATUS_LABEL } from "@/lib/payroll/profit-gate";
import type { PayrollProfitGate } from "@/lib/queries/payroll";
import { cn } from "@/lib/utils";

/**
 * ═══ ĐIỀU KIỆN THƯỞNG LỢI NHUẬN TOÀN CÔNG TY — BẢY CON SỐ, ĐỨNG TRƯỚC BẢNG LƯƠNG ═══
 *
 * Chủ shop yêu cầu 19/10/2026: người đọc bảng lương phải thấy được VÌ SAO một khoản thưởng % lợi
 * nhuận được duyệt hay không, trước khi đọc con số của từng người. Mọi số lấy thẳng từ
 * `lib/payroll/profit-gate.ts` — màn hình không tự cộng trừ lại.
 *
 * `null` in "—" (CHƯA BIẾT), không bao giờ "0 ₫" (AGENTS.md mục 42).
 */
export function ProfitGatePanel({ gate, settingsHref }: { gate: PayrollProfitGate; settingsHref: string | null }) {
  const r = gate.result;
  const v = (n: number | null) => (n === null ? "—" : formatVND(n, { compact: true }));
  const conLo = r.status === "NO_ELIGIBLE_PROFIT" && (r.lossToRecover ?? 0) > 0;
  const chuaKetLuan = r.status === "NOT_ESTABLISHED" || r.status === "DATA_INCOMPLETE" || r.status === "NOT_APPLICABLE";
  return (
    <SectionCard
      title="Điều kiện thưởng lợi nhuận toàn công ty"
      description={
        <>
          <b>{PROFIT_GATE_STATUS_LABEL[r.status]}</b>
          {gate.policy ? ` · quy chế v${gate.policy.version} (${gate.policy.regulationRef}), mở sổ ${gate.policy.openingMonth}` : " · chưa khai quy chế"}
          {r.monthKey ? ` · tháng ${r.monthKey}` : ""}
        </>
      }
      hint={
        <>
          <p>Thưởng % lợi nhuận (kể cả % lợi nhuận cá nhân) chỉ phát sinh từ phần lợi nhuận còn lại SAU KHI công ty đã bù hết lỗ lũy kế và vượt mốc cao nhất đã chia (High-Water Mark).</p>
          <p className="mt-1">Lợi nhuận đủ điều kiện = max(0, lợi nhuận tháng − lỗ cần bù). Quỹ thưởng tối đa = lợi nhuận đủ điều kiện × % quy chế. Tổng thưởng của mọi người không bao giờ vượt quỹ.</p>
          <p className="mt-1">Lợi nhuận tháng = lợi nhuận tính lương (đã trừ giá vốn, quảng cáo, vận chuyển, hoàn, vận hành, lương cố định) − hoa hồng thông thường; thưởng lợi nhuận không nằm trong đó nên không có vòng lặp công thức.</p>
        </>
      }
      actions={settingsHref ? <Link href={settingsHref} className="text-[12px] font-medium underline">Khai / xem quy chế</Link> : null}
    >
      <div className="space-y-3">
        {conLo ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm font-semibold text-destructive">{PROFIT_GATE_LOSS_MESSAGE}</div>
        ) : null}
        {chuaKetLuan || !r.established ? (
          <div className={cn("rounded-xl border px-3 py-2 text-[13px]", r.status === "NOT_APPLICABLE" ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100" : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200")}>
            {r.message}
            {gate.simulatedMonths.length ? ` Tháng còn nháp đang mô phỏng: ${gate.simulatedMonths.join(", ")} — khoá lần lượt từng tháng để số dư đủ căn cứ chốt.` : ""}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">{r.message}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
          <MetricCard
            label="Lợi nhuận kỳ hiện tại"
            value={<span className={cn(r.periodBase !== null && r.periodBase < 0 && "text-destructive")}>{v(r.periodBase)}</span>}
            note={gate.lateAdjustments.length ? `gồm ${gate.lateAdjustments.length} điều chỉnh lũy kế: ${formatVND(gate.lateAdjustments.reduce((t, a) => t + a.amount, 0), { compact: true, sign: true })}` : "trước thưởng % lợi nhuận"}
            hint={`Lợi nhuận tính lương ${v(gate.ownBase === null ? null : gate.ownBase + (gate.regularVariable ?? 0))} − hoa hồng thông thường ${v(gate.regularVariable)}${gate.lateAdjustments.map((a) => ` ${a.amount >= 0 ? "+" : "−"} ${v(Math.abs(a.amount))} (điều chỉnh lũy kế${a.aboutMonth ? ` của tháng ${a.aboutMonth}` : ""}: ${a.reason} — duyệt bởi ${a.approvedByEmail})`).join("")}. Tháng đã khoá không tự tính lại: chứng từ đến muộn của nó ghi bằng điều chỉnh lũy kế ở Lương → Cấu hình.`}
            icon={r.periodBase !== null && r.periodBase < 0 ? TrendingDown : TrendingUp}
            tone={r.periodBase !== null && r.periodBase < 0 ? "rose" : "green"}
            goodWhen="neutral"
          />
          <MetricCard
            label="Lũy kế toàn công ty"
            value={<span className={cn(r.cumulativeBeforeShare !== null && r.cumulativeBeforeShare < 0 && "text-destructive")}>{v(r.cumulativeBeforeShare)}</span>}
            note={`đầu tháng ${v(r.openingCumulative)}`}
            hint="Lợi nhuận/lỗ lũy kế của công ty nội bộ tới hết kỳ này, sau mọi thưởng lợi nhuận đã chia các tháng trước, trước thưởng của tháng này. Chỉ gồm pháp nhân đang xem — không cộng P&L của khách SaaS."
            icon={Landmark}
            tone={r.cumulativeBeforeShare !== null && r.cumulativeBeforeShare < 0 ? "rose" : "slate"}
            goodWhen="neutral"
          />
          <MetricCard
            label="Số lỗ cần bù"
            value={v(r.lossToRecover)}
            note={`mốc cao nhất đã chia ${v(r.openingHighWater)}`}
            hint="Mốc cao nhất đã chia − lũy kế đầu tháng. Lợi nhuận phải lấp hết khoảng này trước khi phát sinh thưởng mới — kể cả phần lỗ phát sinh SAU một tháng đã thưởng."
            icon={Scale}
            tone={(r.lossToRecover ?? 0) > 0 ? "rose" : "slate"}
            goodWhen="neutral"
          />
          <MetricCard label="LN đủ điều kiện phân chia" value={v(r.eligibleProfit)} hint="max(0, lợi nhuận kỳ − số lỗ cần bù)." icon={PiggyBank} tone="primary" goodWhen="neutral" />
          <MetricCard
            label="Tổng quỹ thưởng tối đa"
            value={v(r.poolCap)}
            note={r.poolCapPercent === null ? "chưa khai quy chế" : `${r.poolCapPercent}% LN đủ điều kiện`}
            icon={Coins}
            tone="primary"
            goodWhen="neutral"
          />
          <MetricCard label="Thưởng LN đã chi" value={v(r.paidToDate)} note="lũy kế trước tháng này" hint="Thưởng % lợi nhuận đã chốt ở các tháng đã khoá kể từ mốc mở sổ, cộng phần khai trong quy chế cho trước mốc." icon={Banknote} tone="slate" goodWhen="neutral" />
          <MetricCard
            label="Còn được phép phân bổ"
            value={v(r.remaining)}
            note={r.allocatedTotal === null ? "chưa kết luận" : `đã phân bổ ${v(r.allocatedTotal)} / đề nghị ${v(r.demandTotal)}`}
            icon={Coins}
            tone="slate"
            goodWhen="neutral"
          />
        </div>
        {r.provisionalTotal !== null && r.allocatedTotal !== null && r.provisionalTotal !== r.allocatedTotal ? (
          <p className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
            Thưởng % lợi nhuận tạm tính theo công thức cũ {formatVND(r.provisionalTotal)} → đủ điều kiện {formatVND(r.allocatedTotal)} (chưa đủ điều kiện {formatVND(r.provisionalTotal - r.allocatedTotal)}).
            <InfoHint label="Vì sao khác">Tạm tính = lợi nhuận của RIÊNG kỳ × %, không nhìn lỗ lũy kế. Phần chưa đủ điều kiện không bị xoá khỏi màn hình và không phải nợ của nhân viên — nó chỉ không được duyệt trả.</InfoHint>
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
