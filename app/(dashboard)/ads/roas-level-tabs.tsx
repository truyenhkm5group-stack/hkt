"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LEVELS = [
  { key: "campaign", label: "Theo chiến dịch", hint: "Cấp duy nhất có CẢ tiền chi lẫn đơn hàng — mọi chỉ số ROAS và CAC chỉ có nghĩa ở đây." },
  { key: "ad", label: "Theo mẩu quảng cáo", hint: "Chỉ có ĐƠN, không có tiền chi: Facebook Insights đồng bộ ở cấp chiến dịch/ngày. Dùng để xem mẩu nào đưa được hàng tới tay khách." },
] as const;

/** Chọn cấp xem ROAS. Hai cấp này KHÔNG cùng loại số liệu — nhãn phải nói rõ. */
export function RoasLevelTabs({ current }: { current: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-1">
      {LEVELS.map((l) => (
        <Button
          key={l.key}
          variant={l.key === current ? "default" : "ghost"}
          size="sm"
          className={cn("h-7 px-2 text-xs", l.key === current && "pointer-events-none")}
          disabled={pending}
          title={l.hint}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.set("adsLevel", l.key);
            start(() => router.push(`/ads?${next.toString()}`));
          }}
        >
          {l.label}
        </Button>
      ))}
      {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}
