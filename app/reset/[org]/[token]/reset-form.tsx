"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completePasswordResetAction } from "@/lib/actions/password-reset";
import { ADMIN_PASSWORD_MIN } from "@/lib/onboarding/shared";
import { completeResetSchema } from "@/lib/users/password-reset-shared";

/**
 * Form đặt mật khẩu mới: kiểm bằng CÙNG lược đồ với máy chủ (`completeResetSchema`) để báo lỗi ngay; máy chủ vẫn kiểm
 * lại. Thành công ⇒ action chuyển về `/login` với câu «Đã đổi mật khẩu» (không tự đăng nhập).
 */
export function ResetForm({ org, token, email }: { org: string; token: string; email: string }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = { password, confirmPassword };
    const parsed = completeResetSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await completePasswordResetAction(org, token, input);
      // Thành công thì action đã chuyển trang; tới được đây là có lỗi.
      if (result?.error) setError(result.error);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="reset-email">Email</Label>
        <Input id="reset-email" value={email} readOnly disabled autoComplete="username" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reset-password">Mật khẩu mới</Label>
        <Input id="reset-password" type="password" required autoComplete="new-password" placeholder={`Ít nhất ${ADMIN_PASSWORD_MIN} ký tự`} value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reset-confirm">Nhập lại mật khẩu mới</Label>
        <Input id="reset-confirm" type="password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
        Đặt mật khẩu mới
      </Button>
    </form>
  );
}
