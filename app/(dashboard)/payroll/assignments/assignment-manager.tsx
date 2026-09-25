"use client";

import { useState, useTransition } from "react";
import { Save, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/ui-bits";
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABEL,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABEL,
  WORK_MODES,
  WORK_MODE_LABEL,
  type EmploymentStatus,
  type EmploymentType,
  type WorkMode,
} from "@/lib/constants/payroll-components";
import { saveEmployeePolicyAssignment, saveEmploymentAssignment } from "@/lib/actions/payroll-policy";

type Option = { id: string; name: string };

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * KHAI PHÂN CÔNG LAO ĐỘNG VÀ GÁN CHÍNH SÁCH — CẢ HAI ĐỀU CÓ MỐC HIỆU LỰC.
 *
 * Đổi phòng ban, đổi hình thức làm việc, đổi chính sách: mỗi lần là THÊM một dòng có mốc, không
 * phải sửa dòng cũ. Sửa dòng cũ là làm bảng lương tháng trước đổi theo, sau khi tiền đã trả.
 */
export function AssignmentManager({
  employees,
  policies,
  departments,
  positions,
  users,
}: {
  employees: Option[];
  policies: Option[];
  departments: Option[];
  positions: Option[];
  users: { id: string; name: string; email: string }[];
}) {
  const [pending, start] = useTransition();

  const [emp, setEmp] = useState({
    employeeId: "",
    userId: "",
    departmentId: "",
    positionId: "",
    managerUserId: "",
    employmentType: "FULL_TIME" as EmploymentType,
    workMode: "ONSITE" as WorkMode,
    status: "ACTIVE" as EmploymentStatus,
    standardWorkDays: "",
    costCenter: "",
    effectiveFrom: today(),
    effectiveTo: "",
    note: "",
  });

  const [pol, setPol] = useState({ employeeId: "", policyId: "", effectiveFrom: today(), effectiveTo: "", note: "" });

  const saveEmp = () =>
    start(async () => {
      const r = await saveEmploymentAssignment({
        ...emp,
        userId: emp.userId || undefined,
        departmentId: emp.departmentId || undefined,
        positionId: emp.positionId || undefined,
        managerUserId: emp.managerUserId || undefined,
        standardWorkDays: emp.standardWorkDays ? Number(emp.standardWorkDays) : null,
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã lưu phân công — có hiệu lực từ mốc đã khai, không đụng tới kỳ trước đó");
    });

  const savePol = () =>
    start(async () => {
      const r = await saveEmployeePolicyAssignment(pol);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã gán chính sách lương — từ mốc này, lương của người đó tính bằng máy chung");
    });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Phân công lao động"
        description="Hình thức làm việc (toàn thời gian · bán thời gian · cộng tác) và nơi làm việc (tại chỗ · từ xa · kết hợp) là THUỘC TÍNH LAO ĐỘNG, KHÔNG phải công thức lương. Một người làm từ xa vẫn có thể ăn lương cứng, ăn theo giờ, ăn hoa hồng hay ăn khoán — cách trả tiền do chính sách quyết định."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label>Nhân sự</Label>
            <Select value={emp.employeeId} onValueChange={(v) => setEmp((s) => ({ ...s, employeeId: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn nhân sự" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Tài khoản ERP</Label>
            <Select value={emp.userId || "none"} onValueChange={(v) => setEmp((s) => ({ ...s, userId: v === "none" ? "" : v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chưa nối" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Chưa nối tài khoản</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">Chưa nối nghĩa là CHƯA NỐI ĐƯỢC, không phải “không có ai”.</p>
          </div>
          <div className="space-y-1">
            <Label>Phòng ban</Label>
            <Select value={emp.departmentId || "none"} onValueChange={(v) => setEmp((s) => ({ ...s, departmentId: v === "none" ? "" : v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chưa gán" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Chưa gán</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Chức danh</Label>
            <Select value={emp.positionId || "none"} onValueChange={(v) => setEmp((s) => ({ ...s, positionId: v === "none" ? "" : v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chưa gán" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Chưa gán</SelectItem>
                {positions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">Chức danh là NHÃN — không sinh quyền, không sinh lương.</p>
          </div>
          <div className="space-y-1">
            <Label>Hình thức làm việc</Label>
            <Select value={emp.employmentType} onValueChange={(v) => setEmp((s) => ({ ...s, employmentType: v as EmploymentType }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {EMPLOYMENT_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Nơi làm việc</Label>
            <Select value={emp.workMode} onValueChange={(v) => setEmp((s) => ({ ...s, workMode: v as WorkMode }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORK_MODES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {WORK_MODE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Trạng thái</Label>
            <Select value={emp.status} onValueChange={(v) => setEmp((s) => ({ ...s, status: v as EmploymentStatus }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYMENT_STATUSES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {EMPLOYMENT_STATUS_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Quản lý trực tiếp</Label>
            <Select value={emp.managerUserId || "none"} onValueChange={(v) => setEmp((s) => ({ ...s, managerUserId: v === "none" ? "" : v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chưa gán" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Chưa gán</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Hiệu lực từ</Label>
            <Input type="date" value={emp.effectiveFrom} onChange={(e) => setEmp((s) => ({ ...s, effectiveFrom: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Đến (trống = còn hiệu lực)</Label>
            <Input type="date" value={emp.effectiveTo} onChange={(e) => setEmp((s) => ({ ...s, effectiveTo: e.target.value }))} />
            <p className="text-[11px] text-muted-foreground">Nghỉ giữa tháng thì điền ngày cuối cùng đi làm — lương cứng chia đúng phần ngày đó.</p>
          </div>
          <div className="space-y-1">
            <Label>Ngày công chuẩn / tháng</Label>
            <Input type="number" value={emp.standardWorkDays} onChange={(e) => setEmp((s) => ({ ...s, standardWorkDays: e.target.value }))} placeholder="Trống = dùng số ngày thật của tháng" />
          </div>
          <div className="space-y-1">
            <Label>Ghi chú</Label>
            <Input value={emp.note} onChange={(e) => setEmp((s) => ({ ...s, note: e.target.value }))} />
          </div>
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={saveEmp} disabled={pending || !emp.employeeId}>
            <UserPlus className="size-4" /> Lưu phân công
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Gán chính sách lương"
        description="Từ mốc hiệu lực trở đi, lương của người này tính bằng máy chung (chính sách → thành phần) và bốn ô trên hồ sơ nhân sự KHÔNG còn tham gia. Dòng gán trước đó tự đóng lại ở ngày liền trước — hai chính sách cùng phủ một ngày là để tiền của ngày ấy phụ thuộc vào thứ tự dòng."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1">
            <Label>Nhân sự</Label>
            <Select value={pol.employeeId} onValueChange={(v) => setPol((s) => ({ ...s, employeeId: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn nhân sự" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Chính sách lương</Label>
            <Select value={pol.policyId} onValueChange={(v) => setPol((s) => ({ ...s, policyId: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn chính sách" />
              </SelectTrigger>
              <SelectContent>
                {policies.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Hiệu lực từ</Label>
            <Input type="date" value={pol.effectiveFrom} onChange={(e) => setPol((s) => ({ ...s, effectiveFrom: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Đến (trống = còn hiệu lực)</Label>
            <Input type="date" value={pol.effectiveTo} onChange={(e) => setPol((s) => ({ ...s, effectiveTo: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Lý do</Label>
            <Input value={pol.note} onChange={(e) => setPol((s) => ({ ...s, note: e.target.value }))} placeholder="Vì sao đổi chính sách" />
          </div>
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={savePol} disabled={pending || !pol.employeeId || !pol.policyId}>
            <Save className="size-4" /> Gán chính sách
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
