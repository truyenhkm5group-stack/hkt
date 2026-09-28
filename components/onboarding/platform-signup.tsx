"use client";

import { useState, useTransition } from "react";
import { Copy, Loader2, RotateCcw, Ticket } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInviteAction, retrySetupAction, revokeInviteAction, setSignupModeAction } from "@/lib/actions/onboarding";
import { exceedsSignupCeiling, narrowerSignupMode, SIGNUP_MODE_CONSEQUENCE, SIGNUP_MODE_LABEL, SIGNUP_MODES, type SignupCeilingSource, type SignupMode } from "@/lib/onboarding/shared";

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

const CEILING_NOTE: Record<SignupCeilingSource, string> = {
  ENV_UNSET: "biến môi trường PLATFORM_SIGNUP_MODE không đặt ⇒ trần mặc định",
  ENV: "khai ở biến môi trường PLATFORM_SIGNUP_MODE",
  ENV_INVALID: "PLATFORM_SIGNUP_MODE mang giá trị lạ ⇒ tắt cứng",
};

/**
 * Công tắc B của «Cổng mở bán» (`/platform`): chế độ đăng ký `/start` = min(trần môi trường, cài đặt). Chế độ vượt trần
 * không chọn được (máy chủ cũng từ chối). Đổi phải ghi lý do và qua hộp xác nhận in NGUYÊN VĂN hệ quả của chế độ mới.
 */
export function SignupModeControl(props: {
  ceiling: SignupMode;
  ceilingSource: SignupCeilingSource;
  setting: SignupMode;
  stored: boolean;
  effective: SignupMode;
  updatedAt: string | null;
  updatedByEmail: string | null;
  cacheSeconds: number;
}) {
  const [mode, setMode] = useState<SignupMode>(props.setting);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const nextEffective = narrowerSignupMode(props.ceiling, mode);

  const apply = () =>
    start(async () => {
      setError(null);
      const r = await setSignupModeAction({ mode, reason });
      if ("error" in r) {
        setError(r.error);
        setConfirming(false);
        return;
      }
      setConfirming(false);
      setReason("");
      toast.success(r.changed ? `Đã đổi — /start đang ở chế độ «${SIGNUP_MODE_LABEL[r.effective as SignupMode] ?? r.effective}»` : "Không đổi gì — cài đặt đã là như vậy");
    });

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Đang có hiệu lực</dt>
        <dd className={props.effective === "off" ? "font-semibold" : "font-semibold text-emerald-700 dark:text-emerald-300"} data-signup-effective={props.effective}>
          {SIGNUP_MODE_LABEL[props.effective]}
        </dd>
        <dt className="text-muted-foreground">Trần máy chủ</dt>
        <dd>
          {SIGNUP_MODE_LABEL[props.ceiling]} <span className="text-muted-foreground">({CEILING_NOTE[props.ceilingSource]})</span>
        </dd>
        <dt className="text-muted-foreground">Cài đặt</dt>
        <dd>
          {SIGNUP_MODE_LABEL[props.setting]}
          <span className="text-muted-foreground">{props.stored ? ` · ${props.updatedAt ?? "—"} · ${props.updatedByEmail ?? "máy"}` : " (chưa từng đặt ⇒ TẮT)"}</span>
        </dd>
      </dl>
      <div className="grid gap-2 sm:grid-cols-[150px_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="signup-mode">Chế độ mới</Label>
          <select id="signup-mode" value={mode} onChange={(e) => setMode(e.target.value as SignupMode)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {SIGNUP_MODES.map((m) => (
              <option key={m} value={m} disabled={exceedsSignupCeiling(m, props.ceiling)}>
                {SIGNUP_MODE_LABEL[m]}
                {exceedsSignupCeiling(m, props.ceiling) ? " — vượt trần" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="signup-reason">Lý do (vào nhật ký nền tảng)</Label>
          <Input id="signup-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Mở cho khách thử đợt 1" maxLength={500} />
        </div>
        <Button type="button" variant="outline" disabled={pending || reason.trim().length < 5} onClick={() => setConfirming(true)}>
          Đổi…
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <p className="text-[11px] text-muted-foreground">Có hiệu lực ngay ở máy chủ này (tiến trình khác trễ tối đa {props.cacheSeconds} giây) — không cần deploy. Tắt khẩn cấp: đặt «TẮT» ở đây, hoặc PLATFORM_SIGNUP_MODE=off rồi khởi động lại.</p>

      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đổi đăng ký /start sang «{SIGNUP_MODE_LABEL[mode]}»?</AlertDialogTitle>
            <AlertDialogDescription>
              {SIGNUP_MODE_CONSEQUENCE[nextEffective]} Hiệu lực sau khi đổi: «{SIGNUP_MODE_LABEL[nextEffective]}» (trần máy chủ: «{SIGNUP_MODE_LABEL[props.ceiling]}»). Lượt đổi ghi vào nhật ký nền tảng kèm lý do.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              {pending ? "Đang đổi…" : "Xác nhận đổi"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
