"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Loader2, LockKeyhole } from "lucide-react";
import { loginAction, type LoginState } from "@/lib/actions/auth";
import { BrandLockup } from "@/components/brand";
import type { SiteBrand } from "@/lib/platform/site-host";
import { OrDivider, SocialButtons } from "@/components/auth/social-buttons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { denyReasonMessage } from "@/lib/constants/session-revocation";

const OAUTH_MESSAGE: Record<string, string> = {
  off: "Cách đăng nhập này chưa được bật.",
  failed: "Không đăng nhập được bằng tài khoản đó — thử lại hoặc dùng email / số điện thoại.",
  disabled: "Tài khoản đã bị khoá. Liên hệ quản trị viên.",
};

export function LoginForm({
  next,
  reason,
  oauth,
  showOrgField = false,
  showSetupHint = true,
  orgName = null,
  providers = { google: false, facebook: false },
  signupOpen = false,
  brand = "vnx",
}: {
  next?: string;
  reason?: string;
  oauth?: string;
  showOrgField?: boolean;
  showSetupHint?: boolean;
  orgName?: string | null;
  providers?: { google: boolean; facebook: boolean };
  signupOpen?: boolean;
  brand?: SiteBrand;
}) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, undefined);
  // Ô có điều khiển: React xoá form sau mỗi lượt gửi, mà bước «chọn cửa hàng» phải gửi lại đúng email + mật khẩu vừa gõ.
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const social = !orgName && (providers.google || providers.facebook);
  // Host Chốt Đơn ⇒ câu nhắc chỗ gia hạn chỉ «trang Gói dịch vụ» (vỏ không có menu «Hệ thống»); ERP giữ nguyên câu cũ.
  const reasonText = denyReasonMessage(reason, { shell: brand === "chotdon" });

  return (
    <div className="w-full max-w-sm space-y-6">
      {/* Cột trái có logo nhưng bị ẩn dưới lg — màn hình nhỏ vẫn phải thấy thương hiệu */}
      <BrandLockup className="justify-center lg:hidden" wordmarkClassName="text-lg" brand={brand} />
      <Card className="border-border/60 shadow-xl shadow-black/5">
        <CardHeader className="space-y-1">
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <LockKeyhole className="size-5" />
          </div>
          <CardTitle className="text-xl">Đăng nhập</CardTitle>
          <CardDescription>{orgName ? `ERP của ${orgName} — dùng tài khoản do quản trị của bạn cấp hoặc mời.` : "Dùng email hoặc số điện thoại của bạn."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {social ? (
            <>
              <SocialButtons providers={providers} intent="login" next={next} />
              <OrDivider label="hoặc" />
            </>
          ) : null}
          <form action={action} className="space-y-4">
            <input type="hidden" name="next" value={next ?? "/"} />
            <div className="space-y-2">
              <Label htmlFor="email">Email hoặc số điện thoại</Label>
              <Input
                id="email"
                name="email"
                type="text"
                inputMode="email"
                autoComplete="username"
                placeholder="ban@shop.vn hoặc 0912 345 678"
                required
                autoFocus
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="password">Mật khẩu</Label>
                {/* PUB-07: người quên mật khẩu từng không có nút nào để bấm — /forgot gửi mã Zalo hoặc chuyển yêu cầu tới quản trị. */}
                <Link href="/forgot" className="text-xs font-medium text-primary hover:underline" data-login-forgot>
                  Quên mật khẩu?
                </Link>
              </div>
              <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {state?.choose ? (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3" data-login-choose>
                <p className="text-sm font-medium">Tài khoản này có ở nhiều cửa hàng — vào cửa hàng nào?</p>
                {state.choose.map((o) => (
                  <Button key={o.code} type="submit" name="org" value={o.code} variant="outline" className="w-full justify-start" disabled={pending}>
                    {o.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {showOrgField ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground">Đăng nhập bằng mã tổ chức</summary>
                <div className="mt-2 space-y-2">
                  <Label htmlFor="org">Mã tổ chức</Label>
                  <Input id="org" name="org" type="text" autoComplete="organization" placeholder="Bỏ trống để tự tìm" autoCapitalize="none" spellCheck={false} />
                </div>
              </details>
            ) : null}
            {reasonText ? <p className="text-sm text-destructive">{reasonText}</p> : null}
            {oauth && OAUTH_MESSAGE[oauth] ? <p className="text-sm text-destructive">{OAUTH_MESSAGE[oauth]}</p> : null}
            {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Đăng nhập
            </Button>
            {showSetupHint ? <p className="text-center text-xs text-muted-foreground">Tài khoản mặc định lấy từ ADMIN_EMAIL / ADMIN_PASSWORD trong file .env</p> : null}
          </form>
          {signupOpen && !orgName ? (
            <p className="text-center text-sm text-muted-foreground">
              Chưa có cửa hàng?{" "}
              <Link href="/start" className="font-medium text-primary hover:underline">
                Tạo miễn phí
              </Link>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
