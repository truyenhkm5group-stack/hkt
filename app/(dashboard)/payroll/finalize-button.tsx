"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
 * người bấm cần biết trước khi bấm: chốt xong thì kỳ BẤT BIẾN, và không có đường mở lại. Chứng từ
 * về sau xử lý bằng đề xuất điều chỉnh, hiện ngay dưới bảng.
 */
export function FinalizePeriodButton({ from, to, basis, label, totalSalary }: { from: string; to: string; basis: string; label: string; totalSalary: string }) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Lock className="size-4" aria-hidden /> Chốt kỳ
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Chốt kỳ lương {label}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Tổng lương phải trả của kỳ: <b>{totalSalary}</b>.
              </p>
              <p>
                Chốt là CHỤP LẠI toàn bộ con số và căn cứ của kỳ. Sau đó màn hình đọc ảnh chụp và thôi tính lại: đổi tỷ lệ thưởng, đổi người phụ trách
                fanpage hay nhập thêm phiếu kho về sau sẽ KHÔNG làm đổi kỳ này.
              </p>
              <p className="font-medium">Không có đường mở lại.</p>
              <p className="text-muted-foreground">
                Chứng từ về sau được xử lý bằng ĐỀ XUẤT ĐIỀU CHỈNH: phần tính lại hôm nay hiện ngay dưới bảng đã chốt, và bạn quyết có sửa hay không.
              </p>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú lúc chốt (tuỳ chọn) — vd: đã đối chiếu với bảng kê COD tháng 9" maxLength={500} />
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
                toast.success(`Đã chốt kỳ ${res.key}. Kỳ này nay là bất biến.`);
                setOpen(false);
                router.refresh();
              })
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />} Chốt kỳ
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
