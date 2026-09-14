"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EXPENSE_TABS, EXPENSE_TAB_HINT, EXPENSE_TAB_LABEL, type ExpenseTab } from "@/lib/constants/expense-tabs";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** `useNavTransition` chứ không phải `React.useTransition` trần — xem `cashflow-tabs.tsx`. */
export function ExpenseTabs({ active, unclassified }: { active: ExpenseTab; unclassified: number }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates({ tab: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === "danh-sach" ? null : value, page: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {EXPENSE_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="flex-none gap-1.5 px-3" title={EXPENSE_TAB_HINT[tab]}>
            {EXPENSE_TAB_LABEL[tab]}
            {tab === "bao-cao" && unclassified > 0 ? (
              <span className="rounded-full bg-amber-500/20 px-1.5 font-mono text-[10.5px] text-amber-700 dark:text-amber-300" title="Tiền ra chưa phân loại — chi phí đang thiếu đúng khoản này">
                {formatNumber(unclassified)}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
