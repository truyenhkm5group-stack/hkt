/**
 * Nút «Tiếp tục với Google / Facebook» (docs/platform/quick-start.md). Chỉ vẽ nút của nhà cung cấp ĐÃ khai khoá trên máy
 * chủ (`enabledProviders()` đọc ở trang cha) — không có nút nào dẫn tới một trang lỗi. Liên kết thường (không JS):
 * đường dẫn `/login/oauth/<nhà cung cấp>` lo phần còn lại.
 */
export function SocialButtons({ providers, intent, next }: { providers: { google: boolean; facebook: boolean }; intent: "login" | "signup"; next?: string }) {
  if (!providers.google && !providers.facebook) return null;
  const q = (p: string) => `/login/oauth/${p}?${new URLSearchParams({ intent, ...(next ? { next } : {}) })}`;
  const base = "flex h-10 w-full items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors";
  return (
    <div className="space-y-2" data-social-buttons>
      {providers.google ? (
        <a href={q("google")} className={`${base} bg-background hover:bg-muted`} data-oauth="google">
          <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
            <path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8.1z" />
            <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z" />
            <path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7H2.1a11 11 0 0 0 0 9.9l3.7-2.8z" />
            <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z" />
          </svg>
          Tiếp tục với Google
        </a>
      ) : null}
      {providers.facebook ? (
        <a href={q("facebook")} className={`${base} border-[#1877F2] bg-[#1877F2] text-white hover:bg-[#166FE5]`} data-oauth="facebook">
          <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
            <path d="M24 12a12 12 0 1 0-13.9 11.9v-8.4h-3V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12z" />
          </svg>
          Tiếp tục với Facebook
        </a>
      ) : null}
    </div>
  );
}

export function OrDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
