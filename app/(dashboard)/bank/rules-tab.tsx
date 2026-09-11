"use client";

import { useState, useTransition } from "react";
import { Plus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { BankRuleDialog, EMPTY_RULE, type RuleDraft } from "@/app/(dashboard)/bank/rule-form";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SectionCard } from "@/components/ui-bits";
import { applyBankRules, deleteBankRule } from "@/lib/actions/bank";
import { BANK_DIRECTION_LABEL, BANK_GROUP_SPEC, BANK_GROUP_TONE, type BankDirection, type BankGroup } from "@/lib/constants/bank";
import { formatNumber, formatVND } from "@/lib/format";
import type { BankRuleRow } from "@/lib/queries/bank";
import { cn } from "@/lib/utils";

function conditionText(rule: BankRuleRow): string {
  const parts: string[] = [];
  if (rule.matchCounterparty) parts.push(`đối tác chứa “${rule.matchCounterparty}”`);
  if (rule.matchDescription) parts.push(`nội dung chứa “${rule.matchDescription}”`);
  if (rule.minAmount > 0 && rule.maxAmount > 0) parts.push(`từ ${formatVND(rule.minAmount, { compact: true })} đến ${formatVND(rule.maxAmount, { compact: true })}`);
  else if (rule.minAmount > 0) parts.push(`từ ${formatVND(rule.minAmount, { compact: true })} trở lên`);
  else if (rule.maxAmount > 0) parts.push(`tối đa ${formatVND(rule.maxAmount, { compact: true })}`);
  return parts.join(" và ") || "—";
}

export function BankRulesTab({ rules, canWrite }: { rules: BankRuleRow[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [pending, startTransition] = useTransition();

  const edit = (rule: BankRuleRow) => {
    setDraft({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      direction: rule.direction as RuleDraft["direction"],
      matchCounterparty: rule.matchCounterparty,
      matchDescription: rule.matchDescription,
      minAmount: rule.minAmount,
      maxAmount: rule.maxAmount,
      group: rule.accountingGroup as BankGroup,
      categoryCode: rule.categoryCode,
      enabled: rule.enabled,
    });
    setOpen(true);
  };

  return (
    <SectionCard
      title="Quy tắc gán nhãn tự động"
      description="Gán nhãn thay cho việc chọn tay từng dòng lặp lại."
      hint="Sao kê một tháng có hàng trăm dòng lặp lại cùng một đối tác. Quy tắc chạy thay cho việc chọn tay từng dòng — nhưng không bao giờ ghi đè dòng bạn đã tự phân loại."
      actions={
        canWrite ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !rules.length}
              onClick={() =>
                startTransition(async () => {
                  const res = await applyBankRules();
                  if ("error" in res) toast.error(res.error);
                  else toast.success(res.applied ? `Đã gán lại ${formatNumber(res.applied)} giao dịch` : "Không có giao dịch nào cần đổi nhãn");
                })
              }
            >
              <Wand2 className="size-4" />
              Chạy lại
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setDraft(EMPTY_RULE);
                setOpen(true);
              }}
            >
              <Plus className="size-4" />
              Quy tắc mới
            </Button>
          </div>
        ) : null
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 text-right" title="Số nhỏ chạy trước. Quy tắc đầu tiên khớp sẽ thắng.">Thứ tự</TableHead>
              <TableHead>Tên quy tắc</TableHead>
              <TableHead>Điều kiện</TableHead>
              <TableHead className="w-28">Chiều tiền</TableHead>
              <TableHead className="w-52">Gán vào nhóm</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  Chưa có quy tắc nào. Cách nhanh nhất: về tab Giao dịch, bấm <b>+ quy tắc</b> ngay cạnh một dòng để tạo quy tắc điền sẵn theo dòng đó.
                </TableCell>
              </TableRow>
            ) : (
              rules.map((rule) => (
                <TableRow key={rule.id} className={cn(!rule.enabled && "opacity-50")}>
                  <TableCell className="numeric text-right">{rule.priority}</TableCell>
                  <TableCell className="font-medium">
                    {rule.name}
                    {!rule.enabled ? <span className="ml-1 text-[10.5px] text-muted-foreground">(đang tắt)</span> : null}
                  </TableCell>
                  <TableCell className="text-[12.5px] text-muted-foreground">{conditionText(rule)}</TableCell>
                  <TableCell className="text-[12.5px]">{BANK_DIRECTION_LABEL[rule.direction as BankDirection] ?? rule.direction}</TableCell>
                  <TableCell>
                    <span className={cn("inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-semibold", BANK_GROUP_TONE[rule.accountingGroup as BankGroup] ?? "bg-muted")}>
                      {BANK_GROUP_SPEC[rule.accountingGroup as BankGroup]?.label ?? rule.accountingGroup}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {canWrite ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => edit(rule)}>
                          Sửa
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const res = await deleteBankRule(rule.id);
                              if ("error" in res) toast.error(res.error);
                              else toast.success("Đã xoá quy tắc. Các dòng đã gán vẫn giữ nhãn cũ.");
                            })
                          }
                        >
                          Xoá
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <BankRuleDialog open={open} onOpenChange={setOpen} draft={draft} />
    </SectionCard>
  );
}
