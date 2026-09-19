import Link from "next/link";
import { Card } from "@/components/ui/card";
import { costLabel } from "@/lib/constants/ai";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { RUN_BREAKDOWNS, RUN_BREAKDOWN_LABEL, salesModelBreakdown, salesRunBreakdown, type RunBreakdown } from "@/lib/queries/sales-metrics";
import { cn } from "@/lib/utils";

/**
 * BÓC TÁCH SỐ ĐO — page · ngày · ý định chính · bản nhắc, và một bảng riêng cho MÔ HÌNH.
 *
 * Hai bảng, vì chúng ở HAI ĐỘ MỊN: bảng trên đếm LƯỢT CHẠY, bảng dưới đếm LẦN GỌI mô hình. Một
 * lượt có thể gọi mô hình hai lần (bước Hiểu và bước Soạn) hoặc không gọi lần nào, nên đặt hai con
 * số ấy cạnh nhau dưới cùng một cột là mời người đọc chia nhầm chúng cho nhau.
 */
const th = "p-2 text-left font-medium text-muted-foreground";
const td = "p-2 tabular-nums";

export async function BreakdownCard({ dim, days }: { dim: RunBreakdown; days: number }) {
  const [rows, models] = await Promise.all([salesRunBreakdown(days, dim), salesModelBreakdown(days)]);
  const tongLuot = rows.reduce((s, r) => s + r.runs, 0);

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Bóc tách {formatNumber(tongLuot)} lượt chạy · {days} ngày</h2>
        <div className="flex flex-wrap gap-1">
          {RUN_BREAKDOWNS.map((d) => (
            <Link
              key={d}
              href={`/ai?dim=${d}&days=${days}`}
              className={cn("rounded-md border px-2 py-1 text-xs", d === dim ? "border-foreground font-medium" : "border-border text-muted-foreground hover:bg-muted")}
            >
              {RUN_BREAKDOWN_LABEL[d]}
            </Link>
          ))}
        </div>
      </div>

      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60">
                <th className={th}>{RUN_BREAKDOWN_LABEL[dim]}</th>
                <th className={cn(th, "text-right")}>Lượt</th>
                <th className={cn(th, "text-right")}>Chuyển người</th>
                <th className={cn(th, "text-right")}>Lỗi</th>
                <th className={cn(th, "text-right")}>Trung vị ms</th>
                <th className={cn(th, "text-right")}>Token vào / ra</th>
                <th className={cn(th, "text-right")}>Chi phí</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/40 last:border-0">
                  <td className="p-2">{r.label}</td>
                  <td className={cn(td, "text-right font-medium")}>{formatNumber(r.runs)}</td>
                  <td className={cn(td, "text-right")}>
                    {formatNumber(r.handoffs)}
                    {/* Mẫu số 0 ⇒ "—". Một dòng không có lượt nào mà in "0%" là khẳng định một điều chưa đo được. */}
                    <span className="ml-1 text-muted-foreground">{r.handoffRate === null ? "—" : `(${formatPercent(r.handoffRate)})`}</span>
                  </td>
                  <td className={cn(td, "text-right", r.errors > 0 && "text-rose-700 dark:text-rose-300")}>{formatNumber(r.errors)}</td>
                  <td className={cn(td, "text-right")}>{formatNumber(r.medianLatencyMs)}</td>
                  <td className={cn(td, "text-right")}>
                    {formatNumber(r.inputTokens)} / {formatNumber(r.outputTokens)}
                  </td>
                  <td className={cn(td, "text-right")}>
                    {costLabel(r.costVnd, (n) => formatVND(n))}
                    {r.unpricedRuns > 0 ? <span className="ml-1 text-[10px] text-amber-700 dark:text-amber-300">{formatNumber(r.unpricedRuns)} lượt chưa khai giá</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Chưa có lượt chạy nào trong {days} ngày.</p>
      )}

      <p className="text-[11px] text-muted-foreground">
        Mỗi lượt chạy nằm ở ĐÚNG MỘT dòng, nên cộng cột &quot;Lượt&quot; ra đúng tổng. Chiều Ý ĐỊNH lấy ý định ĐẦU TIÊN: một lượt mang
        nhiều ý định, và trải hết ra sẽ làm tổng các dòng lớn hơn số lượt thật mà không ai nhận ra.
      </p>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Mô hình — đếm theo LẦN GỌI, không phải lượt chạy</h3>
        {models.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60">
                  <th className={th}>Nhà cung cấp · mô hình · nấc</th>
                  <th className={cn(th, "text-right")}>Lần gọi</th>
                  <th className={cn(th, "text-right")}>Hỏng</th>
                  <th className={cn(th, "text-right")}>Token vào / ra</th>
                  <th className={cn(th, "text-right")}>Đệm</th>
                  <th className={cn(th, "text-right")}>Trung vị ms</th>
                  <th className={cn(th, "text-right")}>Chi phí</th>
                  <th className={th}>Bảng giá</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={`${m.provider}-${m.model}-${m.tier}`} className="border-b border-border/40 last:border-0">
                    <td className="p-2">
                      {m.provider} · {m.model} · {m.tier}
                    </td>
                    <td className={cn(td, "text-right font-medium")}>{formatNumber(m.calls)}</td>
                    <td className={cn(td, "text-right", m.failedCalls > 0 && "text-rose-700 dark:text-rose-300")}>{formatNumber(m.failedCalls)}</td>
                    <td className={cn(td, "text-right")}>
                      {formatNumber(m.inputTokens)} / {formatNumber(m.outputTokens)}
                    </td>
                    <td className={cn(td, "text-right")}>{m.cachedInputTokens ? formatNumber(m.cachedInputTokens) : "—"}</td>
                    <td className={cn(td, "text-right")}>{formatNumber(m.medianLatencyMs)}</td>
                    <td className={cn(td, "text-right")}>{costLabel(m.costVnd, (n) => formatVND(n))}</td>
                    {/* Bảng giá đứng NGAY CẠNH số tiền: một con số tiền không nói nó tính theo bảng
                        giá nào thì hai kỳ khác giá trông giống hệt nhau khi đọc lại. */}
                    <td className="p-2 text-muted-foreground">{m.pricingVersions.length ? m.pricingVersions.join(", ") : "chưa khai — chi phí là CHƯA BIẾT"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Không gọi mô hình lần nào trong {days} ngày — mọi lượt xử lý hết bằng luật, và chi phí thật sự bằng 0.
          </p>
        )}
      </div>
    </Card>
  );
}
