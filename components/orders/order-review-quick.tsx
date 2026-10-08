"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Flag, Loader2, PencilLine, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cancelManualOrderAction, confirmOrderReviewAction } from "@/lib/actions/manual-orders";
import { ORDER_REVIEW_CANCEL_REASON, ORDER_REVIEW_HINT, ORDER_REVIEW_LABEL, quickConfirmKind, reviewSeenOf, type OrderReviewEntry, type OrderReviewResolution } from "@/lib/constants/order-review";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ NÚT NHANH «XÁC NHẬN ĐƠN» / «HUỶ ĐƠN» + LÝ DO CẦN NGƯỜI KIỂM (chủ shop 08/10/2026) ═══════════
 *
 * Một khối dùng chung cho hộp thư (panel đơn của hội thoại), danh sách đơn và trang đơn. Mọi thao tác đi qua ĐÚNG server action
 * đang có: xác nhận = `confirmOrderReviewAction` (lõi `confirmOrderReviewCore` ⇒ đường sửa đơn: quyền, hạn mức nợ, sự kiện
 * `order.confirmed`, nhật ký); huỷ = `cancelManualOrderAction` (lõi huỷ đơn tay, bắt buộc lý do). Action tự `revalidatePath` ⇒
 * KHÔNG `router.refresh()` (dựng trang hai lần). Chỉ hiện nút khi máy chủ đã nói người này được làm (cổng đơn tay + `orders:write`).
 *
 * Review độc lập #675:
 *  · «Xác nhận đơn» gửi kèm DẤU VẾT lý do người bấm đang thấy (`reviewSeenOf`) — bot gắn «khách huỷ» sau khi trang dựng thì máy
 *    chủ từ chối «tải lại để xem», không chốt / gỡ cờ thay người (M1);
 *  · đơn còn chỗ thiếu (`gaps`: SĐT · địa chỉ · tỉnh · xã) ⇒ không có nút chốt nhanh, có lối sang sửa đơn (L2);
 *  · lý do huỷ là GỢI Ý (placeholder) — người gõ lý do thật, không bấm qua một câu điền sẵn (L3).
 */

const CANCELLABLE = new Set(["NEW", "WAITING", "CONFIRMED"]);

/**
 * Lý do cần kiểm: nhãn, nguyên văn câu khách, mốc, ai ghi, việc phải làm; `reconfirms` = khách xác nhận lại SAU khi báo huỷ (cờ vẫn
 * mở — người đọc cả hai lời rồi quyết). `compact` = một dòng cho danh sách.
 */
