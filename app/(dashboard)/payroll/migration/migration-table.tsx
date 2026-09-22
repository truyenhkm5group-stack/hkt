"use client";

import { useState, useTransition } from "react";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui-bits";
import { migrateEmployeeToPolicy } from "@/lib/actions/payroll-policy";
import {
  MIGRATION_STATUSES,
  MIGRATION_STATUS_HINT,
  MIGRATION_STATUS_LABEL,
  migrationStatus,
  type MigrationProposal,
  type MigrationStatus,
  type ReconResult,
} from "@/lib/payroll/migration-preview";
import { MISSING_TEXT, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

type Row = { proposal: MigrationProposal; recon: ReconResult | null; alreadyMigrated: boolean; hasEmployment: boolean };

/**
 * ═══ XEM TRƯỚC RỒI MỚI BẤM, VÀ BẤM TỪNG NGƯỜI MỘT ═══
 *
 * Cố ý KHÔNG có nút "chuyển tất cả". Một nút như thế là một lượt đổi cách trả tiền cho tất cả mọi
 * người mà không ai kịp đọc bảng đối chiếu của từng người — và bảng đối chiếu chỉ có giá trị khi
 * có người THẬT SỰ nhìn nó.
 */
/** Màu của nhãn. Chỉ là trình bày — trạng thái do `migrationStatus()` quyết, không do màu. */
const STATUS_CLASS: Record<MigrationStatus, string> = {
  MIGRATED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  BLOCKED: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  DIFF: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  READY: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  LEGACY: "bg-muted text-muted-foreground",
};

export function MigrationTable({ rows, effectiveFrom }: { rows: Row[]; effectiveFrom: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const apply = (r: Row, lyDo: string) =>
    start(async () => {
      const res = await migrateEmployeeToPolicy({
        employeeId: r.proposal.employeeId,
        policyCode: r.proposal.policyCode,
        policyName: r.proposal.policyName,
        effectiveFrom,
        components: r.proposal.components,
        acknowledgedDiff: lyDo,
        hasUnexplainedDiff: Boolean(r.recon?.hasUnexplained),
      });
      if ("error" in res) {
        toast.error(res.error, { duration: 12000 });
        return;
      }
      toast.success(`Đã chuyển ${r.proposal.employeeName} sang máy tính chung, hiệu lực từ ${effectiveFrom}`);
      setReasonFor(null);
      setReason("");
      router.refresh();
    });

  if (!rows.length) {
    return (
      <SectionCard title="Không có nhân sự nào để xem trước">
        <p className="text-[13px] text-muted-foreground">Chưa khai nhân sự nào đang làm việc ở hồ sơ cũ, hoặc kỳ đang chọn không có mốc đầu/cuối.</p>
      </SectionCard>
    );
  }

  const statusOf = (r: Row) =>
    migrationStatus({
      alreadyMigrated: r.alreadyMigrated,
      blockers: r.proposal.blockers,
      componentCount: r.proposal.components.length,
      hasUnexplainedDiff: Boolean(r.recon?.hasUnexplained),
    });
  const dem = (s: MigrationStatus) => rows.filter((r) => statusOf(r) === s).length;

  return (
    <div className="space-y-4">
      {/*
        BẢNG ĐẾM THEO TRẠNG THÁI, ĐỨNG TRƯỚC DANH SÁCH.

        Nó trả lời câu hỏi đầu tiên của người mở trang — "còn bao nhiêu người phải xử lý, và vướng
        ở đâu" — mà không phải cuộn hết danh sách rồi tự đếm.
      */}
      <div className="flex flex-wrap gap-2">
        {MIGRATION_STATUSES.map((s) => (
          <span key={s} title={MIGRATION_STATUS_HINT[s]} className={cn("rounded-md px-2 py-1 text-[12px] font-medium", STATUS_CLASS[s])}>
            {MIGRATION_STATUS_LABEL[s]}: {dem(s)}
          </span>
        ))}
      </div>

      {rows.map((r) => {
        const p = r.proposal;
        const lech = r.recon?.lines.filter((l) => l.diff !== 0) ?? [];
        const trangThai = statusOf(r);
        const chanDuoc = p.blockers.length === 0 && p.components.length > 0 && !r.alreadyMigrated;
        return (
          <SectionCard
            key={p.employeeId}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {p.employeeName}
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_CLASS[trangThai])} title={MIGRATION_STATUS_HINT[trangThai]}>
                  {MIGRATION_STATUS_LABEL[trangThai]}
                </span>
                {!r.hasEmployment ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">Chưa khai phân công</span> : null}
              </span>
            }
            description={p.components.length ? `Đề xuất ${p.components.length} thành phần: ${p.components.map((c) => c.label).join(" · ")}` : "Không có gì để ánh xạ."}
          >
            {p.blockers.length ? (
              <ul className="mb-3 list-disc space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 pl-6 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {p.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            ) : null}
            {p.notes.map((n, i) => (
              <p key={i} className="mb-2 text-[12px] text-muted-foreground">
                {n}
              </p>
            ))}

            {r.recon ? (
              <>
                <TableToolsFor tableId="payroll-migration-migration-table" />
                <div className="overflow-x-auto">
                  <table id="payroll-migration-migration-table" className="w-full min-w-[720px] text-[13px]">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-medium">Khoản</th>
                        <th className="py-1 pr-3 text-right font-medium">Đường cũ</th>
                        <th className="py-1 pr-3 text-right font-medium">Máy chung</th>
                        <th className="py-1 pr-3 text-right font-medium">Lệch</th>
                        <th className="py-1 font-medium">Giải thích</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.recon.lines.map((l) => (
                        <tr key={l.key} className={cn("border-t align-top", l.key === "net" ? "font-semibold" : "")}>
                          <td className="py-1.5 pr-3">{l.label}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{l.old === null ? MISSING_TEXT : formatVND(l.old)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{l.next === null ? MISSING_TEXT : formatVND(l.next)}</td>
                          <td className={cn("py-1.5 pr-3 text-right tabular-nums", l.diff ? "text-rose-700 dark:text-rose-400" : "")}>
                            {l.diff === null ? MISSING_TEXT : l.diff === 0 ? "0 ₫" : formatVND(l.diff, { sign: true })}
                          </td>
                          <td className="py-1.5 text-[11px] text-muted-foreground">{l.explanation || (l.diff === 0 ? "Khớp." : "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-[13px] text-muted-foreground">Kỳ này không có dòng lương nào của người này ở đường cũ nên chưa đối chiếu được.</p>
            )}

            {!r.alreadyMigrated ? (
              <div className="mt-3 space-y-2">
                {r.recon?.hasUnexplained ? (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400">
                    Còn {lech.length} khoản lệch CHƯA giải thích được. Không kích hoạt chính sách khi còn chênh chưa rõ nguyên nhân — trừ khi đó là một sửa ĐÚNG có chủ ý, và khi ấy phải ghi lý do
                    để nó đi vào nhật ký.
                  </p>
                ) : null}
                {reasonFor === p.employeeId ? (
                  <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-2">
                    <div className="flex-1 space-y-1">
                      <label className="text-[12px] font-medium" htmlFor={`ack-${p.employeeId}`}>
                        Vì sao chấp nhận phần lệch (bắt buộc)
                      </label>
                      <Input id={`ack-${p.employeeId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd: số cũ tính thiếu cước chiều hoàn, số mới đúng" />
                    </div>
                    <Button size="sm" disabled={pending || reason.trim().length < 5} onClick={() => apply(r, reason.trim())}>
                      <Check className="size-4" /> Xác nhận chuyển
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReasonFor(null)}>
                      Huỷ
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" disabled={pending || !chanDuoc} onClick={() => (r.recon?.hasUnexplained ? setReasonFor(p.employeeId) : apply(r, ""))}>
                    Chuyển sang máy chung <ArrowRight className="size-4" />
                  </Button>
                )}
              </div>
            ) : null}
          </SectionCard>
        );
      })}
    </div>
  );
}
