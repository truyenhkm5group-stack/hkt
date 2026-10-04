"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addReUnitsAction,
  closeReDepositAction,
  createReProjectAction,
  depositReUnitAction,
  holdReUnitAction,
  lockReUnitAction,
  releaseReHoldAction,
  sellReUnitAction,
} from "@/lib/actions/real-estate";
import { RE_LIMITS, type ReUnitState } from "@/lib/constants/real-estate";

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

function intOrNull(raw: string): number | null {
  const v = raw.replace(/[.,\s]/g, "");
  return /^\d+$/.test(v) ? Number(v) : null;
}

type Result = { ok: true; message: string } | { ok: false; errors: { message: string }[] };

function useRun() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        after?.();
      } else toast.error(firstError(r));
    });
  return { pending, run };
}

/** Tạo dự án — số giờ giữ chỗ BẮT BUỘC khai (không có mặc định). */
export function ReProjectForm() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const { pending, run } = useRun();
  return (
    <div className="grid gap-3 text-sm md:grid-cols-4 md:items-end" data-re-project-form>
      <div className="space-y-1">
        <Label htmlFor="rp-code">Mã dự án *</Label>
        <Input id="rp-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={RE_LIMITS.codeMax} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rp-name">Tên dự án *</Label>
        <Input id="rp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={RE_LIMITS.nameMax} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rp-hours">Giữ chỗ tối đa (giờ) *</Label>
        <Input id="rp-hours" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Theo chính sách của chủ đầu tư" />
      </div>
      <Button
        type="button"
        disabled={pending || !code.trim() || !name.trim() || !intOrNull(hours)}
        onClick={() =>
          run(
            () =>
              createReProjectAction({
                code,
                name,
                holdHours: intOrNull(hours) ?? 0,
                note,
              }),
            () => {
              setCode("");
              setName("");
              setHours("");
              setNote("");
            },
          )
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Tạo dự án
      </Button>
      <div className="space-y-1 md:col-span-4">
        <Label htmlFor="rp-note">Ghi chú (chính sách cọc, bàn giao…)</Label>
        <Input id="rp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={RE_LIMITS.textMax} />
      </div>
    </div>
  );
}

