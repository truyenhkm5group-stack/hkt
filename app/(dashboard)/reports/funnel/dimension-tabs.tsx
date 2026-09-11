"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { CONVERSION_DIMENSION_LABEL, type ConversionDimension } from "@/lib/constants/conversion";
import { cn } from "@/lib/utils";

/**
 * Chọn CHIỀU để xem chuyển đổi. Năm chiều là năm câu hỏi khác nhau ("ai làm tốt", "kênh nào tốt",
 * "mẫu nào tốt", "ngày nào", "giờ nào"), không phải năm cách sắp xếp của cùng một bảng.
 */
export function DimensionTabs({ current }: { current: ConversionDimension }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useNavTransition();

  const go = (dim: ConversionDimension) => {
    const next = new URLSearchParams(params.toString());
    next.set("dim", dim);
    start(() => router.push(`/reports/funnel?${next.toString()}`));
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {(Object.keys(CONVERSION_DIMENSION_LABEL) as ConversionDimension[]).map((d) => (
        <Button
          key={d}
          variant={d === current ? "default" : "ghost"}
          size="sm"
          className={cn("h-7 px-2 text-xs", d === current && "pointer-events-none")}
          disabled={pending}
          onClick={() => go(d)}
        >
          {CONVERSION_DIMENSION_LABEL[d]}
        </Button>
      ))}
      {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}
