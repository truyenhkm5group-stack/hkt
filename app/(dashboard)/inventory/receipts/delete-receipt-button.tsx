"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { deleteStockReceipt } from "@/lib/actions/stock";
import { RECEIPT_DELETE_REASON_MIN } from "@/lib/validation/stock";

/**
 * Xoá phiếu kho — LÝ DO BẮT BUỘC (xoá cứng thì nhật ký là thứ duy nhất còn lại). Máy chủ còn chặn
 * phiếu tái nhập đang là chứng từ kiểm hoàn và đưa việc xoá qua duyệt hai bước khi nhóm đã bật.
 */
export function DeleteReceiptButton({ id, label }: { id: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const router = useRouter();
  const ready = reason.trim().length >= RECEIPT_DELETE_REASON_MIN;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason("");
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Xoá phiếu" onClick={(e) => e.stopPropagation()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xoá phiếu {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Tồn kho của các mẫu mã trong phiếu sẽ được tính lại. Không thể hoàn tác — ERP lưu ảnh chụp đầy đủ của phiếu cùng lý do vào nhật ký. Phiếu tái nhập đang là chứng từ của phiếu kiểm hoàn thì không xoá được.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor={`ly-do-xoa-${id}`}>Lý do xoá (bắt buộc)</Label>
          <Textarea id={`ly-do-xoa-${id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vd: lập trùng với phiếu ngày 12/09, nhập sai mẫu mã…" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Huỷ</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!ready || pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteStockReceipt(id, reason);
                if ("error" in result) toast.error(result.error);
                else {
                  toast.success("Đã xoá phiếu");
                  setOpen(false);
                  setReason("");
                  router.refresh();
                }
              })
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xoá
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
