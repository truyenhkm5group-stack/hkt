"use client";

import { useMemo, useState, useTransition } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { closePackageAction, createAppointmentAction, createPackageAction, setAppointmentStatusAction, updateAppointmentAction } from "@/lib/actions/appointments";
import { APPOINTMENT_STATUS_LABEL, nextAppointmentStatuses, type AppointmentStatus } from "@/lib/constants/appointments";
import type { AppointmentFormOptions } from "@/lib/queries/appointments";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

/** Ô datetime-local là GIỜ VIỆT NAM — gửi kèm +07:00 để máy chủ không đọc nhầm sang UTC. */
function vnIso(local: string): string {
  return `${local}:00+07:00`;
}

/** Đặt lịch hẹn: khách → dịch vụ → kỹ thuật viên → giờ + thời lượng → (liệu trình của khách, nếu có). */
export function AppointmentCreateForm({ options, day, presetCustomerId }: { options: AppointmentFormOptions; day: string; presetCustomerId?: string }) {
  const [customerId, setCustomerId] = useState(presetCustomerId ?? "");
  const [variantId, setVariantId] = useState("");
  const [staffUserId, setStaffUserId] = useState("");
  const [at, setAt] = useState(`${day}T09:00`);
  const [duration, setDuration] = useState("60");
  const [packageId, setPackageId] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const packages = useMemo(() => options.packages.filter((p) => p.customerId === customerId), [options.packages, customerId]);
  const submit = () =>
    start(async () => {
      const r = await createAppointmentAction({ customerId, variantId: variantId || null, staffUserId: staffUserId || null, startsAt: vnIso(at), durationMin: Number(duration), packageId: packageId || null, note });
      if (r.ok) {
        toast.success(r.message);
        setNote("");
        setPackageId("");
      } else toast.error(firstError(r));
    });
  return (
    <div className="grid gap-3 text-sm md:grid-cols-4 md:items-end" data-appointment-form>
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor="ap-customer">Khách *</Label>
        <select id="ap-customer" className={SELECT} value={customerId} onChange={(e) => (setCustomerId(e.target.value), setPackageId(""))}>
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
        <Label htmlFor="ap-service">Dịch vụ *</Label>
        <select id="ap-service" className={SELECT} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
          <option value="">— Chọn dịch vụ —</option>
          {options.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ap-staff">Kỹ thuật viên</Label>
        <select id="ap-staff" className={SELECT} value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)}>
          <option value="">— Chưa xếp —</option>
          {options.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ap-at">Giờ bắt đầu *</Label>
        <Input id="ap-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ap-dur">Thời lượng (phút)</Label>
        <Input id="ap-dur" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ap-pkg">Liệu trình</Label>
        <select id="ap-pkg" className={SELECT} value={packageId} onChange={(e) => setPackageId(e.target.value)} disabled={packages.length === 0}>
          <option value="">{packages.length ? "— Trả lẻ —" : "Khách chưa có liệu trình"}</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} (còn {p.available} buổi)
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1 md:col-span-3">
        <Label htmlFor="ap-note">Ghi chú</Label>
        <Input id="ap-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </div>
      <Button type="button" onClick={submit} disabled={pending || !customerId || !variantId}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Đặt lịch
      </Button>
    </div>
  );
}

/** Nút chuyển trạng thái của MỘT lịch — chỉ những bước hợp lệ; huỷ hỏi lý do ngay tại chỗ. */
export function AppointmentStatusButtons({ id, status, customerId }: { id: string; status: AppointmentStatus; customerId: string }) {
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [pending, start] = useTransition();
  const next = nextAppointmentStatuses(status);
  if (next.length === 0) return null;
  const go = (to: AppointmentStatus) =>
    start(async () => {
      const r = await setAppointmentStatusAction(id, { status: to, reason }, customerId);
      if (r.ok) {
        toast.success(r.message);
        setCancelling(false);
        setReason("");
      } else toast.error(firstError(r));
    });
  return (
    <div className="flex flex-wrap items-center gap-1" data-appointment-actions={id}>
      {next
        .filter((s) => s !== "CANCELLED")
        .map((s) => (
          <Button key={s} type="button" size="sm" variant={s === "DONE" ? "default" : "outline"} className="h-7 px-2 text-xs" disabled={pending} onClick={() => go(s)}>
            {APPOINTMENT_STATUS_LABEL[s]}
          </Button>
        ))}
      {cancelling ? (
        <>
          <Input aria-label="Lý do huỷ" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do huỷ" className="h-7 w-36 text-xs" />
          <Button type="button" size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={pending || reason.trim().length < 3} onClick={() => go("CANCELLED")}>
            Huỷ lịch
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCancelling(true)}>
          Huỷ…
        </Button>
      )}
    </div>
  );
}

