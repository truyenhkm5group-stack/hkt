"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/ui-bits";
import { approveCodeRow, endCodeRow, revokeCodeRow, saveCodeAssignment, saveCodeTerms } from "@/lib/actions/payroll-code";

type Option = { id: string; name: string };
export type Suggestion = {
  productId: string;
  code: string;
  productName: string;
  marketerId: string | null;
  marketerName: string;
  monthKey: string;
  spend: number;
  campaigns: number;
  /** Vai trò ĐANG khai cho (mã, người) trong tháng ấy — rỗng = chưa phân công. */
  existingRole: string;
  adsHref: string;
};
type Row = {
  kind: "ASSIGNMENT" | "TERMS";
  id: string;
  code: string;
  employeeName: string;
  role: string | null;
  detail: string;
  from: string;
  to: string | null;
  policyRef: string;
  status: string;
  approvedByName: string;
};

const METHOD_LABEL: Record<string, string> = {
  MANUAL: "Tỷ lệ tay đã duyệt",
  AD_SPEND: "Theo chi phí quảng cáo đối soát được",
  ATTRIBUTED_REVENUE: "Theo doanh thu quy kết",
};

/**
 * ═══ GIAO MKTer VÀO MÃ · KHAI Y% VÀ TRẦN · KẾT THÚC / HUỶ ═══
 *
 * Không có ô sửa tỷ lệ của một dòng: đổi là KẾT THÚC + THÊM MỚI (server action từ chối mọi đường
 * khác). Khai chỉ tạo dòng CHỜ DUYỆT — bảng lương chưa đọc nó cho tới khi có người bấm Duyệt (người
 * khai không tự duyệt, trừ chủ shop). Action `revalidatePath` trang này nên không cần `router.refresh()`.
 */
