import { TRACE_STAGE_LABEL, traceCodeLabel, type MessageTrace, type TraceStep } from "@/lib/sales-chatbot/ai-status-shared";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const MARK: Record<TraceStep["state"], string> = { DONE: "✓", FAILED: "✗", CURRENT: "…", NOT_REACHED: "·", NOT_MEASURED: "?" };

/**
 * DẤU VẾT MỘT TIN KHÁCH dưới bong bóng tin: Đã nhận → Đủ điều kiện AI → Xếp hàng → Đang soạn → Đã soạn → Đang gửi → Đã gửi, hoặc
 * dừng ở đâu với mã gì (ai-status.ts). Dòng gọn luôn hiện; bấm mở ra từng bước kèm mốc và NGUỒN dữ liệu. Bước không có mốc đã lưu
 * ghi «chưa đo» — không bịa giờ.
 */
export function MessageTraceLine({ trace }: { trace: MessageTrace }) {
  const stop = trace.steps.find((s) => s.state === "FAILED" || s.state === "CURRENT");
  const last = [...trace.steps].reverse().find((s) => s.state === "DONE");
  const head = stop ?? last;
  const tone = trace.outcome === "SENT" ? "text-emerald-700 dark:text-emerald-300" : trace.outcome === "IN_PROGRESS" ? "text-muted-foreground" : "text-rose-700 dark:text-rose-300";
  return (
    <details className={cn("mt-0.5 max-w-[78%] px-1 text-[11px]", tone)} data-testid="message-trace" data-code={trace.code ?? ""} data-outcome={trace.outcome}>
      <summary className="cursor-pointer select-none list-none">
        {head ? `${MARK[head.state]} ${TRACE_STAGE_LABEL[head.stage]}` : "?"}
        {trace.code ? (
          <>
            {" · "}
            <code className="font-mono">{trace.code.startsWith("UNKNOWN") ? "UNKNOWN" : trace.code}</code> {traceCodeLabel(trace.code)}
          </>
        ) : null}
      </summary>
      <ol className="mt-1 space-y-0.5 rounded-md border bg-background/80 p-1.5 text-muted-foreground">
        {trace.steps.map((s) => (
          <li key={s.stage} className={cn(s.state === "FAILED" && "font-medium text-rose-700 dark:text-rose-300")} title={s.source}>
            {MARK[s.state]} {TRACE_STAGE_LABEL[s.stage]} — {s.state === "NOT_REACHED" ? "chưa tới" : s.at ? formatDateTime(s.at) : "chưa đo"}
          </li>
        ))}
        {trace.detail ? <li className="break-words pt-0.5">Ghi chú gốc: {trace.detail}</li> : null}
      </ol>
    </details>
  );
}
