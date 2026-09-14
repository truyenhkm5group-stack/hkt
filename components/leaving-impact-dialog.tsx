"use client";

/**
 * ═══════════ XEM TRƯỚC TÁC ĐỘNG RỒI MỚI XÁC NHẬN ═══════════
 *
 * Dùng chung cho mọi thao tác làm một người rời khỏi phòng ban (bỏ khỏi phòng, chuyển phòng), ở
 * cả `/settings/users` lẫn `/work/settings`.
 *
 * Thay cho `window.confirm`. Không phải vì đẹp hơn: `confirm()` chỉ chứa được một dòng chữ, nên
 * con số duy nhất lọt vào đó là "đang cầm N việc" — không nói được N việc ấy ở phòng nào, bao
 * nhiêu đã quá hạn, bao nhiêu tiền đang treo. Người bấm đọc "12 việc" rồi bấm Đồng ý mà không
 * biết trong đó có 4 việc quá hạn và 30 triệu tiền COD.
 *
 * ĐIỀU QUAN TRỌNG NHẤT ở hộp thoại này là câu khẳng định KHÔNG có gì được giao lại tự động. Đó là
 * luật của hệ thống, và người bấm phải biết luật ấy TRƯỚC khi bấm, chứ không phải phát hiện ra
 * sau khi thấy hàng đợi của người đã chuyển phòng vẫn đầy.
 */
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatNumber, formatVND } from "@/lib/format";

export type LeavingImpactView = {
  holding: number;
  overdue: number;
  byDepartment: { code: string; label: string; count: number }[];
  money: { atRisk: number; recoverable: number; unknown: number; known: number };
  sample: { title: string; department: string }[];
};

export function LeavingImpactDialog({
  open,
  onOpenChange,
  userName,
  title,
  description,
  confirmLabel,
  impact,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userName: string;
  title: string;
  description: string;
  confirmLabel: string;
  impact: LeavingImpactView | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {impact === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang đếm việc {userName} đang cầm…
          </p>
        ) : impact.holding === 0 ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">
            {userName} không cầm việc nào đang mở. Thao tác này không làm việc nào mất chủ.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/40">
              <p className="flex items-start gap-2 font-semibold text-amber-900 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {userName} đang cầm {formatNumber(impact.holding)} việc đang mở
                {impact.overdue ? `, trong đó ${formatNumber(impact.overdue)} việc đã quá hạn` : ""}.
              </p>
              <p className="mt-1.5 text-[12px] text-amber-900/90 dark:text-amber-200/90">
                Những việc này <strong>KHÔNG được giao lại tự động</strong>. Chúng vẫn mang tên {userName} cho tới khi có người chuyển từng việc đi — giao lại ở màn
                <em> Hôm nay </em> của trưởng phòng.
              </p>
            </div>

            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Theo phòng ban của việc</dt>
                <dd className="mt-1 space-y-0.5">
                  {impact.byDepartment.map((d) => (
                    <div key={d.code}>
                      {d.label}: {formatNumber(d.count)}
                    </div>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Tiền đang treo</dt>
                <dd className="mt-1 space-y-0.5">
                  <div>Rủi ro: {formatVND(impact.money.atRisk)}</div>
                  <div>Có thể thu lại: {formatVND(impact.money.recoverable)}</div>
                  {/* `unknown` là CHƯA BIẾT, không phải 0 — nói thẳng thay vì cộng vào như số không. */}
                  {impact.money.unknown ? <div className="text-muted-foreground">{formatNumber(impact.money.unknown)} việc chưa tra được tiền</div> : null}
                </dd>
              </div>
            </dl>

            {impact.sample.length ? (
              <div className="text-xs">
                <div className="font-semibold uppercase tracking-wide text-muted-foreground">Ví dụ</div>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {impact.sample.map((s, i) => (
                    <li key={i} className="truncate">
                      · {s.title} <span className="opacity-70">({s.department})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Huỷ
          </Button>
          <Button onClick={onConfirm} disabled={pending || impact === null}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
