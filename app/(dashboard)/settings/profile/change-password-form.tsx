"use client";

import { useTransition } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { changeMyPassword } from "@/lib/actions/users";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/validation/users";

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const form = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema), defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" } });

  const submit = (values: ChangePasswordInput) => {
    startTransition(async () => {
      const result = await changeMyPassword(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Đã đổi mật khẩu. Hãy dùng mật khẩu mới ở lần đăng nhập tới.");
      form.reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="max-w-sm space-y-4">
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mật khẩu hiện tại</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mật khẩu mới</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormDescription className="text-xs">Tối thiểu 8 ký tự, nên kết hợp chữ hoa, chữ thường và số.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nhập lại mật khẩu mới</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          Đổi mật khẩu
        </Button>
      </form>
    </Form>
  );
}
