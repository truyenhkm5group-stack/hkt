"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2, MessageCircle } from "lucide-react";
import { forgotPasswordAction, type ForgotState } from "@/lib/actions/forgot-password";
import { BrandLockup } from "@/components/brand";
import type { SiteBrand } from "@/lib/platform/site-host";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Form «Quên mật khẩu» — hai bước trên MỘT form (ô có điều khiển: React xoá form sau mỗi lượt gửi, mà bước nhập mã phải gửi lại
 * đúng email / SĐT + mã cửa hàng vừa gõ). Nút đầu tiên của mỗi bước là nút Enter bấm.
 */
export function ForgotForm({
  brand,
  orgName,
  showOrgField,
  otpOn,
  support,
}: {
  brand: SiteBrand;
  orgName: string | null;
  showOrgField: boolean;
  otpOn: boolean;
  support: { zalo: string; zaloHref: string } | null;
}) {
  const [state, action, pending] = useActionState<ForgotState, FormData>(forgotPasswordAction, undefined);
  const [identifier, setIdentifier] = useState("");
  const [org, setOrg] = useState("");
  const [code, setCode] = useState("");
  const codeStep = Boolean(state?.otp);

  return (
    <div className="w-full max-w-sm space-y-6">
      <BrandLockup className="justify-center" wordmarkClassName="text-lg" brand={brand} />
      <Card className="border-border/60 shadow-xl shadow-black/5">
        <CardHeader className="space-y-1">
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </div>
          <CardTitle className="text-xl">Quên mật khẩu</CardTitle>
          <CardDescription>
            {otpOn
              ? "Nhập email hoặc số điện thoại của tài khoản. Chúng tôi gửi mã xác minh qua Zalo tới số điện thoại của tài khoản để bạn tự đặt mật khẩu mới."
              : orgName
                ? `Nhập email hoặc số điện thoại của tài khoản. Yêu cầu sẽ được chuyển tới người quản trị ERP của ${orgName}.`
                : "Nhập email hoặc số điện thoại của tài khoản. Yêu cầu sẽ được chuyển tới người quản trị cửa hàng và bộ phận hỗ trợ."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={action} className="space-y-4" data-forgot-form>
            <div className="space-y-2">
              <Label htmlFor="identifier">Email hoặc số điện thoại</Label>
              <Input
                id="identifier"
                name="identifier"
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
            {showOrgField ? (
              <div className="space-y-2">
                <Label htmlFor="org">Mã cửa hàng</Label>
                <Input id="org" name="org" type="text" autoComplete="organization" placeholder="Bỏ trống để tự tìm" autoCapitalize="none" spellCheck={false} value={org} onChange={(e) => setOrg(e.target.value)} />
              </div>
            ) : null}

            {state?.message ? (
              <p className="rounded-lg border bg-muted/40 p-3 text-sm leading-6" role="status" data-forgot-message>
                {state.message}
              </p>
            ) : null}

            {codeStep ? (
              <div className="space-y-2">
                <Label htmlFor="code">Mã xác minh (6 số)</Label>
                <Input
                  id="code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  maxLength={7}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center font-mono text-lg tracking-[0.4em]"
                />
              </div>
            ) : null}

            {state?.choose ? (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3" data-forgot-choose>
                <p className="text-sm font-medium">Số này có tài khoản ở nhiều cửa hàng — đặt lại mật khẩu ở cửa hàng nào?</p>
                {state.choose.map((o) => (
                  <Button key={o.code} type="submit" name="pick" value={o.code} variant="outline" className="w-full justify-start" disabled={pending}>
                    {o.name}
                  </Button>
                ))}
              </div>
            ) : null}

            {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

            {codeStep ? (
              <div className="space-y-2">
                <Button type="submit" name="intent" value="verify" className="w-full" disabled={pending || code.replace(/\D/g, "").length !== 6}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Xác minh và đặt mật khẩu mới
                </Button>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Button type="submit" name="intent" value="send" variant="link" className="h-auto p-0" disabled={pending}>
                    Gửi lại mã
                  </Button>
                  <Button type="submit" name="intent" value="support" variant="link" className="h-auto p-0 text-muted-foreground" disabled={pending}>
                    Không nhận được mã? Gửi yêu cầu hỗ trợ
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="submit" name="intent" value="send" className="w-full" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                {state?.message ? "Gửi lại" : otpOn ? "Gửi mã qua Zalo" : "Gửi yêu cầu hỗ trợ"}
              </Button>
            )}
          </form>

          {support ? (
            <a href={support.zaloHref} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-lg border p-3 text-sm hover:bg-muted/50" data-forgot-zalo>
              <MessageCircle className="size-4 shrink-0 text-primary" aria-hidden />
              <span>
                Cần giúp ngay? Nhắn Zalo hỗ trợ <b className="whitespace-nowrap">{support.zalo}</b>
              </span>
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">Cần giúp ngay? Liên hệ người quản trị ERP của cửa hàng bạn.</p>
          )}

          <p className="text-center text-sm text-muted-foreground">
            Nhớ ra rồi?{" "}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Đăng nhập
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
