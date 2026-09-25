"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deleteMetricTarget, setMetricTarget } from "@/lib/actions/metric-targets";
import {
  metricOf,
  scopesFor,
  TARGETABLE_METRICS,
  TARGET_SCOPE_LABEL,
  type TargetableMetric,
  type TargetScope,
} from "@/lib/constants/metric-registry";
import { PERIOD_KINDS, PERIOD_KIND_LABEL, type PeriodKind } from "@/lib/constants/metric-targets";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { formatDate, todayVN } from "@/lib/format";

/**
 * ═══════════ ĐẶT ĐÍCH — KHÔNG CÓ SẴN CON SỐ NÀO, VÀ KHÔNG CẦN SỬA CODE ĐỂ ĐẶT ═══════════
 *
 * Bảng này bắt đầu RỖNG và ở rỗng cho tới khi chủ shop tự điền. Đó là trạng thái mặc định lâu
 * dài, không phải "chưa cấu hình xong": chưa có đích thì màn hình Hiệu suất và bảng Rủi ro theo
 * mã hàng vẫn hiện THỰC TẾ và vẫn XẾP HẠNG được, chỉ là không kết luận đạt hay không đạt.
 *
 * Ghi sẵn vài con số "hợp lý" ở đây là lén ra quyết định kinh doanh thay chủ shop, rồi ba tháng
 * sau có người bị chấm không đạt theo một chuẩn không ai trong shop từng đồng ý.
 *
 * ─── VÌ SAO DANH SÁCH CHỈ SỐ ĐỌC TỪ SỔ GỘP, KHÔNG PHẢI `METRIC_CATALOG` ───
 *
 * Bản trước lọc thẳng `METRIC_CATALOG` nên ô chọn chỉ có 14 chỉ số HIỆU SUẤT. Hệ quả đo được:
 * chủ shop KHÔNG có đường nào đặt đích cho "tỷ lệ giao thành công" — chỉ số nằm ở sổ kia
 * (`METRIC_BINDINGS`) — dù `metric_targets` vẫn nhận khoá đó và `resolveTarget` vẫn tra được nó.
 * Bảng Rủi ro theo mã hàng vì thế hiện "Chưa đặt mục tiêu" vĩnh viễn, và cách duy nhất để thoát là
 * sửa code. `TARGETABLE_METRICS` là hợp của hai sổ — đúng cái không gian khoá mà lược đồ đầu vào
 * đang dùng, nên ô chọn và cửa kiểm nói cùng một thứ.
 */
type Row = {
  id: string;
  metricKey: string;
  scope: TargetScope;
  scopeRef: string | null;
  target: number;
  targetMax: number | null;
  warningAt: number | null;
  criticalAt: number | null;
  periodKind: PeriodKind;
  note: string;
  effectiveFrom: Date;
  setByEmail: string;
};

/** Mọi chỉ số ĐO ĐƯỢC của cả hai sổ, xếp theo phòng rồi theo tên để tìm bằng mắt. */
const DAT_DUOC: TargetableMetric[] = Object.values(TARGETABLE_METRICS)
  .filter((m) => m.targetable)
  .sort((a, b) => (a.department ?? "zz").localeCompare(b.department ?? "zz") || a.label.localeCompare(b.label, "vi"));

function donVi(m: TargetableMetric) {
  return m.unit === "PERCENT" ? "%" : m.unit === "VND" ? "đ" : m.unit === "DAYS" ? "ngày" : m.unit === "HOURS" ? "giờ" : "";
}

function tenPhong(d: string | null) {
  return d ? (DEPARTMENT_LABEL[d as DepartmentCode] ?? d) : "Toàn shop";
}

