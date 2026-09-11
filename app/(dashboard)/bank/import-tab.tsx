"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { importBankStatement } from "@/lib/actions/bank";
import { formatNumber } from "@/lib/format";

const MAX_BYTES = 5_000_000;

/**
 * Nhập sao kê vào sổ giao dịch.
 *
 * KHÔNG có bước "duyệt từng dòng" như luồng nhập chi phí cũ: ở đây mọi giao dịch đều được ghi vào
 * sổ, kể cả tiền vào và các khoản không ảnh hưởng lãi lỗ. Sổ phải PHẢN ÁNH ĐẦY ĐỦ sao kê thì mới
 * đối chiếu được số dư; việc chọn lọc diễn ra sau, ở bước phân loại và bước đẩy sang Chi phí.
 */
export function BankImportTab({ canWrite }: { canWrite: boolean }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error("File quá lớn (tối đa 5MB)");
      return;
    }
    setFileName(file.name);
    setText(await file.text());
  };

  const submit = () =>
    startTransition(async () => {
      const res = await importBankStatement(text);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      const parts = [`${formatNumber(res.inserted)} giao dịch mới`];
      if (res.updated) parts.push(`${formatNumber(res.updated)} dòng đã có (giữ nguyên phân loại)`);
      if (res.duplicates) parts.push(`${formatNumber(res.duplicates)} dòng trùng ngay trong file`);
      if (res.labelled) parts.push(`${formatNumber(res.labelled)} dòng được quy tắc gán nhãn`);
      toast.success(parts.join(" · "), { duration: 8000 });
      setText("");
      setFileName("");
      router.refresh();
    });

  return (
    <SectionCard
      title="Nhập sao kê ngân hàng"
      description="Nhận file CSV hoặc JSON xuất từ ứng dụng quản lý giao dịch."
      hint="Mọi giao dịch đều được ghi vào sổ — kể cả tiền vào và khoản không ảnh hưởng lãi lỗ — để sổ khớp với số dư ngân hàng."
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed p-4 text-sm">
          <label className="flex cursor-pointer items-center gap-3">
            <FileUp className="size-5 text-muted-foreground" />
            <span className="font-medium">{fileName || "Chọn file sao kê (.csv / .json)"}</span>
            <input type="file" accept=".csv,.json,text/csv,application/json" className="hidden" disabled={!canWrite || pending} onChange={(e) => void readFile(e.target.files?.[0])} />
          </label>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Hoặc dán thẳng nội dung file vào đây:</p>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} disabled={!canWrite || pending} placeholder="Ngày,Giờ,Tiền vào,Tiền ra,Nội dung,Đối tác,Mã GD,..." className="font-mono text-xs" />
        </div>

        <div className="rounded-md bg-muted px-3 py-2 text-[11.5px] text-muted-foreground">
          <p className="font-medium text-foreground">Nhập lại chồng lấn là an toàn.</p>
          <p>
            Mỗi giao dịch được nhận diện bằng <b>mã giao dịch của ngân hàng</b>. Tải lại tháng 8 rồi tải tiếp 08–09 sẽ không nhân đôi dòng tiền:
            dòng đã có chỉ được cập nhật phần mô tả, còn <b>nhóm kế toán và ghi chú bạn đã gán vẫn giữ nguyên</b>.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={submit} disabled={!canWrite || pending || !text.trim()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Nhập vào sổ giao dịch
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
