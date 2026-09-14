"use client";

import { useState } from "react";
import { BankRuleDialog, EMPTY_RULE, type RuleDraft } from "@/app/(dashboard)/bank/rule-form";
import type { BankGroup } from "@/lib/constants/bank";
import type { BankTxnRow } from "@/lib/queries/bank";

/**
 * Nút &ldquo;+ quy tắc&rdquo; ngay trên dòng giao dịch.
 *
 * Chỗ tự nhiên nhất để nghĩ ra một quy tắc là lúc đang nhìn dòng cần phân loại — không phải lúc mở
 * một trang cấu hình trống rồi cố nhớ lại tên đối tác viết như thế nào. Nên hộp thoại được điền sẵn
 * theo chính dòng đó: đối tác, chiều tiền và nhóm hiện tại.
 */
export function RuleFromTxnButton({ txn }: { txn: BankTxnRow }) {
  const [open, setOpen] = useState(false);
  const draft: RuleDraft = {
    ...EMPTY_RULE,
    name: txn.counterparty || txn.description.slice(0, 60) || "Quy tắc mới",
    // Ưu tiên khớp ĐỐI TÁC: nội dung chuyển khoản hay đổi (mã giao dịch, ghi chú của khách), còn tên
    // người/công ty nhận thì ổn định qua nhiều tháng.
    matchCounterparty: txn.counterparty,
    matchDescription: txn.counterparty ? "" : txn.description.slice(0, 40),
    direction: txn.amount < 0 ? "OUT" : "IN",
    group: (txn.accountingGroup === "UNCLASSIFIED" ? (txn.amount < 0 ? "OTHER_EXPENSE" : "OTHER_INCOME") : txn.accountingGroup) as BankGroup,
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="whitespace-nowrap text-[11px] text-primary hover:underline" title="Tạo quy tắc gán nhãn từ giao dịch này">
        + quy tắc
      </button>
      <BankRuleDialog open={open} onOpenChange={setOpen} draft={draft} />
    </>
  );
}
