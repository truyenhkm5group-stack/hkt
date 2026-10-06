"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui-bits";
import { cancelInboxHistoryAction, startInboxHistoryAction } from "@/lib/actions/sales-chatbot";
import { formatDateTime } from "@/lib/format";
import { HISTORY_LIMITS, HISTORY_STATUS_LABEL, historyCountsText, historyRemainingText, historyRunStale, type HistoryRun } from "@/lib/sales-chatbot/history-shared";

/**
 * «ĐỒNG BỘ LỊCH SỬ HỘP THƯ» — trang Chatbot bán hàng, chỉ người quản lý chatbot. Đọc toàn bộ hội thoại + tin cũ của fanpage qua
 * Pancake vào «Hộp thư khách» (lib/sales-chatbot/history.ts). Chạy nền, tiến độ lưu ở máy chủ — đóng trang không dừng lượt. Không
 * `router.refresh()` sau action (action đã `revalidatePath`); «Làm mới» chỉ để xem tiến độ.
 */
export function InboxHistoryPanel({ run, fanpageReady }: { run: HistoryRun; fanpageReady: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const stale = historyRunStale(run, new Date());
  const running = run.status === "RUNNING" && !stale;
  const canResume = run.status === "FAILED" || run.status === "CANCELLED" || stale;

  const act = (fn: () => Promise<{ ok: true; message: string } | { error: string }>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <SectionCard
      title="Đồng bộ lịch sử hộp thư"
      description="Đọc TẤT CẢ hội thoại và tin cũ của fanpage (qua Pancake) vào «Hộp thư khách» — kể cả khách nhắn trước lúc nối page với ERP. Tin cũ chỉ để xem: bot không trả lời lại, máy ghi đơn không đọc lại, không tính «chưa đọc» / «chờ trả lời»."
    >
      <div className="space-y-3 text-sm" data-testid="inbox-history-panel">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => cancelInboxHistoryAction())}>
              Dừng
            </Button>
          ) : (
            <>
              {canResume ? (
                <Button size="sm" disabled={pending || !fanpageReady} onClick={() => act(() => startInboxHistoryAction({ mode: "resume" }))}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Chạy tiếp
                </Button>
              ) : null}
              <Button size="sm" variant={canResume ? "outline" : "default"} disabled={pending || !fanpageReady} onClick={() => act(() => startInboxHistoryAction({ mode: "restart" }))} title={fanpageReady ? undefined : "Bật kết nối «Fanpage qua Pancake» trước"}>
                {pending && !canResume ? <Loader2 className="size-4 animate-spin" /> : null}
                {run.status === "IDLE" ? "Đồng bộ lịch sử" : "Chạy lại từ đầu"}
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" disabled={pending} onClick={() => router.refresh()}>
            Làm mới
          </Button>
        </div>
        {!fanpageReady ? <p className="text-xs text-amber-700 dark:text-amber-400">Cần bật kết nối «Fanpage qua Pancake» (Cài đặt → Kết nối) — máy đọc lịch sử bằng page access token của shop.</p> : null}

        <div className="space-y-1 text-xs" data-testid="inbox-history-status">
          <p>
            <span className="font-medium">{stale ? "Bị ngắt giữa chừng" : HISTORY_STATUS_LABEL[run.status]}</span>
            {run.startedAt ? ` · bắt đầu ${formatDateTime(run.startedAt)}${run.requestedBy ? ` (${run.requestedBy})` : ""}` : ""}
            {run.finishedAt && run.status !== "RUNNING" ? ` · dừng lúc ${formatDateTime(run.finishedAt)}` : ""}
            {run.lastTickAt && run.status === "RUNNING" ? ` · nhịp cuối ${formatDateTime(run.lastTickAt)}` : ""}
          </p>
          {run.status !== "IDLE" ? <p className="text-muted-foreground">Đã đọc: {historyCountsText(run.counts)}.</p> : null}
          {run.status !== "IDLE" ? <p className="text-muted-foreground">{historyRemainingText(run, formatDateTime)}</p> : null}
          {run.retryAt && run.status === "RUNNING" ? <p className="text-amber-700 dark:text-amber-400">Đang tạm nghỉ tới {formatDateTime(run.retryAt)} rồi đọc tiếp.</p> : null}
          {run.lastError ? <p className="text-red-600 dark:text-red-400">Lỗi gần nhất: {run.lastError}</p> : null}
        </div>

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Máy làm gì · giới hạn</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>Đọc danh sách hội thoại của page từ mới tới cũ, rồi từng hội thoại; mỗi lời gọi cách nhau ≥ {HISTORY_LIMITS.requestGapMs} ms, Pancake báo quá tải thì tự nghỉ rồi đọc tiếp.</li>
            <li>Tin đã có trong ERP (webhook đã ghi, lượt trước đã nhập) bị bỏ qua — chạy lại bao nhiêu lần cũng không nhân đôi.</li>
            <li>Tin mới hơn {HISTORY_LIMITS.freshMinutes} phút không nhập — đó là việc của bot / webhook.</li>
            <li>Tiến độ lưu ở máy chủ sau mỗi lời gọi: máy khởi động lại thì tự đọc tiếp từ chỗ dừng (trong vòng 5 phút).</li>
            <li>SĐT khách Pancake đã ghi nhận được lưu cùng hội thoại để lọc «có SĐT».</li>
            <li>Chỉ kênh Facebook qua Pancake. Page nối trực tiếp với Facebook nhập ở khung «Hội thoại gần đây từ Facebook / Instagram»; Zalo OA chưa nhập được lịch sử.</li>
          </ul>
        </details>
      </div>
    </SectionCard>
  );
}
