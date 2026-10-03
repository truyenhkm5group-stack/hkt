import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { KeyRound } from "lucide-react";
import { ResetForm } from "@/app/reset/[org]/[token]/reset-form";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { formatDateTime } from "@/lib/format";
import { lookupResetToken } from "@/lib/users/password-reset";

export const dynamic = "force-dynamic";
/* Mã nằm trong ĐƯỜNG DẪN: `no-referrer` để nó không đi theo header Referer, và không cho máy tìm kiếm lập chỉ mục. */
export const metadata: Metadata = { title: { absolute: "Đặt lại mật khẩu" }, referrer: "no-referrer", robots: { index: false, follow: false } };

/**
 * `/reset/<mã tổ chức>/<mã>` — ĐẶT LẠI MẬT KHẨU (ngoài nhóm dashboard, không cần phiên).
 *
 * Trang chỉ ĐỌC: mở trang (kể cả bot xem trước liên kết của Zalo / Messenger) không tiêu mã. Lõi tra trong CSDL của
 * tổ chức ghi trong đường dẫn bằng `withOrganization` TƯỜNG MINH (lib/users/password-reset.ts). Mọi lý do không hợp lệ
 * ra CÙNG một câu.
 */
export default async function ResetPasswordPage({ params }: { params: Promise<{ org: string; token: string }> }) {
  const { org, token } = await params;
  const ip = clientIpFrom((await headers()).get("x-forwarded-for"));
  const look = await lookupResetToken(org, token, { ip });

  if (!look.ok) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <KeyRound className="size-6" />
          </span>
          <h1 className="text-xl font-bold">Không mở được liên kết</h1>
          <p className="text-sm text-muted-foreground">{look.error}</p>
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            Đăng nhập
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Đặt lại mật khẩu</p>
          <h1 className="text-xl font-bold">{look.orgName}</h1>
          <p className="text-sm text-muted-foreground">
            Chọn mật khẩu mới cho <b className="text-foreground">{look.email}</b>. Xong là mọi phiên đăng nhập cũ của tài khoản này bị đăng xuất — đăng nhập lại bằng mật khẩu mới.
          </p>
          <p className="text-xs text-muted-foreground">
            Liên kết dùng một lần, hết hạn lúc {formatDateTime(look.expiresAt)}. Mã tổ chức khi đăng nhập: <span className="font-mono">{look.orgCode}</span>.
          </p>
        </div>
        <ResetForm org={look.orgCode} token={token} email={look.email} />
        <p className="text-center text-[11px] text-muted-foreground">Không phải bạn yêu cầu? Bỏ qua trang này — mật khẩu không đổi cho tới khi bấm nút.</p>
      </div>
    </main>
  );
}
