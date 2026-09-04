"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus } from "lucide-react";
import { useForm, type ControllerRenderProps } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createAdSpend, updateAdSpend } from "@/lib/actions/expenses";
import { AD_PLATFORMS } from "@/lib/constants/expenses";
import { todayVN, vnDateKey } from "@/lib/format";
import type { AdSpendRow } from "@/lib/queries/expenses";
import { adSpendSchema, type AdSpendInput } from "@/lib/validation/expenses";

function toForm(ad?: AdSpendRow | null): Partial<AdSpendInput> {
  return {
    platform: ad?.platform ?? "Facebook",
    campaign: ad?.campaign ?? "",
    spend: ad?.spend,
    leads: ad?.leads ?? 0,
    orders: ad?.orders ?? 0,
    revenue: ad?.revenue ?? 0,
    spendDate: ad ? vnDateKey(ad.spendDate) : todayVN(),
    note: ad?.note ?? "",
  };
}

function NumberInput({ field, step = 1, placeholder = "0" }: { field: ControllerRenderProps<AdSpendInput, "spend" | "leads" | "orders" | "revenue">; step?: number; placeholder?: string }) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      step={step}
      placeholder={placeholder}
      className="numeric"
      name={field.name}
      ref={field.ref}
      onBlur={field.onBlur}
      value={typeof field.value === "number" && Number.isFinite(field.value) ? field.value : ""}
      onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
    />
  );
}

/**
 * Dialog thêm/sửa chi tiêu quảng cáo. Không truyền `open` → tự quản lý trạng thái và hiện nút “Thêm chi tiêu QC”.
 */
export function AdSpendDialog({ ad, open, onOpenChange }: { ad?: AdSpendRow | null; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const form = useForm<AdSpendInput>({ resolver: zodResolver(adSpendSchema), defaultValues: toForm(ad) });

  useEffect(() => {
    if (isOpen) form.reset(toForm(ad));
  }, [isOpen, ad, form]);

  const platformOptions = ad?.platform && !(AD_PLATFORMS as readonly string[]).includes(ad.platform) ? [...AD_PLATFORMS, ad.platform] : [...AD_PLATFORMS];

  const submit = (values: AdSpendInput) => {
    startTransition(async () => {
      const result = ad ? await updateAdSpend(ad.id, values) : await createAdSpend(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(ad ? "Đã cập nhật chi tiêu quảng cáo" : "Đã thêm chi tiêu quảng cáo");
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {open === undefined ? (
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="size-4" /> Thêm chi tiêu QC
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ad ? "Sửa chi tiêu quảng cáo" : "Thêm chi tiêu quảng cáo"}</DialogTitle>
          <DialogDescription>Ghi nhận chi tiêu theo ngày và nền tảng để tính ROAS, CPO và lợi nhuận ròng.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="platform"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nền tảng</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Chọn nền tảng" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {platformOptions.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
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
                name="spendDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày chi tiêu</FormLabel>
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
              name="campaign"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Chiến dịch</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Đầm midi — Conversion" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="spend"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chi tiêu (₫)</FormLabel>
                    <FormControl>
                      <NumberInput field={field} step={1000} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="revenue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Doanh thu ghi nhận (₫)</FormLabel>
                    <FormControl>
                      <NumberInput field={field} step={1000} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="leads"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số lead / tin nhắn</FormLabel>
                    <FormControl>
                      <NumberInput field={field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="orders"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số đơn từ quảng cáo</FormLabel>
                    <FormControl>
                      <NumberInput field={field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="Tuỳ chọn" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                {ad ? "Lưu thay đổi" : "Thêm chi tiêu"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
