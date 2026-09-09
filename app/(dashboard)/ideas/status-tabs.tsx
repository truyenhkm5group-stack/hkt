"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IDEA_STATUSES, IDEA_STATUS_LABEL } from "@/lib/constants/ideas";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Lọc ý tưởng theo trạng thái duyệt. Tab mặc định là "Tất cả" nên không ghi lên URL. */
export function IdeaStatusTabs({ counts, active }: { counts: Record<string, number>; active: string }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates({ tt: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tt: value === "ALL" ? null : value, page: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        <TabsTrigger value="ALL" className="flex-none gap-1.5 px-3">
          Tất cả
          <span className="rounded-full bg-muted-foreground/10 px-1.5 font-mono text-[10.5px] text-muted-foreground">{formatNumber(counts.ALL ?? 0)}</span>
        </TabsTrigger>
        {IDEA_STATUSES.map((s) => (
          <TabsTrigger key={s} value={s} className="flex-none gap-1.5 px-3">
            {IDEA_STATUS_LABEL[s]}
            <span className="rounded-full bg-muted-foreground/10 px-1.5 font-mono text-[10.5px] text-muted-foreground">{formatNumber(counts[s] ?? 0)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
