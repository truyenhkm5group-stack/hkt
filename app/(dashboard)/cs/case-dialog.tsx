"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { saveCsCase, searchOrdersForCase } from "@/lib/actions/cs";
import { CS_KIND_LABEL, CS_KINDS, CS_STATUS_LABEL, CS_STATUSES, type CsKind, type CsStatus } from "@/lib/constants/cs";
import type { CsCaseRow } from "@/lib/queries/cs";
import { formatVND } from "@/lib/format";

type OrderHit = { id: string; systemId: number | null; name: string | null; phone: string | null; total: number };

/** Tạo / sửa case CSKH. Không truyền `caseRow` → nút “Thêm case”. */
export function CaseDialog({ caseRow, assignees, open, onOpenChange }: { caseRow?: CsCaseRow | null; assignees: string[]; open?: boolean; onOpenChange?: (v: boolean) => void }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const empty = { orderId: "", orderLabel: "", kind: "EXCHANGE_SIZE" as CsKind, status: "OPEN" as CsStatus, title: "", detail: "", customerName: "", customerPhone: "", assignee: "", resolution: "" };
  const [form, setForm] = useState(empty);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<OrderHit[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    if (caseRow) {
      setForm({
        orderId: caseRow.orderId ?? "",
        orderLabel: caseRow.order ? `#${caseRow.order.systemId ?? caseRow.order.id}` : "",
        kind: caseRow.kind as CsKind,
        status: caseRow.status as CsStatus,
        title: caseRow.title,
        detail: caseRow.detail,
        customerName: caseRow.customerName,
        customerPhone: caseRow.customerPhone,
        assignee: caseRow.assignee,
        resolution: caseRow.resolution,
      });
    } else setForm(empty);
    setTerm("");
    setHits([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, caseRow]);

  const search = () =>
    startTransition(async () => {
      const r = await searchOrdersForCase(term);
      if ("error" in r) toast.error(r.error);
      else setHits(r.orders);
    });

  const submit = () =>
    startTransition(async () => {
      const title = form.title.trim() || `${CS_KIND_LABEL[form.kind]}${form.orderLabel ? ` · ${form.orderLabel}` : ""}${form.customerName ? ` · ${form.customerName}` : ""}`;
      const r = await saveCsCase({ id: caseRow?.id, orderId: form.orderId || null, kind: form.kind, status: form.status, title, detail: form.detail, customerName: form.customerName, customerPhone: form.customerPhone, assignee: form.assignee, resolution: form.resolution });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(caseRow ? "Đã cập nhật case" : "Đã tạo case");
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {!caseRow && open === undefined ? (
        <DialogTrigger asChild>
          <Button>
            <Plus className="size-4" /> Thêm case
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{caseRow ? "Cập nhật case CSKH" : "Case CSKH mới"}</DialogTitle>
          <DialogDescription>Đổi size, đổi màu, sai địa chỉ, sai SĐT, trả hàng, khiếu nại… Gắn với đơn Pancake để mở nhanh đơn và hội thoại.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Đơn hàng {form.orderLabel ? <span className="font-mono text-primary">{form.orderLabel}</span> : <span className="text-muted-foreground">(chưa gắn)</span>}</Label>
            <div className="flex gap-2">
              <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Mã đơn Pancake hoặc SĐT khách" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())} />
              <Button type="button" variant="outline" onClick={search} disabled={pending}>
                <Search className="size-4" />
              </Button>
            </div>
            {hits.length ? (
              <div className="rounded-md border text-sm">
                {hits.map((h) => (
                  <button key={h.id} type="button" className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-muted" onClick={() => { setForm({ ...form, orderId: h.id, orderLabel: `#${h.systemId ?? h.id}`, customerName: form.customerName || h.name || "", customerPhone: form.customerPhone || h.phone || "" }); setHits([]); }}>
                    <span>#{h.systemId ?? h.id} · {h.name || "Khách"} · {h.phone}</span>
                    <span className="text-muted-foreground">{formatVND(h.total)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Loại case</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as CsKind })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CS_KINDS.map((k) => <SelectItem key={k} value={k}>{CS_KIND_LABEL[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Trạng thái</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as CsStatus })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CS_STATUSES.map((k) => <SelectItem key={k} value={k}>{CS_STATUS_LABEL[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Người phụ trách</Label>
              <Input list="cs-assignees" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="Tên nhân viên" />
              <datalist id="cs-assignees">{assignees.map((a) => <option key={a} value={a} />)}</datalist>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Tên khách</Label>
              <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>SĐT khách</Label>
              <Input value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Tiêu đề (để trống sẽ tự đặt)</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="VD: Đổi size L → XL cho chị Loan" />
          </div>
          <div className="space-y-1">
            <Label>Chi tiết yêu cầu</Label>
            <Textarea rows={3} value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="Khách nhận sai size, cần đổi XL sang L, shop hỗ trợ ship đổi miễn phí…" />
          </div>
          <div className="space-y-1">
            <Label>Kết quả xử lý</Label>
            <Textarea rows={2} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} placeholder="Đã lên đơn đổi #…, bưu tá thu lại hàng cũ…" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Huỷ</Button>
          <Button type="button" onClick={submit} disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : null} {caseRow ? "Lưu" : "Tạo case"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
