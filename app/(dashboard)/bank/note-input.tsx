"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { classifyBankTransactions } from "@/lib/actions/bank";
import { Input } from "@/components/ui/input";

/**
 * Ghi chú của một giao dịch. Lưu khi rời ô (blur) hoặc Enter — không lưu theo từng phím gõ, để một
 * dòng ghi chú không thành 30 lần ghi CSDL.
 */
export function BankNoteInput({ id, value, group, canWrite }: { id: string; value: string; group: string; canWrite: boolean }) {
  const [note, setNote] = useState(value);
  const [saved, setSaved] = useState(value);
  const [pending, startTransition] = useTransition();
  if (!canWrite) return note ? <span className="text-xs text-muted-foreground">{note}</span> : null;

  const commit = () => {
    const next = note.trim();
    if (next === saved.trim()) return;
    startTransition(async () => {
      // Gửi kèm nhóm hiện tại: hành động phân loại là một, ghi chú chỉ là một trường của nó.
      const res = await classifyBankTransactions({ ids: [id], group, note: next });
      if ("error" in res) {
        setNote(saved);
        toast.error(res.error);
        return;
      }
      setSaved(next);
    });
  };

  return (
    <Input
      value={note}
      disabled={pending}
      placeholder="ghi chú"
      onChange={(e) => setNote(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setNote(saved);
      }}
      className="h-8 text-xs"
    />
  );
}
