"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * KHUNG CHỌN KHỐI ở chế độ soạn (`mode="edit"`) — CHỈ vẽ viền chọn + `data-block-id` và báo khối được chọn lên
 * trình kéo-thả. Không có logic kéo-thả ở đây (thuộc `components/platform/*`). Cú bấm bên trong khối (liên kết,
 * nút, kanban) bị chặn ở pha bắt: ở chế độ soạn, bấm là CHỌN, không phải chạy thao tác thật.
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