/** Số gõ tay → số thật. Ô trống là CHƯA KHAI (`null`), không phải 0 — luật AGENTS.md mục 42. */
function so(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

export function TargetsPanel({
  rows,
  positions,
  users,
  productCodes,
}: {
  rows: Row[];
  positions: { id: string; name: string }[];
  /** Tài khoản ERP — khoá của đích tầng `USER` là `users.id`, không phải một cái tên. */
  users: { id: string; name: string; email: string }[];
  productCodes: { code: string; name: string }[];
}) {
  const [metricKey, setMetricKey] = useState(DAT_DUOC[0]?.key ?? "");
  const [scope, setScope] = useState<TargetScope>("COMPANY");
  const [scopeRef, setScopeRef] = useState("");
  const [target, setTarget] = useState("");
  const [warningAt, setWarningAt] = useState("");
  const [criticalAt, setCriticalAt] = useState("");
  const [periodKind, setPeriodKind] = useState<PeriodKind>("ANY");
  const [note, setNote] = useState("");
  const [from, setFrom] = useState(() => todayVN());
  const [pending, start] = useTransition();

  const spec = metricOf(metricKey);
  const phamVi = useMemo(() => scopesFor(metricKey), [metricKey]);
  const phongCuaChiSo = spec?.department ?? null;
  // Đổi chỉ số có thể làm phạm vi đang chọn thành không hợp lệ (mã hàng chỉ mở cho vài chỉ số).
  const scopeThat: TargetScope = phamVi.includes(scope) ? scope : "COMPANY";

  const doiChiSo = (k: string) => {
    setMetricKey(k);
    if (!scopesFor(k).includes(scope)) {
      setScope("COMPANY");
      setScopeRef("");
    }
  };

  const luu = () =>
    start(async () => {
      const r = await setMetricTarget({
        metricKey,
        scope: scopeThat,
        scopeRef: scopeThat === "COMPANY" ? null : scopeRef || null,
        target: Number(target),
        warningAt: so(warningAt),
        criticalAt: so(criticalAt),
        periodKind,
        note,
        effectiveFrom: new Date(`${from}T00:00:00+07:00`),
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã đặt mục tiêu");
      setTarget("");
      setWarningAt("");
      setCriticalAt("");
      setNote("");
    });

  const xoa = (id: string) =>
    start(async () => {
      const r = await deleteMetricTarget({ id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã bỏ mục tiêu — chỉ số quay về hiện thực tế mà không kết luận đạt/không đạt");
    });

  const nhanRef = scopeThat === "DEPARTMENT" ? "Phòng ban" : scopeThat === "POSITION" ? "Chức danh" : scopeThat === "PRODUCT" ? "Mã hàng" : "Cá nhân";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1">
          <Label className="text-xs">Chỉ số</Label>
          <Select value={metricKey} onValueChange={doiChiSo}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DAT_DUOC.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {tenPhong(m.department)} · {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {spec ? <p className="text-[11px] text-muted-foreground">{spec.basis}</p> : null}
        </div>

        <div className="grid gap-1">
          <Label className="text-xs">Áp cho</Label>
          <Select
            value={scopeThat}
            onValueChange={(v) => {
              setScope(v as TargetScope);
              setScopeRef(v === "DEPARTMENT" ? (phongCuaChiSo ?? "") : "");
            }}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {phamVi.map((s) => (
                <SelectItem key={s} value={s}>{TARGET_SCOPE_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Tầng hẹp hơn ĐÈ tầng rộng hơn — nói ngay ở đây, không để người dùng tự phát hiện. */}
          <p className="text-[11px] text-muted-foreground">
            {phamVi.includes("PRODUCT")
              ? "Mã hàng đè cá nhân, cá nhân đè chức danh, chức danh đè phòng ban, phòng ban đè công ty."
              : "Cá nhân đè chức danh, chức danh đè phòng ban, phòng ban đè công ty."}
          </p>
        </div>

        {scopeThat !== "COMPANY" ? (
          <div className="grid gap-1">
            <Label className="text-xs">{nhanRef}</Label>
            <Select value={scopeRef} onValueChange={setScopeRef}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Chọn…" /></SelectTrigger>
              <SelectContent>
                {scopeThat === "DEPARTMENT"
                  ? (Object.keys(DEPARTMENT_LABEL) as DepartmentCode[]).map((d) => <SelectItem key={d} value={d}>{DEPARTMENT_LABEL[d]}</SelectItem>)
                  : scopeThat === "PRODUCT"
                    ? productCodes.map((p) => (
                        <SelectItem key={p.code} value={p.code}>
                          {p.code} · {p.name}
                        </SelectItem>
                      ))
                    : /*
                        CÁ NHÂN và CHỨC DANH là HAI không gian khoá khác nhau, và nhánh này từng gộp
                        chúng làm một. Lúc ấy không chỉ số nào mở tầng `USER` nên nhánh sai nằm im;
                        mở tầng ấy cho CPQC/đơn và tỷ lệ chốt là nó thành đường ghi một `positions.id`
                        vào ô lẽ ra giữ `users.id` — dòng đích sẽ không bao giờ khớp ai, và màn hình
                        vẫn nói "chưa đặt mục tiêu" mà không báo lỗi ở đâu cả.
                      */
                      scopeThat === "USER"
                      ? users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name} · {u.email}
                          </SelectItem>
                        ))
                      : positions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {scopeThat === "PRODUCT" ? (
              <p className="text-[11px] text-muted-foreground">Mã mới ra mắt có thể nhận mức riêng, thấp hơn mức chung của shop.</p>
            ) : null}
            {scopeThat === "USER" ? (
              <p className="text-[11px] text-muted-foreground">
                Chỉ những chỉ số ĐO ĐƯỢC ở mức một người và KHÔNG phải kết quả chung mới mở tầng này — tỷ lệ giao thành công, tỷ lệ hoàn, ROAS thực và margin cố ý không có ở đây vì ĐVVC đồng quyết
                định chúng.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-1">
          <Label className="text-xs">Mục tiêu {spec ? `(${donVi(spec)})` : ""}</Label>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder={spec?.direction === "LOWER_BETTER" ? "càng thấp càng tốt" : "càng cao càng tốt"} />
        </div>

        <div className="grid gap-1">
          <Label className="text-xs">Áp cho kỳ</Label>
          <Select value={periodKind} onValueChange={(v) => setPeriodKind(v as PeriodKind)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERIOD_KINDS.map((k) => (
                <SelectItem key={k} value={k}>{PERIOD_KIND_LABEL[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* "Mọi kỳ" là CHƯA KHAI, không phải "mỗi tháng" — AGENTS.md mục 43. */}
          <p className="text-[11px] text-muted-foreground">Đích “500 đơn” không nói gì nếu thiếu vế “một tháng”.</p>
        </div>

        <div className="grid gap-1">
          <Label className="text-xs">Có hiệu lực từ</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          {/* Kỳ đã chốt TRƯỚC mốc này không bị chấm lại — luật "không sửa ngầm kỳ đã chốt". */}
          <p className="text-[11px] text-muted-foreground">Kỳ đã chốt trước mốc này không bị chấm lại.</p>
        </div>

        {/*
          NGƯỠNG CẢNH BÁO là hai mức TUỲ CHỌN nằm giữa "đạt" và "hỏng hẳn". Bỏ trống thì thẻ điểm
          chỉ có hai màu, và đó là một lựa chọn hợp lệ — không có bộ ngưỡng mặc định nào ở đây.
        */}
        <div className="grid gap-1">
          <Label className="text-xs">Ngưỡng cảnh báo {spec ? `(${donVi(spec)})` : ""}</Label>
          <Input value={warningAt} onChange={(e) => setWarningAt(e.target.value)} inputMode="decimal" placeholder="bỏ trống nếu chưa cần" />
        </div>

        <div className="grid gap-1">
          <Label className="text-xs">Ngưỡng báo động {spec ? `(${donVi(spec)})` : ""}</Label>
          <Input value={criticalAt} onChange={(e) => setCriticalAt(e.target.value)} inputMode="decimal" placeholder="bỏ trống nếu chưa cần" />
        </div>

        <div className="grid gap-1 sm:col-span-2 lg:col-span-3">
          <Label className="text-xs">Vì sao đặt con số này</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: mức đội đạt được đều trong quý trước, cộng 5 điểm" />
        </div>
      </div>

      <Button size="sm" disabled={pending || !metricKey || !target.trim() || note.trim().length < 3 || (scopeThat !== "COMPANY" && !scopeRef)} onClick={luu}>
        Đặt mục tiêu
      </Button>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Chưa đặt mục tiêu nào. Màn hình Hiệu suất và bảng Rủi ro theo mã hàng vẫn hiện số thực tế và vẫn xếp hạng được — chỉ là không kết luận đạt hay không đạt. Đó là trạng thái đúng khi shop chưa chốt chuẩn.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chỉ số</TableHead>
                <TableHead>Áp cho</TableHead>
                <TableHead className="text-right">Mục tiêu</TableHead>
                <TableHead>Kỳ</TableHead>
                <TableHead>Từ ngày</TableHead>
                <TableHead>Lý do</TableHead>
                <TableHead>Người đặt</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const m = metricOf(r.metricKey);
                const ref =
                  r.scope === "DEPARTMENT"
                    ? (DEPARTMENT_LABEL[r.scopeRef as DepartmentCode] ?? r.scopeRef)
                    : r.scope === "POSITION"
                      ? (positions.find((p) => p.id === r.scopeRef)?.name ?? r.scopeRef)
                    : r.scope === "USER"
                      ? (users.find((u) => u.id === r.scopeRef)?.name ?? r.scopeRef)
                      : r.scope === "PRODUCT"
                        ? r.scopeRef
                        : "";
                const nguong = [r.warningAt !== null ? `cảnh báo ${r.warningAt}` : "", r.criticalAt !== null ? `báo động ${r.criticalAt}` : ""].filter(Boolean).join(" · ");
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{m?.label ?? r.metricKey}</TableCell>
                    <TableCell className="text-sm">{TARGET_SCOPE_LABEL[r.scope]}{ref ? ` · ${ref}` : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.target}{m ? donVi(m) : ""}
                      {nguong ? <div className="text-[11px] font-normal text-muted-foreground">{nguong}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs">{PERIOD_KIND_LABEL[r.periodKind]}</TableCell>
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
