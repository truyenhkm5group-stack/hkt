"use client";

import { Copy, ExternalLink, MapPin, Phone, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addLeadNoteAction,
  assignLeadsAction,
  convertLeadAction,
  editLeadAction,
  logCallAction,
  prepareOutreachAction,
  requestRefreshAction,
  saveOpportunityAction,
  updateLeadStatusAction,
} from "@/lib/actions/wholesale";
import type { FieldHandoffOptions } from "@/lib/wholesale/field-handoff";
import { HandoffPanel } from "@/app/(dashboard)/wholesale/leads/handoff-panel";
import { CALL_OUTCOME_LABEL, CALL_OUTCOMES, LEAD_STATUS_LABEL, LEAD_STATUSES, OUTREACH_CHANNEL_LABEL, OUTREACH_CHANNELS, type CallOutcome, type LeadStatus, type OutreachChannel } from "@/lib/wholesale/constants";

type LeadInfo = {
  id: string;
  status: LeadStatus;
  phone: string | null;
  website: string | null;
  mapsUrl: string | null;
  placeId: string | null;
  name: string | null;
  address: string | null;
  hasCustomer: boolean;
  assignedToUserId: string | null;
  googleExpired: boolean;
  email: string | null;
  facebookUrl: string | null;
  zaloUrl: string | null;
  businessName: string | null;
  ownAddress: string | null;
  ownPhone: string | null;
  ownWebsite: string | null;
};

