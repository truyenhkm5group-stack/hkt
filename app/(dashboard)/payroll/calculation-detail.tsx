import { HelpCircle } from "lucide-react";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { DataWarnings } from "@/components/data-warnings";
import { Money, SectionCard } from "@/components/ui-bits";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PAYROLL_COMPONENT_KIND_LABEL, PAYROLL_COMPONENT_SIGN, payrollInput, type PayrollComponentKind } from "@/lib/constants/payroll-components";
import { formatDate, formatNumber, MISSING_TEXT } from "@/lib/format";
import type { EmployeeEngineResult } from "@/lib/queries/payroll-engine";
import { cn } from "@/lib/utils";

/**
 * ═══ MỌI CON SỐ PHẢI TRUY NGUYÊN ĐƯỢC ═══
 *
 * Yêu cầu: *"Không chỉ hiện con số cuối cùng."* Khối này in đúng các bước mà máy tính đã làm, theo
 * đúng thứ tự nó đã làm — không dựng lại ở đây. Dựng lại ở tầng màn hình nghĩa là có hai phép tính:
 * cái ra tiền và cái ra lời giải thích, và chúng sẽ rời nhau đúng vào lúc ai đó cần đối chiếu nhất.
 *
 * Vết giải thích đi thẳng từ `ComponentResult.explain` — cùng mảng mà ảnh chụp kỳ đã chốt lưu lại,
 * nên sáu tháng sau mở lại vẫn đọc được đúng câu trả lời của lúc ấy.
 */
export function CalculationDetail({ engine, employeeName }: { engine: EmployeeEngineResult; employeeName: string }) {
  const { result } = engine;
  const rows = [...result.components, ...result.adjustments];
  const policies = [...new Map(engine.segments.filter((s) => s.policyId).map((s) => [`${s.policyCode}:${s.policyVersion}`, s])).values()];

  return (
    <SectionCard
      title={`Chi tiết cách tính — ${employeeName}`}
      hint="Tính bằng máy lương chung."
      actions={
        result.missing.length || result.problems.length || (engine.segments.length > 1 && engine.splitAcrossSegments) ? (
          <div className="flex flex-wrap items-center gap-2">
            {result.missing.length ? (
              <span className="text-[12px] font-medium text-destructive">Còn {result.missing.length} đại lượng CHƯA BIẾT</span>
            ) : null}
            <DataWarnings
              tone={result.missing.length || result.problems.length ? "danger" : "warn"}
              align="end"
              items={[
                ...result.problems,
                result.missing.length ? (
                  <div>
                    <p className="font-medium">Còn {result.missing.length} đại lượng CHƯA BIẾT — vì thế thực nhận là “{MISSING_TEXT}”, không phải 0 ₫</p>
                    <ul className="space-y-0.5">
                      {result.missing.map((m, i) => (
                        <li key={i}>
                          <b>{m.label}</b> — {m.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
                engine.segments.length > 1 && engine.splitAcrossSegments ? (
                  <>
                    Doanh thu, lợi nhuận và các đại lượng nhập tay được đo cho CẢ KỲ chứ không theo đoạn, nên chúng được chia theo SỐ NGÀY của từng đoạn. Đây là một ƯỚC TÍNH — căn cứ duy nhất sẵn có khi
                    một kỳ có nhiều đoạn.
                  </>
                ) : null,
              ]}
            />
          </div>
        ) : null
      }
      description={
        <>
          {policies.length ? (
            <>
              Chính sách:{" "}
              {policies.map((p, i) => (
                <span key={`${p.policyCode}:${p.policyVersion}`}>
                  {i > 0 ? " · " : ""}
                  <b>{p.policyName || p.policyCode}</b> bản #{p.policyVersion}
                </span>
              ))}
              .
            </>
          ) : (
            "Chưa gán chính sách nào."
          )}
        </>
      }
    >
      {engine.segments.length > 1 ? (
        <div className="mb-3 rounded-md border bg-muted/40 p-2 text-[12px]">
          <p className="font-medium">Kỳ này chia thành {engine.segments.length} đoạn</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {result.segments.map((s, i) => (
              <li key={i}>
                {formatDate(s.from)} → {formatDate(s.to)} ({s.days} ngày):{" "}
                {s.working ? (s.policyCode ? `${s.policyCode} bản #${s.policyVersion}` : "chưa gán chính sách") : "không làm việc trong đoạn này"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <TableToolsFor tableId="payroll-calculation-detail" />
      <div className="overflow-x-auto">
        <table id="payroll-calculation-detail" className="w-full min-w-[720px] text-[13px]">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Khoản</th>
              <th className="py-1 pr-3 font-medium">Loại</th>
              <th className="py-1 pr-3 font-medium">Căn cứ</th>
              <th className="py-1 text-right font-medium">Thành tiền</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-3 text-muted-foreground">
                  Chưa có thành phần nào tính ra được. Xem phần cảnh báo phía trên để biết còn thiếu gì.
                </td>
              </tr>
            ) : null}
            {rows.map((c) => {
              const sign = PAYROLL_COMPONENT_SIGN[c.kind as PayrollComponentKind] ?? 1;
              const spec = c.basisKey ? payrollInput(c.basisKey) : null;
              return (
                <tr key={c.code} className="border-t align-top">
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{c.label}</span>
                    {c.cappedBy ? (
                      <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        {c.cappedBy === "MAX" ? "chạm trần" : "nâng lên sàn"}
                      </span>
                    ) : null}
                    <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                      {c.explain.map((s, i) => (
                        <li key={i}>
                          {s.label}
                          {s.value !== null ? <>: <span className="tabular-nums">{formatNumber(s.value)}</span></> : null}
                          {s.note ? <span className="opacity-70"> — {s.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{PAYROLL_COMPONENT_KIND_LABEL[c.kind as PayrollComponentKind] ?? c.kind}</td>
                  <td className="py-1.5 pr-3">
                    {spec ? (
                      <Tooltip>
                        <TooltipTrigger className="inline-flex items-center gap-1 text-left">
                          {spec.label}
                          <HelpCircle className="size-3 opacity-60" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm text-[12px]">{spec.source}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground">Khoản khai sẵn trong chính sách</span>
                    )}
                  </td>
                  <td className={cn("py-1.5 text-right tabular-nums", sign < 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                    {c.amount === null ? <span className="text-muted-foreground">{MISSING_TEXT}</span> : <Money value={c.amount} sign />}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2">
            <tr>
              <td colSpan={3} className="py-1.5 pr-3 text-right font-medium">
                Tổng thu nhập
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">
                <Money value={result.grossEarnings} />
              </td>
            </tr>
            <tr>
              <td colSpan={3} className="py-1.5 pr-3 text-right font-medium">
                Tổng khấu trừ
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">
                <Money value={result.totalDeductions} />
              </td>
            </tr>
            <tr>
              <td colSpan={3} className="py-1.5 pr-3 text-right font-semibold">
                Thực nhận
              </td>
              <td className="py-1.5 text-right tabular-nums font-semibold">
                <Money value={result.netPay} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </SectionCard>
  );
}
