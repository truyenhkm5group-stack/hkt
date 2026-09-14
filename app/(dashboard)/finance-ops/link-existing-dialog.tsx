"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { linkBankTransaction } from "@/lib/actions/bank";
import { searchLinkCandidates } from "@/lib/actions/finance-ops";
import { formatDate, formatVND } from "@/lib/format";

type Row = { id: string; label: string; amount: number; at: Date };

/**
 * "Liên kết khoản có sẵn" — nối một dòng sao kê với một chứng từ ĐÃ CÓ trong ERP (khoản chi hoặc đợt
 * COD), khi máy không tự gợi ý được (không có mã, không khớp tiền+ngày duy nhất) nhưng người dùng
 * biết chính xác đó là khoản nào.
 *
 * Đi qua đúng `linkBankTransaction` đã có — hộp thoại này chỉ thêm một ô TÌM chứng từ, việc mà
 * `lib/queries/finance-ops.ts` làm được nhưng client component không gọi thẳng tới (quy ước: client
 * không import lib/queries/*), nên phải qua `searchLinkCandidates`.
 */
export function LinkExistingDialog({ txnId, type, label = "Liên kết khoản có sẵn" }: { txnId: string; type: "EXPENSE" | "COD_BATCH"; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const timer = setTimeout(() => {
      searchLinkCandidates({ type, q })
        .then((res) => {
          if ("rows" in res) setRows(res.rows.map((r) => ({ ...r, at: new Date(r.at) })));
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [open, q, type]);

  const pick = (targetId: string) =>
    startTransition(async () => {
      const res = await linkBankTransaction({ id: txnId, type, targetId });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã nối giao dịch với chứng từ");
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="outline" className="h-7 px-2 text-[11.5px]" onClick={() => setOpen(true)}>
        <Link2 className="size-3.5" /> {label}
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title={label} description="Tìm theo mô tả hoặc mã tham chiếu">
        <CommandInput placeholder="Nhập từ khoá…" value={q} onValueChange={setQ} />
        <CommandList>
          <CommandEmpty>{loading ? "Đang tìm…" : "Không tìm thấy"}</CommandEmpty>
          <CommandGroup>
            {rows.map((r) => (
              <CommandItem key={r.id} value={`${r.id} ${r.label}`} disabled={pending} onSelect={() => pick(r.id)}>
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="numeric ml-2 shrink-0 text-xs text-muted-foreground">
                  {formatVND(r.amount)} · {formatDate(r.at)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
          {pending ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Đang nối…
            </div>
          ) : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}