type Panel = null | "note" | "call" | "status" | "opportunity" | "convert" | "dnc" | "outreach" | "edit" | "handoff";

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function LeadActions({ lead, canWork, users, handoff }: { lead: LeadInfo; canWork: boolean; users: { id: string; name: string }[]; handoff: FieldHandoffOptions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [note, setNote] = useState("");
  const [followup, setFollowup] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [outcome, setOutcome] = useState<CallOutcome>("ANSWERED");
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [status, setStatus] = useState<LeadStatus>(lead.status === "NEW" ? "QUALIFIED" : lead.status);
  const [lostReason, setLostReason] = useState("");
  const [value, setValue] = useState("");
  const [channel, setChannel] = useState<OutreachChannel>("PHONE_CALL");
  const [useAi, setUseAi] = useState(false);
  const [conv, setConv] = useState({ name: lead.name ?? "", phone: lead.phone ?? "", address: lead.address ?? "" });
  const [edit, setEdit] = useState({ businessName: lead.businessName ?? "", phone: lead.ownPhone ?? "", address: lead.ownAddress ?? "", website: lead.ownWebsite ?? "", email: lead.email ?? "", facebookUrl: lead.facebookUrl ?? "", zaloUrl: lead.zaloUrl ?? "" });

  const run = (fn: () => Promise<{ error: string } | ({ ok: true } & object)>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(ok);
        setPanel(null);
        setNote("");
        router.refresh();
      }
    });

  const copyPhone = async () => {
    if (!lead.phone) return;
    try {
      await navigator.clipboard.writeText(lead.phone);
      toast.success(`Đã chép ${lead.phone}`);
    } catch {
      toast.error("Trình duyệt không cho chép — chọn số và chép tay.");
    }
  };
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const followupIso = followup ? new Date(`${followup}T09:00:00+07:00`).toISOString() : null;
  const terminal = lead.status === "DO_NOT_CONTACT";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" asChild disabled={!lead.phone}>
          <a href={lead.phone ? `tel:${lead.phone}` : undefined} aria-disabled={!lead.phone}>
            <Phone className="size-4" /> Gọi
          </a>
        </Button>
        <Button size="sm" variant="outline" onClick={copyPhone} disabled={!lead.phone}>
          <Copy className="size-4" /> Chép SĐT
        </Button>
        <Button size="sm" variant="outline" asChild disabled={!lead.website}>
          <a href={lead.website ?? undefined} target="_blank" rel="noopener noreferrer nofollow">
            <ExternalLink className="size-4" /> Mở website
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild disabled={!lead.mapsUrl && !lead.placeId}>
          <a href={lead.mapsUrl ?? (lead.placeId ? `https://www.google.com/maps/place/?q=place_id:${lead.placeId}` : undefined)} target="_blank" rel="noopener noreferrer">
            <MapPin className="size-4" /> Mở Google Maps
          </a>
        </Button>
      </div>

      {canWork && !terminal ? (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => toggle("call")}>
            Ghi cuộc gọi
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggle("note")}>
            Thêm ghi chú
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggle("handoff")}>
            Gửi NV thị trường
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => updateLeadStatusAction(lead.id, { status: "CONTACTED", note: "Đánh dấu đã liên hệ" }), "Đã đánh dấu đã liên hệ")}>
            Đã liên hệ
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggle("outreach")}>
            Soạn lời chào
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggle("status")}>
            Đổi trạng thái
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggle("opportunity")}>
            Tạo cơ hội bán sỉ
          </Button>
          {!lead.hasCustomer ? (
            <Button size="sm" onClick={() => toggle("convert")}>
              Chuyển thành khách hàng
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => toggle("edit")}>
            Sửa thông tin
          </Button>
          {lead.placeId ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => requestRefreshAction(lead.id), "Đã xếp lượt làm mới — dữ liệu về sau lượt quét nền kế tiếp (tốn một lượt Place Details)")}>
              <RefreshCw className="size-4" /> Làm mới dữ liệu Google
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => toggle("dnc")}>
            Không liên hệ nữa
          </Button>
        </div>
      ) : null}
      {terminal ? <p className="rounded-md bg-rose-50 p-2 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-200">Lead ở danh sách KHÔNG LIÊN HỆ — không chiến dịch nào được đưa lại vào hàng đợi. Gỡ ở «Cấu hình & chi phí API» nếu khách đổi ý.</p> : null}

      {panel === "call" ? (
        <div className="space-y-2 rounded-md border p-2">
          <select className={sel} value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome)} aria-label="Kết quả cuộc gọi">
            {CALL_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {CALL_OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
          <Textarea rows={3} placeholder="Khách nói gì / đang nhập hàng ở đâu / cần gì" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="block text-xs text-muted-foreground">
            Hẹn gọi lại
            <Input type="date" value={followup} onChange={(e) => setFollowup(e.target.value)} />
          </label>
          {(outcome === "ANSWERED" || outcome === "CALLBACK") && !lead.ownAddress && lead.address ? (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={addressConfirmed} onChange={(e) => setAddressConfirmed(e.target.checked)} />
              <span>Khách xác nhận đúng địa chỉ «{lead.address}» — lưu làm địa chỉ của shop (gửi được cho nhân viên thị trường)</span>
            </label>
          ) : null}
          <p className="text-[11px] text-muted-foreground">Nghe máy / hẹn gọi lại ⇒ tên và SĐT vừa gọi được lưu thành dữ liệu của shop.</p>
          <Button size="sm" disabled={pending} onClick={() => run(() => logCallAction(lead.id, { outcome, note, nextFollowupAt: followupIso, addressConfirmed }), "Đã ghi cuộc gọi")}>
            Lưu cuộc gọi
          </Button>
        </div>
      ) : null}

      {panel === "handoff" ? (
        <div className="rounded-md border p-2">
          <HandoffPanel leadIds={[lead.id]} options={handoff} onDone={() => setPanel(null)} />
        </div>
      ) : null}

      {panel === "note" ? (
        <div className="space-y-2 rounded-md border p-2">
          <Textarea rows={3} placeholder="Ghi chú bán hàng" value={note} onChange={(e) => setNote(e.target.value)} />
          <Input placeholder="Việc tiếp theo (vd gửi catalog qua Zalo)" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
          <label className="block text-xs text-muted-foreground">
            Hẹn gọi lại
            <Input type="date" value={followup} onChange={(e) => setFollowup(e.target.value)} />
          </label>
          <Button size="sm" disabled={pending || !note.trim()} onClick={() => run(() => addLeadNoteAction(lead.id, { note, nextFollowupAt: followupIso, nextAction }), "Đã thêm ghi chú")}>
            Lưu ghi chú
          </Button>
        </div>
      ) : null}

      {panel === "status" ? (
        <div className="space-y-2 rounded-md border p-2">
          <select className={sel} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)} aria-label="Trạng thái mới">
            {LEAD_STATUSES.filter((x) => x !== lead.status).map((x) => (
              <option key={x} value={x}>
                {LEAD_STATUS_LABEL[x]}
              </option>
            ))}
          </select>
          {status === "LOST" ? <Input placeholder="Lý do mất (bắt buộc)" value={lostReason} onChange={(e) => setLostReason(e.target.value)} /> : null}
          <Textarea rows={2} placeholder={status === "DO_NOT_CONTACT" ? "Lý do khách từ chối liên hệ (bắt buộc)" : "Ghi chú (không bắt buộc)"} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={pending} onClick={() => run(() => updateLeadStatusAction(lead.id, { status, note, lostReason }), `Đã chuyển sang «${LEAD_STATUS_LABEL[status]}»`)}>
            Lưu trạng thái
          </Button>
        </div>
      ) : null}

      {panel === "opportunity" ? (
        <div className="space-y-2 rounded-md border p-2">
          <Input inputMode="numeric" placeholder="Giá trị ước tính mỗi tháng (₫) — để trống nếu chưa biết" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))} />
          <Textarea rows={3} placeholder="Khách quan tâm mặt hàng gì, số lượng, tần suất nhập" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={pending} onClick={() => run(() => saveOpportunityAction(lead.id, { value: value ? Number(value) : null, note }), "Đã lưu cơ hội bán sỉ")}>
            Lưu cơ hội
          </Button>
        </div>
      ) : null}

      {panel === "convert" ? (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-xs text-muted-foreground">Tạo khách hàng ERP từ lead (đúng lõi tạo khách có sẵn). Khách cùng SĐT đã có ⇒ nối vào khách đó, không tạo bản thứ hai. Lead chuyển «Chốt được».</p>
          <Input placeholder="Tên khách" value={conv.name} onChange={(e) => setConv({ ...conv, name: e.target.value })} />
          <Input placeholder="SĐT khách xác nhận" value={conv.phone} onChange={(e) => setConv({ ...conv, phone: e.target.value })} />
          <Input placeholder="Địa chỉ giao hàng" value={conv.address} onChange={(e) => setConv({ ...conv, address: e.target.value })} />
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run(() => convertLeadAction(lead.id, conv), "Đã chuyển thành khách hàng — mở hồ sơ ở khối «Cơ hội & doanh thu»")}
          >
            Xác nhận chuyển
          </Button>
        </div>
      ) : null}

      {panel === "dnc" ? (
        <div className="space-y-2 rounded-md border border-destructive/40 p-2">
          <p className="text-xs text-muted-foreground">SĐT, website và địa điểm này vào danh sách KHÔNG LIÊN HỆ: mọi lời chào đang chờ bị huỷ, không chiến dịch nào đưa lại vào hàng đợi.</p>
          <Textarea rows={2} placeholder="Khách nói gì (bắt buộc)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => updateLeadStatusAction(lead.id, { status: "DO_NOT_CONTACT", note }), "Đã đưa vào danh sách không liên hệ")}>
            Xác nhận không liên hệ
          </Button>
        </div>
      ) : null}

      {panel === "outreach" ? (
        <div className="space-y-2 rounded-md border p-2">
          <select className={sel} value={channel} onChange={(e) => setChannel(e.target.value as OutreachChannel)} aria-label="Kênh">
            {OUTREACH_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {OUTREACH_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Để AI diễn đạt (chỉ từ dữ kiện có thật, tốn credit AI)
          </label>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await prepareOutreachAction(lead.id, { channel, useAi });
                if ("error" in r) toast.error(r.error);
                else {
                  toast.success(r.note ? `Đã soạn — ${r.note}` : "Đã soạn lời chào, chờ duyệt ở «Hàng đợi liên hệ»");
                  setPanel(null);
                  router.refresh();
                }
              })
            }
          >
            Soạn lời chào
          </Button>
        </div>
      ) : null}

      {panel === "edit" ? (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-xs text-muted-foreground">Thông tin khách / nhân viên xác nhận. Ô đã sửa máy không ghi đè. Để trống = dùng dữ liệu nguồn.</p>
          {(
            [
              ["businessName", "Tên doanh nghiệp"],
              ["phone", "SĐT"],
              ["address", "Địa chỉ"],
              ["website", "Website"],
              ["email", "Email"],
              ["facebookUrl", "Link Facebook"],
              ["zaloUrl", "Link Zalo"],
            ] as const
          ).map(([k, label]) => (
            <Input key={k} placeholder={label} aria-label={label} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
          ))}
          <Button size="sm" disabled={pending} onClick={() => run(() => editLeadAction(lead.id, edit), "Đã lưu thông tin")}>
            Lưu thông tin
          </Button>
        </div>
      ) : null}

      {users.length ? <AssignBox leadId={lead.id} current={lead.assignedToUserId} users={users} /> : null}
    </div>
  );
}

function AssignBox({ leadId, current, users }: { leadId: string; current: string | null; users: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [to, setTo] = useState(current ?? "");
  return (
    <div className="flex items-center gap-2 border-t pt-3">
      <select className={sel} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Người phụ trách">
        <option value="">— Chưa giao —</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || to === (current ?? "")}
        onClick={() =>
          start(async () => {
            const r = await assignLeadsAction({ leadIds: [leadId], userId: to || null });
            if ("error" in r) toast.error(r.error);
            else {
              toast.success("Đã đổi người phụ trách");
              router.refresh();
            }
          })
        }
      >
        Giao
      </Button>
    </div>
  );
}
