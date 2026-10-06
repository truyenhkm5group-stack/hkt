"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { WebhookRow } from "@/lib/integrations/messenger/permission-guide";
import { cn } from "@/lib/utils";
import { recheckMessengerWebhooksAction } from "./actions";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * Trạng thái webhook THEO PAGE (graph.ts `checkPageWebhook`): page đã lưu trong ERP chưa chắc đang gửi tin về — Meta có thể gỡ
 * đăng ký sau đó. Nút «Kiểm tra lại» chỉ ĐỌC ở Meta. `initial` là lần kiểm lúc nối page gần nhất (có mốc giờ), không phải bây giờ.
 */
export function WebhookCheckPanel({ initial, initialAt, manage, actorLabel }: { initial: WebhookRow[]; initialAt: string | null; manage: boolean; actorLabel: Record<string, string> }) {
  const [rows, setRows] = useState(initial);
  const [at, setAt] = useState(initialAt);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const recheck = () =>
    start(async () => {
      const r = await recheckMessengerWebhooksAction();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setRows(r.rows);
      setAt(r.checkedAt);
      setNote(r.truncated ? `Chỉ kiểm ${r.rows.length} page đầu — còn ${r.truncated} page chưa kiểm.` : null);
    });
  return (
    <div className="space-y-2" data-testid="messenger-webhook-check">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{at ? `Kiểm lúc ${fmt(at)}` : "Chưa kiểm lần nào."}</span>
        {manage ? (
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending} onClick={recheck} data-testid="messenger-webhook-recheck">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Kiểm tra lại
          </Button>
        ) : null}
      </div>
      {note ? <p className="text-xs text-amber-700 dark:text-amber-400">{note}</p> : null}
      {rows.length ? (
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.pageId} className="space-y-1 px-3 py-2 text-sm" data-testid="messenger-webhook-row" data-state={r.state}>
              <p>
                <span className="font-semibold">{r.name}</span> <span className="text-xs text-muted-foreground">(Page ID {r.pageId})</span>{" "}
                <span className={cn("text-xs font-medium", r.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : r.tone === "bad" ? "text-destructive" : "text-muted-foreground")}>· {r.label}</span>
                {r.tokenExpiresAt ? <span className="text-xs text-muted-foreground"> · token hết hạn {fmt(r.tokenExpiresAt)}</span> : null}
              </p>
              {r.detail ? <p className="text-xs text-muted-foreground">{r.detail}</p> : null}
              {r.guide ? (
                <div className="text-xs">
                  <p className="font-medium">
                    {r.guide.title} — {actorLabel[r.guide.actor] ?? r.guide.actor}:
                  </p>
                  <ol className="list-decimal pl-5 text-muted-foreground">
                    {r.guide.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
