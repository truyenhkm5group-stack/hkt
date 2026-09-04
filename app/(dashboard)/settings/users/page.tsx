import Link from "next/link";
import { KeyRound, ShieldCheck, UserCheck, Users } from "lucide-react";
import { CreateUserDialog } from "@/app/(dashboard)/settings/users/user-dialog";
import { UsersTable } from "@/app/(dashboard)/settings/users/users-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { RoleMatrix } from "@/app/(dashboard)/settings/users/role-matrix";
import { loadRoleTemplates, requirePermission } from "@/lib/auth/session";
import { ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
import { formatNumber } from "@/lib/format";
import { listUsers } from "@/lib/queries/users";

export const metadata = { title: "Người dùng" };

export default async function UsersPage() {
  const user = await requirePermission("users:manage");
  const [{ rows, activeAdmins }, templates] = await Promise.all([listUsers(), loadRoleTemplates()]);
  const active = rows.filter((u) => u.active).length;
  const byRole = ROLE_ORDER.map((role) => ({ role, count: rows.filter((u) => u.role === role && u.active).length })).filter((r) => r.count > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Người dùng"
        description="Tài khoản đăng nhập nội bộ, vai trò và quyền truy cập theo từng module. Mỗi thao tác quan trọng được ghi vào Nhật ký hệ thống."
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

      <SectionCard title="Danh sách người dùng" description="Sửa tên / vai trò, phân quyền riêng từng người, đặt lại mật khẩu hoặc khoá tài khoản từ menu ở cuối dòng" padded={false}>
        <UsersTable users={rows} currentUserId={user.id} activeAdmins={activeAdmins} templates={templates} />
      </SectionCard>

      <SectionCard title="Vai trò & quyền" description="Vai trò là mẫu quyền khởi điểm: tích/bỏ tích để đổi quyền mặc định của từng vai trò. Muốn khác biệt cho một người cụ thể, dùng “Phân quyền” ở menu cuối dòng.">
        <RoleMatrix templates={templates} canEdit />
      </SectionCard>
    </div>
  );
}
