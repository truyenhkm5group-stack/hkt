"use client";

import { useState, useTransition } from "react";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { useRouter } from "next/navigation";
import { Copy, Plus, Rocket, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import {
  PAYROLL_CALC_TYPES,
  PAYROLL_CALC_TYPE_LABEL,
  PAYROLL_COMPONENT_KINDS,
  PAYROLL_COMPONENT_KIND_LABEL,
  PAYROLL_INPUTS,
  PAYROLL_PRORATE_LABEL,
  PAYROLL_PRORATE_RULES,
  PAYROLL_ROUNDING_LABEL,
  PAYROLL_ROUNDING_RULES,
  carryForwardAllowed,
  defaultProrate,
  type PayrollCalcParams,
  type PayrollCalcType,
  type PayrollComponentKind,
  type PolicyComponent,
} from "@/lib/constants/payroll-components";
import {
  activateSalaryPolicyVersion,
  cloneSalaryPolicyVersion,
  saveSalaryPolicy,
  saveSalaryPolicyVersion,
} from "@/lib/actions/payroll-policy";
import { PreviewPanel } from "@/app/(dashboard)/payroll/policies/preview-panel";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type VersionView = {
  id: string;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: string;
  note: string;
  components: PolicyComponent[];
};
type PolicyView = {
  id: string;
  code: string;
  name: string;
  description: string;
  departmentId: string | null;
  departmentName: string;
  active: boolean;
  sortOrder: number;
  assignedCount: number;
  versions: VersionView[];
};

const iso = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const today = () => iso(new Date());

/** Tham số mặc định cho một kiểu phép tính — đủ hợp lệ để lưu, số thật do người khai. */
function defaultCalc(type: PayrollCalcType): PayrollCalcParams {
  switch (type) {
    case "FIXED_AMOUNT":
      return { type, amount: 0 };
    case "PER_UNIT":
      return { type, basisKey: "WORK_HOURS", unitRate: 0 };
    case "RATE_OF_BASIS":
      return { type, basisKey: "PROFIT_PERSONAL", ratePercent: 0 };
    case "TIERED_RATE":
      return { type, basisKey: "REVENUE_PERSONAL", tiers: [{ from: 0, ratePercent: 0 }] };
    case "THRESHOLD_BONUS":
      return { type, basisKey: "KPI_PERCENT", threshold: 0, amount: 0 };
  }
}

const STATUS_LABEL: Record<string, string> = { DRAFT: "Bản nháp", ACTIVE: "Đang hiệu lực", RETIRED: "Đã rút" };
const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  ACTIVE: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  RETIRED: "bg-muted text-muted-foreground",
};

