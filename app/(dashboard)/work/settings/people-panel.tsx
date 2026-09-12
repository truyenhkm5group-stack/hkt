"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Crown, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEPARTMENT_ROLE_LABEL, ROLE_DEPARTMENT_HINT, DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { removeDepartmentMember, saveDepartment, setDepartmentMember } from "@/lib/actions/work";
import { cn } from "@/lib/utils";

/**
 * ═══════════ AI THUỘC PHÒNG NÀO — MÀN HÌNH PHẢI LÀM XONG TRƯỚC NGÀY ĐẦU TIÊN ═══════════
 *
 * Hàng đợi `/work` chỉ hoạt động khi người dùng thuộc một phòng: phòng ban quyết định họ thấy
 * việc nào. Đo trên production 12/09/2026 trước bản này: **2 tài khoản, 1 người có phòng**, trong
 * khi hàng đợi đã mang khoảng 1.600 việc. Người còn lại mở `/work` lên thấy trống trơn và không
 * có gì trên màn hình nói cho họ biết vì sao.
 *
 * ─── MÁY KHÔNG ĐOÁN, MÁY CHỈ GỢI Ý ───
 *
 * `ROLE_DEPARTMENT_HINT` hiện thành một dòng chữ cạnh ô chọn và KHÔNG được ghi tự động. Vai trò
 * phân quyền (`users.role`) nói người đó ĐƯỢC XEM gì, không nói họ LÀM việc gì: hai người cùng
 * vai `MANAGER` có thể phụ trách hai mảng chẳng liên quan. Xếp nhầm thì việc chạy nhầm phòng
 * hàng tuần liền mới có người phát hiện, còn bỏ trống thì nổi lên ngay ở dải cảnh báo phía trên.
 */

export type PersonRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  departments: { id: string; code: DepartmentCode; name: string; roleInDept: "LEAD" | "MEMBER" }[];
};

export type DeptRow = { id: string; code: DepartmentCode; name: string; leadUserId: string | null; active: boolean };

export function PeoplePanel({ people, departments }: { people: PersonRow[]; departments: DeptRow[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: true } | { error: string } | { ok: true; id: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(ok);
      router.refresh();
    });

  const chuaCoPhong = people.filter((p) => p.departments.length === 0);

  return (
    <div>
      {chuaCoPhong.length ? (
        <div className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{chuaCoPhong.length} người chưa có phòng ban</p>
            <p className="text-xs">
              {chuaCoPhong.map((p) => p.name || p.email).join(" · ")} — họ mở <strong>Việc của tôi</strong> lên sẽ thấy trống, và việc của các phòng
              không tới tay họ. Chọn phòng ở cột bên phải; ERP cố ý KHÔNG tự đoán.
            </p>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <Table className="min-w-[780px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[38%]">Người</TableHead>
              <TableHead>Phòng ban</TableHead>
              <TableHead className="w-[180px] text-right">Thêm vào phòng</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => (
              <TableRow key={p.id} className={cn(p.departments.length === 0 && "bg-amber-50/50 dark:bg-amber-950/20")}>
                <TableCell className="align-top">
                  <p className="text-sm font-medium">{p.name || "(chưa đặt tên)"}</p>
                  <p className="text-xs text-muted-foreground">{p.email}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Quyền: {p.role}
                    {p.departments.length === 0 && ROLE_DEPARTMENT_HINT[p.role] ? ` · thường là ${DEPARTMENT_LABEL[ROLE_DEPARTMENT_HINT[p.role]]} — GỢI Ý, không tự áp` : ""}
                  </p>
                </TableCell>
                <TableCell className="align-top">
                  {p.departments.length === 0 ? (
                    <span className="text-xs text-muted-foreground">chưa có phòng ban</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p.departments.map((d) => {
                        const laTruong = departments.find((x) => x.id === d.id)?.leadUserId === p.id;
                        return (
                          <Badge key={d.id} variant="secondary" className="gap-1 pr-1 text-[11px]">
                            {d.name}
                            <span className="text-muted-foreground">· {DEPARTMENT_ROLE_LABEL[d.roleInDept]}</span>
                            <button
                              type="button"
                              aria-label={laTruong ? `${p.name} đang là trưởng ${d.name}` : `Đặt ${p.name} làm trưởng ${d.name}`}
                              title={laTruong ? "Đang là trưởng phòng" : "Đặt làm trưởng phòng"}
                              disabled={pending || laTruong}
                              className="rounded p-0.5 hover:bg-background disabled:opacity-50"
                              onClick={() =>
                                run(async () => {
                                  const dept = departments.find((x) => x.id === d.id)!;
                                  const r = await saveDepartment({ id: dept.id, code: dept.code, name: dept.name, leadUserId: p.id, active: dept.active });
                                  if ("error" in r) return r;
                                  // Trưởng phòng phải là LEAD trong chính phòng đó, nếu không họ chỉ thấy việc của mình.
                                  return setDepartmentMember({ departmentId: d.id, userId: p.id, roleInDept: "LEAD" });
                                }, `Đã đặt ${p.name} làm trưởng ${d.name}`)
                              }
                            >
                              <Crown className={cn("size-3", laTruong && "text-amber-600")} />
                            </button>
                            <button
                              type="button"
                              aria-label={`Bỏ ${p.name} khỏi ${d.name}`}
                              title="Bỏ khỏi phòng (chỉ ngừng hoạt động, giữ lịch sử)"
                              disabled={pending}
                              className="rounded p-0.5 hover:bg-background"
                              onClick={() => run(() => removeDepartmentMember({ departmentId: d.id, userId: p.id }), `Đã bỏ ${p.name} khỏi ${d.name}`)}
                            >
                              <UserMinus className="size-3" />
                            </button>
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </TableCell>
                <TableCell className="align-top text-right">
                  <Select
                    value=""
                    onValueChange={(v) => run(() => setDepartmentMember({ departmentId: v, userId: p.id, roleInDept: "MEMBER" }), "Đã thêm vào phòng")}
                  >
                    <SelectTrigger className="ml-auto h-8 w-[160px] text-xs">
                      <span className="flex items-center gap-1">
                        <UserPlus className="size-3" /> Chọn phòng
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {departments
                        .filter((d) => d.active && !p.departments.some((x) => x.id === d.id))
                        .map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
