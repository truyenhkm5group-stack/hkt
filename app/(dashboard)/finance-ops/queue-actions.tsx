"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Check, ChevronDown, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { classifyBankTransactions, confirmInternalTransferPair, updateBankAccount } from "@/lib/actions/bank";
import { BANK_GROUP_SECTIONS, BANK_GROUP_SPEC, type BankGroup } from "@/lib/constants/bank";
import { cn } from "@/lib/utils";

/**
 * Phân loại NGAY trên dòng của hàng đợi.
 *
 * Khác `BankGroupSelect` (app/(dashboard)/bank/group-select.tsx) ở đúng một chỗ: dòng này PHẢI BIẾN
 * MẤT khỏi hàng đợi sau khi xong việc (nó không còn "chưa phân loại" nữa), nên gọi `router.refresh()`
 * thay vì chỉ cập nhật lựa chọn tại chỗ như bên Sổ ngân hàng — ở đó dòng vẫn cần hiện dù đã phân loại.
 */
export function QueueClassifySelect({ id, value }: { id: string; value: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <select
      defaultValue={value}
      disabled={pending}
      onChange={(e) => {
        const group = e.target.value;
        startTransition(async () => {
          const res = await classifyBankTransactions({ ids: [id], group });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          toast.success(`Đã gán "${BANK_GROUP_SPEC[group as BankGroup]?.label ?? group}"`);
          router.refresh();
        });
      }}
      className={cn("h-7 min-w-[168px] rounded-md border bg-background px-1.5 text-[11.5px]", pending && "opacity-60")}
    >
      <option value={value} disabled hidden>
        Phân loại…
      </option>
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

/**
 * "Bỏ qua / chuyển nội bộ" gộp hai kết luận cuối cùng của một dòng tiền: KHÔNG thuộc kinh doanh (đi
 * nhờ tài khoản shop), hoặc CHUYỂN NỘI BỘ giữa các tài khoản của chính shop. Cả hai đều không cần
 * chứng từ để nối — phân loại xong là xong việc.
 */
export function IgnoreOrTransferMenu({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const run = (group: "NOT_BUSINESS" | "INTERNAL_TRANSFER") =>
    startTransition(async () => {
      const res = await classifyBankTransactions({ ids: [id], group });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(group === "NOT_BUSINESS" ? "Đã đánh dấu không thuộc kinh doanh" : "Đã gán chuyển nội bộ");
      router.refresh();
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
          Bỏ qua / chuyển nội bộ
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => run("NOT_BUSINESS")}>Bỏ qua — không thuộc kinh doanh</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run("INTERNAL_TRANSFER")}>Chuyển nội bộ giữa các tài khoản của shop</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Một cú bấm gán CẢ HAI vế (tiền ra + tiền vào) của một cặp nghi ngờ chuyển nội bộ. */
export function ConfirmInternalTransferButton({ outId, inId }: { outId: string; inId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      className="h-7 px-2 text-[11.5px]"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          // GÁN NHÃN VÀ GHÉP CẶP trong một hành động. Gán nhãn thôi thì tổng đã đúng nhưng sổ vẫn
          // không biết hai dòng là MỘT sự kiện, và vế bị gán nhầm sẽ nằm im không ai thấy.
          const res = await confirmInternalTransferPair({ outId, inId });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          toast.success("Đã ghép cặp và gán chuyển nội bộ cho cả hai dòng");
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowLeftRight className="size-3.5" />}
      Xác nhận chuyển nội bộ
    </Button>
  );
}

/** Nút gán nhanh Lương cố định / Hoa hồng khi hàng đợi đã gợi ý đúng nhân sự theo tên/bí danh. */
export function PayrollClassifyButton({ id, group, label }: { id: string; group: "PAYROLL_SALARY" | "PAYROLL_COMMISSION"; label: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2 text-[11.5px]"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await classifyBankTransactions({ ids: [id], group });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          toast.success(`Đã gán "${label}"`);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      {label}
    </Button>
  );
}

/** Xác nhận một tài khoản ngân hàng đang UNCONFIRMED — quyền riêng `bank:accounts`, đã lọc ở trang cha. */
export function ConfirmAccountButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      className="h-7 px-2 text-[11.5px]"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await updateBankAccount({ id, status: "ACTIVE" });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          toast.success("Đã xác nhận tài khoản");
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      Xác nhận
    </Button>
  );
}
