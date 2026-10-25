"use client";

import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DuplicateAckWarning } from "@/lib/constants/order-duplicate";

/**
 * Hộp cảnh báo «đơn này có thể trùng» ở lượt XÁC NHẬN TAY thứ nhất (P0 HSLC 25/10/2026, #E0663E84). Máy chủ trả các tín hiệu
 * (`duplicateAckWarnings`); người đọc, mở đơn kia nếu cần, rồi bấm «Vẫn xác nhận» — lượt hai gửi lại đúng các khoá đã thấy. Không
 * chặn hẳn: người quyết. Dùng chung cho nút nhanh «Xác nhận đơn» và form sửa đơn.
 */
export function DuplicateAckBox({ warnings, pending, confirmLabel = "Vẫn xác nhận", onConfirm, onCancel }: { warnings: readonly DuplicateAckWarning[]; pending: boolean; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  if (!warnings.length) return null;
  return (
    <div role="alertdialog" aria-label="Đơn này có thể trùng" data-testid="duplicate-ack" className="max-w-md space-y-2 rounded-md border border-rose-300 bg-rose-50/80 p-2.5 text-[12.5px] dark:border-rose-900/60 dark:bg-rose-950/30">
      <p className="flex items-center gap-1.5 font-semibold text-rose-900 dark:text-rose-200">
        <AlertTriangle className="size-3.5 shrink-0" /> Đơn này có thể trùng — kiểm trước khi xác nhận
      </p>
      <ul className="space-y-1">
        {warnings.map((w) => (
          <li key={w.key}>
            {w.label}
            {w.otherId ? (
              <>
                {" · "}
                <Link href={`/orders/${encodeURIComponent(w.otherId)}`} className="font-medium underline underline-offset-2" target="_blank">
                  mở đơn kia
                </Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[11.5px] text-muted-foreground">Cùng một lần mua thì giữ MỘT đơn (gộp món vào đơn đặt trước, huỷ đơn còn lại). Hai lần mua thật thì xác nhận.</p>
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" disabled={pending} onClick={onCancel}>
          Thôi
        </Button>
        <Button type="button" size="sm" variant="destructive" className="h-7 px-2 text-[11.5px]" disabled={pending} onClick={onConfirm}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
