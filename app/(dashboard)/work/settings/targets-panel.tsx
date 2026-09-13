"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deleteMetricTarget, setMetricTarget } from "@/lib/actions/metric-targets";
import { METRIC_CATALOG, type MetricSpec } from "@/lib/constants/metric-catalog";
import { TARGET_SCOPE_LABEL, type TargetScope } from "@/lib/constants/metric-targets";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { formatDate } from "@/lib/format";

/**
 * ═══════════ ĐẶT ĐÍCH — BA TẦNG, KHÔNG CÓ SẴN CON SỐ NÀO ═══════════
 *
 * Bảng này bắt đầu RỖNG và ở rỗng cho tới khi chủ shop tự điền. Đó là trạng thái mặc định lâu
 * dài, không phải "chưa cấu hình xong": chưa có đích thì màn hình Hiệu suất vẫn hiện THỰC TẾ, chỉ
 * là không kết luận đạt hay không đạt.
 *
 * Ghi sẵn vài con số "hợp lý" ở đây là lén ra quyết định kinh doanh thay chủ shop, rồi ba tháng
 * sau có người bị chấm không đạt theo một chuẩn không ai trong shop từng đồng ý.
 */
type Row = { id: string; metricKey: string; scope: TargetScope; scopeRef: string | null; target: number; note: string; effectiveFrom: Date; setByEmail: string };

const DAT_DUOC: MetricSpec[] = METRIC_CATALOG.filter((m) => m.availability === "MEASURED" && m.direction !== "CONTEXT");

function donVi(m: MetricSpec) {
  return m.unit === "PERCENT" ? "%" : m.unit === "VND" ? "đ" : m.unit === "DAYS" ? "ngày" : m.unit === "HOURS" ? "giờ" : "";
}

export function TargetsPanel({ rows, positions }: { rows: Row[]; positions: { id: string; name: string }[] }) {
  const [metricKey, setMetricKey] = useState(DAT_DUOC[0]?.key ?? "");
  const [scope, setScope] = useState<TargetScope>("COMPANY");
  const [scopeRef, setScopeRef] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [pending, start] = useTransition();
  const router = useRouter();

  const spec = DAT_DUOC.find((m) => m.key === metricKey) ?? null;
  const phongCuaChiSo = spec?.department ?? null;

  const luu = () =>
    start(async () => {
      const r = await setMetricTarget({
        metricKey,
        scope,
        scopeRef: scope === "COMPANY" ? null : scopeRef || null,
        target: Number(target),
        note,
        effectiveFrom: new Date(`${from}T00:00:00+07:00`),
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã đặt đích");
      setTarget("");
      setNote("");
      router.refresh();
    });

  const xoa = (id: string) =>
    start(async () => {
      const r = await deleteMetricTarget({ id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã bỏ đích — chỉ số quay về hiện thực tế mà không kết luận đạt/không đạt");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1">
          <Label className="text-xs">Chỉ số</Label>
          <Select value={metricKey} onValueChange={setMetricKey}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DAT_DUOC.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {DEPARTMENT_LABEL[m.department]} · {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {spec ? <p className="text-[11px] text-muted-foreground">{spec.definition} Mẫu số: {spec.denominator}.</p> : null}
        </div>

        <div className="grid gap-1">
          <Label className="text-xs">Áp cho</Label>
          <Select
            value={scope}
            onValueChange={(v) => {
              setScope(v as TargetScope);
              setScopeRef(v === "DEPARTMENT" ? (phongCuaChiSo ?? "") : "");
            }}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["COMPANY", "DEPARTMENT", "POSITION"] as TargetScope[]).map((s) => (
                <SelectItem key={s} value={s}>{TARGET_SCOPE_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Tầng hẹp hơn ĐÈ tầng rộng hơn — nói ngay ở đây, không để người dùng tự phát hiện. */}
          <p className="text-[11px] text-muted-foreground">Chức danh đè phòng ban, phòng ban đè công ty.</p>
        </div>

        {scope !== "COMPANY" ? (
          <div className="grid gap-1">
            <Label className="text-xs">{scope === "DEPARTMENT" ? "Phòng ban" : "Chức danh"}</Label>
            <Select value={scopeRef} onValueChange={setScopeRef}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Chọn…" /></SelectTrigger>
              <SelectContent>
                {scope === "DEPARTMENT"
                  ? (Object.keys(DEPARTMENT_LABEL) as DepartmentCode[]).map((d) => <SelectItem key={d} value={d}>{DEPARTMENT_LABEL[d]}</SelectItem>)
                  : positions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="grid gap-1">
          <Label className="text-xs">Đích {spec ? `(${donVi(spec)})` : ""}</Label>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder={spec?.direction === "LOWER_BETTER" ? "càng thấp càng tốt" : "càng cao càng tốt"} />
        </div>

        <div className="grid gap-1">
          <Label className="text-xs">Có hiệu lực từ</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          {/* Kỳ đã chốt TRƯỚC mốc này không bị chấm lại — luật "không sửa ngầm kỳ đã chốt". */}
          <p className="text-[11px] text-muted-foreground">Kỳ đã chốt trước mốc này không bị chấm lại.</p>
        </div>

        <div className="grid gap-1 sm:col-span-2 lg:col-span-3">
          <Label className="text-xs">Vì sao đặt con số này</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: mức đội đạt được đều trong quý trước, cộng 5 điểm" />
        </div>
      </div>

      <Button size="sm" disabled={pending || !metricKey || !target.trim() || note.trim().length < 3 || (scope !== "COMPANY" && !scopeRef)} onClick={luu}>
        Đặt đích
      </Button>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Chưa đặt đích nào. Màn hình Hiệu suất vẫn hiện số thực tế — chỉ là không kết luận đạt hay không đạt. Đó là trạng thái đúng khi shop chưa chốt chuẩn.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chỉ số</TableHead>
                <TableHead>Áp cho</TableHead>
                <TableHead className="text-right">Đích</TableHead>
                <TableHead>Từ ngày</TableHead>
                <TableHead>Lý do</TableHead>
                <TableHead>Người đặt</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const m = METRIC_CATALOG.find((x) => x.key === r.metricKey);
                const ref = r.scope === "DEPARTMENT" ? (DEPARTMENT_LABEL[r.scopeRef as DepartmentCode] ?? r.scopeRef) : r.scope === "POSITION" ? (positions.find((p) => p.id === r.scopeRef)?.name ?? r.scopeRef) : "";
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{m?.label ?? r.metricKey}</TableCell>
                    <TableCell className="text-sm">{TARGET_SCOPE_LABEL[r.scope]}{ref ? ` · ${ref}` : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.target}{m ? donVi(m) : ""}</TableCell>
                    <TableCell className="text-xs">{formatDate(r.effectiveFrom)}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground" title={r.note}>{r.note}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.setByEmail || "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => xoa(r.id)}>Bỏ</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
