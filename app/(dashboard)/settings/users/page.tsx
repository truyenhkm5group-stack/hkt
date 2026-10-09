import Link from "next/link";
import { KeyRound, ShieldCheck, UserCheck, Users } from "lucide-react";
import { CreateUserDialog } from "@/app/(dashboard)/settings/users/user-dialog";
import { InvitesPanel, InviteUserDialog, type InviteRow } from "@/app/(dashboard)/settings/users/invites-panel";
import { UsersTable } from "@/app/(dashboard)/settings/users/users-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { RoleMatrix } from "@/app/(dashboard)/settings/users/role-matrix";
import { RolesPanel } from "@/app/(dashboard)/settings/users/roles-panel";
import { PositionsPanel } from "@/app/(dashboard)/settings/users/positions-panel";
import { loadRoleTemplates, requirePermission } from "@/lib/auth/session";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";
import { ROLE_LABEL, ROLE_ORDER, salesStaffRoleOf, SHELL_ROLE_LABEL, SHELL_SALES_STAFF_ROLE_CODE } from "@/lib/constants/roles";
import { formatNumber } from "@/lib/format";
import { listUsers } from "@/lib/queries/users";
import { membershipOf } from "@/lib/org/membership";
import { listDepartments } from "@/lib/queries/work";
import { listAccessRoles, listPositions, listUserAccess } from "@/lib/queries/access";
import { listUserInvites } from "@/lib/users/invites";
import type { UserDept } from "@/app/(dashboard)/settings/users/department-cell";

export const metadata = { title: "Người dùng" };

/** Nhãn vai trò của một lời mời ở vỏ: ba lựa chọn của vỏ; lời mời cũ mang vai trò khác giữ nhãn ERP để người xem nhận ra. */
function shellInviteLabel(i: { role: keyof typeof ROLE_LABEL; accessRoleCode: string | null }): string {
  if (i.accessRoleCode) return i.accessRoleCode === SHELL_SALES_STAFF_ROLE_CODE ? SHELL_ROLE_LABEL.SALES : `Vai trò tuỳ chỉnh: ${i.accessRoleCode}`;
  if (i.role === "ADMIN") return SHELL_ROLE_LABEL.OWNER;
  if (i.role === "VIEWER") return SHELL_ROLE_LABEL.VIEWER;
  return ROLE_LABEL[i.role];
}

/**
 * ─── VỎ CHỐT ĐƠN: «NHÂN VIÊN» ───
 *
 * Khách Chốt Đơn (`isSalesAgentUser`) vào trang này từ mục menu «Nhân viên». Họ không thuê ERP nên không có mô hình tổ chức của
 * ERP: trang đổi TIÊU ĐỀ + CÂU CHỮ (không «module» / «ERP» / «Nhật ký hệ thống»), bỏ hai cột Phòng ban · Quyền & phạm vi của bảng,
 * và ẨN ba khối nâng cao (Vai trò tuỳ chỉnh · Chức danh · ma trận «Vai trò hệ thống & quyền» — riêng ma trận là ~780 ô bấm nhỏ hơn
 * 32px, trang dài 4.296px ở 390px, đo Finish Line R2). Chỉ là trình bày: mời / tạo / sửa vai trò / «Phân quyền» từng người / khoá
 * vẫn như cũ, quyền vẫn do `can()` quyết, mọi server action giữ nguyên cổng của nó. ERP / nhà: trang y như trước, từng chữ.
 */