/** Mở liệu trình N buổi cho khách (thường sau khi khách trả tiền gói). */
export function PackageCreateForm({ customerId, services }: { customerId: string; services: { id: string; label: string }[] }) {
  const [name, setName] = useState("");
  const [variantId, setVariantId] = useState("");
  const [sessions, setSessions] = useState("10");
  const [expiresOn, setExpiresOn] = useState("");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const label = services.find((s) => s.id === variantId)?.label;
      const r = await createPackageAction(customerId, { name: name.trim() || (label ? `${label} — ${sessions} buổi` : ""), variantId: variantId || null, totalSessions: Number(sessions), expiresOn: expiresOn || null });
      if (r.ok) {
        toast.success(r.message);
        setName("");
      } else toast.error(firstError(r));
    });
  return (
    <div className="grid gap-2 text-sm sm:grid-cols-[1fr_1fr_6rem_10rem_auto] sm:items-end" data-package-form>
      <div className="space-y-1">
        <Label htmlFor="pk-service">Dịch vụ</Label>
        <select id="pk-service" className={SELECT} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
          <option value="">— Gói nhiều dịch vụ —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="pk-name">Tên liệu trình</Label>
        <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tự đặt theo dịch vụ nếu để trống" maxLength={120} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pk-sessions">Số buổi</Label>
        <Input id="pk-sessions" inputMode="numeric" value={sessions} onChange={(e) => setSessions(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pk-exp">Hết hạn</Label>
        <Input id="pk-exp" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </div>
      <Button type="button" onClick={submit} disabled={pending || (!name.trim() && !variantId)}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Mở liệu trình
      </Button>
    </div>
  );
}

export function ClosePackageButton({ id, customerId }: { id: string; customerId: string }) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        Đóng…
      </Button>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <Input aria-label="Lý do đóng" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do" className="h-7 w-32 text-xs" />
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="h-7 px-2 text-xs"
        disabled={pending || reason.trim().length < 3}
        onClick={() =>
          start(async () => {
            const r = await closePackageAction(id, reason, customerId);
            if (r.ok) toast.success(r.message);
            else toast.error(firstError(r));
          })
        }
      >
        Đóng
      </Button>
    </span>
  );
}

/** Giờ Việt Nam dạng ô datetime-local (YYYY-MM-DDTHH:MM) của một mốc ISO. */
function vnLocal(iso: string): string {
  return new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 16);
}

/**
 * ĐỔI GIỜ / KỸ THUẬT VIÊN của một lịch đang hiệu lực. Giữ nguyên khách, dịch vụ, thời lượng, liệu trình, ghi chú — máy chủ
 * kiểm lại trùng giờ (không tự va chính lịch này).
 */
export function AppointmentReschedule({ row, staff }: { row: { id: string; customerId: string; variantId: string | null; serviceName: string; staffUserId: string | null; startsAt: string; endsAt: string; packageId: string | null; note: string }; staff: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(vnLocal(row.startsAt));
  const [staffUserId, setStaffUserId] = useState(row.staffUserId ?? "");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        Đổi giờ…
      </Button>
    );
  const durationMin = Math.round((Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 60_000);
  const save = () =>
    start(async () => {
      const r = await updateAppointmentAction(row.id, { customerId: row.customerId, variantId: row.variantId, serviceName: row.serviceName, staffUserId: staffUserId || null, startsAt: vnIso(at), durationMin, packageId: row.packageId, note: row.note });
      if (r.ok) {
        toast.success(r.message);
        setOpen(false);
      } else toast.error(firstError(r));
    });
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-appointment-reschedule={row.id}>
      <Input aria-label="Giờ mới" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="h-7 w-44 text-xs" />
      <select aria-label="Kỹ thuật viên" className="h-7 rounded-md border bg-background px-1 text-xs" value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)}>
        <option value="">— Chưa xếp —</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={save}>
        Lưu
      </Button>
    </span>
  );
}

/** Sao chép câu nhắc lịch soạn sẵn (khung «Nhắc lịch ngày mai»). */
export function CopyReminderButton({ text }: { text: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 px-2 text-xs"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => toast.success("Đã sao chép câu nhắc"),
          () => toast.error("Trình duyệt không cho sao chép — bôi đen câu nhắc để chép tay"),
        )
      }
    >
      <Copy className="size-3.5" /> Sao chép câu nhắc
    </Button>
  );
}
