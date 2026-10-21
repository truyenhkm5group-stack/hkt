"use client";

import { useState, useTransition } from "react";
import { ClipboardPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DEPARTMENT_LABEL, DEPARTMENT_TONE } from "@/lib/constants/departments";
import { DEPARTMENT_COLUMN_LABEL, EVIDENCE_TIER_LABEL } from "@/lib/constants/return-reason-evidence";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { saveManualTask } from "@/lib/actions/work";
import type { CauseBoard, CauseRow } from "@/lib/returns/cause-board";
import { cn } from "@/lib/utils";

/**
 * ═══════════ NGUYÊN NHÂN HOÀN → GIẢI PHÁP → PHÒNG XỬ LÝ ═══════════
 *
 * Mỗi dòng trùng một dòng của bảng nhóm lý do (cách xếp theo chứng cứ) ngay trên trang — cùng số, cùng tập ca. Ba điều phải nhìn thấy
 * được trên chính dòng: cỡ mẫu (dưới ngưỡng thì không xếp hạng, không giao phòng), độ tin (bao nhiêu ca có người xác nhận, bao nhiêu chỉ
 * là lời ĐVVC) và căn cứ xếp ưu tiên. Nút giao việc tạo việc cho PHÒNG, không gán người (AGENTS.md mục 22).
 */
export function CauseBoardTable({ board, periodLabel }: { board: CauseBoard; periodLabel: string }) {
  const [pending, startTransition] = useTransition();
  const [daTao, setDaTao] = useState<Record<string, boolean>>({});

  const taoViec = (r: CauseRow) =>
    startTransition(async () => {
      if (!r.department) return;
      const res = await saveManualTask({
        title: `[Hoàn · ${periodLabel}] ${r.label}: ${formatNumber(r.count)} ca`,
        summary: [
          `Nguồn: Báo cáo tỷ lệ giao thành công → bảng Nguyên nhân & giải pháp (nhóm ${r.group}).`,
          `Số ca: ${r.count} · ${r.shareOfReturns === null ? "—" : formatPercent(r.shareOfReturns)} ca hoàn · ${r.incidence === null ? "—" : formatPercent(r.incidence)} kiện đã gửi.`,
          `Độ tin: ${EVIDENCE_TIER_LABEL.HUMAN_CONFIRMED} ${r.tiers.HUMAN_CONFIRMED} · ${EVIDENCE_TIER_LABEL.CARE_REPORTED} ${r.tiers.CARE_REPORTED} · ${EVIDENCE_TIER_LABEL.CARRIER_OBSERVED} ${r.tiers.CARRIER_OBSERVED}.`,
          `Việc phải làm: ${r.action}`,
        ].join("\n"),
        department: r.department,
        // KHÔNG gán người: trưởng phòng nhận rồi mới giao (AGENTS.md mục 22).
        assigneeId: null,
        priority: r.rank === 1 ? "HIGH" : "NORMAL",
        businessEntity: "REPORT",
        businessEntityId: "reports/returns",
      });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã tạo việc cho phòng — chưa gán người, trưởng phòng nhận rồi giao.");
      setDaTao((x) => ({ ...x, [r.group]: true }));
    });

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        {board.sortBasis} Dưới {board.minSample} ca: không xếp hạng, không giao phòng. Đã có người xác nhận:{" "}
        <b>{board.verificationRate === null ? "—" : formatPercent(board.verificationRate)}</b> ca hoàn · các nguồn nói khác nhau:{" "}
        <b>{board.conflictRate === null ? "—" : formatPercent(board.conflictRate)}</b> · chưa xếp nhóm: <b>{formatNumber(board.ungrouped)}</b> / {formatNumber(board.returned)} ca.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5">#</th>
              <th className="px-2 py-1.5">Nguyên nhân · giải pháp</th>
              <th className="px-2 py-1.5 text-right">Số đơn</th>
              <th className="px-2 py-1.5 text-right">Giá trị đơn hoàn</th>
              <th className="px-2 py-1.5 text-right">So kỳ trước</th>
              <th className="px-2 py-1.5">Độ tin</th>
              <th className="px-2 py-1.5">{DEPARTMENT_COLUMN_LABEL}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {board.rows.map((r) => (
              <tr key={r.group} className="align-top">
                <td className="px-2 py-2 tabular-nums text-muted-foreground">{r.rank ?? "—"}</td>
                <td className="max-w-[360px] px-2 py-2">
                  <div className="font-medium">{r.label}</div>
                  <div className="text-[12px] leading-snug text-muted-foreground">{r.action}</div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <div className="font-medium">{formatNumber(r.count)}</div>
                  <div className="text-[11px] text-muted-foreground" title="Trên tổng ca hoàn · trên kiện đã gửi">
                    {r.shareOfReturns === null ? "—" : formatPercent(r.shareOfReturns)} hoàn · {r.incidence === null ? "—" : formatPercent(r.incidence)} gửi
                  </div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <div>{r.lostValue === null ? "—" : formatVND(r.lostValue, { compact: true })}</div>
                  {r.lostValueUnknown ? <div className="text-[11px] text-muted-foreground">{formatNumber(r.lostValueUnknown)} đơn chưa có giá trị</div> : null}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {r.trend ? (
                    <span title={`Kỳ trước ${r.trend.prevCount} ca`}>
                      {r.trend.deltaPoints > 0 ? "+" : ""}
                      {r.trend.deltaPoints.toLocaleString("vi-VN", { maximumFractionDigits: 1 })} điểm %
                    </span>
                  ) : (
                    <span className="text-muted-foreground" title="Không có kỳ trước cùng độ dài, hoặc kỳ trước dưới cỡ mẫu">
                      —
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-[11px] leading-snug text-muted-foreground">
                  xác nhận {formatNumber(r.tiers.HUMAN_CONFIRMED)} · nhân viên {formatNumber(r.tiers.CARE_REPORTED)} · chỉ ĐVVC {formatNumber(r.tiers.CARRIER_OBSERVED)}
                  {r.tiers.CONFLICTED ? <span className="text-amber-600 dark:text-amber-400"> · mâu thuẫn {formatNumber(r.tiers.CONFLICTED)}</span> : null}
                </td>
                <td className="px-2 py-2">
                  {r.department ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", DEPARTMENT_TONE[r.department])}>{DEPARTMENT_LABEL[r.department]}</span>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={pending || daTao[r.group]} onClick={() => taoViec(r)}>
                        <ClipboardPlus className="size-3.5" /> {daTao[r.group] ? "Đã tạo" : "Giao việc"}
                      </Button>
                    </div>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{r.departmentWhy}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
