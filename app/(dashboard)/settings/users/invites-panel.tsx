"use client";

/**
 * MỜI NGƯỜI DÙNG QUA LIÊN KẾT — nút «Mời người dùng» + danh sách lời mời.
 *
 * Liên kết hiện ĐÚNG MỘT LẦN ngay sau khi tạo (CSDL chỉ giữ băm của mã): đóng hộp thoại là không lấy lại được — lạc mất
 * thì thu hồi rồi mời lại. ERP chưa có bộ gửi thư, nên màn hình nói thẳng: người mời tự gửi liên kết qua kênh của họ.
 */
import { useEffect, useState, useTransition } from "react";
import { Check, Copy, Link2, Loader2, MailPlus, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createUserInviteAction, revokeUserInviteAction } from "@/lib/actions/user-invites";
import { ROLE_HINT, ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
import { formatDateTime } from "@/lib/format";
import { inviteChoiceToInput, USER_INVITE_STATUS_LABEL, USER_INVITE_TTL_DAYS, type UserInviteStatus } from "@/lib/users/invite-shared";
import { cn } from "@/lib/utils";

export type InviteRoleOption = { code: string; name: string; hint: string };

export type InviteRow = {
  id: string;
  email: string;
  roleLabel: string;
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  status: UserInviteStatus;
};

const STATUS_TONE: Record<UserInviteStatus, string> = {
  ACTIVE: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  ACCEPTED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  EXPIRED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  REVOKED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Nút + hộp thoại tạo lời mời. Sau khi tạo, hộp thoại chuyển sang hiện liên kết + nút sao chép. */
/** `appName`: tên phần mềm trong câu chữ — ERP «ERP» (chữ cũ, từng ký tự), vỏ Chốt Đơn «Chốt Đơn». */
export function InviteUserDialog({ customRoles, appName = "ERP" }: { customRoles: InviteRoleOption[]; appName?: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [choice, setChoice] = useState<string>("role:VIEWER");
  const [created, setCreated] = useState<{ link: string; expiresAt: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setEmail("");
      setChoice("role:VIEWER");
      setCreated(null);
      setCopied(false);
    }
  }, [open]);

  const hint = choice.startsWith("role:") ? (ROLE_HINT[choice.slice(5) as keyof typeof ROLE_HINT] ?? "") : (customRoles.find((r) => `access:${r.code}` === choice)?.hint ?? "");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const role = inviteChoiceToInput(choice);
    if (!role) {
      toast.error("Chọn vai trò");
      return;
    }
    startTransition(async () => {
      const result = await createUserInviteAction({ email, ...role });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setCreated({ link: result.link, expiresAt: result.expiresAt, email: result.email });
    });
  };

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Đã sao chép liên kết mời");
    } catch {
      toast.error("Trình duyệt không cho sao chép — chọn liên kết rồi sao chép tay.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <MailPlus className="size-4" /> Mời người dùng
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Liên kết mời cho {created.email}</DialogTitle>
              <DialogDescription>
                Gửi liên kết này cho nhân viên qua kênh của bạn (Zalo, email, tin nhắn…) — {appName} chưa tự gửi thư. Người nhận mở liên kết, tự đặt tên và mật khẩu, rồi vào thẳng {appName} với đúng vai trò đã chọn.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input readOnly value={created.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" aria-label="Liên kết mời" />
                <Button type="button" onClick={() => copy(created.link)}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? "Đã chép" : "Sao chép"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Hết hạn lúc <b>{formatDateTime(created.expiresAt)}</b>, dùng được một lần. Liên kết chỉ hiện <b>một lần</b> ở đây — lạc mất thì thu hồi lời mời trong danh sách rồi mời lại.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                Xong
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Mời người dùng</DialogTitle>
              <DialogDescription>Nhập email và chọn vai trò. {appName} tạo một liên kết dùng một lần, hạn {USER_INVITE_TTL_DAYS} ngày — nhân viên tự đặt mật khẩu, bạn không phải biết mật khẩu của họ.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email của người được mời</Label>
              <Input id="invite-email" type="email" required placeholder="ten@congty.vn" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Vai trò</Label>
              <Select value={choice} onValueChange={setChoice}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Chọn vai trò" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Vai trò hệ thống</SelectLabel>
                    {ROLE_ORDER.map((r) => (
                      <SelectItem key={r} value={`role:${r}`}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {customRoles.length ? (
                    <SelectGroup>
                      <SelectLabel>Vai trò tuỳ chỉnh</SelectLabel>
                      {customRoles.map((r) => (
                        <SelectItem key={r.code} value={`access:${r.code}`}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending || !email.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                Tạo liên kết mời
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Danh sách lời mời: trạng thái, người mời, hạn; lời mời còn hạn thu hồi được. */
export function InvitesPanel({ invites }: { invites: InviteRow[] }) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const revoke = (row: InviteRow) => {
    setBusyId(row.id);
    startTransition(async () => {
      const result = await revokeUserInviteAction(row.id);
      setBusyId(null);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Đã thu hồi lời mời ${row.email}`);
    });
  };

  if (!invites.length) {
    return <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa có lời mời nào. Bấm «Mời người dùng» ở đầu trang để tạo liên kết cho nhân viên tự đặt mật khẩu.</p>;
  }
  return (
    <ul className="divide-y rounded-lg border">
      {invites.map((r) => (
        <li key={r.id} className={cn("flex flex-wrap items-center gap-3 p-3", r.status !== "ACTIVE" && "opacity-70")}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{r.email}</span>
              <span className={cn("rounded px-1.5 text-[10.5px] font-semibold", STATUS_TONE[r.status])}>{USER_INVITE_STATUS_LABEL[r.status]}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {r.roleLabel} · mời bởi {r.invitedByEmail ?? "—"} lúc {formatDateTime(r.createdAt)} ·{" "}
              {r.status === "ACCEPTED" ? `nhận lúc ${formatDateTime(r.acceptedAt)}` : `hạn ${formatDateTime(r.expiresAt)}`}
            </div>
          </div>
          {r.status === "ACTIVE" ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => revoke(r)}>
              {busyId === r.id ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
              Thu hồi
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
