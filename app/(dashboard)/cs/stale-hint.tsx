import type { CsStaleHint } from "@/lib/queries/cs";
import { cn } from "@/lib/utils";

/**
 * Nhãn "chứng từ đã đi tiếp" trên một case còn mở — xem `lib/queries/cs.ts::staleHints`.
 *
 * Chữ trên nhãn NGẮN; lý do đầy đủ (kiện đang ở chặng nào, đơn đã huỷ…) nằm ở tooltip. Nhãn KHÔNG
 * đổi trạng thái của case: case có người cầm thì người đó bấm đóng, máy không đóng hộ.
 */
export function StaleHintChip({ hint, className }: { hint: CsStaleHint | null; className?: string }) {
  if (!hint) return null;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200", className)}
      title={`${hint.reason}${hint.autoClose ? " — chưa ai cầm case này, máy sẽ tự đóng ở lượt đối chiếu tới (≤ 15 phút)." : " — case đã có người cầm nên máy không đóng hộ: xem lại rồi đóng nếu đúng."}`}
    >
      {hint.autoClose ? "Sắp tự đóng" : "Hết việc? · xem lại"}
    </span>
  );
}
