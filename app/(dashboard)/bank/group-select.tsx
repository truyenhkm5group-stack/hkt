"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { classifyBankTransactions } from "@/lib/actions/bank";
import { BANK_GROUP_SECTIONS, BANK_GROUP_SPEC, type BankGroup } from "@/lib/constants/bank";
import { cn } from "@/lib/utils";

/**
 * Ô chọn nhóm kế toán ngay trên dòng.
 *
 * Phân loại sao kê là việc lặp hàng trăm lần: bắt mở hộp thoại cho từng dòng thì không ai làm hết
 * được, và sổ bỏ dở giữa chừng còn tệ hơn không phân loại — báo cáo thiếu một phần chi phí mà nhìn
 * vẫn như đủ.
 *
 * Lưu NGAY khi chọn, không có nút "Lưu": một thao tác thay vì hai, và không có trạng thái "đã sửa
 * nhưng chưa lưu" để người dùng đóng tab mất trắng.
 */
export function BankGroupSelect({ id, value, canWrite }: { id: string; value: string; canWrite: boolean }) {
  const [group, setGroup] = useState(value);
  const [pending, startTransition] = useTransition();

  if (!canWrite) {
    return <span className="text-xs text-muted-foreground">{BANK_GROUP_SPEC[group as BankGroup]?.label ?? group}</span>;
  }

  const change = (next: string) => {
    const previous = group;
    setGroup(next);
    startTransition(async () => {
      const res = await classifyBankTransactions({ ids: [id], group: next });
      if ("error" in res) {
        setGroup(previous);
        toast.error(res.error);
        return;
      }
      toast.success(`Đã gán “${BANK_GROUP_SPEC[next as BankGroup]?.label ?? next}”`);
    });
  };

  return (
    <select
      value={group}
      disabled={pending}
      onChange={(e) => change(e.target.value)}
      title={BANK_GROUP_SPEC[group as BankGroup]?.hint}
      className={cn(
        "h-8 w-full min-w-[190px] rounded-md border bg-background px-2 text-xs",
        group === "UNCLASSIFIED" && "border-amber-400 text-amber-800 dark:text-amber-300",
        pending && "opacity-60",
      )}
    >
      {BANK_GROUP_SECTIONS.map((section) => (
        <optgroup key={section.title} label={section.title}>
          {section.groups.map((g) => (
            <option key={g} value={g}>
              {BANK_GROUP_SPEC[g].label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
