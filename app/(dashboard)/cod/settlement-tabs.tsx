"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useTransition } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SETTLEMENT_LABEL, type SettlementStatus } from "@/lib/constants/cod";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const THU_TU: (SettlementStatus | "ALL")[] = ["QUA_HAN", "CHUA_TRA", "TRA_THIEU", "DA_TRA_DU", "CHUA_GIAO", "KHONG_PHAI_TRA", "ALL"];

/** Thanh lọc theo tình trạng thanh toán của Viettel Post cho từng vận đơn. */
export function SettlementTabs({ counts, active }: { counts: Record<string, number>; active: string }) {
  const [dangChuyen, startTransition] = useTransition();
  const [, setState] = useQueryStates({ tt: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tt: value === "QUA_HAN" ? null : value, page: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {THU_TU.map((key) => (
          <TabsTrigger key={key} value={key} className="flex-none gap-1.5 px-3">
            {key === "ALL" ? "Tất cả" : SETTLEMENT_LABEL[key]}
            <span className="rounded-full bg-muted-foreground/10 px-1.5 font-mono text-[10.5px] text-muted-foreground">{formatNumber(counts[key] ?? 0)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
