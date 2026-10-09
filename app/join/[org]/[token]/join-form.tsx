"use client";

import { useState, useTransition } from "react";
import { Loader2, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptUserInviteAction } from "@/lib/actions/user-invites";
import { ADMIN_PASSWORD_MIN } from "@/lib/onboarding/shared";
import { acceptUserInviteSchema } from "@/lib/users/invite-shared";

/**
 * Form nhận lời mời: tên + mật khẩu + nhập lại. Kiểm bằng CÙNG lược đồ với máy chủ (`acceptUserInviteSchema`) để báo
 * lỗi ô nhập ngay; máy chủ vẫn kiểm lại. Thành công ⇒ action chuyển thẳng vào `/` với phiên của tài khoản mới.
 */
/** `chotdon`: host Chốt Đơn (máy chủ đọc từ host) — chỉ đổi chữ của nút. */
export function JoinForm({ org, token, email, chotdon = false }: { org: string; token: string; email: string; chotdon?: boolean }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = { name, password, confirmPassword };
    const parsed = acceptUserInviteSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await acceptUserInviteAction(org, token, input);
      // Thành công thì action đã chuyển trang; tới được đây là có lỗi.
      if (result?.error) setError(result.error);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="join-email">Email</Label>
        <Input id="join-email" value={email} readOnly disabled autoComplete="username" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="join-name">Họ tên</Label>
        <Input id="join-name" required placeholder="Nguyễn Văn A" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="join-password">Mật khẩu</Label>
        <Input id="join-password" type="password" required autoComplete="new-password" placeholder={`Ít nhất ${ADMIN_PASSWORD_MIN} ký tự`} value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="join-confirm">Nhập lại mật khẩu</Label>
        <Input id="join-confirm" type="password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <UserCheck className="size-4" />}
        {chotdon ? "Tạo tài khoản và vào ứng dụng" : "Tạo tài khoản và vào ERP"}
      </Button>
    </form>
  );
}
