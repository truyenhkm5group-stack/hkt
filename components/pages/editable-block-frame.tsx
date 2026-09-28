"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Bộ chọn của khung khối — trình kéo-thả gắn `draggable`, đo vị trí và bắt sự kiện kéo theo đúng thuộc tính này. */
const FRAME_SELECTOR = "[data-block-id]";

/**
 * Khung này có phải khung TRONG CÙNG chứa điểm bấm không. Khung cột lồng khung con (khối con của cột); cú bấm đi pha
 * BẮT từ ngoài vào trong, nên khung cột nhận nó TRƯỚC khung con — nếu khung cột chọn chính mình và chặn lan truyền thì
 * khối con không bao giờ chọn được (lỗi cũ: bấm khối con trong cột chọn cả cột). Hàm thuần — bài kiểm gọi thẳng.
 */
export function frameOwnsClick(target: { closest?: (selector: string) => unknown } | null | undefined, frame: unknown): boolean {
  const inner = typeof target?.closest === "function" ? target.closest(FRAME_SELECTOR) : null;
  return inner === null || inner === undefined || inner === frame;
}

/**
 * KHUNG CHỌN KHỐI ở chế độ soạn (`mode="edit"`) — CHỈ vẽ viền chọn + `data-block-id` và báo khối được chọn lên
 * trình kéo-thả. Không có logic kéo-thả ở đây (thuộc `components/platform/*`). Cú bấm bên trong khối (liên kết,
 * nút, kanban) bị chặn mặc định ở pha bắt: ở chế độ soạn, bấm là CHỌN, không phải chạy thao tác thật.
 *
 * Khung lồng nhau (cột → khối con): chỉ khung TRONG CÙNG chứa điểm bấm được chọn. Khung ngoài vẫn chặn hành vi mặc
 * định (liên kết không mở) nhưng KHÔNG chặn lan truyền, để cú bấm đi tiếp tới khung con ở pha bắt.
 */
export function EditableBlockFrame({ blockId, label, selected, onSelect, className, children }: { blockId: string; label: string; selected: boolean; onSelect?: (id: string) => void; className?: string; children: React.ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Chọn khối ${label}`}
      data-block-id={blockId}
      data-selected={selected || undefined}
      className={cn("relative rounded-2xl outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring", selected ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-primary/40", className)}
      onClickCapture={(e) => {
        e.preventDefault();
        if (!frameOwnsClick(e.target as Element, e.currentTarget)) return;
        e.stopPropagation();
        onSelect?.(blockId);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onSelect?.(blockId);
      }}
    >
      {children}
    </div>
  );
}
