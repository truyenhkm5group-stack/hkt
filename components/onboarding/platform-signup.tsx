"use client";

import { useState, useTransition } from "react";
import { Copy, Loader2, RotateCcw, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInviteAction, retrySetupAction, revokeInviteAction } from "@/lib/actions/onboarding";

/**
 * Ba nút của khu "Tự phục vụ" ở `/platform` (Phase 10 · §1): tạo mã mời (mã THÔ hiện ĐÚNG MỘT LẦN — đóng khung này là
 * mất, CSDL chỉ giữ băm), thu hồi mã, chạy lại một tổ chức `SETUP_FAILED`. Mọi kiểm quyền ở server action.
 */

export function InvitePanel({ plans }: { plans: { key: string; name: string }[] }) {
  const [note, setNote] = useState("");
  const [planKey, setPlanKey] = useState(plans[0]?.key ?? "");
  const [days, setDays] = useState(7);
  const [fresh, setFresh] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const link = fresh ? `${typeof window === "undefined" ? "" : window.location.origin}/start?invite=${encodeURIComponent(fresh.code)}` : "";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px_110px_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="invite-note">Ghi chú (cho ai)</Label>
          <Input id="invite-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bán sỉ Minh An — anh Tuấn" maxLength={200} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="invite-plan">Gói</Label>
          <select id="invite-plan" value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="invite-days">Hạn (ngày)</Label>
          <Input id="invite-days" type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </div>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await createInviteAction({ note, planKey, ttlDays: days });
              if ("error" in r) setError(r.error);
              else {
                setFresh({ code: r.code, expiresAt: r.expiresAt });
                setNote("");
              }
            })
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Ticket className="size-4" />}
          Tạo mã mời
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {fresh ? (
        <div role="status" className="space-y-1.5 rounded-xl border border-emerald-400/50 bg-emerald-50 p-3 text-sm dark:bg-emerald-950">
          <p className="font-semibold">Mã mời — chỉ hiện MỘT lần, chép ngay:</p>
          <p className="font-mono text-base tracking-wide" data-invite-code>
            {fresh.code}
          </p>
          <p className="break-all text-xs text-muted-foreground">{link}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => toast.success("Đã chép liên kết mời"));
              }}
            >
              <Copy className="size-3.5" /> Chép liên kết
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Đã chép, đóng
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RevokeInviteButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await revokeInviteAction(id);
          if ("error" in r) toast.error(r.error);
          else toast.success("Đã thu hồi mã mời");
        })
      }
    >
      Thu hồi
    </Button>
  );
}

export function RetrySetupButton({ orgCode }: { orgCode: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retrySetupAction(orgCode);
          if ("error" in r) toast.error(r.error);
          else toast.success(`Đã dựng xong «${orgCode}»`);
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
      Chạy lại
    </Button>
  );
}
