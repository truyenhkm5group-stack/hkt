"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { resumeBroadcastAction, stopBroadcastAction } from "@/lib/actions/outreach-broadcast";
import { BROADCAST_SKIP_LABEL, BROADCAST_STATUS_LABEL, type BroadcastSkipReason } from "@/lib/constants/outreach-broadcast";
import { OUTREACH_ERROR_SPECS, type OutreachErrorKind } from "@/lib/constants/outreach-errors";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export type BroadcastHistoryRow = {
  id: string;
  name: string;
  status: string;
  /** RUNNING mà vòng gửi đã chết (nhịp tim cũ) — cần bấm Tiếp tục. */
  stale: boolean;
  total: number;
  messageCount: number;
  createdByName: string;
  createdAt: string;
  finishedAt: string | null;
  pending: number;
  sending: number;
  sent: number;
  skipped: number;
  failed: number;
  replied: number;
  ordered: number;
  reasons: { status: string; reason: string; n: number }[];
};

const POLL_MS = 5000;

function reasonLabel(status: string, reason: string) {
  if (status === "SKIPPED") return BROADCAST_SKIP_LABEL[reason as BroadcastSkipReason] ?? reason;
  if (reason === "PARTIAL") return "Gửi được một phần";
  return OUTREACH_ERROR_SPECS[reason as OutreachErrorKind]?.label ?? (reason || "Lỗi");
}

export function BroadcastHistory({ rows, canSend }: { rows: BroadcastHistoryRow[]; canSend: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const live = rows.some((r) => r.status === "RUNNING" && !r.stale);

  // Chỉ tự tải lại khi có lượt đang chạy thật — không thì trang đứng yên.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [live, router]);

  const act = (fn: typeof stopBroadcastAction, id: string, ok: string) =>
    startTransition(async () => {
      const r = await fn({ id });
      if ("error" in r) toast.error(r.error);
      else toast.success(ok);
    });

  return (
    <SectionCard
      title="Các lượt đã gửi"
      hint="Khách nhắn lại: hội thoại có tin của khách SAU lúc nhận tin (theo lượt quét hội thoại, chỉ thấy trong 48 giờ). Có đơn: đơn chưa huỷ trong 7 ngày sau tin, ghép theo hội thoại hoặc SĐT — đây là TƯƠNG QUAN, không phải bằng chứng tin nhắn làm khách mua (không có nhóm đối chứng)."
      padded={false}
    >
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Chưa có lượt gửi nào.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th className="px-3 py-2 font-medium">Lượt</th>
                <th className="px-3 py-2 font-medium">Trạng thái</th>
                <th className="px-3 py-2 text-right font-medium">Khách</th>
                <th className="px-3 py-2 text-right font-medium">Đã gửi</th>
                <th className="px-3 py-2 text-right font-medium">Bỏ qua · Lỗi</th>
                <th className="px-3 py-2 text-right font-medium">Chờ</th>
                <th className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1">Nhắn lại · Có đơn</span>
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const done = r.sent + r.skipped + r.failed;
                const running = r.status === "RUNNING" && !r.stale;
                const resumable = canSend && r.pending > 0 && (r.status === "STOPPED" || r.stale);
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.createdByName || "—"} · {r.messageCount} tin/khách{r.finishedAt ? ` · xong ${formatDateTime(r.finishedAt)}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", running ? "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300" : r.stale ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" : "bg-muted text-muted-foreground")}>
                        {r.stale ? "Ngừng giữa chừng" : (BROADCAST_STATUS_LABEL[r.status] ?? r.status)}
                      </span>
                      {running ? <div className="mt-1 text-xs text-muted-foreground">{formatNumber(done)}/{formatNumber(r.total)}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.total)}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatNumber(r.sent)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        {formatNumber(r.skipped)} · {formatNumber(r.failed)}
                        {r.reasons.length ? (
                          <InfoHint label="Lý do">
                            <ul className="space-y-0.5">
                              {r.reasons.map((x) => (
                                <li key={`${x.status}-${x.reason}`}>
                                  {formatNumber(x.n)} · {x.status === "SKIPPED" ? "bỏ qua" : "lỗi"}: {reasonLabel(x.status, x.reason)}
                                </li>
                              ))}
                            </ul>
                          </InfoHint>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.pending + r.sending)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(r.replied)} · {formatNumber(r.ordered)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canSend && running ? (
                        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(stopBroadcastAction, r.id, "Đã dừng — khách chưa gửi vẫn còn, bấm Tiếp tục khi cần")}>
                          <Pause className="size-4" /> Dừng
                        </Button>
                      ) : resumable ? (
                        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(resumeBroadcastAction, r.id, "Đang gửi tiếp")}>
                          <Play className="size-4" /> Tiếp tục
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
