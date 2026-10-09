"use client";

import { useEffect, useState, useTransition } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, UserPlus } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { setUserAccess } from "@/lib/actions/access";
import { createUser, resetUserPassword, updateUser } from "@/lib/actions/users";
import { ROLE_HINT, ROLE_LABEL, ROLE_ORDER, SHELL_ROLE_HINT, SHELL_ROLE_LABEL, SHELL_ROLE_SYSTEM_ROLE, SHELL_SALES_STAFF_MISSING_NOTE, shellRoleKeyOf, shellRoleKeys, type ShellRoleKey } from "@/lib/constants/roles";
import type { UserRow } from "@/lib/queries/users";
import { createUserSchema, updateUserSchema, type CreateUserInput, type UpdateUserInput } from "@/lib/validation/users";
import { z } from "zod";

function RoleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <FormControl>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Chọn vai trò" />
        </SelectTrigger>
      </FormControl>
      <SelectContent>
        {ROLE_ORDER.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABEL[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * VỎ CHỐT ĐƠN: ô chọn ĐÚNG ba lựa chọn (lib/constants/roles.ts). `salesRoleId` = vai trò `BAN_HANG` đang bật của tổ chức;
 * `null` ⇒ chỉ Chủ cửa hàng + Chỉ xem kèm một câu báo — không bao giờ thay bằng vai trò khác. ERP không truyền prop này.
 */
export type ShellRolePicker = { salesRoleId: string | null };

function ShellRoleSelect({ picker, value, onChange, legacyLabel }: { picker: ShellRolePicker; value: ShellRoleKey | null; onChange: (v: ShellRoleKey) => void; legacyLabel?: string }) {
  return (
    <>
      <Select value={value ?? ""} onValueChange={(v) => onChange(v as ShellRoleKey)}>
        <SelectTrigger className="w-full" aria-label="Vai trò">
          <SelectValue placeholder={legacyLabel ? `Vai trò cũ: ${legacyLabel} — chọn lại` : "Chọn vai trò"} />
        </SelectTrigger>
        <SelectContent>
          {shellRoleKeys(Boolean(picker.salesRoleId)).map((k) => (
            <SelectItem key={k} value={k}>
              {SHELL_ROLE_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{value ? SHELL_ROLE_HINT[value] : ""}</p>
      {picker.salesRoleId ? null : <p className="text-xs text-amber-700 dark:text-amber-300">{SHELL_SALES_STAFF_MISSING_NOTE}</p>}
    </>
  );
}

/**
 * Ghi lựa chọn của vỏ bằng HAI action có sẵn, mỗi cái giữ cổng của nó: `users.role` qua `createUser` / `updateUser`, vai trò
 * tuỳ chỉnh qua `setUserAccess`. Thứ tự tránh hai lời từ chối đã có: quản trị viên không mang vai trò tuỳ chỉnh (gỡ trước khi
 * lên ADMIN), và quản trị viên cuối cùng không bị hạ (đổi vai trò hệ thống trước khi gán vai trò bán hàng).
 */
async function applyShellAccess(userId: string, key: ShellRoleKey, picker: ShellRolePicker, keep: { positionId: string | null; scope: string }): Promise<{ error: string } | null> {
  const accessRoleId = key === "SALES" ? (picker.salesRoleId ?? "") : "";
  const r = await setUserAccess({ userId, accessRoleId, positionId: keep.positionId ?? "", scope: key === "OWNER" ? "ALL" : keep.scope });
  return "error" in r ? { error: r.error } : null;
}

/** Dialog thêm người dùng (tự quản lý trạng thái, hiện nút “Thêm người dùng”) */
export function CreateUserDialog({ shell }: { shell?: ShellRolePicker } = {}) {
  const [shellKey, setShellKey] = useState<ShellRoleKey>("VIEWER");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<CreateUserInput>({ resolver: zodResolver(createUserSchema), defaultValues: { name: "", email: "", password: "", role: "VIEWER" } });

  useEffect(() => {
    if (open) {
      form.reset({ name: "", email: "", password: "", role: "VIEWER" });
      setShellKey("VIEWER");
    }
  }, [open, form]);

  const submit = (values: CreateUserInput) => {
    startTransition(async () => {
      const result = await createUser(shell ? { ...values, role: SHELL_ROLE_SYSTEM_ROLE[shellKey] } : values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (shell && shellKey === "SALES" && result.id) {
        const access = await applyShellAccess(result.id, "SALES", shell, { positionId: null, scope: "ALL" });
        if (access) {
          toast.error(`Đã tạo tài khoản ${values.email} nhưng chưa gán được «${SHELL_ROLE_LABEL.SALES}»: ${access.error}`);
          setOpen(false);
          return;
        }
      }
      toast.success(`Đã tạo tài khoản ${values.email}`);
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="size-4" /> Thêm người dùng
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Thêm người dùng</DialogTitle>
          <DialogDescription>Tài khoản đăng nhập nội bộ. Hãy gửi mật khẩu cho nhân viên và yêu cầu đổi sau lần đăng nhập đầu.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Họ tên</FormLabel>
                  <FormControl>
                    <Input placeholder="Nguyễn Văn A" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email đăng nhập</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="ten@shop.vn" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mật khẩu</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" placeholder="Tối thiểu 8 ký tự" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {shell ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Vai trò</p>
                <ShellRoleSelect picker={shell} value={shellKey} onChange={setShellKey} />
              </div>
            ) : (
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vai trò</FormLabel>
                    <RoleSelect value={field.value} onChange={field.onChange} />
                    <FormDescription className="text-xs">{ROLE_HINT[field.value] ?? ""}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Tạo tài khoản
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog sửa tên / vai trò / trạng thái (điều khiển từ ngoài) */
export function EditUserDialog({
  user,
  open,
  onOpenChange,
  isSelf,
  shell,
  access,
}: {
  user: UserRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSelf: boolean;
  /** Vỏ Chốt Đơn: ô vai trò ba lựa chọn (ERP không truyền). */
  shell?: ShellRolePicker;
  /** Vai trò tuỳ chỉnh / chức danh / phạm vi hiện tại — vỏ giữ nguyên chức danh + phạm vi khi đổi vai trò. */
  access?: { accessRoleId: string | null; positionId: string | null; scope: string };
}) {
  const [pending, startTransition] = useTransition();
  const currentShellKey = shell ? shellRoleKeyOf(user, access?.accessRoleId, shell.salesRoleId) : null;
  const [shellKey, setShellKey] = useState<ShellRoleKey | null>(currentShellKey);
  const form = useForm<UpdateUserInput>({ resolver: zodResolver(updateUserSchema), defaultValues: { id: user.id, name: user.name, role: user.role, active: user.active } });

  useEffect(() => {
    if (open) {
      form.reset({ id: user.id, name: user.name, role: user.role, active: user.active });
      setShellKey(currentShellKey);
    }
  }, [open, user, form, currentShellKey]);

  const submit = (values: UpdateUserInput) => {
    startTransition(async () => {
      if (shell) {
        if (!shellKey) {
          toast.error("Chọn vai trò");
          return;
        }
        const keep = { positionId: access?.positionId ?? null, scope: access?.scope ?? "ALL" };
        // Lên Chủ cửa hàng / về Chỉ xem: gỡ vai trò bán hàng TRƯỚC (quản trị viên không mang vai trò tuỳ chỉnh).
        if (shellKey !== "SALES" && access?.accessRoleId) {
          const unset = await applyShellAccess(user.id, shellKey, shell, keep);
          if (unset) {
            toast.error(unset.error);
            return;
          }
        }
        const updated = await updateUser({ ...values, role: SHELL_ROLE_SYSTEM_ROLE[shellKey] });
        if ("error" in updated) {
          toast.error(updated.error);
          return;
        }
        if (shellKey === "SALES" && access?.accessRoleId !== shell.salesRoleId) {
          const assign = await applyShellAccess(user.id, "SALES", shell, keep);
          if (assign) {
            toast.error(assign.error);
            return;
          }
        }
        toast.success("Đã cập nhật người dùng");
        onOpenChange(false);
        return;
      }
      const result = await updateUser(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Đã cập nhật người dùng");
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sửa người dùng</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Họ tên</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {shell ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Vai trò</p>
                <ShellRoleSelect picker={shell} value={shellKey} onChange={setShellKey} legacyLabel={currentShellKey ? undefined : ROLE_LABEL[user.role]} />
                {isSelf ? <p className="text-xs text-muted-foreground">Bạn không thể tự hạ quyền của chính mình.</p> : null}
              </div>
            ) : (
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vai trò</FormLabel>
                    <RoleSelect value={field.value} onChange={field.onChange} />
                    <FormDescription className="text-xs">{isSelf ? "Bạn không thể tự hạ quyền của chính mình." : ROLE_HINT[field.value] ?? ""}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <div>
                    <FormLabel>Đang hoạt động</FormLabel>
                    <FormDescription className="text-xs">{isSelf ? "Không thể tự khoá tài khoản của bạn." : "Tắt để khoá đăng nhập nhưng vẫn giữ lịch sử thao tác."}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} disabled={isSelf} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Lưu thay đổi
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const resetFormSchema = z
  .object({ password: z.string().min(8, "Mật khẩu tối thiểu 8 ký tự").max(100, "Mật khẩu tối đa 100 ký tự"), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Mật khẩu nhập lại không khớp" });
type ResetForm = z.infer<typeof resetFormSchema>;

/** Dialog đặt lại mật khẩu cho người dùng khác (điều khiển từ ngoài) */
export function ResetPasswordDialog({ user, open, onOpenChange }: { user: UserRow; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pending, startTransition] = useTransition();
  const form = useForm<ResetForm>({ resolver: zodResolver(resetFormSchema), defaultValues: { password: "", confirm: "" } });

  useEffect(() => {
    if (open) form.reset({ password: "", confirm: "" });
  }, [open, form]);

  const submit = (values: ResetForm) => {
    startTransition(async () => {
      const result = await resetUserPassword({ id: user.id, password: values.password });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Đã đặt lại mật khẩu cho ${user.email}`);
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Đặt lại mật khẩu</DialogTitle>
          <DialogDescription>
            Mật khẩu mới cho <strong>{user.name}</strong> ({user.email}). Mọi phiên đăng nhập hiện tại của người này bị đăng xuất. Muốn người này tự chọn mật khẩu thì dùng «Gửi liên kết đặt lại».
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mật khẩu mới</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nhập lại mật khẩu</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Đặt lại mật khẩu
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
