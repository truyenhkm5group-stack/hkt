"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui-bits";
import { startMessengerHistoryAction } from "@/lib/actions/sales-chatbot";
import { formatDateTime } from "@/lib/format";
import { MESSENGER_HISTORY_LIMITS, MESSENGER_HISTORY_STATUS_LABEL, messengerHistoryStale, type MessengerHistoryRun } from "@/lib/sales-chatbot/messenger-history-shared";

/**
 * «HỘI THOẠI GẦN ĐÂY TỪ FACEBOOK / INSTAGRAM» — trang Chatbot bán hàng, chỉ người quản lý chatbot, chỉ khi có page nối THẲNG Meta
 * (lib/sales-chatbot/messenger-history.ts). Không cần Pancake. Meta chỉ cho đọc 20 tin gần nhất mỗi hội thoại — nói thẳng giới hạn
 * đó trên màn hình. Không `router.refresh()` sau action (action đã `revalidatePath`); «Làm mới» để xem kết quả.
 */
/** `shell`: vỏ Chốt Đơn — chỉ đổi CHỮ (không «webhook»), câu của ERP giữ nguyên từng ký tự. */
export function MessengerHistoryPanel({ run, pages, shell = false }: { run: MessengerHistoryRun; pages: number; shell?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const running = run.status === "RUNNING" && !messengerHistoryStale(run, new Date());
  const total = (k: "conversations" | "inserted" | "duplicates" | "fresh") => run.pages.reduce((n, p) => n + p[k], 0);

  return (
    <SectionCard
      title="Hội thoại gần đây từ Facebook / Instagram"
      description={`Đưa hội thoại đã có của ${pages} page / tài khoản nối trực tiếp vào «Hộp thư khách» — không cần Pancake. Tin cũ chỉ để xem: bot không trả lời lại, máy ghi đơn không đọc lại, không tính «chưa đọc» / «chờ trả lời».`}
    >
      <div className="space-y-3 text-sm" data-testid="messenger-history-panel">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || running}
            onClick={() =>
              start(async () => {
                const r = await startMessengerHistoryAction();
                if ("error" in r) toast.error(r.error);
                else toast.success(r.message);
              })
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {run.status === "IDLE" ? "Nhập hội thoại gần đây" : "Nhập lại"}
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => router.refresh()}>
            Làm mới
          </Button>
        </div>
        <div className="space-y-1 text-xs" data-testid="messenger-history-status">
          <p>
            <span className="font-medium">{MESSENGER_HISTORY_STATUS_LABEL[run.status]}</span>
            {run.startedAt ? ` · bắt đầu ${formatDateTime(run.startedAt)}${run.requestedBy ? ` (${run.requestedBy})` : ""}` : ""}
            {run.finishedAt && run.status !== "RUNNING" ? ` · xong lúc ${formatDateTime(run.finishedAt)}` : ""}
          </p>
          {run.status === "DONE" || run.status === "FAILED" ? (
            <p className="text-muted-foreground">
              {total("conversations")} hội thoại · {total("inserted")} tin mới · {total("duplicates")} đã có · {total("fresh")} quá mới ({shell ? "để bot lo" : "để bot / webhook lo"})
            </p>
          ) : null}
          {run.pages
            .filter((p) => p.error)
            .map((p) => (
              <p key={p.pageId} className="text-red-600 dark:text-red-400">
                {p.kind === "INSTAGRAM" ? "Instagram" : "Page"} {p.pageId}: {p.error}
              </p>
            ))}
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Máy làm gì · giới hạn</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>Mỗi page: tối đa {MESSENGER_HISTORY_LIMITS.conversationsPerPage} hội thoại mới cập nhật nhất, mỗi hội thoại {MESSENGER_HISTORY_LIMITS.messagesPerConversation} tin gần nhất — giới hạn của Meta, không đọc được xa hơn.</li>
            <li>Hội thoại trong «Tin nhắn chờ» không hoạt động 30 ngày Meta không trả về.</li>
            <li>{shell ? "Tin đã có (đã nhận trực tiếp hoặc lần nhập trước) bị bỏ qua — nhập lại bao nhiêu lần cũng không nhân đôi." : "Tin đã có (webhook đã ghi, lần nhập trước) bị bỏ qua — nhập lại bao nhiêu lần cũng không nhân đôi."}</li>
            <li>Tin mới hơn {MESSENGER_HISTORY_LIMITS.freshMinutes} phút không nhập — đó là việc của bot{shell ? "" : " / webhook"}.</li>
          </ul>
        </details>
      </div>
    </SectionCard>
  );
}
