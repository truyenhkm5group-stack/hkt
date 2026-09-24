import { InfoHint } from "@/components/info-hint";
import { Money } from "@/components/ui-bits";
import { PAYROLL_COMPONENT_KIND_LABEL, type PayrollComponentKind } from "@/lib/constants/payroll-components";
import { MISSING_TEXT } from "@/lib/format";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { cn } from "@/lib/utils";

/**
 * ═══ PHIẾU LƯƠNG ĐỌC TỪ ẢNH CHỤP ═══
 *
 * In ĐÚNG một dòng của ảnh chụp kỳ — không tính lại gì. Đây là thứ người lao động xác nhận, nên nó
 * phải là con số đã gửi, không phải con số hôm nay. Hai đường tính (máy chung / bốn ô cũ) in theo
 * đúng cấu trúc của chúng; dòng khấu trừ theo luật không bao giờ in "0 ₫" khi chưa ai khai
 * (AGENTS.md mục 42).
 */
export function PayslipBreakdown({ line, statutory }: { line: PayrollSnapshot["lines"][number]; statutory: { amount: number | null; label: string; hint: string } }) {
  const engine = line.engine;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-[13px]">
        <tbody>
          {engine && engine.components.length ? (
            <>
              {/* Số của máy chung ĐÃ MANG DẤU (`lib/payroll/engine.ts`), nên chỉ tô màu, không nhân dấu lần nữa. */}
              {[...engine.components, ...engine.adjustments].map((c) => (
                <tr key={c.code} className="border-b">
                  <td className="py-1.5 pr-3">
                    {c.label}
                    <span className="ml-2 text-[11px] text-muted-foreground">{PAYROLL_COMPONENT_KIND_LABEL[c.kind as PayrollComponentKind] ?? c.kind}</span>
                  </td>
                  <td className={cn("py-1.5 text-right tabular-nums", (c.amount ?? 0) < 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                    {c.amount === null ? <span className="text-muted-foreground">{MISSING_TEXT}</span> : <Money value={c.amount} sign />}
                  </td>
                </tr>
              ))}
              <StatutoryRow statutory={statutory} />
              <NetRow value={engine.netPay} />
            </>
          ) : (
            <>
              <Row label={line.employmentClip ? `Lương cứng (${line.employmentClip.days} ngày làm, ${line.employmentClip.from} → ${line.employmentClip.to})` : "Lương cứng (phần thuộc kỳ)"} value={line.fixed} />
              <Row label={`Thưởng ${line.percentTotal}% lợi nhuận toàn shop`} value={line.bonusTotal} hideZero={!line.percentTotal} />
              <Row label={`Hoa hồng ${line.percentPersonal}% lợi nhuận cá nhân`} value={line.bonusPersonal} hideZero={!line.percentPersonal} />
              <Row label={`Hoa hồng ${line.percentRevenue}% doanh thu cá nhân`} value={line.bonusRevenue} hideZero={!line.percentRevenue} />
              {(line.legacyAdjustments?.items ?? []).map((a, i) => (
                <tr key={`adj-${i}`} className="border-b">
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex items-center gap-1">
                      {a.label}
                      {a.reason ? <InfoHint>{a.reason}</InfoHint> : null}
                    </span>
                  </td>
                  <td className={cn("py-1.5 text-right tabular-nums", a.amount < 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                    <Money value={a.amount} sign />
                  </td>
                </tr>
              ))}
              <StatutoryRow statutory={statutory} />
              <NetRow value={line.salary} />
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, value, hideZero }: { label: string; value: number | null; hideZero?: boolean }) {
  if (hideZero && !value) return null;
  return (
    <tr className="border-b">
      <td className="py-1.5 pr-3">{label}</td>
      <td className="py-1.5 text-right tabular-nums">
        <Money value={value} />
      </td>
    </tr>
  );
}

function NetRow({ value }: { value: number | null }) {
  return (
    <tr className="border-t-2">
      <td className="py-2 pr-3 text-right font-semibold">Thực nhận</td>
      <td className="py-2 text-right font-semibold tabular-nums">
        <Money value={value} className="text-base" />
      </td>
    </tr>
  );
}

function StatutoryRow({ statutory }: { statutory: { amount: number | null; label: string; hint: string } }) {
  return (
    <tr className="border-b">
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-1">
          Khấu trừ theo luật (thuế TNCN · BHXH · BHYT · BHTN)
          <InfoHint>{statutory.hint}</InfoHint>
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums">
        {statutory.amount === null ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{statutory.label}</span>
        ) : statutory.amount === 0 ? (
          <span className="text-[11px] text-muted-foreground">{statutory.label}</span>
        ) : (
          <Money value={statutory.amount} sign />
        )}
      </td>
    </tr>
  );
}
