"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelStayBookingAction,
  createStayBookingAction,
  createStayUnitAction,
  importStayIcsAction,
  markStayTurnoverAction,
  rotateStayIcalTokenAction,
  updateStayBookingDetailsAction,
  updateStayUnitAction,
} from "@/lib/actions/stays";
import { addStayDays, STAY_CHANNEL_LABEL, STAY_CHANNELS, STAY_LIMITS, type StayChannel } from "@/lib/constants/stays";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

/** Ô tiền / ô số: trống ⇒ `null` (CHƯA BIẾT), không phải 0. */
function intOrNull(raw: string): number | null {
  const v = raw.replace(/[.,\s]/g, "");
  return /^\d+$/.test(v) ? Number(v) : null;
}

type UnitOption = { id: string; name: string; code: string };

/** Đặt phòng tay (khách trực tiếp / kênh không có lịch) hoặc khoá ngày. Trùng phòng thì máy chủ chặn và nói trùng với ai. */
export function StayBookingForm({ units, today }: { units: UnitOption[]; today: string }) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [kind, setKind] = useState<"BOOKING" | "BLOCK">("BOOKING");
  const [channel, setChannel] = useState<StayChannel>("DIRECT");
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(addStayDays(today, 1));
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guests, setGuests] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await createStayBookingAction({ unitId, kind, channel, checkIn, checkOut, guestName, guestPhone, guests: intOrNull(guests), amountVnd: intOrNull(amount), note });
      if (r.ok) {
        toast.success(r.message);
        setGuestName("");
        setGuestPhone("");
        setGuests("");
        setAmount("");
        setNote("");
      } else toast.error(firstError(r));
    });
  return (
    <div className="grid gap-3 text-sm md:grid-cols-4 md:items-end" data-stay-booking-form>
      <div className="space-y-1">
        <Label htmlFor="sb-unit">Phòng *</Label>
        <select id="sb-unit" className={SELECT} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.code} · {u.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="sb-kind">Loại</Label>
        <select id="sb-kind" className={SELECT} value={kind} onChange={(e) => setKind(e.target.value as "BOOKING" | "BLOCK")}>
          <option value="BOOKING">Đặt phòng</option>
          <option value="BLOCK">Khoá ngày (sửa chữa, chủ ở…)</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="sb-in">Ngày nhận *</Label>
        <Input id="sb-in" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sb-out">Ngày trả *</Label>
        <Input id="sb-out" type="date" value={checkOut} min={checkIn ? addStayDays(checkIn, 1) : undefined} onChange={(e) => setCheckOut(e.target.value)} />
      </div>
      {kind === "BOOKING" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="sb-channel">Kênh</Label>
            <select id="sb-channel" className={SELECT} value={channel} onChange={(e) => setChannel(e.target.value as StayChannel)}>
              {STAY_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {STAY_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-guest">Tên khách *</Label>
            <Input id="sb-guest" value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={STAY_LIMITS.nameMax} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-phone">SĐT</Label>
            <Input id="sb-phone" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} maxLength={30} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-guests">Số khách</Label>
            <Input id="sb-guests" inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-amount">Tiền phòng (đ)</Label>
            <Input id="sb-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Trống = chưa biết" />
          </div>
        </>
      ) : null}
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor="sb-note">Ghi chú</Label>
        <Input id="sb-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={STAY_LIMITS.noteMax} />
      </div>
      <Button type="button" onClick={submit} disabled={pending || !unitId || !checkIn || !checkOut || (kind === "BOOKING" && !guestName.trim())}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {kind === "BLOCK" ? "Khoá ngày" : "Đặt phòng"}
      </Button>
    </div>
  );
}

/** Huỷ lượt đặt tay / mở lại ngày khoá — bắt buộc lý do. */
export function StayCancelButton({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        {label}…
      </Button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Input className="h-7 w-48 text-xs" placeholder="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={pending || reason.trim().length < STAY_LIMITS.reasonMin}
        onClick={() =>
          start(async () => {
            const r = await cancelStayBookingAction(id, reason);
            if (r.ok) toast.success(r.message);
            else toast.error(firstError(r));
          })
        }
      >
        {label}
      </Button>
    </span>
  );
}

