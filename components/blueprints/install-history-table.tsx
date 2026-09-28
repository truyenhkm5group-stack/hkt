import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { PLAN_ACTION_LABEL, type InstallHistoryRow, type PlanAction } from "@/lib/blueprints/types";

const STATUS_LABEL: Record<InstallHistoryRow["status"], string> = { RUNNING: "Đang chạy / dừng đột ngột", DONE: "Xong", FAILED: "Dừng giữa chừng" };

/** Bảng lịch sử cài — chỉ đọc. Người gọi bọc khung cuộn ngang (`overflow-x-auto`). */
export function InstallHistoryTable({ rows, showTemplate = false }: { rows: InstallHistoryRow[]; showTemplate?: boolean }) {
  return (
    <table className="w-full min-w-[760px] text-sm">
      <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-3 py-2">Lúc</th>
          {showTemplate ? <th className="px-3 py-2">Mẫu</th> : null}
          <th className="px-3 py-2">Phiên bản</th>
          <th className="px-3 py-2">Kết quả</th>
          <th className="px-3 py-2">Đã ghi</th>
          <th className="px-3 py-2">Người bấm</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const written = (Object.entries(r.counts) as [PlanAction, number][]).filter(([, n]) => n > 0);
          return (
            <tr key={r.id} className="border-t border-hairline align-top">
              <td className="whitespace-nowrap px-3 py-2">{formatDateTime(r.installedAt)}</td>
              {showTemplate ? <td className="px-3 py-2 font-mono text-[12.5px]">{r.blueprintKey}</td> : null}
              <td className="numeric px-3 py-2">{r.version}</td>
              <td className="px-3 py-2">
                <Badge variant={r.status === "DONE" ? "secondary" : r.status === "FAILED" ? "destructive" : "outline"}>{STATUS_LABEL[r.status]}</Badge>
                {r.error ? <p className="mt-1 max-w-[360px] text-xs text-muted-foreground">{r.error}</p> : null}
              </td>
              <td className="px-3 py-2 text-xs">{written.length ? written.map(([a, n]) => `${PLAN_ACTION_LABEL[a]} ${n}`).join(" · ") : "Không ghi gì (mọi mục không đổi)"}</td>
              <td className="px-3 py-2 text-xs">{r.installedByEmail ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