export function OrderReviewEntries({ entries, reconfirms = [], compact = false }: { entries: readonly OrderReviewEntry[]; reconfirms?: readonly OrderReviewResolution[]; compact?: boolean }) {
  if (!entries.length) return null;
  if (compact) {
    const title = entries.map((e) => `${ORDER_REVIEW_LABEL[e.code]}${e.quote ? ` — «${e.quote}»` : ""}${e.at ? ` · ${formatDateTime(e.at)}` : ""}`).join("\n");
    return (
      <div className="inline-flex max-w-[220px] items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300" title={title}>
        <Flag className="size-3 shrink-0" />
        <span className="truncate">Cần kiểm · {ORDER_REVIEW_LABEL[entries[entries.length - 1].code]}</span>
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {entries.map((e, i) => (
        <li key={`${e.code}-${e.at}-${i}`} className="text-[12.5px]">
          <p className="font-semibold text-amber-900 dark:text-amber-200">
            <Flag className="mr-1 inline size-3.5" />
            {ORDER_REVIEW_LABEL[e.code]}
          </p>
          {e.quote ? <p className="mt-0.5 italic">Khách nhắn: «{e.quote}»</p> : null}
          {e.note ? <p className="mt-0.5 text-muted-foreground">{e.note}</p> : null}
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {e.at ? formatDateTime(e.at) : "—"}
            {e.by ? ` · ${e.by}` : ""} · {ORDER_REVIEW_HINT[e.code]}
          </p>
        </li>
      ))}
      {reconfirms.map((r, i) => (
        <li key={`re-${r.at}-${i}`} className="text-[12.5px]">
          <p className="font-semibold text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="mr-1 inline size-3.5" />
            Khách xác nhận lại sau khi báo huỷ
          </p>
          {r.quote ? <p className="mt-0.5 italic">Khách nhắn: «{r.quote}»</p> : null}
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {r.at ? formatDateTime(r.at) : "—"}
            {r.byName ? ` · ${r.byName}` : ""} · cờ vẫn mở — người quyết giữ hay huỷ đơn.
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Hai nút nhanh. `stage` + `entries` quyết định nút nào có (hàm thuần `quickConfirmKind` — cùng phân nhánh với lõi). */
export function OrderQuickDecision({ orderId, stage, entries, gaps = [], size = "sm", className }: { orderId: string; stage: string; entries: readonly OrderReviewEntry[]; gaps?: readonly string[]; size?: "sm" | "xs"; className?: string }) {
  const [pending, setPending] = useState<null | "confirm" | "cancel">(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const kind = quickConfirmKind(stage, entries.length > 0);
  const canCancel = CANCELLABLE.has(stage);
  // Chỉ hiện khi có việc cho người: đơn còn «Mới» / «Chờ hàng», hoặc đang mang cờ cần kiểm. Đơn đã xác nhận bình thường không mang
  // nút huỷ nhanh trên danh sách / hộp thư — huỷ đơn đó đi qua nút «Huỷ đơn» (gõ lý do) ở trang đơn.
  if (!kind) return null;
  const h = size === "xs" ? "h-7 px-2 text-[11.5px]" : "h-8";
  const hint = entries.length ? ORDER_REVIEW_CANCEL_REASON[entries[entries.length - 1].code] : "khách đổi ý, trùng đơn, hết hàng…";

  const confirm = async () => {
    setPending("confirm");
    setError(null);
    try {
      const r = await confirmOrderReviewAction(orderId, reviewSeenOf(entries));
      if (!("ok" in r)) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(r.message);
    } finally {
      setPending(null);
    }
  };

  const cancel = async () => {
    setPending("cancel");
    setError(null);
    try {
      const r = await cancelManualOrderAction(orderId, { reason });
      if (!("ok" in r)) {
        setError(r.error);
        return;
      }
      toast.success(r.message);
      setCancelOpen(false);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={cn("space-y-1.5", className)} data-no-row-link>
      <div className="flex flex-wrap items-center gap-1.5">
        {gaps.length ? (
          // Còn thiếu ⇒ không chốt nhanh: người phải sửa đơn (chọn xã, thêm SĐT…) trước — máy chủ cũng từ chối.
          <Button asChild size="sm" variant="outline" className={h} title={`Còn thiếu: ${gaps.join(", ")}`}>
            <Link href={`/orders/${encodeURIComponent(orderId)}/edit`}>
              <PencilLine className="size-3.5" /> Thiếu {gaps.join(", ")} — sửa đơn
            </Link>
          </Button>
        ) : (
          <Button type="button" size="sm" className={h} disabled={!!pending} onClick={() => void confirm()} title={kind === "RESOLVE" ? "Đơn đã «Đã xác nhận» — bấm để xác nhận lại sau khi kiểm (gỡ cờ cần kiểm)" : "Chuyển đơn sang «Đã xác nhận»"}>
            {pending === "confirm" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Xác nhận đơn
          </Button>
        )}
        {canCancel && !cancelOpen ? (
          <Button type="button" size="sm" variant="outline" className={h} disabled={!!pending} onClick={() => setCancelOpen(true)}>
            <XCircle className="size-3.5" /> Huỷ đơn
          </Button>
        ) : null}
      </div>
      {cancelOpen ? (
        <div className="max-w-sm space-y-1.5 rounded-md border bg-background p-2">
          <Textarea aria-label="Lý do huỷ đơn" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="text-[12.5px]" placeholder={`Vì sao huỷ (bắt buộc) — vd: ${hint}`} />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" className={h} disabled={!!pending} onClick={() => setCancelOpen(false)}>
              Thôi
            </Button>
            <Button type="button" size="sm" variant="destructive" className={h} disabled={!!pending || !reason.trim()} onClick={() => void cancel()}>
              {pending === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : null} Xác nhận huỷ
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-[11.5px] font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
