import Link from "next/link";
import { KeyRound, ShieldCheck, UserCheck, Users } from "lucide-react";
import { CreateUserDialog } from "@/app/(dashboard)/settings/users/user-dialog";
import { UsersTable } from "@/app/(dashboard)/settings/users/users-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { ROLE_HINT, ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
import { formatNumber } from "@/lib/format";
import { listUsers } from "@/lib/queries/users";

export const metadata = { title: "Người dùng" };

export default async function UsersPage() {
  const user = await requireUser(["ADMIN"]);
  const { rows, activeAdmins } = await listUsers();
  const active = rows.filter((u) => u.active).length;
  const byRole = ROLE_ORDER.map((role) => ({ role, count: rows.filter((u) => u.role === role && u.active).length })).filter((r) => r.count > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Người dùng"
        description="Tài khoản đăng nhập nội bộ và vai trò truy cập. Mỗi thao tác quan trọng được ghi vào Nhật ký hệ thống."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/profile">
                <KeyRound className="size-4" /> Đổi mật khẩu của tôi
              </Link>
            </Button>
            <CreateUserDialog />
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Tổng tài khoản" value={formatNumber(rows.length)} note={`${formatNumber(rows.length - active)} đã khoá`} icon={Users} tone="blue" />
        <MetricCard label="Đang hoạt động" value={formatNumber(active)} note={byRole.map((r) => `${r.count} ${ROLE_LABEL[r.role]}`).join(" · ") || "—"} icon={UserCheck} tone="green" />
        <MetricCard label="Quản trị viên" value={formatNumber(activeAdmins)} note={activeAdmins <= 1 ? "Nên có ít nhất 2 quản trị viên để dự phòng" : "Có thể quản lý người dùng và cấu hình"} icon={ShieldCheck} tone={activeAdmins <= 1 ? "amber" : "primary"} />
      </section>

      <SectionCard title="Danh sách người dùng" description="Sửa tên / vai trò, đặt lại mật khẩu hoặc khoá tài khoản từ menu ở cuối dòng" padded={false}>
        <UsersTable users={rows} currentUserId={user.id} activeAdmins={activeAdmins} />
      </SectionCard>

      <SectionCard title="Vai trò & quyền" description="Quản trị viên luôn có toàn quyền; các vai trò khác giới hạn theo module">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ROLE_ORDER.map((role) => (
            <div key={role} className="rounded-lg border bg-background p-3">
              <p className="text-sm font-semibold">{ROLE_LABEL[role]}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{ROLE_HINT[role]}</p>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