export default async function UsersPage() {
  const user = await requirePermission("users:manage");
  const shell = isSalesAgentUser(user);
  const [{ rows, activeAdmins }, templates, departments, accessRoles, positions, accessByUserRow, invites] = await Promise.all([
    listUsers(),
    loadRoleTemplates(),
    listDepartments(),
    listAccessRoles(),
    listPositions(),
    listUserAccess(),
    listUserInvites(),
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
  // Lời mời: vai trò tuỳ chỉnh hiện bằng TÊN hiện tại của nó (mã lưu ở lời mời); vai trò đã bị xoá thì hiện mã.
  const roleNameByCode = new Map(accessRoles.map((r) => [r.code, r.name]));
  const inviteRows: InviteRow[] = invites.map((i) => ({
    id: i.id,
    email: i.email,
    roleLabel: shell ? shellInviteLabel(i) : i.accessRoleCode ? `Vai trò tuỳ chỉnh: ${roleNameByCode.get(i.accessRoleCode) ?? i.accessRoleCode}` : ROLE_LABEL[i.role],
    invitedByEmail: i.invitedByEmail,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    acceptedAt: i.acceptedAt ? i.acceptedAt.toISOString() : null,
    status: i.status,
  }));
  const invitesActive = invites.filter((i) => i.status === "ACTIVE").length;
  // Vỏ Chốt Đơn: vai trò «Nhân viên bán hàng» nhận ra bằng MÃ `BAN_HANG` (đang bật) — thiếu thì vỏ chỉ có hai lựa chọn.
  const salesRole = shell ? salesStaffRoleOf(accessRoles) : null;
  const shellRoles = shell ? { salesRoleId: salesRole?.id ?? null } : undefined;
  const inviteRoleOptions = accessRoles.filter((r) => r.active && r.baseRole !== "ADMIN").map((r) => ({ code: r.code, name: r.name, hint: `${r.permissions.length} quyền · nền ${ROLE_LABEL[r.baseRole]}` }));
  const byRole = ROLE_ORDER.map((role) => ({ role, count: rows.filter((u) => u.role === role && u.active).length })).filter((r) => r.count > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={shell ? undefined : "Hệ thống"}
        title={shell ? "Nhân viên" : "Người dùng"}
        description={shell ? "Tài khoản đăng nhập của nhân viên cửa hàng và việc mỗi người được làm." : "Tài khoản đăng nhập nội bộ, vai trò và quyền theo từng module."}
        hint={
          shell
            ? "Mời nhân viên bằng liên kết hoặc tạo tài khoản, rồi chọn vai trò — vai trò quyết người đó được làm gì. Cần khác vai trò cho một người thì dùng «Phân quyền» ở menu cuối dòng."
            : "Tài khoản đăng nhập nội bộ, vai trò và quyền truy cập theo từng module. Mỗi thao tác quan trọng được ghi vào Nhật ký hệ thống."
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/profile">
                <KeyRound className="size-4" /> Đổi mật khẩu của tôi
              </Link>
            </Button>
            <InviteUserDialog customRoles={inviteRoleOptions} appName={shell ? "Chốt Đơn" : undefined} shell={shell ? { salesInstalled: Boolean(salesRole) } : undefined} />
            <CreateUserDialog shell={shellRoles} />
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Tổng tài khoản" value={formatNumber(rows.length)} note={`${formatNumber(rows.length - active)} đã khoá`} icon={Users} tone="blue" />
        <MetricCard label="Đang hoạt động" value={formatNumber(active)} note={byRole.map((r) => `${r.count} ${ROLE_LABEL[r.role]}`).join(" · ") || "—"} icon={UserCheck} tone="green" />
        <MetricCard label="Quản trị viên" value={formatNumber(activeAdmins)} note={activeAdmins <= 1 ? "Nên có ít nhất 2 quản trị viên để dự phòng" : "Có thể quản lý người dùng và cấu hình"} icon={ShieldCheck} tone={activeAdmins <= 1 ? "amber" : "primary"} />
      </section>

      <SectionCard
        title={shell ? "Danh sách nhân viên" : "Danh sách người dùng"}
        description={
          shell
            ? "Sửa tên / vai trò ở menu cuối dòng; ở đó cũng có phân quyền riêng, đặt lại mật khẩu và khoá tài khoản."
            : chuaCoPhong
              ? `Sửa tên / vai trò / phòng ban ngay trên dòng — còn ${chuaCoPhong} người chưa có phòng ban.`
              : "Sửa tên / vai trò / phòng ban ngay trên dòng; phân quyền riêng, đặt lại mật khẩu hoặc khoá tài khoản từ menu cuối dòng."
        }
        hint={
          shell
            ? "Vai trò nói người đó ĐƯỢC LÀM GÌ. Đổi vai trò hay quyền thì có hiệu lực ở lần tải trang tiếp theo của người đó."
            : "Vai trò nói người đó ĐƯỢC LÀM GÌ; phòng ban nói họ LÀM VIỆC Ở ĐÂU. Hai thứ khác nhau và ERP không suy cái này ra cái kia — hai người cùng vai “Quản lý” có thể phụ trách hai mảng chẳng liên quan. Phòng ban quyết định hàng đợi công việc của họ có gì."
        }
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
          compact={shell}
          appName={shell ? "Chốt Đơn" : undefined}
          shellRoles={shellRoles}
        />
      </SectionCard>

      <SectionCard
        title="Lời mời"
        description={invitesActive ? `${invitesActive} lời mời còn hạn chưa được nhận — mỗi lời mời giữ một chỗ trong hạn mức người dùng của gói.` : "Mời nhân viên bằng liên kết: họ tự đặt mật khẩu, bạn không phải biết mật khẩu của ai."}
        hint={
          shell
            ? "Liên kết mời dùng một lần, hạn 7 ngày, chỉ hiện một lần lúc tạo. Chốt Đơn chưa tự gửi thư: bạn gửi liên kết cho nhân viên qua kênh của mình. Thu hồi ở đây là liên kết chết ngay."
            : "Liên kết mời dùng một lần, hạn 7 ngày, chỉ hiện một lần lúc tạo — ERP chỉ giữ bản băm. ERP chưa tự gửi thư: bạn gửi liên kết cho nhân viên qua kênh của mình. Thu hồi ở đây là liên kết chết ngay."
        }
      >
        <InvitesPanel invites={inviteRows} />
      </SectionCard>

      {shell ? null : (
        <>

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
        </>
      )}
    </div>
  );
}
