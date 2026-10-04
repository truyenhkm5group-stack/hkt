"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { advanceWarrantyClaimAction, createWarrantyCardAction, openWarrantyClaimAction, voidWarrantyCardAction } from "@/lib/actions/warranty";
import { nextClaimStatuses, WARRANTY_CLAIM_STATUS_LABEL, WARRANTY_RESOLUTION_LABEL, WARRANTY_RESOLUTIONS, type WarrantyClaimStatus, type WarrantyResolution } from "@/lib/constants/warranty";
import type { WarrantyFormOptions } from "@/lib/queries/warranty";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

/** Ô tiền: trống ⇒ `null` (CHƯA BIẾT), không phải 0. */
function moneyOrNull(raw: string): number | null {
  const v = raw.replace(/[.,\s]/g, "");
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** Lập phiếu bảo hành: khách · sản phẩm · serial · ngày mua · số tháng. Hạn do máy chủ tính. */
export function WarrantyCardForm({ options, today, presetCustomerId }: { options: WarrantyFormOptions; today: string; presetCustomerId?: string }) {
  const [customerId, setCustomerId] = useState(presetCustomerId ?? "");
  const [variantId, setVariantId] = useState("");
  const [serial, setSerial] = useState("");
  const [purchasedOn, setPurchasedOn] = useState(today);
  const [months, setMonths] = useState("12");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await createWarrantyCardAction({ customerId, variantId: variantId || null, serial: serial || null, purchasedOn, months: Number(months), note });
      if (r.ok) {
        toast.success(r.message);
        setSerial("");
        setNote("");
      } else toast.error(firstError(r));
    });
  return (
    <div className="grid gap-3 text-sm md:grid-cols-4 md:items-end" data-warranty-card-form>
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor="wc-customer">Khách *</Label>
        <select id="wc-customer" className={SELECT} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">— Chọn khách —</option>
          {options.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone ? ` · ${c.phone}` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor="wc-product">Sản phẩm *</Label>
        <select id="wc-product" className={SELECT} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
          <option value="">— Chọn sản phẩm —</option>
          {options.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="wc-serial">Serial / IMEI</Label>
        <Input id="wc-serial" value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={80} placeholder="Để trống nếu hàng không có serial" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wc-date">Ngày mua *</Label>
        <Input id="wc-date" type="date" value={purchasedOn} max={today} onChange={(e) => setPurchasedOn(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wc-months">Bảo hành (tháng) *</Label>
        <Input id="wc-months" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wc-note">Ghi chú</Label>
        <Input id="wc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </div>
      <Button type="button" onClick={submit} disabled={pending || !customerId || !variantId || !/^\d+$/.test(months)}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lập phiếu bảo hành
      </Button>
    </div>
  );
}

/** Huỷ phiếu (nhập nhầm, khách trả hàng) — bắt buộc lý do. */
export function VoidWarrantyCardButton({ id, customerId }: { id: string; customerId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        Huỷ phiếu…
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Input className="h-7 w-56 text-xs" placeholder="Lý do huỷ phiếu" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={pending || reason.trim().length < 3}
        onClick={() =>
          start(async () => {
            const r = await voidWarrantyCardAction(id, reason, customerId);
            if (r.ok) toast.success(r.message);
            else toast.error(firstError(r));
          })
        }
      >
        Huỷ phiếu
      </Button>
    </div>
  );
}

/** Mở ca bảo hành trên một phiếu: mô tả lỗi + (tuỳ chọn) người nhận ca. */
export function OpenWarrantyClaimForm({ cardId, customerId, staff }: { cardId: string; customerId: string; staff: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        Mở ca bảo hành
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center gap-1" data-open-claim={cardId}>
      <Input className="h-7 w-72 text-xs" placeholder="Khách báo lỗi gì (ít nhất 5 ký tự)" value={issue} onChange={(e) => setIssue(e.target.value)} maxLength={1000} />
      <select className="h-7 rounded-md border bg-background px-1 text-xs" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Người nhận ca">
        <option value="">— Chưa giao —</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={pending || issue.trim().length < 5}
        onClick={() =>
          start(async () => {
            const r = await openWarrantyClaimAction(cardId, { issue, assigneeUserId: assignee || null }, customerId);
            if (r.ok) {
              toast.success(r.message);
              setOpen(false);
              setIssue("");
            } else toast.error(firstError(r));
          })
        }
      >
        Mở ca
      </Button>
    </div>
  );
}

/** Nút xử lý MỘT ca — chỉ bước hợp lệ. Xong cần cách xử lý; từ chối cần lý do. Chi phí / tiền thu: trống = chưa biết. */
export function WarrantyClaimActions({ id, status, customerId }: { id: string; status: WarrantyClaimStatus; customerId: string }) {
  const [mode, setMode] = useState<"DONE" | "REJECTED" | null>(null);
  const [resolution, setResolution] = useState<WarrantyResolution>("REPAIRED");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");
  const [charged, setCharged] = useState("");
  const [pending, start] = useTransition();
  const next = nextClaimStatuses(status);
  if (next.length === 0) return null;
  const go = (to: WarrantyClaimStatus) =>
    start(async () => {
      const r = await advanceWarrantyClaimAction(id, { status: to, resolution: to === "DONE" ? resolution : null, rejectReason: to === "REJECTED" ? reason : null, costVnd: moneyOrNull(cost), chargedVnd: moneyOrNull(charged) }, customerId);
      if (r.ok) {
        toast.success(r.message);
        setMode(null);
      } else toast.error(firstError(r));
    });
  return (
    <div className="flex flex-wrap items-center gap-1" data-claim-actions={id}>
      {next.includes("IN_PROGRESS") ? (
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending} onClick={() => go("IN_PROGRESS")}>
          {WARRANTY_CLAIM_STATUS_LABEL.IN_PROGRESS}
        </Button>
      ) : null}
      {mode === null ? (
        <>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setMode("DONE")}>
            Đóng ca…
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setMode("REJECTED")}>
            Từ chối…
          </Button>
        </>
      ) : (
        <>
          {mode === "DONE" ? (
            <select className="h-7 rounded-md border bg-background px-1 text-xs" value={resolution} onChange={(e) => setResolution(e.target.value as WarrantyResolution)} aria-label="Cách xử lý">
              {WARRANTY_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {WARRANTY_RESOLUTION_LABEL[r]}
                </option>
              ))}
            </select>
          ) : (
            <Input className="h-7 w-48 text-xs" placeholder="Lý do từ chối" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
          <Input className="h-7 w-28 text-xs" inputMode="numeric" placeholder="Chi phí (đ)" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Chi phí của shop" />
          <Input className="h-7 w-28 text-xs" inputMode="numeric" placeholder="Thu khách (đ)" value={charged} onChange={(e) => setCharged(e.target.value)} aria-label="Tiền thu khách" />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={pending || (mode === "REJECTED" && reason.trim().length < 3)} onClick={() => go(mode)}>
            {mode === "DONE" ? "Xác nhận xong" : "Xác nhận từ chối"}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setMode(null)}>
            Thôi
          </Button>
        </>
      )}
    </div>
  );
}
