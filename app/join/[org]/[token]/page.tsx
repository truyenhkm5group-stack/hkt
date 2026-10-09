import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { MailX } from "lucide-react";
import { JoinForm } from "@/app/join/[org]/[token]/join-form";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { formatDateTime } from "@/lib/format";
import { hostBrand } from "@/lib/platform/host-brand";
import { lookupUserInvite } from "@/lib/users/invites";

export const dynamic = "force-dynamic";
/*
  Mã mời nằm trong ĐƯỜNG DẪN: `no-referrer` để nó không đi theo header Referer sang bất kỳ đâu trang này dẫn tới, và
  không cho máy tìm kiếm lập chỉ mục.
*/
export const metadata: Metadata = { title: { absolute: "Nhận lời mời" }, referrer: "no-referrer", robots: { index: false, follow: false } };

/**
 * `/join/<mã tổ chức>/<mã mời>` — NHẬN LỜI MỜI (ngoài nhóm dashboard, không cần phiên).
 *
 * Trang chỉ ĐỌC: mở trang (kể cả bot xem trước liên kết của Zalo / Messenger) không tiêu mã. Lõi tra trong CSDL của
 * tổ chức ghi trong đường dẫn bằng `withOrganization` TƯỜNG MINH (lib/users/invites.ts) — không phiên thì không rơi về
 * tổ chức nhà. Mọi lý do không hợp lệ ra CÙNG một câu.
 */
export default async function JoinPage({ params }: { params: Promise<{ org: string; token: string }> }) {
  // Mã tổ chức [a-z0-9-] và mã mời base64url không có ký tự cần giải mã; chuỗi lạ thì lõi trả câu chung.
  const { org, token } = await params;
  const ip = clientIpFrom((await headers()).get("x-forwarded-for"));
  const look = await lookupUserInvite(org, token, { ip });

  if (!look.ok) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <MailX className="size-6" />
          </span>
          <h1 className="text-xl font-bold">Không mở được lời mời</h1>
          <p className="text-sm text-muted-foreground">{look.error}</p>
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            Đăng nhập
          </Link>
        </div>
      </main>
    );
  }

  // Host Chốt Đơn (C1 #7): người được mời là nhân viên của một CỬA HÀNG, không phải người dùng «ERP» — chỉ đổi CHỮ theo host.
  const chotdon = (await hostBrand()) === "chotdon";
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Lời mời tham gia</p>
          <h1 className="text-xl font-bold">{look.orgName}</h1>
          <p className="text-sm text-muted-foreground">
            Bạn được mời vào {chotdon ? "cửa hàng" : "ERP của tổ chức"} này với email <b className="text-foreground">{look.email}</b>, vai trò <b className="text-foreground">{look.roleLabel}</b>. Đặt tên và mật khẩu để tạo tài khoản — xong là vào thẳng {chotdon ? "ứng dụng" : "ERP"}.
          </p>
          <p className="text-xs text-muted-foreground">
            Liên kết dùng một lần, hết hạn lúc {formatDateTime(look.expiresAt)}. Lần sau đăng nhập bằng email trên, {chotdon ? "mã cửa hàng" : "mã tổ chức"} <span className="font-mono">{look.orgCode}</span>.
          </p>
        </div>
        <JoinForm org={look.orgCode} token={token} email={look.email} chotdon={chotdon} />
        <p className="text-center text-[11px] text-muted-foreground">Không phải bạn? Bỏ qua trang này — không có tài khoản nào được tạo cho tới khi bấm nút.</p>
      </div>
    </main>
  );
}
