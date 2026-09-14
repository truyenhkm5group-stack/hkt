import Link from "next/link";
import { KeyRound, ShieldCheck, UserCheck, Users } from "lucide-react";
import { CreateUserDialog } from "@/app/(dashboard)/settings/users/user-dialog";
import { UsersTable } from "@/app/(dashboard)/settings/users/users-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { RoleMatrix } from "@/app/(dashboard)/settings/users/role-matrix";
import { RolesPanel } from "@/app/(dashboard)/settings/users/roles-panel";
import { PositionsPanel } from "@/app/(dashboard)/settings/users/positions-panel";
import { loadRoleTemplates, requirePermission } from "@/lib/auth/session";
import { ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
import { formatNumber } from "@/lib/format";
import { listUsers } from "@/lib/queries/users";
import { membershipOf } from "@/lib/org/membership";
import { listDepartments } from "@/lib/queries/work";
import { listAccessRoles, listPositions, listUserAccess } from "@/lib/queries/access";
import type { UserDept } from "@/app/(dashboard)/settings/users/department-cell";

export const metadata = { title: "Người dùng" };

export default async function UsersPage() {
  const user = await requirePermission("users:manage");
  const [{ rows, activeAdmins }, templates, departments, accessRoles, positions, accessByUserRow] = await Promise.all([
    listUsers(),
    loadRoleTemplates(),
    listDepartments(),
    listAccessRoles(),
    listPositions(),
    listUserAccess(),
  ]);

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
  const accessByUser = Object.fromEntries(
    rows.map((u) => {
      const a = accessByUserRow[u.id];
      return [u.id, { accessRoleId: a?.accessRoleId ?? null, accessRoleName: a?.accessRoleName ?? "", positionId: a?.positionId ?? null, positionName: a?.positionName ?? "", scope: a?.scope ?? "ALL" }];
    }),
  );
  const roleOptions = accessRoles.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name, hint: `${r.permissions.length} quyền · nền ${r.baseRole}` }));
  const positionOptions = positions.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, hint: p.departmentName }));
  const chuaCoChucDanh = rows.filter((u) => u.active && !accessByUserRow[u.id]?.positionId).length;
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
          accessByUser={accessByUser}
          roleOptions={roleOptions}
          positionOptions={positionOptions}
        />
      </SectionCard>

      <SectionCard
        title="Vai trò tuỳ chỉnh"
        description={`${accessRoles.filter((r) => r.active).length} vai trò đang bật. Tám vai trò hệ thống không nằm ở đây — chúng là hằng số trong mã nguồn nên không ai xoá được.`}
        hint="Vai trò tuỳ chỉnh là một bó quyền có tên, dùng lại được cho nhiều người. Khác với “Phân quyền” riêng cho từng người ở chỗ: sửa bó là sửa cho mọi người mang nó. Vai trò tuỳ chỉnh không được cấp quyền quản lý người dùng — đó là cửa để tự nâng mình lên toàn quyền."
      >
        <RolesPanel roles={accessRoles.map((r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, baseRole: r.baseRole, permissions: r.permissions, defaultScope: r.defaultScope, active: r.active, usedBy: r.usedBy }))} />
      </SectionCard>

      <SectionCard
        title="Chức danh"
        description={chuaCoChucDanh ? `${positions.filter((p) => p.active).length} chức danh đang dùng — còn ${chuaCoChucDanh} người chưa đặt chức danh.` : `${positions.filter((p) => p.active).length} chức danh đang dùng.`}
        hint="Chức danh trả lời “người này làm chức gì”, KHÔNG mở thêm quyền nào. Nếu một ngày đổi tên chức danh mà quyền của ai đó thay đổi thì luật đã bị phá — kiểm thử quét mã nguồn để chặn điều đó."
      >
        <PositionsPanel positions={positions} departments={departments.map((d) => ({ id: d.id, name: d.name }))} />
      </SectionCard>

      <SectionCard title="Vai trò hệ thống & quyền" description="Vai trò là mẫu quyền khởi điểm cho người dùng."
 hint="Vai trò là mẫu quyền khởi điểm: tích/bỏ tích để đổi quyền mặc định của từng vai trò. Muốn khác biệt cho một người cụ thể, dùng “Phân quyền” ở menu cuối dòng.">
        <RoleMatrix templates={templates} canEdit />
      </SectionCard>
    </div>
  );
}