export function CodeBookManager({ employees, codes, rows, suggestions }: { employees: Option[]; codes: { id: string; label: string }[]; rows: Row[]; suggestions: Suggestion[] }) {
  const [pending, start] = useTransition();
  const [a, setA] = useState({ productId: "", employeeId: "", role: "OWNER", ownerRatePercent: "", weightMethod: "AD_SPEND", weightPercent: "", effectiveFrom: "", effectiveTo: "", policyRef: "", note: "" });
  const [t, setT] = useState({ productId: "", supportPoolPercent: "", maxBonusAmount: "", effectiveFrom: "", effectiveTo: "", policyRef: "", note: "" });
  const run = (fn: () => Promise<{ ok: true } | { error: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(done);
    });

  return (
    <div className="space-y-5">
      {suggestions.length ? (
        <SectionCard
          title="Gợi ý từ dữ liệu quảng cáo"
          description="Ai đã chạy QC cho mã nào, tháng nào (theo ngày chi). Chỉ là căn cứ để NGƯỜI quyết OWNER / SUPPORT — bấm «Điền» chỉ điền sẵn biểu mẫu bên dưới, không lưu gì. Người chi nhiều nhất chưa chắc là người phụ trách mã."
        >
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="sticky top-0 bg-background text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Mã</th>
                  <th className="py-1 pr-3 font-medium">Tháng</th>
                  <th className="py-1 pr-3 font-medium">MKTer</th>
                  <th className="py-1 pr-3 text-right font-medium">Chi phí QC · chiến dịch</th>
                  <th className="py-1 pr-3 font-medium">Đang khai</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={`${s.productId}:${s.marketerId ?? "-"}:${s.monthKey}`} className="border-t">
                    <td className="py-1.5 pr-3 font-medium">{s.code}</td>
                    <td className="py-1.5 pr-3">{s.monthKey}</td>
                    <td className={`py-1.5 pr-3 ${s.marketerId ? "" : "text-rose-700"}`}>{s.marketerId ? s.marketerName : "Chưa gán MKTer"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      <a href={s.adsHref} className="hover:text-primary hover:underline">
                        {Math.round(s.spend).toLocaleString("vi-VN")} ₫ · {s.campaigns}
                      </a>
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{s.existingRole || <span className="text-muted-foreground">chưa phân công</span>}</td>
                    <td className="py-1.5">
                      {s.marketerId && !s.existingRole ? (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => setA({ ...a, productId: s.productId, employeeId: s.marketerId as string, effectiveFrom: `${s.monthKey}-01` })}>
                          Điền
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Giao MKTer vào mã" description="OWNER: X% = TỔNG phần MKT của mã — OWNER nhận X% trên phần lợi nhuận mình làm ra và (X − Y)% trên phần người đẩy cùng làm ra. SUPPORT: Y% trên phần lợi nhuận chính họ làm ra (đo theo doanh thu quy kết / chi phí quảng cáo / đặt tay). Mỗi mã tối đa một OWNER một lúc; OWNER mới tự đóng OWNER cũ ở ngày liền trước, sổ lũy kế của mã KHÔNG reset.">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label>Mã sản phẩm</Label>
            <Select value={a.productId} onValueChange={(x) => setA({ ...a, productId: x })}>
              <SelectTrigger><SelectValue placeholder="Chọn mã" /></SelectTrigger>
              <SelectContent>{codes.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>MKTer</Label>
            <Select value={a.employeeId} onValueChange={(x) => setA({ ...a, employeeId: x })}>
              <SelectTrigger><SelectValue placeholder="Chọn người" /></SelectTrigger>
              <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Vai trò</Label>
            <Select value={a.role} onValueChange={(x) => setA({ ...a, role: x })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="OWNER">OWNER — phụ trách mã</SelectItem>
                <SelectItem value="SUPPORT">SUPPORT — đẩy cùng</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {a.role === "OWNER" ? (
            <div className="space-y-1">
              <Label title="TỔNG phần MKT của mã. OWNER nhận X% trên phần lợi nhuận mình làm ra và (X − Y)% trên phần người đẩy cùng làm ra.">X% (tổng phần MKT của mã)</Label>
              <Input inputMode="decimal" value={a.ownerRatePercent} onChange={(e) => setA({ ...a, ownerRatePercent: e.target.value })} placeholder="vd 10" />
            </div>
          ) : (
            <div className="space-y-1">
              <Label>Cách tính trọng số</Label>
              <Select value={a.weightMethod} onValueChange={(x) => setA({ ...a, weightMethod: x })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(METHOD_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {a.role === "SUPPORT" && a.weightMethod === "MANUAL" ? (
            <div className="space-y-1">
              <Label title="Phần lợi nhuận của mã do người đẩy cùng này làm ra. OWNER lấy phần còn lại của 100%.">% lợi nhuận mã do người này làm ra</Label>
              <Input inputMode="decimal" value={a.weightPercent} onChange={(e) => setA({ ...a, weightPercent: e.target.value })} placeholder="Σ các SUPPORT = 100" />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label>Từ ngày</Label>
            <Input type="date" value={a.effectiveFrom} onChange={(e) => setA({ ...a, effectiveFrom: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Đến ngày (bỏ trống = còn hiệu lực)</Label>
            <Input type="date" value={a.effectiveTo} onChange={(e) => setA({ ...a, effectiveTo: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Số hiệu quy chế / hợp đồng</Label>
            <Input value={a.policyRef} onChange={(e) => setA({ ...a, policyRef: e.target.value })} placeholder="vd QC-THUONG-2026-10" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Ghi chú</Label>
            <Input value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} />
          </div>
        </div>
        <Button
          className="mt-3"
          disabled={pending}
          onClick={() =>
            run(
              () =>
                saveCodeAssignment({
                  ...a,
                  ownerRatePercent: a.role === "OWNER" && a.ownerRatePercent !== "" ? a.ownerRatePercent : undefined,
                  weightMethod: a.role === "SUPPORT" ? a.weightMethod : undefined,
                  weightPercent: a.role === "SUPPORT" && a.weightMethod === "MANUAL" && a.weightPercent !== "" ? a.weightPercent : undefined,
                }),
              "Đã khai phân công — CHỜ DUYỆT, chưa áp vào lương",
            )
          }
        >
          <Plus className="mr-1 size-4" /> Giao vào mã
        </Button>
      </SectionCard>

      <SectionCard title="Điều khoản thưởng theo mã" description="Y% = phần của người đẩy cùng trên lợi nhuận CHÍNH HỌ làm ra (không vượt X% của OWNER — tổng vẫn là X%); trần = tổng thưởng tối đa của mã mỗi tháng. Bỏ trống mã = điều khoản MẶC ĐỊNH công ty (điều khoản của mã thắng).">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label>Mã (bỏ trống = mặc định công ty)</Label>
            <Select value={t.productId || "*"} onValueChange={(x) => setT({ ...t, productId: x === "*" ? "" : x })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="*">Mặc định công ty</SelectItem>
                {codes.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label title="Phần của người đẩy cùng trên lợi nhuận CHÍNH HỌ làm ra. OWNER giữ (X − Y)% trên phần ấy — tổng vẫn là X%.">Y% (người đẩy cùng, trên phần họ làm ra)</Label>
            <Input inputMode="decimal" value={t.supportPoolPercent} onChange={(e) => setT({ ...t, supportPoolPercent: e.target.value })} placeholder="vd 5" />
          </div>
          <div className="space-y-1">
            <Label>Trần thưởng của mã / tháng (₫, bỏ trống = không có trần)</Label>
            <Input inputMode="numeric" value={t.maxBonusAmount} onChange={(e) => setT({ ...t, maxBonusAmount: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Số hiệu quy chế / hợp đồng</Label>
            <Input value={t.policyRef} onChange={(e) => setT({ ...t, policyRef: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Từ ngày</Label>
            <Input type="date" value={t.effectiveFrom} onChange={(e) => setT({ ...t, effectiveFrom: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Đến ngày (bỏ trống = còn hiệu lực)</Label>
            <Input type="date" value={t.effectiveTo} onChange={(e) => setT({ ...t, effectiveTo: e.target.value })} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Ghi chú</Label>
            <Input value={t.note} onChange={(e) => setT({ ...t, note: e.target.value })} />
          </div>
        </div>
        <Button className="mt-3" disabled={pending} onClick={() => run(() => saveCodeTerms(t), "Đã khai điều khoản — CHỜ DUYỆT, chưa áp vào lương")}>
          <Plus className="mr-1 size-4" /> Khai điều khoản
        </Button>
      </SectionCard>

      <SectionCard title="Sổ phân công & điều khoản" description="Mọi dòng, kể cả đã kết thúc hoặc huỷ. Kết thúc = rút ngắn hiệu lực; huỷ chỉ cho dòng nhập nhầm chưa chạm tháng đã khoá.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Mã</th>
                <th className="py-1 pr-3 font-medium">MKTer · Vai trò</th>
                <th className="py-1 pr-3 font-medium">Tỷ lệ</th>
                <th className="py-1 pr-3 font-medium">Hiệu lực</th>
                <th className="py-1 pr-3 font-medium">Quy chế · Duyệt</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RowView key={`${r.kind}:${r.id}`} r={r} pending={pending} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function RowView({ r, pending, run }: { r: Row; pending: boolean; run: (fn: () => Promise<{ ok: true } | { error: string }>, done: string) => void }) {
  const [den, setDen] = useState("");
  const active = r.status === "APPROVED";
  const cho = r.status === "PENDING";
  return (
    <tr className={`border-t align-top ${active ? "" : cho ? "bg-amber-50/60 dark:bg-amber-950/20" : "text-muted-foreground line-through"}`}>
      <td className="py-1.5 pr-3 font-medium">{r.code}</td>
      <td className="py-1.5 pr-3">{r.kind === "TERMS" ? "Điều khoản" : `${r.employeeName} · ${r.role}`}</td>
      <td className="py-1.5 pr-3">{r.detail}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        {r.from} → {r.to ?? "còn hiệu lực"}
      </td>
      <td className="py-1.5 pr-3">
        {r.policyRef}
        <div className="text-xs text-muted-foreground">{cho ? "Chờ duyệt — chưa áp vào lương" : r.approvedByName || "—"}</div>
      </td>
      <td className="py-1.5">
        {active ? (
          <div className="flex flex-wrap items-center gap-1">
            <Input type="date" className="h-7 w-[140px]" value={den} onChange={(e) => setDen(e.target.value)} />
            <Button size="sm" variant="outline" disabled={pending || !den} onClick={() => run(() => endCodeRow({ kind: r.kind, id: r.id, effectiveTo: den }), "Đã kết thúc hiệu lực")}>
              Kết thúc
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                const ly = window.prompt("Lý do huỷ (dòng nhập nhầm):");
                if (ly) run(() => revokeCodeRow({ kind: r.kind, id: r.id, reason: ly }), "Đã huỷ dòng");
              }}
            >
              Huỷ
            </Button>
          </div>
        ) : cho ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" disabled={pending} onClick={() => run(() => approveCodeRow({ kind: r.kind, id: r.id }), "Đã duyệt — dòng có hiệu lực từ ngày bắt đầu")}>
              Duyệt
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                const ly = window.prompt("Lý do từ chối:");
                if (ly) run(() => revokeCodeRow({ kind: r.kind, id: r.id, reason: ly }), "Đã từ chối dòng chờ");
              }}
            >
              Từ chối
            </Button>
          </div>
        ) : (
          <span className="text-xs">Đã huỷ</span>
        )}
      </td>
    </tr>
  );
}
