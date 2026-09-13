"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { vtpEditOrder, vtpOrderAction } from "@/lib/actions/shipments-vtp";
import { canRequestCarrierAction, type Eligibility } from "@/lib/care/redelivery-eligibility";
import type { CarrierActionKey } from "@/lib/constants/care";
import { VTP_ORDER_ACTIONS, type VtpOrderActionType } from "@/lib/constants/viettelpost";

type Receiver = { name: string; phone: string; address: string; cod: number; note: string };

/**
 * Nút thao tác Viettel Post trên trang vận đơn: phát tiếp, duyệt hoàn, gửi lại, duyệt, huỷ, sửa đơn.
 *
 * ĐIỀU KIỆN XÉT BẰNG ĐÚNG HÀM CỦA MÁY CHỦ (`canRequestCarrierAction`) trên mã + chữ + chặng + năng
 * lực tài khoản — không còn danh sách chặng ghi cứng riêng của trang này. Nút không đủ điều kiện vẫn
 * hiện nhưng khoá, tooltip nói vì sao; tài khoản không sở hữu kiện thì nút vẫn bấm được và đi
 * đường làm tay có ghi vết.
 */
export function VtpActions({ shipmentId, stage, vtpStatus, rawStatus, tracking, trackingCapability, receiver }: { shipmentId: string; stage: string; vtpStatus: number | null; rawStatus: string | null; tracking: string | null; trackingCapability: string; receiver: Receiver }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<VtpOrderActionType | null>(null);
  const [note, setNote] = useState("");
  const [form, setForm] = useState(receiver);
  const router = useRouter();
  const facts = { stage, vtpStatus, vtpStatusName: rawStatus, orderNumber: tracking, trackingCapability, configured: true };
  const eligibility = (key: string): Eligibility => canRequestCarrierAction(key as CarrierActionKey, facts);
  const editOk = eligibility("edit");
  const run = (type: VtpOrderActionType) => {
    const a = VTP_ORDER_ACTIONS.find((x) => x.type === type)!;
    setBusy(a.key);
    start(async () => {
      const r = await vtpOrderAction(shipmentId, type, note);
      setBusy(null);
      setNoteFor(null);
      setNote("");
      if ("error" in r) toast.error(r.error, { duration: 8000 });
      else {
        toast.success(r.message);
        router.refresh();
      }
    });
  };
  return (
    <>
      {VTP_ORDER_ACTIONS.map((a) => {
        const e = eligibility(a.key);
        return (
          <Button key={a.key} size="sm" variant={a.tone === "destructive" ? "destructive" : a.tone === "secondary" ? "secondary" : "default"} title={e.ok ? (e.callsApi ? a.hint : e.reason) : e.reason} disabled={pending || !e.ok} onClick={() => setNoteFor(a.type)}>
            {busy === a.key ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} {a.label}
          </Button>
        );
      })}
      <Button size="sm" variant="outline" disabled={pending || !editOk.ok} onClick={() => setEditOpen(true)} title={editOk.ok ? "Sửa người nhận, SĐT, địa chỉ, tiền thu hộ trên Viettel Post" : editOk.reason}>
        <Pencil className="size-4" /> Sửa đơn VTP
      </Button>

      <Dialog open={noteFor !== null} onOpenChange={(o) => !o && setNoteFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{VTP_ORDER_ACTIONS.find((x) => x.type === noteFor)?.label}</DialogTitle>
            <DialogDescription>{VTP_ORDER_ACTIONS.find((x) => x.type === noteFor)?.confirm} Yêu cầu được gửi thẳng lên Viettel Post bằng tài khoản đối tác của shop và ghi vào hành trình vận đơn.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Ghi chú cho bưu cục (tuỳ chọn)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: khách hẹn nhận sáng mai, gọi số phụ 09xx…" rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteFor(null)}>Đóng</Button>
            <Button variant={VTP_ORDER_ACTIONS.find((x) => x.type === noteFor)?.tone === "destructive" ? "destructive" : "default"} disabled={pending} onClick={() => noteFor && run(noteFor)}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sửa đơn trên Viettel Post</DialogTitle>
            <DialogDescription>Áp dụng cho vận đơn chưa phát. Sửa xong ERP tra lại trạng thái; nhớ sửa cả trên Pancake nếu cần in lại.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>Người nhận</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>SĐT</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="space-y-1 sm:col-span-2"><Label>Địa chỉ</Label><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div className="space-y-1"><Label>Tiền thu hộ (₫)</Label><Input type="number" min={0} step={1000} value={form.cod} onChange={(e) => setForm({ ...form, cod: Number(e.target.value) || 0 })} /></div>
            <div className="space-y-1"><Label>Ghi chú vận đơn</Label><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Đóng</Button>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await vtpEditOrder(shipmentId, { receiverName: form.name, receiverPhone: form.phone.replace(/\D/g, ""), receiverAddress: form.address, moneyCollection: form.cod, note: form.note });
                  if ("error" in r) toast.error(r.error, { duration: 8000 });
                  else {
                    toast.success(r.message);
                    setEditOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Gửi Viettel Post
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
