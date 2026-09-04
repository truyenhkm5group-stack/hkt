"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, MessageCircle, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CaseDialog } from "@/app/(dashboard)/cs/case-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deleteCsCase, runCsDetection, updateCsCaseQuick } from "@/lib/actions/cs";
import { CS_KIND_LABEL, CS_SOURCE_LABEL, CS_STATUS_LABEL, CS_STATUS_TONE, CS_STATUSES, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { CsCaseRow } from "@/lib/queries/cs";
import { cn } from "@/lib/utils";

export function DetectButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button variant="outline" disabled={pending} onClick={() => startTransition(async () => { const r = await runCsDetection(); if ("error" in r) toast.error(r.error); else { toast.success(`Quét ${r.scanned} dấu hiệu · ${r.created} case mới`); router.refresh(); } })}>
      <RefreshCw className={cn("size-4", pending && "animate-spin")} /> Quét từ Pancake
    </Button>
  );
}

export function CsTable({ rows, assignees, canWrite }: { rows: CsCaseRow[]; assignees: string[]; canWrite: boolean }) {
  const [editing, setEditing] = useState<CsCaseRow | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const quick = (id: string, patch: { status?: string; assignee?: string }) => {
    setPendingId(id);
    startTransition(async () => {
      const r = await updateCsCaseQuick({ id, ...patch });
      setPendingId(null);
      if ("error" in r) toast.error(r.error);
      else router.refresh();
    });
  };
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Khách / đơn</TableHead>
            <TableHead>Nguồn</TableHead>
            <TableHead className="w-[150px]">Trạng thái</TableHead>
            <TableHead className="w-[160px]">Phụ trách</TableHead>
            <TableHead>Tạo lúc</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">Chưa có case nào. Bấm “Quét từ Pancake” hoặc “Thêm case”.</TableCell></TableRow>
          ) : rows.map((r) => {
            const chatHref = r.order?.pageId && r.order?.conversationId ? `https://pancake.vn/${r.order.pageId}?c_id=${r.order.conversationId}` : null;
            return (
              <TableRow key={r.id} className={cn(r.status === "DONE" || r.status === "CANCELLED" ? "opacity-70" : "")}>
                <TableCell className="max-w-[360px]">
                  <div className="font-semibold">{CS_KIND_LABEL[r.kind as CsKind] ?? r.kind}</div>
                  <div className="truncate text-sm" title={r.title}>{r.title}</div>
                  {r.detail ? <div className="line-clamp-2 text-xs text-muted-foreground" title={r.detail}>{r.detail}</div> : null}
                  {r.resolution ? <div className="mt-0.5 line-clamp-1 text-xs text-emerald-700" title={r.resolution}>✔ {r.resolution}</div> : null}
                </TableCell>
                <TableCell className="text-sm">
                  <div>{r.customerName || "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.customerPhone}</div>
                  {r.order ? (
                    <div className="mt-0.5 flex flex-wrap gap-2 text-xs">
                      <Link href={`/orders/${r.order.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="size-3" /> Đơn #{r.order.systemId ?? r.order.id}</Link>
                      {chatHref ? <a href={chatHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><MessageCircle className="size-3" /> Chat Pancake</a> : null}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{CS_SOURCE_LABEL[r.source] ?? r.source}</TableCell>
                <TableCell>
                  {canWrite ? (
                    <Select value={r.status} onValueChange={(v) => quick(r.id, { status: v })} disabled={pendingId === r.id}>
                      <SelectTrigger className={cn("h-8 w-full", CS_STATUS_TONE[r.status as CsStatus])}><SelectValue /></SelectTrigger>
                      <SelectContent>{CS_STATUSES.map((s) => <SelectItem key={s} value={s}>{CS_STATUS_LABEL[s]}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : <span className={cn("rounded px-1.5 py-0.5 text-xs", CS_STATUS_TONE[r.status as CsStatus])}>{CS_STATUS_LABEL[r.status as CsStatus] ?? r.status}</span>}
                </TableCell>
                <TableCell>
                  {canWrite ? (
                    <Select value={r.assignee || "__none__"} onValueChange={(v) => quick(r.id, { assignee: v === "__none__" ? "" : v })} disabled={pendingId === r.id}>
                      <SelectTrigger className="h-8 w-full"><SelectValue placeholder="Chưa gán" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Chưa gán</SelectItem>
                        {assignees.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : <span className="text-sm">{r.assignee || "—"}</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground" title={formatDateTime(r.createdAt)}>{formatTimeAgo(r.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {canWrite ? (
                    <>
                      <Button variant="ghost" size="icon" className="size-8" aria-label="Sửa" onClick={() => setEditing(r)}><Pencil className="size-4" /></Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Xoá" onClick={() => { if (confirm("Xoá case này?")) startTransition(async () => { const x = await deleteCsCase(r.id); if ("error" in x) toast.error(x.error); else router.refresh(); }); }}><Trash2 className="size-4" /></Button>
                    </>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {editing ? <CaseDialog caseRow={editing} assignees={assignees} open onOpenChange={(v) => { if (!v) setEditing(null); }} /> : null}
    </div>
  );
}
