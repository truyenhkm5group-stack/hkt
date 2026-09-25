"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { clearShortageDecision, decideShortage } from "@/lib/actions/stock-shortage";
import { SHORTAGE_DECISIONS, SHORTAGE_DECISION_HINT, SHORTAGE_DECISION_LABEL, type ShortageDecisionKind } from "@/lib/constants/stock-shortage";
import { cn } from "@/lib/utils";

/**
 * Ba nút "Đã đặt rồi · Sẽ đặt thêm · Không đặt nữa" của một mẫu thiếu. Link trên tin Lark mở trang
 * với `?variant=…&decide=…` — nút tương ứng được tô nổi (`suggested`) để người bấm xác nhận MỘT lần.
 */
export function ShortageDecisionButtons({ variantId, current, suggested, canWrite }: { variantId: string; current: ShortageDecisionKind | null; suggested: ShortageDecisionKind | null; canWrite: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (!canWrite) return null;
  const decide = (decision: ShortageDecisionKind) =>
    startTransition(async () => {
      const r = await decideShortage({ variantId, decision });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
      }
    });
  const clear = () =>
    startTransition(async () => {
      const r = await clearShortageDecision(variantId);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã bỏ quyết định — mẫu này được nhắc lại như bình thường");
        router.refresh();
      }
    });
  return (
    <div className="flex flex-wrap items-center gap-1">
      {SHORTAGE_DECISIONS.map((d) => (
        <Button
          key={d}
          type="button"
          size="sm"
          variant={current === d ? "default" : suggested === d ? "secondary" : "outline"}
          className={cn("h-6 px-2 text-[10.5px]", suggested === d && current !== d && "ring-2 ring-primary")}
          disabled={pending || current === d}
          title={SHORTAGE_DECISION_HINT[d]}
          onClick={() => decide(d)}
        >
          {SHORTAGE_DECISION_LABEL[d]}
        </Button>
      ))}
      {current ? (
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10.5px] text-muted-foreground" disabled={pending} onClick={clear} title="Bỏ quyết định, nhắc lại như bình thường">
          Bỏ
        </Button>
      ) : null}
    </div>
  );
}
