"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CASHFLOW_TABS, CASHFLOW_TAB_HINT, CASHFLOW_TAB_LABEL, type CashflowTab } from "@/lib/constants/cashflow-tabs";
import { cn } from "@/lib/utils";

/**
 * `useNavTransition` chứ KHÔNG phải `React.useTransition` trần.
 *
 * Bấm tab ở đây ghi lên URL với `shallow: false`, tức đi một vòng lên máy chủ. Dùng transition
 * trần thì thanh tiến trình chung không biết có việc đang chạy, và người bấm không thấy dấu hiệu
 * gì trong lúc chờ — đúng lời phàn nàn gốc của chủ shop: "không biết nó đang chạy hay đã treo".
 * `tests/loading-ux-contract.test.ts` khoá điều này ở mức mã nguồn.
 */
export function CashflowTabs({ active }: { active: CashflowTab }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates({ tab: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === "thuc-te" ? null : value })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {CASHFLOW_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="flex-none px-3" title={CASHFLOW_TAB_HINT[tab]}>
            {CASHFLOW_TAB_LABEL[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
