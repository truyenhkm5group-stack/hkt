"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addManualBankTransaction } from "@/lib/actions/bank";
import { BANK_GROUP_SECTIONS, BANK_GROUP_SPEC, type BankGroup } from "@/lib/constants/bank";
import { todayVN } from "@/lib/format";

/**
 * Thêm giao dịch tay: tiền mặt, ví điện tử, hoặc khoản ngân hàng chưa lên sao kê.
 *
 * Chiều tiền chọn bằng nút chứ không bằng dấu trừ gõ tay — gõ nhầm dấu là cách dễ nhất biến một
 * khoản chi thành một khoản thu, và sai đó rất khó nhìn ra khi rà lại sổ.
 */
export function ManualTxnDialog() {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [date, setDate] = useState(todayVN());
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [group, setGroup] = useState<BankGroup>("OTHER_EXPENSE");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const submit = () =>
    startTransition(async () => {
      const value = Math.round(Number(amount) || 0);
      if (value <= 0) {
        toast.error("Nhập số tiền lớn hơn 0");
        return;
      }
      const res = await addManualBankTransaction({
        date,
        amount: direction === "OUT" ? -value : value,
        description,
        counterparty,
        group,
      });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã thêm giao dịch");
      setOpen(false);
      setAmount("");
      setDescription("");
      setCounterparty("");
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" />
          Thêm giao dịch tay
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Thêm giao dịch tay</DialogTitle>
          <DialogDescription>Dùng cho tiền mặt, ví điện tử, hoặc khoản ngân hàng chưa lên sao kê. Dòng nhập tay được đánh dấu riêng và có thể xoá; dòng từ sao kê thì không.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={direction === "OUT" ? "default" : "outline"} onClick={() => setDirection("OUT")}>
              Tiền ra
            </Button>
            <Button type="button" variant={direction === "IN" ? "default" : "outline"} onClick={() => setDirection("IN")}>
              Tiền vào
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Ngày</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Số tiền (₫)</Label>
              <Input type="number" inputMode="numeric" min={1} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Nội dung</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="VD: Trả tiền điện tháng 9" />
          </div>
          <div className="space-y-1">
            <Label>Đối tác</Label>
            <Input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="Tên người / công ty nhận" />
          </div>
          <div className="space-y-1">
            <Label>Nhóm kế toán</Label>
            <select value={group} onChange={(e) => setGroup(e.target.value as BankGroup)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
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
            <p className="text-[11px] text-muted-foreground">{BANK_GROUP_SPEC[group].hint}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={pending || !description.trim() || !amount}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Thêm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
