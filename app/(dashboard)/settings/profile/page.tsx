import { ChangePasswordForm } from "@/app/(dashboard)/settings/profile/change-password-form";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { requireUser } from "@/lib/auth/session";
import { ROLE_HINT, ROLE_LABEL } from "@/lib/constants/roles";
import { initials } from "@/lib/format";

export const metadata = { title: "Tài khoản của tôi" };

export default async function ProfilePage() {
  const user = await requireUser();
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Hệ thống" title="Tài khoản của tôi" description="Thông tin đăng nhập và đổi mật khẩu" />
      <section className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <SectionCard title="Thông tin tài khoản" description="Liên hệ quản trị viên nếu cần đổi tên, email hoặc vai trò">
          <div className="mb-4 flex items-center gap-3">
            <Avatar className="size-12 rounded-xl">
              <AvatarFallback className="rounded-xl bg-primary text-sm font-bold text-primary-foreground">{initials(user.name) || "U"}</AvatarFallback>
            </Avatar>
            <div>
              <p className="text-base font-bold">{user.name}</p>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <DescriptionList
            columns={1}
            items={[
              { label: "Vai trò", value: ROLE_LABEL[user.role] },
              { label: "Phạm vi", value: ROLE_HINT[user.role] },
              { label: "Email đăng nhập", value: user.email },
            ]}
          />
        </SectionCard>
        <SectionCard title="Đổi mật khẩu của tôi" description="Nhập mật khẩu hiện tại để xác nhận. Các phiên đăng nhập khác vẫn còn hiệu lực tới khi hết hạn (7 ngày).">
          <ChangePasswordForm />
        </SectionCard>
      </section>
    </div>
  );
}
