"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { createUser, resetUserPassword, updateUser } from "@/lib/actions/users";
import { ROLE_HINT, ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
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

/** Dialog thêm người dùng (tự quản lý trạng thái, hiện nút “Thêm người dùng”) */
export function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const form = useForm<CreateUserInput>({ resolver: zodResolver(createUserSchema), defaultValues: { name: "", email: "", password: "", role: "VIEWER" } });

  useEffect(() => {
    if (open) form.reset({ name: "", email: "", password: "", role: "VIEWER" });
  }, [open, form]);

  const submit = (values: CreateUserInput) => {
    startTransition(async () => {
      const result = await createUser(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Đã tạo tài khoản ${values.email}`);
      setOpen(false);
      router.refresh();
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
export function EditUserDialog({ user, open, onOpenChange, isSelf }: { user: UserRow; open: boolean; onOpenChange: (open: boolean) => void; isSelf: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const form = useForm<UpdateUserInput>({ resolver: zodResolver(updateUserSchema), defaultValues: { id: user.id, name: user.name, role: user.role, active: user.active } });

  useEffect(() => {
    if (open) form.reset({ id: user.id, name: user.name, role: user.role, active: user.active });
  }, [open, user, form]);

  const submit = (values: UpdateUserInput) => {
    startTransition(async () => {
      const result = await updateUser(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Đã cập nhật người dùng");
      onOpenChange(false);
      router.refresh();
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
            Mật khẩu mới cho <strong>{user.name}</strong> ({user.email}). Phiên đăng nhập hiện tại của người này vẫn còn hiệu lực tới khi hết hạn.
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