/** Bổ sung tên / SĐT / số khách / tiền / ghi chú cho một lượt (kể cả lượt nhập từ lịch kênh). */
export function StayDetailsEditor({ booking }: { booking: { id: string; guestName: string; guestPhone: string; guests: number | null; amountVnd: number | null; note: string } }) {
  const [open, setOpen] = useState(false);
  const [guestName, setGuestName] = useState(booking.guestName);
  const [guestPhone, setGuestPhone] = useState(booking.guestPhone);
  const [guests, setGuests] = useState(booking.guests === null ? "" : String(booking.guests));
  const [amount, setAmount] = useState(booking.amountVnd === null ? "" : String(booking.amountVnd));
  const [note, setNote] = useState(booking.note);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        Sửa thông tin
      </Button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Input className="h-7 w-32 text-xs" placeholder="Tên khách" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
      <Input className="h-7 w-28 text-xs" placeholder="SĐT" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} />
      <Input className="h-7 w-16 text-xs" placeholder="Khách" inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value)} />
      <Input className="h-7 w-28 text-xs" placeholder="Tiền (đ)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <Input className="h-7 w-40 text-xs" placeholder="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await updateStayBookingDetailsAction(booking.id, { guestName, guestPhone, guests: intOrNull(guests), amountVnd: intOrNull(amount), note });
            if (r.ok) {
              toast.success(r.message);
              setOpen(false);
            } else toast.error(firstError(r));
          })
        }
      >
        Lưu
      </Button>
    </span>
  );
}

/** Dọn xong / bỏ đánh dấu cho (phòng, ngày). */
export function StayTurnoverButton({ unitId, day, done }: { unitId: string; day: string; done: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant={done ? "ghost" : "outline"}
      className="h-7 px-2 text-xs"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await markStayTurnoverAction(unitId, day, !done);
          if (r.ok) toast.success(r.message);
          else toast.error(firstError(r));
        })
      }
    >
      {done ? "Bỏ đánh dấu" : "Dọn xong"}
    </Button>
  );
}

type UnitDraft = { id?: string; name: string; code: string; capacity: number | null; address: string; ownerName: string; note: string; active: boolean };

/** Thêm / sửa phòng. */
export function StayUnitForm({ unit }: { unit?: UnitDraft }) {
  const [name, setName] = useState(unit?.name ?? "");
  const [code, setCode] = useState(unit?.code ?? "");
  const [capacity, setCapacity] = useState(unit?.capacity ? String(unit.capacity) : "");
  const [address, setAddress] = useState(unit?.address ?? "");
  const [ownerName, setOwnerName] = useState(unit?.ownerName ?? "");
  const [note, setNote] = useState(unit?.note ?? "");
  const [active, setActive] = useState(unit?.active ?? true);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const input = { name, code, capacity: intOrNull(capacity), address, ownerName, note, active };
      const r = unit?.id ? await updateStayUnitAction(unit.id, input) : await createStayUnitAction(input);
      if (r.ok) {
        toast.success(r.message);
        if (!unit?.id) {
          setName("");
          setCode("");
          setCapacity("");
          setAddress("");
          setNote("");
        }
      } else toast.error(firstError(r));
    });
  const p = unit?.id ? `su-${unit.id.slice(0, 6)}` : "su-new";
  return (
    <div className="grid gap-3 text-sm md:grid-cols-4 md:items-end" data-stay-unit-form>
      <div className="space-y-1">
        <Label htmlFor={`${p}-code`}>Mã phòng *</Label>
        <Input id={`${p}-code`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={STAY_LIMITS.codeMax} placeholder="VD: P201, Villa A" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${p}-name`}>Tên phòng *</Label>
        <Input id={`${p}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={STAY_LIMITS.nameMax} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${p}-cap`}>Sức chứa (khách)</Label>
        <Input id={`${p}-cap`} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${p}-owner`}>Chủ nhà</Label>
        <Input id={`${p}-owner`} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} maxLength={STAY_LIMITS.nameMax} placeholder="Khi vận hành hộ chủ nhà" />
      </div>
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor={`${p}-addr`}>Địa chỉ</Label>
        <Input id={`${p}-addr`} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${p}-note`}>Ghi chú</Label>
        <Input id={`${p}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={STAY_LIMITS.noteMax} />
      </div>
      <div className="flex items-center gap-3">
        {unit?.id ? (
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Đang cho thuê
          </label>
        ) : null}
        <Button type="button" onClick={submit} disabled={pending || !name.trim() || !code.trim()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {unit?.id ? "Lưu phòng" : "Thêm phòng"}
        </Button>
      </div>
    </div>
  );
}

