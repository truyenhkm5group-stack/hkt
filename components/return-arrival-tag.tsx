import { RETURN_ARRIVAL_LABEL, returnArrivalDetail, type ReturnArrival } from "@/lib/constants/return-arrival";
import { cn } from "@/lib/utils";

/**
 * Nhãn «Thực tế: hoàn về shop» đặt CẠNH nhãn chặng của Viettel Post — không thay nó (AGENTS 47).
 * Không hook, không trạng thái: dùng được ở cả Server Component lẫn client component. Luật quyết định
 * `value` nằm ở `lib/queries/shipment-return-arrival.ts`; thành phần này chỉ vẽ.
 */
export function ReturnArrivalTag({ value, className }: { value: ReturnArrival | null | undefined; className?: string }) {
  if (!value) return null;
  return (
    <span
      className={cn("rounded-md bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950/60 dark:text-rose-300", className)}
      title={returnArrivalDetail(value)}
    >
      Thực tế: {RETURN_ARRIVAL_LABEL.toLowerCase()}
    </span>
  );
}
