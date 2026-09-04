"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { COD_DEFAULT_TAB } from "@/lib/constants/cod";
import { formatNumber } from "@/lib/format";

export type CodTabItem = { value: string; label: string; count: number | null };

/** Thanh tab trạng thái COD — đồng bộ với tham số `cod` trên URL (tab mặc định không ghi lên URL) */
export function CodTabs({ tabs, active }: { tabs: CodTabItem[]; active: string }) {
  const [, setState] = useQueryStates({ cod: parseAsString, page: parseAsString, batch: parseAsString }, { shallow: false, history: "push" });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ cod: value === COD_DEFAULT_TAB ? null : value, page: null, batch: null })}>
      <TabsList className="h-auto flex-wrap justify-start">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="flex-none gap-1.5 px-3">
            {tab.label}
            {tab.count !== null ? <span className="rounded-full bg-muted-foreground/10 px-1.5 font-mono text-[10.5px] text-muted-foreground">{formatNumber(tab.count)}</span> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
