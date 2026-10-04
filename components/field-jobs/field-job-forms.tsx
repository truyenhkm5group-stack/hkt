"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addFieldJobPhotoAction,
  createFieldJobAction,
  deleteFieldJobPhotoAction,
  moveFieldJobAction,
  openFieldJobRevisitAction,
  recordFieldJobReceiptAction,
  updateFieldJobQuoteAction,
  voidFieldJobReceiptAction,
} from "@/lib/actions/field-jobs";
import { FIELD_JOB_LIMITS, FIELD_JOB_PAY_METHOD_LABEL, FIELD_JOB_PAY_METHODS, FIELD_JOB_PHOTO_PHASE_LABEL, fieldJobTotal, type FieldJobPayMethod, type FieldJobPhotoPhase, type FieldJobStatus } from "@/lib/constants/field-jobs";
import { thuNhoAnhTheoCo } from "@/lib/ideas/shrink-image";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const L = FIELD_JOB_LIMITS;

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

function intOrNull(raw: string): number | null {
  const v = raw.replace(/[.,\s]/g, "");
  return /^\d+$/.test(v) ? Number(v) : null;
}

const vnd = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("vi-VN")} ₫`);

type LineDraft = { description: string; quantity: string; unitPrice: string };

const toLines = (rows: LineDraft[]) =>
  rows
    .filter((r) => r.description.trim())
    .map((r) => ({ description: r.description.trim(), quantity: intOrNull(r.quantity) ?? 0, unitPrice: intOrNull(r.unitPrice) ?? -1 }));

type QuoteInitial = { title: string; address: string; description: string; warrantyMonths: number | null; lines: { description: string; quantity: number; unitPrice: number }[] };

/**
 * Lập phiếu (có chọn khách) hoặc sửa báo giá của phiếu đang có. Tổng tạm tính hiện ngay; máy chủ tính lại khi đọc — tổng không
 * lưu cột nào.
 */
export function FieldJobQuoteForm({ jobId, customers, initial }: { jobId?: string; customers?: { id: string; name: string; phone: string | null; address: string }[]; initial?: QuoteInitial }) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [warranty, setWarranty] = useState(initial?.warrantyMonths ? String(initial.warrantyMonths) : "");
  const [rows, setRows] = useState<LineDraft[]>(initial?.lines.length ? initial.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: String(l.unitPrice) })) : [{ description: "", quantity: "1", unitPrice: "" }]);
  const [pending, start] = useTransition();
  const lines = toLines(rows);
  const total = fieldJobTotal(lines.filter((l) => l.quantity > 0 && l.unitPrice >= 0));
  const setRow = (i: number, patch: Partial<LineDraft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const submit = () =>
    start(async () => {
      const quote = { title, address, description, warrantyMonths: intOrNull(warranty), lines };
      const r = jobId ? await updateFieldJobQuoteAction(jobId, quote) : await createFieldJobAction({ customerId, ...quote });
      if (!r.ok) {
        toast.error(firstError(r));
        return;
      }
      toast.success(r.message);
      if (!jobId) router.push(`/field-jobs/${r.id}`);
    });
  return (
    <div className="space-y-3 text-sm" data-field-job-quote-form>
      <div className="grid gap-3 md:grid-cols-2">
        {customers ? (
          <div className="space-y-1">
            <Label htmlFor="fj-customer">Khách *</Label>
            <select
              id="fj-customer"
              className={SELECT}
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                const c = customers.find((x) => x.id === e.target.value);
                if (c && !address) setAddress(c.address);
              }}
            >
              <option value="">— Chọn khách —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="fj-title">Tên việc *</Label>
          <Input id="fj-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={L.titleMax} placeholder="VD: Vệ sinh 2 máy lạnh, thay ống nước bếp" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fj-address">Địa chỉ làm</Label>
          <Input id="fj-address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fj-warranty">Bảo hành dịch vụ (tháng)</Label>
          <Input id="fj-warranty" inputMode="numeric" value={warranty} onChange={(e) => setWarranty(e.target.value)} placeholder="Trống = không bảo hành" />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="fj-desc">Mô tả / tình trạng</Label>
          <Input id="fj-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={L.textMax} />
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Dòng báo giá</div>
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="h-8 min-w-48 flex-1" aria-label={`Nội dung dòng ${i + 1}`} placeholder="Nội dung công việc / vật tư" value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} maxLength={L.lineTextMax} />
            <Input className="h-8 w-20" aria-label={`Số lượng dòng ${i + 1}`} inputMode="numeric" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} />
            <Input className="h-8 w-32" aria-label={`Đơn giá dòng ${i + 1}`} inputMode="numeric" placeholder="Đơn giá (đ)" value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: e.target.value })} />
            <Button type="button" size="sm" variant="ghost" className="h-8 px-2" aria-label="Xoá dòng" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="h-8" disabled={rows.length >= L.lineMax} onClick={() => setRows((rs) => [...rs, { description: "", quantity: "1", unitPrice: "" }])}>
          <Plus className="size-4" /> Thêm dòng
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span>
          Tổng báo giá: <b>{vnd(total)}</b>
        </span>
        <Button type="button" onClick={submit} disabled={pending || !title.trim() || (!jobId && !customerId)}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {jobId ? "Lưu báo giá" : "Lập phiếu"}
        </Button>
      </div>
    </div>
  );
}

/** Nút chuyển trạng thái theo đúng bước kế tiếp của phiếu. */
export function FieldJobActions({ job, techs }: { job: { id: string; status: FieldJobStatus; assigneeUserId: string | null }; techs: { id: string; name: string }[] }) {
  const [mode, setMode] = useState<null | "ACCEPTED" | "SCHEDULED" | "DONE" | "CANCELLED">(null);
  const [note, setNote] = useState("");
  const [tech, setTech] = useState(job.assigneeUserId ?? techs[0]?.id ?? "");
  const [startAt, setStartAt] = useState("");
  const [duration, setDuration] = useState("120");
  const [signer, setSigner] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const go = (to: "ACCEPTED" | "SCHEDULED" | "IN_PROGRESS" | "DONE" | "CANCELLED") =>
    start(async () => {
      const r = await moveFieldJobAction(job.id, {
        to,
        note,
        assigneeUserId: to === "SCHEDULED" ? tech : null,
        start: to === "SCHEDULED" ? startAt : null,
        durationMin: to === "SCHEDULED" ? intOrNull(duration) : null,
        signedByName: to === "DONE" ? signer : null,
        reason: to === "CANCELLED" ? reason : null,
      });
      if (r.ok) {
        toast.success(r.message);
        setMode(null);
      } else toast.error(firstError(r));
    });
  const s = job.status;
  if (s === "DONE" || s === "CANCELLED") return null;
  return (
    <div className="space-y-2 text-sm" data-field-job-actions={s}>
      <div className="flex flex-wrap gap-2">
        {s === "QUOTED" ? <Button type="button" size="sm" onClick={() => setMode("ACCEPTED")}>Khách đồng ý báo giá</Button> : null}
        {s === "ACCEPTED" || s === "SCHEDULED" ? (
          <Button type="button" size="sm" variant={s === "SCHEDULED" ? "outline" : "default"} onClick={() => setMode("SCHEDULED")}>
            {s === "SCHEDULED" ? "Dời hẹn" : "Hẹn thợ"}
          </Button>
        ) : null}
        {s === "SCHEDULED" ? (
          <Button type="button" size="sm" disabled={pending} onClick={() => go("IN_PROGRESS")}>
            Bắt đầu làm
          </Button>
        ) : null}
        {s === "IN_PROGRESS" ? <Button type="button" size="sm" onClick={() => setMode("DONE")}>Nghiệm thu</Button> : null}
        <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setMode("CANCELLED")}>
          Huỷ phiếu…
        </Button>
      </div>
      {mode === "ACCEPTED" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-72" placeholder="Khách đồng ý qua đâu (Zalo, gọi điện…)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="button" size="sm" disabled={pending} onClick={() => go("ACCEPTED")}>
            Xác nhận khách đồng ý
          </Button>
        </div>
      ) : null}
      {mode === "SCHEDULED" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="fj-tech">Thợ</Label>
            <select id="fj-tech" className={`${SELECT} w-48`} value={tech} onChange={(e) => setTech(e.target.value)}>
              {techs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fj-start">Giờ hẹn</Label>
            <Input id="fj-start" type="datetime-local" className="h-9" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fj-dur">Thời lượng (phút)</Label>
            <Input id="fj-dur" className="h-9 w-28" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <Button type="button" size="sm" disabled={pending || !tech || !startAt} onClick={() => go("SCHEDULED")}>
            Lưu lịch hẹn
          </Button>
        </div>
      ) : null}
      {mode === "DONE" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-56" placeholder="Tên khách ký nghiệm thu" value={signer} onChange={(e) => setSigner(e.target.value)} maxLength={L.nameMax} />
          <Input className="h-8 w-72" placeholder="Ghi chú nghiệm thu" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="button" size="sm" disabled={pending || !signer.trim()} onClick={() => go("DONE")}>
            Xác nhận nghiệm thu
          </Button>
        </div>
      ) : null}
      {mode === "CANCELLED" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-72" placeholder="Lý do huỷ" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="button" size="sm" variant="outline" disabled={pending || reason.trim().length < L.reasonMin} onClick={() => go("CANCELLED")}>
            Huỷ phiếu
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Thu một đợt tiền (cọc / đợt giữa / nghiệm thu). Không thu vượt số còn phải thu. */
export function FieldJobReceiptForm({ jobId, due }: { jobId: string; due: number | null }) {
  const [amount, setAmount] = useState(due && due > 0 ? String(due) : "");
  const [method, setMethod] = useState<FieldJobPayMethod>("CASH");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm" data-field-job-receipt-form>
      <div className="space-y-1">
        <Label htmlFor="fj-amount">Số tiền (đ)</Label>
        <Input id="fj-amount" className="h-9 w-36" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="fj-method">Hình thức</Label>
        <select id="fj-method" className={`${SELECT} w-36`} value={method} onChange={(e) => setMethod(e.target.value as FieldJobPayMethod)}>
          {FIELD_JOB_PAY_METHODS.map((m) => (
            <option key={m} value={m}>
              {FIELD_JOB_PAY_METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="fj-rnote">Ghi chú</Label>
        <Input id="fj-rnote" className="h-9 w-48" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Cọc / đợt 2 / nghiệm thu" />
      </div>
      <Button
        type="button"
        size="sm"
        disabled={pending || !intOrNull(amount)}
        onClick={() =>
          start(async () => {
            const r = await recordFieldJobReceiptAction(jobId, { amount: intOrNull(amount) ?? 0, method, note });
            if (r.ok) {
              toast.success(r.message);
              setNote("");
            } else toast.error(firstError(r));
          })
        }
      >
        Thu tiền
      </Button>
    </div>
  );
}

export function VoidFieldJobReceiptButton({ jobId, receiptId }: { jobId: string; receiptId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        Huỷ phiếu thu…
      </Button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Input className="h-7 w-44 text-xs" placeholder="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={pending || reason.trim().length < L.reasonMin}
        onClick={() =>
          start(async () => {
            const r = await voidFieldJobReceiptAction(jobId, receiptId, reason);
            if (r.ok) toast.success(r.message);
            else toast.error(firstError(r));
          })
        }
      >
        Huỷ phiếu thu
      </Button>
    </span>
  );
}

/** Tải ảnh trước / sau — thu nhỏ ngay trên máy (cạnh dài 1600px) rồi mới gửi. */
export function FieldJobPhotoUpload({ jobId }: { jobId: string }) {
  const [phase, setPhase] = useState<FieldJobPhotoPhase>("BEFORE");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm" data-field-job-photo-upload>
      <div className="space-y-1">
        <Label htmlFor="fj-phase">Loại ảnh</Label>
        <select id="fj-phase" className={`${SELECT} w-44`} value={phase} onChange={(e) => setPhase(e.target.value as FieldJobPhotoPhase)}>
          {(Object.keys(FIELD_JOB_PHOTO_PHASE_LABEL) as FieldJobPhotoPhase[]).map((p) => (
            <option key={p} value={p}>
              {FIELD_JOB_PHOTO_PHASE_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="fj-photo">Chọn ảnh</Label>
        <Input
          id="fj-photo"
          type="file"
          accept="image/*"
          multiple
          disabled={pending}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            start(async () => {
              for (const f of files) {
                try {
                  const img = await thuNhoAnhTheoCo(f, { maxEdge: 1600, quality: 0.82 });
                  const r = await addFieldJobPhotoAction(jobId, { phase, contentType: img.contentType, base64: img.base64 });
                  if (!r.ok) toast.error(firstError(r));
                } catch {
                  toast.error(`Không đọc được ảnh ${f.name}`);
                }
              }
              toast.success("Đã tải ảnh lên");
            });
          }}
        />
      </div>
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
    </div>
  );
}

export function DeleteFieldJobPhotoButton({ jobId, photoId }: { jobId: string; photoId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-1 text-xs text-muted-foreground"
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (!window.confirm("Xoá ảnh này?")) return;
          const r = await deleteFieldJobPhotoAction(jobId, photoId);
          if (r.ok) toast.success(r.message);
          else toast.error(firstError(r));
        })
      }
    >
      Xoá
    </Button>
  );
}

/** Mở lượt bảo hành / quay lại cho phiếu đã nghiệm thu. */
export function FieldJobRevisitForm({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [issue, setIssue] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Input className="h-8 w-80" placeholder="Khách báo sự cố gì?" value={issue} onChange={(e) => setIssue(e.target.value)} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending || issue.trim().length < 5}
        onClick={() =>
          start(async () => {
            const r = await openFieldJobRevisitAction(jobId, issue);
            if (r.ok) {
              toast.success(r.message);
              router.push(`/field-jobs/${r.id}`);
            } else toast.error(firstError(r));
          })
        }
      >
        Mở lượt bảo hành
      </Button>
    </div>
  );
}
