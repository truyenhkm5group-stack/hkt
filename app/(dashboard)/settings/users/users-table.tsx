"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, Lock, LockOpen, MoreHorizontal, Pencil } from "lucide-react";
import { toast } from "sonner";
import { EditUserDialog, ResetPasswordDialog } from "@/app/(dashboard)/settings/users/user-dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { setUserActive } from "@/lib/actions/users";
import { ROLE_LABEL, ROLE_TONE } from "@/lib/constants/roles";
import { formatDateTime, formatTimeAgo, initials } from "@/lib/format";
import type { UserRow } from "@/lib/queries/users";
import { cn } from "@/lib/utils";

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

function UserRowActions({ user, isSelf, isLastAdmin }: { user: UserRow; isSelf: boolean; isLastAdmin: boolean }) {
  const [editOpen, setEditOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const canLock = !isSelf && !(user.active && isLastAdmin);

  const toggleActive = () => {
    startTransition(async () => {
      const result = await setUserActive({ id: user.id, active: !user.active });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(user.active ? `Đã khoá ${user.email}` : `Đã mở khoá ${user.email}`);
      setLockOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Thao tác">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil className="size-4" /> Sửa
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setResetOpen(true)}>
            <KeyRound className="size-4" /> Đặt lại mật khẩu
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setLockOpen(true)} disabled={!canLock} className={user.active ? "text-destructive focus:text-destructive" : ""}>
            {user.active ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
            {user.active ? "Khoá tài khoản" : "Mở khoá"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditUserDialog user={user} open={editOpen} onOpenChange={setEditOpen} isSelf={isSelf} />
      <ResetPasswordDialog user={user} open={resetOpen} onOpenChange={setResetOpen} />
      <AlertDialog open={lockOpen} onOpenChange={setLockOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{user.active ? "Khoá tài khoản?" : "Mở khoá tài khoản?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {user.active ? (
                <>
                  <strong>{user.name}</strong> ({user.email}) sẽ không đăng nhập được nữa và bị đăng xuất ở lần tải trang tiếp theo. Lịch sử thao tác vẫn được giữ.
                </>
              ) : (
                <>
                  <strong>{user.name}</strong> ({user.email}) sẽ đăng nhập lại được với mật khẩu hiện có.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              className={user.active ? "bg-destructive text-white hover:bg-destructive/90" : ""}
              onClick={(e) => {
                e.preventDefault();
                toggleActive();
              }}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {user.active ? "Khoá" : "Mở khoá"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function UsersTable({ users, currentUserId, activeAdmins }: { users: UserRow[]; currentUserId: string; activeAdmins: number }) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[820px]">
        <TableHeader className="bg-muted/50">
          <TableRow className="hover:bg-transparent">
            {["Người dùng", "Email", "Vai trò", "Trạng thái", "Đăng nhập gần nhất", "Tạo lúc", ""].map((h, i) => (
              <TableHead key={i} className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const isSelf = u.id === currentUserId;
            const isLastAdmin = u.role === "ADMIN" && u.active && activeAdmins <= 1;
            return (
              <TableRow key={u.id} className={cn(!u.active && "opacity-60")}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8 rounded-lg">
                      <AvatarFallback className={cn("rounded-lg text-xs font-bold", u.active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{initials(u.name) || "U"}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-semibold">{u.name}</span>
                        {isSelf ? <span className="rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">Bạn</span> : null}
                      </div>
                      {isLastAdmin ? <div className="text-[10.5px] text-muted-foreground">Quản trị viên duy nhất</div> : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm">{u.email}</TableCell>
                <TableCell>
                  <span className={cn(badge, ROLE_TONE[u.role])}>{ROLE_LABEL[u.role]}</span>
                </TableCell>
                <TableCell>
                  {u.active ? (
                    <span className={cn(badge, "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300")}>
                      <span className="size-1.5 rounded-full bg-current opacity-70" /> Đang hoạt động
                    </span>
                  ) : (
                    <span className={cn(badge, "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")}>
                      <Lock className="size-3" /> Đã khoá
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {u.lastLoginAt ? (
                    <>
                      <div>{formatDateTime(u.lastLoginAt)}</div>
                      <div className="text-[10.5px]">{formatTimeAgo(u.lastLoginAt)}</div>
                    </>
                  ) : (
                    "Chưa đăng nhập"
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDateTime(u.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <UserRowActions user={u} isSelf={isSelf} isLastAdmin={isLastAdmin} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
