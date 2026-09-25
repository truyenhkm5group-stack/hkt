"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PAYROLL_ACTION_SPEC,
  PAYROLL_RUN_STATUS_HINT,
  PAYROLL_RUN_STATUS_LABEL,
  PAYROLL_RUN_STATUSES,
  availableActions,
  type PayrollRunAction,
  type PayrollRunStatus,
} from "@/lib/constants/payroll-lifecycle";
import { movePayrollRun } from "@/lib/actions/payroll-run";
import type { PayrollBasis } from "@/lib/constants/payroll";
import { cn } from "@/lib/utils";

/**
 * ═══ THANH TRẠNG THÁI KỲ LƯƠNG ═══
 *
 * Hiện ĐANG Ở ĐÂU trong sáu bước, và chỉ hiện những nút thật sự bấm được — danh sách ấy đọc từ
 * CÙNG bảng chuyển trạng thái mà máy chủ dùng (`availableActions`). Hai nơi tự viết hai mệnh đề là
 * cách nút hiện rồi server từ chối, bắt người dùng phát hiện luật bằng cách bấm nhầm.
 *
 * Nút của việc người này KHÔNG có quyền thì không hiện — nhưng máy chủ vẫn kiểm lại: một cái nút
 * ẩn không phải một lớp bảo vệ, nó chỉ là một lời gợi ý.
 */
export function RunWorkflow({
  periodKey,
  basis,
  status,
  canManage,
  canApprove,
  calcRuns,
  statusReason,
  approvedByEmail,
  approvedAt,
  lockedAt,
  paidAt,
}: {
  periodKey: string;
  basis: PayrollBasis;
  status: PayrollRunStatus;
  canManage: boolean;
  canApprove: boolean;
  calcRuns: number;
  statusReason: string;
  approvedByEmail: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
  paidAt: string | null;
}) {
  const [pending, start] = useTransition();
  const [reasonFor, setReasonFor] = useState<PayrollRunAction | null>(null);
  const [reason, setReason] = useState("");

  const run = (action: PayrollRunAction, lyDo: string) =>
    start(async () => {
      const r = await movePayrollRun({ periodKey, basis, action, reason: lyDo });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`${PAYROLL_ACTION_SPEC[action].label} — kỳ chuyển sang “${PAYROLL_RUN_STATUS_LABEL[r.status as PayrollRunStatus]}”`, {
        // Việc đi kèm (gửi phiếu khi chuyển soát, lập lệnh chuyển khi khoá) — nói ra cả khi nó hỏng.
        description: r.sideEffects.length ? r.sideEffects.join(" · ") : undefined,
      });
      setReasonFor(null);
      setReason("");
    });

  const allowed = availableActions(status).filter((a) => {
    const need = PAYROLL_ACTION_SPEC[a].permission;
    return need === "payroll:approve" ? canApprove : canManage;
  });
  const idx = PAYROLL_RUN_STATUSES.indexOf(status);

  return (
    <div className="rounded-xl border bg-card p-3 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {PAYROLL_RUN_STATUSES.map((s, i) => (
          <span
            key={s}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium",
              i < idx ? "bg-muted text-muted-foreground" : i === idx ? "bg-primary text-primary-foreground" : "border border-dashed text-muted-foreground",
            )}
            title={PAYROLL_RUN_STATUS_HINT[s]}
          >
            {PAYROLL_RUN_STATUS_LABEL[s].split(" — ")[0]}
          </span>
        ))}
      </div>

      <p className="mt-2 text-muted-foreground">{PAYROLL_RUN_STATUS_HINT[status]}</p>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        {calcRuns > 0 ? <span>Đã tính {calcRuns} lượt</span> : null}
        {approvedAt ? <span>Duyệt {approvedAt}{approvedByEmail ? ` · ${approvedByEmail}` : ""}</span> : null}
        {lockedAt ? <span>Khoá {lockedAt}</span> : null}
        {paidAt ? <span>Đã trả {paidAt}</span> : null}
      </div>

      {statusReason ? <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-400">Lý do lần chuyển gần nhất: {statusReason}</p> : null}

      {allowed.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {allowed.map((a) => {
            const spec = PAYROLL_ACTION_SPEC[a];
            return (
              <Button
                key={a}
                size="sm"
                variant={a === "APPROVE" || a === "LOCK" ? "default" : "outline"}
                disabled={pending}
                title={spec.hint}
                onClick={() => (spec.requiresReason ? setReasonFor(a) : run(a, ""))}
              >
                {spec.label}
                {spec.secondApproval ? <span className="ml-1 text-[10px] opacity-70">cần người thứ hai</span> : null}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Không có việc nào bấm được từ trạng thái này với quyền hiện tại.
          {status === "UNDER_REVIEW" && !canApprove ? " Bước tiếp theo là DUYỆT, và nó cần quyền duyệt lương — người khai số và người duyệt số không nên là một." : ""}
        </p>
      )}

      {reasonFor ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-2">
          <div className="flex-1 space-y-1">
            <label className="text-[12px] font-medium" htmlFor="ly-do">
              Lý do “{PAYROLL_ACTION_SPEC[reasonFor].label}” (bắt buộc)
            </label>
            <Input id="ly-do" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sai ở đâu, hoặc vì sao phải mở khoá" />
          </div>
          <Button size="sm" disabled={pending || reason.trim().length < 3} onClick={() => run(reasonFor, reason.trim())}>
            Xác nhận
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReasonFor(null)}>
            Huỷ
          </Button>
        </div>
      ) : null}
    </div>
  );
}
