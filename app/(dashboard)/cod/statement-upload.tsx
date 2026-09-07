"use client";

import { FileUp } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { VtpImportForm } from "@/app/(dashboard)/import-vtp/import-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * BỔ SUNG BẢNG KÊ THIẾU.
 *
 * Bảng kê thường tự về qua email, nhưng Viettel Post có lúc gửi thiếu kỳ. Nút này để tải đúng
 * bảng kê của kỳ đó từ web Viettel Post rồi nạp lên — ERP giữ luôn tệp gốc nên chỉ phải làm MỘT
 * LẦN, và nếu sau này thư của chính kỳ đó về qua email thì cũng không bị tính hai lần: sổ chứng từ
 * khoá theo ngày chốt của bảng kê chứ không theo tên tệp.
 */
export function StatementUploadDialog({ label = "Bổ sung bảng kê thiếu" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileUp className="size-4" /> {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) router.refresh();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bổ sung bảng kê Viettel Post</DialogTitle>
            <DialogDescription>
              Tải bảng kê của kỳ còn thiếu từ web Viettel Post rồi chọn tệp ở đây. ERP giữ lại tệp
              gốc nên chỉ phải nạp một lần; thư cùng kỳ về sau qua email sẽ không bị tính lặp.
            </DialogDescription>
          </DialogHeader>
          <VtpImportForm />
        </DialogContent>
      </Dialog>
    </>
  );
}
