"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createExpense, updateExpense } from "@/lib/actions/expenses";
import { EXPENSE_CATEGORY_LABEL, EXPENSE_CATEGORY_ORDER } from "@/lib/constants/expenses";
import { todayVN, vnDateKey } from "@/lib/format";
import type { ExpenseRow } from "@/lib/queries/expenses";
import { expenseSchema, type ExpenseInput } from "@/lib/validation/expenses";

function toForm(expense?: ExpenseRow | null): Partial<ExpenseInput> {
  return {
    category: expense?.category ?? "OTHER",
    description: expense?.description ?? "",
    amount: expense?.amount,
    occurredAt: expense ? vnDateKey(expense.occurredAt) : todayVN(),
    reference: expense?.reference ?? "",
    costSource: (expense?.costSource === "MANUAL_ADJUSTMENT" ? "MANUAL_ADJUSTMENT" : "MANUAL") as ExpenseInput["costSource"],
    reason: expense?.reason ?? "",
  };
}

/**
 * Dialog thêm/sửa chi phí. Không truyền `open` → tự quản lý trạng thái và hiện nút “Thêm chi phí”.
 *
 * `defaultValues` / `onCreated` phục vụ nơi gọi muốn ĐIỀN SẴN một vài trường (vd từ một dòng sao kê
 * ngân hàng đang chờ xử lý ở Hàng đợi tác vụ tài chính) rồi làm thêm việc SAU KHI tạo xong (vd nối
 * khoản chi vừa tạo với đúng dòng sao kê đó). Không đổi hành vi của nơi gọi cũ: hai prop đều tuỳ
 * chọn, bỏ qua thì y hệt trước.
 */
export function ExpenseDialog({
  expense,
  open,
  onOpenChange,
  defaultValues,
  onCreated,
}: {
  expense?: ExpenseRow | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultValues?: Partial<ExpenseInput>;
  onCreated?: (id: string) => void | Promise<void>;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const form = useForm<ExpenseInput>({ resolver: zodResolver(expenseSchema), defaultValues: { ...toForm(expense), ...defaultValues } });

  useEffect(() => {
    if (isOpen) form.reset({ ...toForm(expense), ...defaultValues });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, expense, form]);

  const submit = (values: ExpenseInput) => {
    startTransition(async () => {
      const result = expense ? await updateExpense(expense.id, values) : await createExpense(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (!expense && onCreated && result.id) {
        await onCreated(result.id);
      } else {
        toast.success(expense ? "Đã cập nhật chi phí" : "Đã thêm chi phí");
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {open === undefined ? (
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="size-4" /> Thêm chi phí
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{expense ? "Sửa chi phí" : "Thêm chi phí"}</DialogTitle>
          <DialogDescription>Chi phí vận hành ngoài Pancake (lương, mặt bằng, phần mềm, đóng gói…). Số tiền tính bằng VND.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhóm chi phí</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Chọn nhóm" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {EXPENSE_CATEGORY_ORDER.map((c) => (
                          <SelectItem key={c} value={c}>
                            {EXPENSE_CATEGORY_LABEL[c]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="occurredAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày phát sinh</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="VD: Lương nhân viên tháng 9" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số tiền (₫)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1000}
                        placeholder="0"
                        className="numeric"
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        value={typeof field.value === "number" && Number.isFinite(field.value) ? field.value : ""}
                        onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/*
                KHOẢN ĐIỀU CHỈNH — lối thoát DUY NHẤT của luật chống trừ hai lần.
                Cước và phí hoàn của từng đơn đã được tính theo vận đơn, nên khoản gõ tay trong hai nhóm đó bị
                loại. Nhưng đền bù, phí ngoại lệ, cước chuyến gom hàng không gắn được vận đơn nào vẫn là tiền
                thật — khai là "điều chỉnh" kèm lý do thì được tính.
              */}
              <FormField
                control={form.control}
                name="costSource"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nguồn khoản chi</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="MANUAL">Khoản chi thông thường</SelectItem>
                        <SelectItem value="MANUAL_ADJUSTMENT">Điều chỉnh thủ công (ngoài cước theo vận đơn)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">
                      Nhóm “Phí giao hàng” và “Phí hoàn” đã được tính theo từng vận đơn. Khoản gõ tay trong hai
                      nhóm đó chỉ vào lợi nhuận khi chọn <b>Điều chỉnh thủ công</b> và ghi rõ lý do.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {form.watch("costSource") === "MANUAL_ADJUSTMENT" ? (
                <FormField
                  control={form.control}
                  name="reason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Lý do điều chỉnh</FormLabel>
                      <FormControl>
                        <Input placeholder="VD: đền bù kiện vỡ, không thuộc bảng kê nào" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

              <FormField
                control={form.control}
                name="reference"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tham chiếu</FormLabel>
                    <FormControl>
                      <Input placeholder="Số hoá đơn, mã giao dịch…" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                {expense ? "Lưu thay đổi" : "Thêm chi phí"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
