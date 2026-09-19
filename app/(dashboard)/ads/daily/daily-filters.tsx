"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MARKETING_BASIS_LABEL,
  MARKETING_BASIS_QUESTION,
  MARKETING_DIMENSION_LABEL,
  MARKETING_DIMENSIONS,
  MARKETING_VIEW_LABEL,
  MARKETING_VIEWS,
  type MarketingBasis,
  type MarketingView,
} from "@/lib/constants/marketing-daily";
import { PERIOD_OPTIONS, type Period } from "@/lib/search-params";
import type { MarketingFilters } from "@/lib/queries/marketing-daily";
import { cn } from "@/lib/utils";

/**
 * ───────────── BỘ LỌC ─────────────
 *
 * Mọi lựa chọn nằm trên URL, nên một báo cáo đã lọc là một đường dẫn chép gửi được — điều kiện để
 * hai người nói về cùng một con số thay vì mỗi người tự bấm lại.
 *
 * Nút chọn MỐC đứng cạnh nút chọn kỳ và mang theo câu hỏi mà mốc ấy trả lời. Một bảng không nói ra
 * nó đang lọc theo mốc nào là một cái bẫy: 73,6% vận đơn có ngày tạo đơn và ngày gửi rơi vào hai
 * ngày khác nhau (đo production 13/09/2026 — `lib/constants/report-time-basis.ts`).
 */

const FILTER_PARAM: Record<keyof MarketingFilters, string> = {
  marketerId: "marketer",
  productId: "product",
  pageId: "page",
  campaignId: "campaign",
  adsetId: "adset",
  adId: "ad",
  source: "src",
};

const FILTER_LABEL: Record<keyof MarketingFilters, string> = {
  marketerId: MARKETING_DIMENSION_LABEL.marketer,
  productId: MARKETING_DIMENSION_LABEL.product,
  pageId: MARKETING_DIMENSION_LABEL.page,
  campaignId: MARKETING_DIMENSION_LABEL.campaign,
  adsetId: MARKETING_DIMENSION_LABEL.adset,
  adId: MARKETING_DIMENSION_LABEL.ad,
  source: MARKETING_DIMENSION_LABEL.source,
};

export function MarketingDailyFilters({ period, basis, view, filters }: { period: Period; basis: MarketingBasis; view: MarketingView; filters: MarketingFilters }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useNavTransition();

  const go = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    start(() => router.push(`/ads/daily?${next.toString()}`));
  };

  const active = (Object.keys(FILTER_PARAM) as (keyof MarketingFilters)[]).filter((k) => filters[k]);

  return (
    <div className="space-y-2 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Kỳ</span>
          {PERIOD_OPTIONS.filter((o) => o.value !== "custom").map((o) => (
            <Button
              key={o.value}
              variant={period.key === o.value ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => go((p) => { p.set("period", o.value); p.delete("from"); p.delete("to"); })}
            >
              {o.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Mốc</span>
          {(["created", "delivered"] as MarketingBasis[]).map((b) => (
            <Tooltip key={b}>
              <TooltipTrigger asChild>
                <Button variant={basis === b ? "default" : "ghost"} size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={() => go((p) => p.set("basis", b))}>
                  {MARKETING_BASIS_LABEL[b]}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs">{MARKETING_BASIS_QUESTION[b]}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Bộ cột</span>
          {MARKETING_VIEWS.map((v) => (
            <Button key={v} variant={view === v ? "default" : "ghost"} size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={() => go((p) => p.set("view", v))}>
              {MARKETING_VIEW_LABEL[v]}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Bóc tách</span>
          {MARKETING_DIMENSIONS.map((d) => (
            <Button key={d} variant={params.get("dim") === d || (!params.get("dim") && d === "marketer") ? "default" : "ghost"} size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={() => go((p) => p.set("dim", d))}>
              {MARKETING_DIMENSION_LABEL[d]}
            </Button>
          ))}
        </div>
      </div>

      {active.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Đang lọc</span>
          {active.map((k) => (
            <Button
              key={k}
              variant="secondary"
              size="sm"
              className={cn("h-6 gap-1 px-2 text-xs")}
              disabled={pending}
              onClick={() => go((p) => p.delete(FILTER_PARAM[k]))}
            >
              {FILTER_LABEL[k]}: {filters[k]}
              <X className="size-3" />
            </Button>
          ))}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={() => go((p) => Object.values(FILTER_PARAM).forEach((v) => p.delete(v)))}>
            Bỏ hết
          </Button>
        </div>
      ) : null}
    </div>
  );
}
