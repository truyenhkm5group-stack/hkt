"use client";

import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  ACTOR_KIND_LABEL,
  LANE_HINT,
  LANE_LABEL,
  LANE_TONE,
  TIMELINE_EVENT_LABEL,
  TIMELINE_LANES,
  timelineSourceLabel,
  type TimelineLane,
} from "@/lib/constants/shipment-timeline";
import type { ShipmentTimelineEntry } from "@/lib/queries/shipment-timeline";
import { formatDateTime, formatNumber, MISSING_TEXT } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ NHẬT KÝ MỘT VẬN ĐƠN — ĐỌC NHANH, ĐỐI CHIẾU ĐƯỢC ═══════════
 *
 * Bốn chiều mang bốn màu, và bộ lọc ở trên cho phép tách chúng ra. Đó không phải trang trí: người
 * đi đối chiếu với màn hình Viettel Post chỉ muốn thấy chiều CHỨNG TỪ, còn người chấm hiệu quả
 * care chỉ muốn thấy chiều NGƯỜI. Trộn hai chiều rồi bắt họ tự lọc bằng mắt là cách chắc chắn nhất
 * để ai đó kết luận "giao thành công nhờ bạn A" từ một dòng không nói điều đó.
 *
 * MỚI NHẤT TRƯỚC là mặc định vì câu hỏi thường gặp nhất là "vừa xảy ra chuyện gì". Đổi được sang
 * cũ nhất trước để đọc một ca từ đầu tới cuối.
 */
export function ShipmentActivityLog({ entries }: { entries: ShipmentTimelineEntry[] }) {
  const [lanes, setLanes] = useState<TimelineLane[]>([]);
  const [oldestFirst, setOldestFirst] = useState(false);

  const shown = useMemo(() => {
    const filtered = lanes.length ? entries.filter((e) => lanes.includes(e.lane)) : entries;
    return oldestFirst ? [...filtered].reverse() : filtered;
  }, [entries, lanes, oldestFirst]);

  const toggle = (lane: TimelineLane) => setLanes((cur) => (cur.includes(lane) ? cur.filter((l) => l !== lane) : [...cur, lane]));

  // Gom theo NGÀY: một vận đơn sống nhiều ngày, và mốc giờ trần trụi thì không đọc được thành câu chuyện.
  const groups = useMemo(() => {
    const map = new Map<string, ShipmentTimelineEntry[]>();
    for (const e of shown) {
      const key = e.at.toISOString().slice(0, 10);
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [shown]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {TIMELINE_LANES.map((lane) => {
          const n = entries.filter((e) => e.lane === lane).length;
          const on = lanes.includes(lane);
          return (
            <button
              key={lane}
              type="button"
              onClick={() => toggle(lane)}
              title={LANE_HINT[lane]}
              className={cn(
                "rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors",
                on ? LANE_TONE[lane] : "text-muted-foreground hover:bg-accent",
                !n && "opacity-40",
              )}
            >
              {LANE_LABEL[lane]} <span className="numeric">{formatNumber(n)}</span>
            </button>
          );
        })}
        {lanes.length ? (
          <button type="button" onClick={() => setLanes([])} className="rounded-md px-2 py-1 text-[11.5px] text-muted-foreground underline underline-offset-2">
            Bỏ lọc
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOldestFirst((v) => !v)}
          className="ml-auto rounded-md border px-2 py-1 text-[11.5px] text-muted-foreground hover:bg-accent"
        >
          {oldestFirst ? "Cũ nhất trước" : "Mới nhất trước"}
        </button>
      </div>

      {shown.length === 0 ? (
        /* Không có mốc nào là một THÔNG TIN, không phải một ô trống. */
        <p className="rounded-lg border border-dashed p-4 text-[12.5px] text-muted-foreground">
          {lanes.length ? "Không có mốc nào thuộc chiều đang lọc." : "Chưa có mốc nào cho vận đơn này — ERP chưa từng nhận tin gì, đây là lỗ hổng dữ liệu."}
        </p>
      ) : null}

      <div className="space-y-4">
        {groups.map(([day, list]) => (
          <div key={day}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {new Date(`${day}T00:00:00Z`).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })}
            </div>
            <ul className="space-y-2 border-l pl-3">
              {list.map((e) => (
                <li key={e.id} className="relative">
                  <span className={cn("absolute -left-[17px] top-1.5 size-2 rounded-full", LANE_TONE[e.lane].split(" ")[0])} />
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="numeric text-[11.5px] text-muted-foreground">{formatDateTime(e.at)}</span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", LANE_TONE[e.lane])} title={LANE_HINT[e.lane]}>
                      {LANE_LABEL[e.lane]}
                    </span>
                    <span className="text-[13px] font-medium">{e.title}</span>
                  </div>

                  {e.before || e.after ? (
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span className="text-muted-foreground">{e.before ?? MISSING_TEXT}</span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                      <span className="font-semibold">{e.after ?? MISSING_TEXT}</span>
                    </div>
                  ) : null}

                  <div className="text-[11px] text-muted-foreground">
                    {TIMELINE_EVENT_LABEL[e.eventType]}
                    {e.source ? ` · ${timelineSourceLabel(e.source)}` : ""}
                    {e.actorKind === "USER" ? ` · ${e.actorName}` : e.actorName ? ` · ${e.actorName} (${ACTOR_KIND_LABEL[e.actorKind]})` : ""}
                    {/*
                      MỐC ERP BIẾT đứng cạnh mốc ĐVVC, không thay nó. Chênh lệch giữa hai con số là
                      độ trễ của chính ERP — thứ duy nhất nói được webhook có rơi hay không.
                    */}
                    {e.receivedAt && Math.abs(e.receivedAt.getTime() - e.at.getTime()) > 60_000
                      ? ` · ERP biết lúc ${formatDateTime(e.receivedAt)}`
                      : ""}
                  </div>

                  {e.detail ? <div className="text-[11.5px] leading-snug text-muted-foreground">{e.detail}</div> : null}
                  {e.note ? <div className="text-[11.5px] leading-snug">{e.note}</div> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
