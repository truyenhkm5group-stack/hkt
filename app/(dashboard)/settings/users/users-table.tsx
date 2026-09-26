"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2, Lock, LockOpen, LogOut, MoreHorizontal, Pencil, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PermissionsDialog } from "@/app/(dashboard)/settings/users/permissions-dialog";
import { RevokeSessionsDialog } from "@/app/(dashboard)/settings/users/revoke-sessions-dialog";
import { EditUserDialog, ResetPasswordDialog } from "@/app/(dashboard)/settings/users/user-dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { setUserActive } from "@/lib/actions/users";
import { PERMISSION_LABEL, type RolePermissionMap } from "@/lib/auth/permissions";
import { ROLE_LABEL, ROLE_TONE } from "@/lib/constants/roles";
import { formatDateTime, formatTimeAgo, initials } from "@/lib/format";
import type { UserRow } from "@/lib/queries/users";
import { DepartmentCell, type UserDept } from "@/app/(dashboard)/settings/users/department-cell";
import { AccessCell, type AccessOption, type UserAccessView } from "@/app/(dashboard)/settings/users/access-cell";
import { cn } from "@/lib/utils";

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

function UserRowActions({ user, isSelf, isLastAdmin, templates }: { user: UserRow; isSelf: boolean; isLastAdmin: boolean; templates: RolePermissionMap }) {
  const [editOpen, setEditOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [pending, startTransition] = useTransition();
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
          <DropdownMenuItem onSelect={() => setPermOpen(true)}>
            <ShieldCheck className="size-4" /> Phân quyền
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setResetOpen(true)}>
            <KeyRound className="size-4" /> Đặt lại mật khẩu
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/*
            THU HỒI PHIÊN ĐỨNG RIÊNG KHỎI KHOÁ TÀI KHOẢN. Hai việc khác hẳn nhau: thu hồi là "máy
            bị mất, tài khoản vẫn tốt"; khoá là "người này không được dùng ERP nữa". Gộp chúng vào
            một nút thì quản trị phải khoá một người chỉ để đá họ ra khỏi một cái điện thoại.
          */}
          <DropdownMenuItem onSelect={() => setRevokeOpen(true)}>
            <LogOut className="size-4" /> Thu hồi phiên
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLockOpen(true)} disabled={!canLock} className={user.active ? "text-destructive focus:text-destructive" : ""}>
            {user.active ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
            {user.active ? "Khoá tài khoản" : "Mở khoá"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditUserDialog user={user} open={editOpen} onOpenChange={setEditOpen} isSelf={isSelf} />
      <PermissionsDialog user={user} templates={templates} open={permOpen} onOpenChange={setPermOpen} />
      <ResetPasswordDialog user={user} open={resetOpen} onOpenChange={setResetOpen} />
      <RevokeSessionsDialog user={user} open={revokeOpen} onOpenChange={setRevokeOpen} />
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

export function UsersTable({
  users,
  currentUserId,
  activeAdmins,
  templates,
  departmentsByUser,
  allDepartments,
  accessByUser,
  roleOptions,
  positionOptions,
}: {
  users: UserRow[];
  currentUserId: string;
  activeAdmins: number;
  templates: RolePermissionMap;
  departmentsByUser: Record<string, UserDept[]>;
  allDepartments: { id: string; name: string }[];
  accessByUser: Record<string, UserAccessView>;
  roleOptions: AccessOption[];
  positionOptions: AccessOption[];
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[1240px]">
        <TableHeader className="bg-muted/50">
          <TableRow className="hover:bg-transparent">
            {["Người dùng", "Email", "Vai trò", "Phòng ban", "Quyền & phạm vi", "Trạng thái", "Đăng nhập gần nhất", "Tạo lúc", ""].map((h, i) => (
              <TableHead key={i} className="h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={12} className="h-24 text-center text-sm text-muted-foreground">Không có tài khoản nào khớp bộ lọc.</TableCell>
            </TableRow>
          ) : null}
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
                  {Array.isArray(u.permissions) ? (
                    <div className="mt-1 max-w-[260px] truncate text-[10.5px] text-muted-foreground" title={u.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(", ")}>
                      Tuỳ chỉnh · {u.permissions.length} quyền
                    </div>
                  ) : null}
                </TableCell>
                {/*
                  PHÒNG BAN SỬA ĐƯỢC NGAY TỪ ĐÂY — cùng Server Action với màn Cấu hình công việc.
                  Một sự thật, hai lối vào; trước đây chỉ có một lối và khi nó hỏng thì hết đường.
                */}
                <TableCell>
                  <DepartmentCell
                    userId={u.id}
                    userName={u.name}
                    userActive={u.active}
                    departments={departmentsByUser[u.id] ?? []}
                    all={allDepartments}
                  />
                </TableCell>
                {/*
                  BA CHIỀU CỦA QUYỀN TRUY CẬP trong một ô: vai trò (được làm gì) · chức danh (làm
                  chức gì) · phạm vi (trên dữ liệu nào). Bấm vào mở hộp thoại có XEM TRƯỚC quyền
                  thực tế — chủ shop thấy hậu quả trước khi lưu, không phải sau.
                */}
                <TableCell>
                  <AccessCell
                    userId={u.id}
                    userName={u.name}
                    isAdmin={u.role === "ADMIN"}
                    view={accessByUser[u.id] ?? { accessRoleId: null, accessRoleName: "", positionId: null, positionName: "", scope: "ALL" }}
                    roles={roleOptions}
                    positions={positionOptions}
                  />
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
                  <UserRowActions user={u} isSelf={isSelf} isLastAdmin={isLastAdmin} templates={templates} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
