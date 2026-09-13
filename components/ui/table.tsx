"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ColumnVisibility } from "@/components/data-table/column-visibility"
import { STICKY_HEAD, TABLE_FLOW, TABLE_SCROLL } from "@/lib/constants/table-ux"

/**
 * ═══════════ TIÊU ĐỀ CỘT DÍNH: MỘT LUẬT CHUNG, KHÔNG CHÉP CSS SANG TỪNG TRANG ═══════════
 *
 * Hợp đồng đầy đủ (và lý do đo được bằng Chromium) nằm ở `lib/constants/table-ux.ts`. Tóm tắt:
 * khung bao bảng LUÔN là khung cuộn hai chiều có trần chiều cao (`TABLE_SCROLL`), tiêu đề cột dính
 * ở mốc `0` của chính khung đó. Không có mốc "dưới thanh tiêu đề ứng dụng": khung cuộn ngang đã là
 * scrollport của `sticky`, nên mốc ấy chỉ đẩy tiêu đề xuống đè lên dữ liệu chứ không dính theo trang.
 *
 * `scrollable={false}` chỉ dành cho bảng in ra giấy hoặc bảng lồng trong ô: khung chỉ cuộn ngang,
 * không có trần chiều cao, và tiêu đề không dính (dính trong khung không giới hạn là vô nghĩa).
 */
function Table({ className, columnToggle = true, containerClassName, scrollable = true, ...props }: React.ComponentProps<"table"> & {
  /** Tắt nút ẩn/hiện cột cho bảng này */
  columnToggle?: boolean
  /** Lớp thêm cho khung cuộn bao quanh bảng (ví dụ đổi trần chiều cao trong hộp thoại: `max-h-[60vh]`). */
  containerClassName?: string
  /** Mặc định BẬT: khung cuộn hai chiều có trần chiều cao, tiêu đề dính. `false` = bảng chảy theo trang (in, lồng trong ô). */
  scrollable?: boolean
}) {
  const ref = React.useRef<HTMLTableElement>(null)
  return (
    <div className="relative w-full">
      {columnToggle ? <ColumnVisibility tableRef={ref} /> : null}
      <div
        data-slot="table-container"
        data-scrollable={scrollable ? "true" : "false"}
        className={cn(scrollable ? TABLE_SCROLL : TABLE_FLOW, containerClassName)}
      >
        <table
          ref={ref}
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
    </div>
  )
}

function TableHeader({ className, sticky = true, ...props }: React.ComponentProps<"thead"> & {
  /** Tắt tiêu đề dính cho bảng đặc biệt (bảng lồng trong ô, bảng in ra giấy). Mặc định BẬT. */
  sticky?: boolean
}) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", sticky && STICKY_HEAD, className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-hairline transition-colors hover:bg-row-hover has-aria-expanded:bg-row-hover data-[state=selected]:bg-accent/40",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-2.5 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2.5 py-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
