import Link from "next/link";
import { objectDef } from "@/lib/constants/object-registry";
import { domainEventLabel } from "@/lib/constants/domain-events";
import { formatDateTime } from "@/lib/format";
import { ACTION_KIND_LABEL, APPROVAL_QUEUE_HREF, MODE_LABEL, RUN_STATUS_TONE, runStatusLabel, STEP_STATUS_LABEL, TRIGGER_KIND_LABEL } from "@/lib/platform-ui/workflow-admin-shared";
import type { WorkflowRunRow } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/**
 * Bảng «Lượt chạy gần đây» của một luật — CHỈ ĐỌC, dựng ở máy chủ từ `listRuns` của dịch vụ.
 *
 * Mỗi trạng thái có nhãn tiếng Việt riêng: «Chạy thử — không làm thật» KHÁC «Đã làm» (người đọc phải biết máy
 * đã thật sự tạo việc hay chưa). Lượt chờ duyệt trỏ về hàng đợi duyệt đã có — không có nút duyệt thứ hai ở đây.
 */
export function WorkflowRunsTable({ runs }: { runs: WorkflowRunRow[] }) {
  if (runs.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Chưa có lượt chạy nào — luật chạy ké job cảnh báo (10 phút / lượt) sau khi được bật.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Thời điểm</th>
            <th className="px-3 py-2">Nguồn</th>
            <th className="px-3 py-2">Bản ghi</th>
            <th className="px-3 py-2">Trạng thái</th>
            <th className="px-3 py-2">Các bước</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-hairline align-top">
              <td className="whitespace-nowrap px-3 py-2">
                <div>{formatDateTime(r.createdAt)}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  v{r.ruleVersion} · {MODE_LABEL[r.mode]}
                </div>
              </td>
              <td className="px-3 py-2">
                <div>{TRIGGER_KIND_LABEL[r.triggerKind]}</div>
                <div className="max-w-[220px] truncate font-mono text-[11.5px] text-muted-foreground" title={r.triggerRef}>
                  {r.triggerKind === "event" ? domainEventLabel(r.triggerRef) : r.triggerRef}
                </div>
              </td>
              <td className="px-3 py-2">
                {r.subjectId ? (
                  <>
                    <div className="text-[11.5px] text-muted-foreground">{(r.subjectType && objectDef(r.subjectType)?.label) ?? r.subjectType ?? "—"}</div>
                    <div className="max-w-[180px] truncate font-mono text-[12px]" title={r.subjectId}>
                      {r.subjectId}
                    </div>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2">
                <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", RUN_STATUS_TONE[r.status])}>{runStatusLabel(r.status, r.error)}</span>
                {r.status === "WAITING_APPROVAL" ? (
                  <div className="mt-1 text-[11.5px]">
                    <Link href={APPROVAL_QUEUE_HREF} className="text-primary underline-offset-2 hover:underline">
                      Mở hàng đợi duyệt
                    </Link>
                    {" · "}
                    <Link href="/work" className="text-primary underline-offset-2 hover:underline">
                      /work
                    </Link>
                  </div>
                ) : null}
                {r.error ? <div className="mt-1 max-w-[260px] text-[11.5px] text-destructive">{r.error}</div> : null}
                {r.causationDepth > 0 ? <div className="mt-1 text-[11.5px] text-muted-foreground">Độ sâu nhân quả {r.causationDepth}</div> : null}
              </td>
              <td className="px-3 py-2">
                {r.steps.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ol className="space-y-0.5 text-[12.5px]">
                    {r.steps.map((s, i) => (
                      <li key={i}>
                        <b>{ACTION_KIND_LABEL[s.action] ?? s.action}</b> · <span className={cn(s.status === "FAILED" && "text-destructive")}>{STEP_STATUS_LABEL[s.status] ?? s.status}</span>
                        {s.detail ? <span className="text-muted-foreground"> — {s.detail}</span> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
