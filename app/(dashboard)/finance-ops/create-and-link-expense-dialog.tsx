"use client";

import { useState } from "react";
import { PlusCircle } from "lucide-react";
import { toast } from "sonner";
import { ExpenseDialog } from "@/app/(dashboard)/expenses/expense-dialog";
import { Button } from "@/components/ui/button";
import { linkBankTransaction } from "@/lib/actions/bank";
import type { ExpenseCategory } from "@/db/schema";
import { vnDateKey } from "@/lib/format";
import type { ExpenseInput } from "@/lib/validation/expenses";

/**
 * "Tạo & liên kết chi phí" — MỘT dòng sao kê chưa có chứng từ chi phí nào để nối.
 *
 * Cố ý KHÔNG tự tạo khoản chi từ dòng tiền: bảng Chi phí từng có một nút như vậy và bị bỏ, vì nó biến
 * "tiền đã đi ra ngày X" thành "chi phí của kỳ chứa ngày X", trong khi chi phí phải thuộc kỳ hưởng lợi
 * ích (xem `app/(dashboard)/bank/transactions-table.tsx`). Nên hộp thoại này vẫn là ĐÚNG form tạo chi
 * phí bình thường (`ExpenseDialog`, cùng zod, cùng luật MANUAL_ADJUSTMENT phải có lý do) — chỉ ĐIỀN
 * SẴN vài trường từ dòng sao kê để người dùng đỡ gõ lại, người dùng vẫn tự chọn nhóm và kỳ hiệu lực.
 * Tạo xong mới NỐI, qua đúng `linkBankTransaction` đã có.
 */
export function CreateAndLinkExpenseDialog({
  txnId,
  amount,
  txnAt,
  description,
  defaultCategory = "OTHER",
}: {
  txnId: string;
  amount: number;
  txnAt: Date;
  description: string;
  defaultCategory?: ExpenseCategory;
}) {
  const [open, setOpen] = useState(false);
  const defaultValues: Partial<ExpenseInput> = {
    category: defaultCategory,
    description: description.trim().slice(0, 500) || "Khoản chi từ sổ ngân hàng",
    amount: Math.abs(amount),
    occurredAt: vnDateKey(txnAt),
    reference: "",
    costSource: "MANUAL",
    reason: "",
  };
  return (
    <>
      <Button size="sm" variant="outline" className="h-7 px-2 text-[11.5px]" onClick={() => setOpen(true)}>
        <PlusCircle className="size-3.5" /> Tạo & liên kết chi phí
      </Button>
      <ExpenseDialog
        open={open}
        onOpenChange={setOpen}
        defaultValues={defaultValues}
        onCreated={async (expenseId) => {
          const res = await linkBankTransaction({ id: txnId, type: "EXPENSE", targetId: expenseId });
          if ("error" in res) {
            toast.error(`Đã tạo khoản chi nhưng nối thất bại: ${res.error}. Vào Sổ ngân hàng → Đối khớp để nối tay.`);
            return;
          }
          toast.success("Đã tạo khoản chi và nối với giao dịch ngân hàng");
        }}
      />
    </>
  );
}
