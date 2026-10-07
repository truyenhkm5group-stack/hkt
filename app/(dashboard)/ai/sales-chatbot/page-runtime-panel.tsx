"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { savePageRuntimeAction } from "@/lib/actions/sales-page-runtime";
import { formatDateTime } from "@/lib/format";
import { PAGE_RUNTIME_LABEL, PAGE_RUNTIME_MODES, type PageRuntimeMode } from "@/lib/sales-chatbot/page-runtime-shared";
import type { PageRuntimeRow } from "@/lib/sales-chatbot/page-runtime";

const BADGE: Record<PageRuntimeMode, string> = {
  OFF: "bg-muted text-muted-foreground",
  SHADOW: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  LIVE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
};

/** Workspace nhà: đặt từng page ở Tắt / Bóng / Chạy thật cho bot Chốt Đơn. Không page nào tự bật — người có quyền bấm. */
export function PageRuntimePanel({ pages, manage }: { pages: PageRuntimeRow[]; manage: boolean }) {
  return (
    <div className="space-y-3 text-sm" data-testid="page-runtime-panel">
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" data-testid="legacy-bot-warning">
        Bot cũ (container <code>chatbot/</code>) vẫn đang chạy và trả lời khách trên các page của nhà — màn hình này KHÔNG tắt nó. Ở chế độ Bóng bot mới không gửi gì nên không sao; chuyển một page sang Chạy thật khi bot cũ còn trả lời page đó thì khách nhận HAI câu trả lời. Page chưa có trong danh sách = Tắt.
      </p>
      {pages.length === 0 ? (
        <p className="text-xs text-muted-foreground">Chưa có page nào: nối fanpage (qua Pancake / Messenger trực tiếp) hoặc Zalo OA ở Cài đặt → Kết nối trước.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {pages.map((p) => (
            <PageRow key={p.id} page={p} manage={manage} />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Câu bot soạn ở chế độ Bóng được đem so với câu thật của page (bot cũ / nhân viên) ở{" "}
        <Link href="/ai/sales-chatbot/copilot" className="underline underline-offset-2">
          Copilot — so gợi ý
        </Link>
        .
      </p>
    </div>
  );
}

function PageRow({ page, manage }: { page: PageRuntimeRow; manage: boolean }) {
  const [mode, setMode] = useState<PageRuntimeMode>(page.mode);
  const [ack, setAck] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const changed = mode !== page.mode;
  const needAck = mode === "LIVE" && changed;
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="page-runtime-row" data-page={page.id} data-mode={page.mode}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{page.name}</span>
          <span className={`shrink-0 rounded px-1.5 text-[11px] font-semibold ${BADGE[page.mode]}`}>{page.mode}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {page.id}
          {page.mode === "SHADOW" || page.shadowDrafts7d ? ` · ${page.shadowDrafts7d} câu soạn bóng / 7 ngày${page.lastShadowAt ? ` (gần nhất ${formatDateTime(page.lastShadowAt)})` : ""}` : ""}
          {page.updatedAt ? ` · đổi ${formatDateTime(page.updatedAt)}${page.updatedByEmail ? ` bởi ${page.updatedByEmail}` : ""}` : ""}
        </div>
      </div>
      <select value={mode} onChange={(e) => setMode(e.target.value as PageRuntimeMode)} disabled={!manage || pending} className="h-8 rounded-md border bg-background px-2 text-sm" data-testid="page-runtime-select">
        {PAGE_RUNTIME_MODES.map((m) => (
          <option key={m} value={m}>
            {PAGE_RUNTIME_LABEL[m]}
          </option>
        ))}
      </select>
      {needAck ? (
        <label className="flex basis-full items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Tôi xác nhận bot cũ (chatbot/) đã thôi trả lời page này
        </label>
      ) : null}
      {manage ? (
        <Button
          size="sm"
          disabled={!changed || pending || (needAck && !ack)}
          onClick={() =>
            start(async () => {
              const r = await savePageRuntimeAction({ pageId: page.id, mode, acknowledgeLegacyBot: ack });
              if ("error" in r) toast.error(r.error);
              else {
                toast.success(r.message);
                setAck(false);
                router.refresh();
              }
            })
          }
        >
          {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Lưu
        </Button>
      ) : null}
    </li>
  );
}
