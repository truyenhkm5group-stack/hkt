"use client";

import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseReviewDay } from "@/lib/constants/creative-loop";
import { shiftDay } from "@/lib/constants/marketing-decision-ledger";
import type { ReviewDayOption } from "@/lib/queries/creative-manual-gen";
import { cn } from "@/lib/utils";

/**
 * BỘ LỌC NGÀY của tab "Duyệt mẫu" (chủ shop 26/09/2026): mặc định HÔM NAY, các ngày trước tạm ẩn; chọn ngày nào
 * thì "Kết quả gen tay" và "Lịch sử lô" hiện đúng ngày ấy. Ngày nằm trên URL (`?ngay=`) nên gửi link được và nút
 * Back của trình duyệt đi đúng. Chọn lại hôm nay ⇒ bỏ tham số (URL mặc định = hôm nay).
 */
function ddmm(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

export function ReviewDayFilter({ day, today, days }: { day: string; today: string; days: ReviewDayOption[] }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates({ ngay: parseAsString, lo: parseAsString }, { shallow: false, history: "push", startTransition });
  const go = (d: string) => {
    const next = parseReviewDay(d, today);
    void setState({ ngay: next === today ? null : next, lo: null });
  };
  const laHomNay = day === today;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
        <CalendarDays className="size-4" /> Kết quả ngày
      </span>
      <div className="flex items-center gap-1">
        <Button type="button" size="icon" variant="outline" className="size-8" onClick={() => go(shiftDay(day, -1))} aria-label="Ngày trước">
          <ChevronLeft className="size-4" />
        </Button>
        <Input type="date" value={day} max={today} onChange={(e) => e.target.value && go(e.target.value)} className="h-8 w-[150px] text-[12.5px]" aria-label="Chọn ngày" />
        <Button type="button" size="icon" variant="outline" className="size-8" disabled={day >= today} onClick={() => go(shiftDay(day, 1))} aria-label="Ngày sau">
          <ChevronRight className="size-4" />
        </Button>
        <Button type="button" size="sm" variant={laHomNay ? "default" : "outline"} className="h-8 text-[12px]" onClick={() => go(today)}>
          Hôm nay
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" aria-label="Các ngày gần đây có kết quả">
        {days.map((d) => {
          const on = d.day === day;
          const parts = [d.runs ? `${d.runs} lượt gen` : "", d.batches ? `${d.batches} lô` : ""].filter(Boolean);
          return (
            <button
              key={d.day}
              type="button"
              onClick={() => go(d.day)}
              aria-pressed={on}
              title={parts.length ? `${parts.join(" · ")}${d.images ? ` · ${d.images} ảnh` : ""}` : "Chưa có kết quả"}
              className={cn("rounded-md border px-2 py-0.5 text-[11.5px]", on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted", !parts.length && !on && "text-muted-foreground")}
            >
              {d.day === today ? "Hôm nay" : ddmm(d.day)}
              {d.runs || d.batches ? <span className={cn("numeric ml-1", on ? "opacity-80" : "text-muted-foreground")}>{d.runs + d.batches}</span> : null}
            </button>
          );
        })}
      </div>
      {!laHomNay ? <span className="text-[11.5px] text-warning">Đang xem ngày {ddmm(day)} — kết quả hôm nay đang ẩn.</span> : null}
    </div>
  );
}
