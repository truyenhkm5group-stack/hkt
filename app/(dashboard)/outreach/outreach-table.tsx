"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, ExternalLink, MessageCircle, Pencil, RefreshCw, Send, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { buildOutreach, sendOutreach, skipOutreach, updateOutreachMessage } from "@/lib/actions/outreach";
import { OUTREACH_STATUS_LABEL, OUTREACH_STATUS_TONE } from "@/lib/constants/outreach";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { OutreachRow } from "@/lib/queries/outreach";
import { cn } from "@/lib/utils";

export function BuildButton({ segment }: { segment: "NURTURE" | "CROSS_SELL" }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await buildOutreach(segment);
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(`Thêm ${r.nurture + r.crossSell} khách mới${r.scanned ? ` · quét ${r.scanned} hội thoại` : ""}${r.errors.length ? ` · ${r.errors.length} lỗi` : ""}`);
            router.refresh();
          }
        })
      }
    >
      <RefreshCw className={cn("size-4", pending && "animate-spin")} /> Lập danh sách hôm nay
    </Button>
  );
}

function toCsv(rows: OutreachRow[]) {
  const esc = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Khách", "SĐT", "Ngữ cảnh", "Gợi ý", "Nội dung tin", "Trạng thái", "Lý do"].join(",");
  return [head, ...rows.map((r) => [r.customerName, r.phone, r.context, r.suggestions, r.message, OUTREACH_STATUS_LABEL[r.status] ?? r.status, r.error].map(esc).join(","))].join("\n");
}

export function OutreachTable({ rows, segment, canWrite }: { rows: OutreachRow[]; segment: "NURTURE" | "CROSS_SELL"; canWrite: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<OutreachRow | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const pendingRows = useMemo(() => rows.filter((r) => r.status === "PENDING"), [rows]);
  const allSelected = pendingRows.length > 0 && pendingRows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pendingRows.map((r) => r.id)));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...selected];

  const send = () =>
    startTransition(async () => {
      const r = await sendOutreach(ids);
      if ("error" in r) toast.error(r.error);
      else {
        toast[r.failed ? "warning" : "success"](`Đã gửi ${r.sent} · lỗi ${r.failed} · bỏ qua ${r.skipped} · còn ${r.remainingToday} lượt hôm nay`);
        setSelected(new Set());
        router.refresh();
      }
    });
  const skip = () =>
    startTransition(async () => {
      const r = await skipOutreach(ids);
      if ("error" in r) toast.error(r.error);
      else { setSelected(new Set()); router.refresh(); }
    });
  const exportCsv = () => {
    const list = ids.length ? rows.filter((r) => selected.has(r.id)) : rows;
    const blob = new Blob(["﻿" + toCsv(list)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `outreach-${segment.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const saveDraft = () =>
    startTransition(async () => {
      if (!editing) return;
      const r = await updateOutreachMessage(editing.id, draft);
      if ("error" in r) toast.error(r.error);
      else { setEditing(null); router.refresh(); }
    });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
        {canWrite ? (
          <>
            <span className="text-muted-foreground">{ids.length ? `Đã chọn ${ids.length}` : "Tích chọn khách chờ gửi để gửi hàng loạt"}</span>
            <Button size="sm" disabled={!ids.length || pending} onClick={() => { if (confirm(`Gửi ${ids.length} tin qua inbox Pancake?`)) send(); }}><Send className="size-4" /> Gửi qua Pancake</Button>
            <Button size="sm" variant="outline" disabled={!ids.length || pending} onClick={skip}><SkipForward className="size-4" /> Bỏ qua</Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={exportCsv} disabled={!rows.length}><Download className="size-4" /> Xuất CSV {ids.length ? "(đã chọn)" : "(trang này)"}</Button>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[1080px]">
          <TableHeader>
            <TableRow>
              {canWrite ? <TableHead className="w-10"><Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Chọn tất cả" /></TableHead> : null}
              <TableHead>Khách</TableHead>
              <TableHead>{segment === "NURTURE" ? "Tin nhắn cuối của khách" : "Đã mua · gợi ý bán chéo"}</TableHead>
              <TableHead className="w-[380px]">Nội dung sẽ gửi</TableHead>
              <TableHead className="w-[110px]">Trạng thái</TableHead>
              <TableHead>{segment === "NURTURE" ? "Nhắn lúc" : "Nhận hàng"}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">Chưa có khách nào. Bấm “Lập danh sách hôm nay” (hoặc chờ job tự chạy lúc 08:30).</TableCell></TableRow>
            ) : rows.map((r) => {
              const chatHref = r.pageId && r.conversationId ? `https://pancake.vn/${r.pageId}?c_id=${r.conversationId}` : null;
              return (
                <TableRow key={r.id} className={cn(r.status === "SKIPPED" && "opacity-60")}>
                  {canWrite ? <TableCell>{r.status === "PENDING" ? <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label="Chọn" /> : null}</TableCell> : null}
                  <TableCell className="text-sm">
                    <div className="font-medium">{r.customerName || "—"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.phone || "—"}</div>
                    <div className="mt-0.5 flex flex-wrap gap-2 text-xs">
                      {r.order ? <Link href={`/orders/${r.order.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="size-3" /> Đơn #{r.order.systemId ?? r.order.id}</Link> : null}
                      {chatHref ? <a href={chatHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><MessageCircle className="size-3" /> Chat Pancake</a> : <span className="text-muted-foreground">Không có hội thoại</span>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[260px] text-xs">
                    <div className="line-clamp-3" title={r.context}>{r.context || "—"}</div>
                    {r.suggestions ? <div className="mt-1 text-primary">→ {r.suggestions}</div> : null}
                  </TableCell>
                  <TableCell className="text-xs"><div className="line-clamp-4 whitespace-pre-wrap" title={r.message}>{r.message}</div></TableCell>
                  <TableCell>
                    <span className={cn("rounded px-1.5 py-0.5 text-xs", OUTREACH_STATUS_TONE[r.status])}>{OUTREACH_STATUS_LABEL[r.status] ?? r.status}</span>
                    {r.error ? <div className="mt-1 line-clamp-2 text-[11px] text-rose-600" title={r.error}>{r.error}</div> : null}
                    {r.sentAt ? <div className="mt-1 text-[11px] text-muted-foreground">{formatDateTime(r.sentAt)}{r.sentBy ? ` · ${r.sentBy}` : ""}</div> : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={formatDateTime(r.lastActivityAt)}>{formatTimeAgo(r.lastActivityAt)}</TableCell>
                  <TableCell>{canWrite && r.status === "PENDING" ? <Button variant="ghost" size="icon" className="size-8" aria-label="Sửa nội dung" onClick={() => { setEditing(r); setDraft(r.message); }}><Pencil className="size-4" /></Button> : null}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Dialog open={Boolean(editing)} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Sửa nội dung tin · {editing?.customerName}</DialogTitle>
            <DialogDescription>Nội dung này sẽ được gửi vào inbox Pancake của khách khi bấm “Gửi qua Pancake”.</DialogDescription>
          </DialogHeader>
          <Textarea rows={7} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Huỷ</Button>
            <Button onClick={saveDraft} disabled={pending}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
