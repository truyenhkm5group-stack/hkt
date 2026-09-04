"use client";

import { useState } from "react";
import { Braces } from "lucide-react";
import { CopyButton } from "@/components/misc";
import { RunStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SYNC_SOURCE_LABEL } from "@/lib/constants/sync";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { WebhookRow } from "@/lib/queries/integrations";

export function WebhookEventsTable({ rows }: { rows: WebhookRow[] }) {
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const json = selected ? JSON.stringify(selected.payload, null, 2) : "";

  return (
    <>
      <div className="overflow-x-auto">
        <Table className="min-w-[860px]">
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Nguồn</TableHead>
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Loại</TableHead>
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Mã ngoài</TableHead>
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Trạng thái</TableHead>
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Lỗi</TableHead>
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Nhận lúc</TableHead>
              <TableHead className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Xử lý lúc</TableHead>
              <TableHead className="h-10 w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setSelected(row)}>
                  <TableCell className="text-xs font-semibold">{SYNC_SOURCE_LABEL[row.source] ?? row.source}</TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{row.eventLabel}</div>
                    <div className="font-mono text-[10.5px] text-muted-foreground">{row.eventType || "—"}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.externalId || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <RunStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell>
                    {row.error ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="block max-w-[220px] cursor-help truncate text-xs text-destructive">{row.error}</span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md whitespace-pre-wrap break-words">{row.error}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    <div>{formatDateTime(row.receivedAt)}</div>
                    <div className="text-[10.5px]">{formatTimeAgo(row.receivedAt)}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{row.processedAt ? formatDateTime(row.processedAt) : "—"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Xem JSON" onClick={(e) => { e.stopPropagation(); setSelected(row); }}>
                      <Braces className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="h-28 text-center text-sm text-muted-foreground">
                  Chưa nhận webhook nào. Cấu hình URL webhook ở phần trên; sự kiện sẽ hiện tại đây ngay khi Pancake / Viettel Post gửi tới.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="flex w-full flex-col sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Dữ liệu webhook</SheetTitle>
            <SheetDescription>
              {selected ? `${SYNC_SOURCE_LABEL[selected.source] ?? selected.source} · ${selected.eventLabel}${selected.externalId ? ` · ${selected.externalId}` : ""} · nhận lúc ${formatDateTime(selected.receivedAt)}` : ""}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
              <div className="flex items-center justify-between gap-2 text-xs">
                <RunStatusBadge status={selected.status} />
                <CopyButton value={json} label="Sao chép JSON" />
              </div>
              {selected.error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{selected.error}</p> : null}
              <pre className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5">{json}</pre>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