export function PolicyManager({ policies, departments }: { policies: PolicyView[]; departments: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);

  const [form, setForm] = useState({ code: "", name: "", description: "", departmentId: "", active: true, sortOrder: 100 });
  const savePolicy = () =>
    start(async () => {
      const r = await saveSalaryPolicy({ ...form, departmentId: form.departmentId || undefined });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã lưu chính sách lương");
      setForm({ code: "", name: "", description: "", departmentId: "", active: true, sortOrder: 100 });
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Thêm chính sách lương"
        description="Một chính sách là một CÁCH TRẢ TIỀN, không phải một chức danh. Nhiều người có thể dùng chung một chính sách, và một người đổi chính sách theo thời gian mà lịch sử vẫn đúng."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="pol-code">Mã chính sách</Label>
            <Input id="pol-code" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="WAREHOUSE_HOURLY" />
            <p className="text-[11px] text-muted-foreground">Chữ HOA, số, gạch dưới. Đây là KHOÁ — đặt rồi thì đừng đổi.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pol-name">Tên hiển thị</Label>
            <Input id="pol-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Kho — lương theo giờ" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pol-dept">Phòng ban thường áp dụng</Label>
            <Select value={form.departmentId || "none"} onValueChange={(v) => setForm((f) => ({ ...f, departmentId: v === "none" ? "" : v }))}>
              <SelectTrigger id="pol-dept">
                <SelectValue placeholder="Không gắn phòng ban" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Không gắn phòng ban</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">Chỉ để gợi ý khi xếp người — KHÔNG tự gán cho ai.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pol-desc">Mô tả</Label>
            <Input id="pol-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Áp cho nhân sự kho bán thời gian" />
          </div>
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={savePolicy} disabled={pending || !form.code || !form.name}>
            <Plus className="size-4" /> Thêm chính sách
          </Button>
        </div>
      </SectionCard>

      {policies.length === 0 ? (
        <EmptyState
          title="Chưa có chính sách lương nào"
          description="Chưa khai chính sách nào thì mọi nhân sự vẫn tính lương bằng đường cũ (bốn ô trên hồ sơ nhân sự ở tab Bảng lương). Không con số nào đổi cho tới khi bạn gán chính sách cho một người."
        />
      ) : null}

      {policies.map((p) => (
        <PolicyCard key={p.id} policy={p} editing={editing === p.id} onToggleEdit={() => setEditing(editing === p.id ? null : p.id)} />
      ))}
    </div>
  );
}

function PolicyCard({ policy, editing, onToggleEdit }: { policy: PolicyView; editing: boolean; onToggleEdit: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const latest = policy.versions[0];
  const [draft, setDraft] = useState<{ id?: string; effectiveFrom: string; effectiveTo: string; note: string; components: PolicyComponent[] }>(() => {
    const nhap = policy.versions.find((v) => v.status === "DRAFT");
    return nhap
      ? { id: nhap.id, effectiveFrom: iso(nhap.effectiveFrom), effectiveTo: nhap.effectiveTo ? iso(nhap.effectiveTo) : "", note: nhap.note, components: nhap.components }
      : { effectiveFrom: today(), effectiveTo: "", note: "", components: [] };
  });

  const addComponent = () =>
    setDraft((d) => ({
      ...d,
      components: [
        ...d.components,
        {
          code: `C${d.components.length + 1}`,
          label: "Khoản mới",
          kind: "FIXED" as PayrollComponentKind,
          calc: defaultCalc("FIXED_AMOUNT"),
          prorate: defaultProrate("FIXED"),
          rounding: "ROUND" as const,
          minAmount: null,
          maxAmount: null,
          carryForward: false,
          sortOrder: (d.components.length + 1) * 10,
          note: "",
        },
      ],
    }));

  const setComp = (i: number, patch: Partial<PolicyComponent>) =>
    setDraft((d) => ({ ...d, components: d.components.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));

  const saveDraft = () =>
    start(async () => {
      const r = await saveSalaryPolicyVersion({ ...draft, policyId: policy.id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã lưu bản nháp phiên bản");
      router.refresh();
    });

  const activate = (versionId: string) =>
    start(async () => {
      const r = await activateSalaryPolicyVersion(versionId);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã phát hành phiên bản — từ mốc hiệu lực, lương tính theo bản này");
      router.refresh();
    });

  const clone = (versionId: string) =>
    start(async () => {
      const r = await cloneSalaryPolicyVersion(versionId, today());
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã nhân bản thành bản nháp mới — sửa rồi phát hành");
      router.refresh();
    });

  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          {policy.name}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{policy.code}</code>
          {policy.departmentName ? <span className="text-[12px] font-normal text-muted-foreground">{policy.departmentName}</span> : null}
          {!policy.active ? <Badge variant="outline">Đã tắt</Badge> : null}
        </span>
      }
      description={
        <>
          {policy.assignedCount} người đang gán · {policy.versions.length} phiên bản.
          {policy.description ? ` ${policy.description}` : ""}
        </>
      }
      actions={
        <Button size="sm" variant="outline" onClick={onToggleEdit}>
          {editing ? "Đóng" : "Sửa phiên bản"}
        </Button>
      }
    >
      <TableToolsFor tableId="payroll-policies-policy-manager" />
      <div className="overflow-x-auto">
        <table id="payroll-policies-policy-manager" className="w-full min-w-[640px] text-[13px]">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Phiên bản</th>
              <th className="py-1 pr-3 font-medium">Hiệu lực</th>
              <th className="py-1 pr-3 font-medium">Trạng thái</th>
              <th className="py-1 pr-3 font-medium">Thành phần</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {policy.versions.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-muted-foreground">
                  Chưa có phiên bản nào. Một chính sách không có phiên bản ĐANG HIỆU LỰC thì không tính ra đồng nào — và bảng lương sẽ nói thẳng điều đó thay vì ghi 0 ₫.
                </td>
              </tr>
            ) : null}
            {policy.versions.map((v) => (
              <tr key={v.id} className="border-t">
                <td className="py-1.5 pr-3 tabular-nums">#{v.version}</td>
                <td className="py-1.5 pr-3">
                  {formatDate(v.effectiveFrom)} → {v.effectiveTo ? formatDate(v.effectiveTo) : "còn hiệu lực"}
                </td>
                <td className="py-1.5 pr-3">
                  <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[v.status])}>{STATUS_LABEL[v.status] ?? v.status}</span>
                </td>
                <td className="py-1.5 pr-3">{v.components.map((c) => c.label).join(" · ") || "—"}</td>
                <td className="py-1.5 text-right">
                  <span className="flex justify-end gap-1">
                    {v.status === "DRAFT" ? (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => activate(v.id)}>
                        <Rocket className="size-3.5" /> Phát hành
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => clone(v.id)}>
                      <Copy className="size-3.5" /> Nhân bản
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <div className="mt-4 space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-[12px] text-muted-foreground">
            Phiên bản ĐÃ PHÁT HÀNH là bất biến — sửa nó là viết lại cách trả tiền của những tháng đã đi qua nó, kể cả tháng đã trả. Sửa ở đây chỉ chạm vào BẢN NHÁP; muốn đổi một bản đang chạy thì bấm
            “Nhân bản”, sửa, rồi phát hành với mốc hiệu lực mới.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`ef-${policy.id}`}>Hiệu lực từ</Label>
              <Input id={`ef-${policy.id}`} type="date" value={draft.effectiveFrom} onChange={(e) => setDraft((d) => ({ ...d, effectiveFrom: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`et-${policy.id}`}>Đến (để trống = còn hiệu lực)</Label>
              <Input id={`et-${policy.id}`} type="date" value={draft.effectiveTo} onChange={(e) => setDraft((d) => ({ ...d, effectiveTo: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`nt-${policy.id}`}>Ghi chú</Label>
              <Input id={`nt-${policy.id}`} value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder="Vì sao đổi" />
            </div>
          </div>

          {draft.components.map((c, i) => (
            <ComponentEditor key={i} value={c} onChange={(patch) => setComp(i, patch)} onRemove={() => setDraft((d) => ({ ...d, components: d.components.filter((_, idx) => idx !== i) }))} />
          ))}

          {draft.components.length ? <PreviewPanel components={draft.components} /> : null}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={addComponent}>
              <Plus className="size-4" /> Thêm thành phần
            </Button>
            <Button size="sm" onClick={saveDraft} disabled={pending}>
              <Save className="size-4" /> Lưu bản nháp
            </Button>
          </div>
          {latest && latest.status !== "DRAFT" ? (
            <p className="text-[12px] text-muted-foreground">Phiên bản mới nhất đang ở trạng thái “{STATUS_LABEL[latest.status]}”. Lưu ở đây sẽ tạo một bản NHÁP riêng, chưa ảnh hưởng tới lương của ai.</p>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

/** Ô khai một thành phần. Đại lượng chỉ chọn được từ SỔ ĐĂNG KÝ — không có ô gõ tự do. */
function ComponentEditor({ value, onChange, onRemove }: { value: PolicyComponent; onChange: (patch: Partial<PolicyComponent>) => void; onRemove: () => void }) {
  const calc = value.calc;
  const spec = "basisKey" in calc ? PAYROLL_INPUTS.find((i) => i.key === calc.basisKey) : null;
  const setCalc = (patch: Record<string, unknown>) => onChange({ calc: { ...calc, ...patch } as PayrollCalcParams });
  return (
    <div className="space-y-2 rounded-lg border bg-background p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label>Khoá</Label>
          <Input value={value.code} onChange={(e) => onChange({ code: e.target.value.toUpperCase() })} />
        </div>
        <div className="space-y-1">
          <Label>Tên trên phiếu lương</Label>
          <Input value={value.label} onChange={(e) => onChange({ label: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Loại khoản</Label>
          <Select
            value={value.kind}
            onValueChange={(v) => onChange({ kind: v as PayrollComponentKind, prorate: defaultProrate(v as PayrollComponentKind) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYROLL_COMPONENT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {PAYROLL_COMPONENT_KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Cách tính</Label>
          <Select value={calc.type} onValueChange={(v) => onChange({ calc: defaultCalc(v as PayrollCalcType), carryForward: false })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYROLL_CALC_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {PAYROLL_CALC_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {"basisKey" in calc ? (
          <div className="space-y-1 lg:col-span-2">
            <Label>Đại lượng</Label>
            <Select value={calc.basisKey} onValueChange={(v) => setCalc({ basisKey: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYROLL_INPUTS.map((i) => (
                  <SelectItem key={i.key} value={i.key}>
                    {i.label} · {i.availability === "MEASURED" ? "ERP đo được" : "phải nhập tay"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {spec ? <p className="text-[11px] text-muted-foreground">{spec.source}</p> : null}
          </div>
        ) : null}
        {calc.type === "FIXED_AMOUNT" ? (
          <div className="space-y-1">
            <Label>Số tiền mỗi tháng (đ)</Label>
            <Input type="number" value={calc.amount} onChange={(e) => setCalc({ amount: Math.round(Number(e.target.value) || 0) })} />
          </div>
        ) : null}
        {calc.type === "PER_UNIT" ? (
          <div className="space-y-1">
            <Label>Đơn giá (đ / đơn vị)</Label>
            <Input type="number" value={calc.unitRate} onChange={(e) => setCalc({ unitRate: Number(e.target.value) || 0 })} />
          </div>
        ) : null}
        {calc.type === "RATE_OF_BASIS" ? (
          <div className="space-y-1">
            <Label>Tỷ lệ (%)</Label>
            <Input type="number" step="0.01" value={calc.ratePercent} onChange={(e) => setCalc({ ratePercent: Number(e.target.value) || 0 })} />
          </div>
        ) : null}
        {calc.type === "THRESHOLD_BONUS" ? (
          <>
            <div className="space-y-1">
              <Label>Ngưỡng phải đạt</Label>
              <Input type="number" value={calc.threshold} onChange={(e) => setCalc({ threshold: Number(e.target.value) || 0 })} />
            </div>
            <div className="space-y-1">
              <Label>Thưởng khi đạt (đ)</Label>
              <Input type="number" value={calc.amount} onChange={(e) => setCalc({ amount: Math.round(Number(e.target.value) || 0) })} />
            </div>
          </>
        ) : null}
      </div>

      {calc.type === "TIERED_RATE" ? (
        <div className="space-y-2 rounded-md border bg-muted/40 p-2">
          <p className="text-[11px] text-muted-foreground">
            Mỗi bậc áp cho PHẦN VƯỢT mốc của nó, không áp cho toàn bộ — nếu không, vượt ngưỡng một đồng làm tiền thưởng nhảy một bậc và người ta sẽ giữ đơn lại để rơi vào bên có lợi. Bậc thấp nhất
            phải bắt đầu từ 0.
          </p>
          {calc.tiers.map((t, idx) => (
            <div key={idx} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label>Từ</Label>
                <Input
                  type="number"
                  value={t.from}
                  onChange={(e) => setCalc({ tiers: calc.tiers.map((x, i) => (i === idx ? { ...x, from: Number(e.target.value) || 0 } : x)) })}
                />
              </div>
              <div className="space-y-1">
                <Label>Tỷ lệ (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={t.ratePercent}
                  onChange={(e) => setCalc({ tiers: calc.tiers.map((x, i) => (i === idx ? { ...x, ratePercent: Number(e.target.value) || 0 } : x)) })}
                />
              </div>
              <Button size="sm" variant="ghost" onClick={() => setCalc({ tiers: calc.tiers.filter((_, i) => i !== idx) })} disabled={calc.tiers.length <= 1}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setCalc({ tiers: [...calc.tiers, { from: 0, ratePercent: 0 }] })}>
            <Plus className="size-3.5" /> Thêm bậc
          </Button>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label>Chia theo đoạn</Label>
          <Select value={value.prorate} onValueChange={(v) => onChange({ prorate: v as PolicyComponent["prorate"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYROLL_PRORATE_RULES.map((r) => (
                <SelectItem key={r} value={r}>
                  {PAYROLL_PRORATE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Làm tròn</Label>
          <Select value={value.rounding} onValueChange={(v) => onChange({ rounding: v as PolicyComponent["rounding"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYROLL_ROUNDING_RULES.map((r) => (
                <SelectItem key={r} value={r}>
                  {PAYROLL_ROUNDING_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Sàn (để trống = không có)</Label>
          <Input type="number" value={value.minAmount ?? ""} onChange={(e) => onChange({ minAmount: e.target.value === "" ? null : Math.round(Number(e.target.value)) })} />
        </div>
        <div className="space-y-1">
          <Label>Trần (để trống = không có)</Label>
          <Input type="number" value={value.maxAmount ?? ""} onChange={(e) => onChange({ maxAmount: e.target.value === "" ? null : Math.round(Number(e.target.value)) })} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={value.carryForward} disabled={!carryForwardAllowed(calc)} onCheckedChange={(v) => onChange({ carryForward: v })} />
          <span>
            Bù lỗ lũy kế
            <span className="ml-1 text-[11px] text-muted-foreground">
              {carryForwardAllowed(calc)
                ? "Lỗ kỳ trước được bù trước khi tính; phần âm còn lại chuyển sang kỳ sau."
                : "Chỉ bật được cho khoản tính theo LỢI NHUẬN — doanh thu, số đơn, giờ công và sản lượng không bao giờ âm."}
            </span>
          </span>
        </label>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="size-3.5" /> Bỏ thành phần
        </Button>
      </div>
      <Textarea rows={1} value={value.note} onChange={(e) => onChange({ note: e.target.value })} placeholder="Ghi chú cho người đọc phiếu lương (không tham gia phép tính)" />
    </div>
  );
}