/** Đường dẫn lịch .ics ERP phát cho từng kênh + nút đổi đường dẫn khi lộ. */
export function StayFeedLinks({ unitId, links }: { unitId: string; links: { channel: StayChannel; url: string }[] }) {
  const [pending, start] = useTransition();
  return (
    <div className="space-y-1 text-xs" data-stay-feed-links>
      {links.map((l) => (
        <div key={l.channel} className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-muted-foreground">Dán vào {STAY_CHANNEL_LABEL[l.channel]}</span>
          <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5">{l.url}</code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => {
              void navigator.clipboard?.writeText(l.url).then(
                () => toast.success("Đã chép đường dẫn lịch"),
                () => toast.error("Không chép được — bôi đen và chép tay"),
              );
            }}
          >
            Chép
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs text-muted-foreground"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (!window.confirm("Đổi đường dẫn lịch? Đường cũ ngừng hoạt động ngay — phải dán đường mới vào từng kênh.")) return;
            const r = await rotateStayIcalTokenAction(unitId);
            if (r.ok) toast.success(r.message);
            else toast.error(firstError(r));
          })
        }
      >
        Đổi đường dẫn (khi bị lộ)…
      </Button>
    </div>
  );
}

type ImportOutcome = { applied: boolean; message: string; cancelList: { checkIn: string; checkOut: string; why: string }[] };

/**
 * Nhập lịch .ics của kênh: dán nội dung hoặc chọn tệp tải từ Airbnb / Booking / Agoda. Bấm «Chạy thử» trước — xem bao nhiêu
 * lượt mới / đổi / huỷ — rồi mới «Nhập thật».
 */
export function StayIcsImport({ units }: { units: UnitOption[] }) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [channel, setChannel] = useState<StayChannel>("AIRBNB");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [pending, start] = useTransition();
  const run = (apply: boolean) =>
    start(async () => {
      const r = await importStayIcsAction({ unitId, channel, text, apply });
      if (!r.ok) {
        toast.error(firstError(r));
        return;
      }
      setResult({ applied: r.applied, message: r.message, cancelList: r.cancelList });
      if (r.applied) {
        toast.success(r.message);
        setText("");
      }
    });
  return (
    <div className="space-y-3 text-sm" data-stay-ics-import>
      <div className="grid gap-3 md:grid-cols-3 md:items-end">
        <div className="space-y-1">
          <Label htmlFor="si-unit">Phòng</Label>
          <select
            id="si-unit"
            className={SELECT}
            value={unitId}
            onChange={(e) => {
              setUnitId(e.target.value);
              setResult(null);
            }}
          >
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code} · {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="si-channel">Kênh</Label>
          <select
            id="si-channel"
            className={SELECT}
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as StayChannel);
              setResult(null);
            }}
          >
            {STAY_CHANNELS.filter((c) => c !== "DIRECT").map((c) => (
              <option key={c} value={c}>
                {STAY_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="si-file">Tệp .ics</Label>
          <Input
            id="si-file"
            type="file"
            accept=".ics,text/calendar"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > STAY_LIMITS.icsMaxBytes) {
                toast.error("Tệp lịch quá lớn");
                return;
              }
              void f.text().then((t) => {
                setText(t);
                setResult(null);
              });
            }}
          />
        </div>
      </div>
      <textarea
        aria-label="Nội dung lịch .ics"
        className="h-28 w-full rounded-md border bg-background p-2 font-mono text-xs"
        placeholder="…hoặc dán nội dung tệp lịch (BEGIN:VCALENDAR …)"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={pending || !text.trim() || !unitId} onClick={() => run(false)}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Chạy thử
        </Button>
        <Button type="button" disabled={pending || !result || result.applied} onClick={() => run(true)}>
          Nhập thật
        </Button>
        {result ? <span className={result.applied ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}>{result.message}</span> : null}
      </div>
      {result && !result.applied && result.cancelList.length ? (
        <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
          {result.cancelList.map((c) => (
            <li key={`${c.checkIn}-${c.checkOut}`}>
              Sẽ huỷ {c.checkIn.split("-").reverse().join("/")} → {c.checkOut.split("-").reverse().join("/")}: {c.why}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
