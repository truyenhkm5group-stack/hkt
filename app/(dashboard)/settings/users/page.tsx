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
import { membershipOf } from "@/lib/org/membership";
import { listDepartments } from "@/lib/queries/work";
import type { UserDept } from "@/app/(dashboard)/settings/users/department-cell";

export const metadata = { title: "Người dùng" };

export default async function UsersPage() {
  const user = await requirePermission("users:manage");
  const [{ rows, activeAdmins }, templates, departments] = await Promise.all([listUsers(), loadRoleTemplates(), listDepartments()]);

  /*
    Phòng ban của từng người, đọc qua ĐÚNG dịch vụ mà màn Cấu hình công việc dùng
    (`lib/org/membership.ts`). Không viết lại một truy vấn thứ hai ở đây: hai truy vấn cho cùng
    một sự thật là hai cách để chúng nói khác nhau.
  */
  const memberships = await Promise.all(rows.map(async (u) => [u.id, await membershipOf(u.id)] as const));
  const departmentsByUser: Record<string, UserDept[]> = Object.fromEntries(
    memberships.map(([id, list]) => [id, list.map((m) => ({ departmentId: m.departmentId, code: m.code, name: m.name, roleInDept: m.roleInDept, isLead: m.isLead }))]),
  );
  const chuaCoPhong = rows.filter((u) => u.active && (departmentsByUser[u.id] ?? []).length === 0).length;
  const active = rows.filter((u) => u.active).length;
  const byRole = ROLE_ORDER.map((role) => ({ role, count: rows.filter((u) => u.role === role && u.active).length })).filter((r) => r.count > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Người dùng"
        description="Tài khoản đăng nhập nội bộ, vai trò và quyền theo từng module."
        hint="Tài khoản đăng nhập nội bộ, vai trò và quyền truy cập theo từng module. Mỗi thao tác quan trọng được ghi vào Nhật ký hệ thống."
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

      <SectionCard
        title="Danh sách người dùng"
        description={
          chuaCoPhong
            ? `Sửa tên / vai trò / phòng ban ngay trên dòng — còn ${chuaCoPhong} người chưa có phòng ban.`
            : "Sửa tên / vai trò / phòng ban ngay trên dòng; phân quyền riêng, đặt lại mật khẩu hoặc khoá tài khoản từ menu cuối dòng."
        }
        hint="Vai trò nói người đó ĐƯỢC LÀM GÌ; phòng ban nói họ LÀM VIỆC Ở ĐÂU. Hai thứ khác nhau và ERP không suy cái này ra cái kia — hai người cùng vai “Quản lý” có thể phụ trách hai mảng chẳng liên quan. Phòng ban quyết định hàng đợi công việc của họ có gì."
        padded={false}
      >
        <UsersTable
          users={rows}
          currentUserId={user.id}
          activeAdmins={activeAdmins}
          templates={templates}
          departmentsByUser={departmentsByUser}
          allDepartments={departments.map((d) => ({ id: d.id, name: d.name }))}
        />
      </SectionCard>

      <SectionCard title="Vai trò & quyền" description="Vai trò là mẫu quyền khởi điểm cho người dùng."
 hint="Vai trò là mẫu quyền khởi điểm: tích/bỏ tích để đổi quyền mặc định của từng vai trò. Muốn khác biệt cho một người cụ thể, dùng “Phân quyền” ở menu cuối dòng.">
        <RoleMatrix templates={templates} canEdit />
      </SectionCard>
    </div>
  );
}
