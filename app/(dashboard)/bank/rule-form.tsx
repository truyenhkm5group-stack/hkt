"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveBankRule } from "@/lib/actions/bank";
import { BANK_GROUP_SECTIONS, BANK_GROUP_SPEC, type BankGroup } from "@/lib/constants/bank";

export type RuleDraft = {
  id?: string;
  name: string;
  priority: number;
  direction: "ANY" | "IN" | "OUT";
  matchCounterparty: string;
  matchDescription: string;
  minAmount: number;
  maxAmount: number;
  group: BankGroup;
  categoryCode: string;
  enabled: boolean;
};

export const EMPTY_RULE: RuleDraft = {
  name: "",
  priority: 100,
  direction: "OUT",
  matchCounterparty: "",
  matchDescription: "",
  minAmount: 0,
  maxAmount: 0,
  group: "OTHER_EXPENSE",
  categoryCode: "",
  enabled: true,
};

/**
 * Hộp thoại tạo / sửa quy tắc gán nhãn.
 *
 * Hiện SỐ DÒNG SẼ ĐỔI NHÃN ngay trong thông báo sau khi lưu: một quy tắc viết rộng tay có thể gán
 * lại hàng trăm giao dịch, và người viết cần thấy hậu quả ngay chứ không phải phát hiện ra ở báo
 * cáo cuối tháng.
 */
export function BankRuleDialog({ open, onOpenChange, draft }: { open: boolean; onOpenChange: (v: boolean) => void; draft: RuleDraft }) {
  const [form, setForm] = useState<RuleDraft>(draft);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setForm((f) => ({ ...f, [key]: value }));
  const noCondition = !form.matchCounterparty.trim() && !form.matchDescription.trim() && form.minAmount <= 0 && form.maxAmount <= 0;

  const submit = () =>
    startTransition(async () => {
      const res = await saveBankRule(form);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(res.applied ? `Đã lưu quy tắc · gán lại ${res.applied} giao dịch` : "Đã lưu quy tắc · chưa giao dịch nào khớp");
      onOpenChange(false);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) setForm(draft);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{form.id ? "Sửa quy tắc gán nhãn" : "Quy tắc gán nhãn mới"}</DialogTitle>
          <DialogDescription>
            Quy tắc chỉ chạm vào giao dịch <b>chưa ai phân loại tay</b>. Quy tắc đầu tiên khớp sẽ thắng (số thứ tự nhỏ chạy trước).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="space-y-1">
            <Label>Tên quy tắc</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="VD: Tiền thuê mặt bằng chị Hương" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Đối tác chứa</Label>
              <Input value={form.matchCounterparty} onChange={(e) => set("matchCounterparty", e.target.value)} placeholder="NGUYEN THI MINH HUONG" />
            </div>
            <div className="space-y-1">
              <Label>Nội dung chứa</Label>
              <Input value={form.matchDescription} onChange={(e) => set("matchDescription", e.target.value)} placeholder="tien thue thang" />
            </div>
          </div>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            Khớp kiểu &ldquo;chứa&rdquo;, không phân biệt hoa thường và dấu tiếng Việt. Khai cả hai ô thì phải khớp <b>cả hai</b>.
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>Chiều tiền</Label>
              <select value={form.direction} onChange={(e) => set("direction", e.target.value as RuleDraft["direction"])} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="OUT">Chỉ tiền ra</option>
                <option value="IN">Chỉ tiền vào</option>
                <option value="ANY">Cả hai</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Từ (₫)</Label>
              <Input type="number" min={0} step={100000} value={form.minAmount} onChange={(e) => set("minAmount", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
            </div>
            <div className="space-y-1">
              <Label>Đến (₫)</Label>
              <Input type="number" min={0} step={100000} value={form.maxAmount} onChange={(e) => set("maxAmount", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
            </div>
          </div>
          <p className="-mt-1 text-[11px] text-muted-foreground">Số tiền theo trị tuyệt đối. Để 0 ở ô &ldquo;Đến&rdquo; nghĩa là không giới hạn trên.</p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Gán vào nhóm</Label>
              <select value={form.group} onChange={(e) => set("group", e.target.value as BankGroup)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {BANK_GROUP_SECTIONS.filter((s) => s.groups[0] !== "UNCLASSIFIED").map((section) => (
                  <optgroup key={section.title} label={section.title}>
                    {section.groups.map((g) => (
                      <option key={g} value={g}>
                        {BANK_GROUP_SPEC[g].label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Thứ tự ưu tiên</Label>
              <Input type="number" min={1} max={9999} value={form.priority} onChange={(e) => set("priority", Math.max(1, Math.round(Number(e.target.value) || 100)))} />
            </div>
          </div>

          <p className="rounded-md bg-muted px-3 py-2 text-[11.5px] text-muted-foreground">{BANK_GROUP_SPEC[form.group].hint}</p>

          {noCondition ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              Chưa có điều kiện nào. Quy tắc như vậy sẽ khớp <b>mọi</b> giao dịch — hãy nhập ít nhất một điều kiện.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={pending || noCondition || !form.name.trim()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Lưu &amp; áp dụng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