/** Dán danh sách căn: «mã | toà/khu | tầng | diện tích m² | giá niêm yết», mỗi dòng một căn. */
export function ReUnitsBulkForm({ projectId }: { projectId: string }) {
  const [text, setText] = useState("");
  const { pending, run } = useRun();
  return (
    <div className="space-y-2 text-sm" data-re-units-form>
      <textarea
        aria-label="Danh sách căn"
        className="h-32 w-full rounded-md border bg-background p-2 font-mono text-xs"
        placeholder={"A-1201 | Toà A | 12 | 68,5 | 3.250.000.000\nA-1202 | Toà A | 12 | 75 | 3.600.000.000"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button
        type="button"
        size="sm"
        disabled={pending || !text.trim()}
        onClick={() =>
          run(
            () => addReUnitsAction(projectId, text),
            () => setText(""),
          )
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Thêm căn
      </Button>
    </div>
  );
}

type UnitForActions = {
  id: string;
  state: ReUnitState;
  hold: { id: string; mine: boolean } | null;
  deposit: { id: string } | null;
};

/** Nút theo đúng trạng thái căn và quyền người xem. */
export function ReUnitActions({ unit, canHold, canManage }: { unit: UnitForActions; canHold: boolean; canManage: boolean }) {
  const [mode, setMode] = useState<null | "hold" | "deposit" | "release" | "close" | "sell" | "lock">(null);
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [contract, setContract] = useState("");
  const { pending, run } = useRun();
  const done = () => {
    setMode(null);
    setReason("");
  };
  const s = unit.state;
  const btn = (label: string, m: typeof mode, variant: "outline" | "ghost" = "outline") => (
    <Button type="button" size="sm" variant={variant} className="h-7 px-2 text-xs" onClick={() => setMode(mode === m ? null : m)}>
      {label}
    </Button>
  );
  return (
    <div className="space-y-1" data-re-unit-actions={s}>
      <div className="flex flex-wrap justify-end gap-1">
        {canHold && s === "AVAILABLE" ? btn("Giữ chỗ", "hold") : null}
        {canHold && (s === "AVAILABLE" || (s === "HELD" && unit.hold?.mine)) ? btn("Đặt cọc", "deposit") : null}
        {s === "HELD" && unit.hold?.mine ? (
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => unit.hold && run(() => releaseReHoldAction(unit.hold!.id, ""))}>
            Nhả giữ chỗ
          </Button>
        ) : null}
        {canManage && s === "HELD" && unit.hold && !unit.hold.mine ? btn("Nhả hộ…", "release", "ghost") : null}
        {canManage && s === "DEPOSITED" ? btn("Ký bán", "sell") : null}
        {canManage && s === "DEPOSITED" ? btn("Hoàn / bỏ cọc…", "close", "ghost") : null}
        {canManage && s === "AVAILABLE" ? btn("Khoá căn…", "lock", "ghost") : null}
        {canManage && s === "LOCKED" ? (
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => run(() => lockReUnitAction(unit.id, false, ""))}>
            Mở căn
          </Button>
        ) : null}
      </div>
      {mode === "hold" || mode === "deposit" ? (
        <div className="flex flex-wrap justify-end gap-1">
          {mode === "deposit" ? <Input className="h-7 w-32 text-xs" placeholder="Tiền cọc (đ)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /> : null}
          {mode === "hold" || s === "AVAILABLE" ? (
            <>
              <Input className="h-7 w-36 text-xs" placeholder="Tên khách" value={customer} onChange={(e) => setCustomer(e.target.value)} />
              <Input className="h-7 w-28 text-xs" placeholder="SĐT" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={pending || (mode === "hold" && !customer.trim()) || (mode === "deposit" && !intOrNull(amount))}
            onClick={() =>
              run(
                () =>
                  mode === "hold"
                    ? holdReUnitAction(unit.id, {
                        customerName: customer,
                        customerPhone: phone,
                      })
                    : depositReUnitAction(unit.id, {
                        amount: intOrNull(amount) ?? 0,
                        customerName: customer,
                        customerPhone: phone,
                      }),
                done,
              )
            }
          >
            {mode === "hold" ? "Xác nhận giữ chỗ" : "Xác nhận cọc"}
          </Button>
        </div>
      ) : null}
      {mode === "release" || mode === "lock" ? (
        <div className="flex flex-wrap justify-end gap-1">
          <Input className="h-7 w-52 text-xs" placeholder="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={pending || reason.trim().length < RE_LIMITS.reasonMin}
            onClick={() => run(() => (mode === "release" && unit.hold ? releaseReHoldAction(unit.hold.id, reason) : lockReUnitAction(unit.id, true, reason)), done)}
          >
            {mode === "release" ? "Nhả giữ chỗ" : "Khoá căn"}
          </Button>
        </div>
      ) : null}
      {mode === "close" && unit.deposit ? (
        <div className="flex flex-wrap justify-end gap-1">
          <Input className="h-7 w-52 text-xs" placeholder="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={pending || reason.trim().length < RE_LIMITS.reasonMin}
            onClick={() =>
              run(
                () =>
                  closeReDepositAction(unit.deposit!.id, {
                    outcome: "REFUNDED",
                    reason,
                  }),
                done,
              )
            }
          >
            Hoàn cọc
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={pending || reason.trim().length < RE_LIMITS.reasonMin}
            onClick={() =>
              run(
                () =>
                  closeReDepositAction(unit.deposit!.id, {
                    outcome: "FORFEITED",
                    reason,
                  }),
                done,
              )
            }
          >
            Khách bỏ cọc
          </Button>
        </div>
      ) : null}
      {mode === "sell" ? (
        <div className="flex flex-wrap justify-end gap-1">
          <Input className="h-7 w-44 text-xs" placeholder="Số hợp đồng" value={contract} onChange={(e) => setContract(e.target.value)} />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={pending || !contract.trim()} onClick={() => run(() => sellReUnitAction(unit.id, contract), done)}>
            Xác nhận ký bán
          </Button>
        </div>
      ) : null}
    </div>
  );
}
