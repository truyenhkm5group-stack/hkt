"use client";

import { useActionState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { loginAction, type LoginState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ next, reason }: { next?: string; reason?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, undefined);

  return (
    <Card className="w-full max-w-sm border-border/60 shadow-xl shadow-black/5">
      <CardHeader className="space-y-1">
        <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LockKeyhole className="size-5" />
        </div>
        <CardTitle className="text-xl">Đăng nhập</CardTitle>
        <CardDescription>Dùng tài khoản nội bộ do quản trị viên cấp.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <input type="hidden" name="next" value={next ?? "/"} />
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="username" placeholder="ban@shop.vn" required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mật khẩu</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {reason === "inactive" ? <p className="text-sm text-destructive">Tài khoản đã bị khoá hoặc không tồn tại.</p> : null}
          {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Đăng nhập
          </Button>
          <p className="text-center text-xs text-muted-foreground">Tài khoản mặc định lấy từ ADMIN_EMAIL / ADMIN_PASSWORD trong file .env</p>
        </form>
      </CardContent>
    </Card>
  );
}
