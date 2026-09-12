"use client";

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { workHistory } from "@/lib/actions/work";
import { formatDateTime } from "@/lib/format";

const ACTION_LABEL: Record<string, string> = {
  CREATE: "Tạo việc",
  STATUS: "Đổi trạng thái",
  ASSIGN: "Giao việc",
  NOTE: "Ghi chú",
  SNOOZE: "Hoãn",
  DUE: "Đặt hạn",
  PRIORITY: "Đổi ưu tiên",
  BLOCK: "Báo bị chặn",
  DOMAIN_ACTION: "Hành động nghiệp vụ",
};

/**
 * Lịch sử một việc — CHỈ THÊM, đọc trên chính dòng.
 *
 * Nạp khi mở chứ không nạp sẵn: một hàng đợi 150 dòng mà dòng nào cũng kéo lịch sử là 150 truy vấn
 * cho thứ người dùng mở đúng một lần.
 */
export function WorkHistoryButton({ workKey }: { workKey: string }) {
  const [rows, setRows] = useState<{ id: string; action: string; note: string; actor: string; at: string; previousStatus: string | null; nextStatus: string | null }[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (open: boolean) => {
    if (!open || rows || loading) return;
    setLoading(true);
    const r = await workHistory(workKey);
    setLoading(false);
    setRows("error" in r ? [] : r.events);
  };

  return (
    <Popover onOpenChange={load}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Lịch sử việc: ai làm gì, lúc nào">
          <History className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-80 w-80 overflow-y-auto p-2.5" align="end">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Đang đọc lịch sử…</p>
        ) : !rows?.length ? (
          <p className="text-xs text-muted-foreground">Chưa có thao tác nào được ghi cho việc này. Lịch sử chỉ ghi thao tác đi qua hàng đợi — việc xử lý thẳng ở module gốc có lịch sử riêng tại đó.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((e) => (
              <li key={e.id} className="border-l-2 pl-2 text-xs">
                <p className="font-medium">
                  {ACTION_LABEL[e.action] ?? e.action}
                  {e.previousStatus && e.nextStatus ? <span className="font-normal text-muted-foreground"> · {e.previousStatus} → {e.nextStatus}</span> : null}
                </p>
                {e.note ? <p className="text-muted-foreground">{e.note}</p> : null}
                <p className="text-[11px] text-muted-foreground">{e.actor} · {formatDateTime(e.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
