"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useTransition } from "react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { COD_DEFAULT_TAB } from "@/lib/constants/cod";
import { formatNumber } from "@/lib/format";

export type CodTabItem = { value: string; label: string; count: number | null };

/** Thanh tab trạng thái COD — đồng bộ với tham số `cod` trên URL (tab mặc định không ghi lên URL) */
export function CodTabs({ tabs, active }: { tabs: CodTabItem[]; active: string }) {
  // Bấm tab phải phản hồi NGAY. `shallow: false` bắt buộc đi vòng lên máy chủ, nên nếu không bắt
  // trạng thái chờ thì giao diện đứng im vài trăm mili-giây và người dùng tưởng máy treo.
  const [dangChuyen, startTransition] = useTransition();
  const [, setState] = useQueryStates(
    { cod: parseAsString, page: parseAsString, batch: parseAsString },
    { shallow: false, history: "push", startTransition },
  );
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ cod: value === COD_DEFAULT_TAB ? null : value, page: null, batch: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
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
