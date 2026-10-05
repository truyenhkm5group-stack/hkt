"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { OrDivider, SocialButtons } from "@/components/auth/social-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgetSocialSignupAction } from "@/lib/actions/oauth";
import { TRIAL_DAYS } from "@/lib/billing/rules";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { quickSignupAction, sendSignupOtpAction } from "@/lib/actions/onboarding";
import { ADMIN_PASSWORD_MIN, QUICK_BUSINESS_LABEL, QUICK_BUSINESS_TYPES, type QuickBusinessType } from "@/lib/onboarding/quick-shared";
import { cn } from "@/lib/utils";

type Social = { provider: "google" | "facebook"; email: string | null; name: string | null } | null;

/**
 * ĐĂNG KÝ NHANH MỘT MÀN HÌNH (docs/platform/quick-start.md): tên cửa hàng · ngành hàng · SĐT · email · mật khẩu — hoặc
 * một nút Google / Facebook thay hai ô cuối. Máy tự chọn mã, mẫu, module; dựng xong vào thẳng ERP.
 */
export function QuickStart({
  needInvite,
  initialInvite,
  providers,
  social,
  initialBusinessType = "food",
  otpRequired = false,
}: {
  needInvite: boolean;
  initialInvite: string;
  providers: { google: boolean; facebook: boolean };
  social: Social;
  /** Ngành chọn sẵn — `ai_sales` trên host «Chốt Đơn Tự Động», hoặc `?nganh=` hợp lệ. */
  initialBusinessType?: QuickBusinessType;
  /** Người vận hành bật xác minh SĐT qua Zalo (lib/onboarding/phone-otp.ts) ⇒ phải nhập mã trước khi tạo. */
  otpRequired?: boolean;
}) {
  const [storeName, setStoreName] = useState("");
  const [businessType, setBusinessType] = useState<QuickBusinessType>(initialBusinessType);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [invite, setInvite] = useState(initialInvite);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [otp, setOtp] = useState("");
  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
  const needEmail = !social || !social.email;
  const needPassword = !social;

  const sendOtp = () => {
    setError(null);
    start(async () => {
      const r = await sendSignupOtpAction(phone);
      if ("error" in r) {
        setError(r.error);
        if (r.retryAfterSeconds) setResendIn(r.retryAfterSeconds);
        return;
      }
      setOtpSentTo(r.sentTo);
      setResendIn(r.resendAfterSeconds);
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Bước 1 khi phải xác minh: gửi mã trước (form vẫn kiểm đủ ô bắt buộc nhờ trình duyệt).
    if (otpRequired && !otpSentTo) return sendOtp();
    setError(null);
    start(async () => {
      const r = await quickSignupAction({ storeName, businessType, phone, email, password, invite: needInvite ? invite : null, otp });
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
          <Input
            id="qs-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setOtpSentTo(null);
              setOtp("");
            }}
            placeholder="0912 345 678"
            maxLength={30}
            required
          />
          {otpRequired && !otpSentTo ? <p className="text-xs text-muted-foreground">Mã xác minh sẽ gửi qua Zalo tới số này.</p> : null}
        </div>
        {otpRequired && otpSentTo ? (
          <div className="space-y-1.5" data-quick-otp>
            <Label htmlFor="qs-otp">Mã xác minh Zalo gửi tới {otpSentTo}</Label>
            <Input id="qs-otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 số" maxLength={6} required autoFocus />
            <button type="button" onClick={sendOtp} disabled={pending || resendIn > 0} className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">
              {resendIn > 0 ? `Gửi lại mã sau ${resendIn} giây` : "Gửi lại mã"}
            </button>
          </div>
        ) : null}
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
          {otpRequired && !otpSentTo ? (pending ? "Đang gửi mã…" : "Gửi mã xác minh qua Zalo") : pending ? "Đang dựng cửa hàng… (dưới 1 phút)" : "Tạo cửa hàng"}
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
