"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { OrDivider, SocialButtons } from "@/components/auth/social-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgetSocialSignupAction } from "@/lib/actions/oauth";
import { TRIAL_DAYS } from "@/lib/billing/rules";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { quickSignupAction } from "@/lib/actions/onboarding";
import { ADMIN_PASSWORD_MIN, QUICK_BUSINESS_LABEL, QUICK_BUSINESS_TYPES, type QuickBusinessType } from "@/lib/onboarding/quick-shared";
import { cn } from "@/lib/utils";

type Social = { provider: "google" | "facebook"; email: string | null; name: string | null } | null;

/**
 * ĐĂNG KÝ NHANH MỘT MÀN HÌNH (docs/platform/quick-start.md): tên cửa hàng · ngành hàng · SĐT · email · mật khẩu — hoặc
 * một nút Google / Facebook thay hai ô cuối. Máy tự chọn mã, mẫu, module; dựng xong vào thẳng ERP.
 */
export function QuickStart({ needInvite, initialInvite, providers, social }: { needInvite: boolean; initialInvite: string; providers: { google: boolean; facebook: boolean }; social: Social }) {
  const [storeName, setStoreName] = useState("");
  const [businessType, setBusinessType] = useState<QuickBusinessType>("food");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [invite, setInvite] = useState(initialInvite);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const needEmail = !social || !social.email;
  const needPassword = !social;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await quickSignupAction({ storeName, businessType, phone, email, password, invite: needInvite ? invite : null });
      if (r && "error" in r) setError(r.error);
    });
  };

  return (
    <div className="w-full max-w-md space-y-5" data-quick-start>
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-bold">Tạo cửa hàng của bạn</h1>
        <p className="text-sm text-muted-foreground">Khoảng 1 phút. Dùng thử miễn phí, chưa cần thanh toán.</p>
      </div>

      {social ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-social-profile={social.provider}>
          <span>
            Đăng ký bằng {social.provider === "google" ? "Google" : "Facebook"}
            {social.email ? <span className="font-medium">: {social.email}</span> : null}
          </span>
          <form action={forgetSocialSignupAction}>
            <button type="submit" className="text-xs text-muted-foreground underline">
              Đổi
            </button>
          </form>
        </div>
      ) : (
        <>
          <SocialButtons providers={providers} intent="signup" />
          {providers.google || providers.facebook ? <OrDivider label="hoặc dùng email" /> : null}
        </>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="qs-store">Tên cửa hàng</Label>
          <Input id="qs-store" value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="Hải Sản Làng Chài" maxLength={120} required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label>Bạn bán gì?</Label>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Ngành hàng">
            {QUICK_BUSINESS_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={businessType === t}
                onClick={() => setBusinessType(t)}
                data-business-type={t}
                className={cn("rounded-md border px-3 py-2 text-left text-sm transition-colors", businessType === t ? "border-primary bg-primary/5 font-medium ring-1 ring-primary" : "hover:bg-muted/50")}
              >
                {QUICK_BUSINESS_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qs-phone">Số điện thoại</Label>
          <Input id="qs-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0912 345 678" maxLength={30} required />
        </div>
        {needEmail ? (
          <div className="space-y-1.5">
            <Label htmlFor="qs-email">Email</Label>
            <Input id="qs-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ban@shop.vn" maxLength={200} required />
          </div>
        ) : null}
        {needPassword ? (
          <div className="space-y-1.5">
            <Label htmlFor="qs-password">Mật khẩu</Label>
            <div className="relative">
              <Input id="qs-password" type={showPw ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={ADMIN_PASSWORD_MIN} maxLength={200} required className="pr-10" />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground" aria-label={showPw ? "Ẩn mật khẩu" : "Hiện mật khẩu"}>
                {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Ít nhất {ADMIN_PASSWORD_MIN} ký tự. Đăng nhập lại bằng email hoặc số điện thoại.</p>
          </div>
        ) : null}
        {needInvite ? (
          <div className="space-y-1.5">
            <Label htmlFor="qs-invite">Mã mời</Label>
            <Input id="qs-invite" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXX" maxLength={80} required autoCapitalize="characters" spellCheck={false} />
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <Button type="submit" className="h-10 w-full" disabled={pending} data-quick-submit>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {pending ? "Đang dựng cửa hàng… (dưới 1 phút)" : "Tạo cửa hàng"}
        </Button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href="/login" className="text-primary hover:underline">
          Đã có tài khoản? Đăng nhập
        </Link>
        <Link href="/start?day-du=1" className="text-xs text-muted-foreground hover:underline">
          Tự chọn mẫu và module
        </Link>
      </div>
      <p className="text-center text-xs text-muted-foreground" data-quick-consent>
        Dùng thử {TRIAL_DAYS} ngày miễn phí, không cần thẻ. Bằng việc tạo cửa hàng, bạn đồng ý với{" "}
        <a href={TERMS_OF_SERVICE.path} target="_blank" rel="noopener" className="underline hover:text-foreground">
          Điều khoản sử dụng
        </a>{" "}
        và{" "}
        <a href={PRIVACY_POLICY.path} target="_blank" rel="noopener" className="underline hover:text-foreground">
          Chính sách quyền riêng tư
        </a>
        .
      </p>
    </div>
  );
}
