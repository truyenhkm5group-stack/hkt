"use client";

import { useState, useTransition } from "react";
import { Bot, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { applyBulkReturnToAiAction, previewBulkReturnToAiAction } from "@/lib/actions/inbox-bulk-ai";
import type { BulkReturnPreview } from "@/lib/sales-chatbot/bulk-return-ai";
import { HUMAN_HANDLING_LABEL } from "@/lib/sales-chatbot/inbox-shared";
import { formatNumber } from "@/lib/format";

/**
 * ═══════════ NÚT «TRẢ TẤT CẢ CHO AI» (chủ shop 10/10/2026, mục D) ═══════════
 *
 * Một dòng mảnh ngay dưới hàng thẻ lọc — chỉ hiện khi người xem CÓ QUYỀN và có ≥ 1 hội thoại đang do người xử lý (máy chủ quyết, trang
 * chỉ nhận số). Bấm ⇒ máy chủ XEM TRƯỚC (không ghi gì) ⇒ hộp xác nhận nói đúng hai con số: bao nhiêu hội thoại trả được, bao nhiêu
 * KHÔNG tự chạy lại được và vì sao (từng nhóm lý do, kèm vài tên khách). Đồng ý ⇒ lõi trả từng hội thoại qua đúng đường của nút trả
 * một hội thoại; hội thoại bị chặn giữ nguyên. Trang tự làm mới nhờ `revalidatePath` của action (không gọi thêm `router.refresh`).
 */
export function BulkReturnToAi({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<BulkReturnPreview | null>(null);
  const [loading, startLoading] = useTransition();
  const [applying, startApplying] = useTransition();

  const openPreview = () => {
    setPreview(null);
    setOpen(true);
    startLoading(async () => {
      const r = await previewBulkReturnToAiAction();
      if ("error" in r) {
        toast.error(r.error);
        setOpen(false);
        return;
      }
      setPreview(r.preview);
    });
  };

  const apply = () =>
    startApplying(async () => {
      const r = await applyBulkReturnToAiAction({ confirm: true });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const parts = [`Đã trả ${formatNumber(r.resumed)} hội thoại cho AI`];
      if (r.preview.blocked) parts.push(`${formatNumber(r.preview.blocked)} hội thoại giữ nguyên vì còn chặn`);
      if (r.failed.length) parts.push(`${formatNumber(r.failed.length)} hội thoại vừa đổi trạng thái — bỏ qua`);
      (r.resumed > 0 ? toast.success : toast.info)(parts.join(" · "));
      setOpen(false);
    });

  return (
    <div className="flex items-center gap-2 rounded-md bg-orange-50 px-2 py-1 text-[12px] text-orange-900 dark:bg-orange-950/40 dark:text-orange-100" data-testid="inbox-bulk-ai">
      <UserRound className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title="Nhân viên tiếp quản · AI đang nhường sau câu nhân viên gửi tay · AI gợi ý, người gửi">
        {formatNumber(count)} hội thoại đang do người xử lý
      </span>
      <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2 text-[12px]" onClick={openPreview} disabled={loading || applying} data-testid="inbox-bulk-ai-open">
        <Bot className="size-3.5" />
        Trả tất cả cho AI
      </Button>
      <AlertDialog open={open} onOpenChange={(v) => !applying && setOpen(v)}>
        <AlertDialogContent className="max-h-[85dvh] overflow-y-auto" data-testid="inbox-bulk-ai-dialog">
          {!preview ? (
            <AlertDialogHeader>
              <AlertDialogTitle>Trả tất cả cho AI</AlertDialogTitle>
              <AlertDialogDescription className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Đang kiểm từng hội thoại đang do người xử lý…
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle data-testid="inbox-bulk-ai-title">{preview.resumable > 0 ? `Trả ${formatNumber(preview.resumable)} hội thoại đang do người xử lý về AI?` : "Không hội thoại nào trả về AI được lúc này"}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2 text-left text-sm">
                    <p>
                      Đang do người xử lý: <b>{formatNumber(preview.total)}</b> —{" "}
                      {(Object.keys(preview.byHandling) as (keyof typeof preview.byHandling)[])
                        .filter((k) => preview.byHandling[k] > 0)
                        .map((k) => `${HUMAN_HANDLING_LABEL[k]} ${formatNumber(preview.byHandling[k])}`)
                        .join(" · ")}
                      .
                    </p>
                    <p data-testid="inbox-bulk-ai-counts">
                      <b className="text-foreground">Trả được: {formatNumber(preview.resumable)}</b> · <b className="text-foreground">Bị chặn: {formatNumber(preview.blocked)}</b>
                    </p>
                    {preview.blocked > 0 ? (
                      <div className="space-y-1.5">
                        <p>{formatNumber(preview.blocked)} hội thoại không thể tự chạy lại — giữ nguyên chế độ, người vẫn phải xử lý:</p>
                        <ul className="space-y-1.5">
                          {preview.groups.map((g) => (
                            <li key={g.code} className="rounded-md border border-foreground/10 px-2 py-1.5" data-block={g.code}>
                              <div className="font-medium text-foreground">
                                {formatNumber(g.count)} · {g.label}
                              </div>
                              <div className="truncate text-xs" title={g.samples.map((s) => (s.detail ? `${s.name} — ${s.detail}` : s.name)).join("\n")}>
                                {g.samples.map((s) => s.name).join(", ")}
                                {g.count > g.samples.length ? ` và ${formatNumber(g.count - g.samples.length)} hội thoại khác` : ""}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {preview.truncated ? <p className="text-xs">Có nhiều hội thoại hơn trần một lượt — chạy lại sau khi lượt này xong để xét phần còn lại.</p> : null}
                    {preview.resumable > 0 ? <p className="text-xs">AI trả lời từ tin khách KẾ TIẾP của từng hội thoại; tin cũ vẫn nằm trong lịch sử cho AI đọc.</p> : null}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={applying}>Để sau</AlertDialogCancel>
                {preview.resumable > 0 ? (
                  <Button type="button" onClick={apply} disabled={applying} data-testid="inbox-bulk-ai-confirm">
                    {applying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Bot className="size-4" aria-hidden />}
                    Trả {formatNumber(preview.resumable)} hội thoại cho AI
                  </Button>
                ) : null}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
