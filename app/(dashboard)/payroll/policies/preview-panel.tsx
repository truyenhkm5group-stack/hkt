"use client";

import { useState, useTransition } from "react";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui-bits";
import { PAYROLL_COMPONENT_SIGN, PAYROLL_INPUTS, componentBasisKey, type PayrollComponentKind, type PolicyComponent } from "@/lib/constants/payroll-components";
import { previewPolicyCalculation } from "@/lib/actions/payroll-preview";
import type { PayrollItemResult } from "@/lib/payroll/engine";
import { MISSING_TEXT, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const firstOfMonth = () => `${today().slice(0, 7)}-01`;

/**
 * ═══ XEM THỬ: NHẬP ĐẠI LƯỢNG MẪU, ĐỌC RA CON SỐ THẬT ═══
 *
 * Chỉ hỏi những đại lượng mà chính sách ĐANG khai thật sự cần — hỏi cả mười hai ô là bắt người
 * khai điền chín ô không liên quan, và rồi họ sẽ điền bừa.
 *
 * Không có một phép nhân nào trong tệp này: mọi con số đến từ `previewPolicyCalculation`, và hàm
 * ấy gọi CHÍNH máy tính mà bảng lương gọi.
 */
export function PreviewPanel({ components }: { components: PolicyComponent[] }) {
  const [pending, start] = useTransition();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [basis, setBasis] = useState<Record<string, string>>({});
  const [carry, setCarry] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PayrollItemResult | null>(null);

  /** Đại lượng mà chính sách đang khai cần — trừ PERIOD_DAYS (máy tự suy từ mốc kỳ). */
  const canHoi = [...new Set(components.map((c) => componentBasisKey(c.calc)).filter((k): k is string => Boolean(k) && k !== "PERIOD_DAYS"))];
  const buLo = components.filter((c) => c.carryForward);

  const chay = () =>
    start(async () => {
      const r = await previewPolicyCalculation({
        from,
        to,
        components,
        basis: Object.fromEntries(canHoi.map((k) => [k, basis[k] === "" || basis[k] === undefined ? null : Number(basis[k])])),
        carryOpening: Object.fromEntries(buLo.map((c) => [c.code, carry[c.code] === "" || carry[c.code] === undefined ? null : Number(carry[c.code])])),
        adjustments: [],
      });
      if ("error" in r) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      setResult(r.result);
    });

  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-background p-3">
      <p className="text-[12px] text-muted-foreground">
        <b>Xem thử phép tính.</b> Chạy qua ĐÚNG máy tính mà bảng lương dùng, nên con số ở đây là con số sẽ được trả. Không ghi gì: không tạo kỳ lương, không ghi sổ lỗ, không tạo khoản điều chỉnh,
        không phát hành phiên bản.
      </p>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label>Kỳ mẫu từ</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>đến</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {canHoi.map((k) => {
          const spec = PAYROLL_INPUTS.find((i) => i.key === k);
          return (
            <div key={k} className="space-y-1">
              <Label htmlFor={`bs-${k}`}>{spec?.label ?? k}</Label>
              <Input id={`bs-${k}`} type="number" value={basis[k] ?? ""} onChange={(e) => setBasis((s) => ({ ...s, [k]: e.target.value }))} placeholder="để trống = CHƯA BIẾT" />
              <p className="text-[10px] text-muted-foreground">{spec?.availability === "MANUAL" ? "Phải nhập tay khi chạy thật" : "ERP đo được khi chạy thật"}</p>
            </div>
          );
        })}
        {buLo.map((c) => (
          <div key={c.code} className="space-y-1">
            <Label htmlFor={`cy-${c.code}`}>Lỗ đầu kỳ · {c.label}</Label>
            <Input id={`cy-${c.code}`} type="number" value={carry[c.code] ?? ""} onChange={(e) => setCarry((s) => ({ ...s, [c.code]: e.target.value }))} placeholder="vd −10000000" />
          </div>
        ))}
      </div>

      <Button size="sm" variant="outline" onClick={chay} disabled={pending || !components.length}>
        <FlaskConical className="size-4" /> Xem thử phép tính
      </Button>

      {result ? (
        <div className="overflow-x-auto rounded-md border bg-muted/30 p-2">
          <table className="w-full min-w-[520px] text-[13px]">
            <tbody>
              {[...result.components, ...result.adjustments].map((c) => {
                const sign = PAYROLL_COMPONENT_SIGN[c.kind as PayrollComponentKind] ?? 1;
                return (
                  <tr key={c.code} className="border-b align-top">
                    <td className="py-1 pr-3">
                      {c.label}
                      <ul className="mt-0.5 space-y-0.5 text-[10px] text-muted-foreground">
                        {c.explain.map((s, i) => (
                          <li key={i}>
                            {s.label}
                            {s.value !== null ? `: ${formatNumber(s.value)}` : ""}
                            {s.note ? ` — ${s.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className={cn("py-1 text-right tabular-nums", sign < 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                      {c.amount === null ? <span className="text-muted-foreground">{MISSING_TEXT}</span> : <Money value={c.amount} sign />}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="py-1 pr-3 text-right font-medium">Tổng thu nhập</td>
                <td className="py-1 text-right tabular-nums font-medium">
                  <Money value={result.grossEarnings} />
                </td>
              </tr>
              <tr>
                <td className="py-1 pr-3 text-right font-medium">Tổng khấu trừ</td>
                <td className="py-1 text-right tabular-nums font-medium">
                  <Money value={result.totalDeductions} />
                </td>
              </tr>
              <tr className="border-t-2">
                <td className="py-1.5 pr-3 text-right font-semibold">Thực nhận</td>
                <td className="py-1.5 text-right tabular-nums font-semibold">
                  <Money value={result.netPay} />
                </td>
              </tr>
            </tbody>
          </table>
          {result.missing.length ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-400">
              {result.missing.map((m, i) => (
                <li key={i}>
                  <b>{m.label}</b> — {m.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
