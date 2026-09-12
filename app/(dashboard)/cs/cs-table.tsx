"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlarmClock, ExternalLink, Loader2, MessageCircle, MessageSquarePlus, Pencil, RefreshCw, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { CaseDialog } from "@/app/(dashboard)/cs/case-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { addCsCaseNote, csQuickAction, deleteCsCase, getCsCaseHistory, runCsDetection, updateCsCaseQuick } from "@/lib/actions/cs";
import { CS_HUMAN_STATUSES, CS_KIND_LABEL, CS_SOURCE_LABEL, CS_STATUS_LABEL, CS_STATUS_TONE, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { CS_EVENT_ACTION_LABEL, CS_QUICK_ACTION, CS_QUICK_ACTIONS_BY_KIND, CS_SNOOZE_PRESETS, type CsQuickActionKey } from "@/lib/constants/cs-actions";
import { CS_CASE_SLA_HOURS, isBotAssignee } from "@/lib/constants/cs-domain";
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

/**
 * ═══════════ BẢNG CSKH LÀ CHỖ LÀM VIỆC, KHÔNG PHẢI CHỖ NGẮM ═══════════
 *
 * Ba luật của một dòng:
 *
 *  1. **Phản hồi tại chỗ.** Mọi thao tác vẽ kết quả lên dòng trước (`patches`) rồi mới đồng bộ với
 *     máy chủ. Hỏng thì hoàn tác đúng dòng đó và báo lỗi ngay đó — không nhảy trang, không mất vị
 *     trí cuộn. `router.refresh()` chỉ chạy SAU khi máy chủ xác nhận, để hoà lại các số ở đầu trang.
 *  2. **Chữ dài không được chiếm chỗ của nút.** Bằng chứng (ghi chú bưu tá, đoạn chat, kết luận,
 *     lịch sử) nằm sau nút "Xem bằng chứng"; dòng chỉ giữ một câu. Bảng cũ in cả `detail` lẫn
 *     `resolution` nhiều dòng chữ xanh/đỏ, và 40 case cao bằng ba màn hình.
 *  3. **Nút phụ thuộc loại case.** `lib/constants/cs-actions.ts` khai việc thường làm nhất của
 *     từng loại; ở đây chỉ dịch sang nút — và ẩn nút `LINK` khi không có đích thật, vì một nút bấm
 *     vào không đi đâu làm người dùng mất tin vào cả hàng nút còn lại.
 */

/** Thay đổi đã vẽ lên dòng nhưng máy chủ có thể chưa xác nhận. */
type Patch = { status?: string; assignee?: string; followUpAt?: string | null; note?: { lastNote: string; lastNoteBy: string; lastNoteAt: Date; noteCount: number } };
type QuickResult = { ok: true } | { error: string };

const isClosed = (s: string) => s === "DONE" || s === "CANCELLED" || s === "AUTO_RESOLVED";

function snoozeTarget(hours: number): Date {
  if (hours >= 0) return new Date(Date.now() + hours * 3_600_000);
  // "Sáng mai" = 8 giờ sáng hôm sau, theo đồng hồ của máy người dùng (nhân viên ngồi ở Việt Nam).
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

export function CsTable({ rows, assignees, canWrite, currentUser }: { rows: CsCaseRow[]; assignees: string[]; canWrite: boolean; currentUser: string }) {
  const [editing, setEditing] = useState<CsCaseRow | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, Patch>>({});
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Dữ liệu mới từ máy chủ đã về ⇒ bỏ lớp vẽ tạm, không để hai nguồn sự thật chồng lên nhau.
  useEffect(() => setPatches({}), [rows]);

  /** Chạy một thao tác: vẽ trước, gọi sau, hỏng thì hoàn tác đúng dòng. */
  const run = async (id: string, optimistic: Patch, call: () => Promise<QuickResult>, okMessage?: string) => {
    const rollback = patches[id];
    setPatches((p) => ({ ...p, [id]: { ...p[id], ...optimistic } }));
    setPendingId(id);
    const res = await call();
    setPendingId(null);
    if ("error" in res) {
      setPatches((p) => ({ ...p, [id]: rollback ?? {} }));
      toast.error(res.error);
      return false;
    }
    if (okMessage) toast.success(okMessage);
    startTransition(() => router.refresh());
    return true;
  };

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[1080px]">
        <TableHeader>
          <TableRow>
            <TableHead>Case · việc cần làm</TableHead>
            <TableHead>Khách / đơn</TableHead>
            <TableHead className="w-[170px]">Phụ trách</TableHead>
            <TableHead className="w-[130px]">Tuổi / hẹn</TableHead>
            <TableHead className="w-[150px]">Trạng thái</TableHead>
            <TableHead className="w-[300px]">Hành động</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">Không còn case CSKH nào phải làm. Case sinh từ trạng thái giao vận nằm ở “Vận đơn &amp; care”.</TableCell></TableRow>
          ) : rows.map((r) => {
            const patch = patches[r.id] ?? {};
            const status = patch.status ?? r.status;
            const assignee = patch.assignee ?? r.assignee;
            const followUpAt = patch.followUpAt !== undefined ? (patch.followUpAt ? new Date(patch.followUpAt) : null) : r.followUpAt;
            const note = patch.note ?? r.note;
            const owner = isBotAssignee(assignee) ? "" : assignee;
            const chatHref = r.chatUrl || (r.order?.pageId && r.order?.conversationId ? `https://pancake.vn/${r.order.pageId}?c_id=${r.order.conversationId}` : null);
            const ageHours = (Date.now() - new Date(r.createdAt).getTime()) / 3_600_000;
            const overdue = !isClosed(status) && ageHours > CS_CASE_SLA_HOURS;
            const busy = pendingId === r.id;
            const keys = CS_QUICK_ACTIONS_BY_KIND[r.kind as CsKind] ?? [];

            return (
              <TableRow key={r.id} className={cn(isClosed(status) && "opacity-60", busy && "bg-muted/40")}>
                <TableCell className="max-w-[340px] align-top">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold">{CS_KIND_LABEL[r.kind as CsKind] ?? r.kind}</span>
                    {r.domain === "LOGISTICS" ? <span className="rounded bg-sky-100 px-1 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-950/60 dark:text-sky-300">Vận đơn</span> : null}
                  </div>
                  <div className="truncate text-sm text-muted-foreground" title={r.title}>{r.title}</div>
                  {note?.lastNote ? (
                    <div className="mt-0.5 truncate text-xs text-foreground/80" title={note.lastNote}>
                      <span className="text-muted-foreground">Ghi chú:</span> {note.lastNote}
                    </div>
                  ) : null}
                  <EvidencePopover row={r} noteCount={note?.noteCount ?? 0} />
                </TableCell>

                <TableCell className="align-top text-sm">
                  <div>{r.customerName || "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.customerPhone}</div>
                  {r.order || r.shipment ? (
                    <div className="mt-0.5 flex flex-wrap gap-2 text-xs">
                      {r.order ? <Link href={`/orders/${r.order.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="size-3" /> Đơn #{r.order.systemId ?? r.order.id}</Link> : null}
                      {r.shipment ? <Link href={`/shipments/${r.shipment.shipmentId}`} className="inline-flex items-center gap-1 text-muted-foreground hover:underline"><Truck className="size-3" /> {r.shipment.tracking}</Link> : null}
                    </div>
                  ) : null}
                </TableCell>

                <TableCell className="align-top">
                  {canWrite ? (
                    owner ? (
                      <Select value={owner} onValueChange={(v) => run(r.id, { assignee: v === "__none__" ? "" : v }, () => updateCsCaseQuick({ id: r.id, assignee: v === "__none__" ? "" : v }))} disabled={busy}>
                        <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Bỏ gán</SelectItem>
                          {assignees.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="space-y-1">
                        <Button size="sm" variant="secondary" className="h-8 w-full" disabled={busy} title={CS_QUICK_ACTION.CLAIM.hint} onClick={() => run(r.id, { assignee: currentUser, status: status === "OPEN" ? "IN_PROGRESS" : status }, () => csQuickAction({ id: r.id, action: "CLAIM" }), "Đã nhận việc")}>
                          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {CS_QUICK_ACTION.CLAIM.label}
                        </Button>
                        {/*
                          BOT LÀ NGƯỜI TẠO, KHÔNG PHẢI NGƯỜI XỬ LÝ. Job tự nhắn khách ghi tên mình
                          vào ô phụ trách; đọc nguyên văn thì hàng đợi trông như đã có người lo
                          trong khi thực tế chưa ai nhận.
                        */}
                        {isBotAssignee(assignee) ? <div className="text-[11px] text-muted-foreground">Bot đã nhắn · chưa ai nhận</div> : null}
                      </div>
                    )
                  ) : <span className="text-sm">{owner || (isBotAssignee(assignee) ? "Bot đã nhắn" : "—")}</span>}
                </TableCell>

                <TableCell className="align-top text-xs">
                  <div className={cn(overdue ? "font-semibold text-rose-600 dark:text-rose-400" : "text-muted-foreground")} title={formatDateTime(r.createdAt)}>
                    {formatTimeAgo(r.createdAt)}
                    {overdue ? " · quá hạn" : ""}
                  </div>
                  {followUpAt ? (
                    <div className={cn("mt-0.5 inline-flex items-center gap-1", followUpAt.getTime() <= Date.now() ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")} title={`Hẹn lại ${formatDateTime(followUpAt)}`}>
                      <AlarmClock className="size-3" /> {formatDateTime(followUpAt)}
                    </div>
                  ) : null}
                </TableCell>

                <TableCell className="align-top">
                  {canWrite ? (
                    <Select value={status} onValueChange={(v) => run(r.id, { status: v }, () => updateCsCaseQuick({ id: r.id, status: v }))} disabled={busy}>
                      <SelectTrigger className={cn("h-8 w-full", CS_STATUS_TONE[status as CsStatus])}><SelectValue /></SelectTrigger>
                      {/* AUTO_RESOLVED không có ở đây: máy đóng khác người đóng, xem CS_HUMAN_STATUSES. */}
                      <SelectContent>{CS_HUMAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{CS_STATUS_LABEL[s]}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : <span className={cn("rounded px-1.5 py-0.5 text-xs", CS_STATUS_TONE[status as CsStatus])}>{CS_STATUS_LABEL[status as CsStatus] ?? status}</span>}
                </TableCell>

                <TableCell className="align-top">
                  <div className="flex flex-wrap items-center gap-1">
                    {r.domain === "LOGISTICS" ? (
                      <Button asChild size="sm" variant="outline" className="h-8" title={CS_QUICK_ACTION.OPEN_CARE.hint}>
                        <Link href={r.shipment ? `/shipments/${r.shipment.shipmentId}` : "/shipments"}>{CS_QUICK_ACTION.OPEN_CARE.label}</Link>
                      </Button>
                    ) : null}
                    {canWrite
                      ? keys.map((key) => (
                          <QuickButton
                            key={key}
                            actionKey={key}
                            busy={busy}
                            chatHref={chatHref}
                            orderHref={r.order ? `/orders/${r.order.id}` : null}
                            caseId={r.id}
                            status={status}
                            currentUser={currentUser}
                            onMutate={run}
                          />
                        ))
                      : null}
                    {canWrite ? <NoteButton caseId={r.id} busy={busy} onSaved={(n) => setPatches((p) => ({ ...p, [r.id]: { ...p[r.id], note: n } }))} /> : null}
                    {canWrite ? (
                      <>
                        <Button variant="ghost" size="icon" className="size-8" aria-label="Sửa" onClick={() => setEditing(r)}><Pencil className="size-4" /></Button>
                        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Xoá" disabled={busy} onClick={() => { if (confirm("Xoá case này?")) startTransition(async () => { const x = await deleteCsCase(r.id); if ("error" in x) toast.error(x.error); else router.refresh(); }); }}><Trash2 className="size-4" /></Button>
                      </>
                    ) : null}
                  </div>
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

type RunFn = (id: string, optimistic: Patch, call: () => Promise<QuickResult>, okMessage?: string) => Promise<boolean>;

/** Một nút hành động nhanh. `LINK` chỉ mở đúng chỗ; `MUTATE` ghi và vẽ kết quả ngay tại dòng. */
function QuickButton({
  actionKey,
  busy,
  chatHref,
  orderHref,
  caseId,
  status,
  currentUser,
  onMutate,
}: {
  actionKey: CsQuickActionKey;
  busy: boolean;
  chatHref: string | null;
  orderHref: string | null;
  caseId: string;
  status: string;
  currentUser: string;
  onMutate: RunFn;
}) {
  const spec = CS_QUICK_ACTION[actionKey];
  if (spec.mode === "LINK") {
    const href = actionKey === "OPEN_ORDER" ? orderHref : chatHref;
    // Đơn landing / sheet không có hội thoại Pancake ⇒ không vẽ nút dẫn tới hư không.
    if (!href) return null;
    const external = href.startsWith("http");
    return (
      <Button asChild size="sm" variant="outline" className="h-8" title={spec.hint}>
        {external ? (
          <a href={href} target="_blank" rel="noreferrer"><MessageCircle className="size-3.5" /> {spec.label}</a>
        ) : (
          <Link href={href}>{spec.label}</Link>
        )}
      </Button>
    );
  }
  if (actionKey === "SNOOZE") return <SnoozeButton caseId={caseId} busy={busy} status={status} onMutate={onMutate} />;

  const patch: Patch =
    actionKey === "CONTACTED"
      ? { status: "IN_PROGRESS", assignee: currentUser }
      : actionKey === "DONE" || actionKey === "INFO_FIXED"
        ? { status: "DONE" }
        : {};
  const message = actionKey === "CONTACTED" ? "Đã ghi nhận liên hệ" : "Đã đóng case";
  return (
    <Button
      size="sm"
      variant={actionKey === "DONE" || actionKey === "INFO_FIXED" ? "default" : "outline"}
      className="h-8"
      disabled={busy}
      title={spec.hint}
      onClick={() => onMutate(caseId, patch, () => csQuickAction({ id: caseId, action: actionKey }), message)}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {spec.label}
    </Button>
  );
}

/** Hẹn lại: bốn mốc bấm một phát hoặc chọn giờ cụ thể. Lưu xong dòng đổi ngay, không mở trang nào. */
function SnoozeButton({ caseId, busy, status, onMutate }: { caseId: string; busy: boolean; status: string; onMutate: RunFn }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const save = async (at: Date) => {
    const ok = await onMutate(
      caseId,
      // KHÔNG vẽ tạm người phụ trách: máy chủ chỉ gán mình khi case chưa có ai, nên đoán ở đây sẽ
      // hiện nhầm tên trên case của người khác trong khoảnh khắc trước lúc dữ liệu thật về.
      { followUpAt: at.toISOString(), status: status === "OPEN" ? "IN_PROGRESS" : status },
      () => csQuickAction({ id: caseId, action: "SNOOZE", followUpAt: at.toISOString() }),
      `Đã hẹn lại ${formatDateTime(at)}`,
    );
    if (ok) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8" disabled={busy} title={CS_QUICK_ACTION.SNOOZE.hint}><AlarmClock className="size-3.5" /> {CS_QUICK_ACTION.SNOOZE.label}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2">
        <div className="text-xs font-semibold">Hẹn quay lại case</div>
        <div className="flex flex-wrap gap-1">
          {CS_SNOOZE_PRESETS.map((p) => (
            <Button key={p.key} size="sm" variant="secondary" className="h-7 text-xs" onClick={() => save(snoozeTarget(p.hours))}>{p.label}</Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Input type="datetime-local" className="h-8 text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Giờ hẹn lại" />
          <Button size="sm" className="h-8" disabled={!custom} onClick={() => { const at = new Date(custom); if (Number.isNaN(at.getTime())) { toast.error("Thời điểm không hợp lệ"); return; } void save(at); }}>Lưu</Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">Tới hạn thì case nổi lên đầu hàng đợi. Chưa hẹn KHÁC hẹn ngay bây giờ.</p>
      </PopoverContent>
    </Popover>
  );
}

/** Ghi chú nhanh: một ô chữ trong popover nhỏ, lưu xong hiện ngay trên dòng, không mở trang khác. */
function NoteButton({ caseId, busy, onSaved }: { caseId: string; busy: boolean; onSaved: (n: { lastNote: string; lastNoteBy: string; lastNoteAt: Date; noteCount: number }) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    const res = await addCsCaseNote({ id: caseId, note: text.trim() });
    setSaving(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    onSaved({ lastNote: res.note, lastNoteBy: res.by, lastNoteAt: new Date(res.at), noteCount: 1 });
    setText("");
    setOpen(false);
    toast.success("Đã lưu ghi chú");
    router.refresh();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 px-2" disabled={busy} aria-label="Ghi chú nhanh" title="Ghi chú nhanh — không mở trang khác"><MessageSquarePlus className="size-4" /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2">
        <div className="text-xs font-semibold">Ghi chú nhanh</div>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Khách nói gì, đã làm gì…" className="text-xs" />
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>Đóng</Button>
          <Button size="sm" className="h-7 text-xs" disabled={saving || !text.trim()} onClick={save}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Lưu</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Bằng chứng dài đi vào đây, không đi ra dòng: nguồn phát hiện, nội dung gốc, kết luận đã ghi và
 * lịch sử case. Lịch sử chỉ tải khi mở — 40 dòng × 30 sự kiện là thứ không ai đọc hết bao giờ.
 */
function EvidencePopover({ row, noteCount }: { row: CsCaseRow; noteCount: number }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<{ id: string; action: string; note: string; actor: string; at: string; nextStatus: string | null }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (events || loading) return;
    setLoading(true);
    const res = await getCsCaseHistory(row.id);
    setLoading(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    setEvents(res.events);
  };
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) void load(); }}>
      <PopoverTrigger asChild>
        <button type="button" className="mt-0.5 text-[11px] font-medium text-primary hover:underline">
          Xem bằng chứng{noteCount > 1 ? ` · ${noteCount} ghi chú` : ""}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-[min(30rem,calc(100vw-2rem))] space-y-2 overflow-y-auto text-xs leading-5">
        <div className="font-semibold">{row.title}</div>
        <div className="text-muted-foreground">Nguồn: {CS_SOURCE_LABEL[row.source] ?? row.source} · tạo bởi {row.createdBy || "—"} · {formatDateTime(row.createdAt)}</div>
        {row.detail ? <div className="whitespace-pre-wrap rounded bg-muted/50 p-2">{row.detail}</div> : null}
        {row.resolution ? <div className="rounded bg-emerald-50 p-2 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">✔ {row.resolution}</div> : null}
        <div className="border-t pt-2 font-semibold">Lịch sử</div>
        {loading ? <div className="text-muted-foreground">Đang tải…</div> : null}
        {events && events.length === 0 ? <div className="text-muted-foreground">Chưa có thao tác nào được ghi.</div> : null}
        {events?.map((e) => (
          <div key={e.id} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{formatDateTime(e.at)}</span>
            <span>
              <b>{CS_EVENT_ACTION_LABEL[e.action as keyof typeof CS_EVENT_ACTION_LABEL] ?? e.action}</b>
              {e.nextStatus ? ` → ${CS_STATUS_LABEL[e.nextStatus as CsStatus] ?? e.nextStatus}` : ""} · {e.actor}
              {e.note ? <div className="text-muted-foreground">{e.note}</div> : null}
            </span>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
