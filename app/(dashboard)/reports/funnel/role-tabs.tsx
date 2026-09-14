"use client";

import { useNavTransition } from "@/components/nav-progress";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { ATTRIBUTION_FIELDS, type AttributionField } from "@/lib/constants/sales-funnel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Chọn VAI để xem hiệu suất. Năm vai không thay thế được cho nhau nên đây là năm bảng khác nhau,
 * không phải năm cách gọi tên của cùng một bảng.
 */
export function RoleTabs({ current }: { current: AttributionField }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useNavTransition();

  const go = (field: AttributionField) => {
    const next = new URLSearchParams(params.toString());
    next.set("role", field);
    start(() => router.push(`/reports/funnel?${next.toString()}`));
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {ATTRIBUTION_FIELDS.map((f) => (
        <Button
          key={f.field}
          variant={f.field === current ? "default" : "ghost"}
          size="sm"
          className={cn("h-7 px-2 text-xs", f.field === current && "pointer-events-none")}
          disabled={pending}
          onClick={() => go(f.field)}
          title={f.note}
        >
          {f.label}
        </Button>
      ))}
      {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}
