"use client";

import { useState, useTransition } from "react";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { Check, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/ui-bits";
import { PAYROLL_COMPONENT_KIND_LABEL, PAYROLL_COMPONENT_SIGN, PAYROLL_INPUTS, type PayrollComponentKind } from "@/lib/constants/payroll-components";
import { approvePayrollInput, deletePayrollAdjustment, savePayrollAdjustment, savePayrollInput } from "@/lib/actions/payroll-policy";
import { formatDateTime } from "@/lib/format";

type Option = { id: string; name: string };

const ADJ_KINDS = ["BONUS", "ALLOWANCE", "ADJUSTMENT", "ADVANCE", "DEDUCTION", "REIMBURSEMENT"] as const;
const MANUAL_INPUTS = PAYROLL_INPUTS.filter((i) => i.availability === "MANUAL");

/** Nhãn đọc được của đơn vị. Bảng này CHỈ để hiển thị — đơn vị thật nằm ở sổ đăng ký và ở cột `unit`. */
const UNIT_LABEL: Record<string, string> = { VND: "đồng", COUNT: "lượt", DAY: "ngày", HOUR: "giờ", PERCENT: "%" };

/**
 * ═══ HAI THỨ KHÁC NHAU, HAI Ô NHẬP KHÁC NHAU ═══
 *
 *  · ĐẦU VÀO   — một ĐẠI LƯỢNG (giờ công, ngày công, % KPI, số sản phẩm). Nó được NHÂN với đơn giá
 *    trong chính sách. Nhập lại là SỬA, không tạo dòng thứ hai, nếu không mỗi lượt tính lại sẽ cộng
 *    dồn và lương tăng mỗi lần ai đó mở trang.
 *  · ĐIỀU CHỈNH — một SỐ TIỀN cụ thể cho riêng kỳ này (thưởng nóng, tạm ứng, khấu trừ). Số luôn
 *    nhập DƯƠNG; dấu do loại khoản quyết định, để một dấu trừ gõ nhầm không biến khấu trừ thành
 *    thưởng.
 */
export function AdjustmentManager({
  employees,
  periodKey,
  periodLabel,
  locked,
  adjustments,
  inputs,
  canApprove,
}: {
  employees: Option[];
  periodKey: string;
  periodLabel: string;
  locked: boolean;
  adjustments: { id: string; employeeId: string; kind: string; label: string; amount: number; reason: string; createdByName: string }[];
  inputs: {
    employeeId: string;
    inputKey: string;
    value: number;
    unit: string;
    evidence: string;
    status: string;
    enteredByName: string;
    enteredAt: string | null;
    approvedByName: string;
    approvedAt: string | null;
  }[];
  /** Người đang xem có quyền duyệt hay không — nút duyệt không hiện cho người chỉ đọc. */
  canApprove: boolean;
}) {
  const [pending, start] = useTransition();
  const [inp, setInp] = useState({ employeeId: "", inputKey: MANUAL_INPUTS[0]?.key ?? "", value: "", evidence: "" });
  const [adj, setAdj] = useState({ employeeId: "", kind: "BONUS" as PayrollComponentKind, label: "", amount: "", reason: "", reference: "" });

  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? id;
  const inputLabel = (key: string) => PAYROLL_INPUTS.find((i) => i.key === key)?.label ?? key;
  const spec = PAYROLL_INPUTS.find((i) => i.key === inp.inputKey);

  const saveInput = () =>
    start(async () => {
      const r = await savePayrollInput({ ...inp, periodKey, value: Number(inp.value) });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã ghi “${inputLabel(inp.inputKey)}” cho kỳ ${periodLabel}`);
      setInp((s) => ({ ...s, value: "", evidence: "" }));
    });

  const approveInput = (employeeId: string, inputKey: string) =>
    start(async () => {
      const r = await approvePayrollInput({ employeeId, periodKey, inputKey });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã duyệt “${inputLabel(inputKey)}” của ${nameOf(employeeId)}`);
    });

  const saveAdj = () =>
    start(async () => {
      const r = await savePayrollAdjustment({ ...adj, periodKey, amount: Math.round(Number(adj.amount) || 0) });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã ghi khoản điều chỉnh");
      setAdj((s) => ({ ...s, label: "", amount: "", reason: "", reference: "" }));
    });

  const remove = (id: string) =>
    start(async () => {
      const r = await deletePayrollAdjustment(id);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã xoá khoản điều chỉnh");
    });

  return (
    <div className="space-y-4">
      <SectionCard
        title={`Đầu vào nhập tay — kỳ ${periodLabel}`}
        description="ERP chưa có bảng chấm công, chưa đo được sản lượng ở mức từng người, và chấm KPI là một quyết định của người quản lý chứ không phải một truy vấn. Một ô trống nhìn thấy được, có tên người phải điền, tốt hơn một con số không ai kiểm lại được."
      >
        {locked ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Kỳ này đã CHỐT nên không nhập thêm được. Kỳ đã chốt là bất biến — chứng từ về sau ghi vào kỳ SAU, nó vẫn được trả đủ và vẫn có dấu vết.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label>Nhân sự</Label>
              <Select value={inp.employeeId} onValueChange={(v) => setInp((s) => ({ ...s, employeeId: v }))}>
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
              <Label>Đại lượng</Label>
              <Select value={inp.inputKey} onValueChange={(v) => setInp((s) => ({ ...s, inputKey: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_INPUTS.map((i) => (
                    <SelectItem key={i.key} value={i.key}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {spec ? <p className="text-[11px] text-muted-foreground">{spec.source}</p> : null}
            </div>
            <div className="space-y-1">
              <Label>Giá trị{spec ? ` (${UNIT_LABEL[spec.unit] ?? spec.unit})` : ""}</Label>
              <Input type="number" step="0.01" value={inp.value} onChange={(e) => setInp((s) => ({ ...s, value: e.target.value }))} />
              <p className="text-[11px] text-muted-foreground">Nguồn: NHẬP TAY. Đơn vị do sổ đăng ký quy định, máy chủ tự ghi kèm — không gõ lại.</p>
            </div>
            <div className="space-y-1">
              <Label>Căn cứ</Label>
              <Input value={inp.evidence} onChange={(e) => setInp((s) => ({ ...s, evidence: e.target.value }))} placeholder="Bảng công T9, chị Lan duyệt 01/10" />
            </div>
          </div>
        )}
        {!locked ? (
          <div className="mt-3">
            <Button size="sm" onClick={saveInput} disabled={pending || !inp.employeeId || inp.value === ""}>
              <Save className="size-4" /> Ghi đầu vào
            </Button>
          </div>
        ) : null}

        <TableToolsFor tableId="payroll-adjustments-adjustment-manager-1" />
        <div className="mt-4 overflow-x-auto">
          <table id="payroll-adjustments-adjustment-manager-1" className="w-full min-w-[720px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Nhân sự</th>
                <th className="py-1 pr-3 font-medium">Đại lượng</th>
                <th className="py-1 pr-3 text-right font-medium">Giá trị</th>
                <th className="py-1 pr-3 font-medium">Đơn vị</th>
                <th className="py-1 pr-3 font-medium">Căn cứ</th>
                <th className="py-1 pr-3 font-medium">Người nhập</th>
                <th className="py-1 pr-3 font-medium">Lúc nhập</th>
                <th className="py-1 pr-3 font-medium">Trạng thái</th>
                <th className="py-1 font-medium">Người duyệt</th>
              </tr>
            </thead>
            <tbody>
              {inputs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-3 text-muted-foreground">
                    Chưa có đầu vào nào cho kỳ này. Thành phần lương cần chúng sẽ hiện CHƯA BIẾT kèm tên người phải nhập, không hiện 0 ₫.
                  </td>
                </tr>
              ) : null}
              {inputs.map((r) => (
                <tr key={`${r.employeeId}:${r.inputKey}`} className="border-t">
                  <td className="py-1.5 pr-3 font-medium">{nameOf(r.employeeId)}</td>
                  <td className="py-1.5 pr-3">{inputLabel(r.inputKey)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.value.toLocaleString("vi-VN")}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{UNIT_LABEL[r.unit] ?? r.unit ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{r.evidence}</td>
                  <td className="py-1.5 pr-3">{r.enteredByName || "—"}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground tabular-nums">{r.enteredAt ? formatDateTime(r.enteredAt) : "—"}</td>
                  <td className="py-1.5 pr-3">
                    {r.status === "APPROVED" ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">Đã duyệt</span>
                    ) : (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">Chờ duyệt</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    {r.status === "APPROVED" ? (
                      <span>
                        {r.approvedByName || "—"}
                        {r.approvedAt ? <span className="ml-1 text-muted-foreground tabular-nums">{formatDateTime(r.approvedAt)}</span> : null}
                      </span>
                    ) : canApprove && !locked ? (
                      <Button size="sm" variant="outline" onClick={() => approveInput(r.employeeId, r.inputKey)} disabled={pending}>
                        <Check className="size-3.5" /> Duyệt
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title={`Điều chỉnh — kỳ ${periodLabel}`}
        description="Thưởng nóng, tạm ứng, khấu trừ. Số tiền luôn nhập DƯƠNG — dấu do loại khoản quyết định. Mỗi khoản bắt buộc có LÝ DO: một khoản tiền không có lý do là một khoản không ai duyệt lại được."
      >
        {!locked ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label>Nhân sự</Label>
              <Select value={adj.employeeId} onValueChange={(v) => setAdj((s) => ({ ...s, employeeId: v }))}>
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
              <Label>Loại khoản</Label>
              <Select value={adj.kind} onValueChange={(v) => setAdj((s) => ({ ...s, kind: v as PayrollComponentKind }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJ_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {PAYROLL_COMPONENT_KIND_LABEL[k]} {PAYROLL_COMPONENT_SIGN[k] < 0 ? "(trừ vào lương)" : "(cộng vào lương)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Tên khoản</Label>
              <Input value={adj.label} onChange={(e) => setAdj((s) => ({ ...s, label: e.target.value }))} placeholder="Tạm ứng 10/09" />
            </div>
            <div className="space-y-1">
              <Label>Số tiền (đ, luôn dương)</Label>
              <Input type="number" value={adj.amount} onChange={(e) => setAdj((s) => ({ ...s, amount: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Lý do</Label>
              <Input value={adj.reason} onChange={(e) => setAdj((s) => ({ ...s, reason: e.target.value }))} placeholder="Ứng trước theo đề nghị 08/09" />
            </div>
          </div>
        ) : null}
        {!locked ? (
          <div className="mt-3">
            <Button size="sm" onClick={saveAdj} disabled={pending || !adj.employeeId || !adj.label || !adj.amount || adj.reason.length < 3}>
              <Plus className="size-4" /> Thêm khoản
            </Button>
          </div>
        ) : null}

        <TableToolsFor tableId="payroll-adjustments-adjustment-manager-2" />
        <div className="mt-4 overflow-x-auto">
          <table id="payroll-adjustments-adjustment-manager-2" className="w-full min-w-[820px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Nhân sự</th>
                <th className="py-1 pr-3 font-medium">Loại</th>
                <th className="py-1 pr-3 font-medium">Tên khoản</th>
                <th className="py-1 pr-3 text-right font-medium">Số tiền</th>
                <th className="py-1 pr-3 font-medium">Lý do</th>
                <th className="py-1 pr-3 font-medium">Người tạo</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {adjustments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-3 text-muted-foreground">
                    Chưa có khoản điều chỉnh nào cho kỳ này.
                  </td>
                </tr>
              ) : null}
              {adjustments.map((r) => {
                const sign = PAYROLL_COMPONENT_SIGN[r.kind as PayrollComponentKind] ?? 1;
                return (
                  <tr key={r.id} className="border-t">
                    <td className="py-1.5 pr-3 font-medium">{nameOf(r.employeeId)}</td>
                    <td className="py-1.5 pr-3">{PAYROLL_COMPONENT_KIND_LABEL[r.kind as PayrollComponentKind] ?? r.kind}</td>
                    <td className="py-1.5 pr-3">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {sign < 0 ? "−" : "+"}
                      {r.amount.toLocaleString("vi-VN")} ₫
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r.reason}</td>
                    <td className="py-1.5 pr-3">{r.createdByName || "—"}</td>
                    <td className="py-1.5 text-right">
                      {!locked ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => remove(r.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
