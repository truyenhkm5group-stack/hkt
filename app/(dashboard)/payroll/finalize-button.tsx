"use client";

import { useState, useTransition } from "react";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { finalizePayrollPeriod } from "@/lib/actions/payroll-period";

/**
 * CHỐT KỲ LƯƠNG — một lần, không mở lại được.
 *
 * Nên nó là `AlertDialog` chứ không phải một nút bấm thẳng, và câu hỏi xác nhận nói đúng hai điều
 * người bấm cần biết trước khi bấm.
 *
 * TỪ BẢN VÒNG ĐỜI, nút này là bước TÍNH chứ không còn là bước KHOÁ. Trước đây một lượt bấm đi
 * thẳng từ chưa có gì tới bất biến — nó gộp mất chỗ để soát, và không ai ký tên vào con số. Nay
 * nút đưa kỳ tới "Đã tính"; duyệt và khoá là hai bước riêng ở thanh vòng đời, và bước duyệt cần
 * quyền khác.
 */
export function FinalizePeriodButton({ from, to, basis, label, totalSalary }: { from: string; to: string; basis: string; label: string; totalSalary: string }) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Lock className="size-4" aria-hidden /> Tính & chụp ảnh kỳ
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Tính và chụp ảnh kỳ lương {label}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Tổng lương phải trả của kỳ: <b>{totalSalary}</b>.
              </p>
              <p>
                Đây là bước TÍNH: chụp lại toàn bộ con số và căn cứ của kỳ. Kỳ chuyển sang “Đã tính”, và từ đó màn hình đọc ảnh chụp thay vì tính lại mỗi
                lần mở.
              </p>
              <p className="font-medium">Chưa phải bước khoá — vẫn tính lại được.</p>
              <p className="text-muted-foreground">
                Đường đi tiếp: Đã tính → Đang soát → <b>Đã duyệt</b> → Đã khoá → Đã trả. Bước DUYỆT cần quyền duyệt lương, vì người khai số và người duyệt
                số không nên là một. Chỉ sau khi KHOÁ thì kỳ mới bất biến, và chứng từ về sau xử lý bằng khoản điều chỉnh ở kỳ kế tiếp.
              </p>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú lúc tính (tuỳ chọn) — vd: đã đối chiếu với bảng kê COD tháng 9" maxLength={500} />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await finalizePayrollPeriod({ from, to, basis, note });
                if ("error" in res) {
                  toast.error(res.error, { duration: 10000 });
                  return;
                }
                toast.success(`Đã tính và chụp ảnh kỳ ${res.key}. Bước tiếp theo: chuyển soát rồi duyệt.`);
                setOpen(false);
              })
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />} Tính & chụp ảnh kỳ
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
