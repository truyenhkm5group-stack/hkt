"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useTransition } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const BANK_TABS = ["giao-dich", "doi-khop", "nhap-sao-ke", "quy-tac", "doi-chieu"] as const;
export type BankTab = (typeof BANK_TABS)[number];

const LABEL: Record<BankTab, string> = {
  "giao-dich": "Giao dịch",
  "doi-khop": "Đối khớp chứng từ",
  "nhap-sao-ke": "Nhập sao kê",
  "quy-tac": "Quy tắc gán nhãn",
  "doi-chieu": "Đối chiếu",
};

export function BankTabs({ active, unclassified }: { active: BankTab; unclassified: number }) {
  const [dangChuyen, startTransition] = useTransition();
  const [, setState] = useQueryStates({ tab: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === "giao-dich" ? null : value, page: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {BANK_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="flex-none gap-1.5 px-3">
            {LABEL[tab]}
            {tab === "giao-dich" && unclassified > 0 ? (
              <span className="rounded-full bg-amber-500/20 px-1.5 font-mono text-[10.5px] text-amber-700 dark:text-amber-300" title="Giao dịch chưa phân loại">
                {formatNumber(unclassified)}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
