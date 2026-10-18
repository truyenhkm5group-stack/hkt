"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui-bits";
import { saveProfitGateAdjustment, saveProfitGatePolicy } from "@/lib/actions/payroll-policy";
import type { ProfitGateConfig } from "@/lib/constants/payroll-profit-gate";
import { formatDateTime, formatVND } from "@/lib/format";

/**
 * ═══ QUY CHẾ CHIA THƯỞNG LỢI NHUẬN — CỔNG LỖ LŨY KẾ TOÀN CÔNG TY ═══
 *
 * Mỗi lần lưu là một PHIÊN BẢN MỚI (bản cũ giữ nguyên ở bảng lịch sử bên dưới), mang tên người duyệt
 * và mốc thời gian. Không có giá trị điền sẵn: số dư lũy kế là con số kế toán đã đối soát, quỹ thưởng
 * là quyết định của quy chế — ERP không đoán hộ cả hai.
 */
export function ProfitGateForm({ config, canApprove }: { config: ProfitGateConfig; canApprove: boolean }) {
  const [pending, start] = useTransition();
  const a = config.active;
  const [f, setF] = useState({
    openingMonth: a?.openingMonth ?? "",
    openingCumulative: a ? String(a.openingCumulative) : "",
    openingHighWater: a ? String(a.openingHighWater) : "",
    openingPaidBonus: a ? String(a.openingPaidBonus) : "0",
    poolCapPercent: a ? String(a.poolCapPercent) : "",
    regulationRef: a?.regulationRef ?? "",
    reason: "",
  });
  const [dc, setDc] = useState({ monthKey: "", aboutMonth: "", amount: "", reason: "" });
  const setD = (k: keyof typeof dc) => (e: React.ChangeEvent<HTMLInputElement>) => setDc((s) => ({ ...s, [k]: e.target.value }));
  const ghiDc = () =>
    start(async () => {
      const r = await saveProfitGateAdjustment(dc);
      if ("error" in r) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      setDc({ monthKey: "", aboutMonth: "", amount: "", reason: "" });
      toast.success("Đã ghi điều chỉnh lũy kế");
    });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const luu = () =>
    start(async () => {
      const r = await saveProfitGatePolicy(f);
      if ("error" in r) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      toast.success("Đã lưu phiên bản quy chế chia thưởng lợi nhuận mới");
    });

  return (
    <SectionCard
      title="Quy chế chia thưởng lợi nhuận (cổng lỗ lũy kế toàn công ty)"
      description="Thưởng % lợi nhuận — kể cả % lợi nhuận cá nhân — chỉ được duyệt từ phần lợi nhuận còn lại SAU KHI công ty đã bù hết lỗ lũy kế và vượt mốc cao nhất đã chia. Chưa khai quy chế thì mọi khoản thưởng % lợi nhuận là “chưa đủ điều kiện” và kỳ lương có khoản ấy không chốt được."
    >
      <div className="space-y-3 text-[13px]">
        {a ? (
          <div className="rounded-md border p-2">
            <p>
              <b>Đang hiệu lực: v{a.version}</b> · {a.regulationRef} · mở sổ tháng <b>{a.openingMonth}</b> · lũy kế đầu{" "}
              <b className={a.openingCumulative < 0 ? "text-destructive" : ""}>{formatVND(a.openingCumulative)}</b> · mốc cao nhất đã chia {formatVND(a.openingHighWater)} · quỹ tối đa{" "}
              <b>{a.poolCapPercent}%</b> lợi nhuận đủ điều kiện
            </p>
            <p className="text-[11px] text-muted-foreground">
              Duyệt bởi {a.approvedByEmail} lúc {formatDateTime(new Date(a.approvedAt))}. Căn cứ: {a.reason}
            </p>
          </div>
        ) : (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <b>Chưa khai quy chế.</b> Thưởng % lợi nhuận đang ở trạng thái “chưa đủ điều kiện duyệt”. Rà soát hợp đồng và quy chế thưởng hiện hành trước khi khai.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pg-month">Tháng mở sổ — ngày hiệu lực (YYYY-MM)</Label>
            <Input id="pg-month" value={f.openingMonth} onChange={set("openingMonth")} placeholder="2026-11" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pg-cum">Lợi nhuận lũy kế tới hết tháng trước (₫, âm = lỗ)</Label>
            <Input id="pg-cum" inputMode="numeric" value={f.openingCumulative} onChange={set("openingCumulative")} placeholder="-150000000" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pg-hwm">Mốc cao nhất đã chia (₫, ≥ 0)</Label>
            <Input id="pg-hwm" inputMode="numeric" value={f.openingHighWater} onChange={set("openingHighWater")} placeholder="0" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pg-paid">Thưởng lợi nhuận đã chi trước mốc (₫)</Label>
            <Input id="pg-paid" inputMode="numeric" value={f.openingPaidBonus} onChange={set("openingPaidBonus")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pg-cap">Quỹ thưởng tối đa (% lợi nhuận đủ điều kiện)</Label>
            <Input id="pg-cap" inputMode="decimal" value={f.poolCapPercent} onChange={set("poolCapPercent")} placeholder="40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pg-ref">Số hiệu / tên quy chế thưởng</Label>
            <Input id="pg-ref" value={f.regulationRef} onChange={set("regulationRef")} placeholder="Quy chế thưởng 01/2026" />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pg-reason">Căn cứ của số dư (biên bản đối soát, báo cáo tài chính…)</Label>
          <Input id="pg-reason" value={f.reason} onChange={set("reason")} placeholder="Biên bản đối soát lỗ lũy kế đến 31/10/2026 do kế toán lập" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Lưu là tạo phiên bản mới; tháng đã khoá không bị tính lại. Cần cả quyền “Khai báo lương” và “Duyệt lương”, và có thể cần người thứ hai duyệt.
        </p>
        <Button size="sm" onClick={luu} disabled={pending || !canApprove}>
          <Save className="size-4" /> Lưu phiên bản quy chế
        </Button>
        {!canApprove ? <p className="text-[11px] text-muted-foreground">Bạn chưa có quyền “Duyệt lương” nên chỉ xem được.</p> : null}

        {a ? (
          <div className="space-y-2 rounded-md border p-2">
            <p className="font-medium">Điều chỉnh lũy kế — chứng từ đến muộn của tháng đã khoá</p>
            <p className="text-[11px] text-muted-foreground">
              Tháng đã khoá không bao giờ tự tính lại (giá vốn, giá báo MKT và giả định chi phí hôm nay khác lúc khoá, nên “tính lại” trộn chứng từ muộn với một lần đổi giá). Đơn hoàn về muộn hay chi phí nhập
              muộn của tháng đã khoá ghi ở đây: vào một tháng CÒN MỞ, có dấu (âm = làm giảm lợi nhuận), cộng vào lợi nhuận đem xét của tháng ấy đúng một lần. Chỉ thêm — sai thì ghi một dòng ngược dấu.
            </p>
            <div className="grid gap-2 sm:grid-cols-4">
              <Input aria-label="Tháng ghi (đang mở)" value={dc.monthKey} onChange={setD("monthKey")} placeholder="Tháng ghi 2026-11" />
              <Input aria-label="Tháng chứng từ (đã khoá)" value={dc.aboutMonth} onChange={setD("aboutMonth")} placeholder="Tháng chứng từ 2026-10" />
              <Input aria-label="Số tiền có dấu" inputMode="numeric" value={dc.amount} onChange={setD("amount")} placeholder="-3000000" />
              <Input aria-label="Lý do" value={dc.reason} onChange={setD("reason")} placeholder="12 đơn tháng 10 hoàn về sau ngày khoá" />
            </div>
            <Button size="sm" variant="outline" onClick={ghiDc} disabled={pending || !canApprove}>
              <Save className="size-4" /> Ghi điều chỉnh
            </Button>
            {config.adjustments.length ? (
              <table className="w-full text-[12px]">
                <tbody>
                  {[...config.adjustments].reverse().map((x) => (
                    <tr key={x.id} className="border-t align-top">
                      <td className="py-1 pr-2">ghi vào {x.monthKey}</td>
                      <td className="py-1 pr-2">{x.aboutMonth ? `chứng từ ${x.aboutMonth}` : "—"}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{formatVND(x.amount, { sign: true })}</td>
                      <td className="py-1 pr-2">{x.reason}</td>
                      <td className="py-1 text-muted-foreground">
                        {x.approvedByEmail} · {formatDateTime(new Date(x.approvedAt))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}

        {config.history.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">Bản</th>
                  <th className="py-1 pr-2 font-medium">Mở sổ</th>
                  <th className="py-1 pr-2 text-right font-medium">Lũy kế đầu</th>
                  <th className="py-1 pr-2 text-right font-medium">Quỹ tối đa</th>
                  <th className="py-1 pr-2 font-medium">Quy chế</th>
                  <th className="py-1 font-medium">Người duyệt · lúc</th>
                </tr>
              </thead>
              <tbody>
                {[...config.history].reverse().map((h) => (
                  <tr key={h.version} className="border-t align-top">
                    <td className="py-1 pr-2">v{h.version}</td>
                    <td className="py-1 pr-2">{h.openingMonth}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatVND(h.openingCumulative)}</td>
                    <td className="py-1 pr-2 text-right">{h.poolCapPercent}%</td>
                    <td className="py-1 pr-2">{h.regulationRef}</td>
                    <td className="py-1 text-muted-foreground">
                      {h.approvedByEmail} · {formatDateTime(new Date(h.approvedAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
