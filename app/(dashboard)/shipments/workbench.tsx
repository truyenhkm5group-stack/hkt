"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CalendarClock, Check, ExternalLink, Loader2, MessageSquarePlus, Phone, Truck } from "lucide-react";
import { toast } from "sonner";
import { CareDrawerHost, CareOpenButton } from "@/app/(dashboard)/shipments/care-drawer";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { addCareNote, markCarrierManualDone, requestCarrierAction, setCareFollowUp, setCareOwner, setCareStatus } from "@/lib/actions/care-workbench";
import { careViewOf, slaOf } from "@/lib/care/view";
import {
  CARE_REASON_LABEL,
  CARE_STATUSES,
  CARE_STATUS_HINT,
  CARE_STATUS_LABEL,
  CARE_STATUS_TONE,
  CARE_VIEW_LABEL,
  CARRIER_ACTION_LABEL,
  CARRIER_REQUEST_LABEL,
  CARRIER_REQUEST_TONE,
  FOLLOW_UP_PRESETS,
  carrierActionAllowed,
  type CareStatus,
  type CareView,
  type CarrierActionKey,
} from "@/lib/constants/care";
import { CARE_ACTION_KINDS, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { formatDateTime, formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import type { CareCase, CareState, CareWorkbench, CarrierRequestView } from "@/lib/queries/care-workbench";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN LÀM VIỆC GIAO VẬN ═══════════
 *
 * Danh sách là TRẠNG THÁI PHÍA TRÌNH DUYỆT: mỗi hành động trả về mảnh care mới của kiện và dòng
 * được vá tại chỗ — không tải lại trang, không cuộn. Kiện đổi góc nhìn (vd bấm Đã xong ở Cần care)
 * thì rời danh sách này ngay, đếm trên tab đổi theo, lịch sử vẫn ở nhật ký và ngăn kéo.
 *
 * Chiều ĐVVC (cột "VTP báo") và chiều care (cột "Care") đứng cạnh nhau nhưng KHÔNG bao giờ suy ra
 * lẫn nhau.
 */

type Props = {
  initial: CareWorkbench;
  view: Exclude<CareView, "all">;
  staff: { id: string; name: string }[];
  canManage: boolean;
};

const CARRIER_MENU: CarrierActionKey[] = ["redeliver", "approve-return", "resend", "cancel"];

function gio(h: number | null) {
  if (h === null) return "chưa có tin";
  if (h < 1) return "<1 giờ";
  if (h < 48) return `${Math.round(h)} giờ`;
  return `${Math.round(h / 24)} ngày`;
}

function sangMai() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function reviveState(s: CareState): CareState {
  // Server Action trả Date đã được tuần tự hoá lại thành Date ở phía client (React Flight), nhưng
  // phòng khi là chuỗi thì ép về Date để luật góc nhìn không so sánh nhầm.
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return { ...s, followUpAt: d(s.followUpAt), lastNoteAt: d(s.lastNoteAt), firstResponseAt: d(s.firstResponseAt), doneAt: d(s.doneAt), updatedAt: d(s.updatedAt) };
}

export function CareWorkbenchView({ initial, view, staff, canManage }: Props) {
  const [cases, setCases] = useState<CareCase[]>(() => initial.cases.map((c) => ({ ...c, queueSince: new Date(c.queueSince) })));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  const patch = (shipmentId: string, care: CareState, extra: Partial<CareCase> = {}) =>
    setCases((prev) =>
      prev.map((c) => {
        if (c.shipmentId !== shipmentId) return c;
        const revived = reviveState(care);
        const { view: v, reopened } = careViewOf(revived, c.queueSince);
        return { ...c, ...extra, care: revived, view: v, reopened, sla: slaOf(c.queueSince, revived) };
      }),
    );

  const counts = useMemo(() => {
    const k = { care: 0, waiting: 0, escalated: 0, done: 0 };
    for (const c of cases) k[c.view] += 1;
    return k;
  }, [cases]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return cases.filter(
      (c) =>
        c.view === view &&
        (!owner || (owner === "none" ? !c.care.owner : c.care.owner?.id === owner)) &&
        (!reason || c.reason === reason) &&
        (!term || [c.tracking, c.customer, c.phone, String(c.orderSystemId ?? "")].some((x) => x.toLowerCase().includes(term))),
    );
  }, [cases, view, owner, reason, q]);

  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cases) if (c.view === view) m.set(c.reason, (m.get(c.reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [cases, view]);

  const queue = visible.map((c) => ({ shipmentId: c.shipmentId }));
  const moneyAtRisk = visible.reduce((a, c) => a + c.codAmount, 0);
  const overdue = visible.filter((c) => c.sla.firstResponseBreached || c.sla.resolveBreached).length;

  const bulkStatus = (status: CareStatus) =>
    start(async () => {
      const ids = [...selected];
      const r = await setCareStatus({ shipmentIds: ids, status });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      for (const [id, st] of Object.entries(r.data)) patch(id, st);
      setSelected(new Set());
      toast.success(`${ids.length} kiện → ${CARE_STATUS_LABEL[status]}`);
    });
  const bulkOwner = (ownerId: string) =>
    start(async () => {
      const ids = [...selected];
      const r = await setCareOwner({ shipmentIds: ids, ownerId: ownerId || null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      for (const [id, st] of Object.entries(r.data)) patch(id, st);
      setSelected(new Set());
      toast.success(`Đã giao ${ids.length} kiện`);
    });

  const toggleAll = () => setSelected((s) => (s.size === visible.length ? new Set() : new Set(visible.map((c) => c.shipmentId))));

  return (
    <div className="space-y-3">
      <CareDrawerHost queue={queue} />

      {/* Dải tóm tắt + bộ lọc nhẹ: tất cả trên một hàng, không có thẻ KPI to. */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold">{formatNumber(visible.length)} kiện</span>
        <span className="text-muted-foreground">· COD treo {formatVND(moneyAtRisk, { compact: true })}</span>
        {overdue ? <span className="font-semibold text-rose-600 dark:text-rose-400">· {formatNumber(overdue)} vỡ SLA</span> : null}
        <span className="text-muted-foreground">· chưa ai nhận {formatNumber(visible.filter((c) => !c.care.owner).length)}</span>
        <InfoHint>
          SLA: phản hồi đầu trong 2 giờ, đóng hoặc escalate trong 24 giờ, tính từ lúc kiện VÀO điều kiện cần care (lần giao hụt gần nhất / tin cuối). Kiện rời danh sách khi điều kiện hết (đã giao, đã hoàn…) — lịch sử giữ nguyên.
        </InfoHint>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mã · SĐT · tên · #đơn" className="h-7 w-40 rounded-md border bg-background px-2 text-xs" />
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className="h-7 rounded-md border bg-background px-1.5 text-xs" aria-label="Lọc theo người care">
            <option value="">Mọi người</option>
            <option value="none">Chưa ai nhận</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </span>
      </div>

      {reasons.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {reasons.map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setReason(reason === k ? "" : k)}
              className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", reason === k && "border-primary bg-accent font-semibold")}
            >
              {CARE_REASON_LABEL[k as keyof typeof CARE_REASON_LABEL] ?? k} <span className="numeric text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>
      ) : null}

      {selected.size ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <span className="font-semibold">{selected.size} kiện đã chọn</span>
          {CARE_STATUSES.map((s) => (
            <Button key={s} size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending} onClick={() => bulkStatus(s)}>
              {CARE_STATUS_LABEL[s]}
            </Button>
          ))}
          <select className="h-7 rounded-md border bg-background px-1.5 text-xs" defaultValue="" onChange={(e) => e.target.value !== "" && bulkOwner(e.target.value === "none" ? "" : e.target.value)} aria-label="Giao cho">
            <option value="">Giao cho…</option>
            <option value="none">Bỏ người nhận</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set())}>
            Bỏ chọn
          </Button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          {view === "care" ? "Không có kiện nào đang cần care — mọi kiện đang chạy đúng lịch hoặc đã có người theo." : `Không có kiện nào ở “${CARE_VIEW_LABEL[view]}”.`}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[1180px] text-[12px]">
            <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2">
                  <input type="checkbox" aria-label="Chọn tất cả" checked={selected.size > 0 && selected.size === visible.length} onChange={toggleAll} />
                </th>
                <th className="px-2 py-2 font-semibold">Kiện · vì sao</th>
                <th className="px-2 py-2 font-semibold">Khách · COD</th>
                <th className="px-2 py-2 font-semibold" title="Chiều ĐVVC — chứng từ Viettel Post, đội không sửa được">
                  VTP báo
                </th>
                <th className="px-2 py-2 font-semibold" title="Chiều nội bộ — đội đã làm tới đâu; không suy ra từ trạng thái VTP">
                  Care
                </th>
                <th className="px-2 py-2 font-semibold">Note gần nhất</th>
                <th className="px-2 py-2 font-semibold">Viettel Post</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((c) => (
                <CaseRow
                  key={c.shipmentId}
                  c={c}
                  staff={staff}
                  canManage={canManage}
                  checked={selected.has(c.shipmentId)}
                  onCheck={(v) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (v) n.add(c.shipmentId);
                      else n.delete(c.shipmentId);
                      return n;
                    })
                  }
                  onPatch={(care, extra) => patch(c.shipmentId, care, extra)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        {(["care", "waiting", "escalated", "done"] as const).map((v) => `${CARE_VIEW_LABEL[v]} ${counts[v]}`).join(" · ")}
      </p>
    </div>
  );
}

function CaseRow({ c, staff, canManage, checked, onCheck, onPatch }: { c: CareCase; staff: { id: string; name: string }[]; canManage: boolean; checked: boolean; onCheck: (v: boolean) => void; onPatch: (care: CareState, extra?: Partial<CareCase>) => void }) {
  const [pending, start] = useTransition();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<CareActionKind>("CALLED_REACHED");
  const [vtpOpen, setVtpOpen] = useState(false);
  const [vtpNote, setVtpNote] = useState("");

  const changeStatus = (status: CareStatus) =>
    start(async () => {
      const r = await setCareStatus({ shipmentIds: [c.shipmentId], status });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data[c.shipmentId]);
      if (status === "DONE") toast.success(`${c.tracking}: đã xong — chuyển sang “Đã xử lý”`);
    });
  const changeOwner = (ownerId: string) =>
    start(async () => {
      const r = await setCareOwner({ shipmentIds: [c.shipmentId], ownerId: ownerId || null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data[c.shipmentId]);
    });
  const followUp = (at: Date | null) =>
    start(async () => {
      const r = await setCareFollowUp({ shipmentId: c.shipmentId, at });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data);
      if (at) toast.success(`${c.tracking}: hẹn theo dõi ${formatDateTime(at)}`);
    });
  const saveNote = () =>
    start(async () => {
      const r = await addCareNote({ shipmentId: c.shipmentId, note, kind });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data, { lastCareAction: { label: CARE_ACTION_LABEL[kind], at: new Date(), byHuman: true } });
      setNote("");
      setNoteOpen(false);
    });
  const carrier = (actionKey: CarrierActionKey) =>
    start(async () => {
      const r = await requestCarrierAction({ shipmentId: c.shipmentId, actionKey, note: vtpNote });
      setVtpOpen(false);
      setVtpNote("");
      if ("error" in r) {
        toast.error(r.error, { duration: 8000 });
        return;
      }
      onPatch(c.care, { carrierRequest: { ...r.data.request, at: new Date(r.data.request.at) } });
      (r.data.request.status === "MANUAL_REQUIRED" ? toast.warning : toast.success)(r.data.message, { duration: 8000 });
    });
  const manualDone = (req: CarrierRequestView) =>
    start(async () => {
      const r = await markCarrierManualDone({ requestId: req.id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(c.care, { carrierRequest: { ...r.data, at: new Date(r.data.at) } });
      toast.success("Đã ghi: làm tay trên Viettel Post");
    });

  const breached = c.sla.firstResponseBreached || c.sla.resolveBreached;
  const allowed = CARRIER_MENU.filter((k) => carrierActionAllowed(k, c.carrier.stage));
  const req = c.carrierRequest;

  return (
    <tr className={cn("align-top hover:bg-accent/30", pending && "opacity-60")}>
      <td className="px-2 py-2">
        <input type="checkbox" aria-label="Chọn kiện" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1.5">
          <CareOpenButton shipmentId={c.shipmentId} className="font-mono text-[12.5px] font-semibold">
            {c.tracking}
          </CareOpenButton>
          {c.orderSystemId ? (
            <Link href={`/orders/${c.orderId}`} className="text-[11px] text-muted-foreground hover:underline">
              #{c.orderSystemId}
            </Link>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-medium" title={c.reasonDetail}>
            {c.reasonLabel}
          </span>
          {c.reopened ? <span className="rounded bg-violet-100 px-1.5 py-px text-[10.5px] font-medium text-violet-800 dark:bg-violet-950/60 dark:text-violet-300">mở lại</span> : null}
          {breached ? (
            <span className="rounded bg-rose-100 px-1.5 py-px text-[10.5px] font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300" title={`Phản hồi đầu hạn ${formatDateTime(c.sla.firstResponseDueAt)} · đóng hạn ${formatDateTime(c.sla.resolveDueAt)}`}>
              vỡ SLA
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground" title={c.nextAction}>
          Nên: {c.nextAction.length > 70 ? `${c.nextAction.slice(0, 70)}…` : c.nextAction}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="font-medium">{c.customer}</div>
        {c.phone ? (
          <a href={`tel:${c.phone}`} className="numeric inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline">
            <Phone className="size-3" /> {c.phone}
          </a>
        ) : (
          <span className="text-[11px] text-muted-foreground">chưa có SĐT</span>
        )}
        <div className="numeric font-semibold">{formatVND(c.codAmount)}</div>
      </td>
      <td className="px-2 py-2">
        <div>{c.carrier.rawStatus}</div>
        <div className="text-[11px] text-muted-foreground">
          {c.carrier.stageLabel} · {gio(c.carrier.ageHours)}
          {c.carrier.failedAttempts ? ` · hụt ${c.carrier.failedAttempts} lần` : ""}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={c.care.status}
            disabled={pending}
            onChange={(e) => changeStatus(e.target.value as CareStatus)}
            title={CARE_STATUS_HINT[c.care.status]}
            className={cn("h-7 rounded-md border-0 px-1.5 text-[11.5px] font-semibold", CARE_STATUS_TONE[c.care.status])}
            aria-label="Trạng thái care"
          >
            {CARE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CARE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select value={c.care.owner?.id ?? ""} disabled={pending} onChange={(e) => changeOwner(e.target.value)} className="h-7 max-w-[120px] rounded-md border bg-background px-1.5 text-[11.5px]" aria-label="Người care">
            <option value="">Chưa ai nhận</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
          <CalendarClock className="size-3 text-muted-foreground" />
          {c.care.followUpAt ? (
            <button type="button" className={cn("hover:underline", c.care.followUpAt.getTime() <= Date.now() && "font-semibold text-rose-600 dark:text-rose-400")} title="Bấm để bỏ hẹn" onClick={() => followUp(null)}>
              {formatDateTime(c.care.followUpAt)}
            </button>
          ) : (
            FOLLOW_UP_PRESETS.map((p) => (
              <button key={p.key} type="button" disabled={pending} className="rounded border px-1 py-px text-[10.5px] hover:bg-accent" onClick={() => followUp(p.hours < 0 ? sangMai() : new Date(Date.now() + p.hours * 3600_000))}>
                {p.label}
              </button>
            ))
          )}
        </div>
        {c.care.updatedAt ? (
          <div className="mt-0.5 text-[10.5px] text-muted-foreground" title={formatDateTime(c.care.updatedAt)}>
            {c.care.updatedBy || "—"} · {formatTimeAgo(c.care.updatedAt)}
          </div>
        ) : null}
      </td>
      <td className="max-w-[220px] px-2 py-2">
        {c.care.lastNote ? (
          <div className="line-clamp-2" title={`${c.care.lastNote}\n— ${c.care.lastNoteBy} · ${c.care.lastNoteAt ? formatDateTime(c.care.lastNoteAt) : ""}`}>
            {c.care.lastNote}
          </div>
        ) : c.lastCareAction ? (
          <div className="text-muted-foreground" title={formatDateTime(c.lastCareAction.at)}>
            {c.lastCareAction.label}
            {c.lastCareAction.byHuman ? null : <span className="ml-1 rounded bg-muted px-1 text-[10px]">bot</span>}
          </div>
        ) : (
          <span className="font-medium text-rose-600 dark:text-rose-400">Chưa ai chạm</span>
        )}
        <Popover open={noteOpen} onOpenChange={setNoteOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent">
              <MessageSquarePlus className="size-3" /> Ghi note
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-2 p-3">
            <div className="flex flex-wrap gap-1">
              {CARE_ACTION_KINDS.map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded border px-1.5 py-px text-[10.5px]", kind === k ? "border-primary bg-primary/10 font-semibold" : "hover:bg-accent")}>
                  {CARE_ACTION_LABEL[k]}
                </button>
              ))}
            </div>
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && note.trim()) saveNote();
              }}
              placeholder="Khách nói gì? (Ctrl/⌘ + Enter để lưu)"
              className="min-h-[64px] text-[12px]"
            />
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setNoteOpen(false)}>
                Huỷ
              </Button>
              <Button size="sm" className="h-7 px-2 text-xs" disabled={pending || !note.trim()} onClick={saveNote}>
                {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Lưu
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </td>
      <td className="px-2 py-2">
        {req ? (
          <div className="mb-1">
            <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium", CARRIER_REQUEST_TONE[req.status])} title={`${CARRIER_ACTION_LABEL[req.actionKey]} · ${req.actor} · ${formatDateTime(req.at)}${req.error ? `\n${req.error}` : ""}`}>
              {CARRIER_ACTION_LABEL[req.actionKey]}: {CARRIER_REQUEST_LABEL[req.status]}
            </span>
            {req.status === "MANUAL_REQUIRED" && canManage ? (
              <button type="button" disabled={pending} onClick={() => manualDone(req)} className="ml-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent" title="Bạn đã làm việc này trên viettelpost.vn — ghi lại để lịch sử không trống">
                Đã làm tay
              </button>
            ) : null}
          </div>
        ) : null}
        {canManage && allowed.length ? (
          <Popover open={vtpOpen} onOpenChange={setVtpOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent" title={c.carrierCapability === "API" ? "Gửi thẳng lên Viettel Post bằng tài khoản đối tác" : "Tài khoản API không sở hữu kiện này — ERP ghi yêu cầu và bạn làm tay trên viettelpost.vn"}>
                <Truck className="size-3" /> Thao tác VTP
                <span className={cn("rounded px-1", c.carrierCapability === "API" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300")}>
                  {c.carrierCapability === "API" ? "API" : "làm tay"}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-2 p-3">
              <p className="text-[11px] text-muted-foreground">
                {c.carrierCapability === "API"
                  ? "Yêu cầu gửi thẳng lên Viettel Post. Chỉ được coi là THÀNH CÔNG khi sự kiện hành trình xác nhận."
                  : "Tài khoản API của ERP không sở hữu kiện này (vận đơn Pancake tạo). ERP ghi yêu cầu là PHẢI LÀM TAY; làm trên viettelpost.vn rồi bấm “Đã làm tay”."}
              </p>
              <Textarea value={vtpNote} onChange={(e) => setVtpNote(e.target.value)} placeholder="Ghi chú cho bưu cục (tuỳ chọn)" className="min-h-[48px] text-[12px]" />
              <div className="flex flex-wrap gap-1">
                {allowed.map((k) => (
                  <Button key={k} size="sm" variant={k === "cancel" ? "destructive" : "outline"} className="h-7 px-2 text-xs" disabled={pending} onClick={() => carrier(k)}>
                    {CARRIER_ACTION_LABEL[k]}
                  </Button>
                ))}
              </div>
              <a href={`https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${encodeURIComponent(c.tracking)}&orderType=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                <ExternalLink className="size-3" /> Mở trên viettelpost.vn
              </a>
            </PopoverContent>
          </Popover>
        ) : (
          <Link href={`/shipments/${c.shipmentId}`} className="text-[11px] text-primary hover:underline">
            Chi tiết
          </Link>
        )}
      </td>
    </tr>
  );
}
