"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ColumnVisibility } from "@/components/data-table/column-visibility"
import { APP_HEADER_OFFSET, STICKY_HEAD } from "@/lib/constants/table-ux"

/**
 * ═══════════ TIÊU ĐỀ CỘT DÍNH: MỘT LUẬT CHUNG, KHÔNG CHÉP CSS SANG TỪNG TRANG ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Luật dính trước đây nằm ở CHỖ GỌI (`components/data-table/data-table.tsx`), không nằm trong
 * primitive. Nên đúng một bảng trong ERP có tiêu đề dính, còn **100 chỗ khác dùng `<Table>` trực
 * tiếp** — Đơn hàng chi tiết, CSKH, Ngân hàng, Chi phí, Lương, Khách hàng, Chất lượng dữ liệu… —
 * và bảng Cần care viết tay bằng `<table>` thuần thì cuộn xuống là mất hết tên cột.
 *
 * ─── MỐC DÍNH PHỤ THUỘC AI ĐANG CUỘN ───
 *
 * `position: sticky` dính trong KHUNG CUỘN GẦN NHẤT, nên có đúng hai tình huống và hai mốc:
 *
 *   · bảng tự có khung cuộn dọc (trần chiều cao)  ⇒ mốc `0` — dính vào mép trên của chính khung;
 *   · bảng cuộn theo CẢ TRANG                     ⇒ mốc `3.5rem` — đúng chiều cao thanh tiêu đề
 *     ứng dụng (`components/site-header.tsx`: `sticky top-0 h-14`). Để `0` ở đây thì tiêu đề cột
 *     trượt XUỐNG DƯỚI thanh đó và biến mất — đúng lỗi mà tính năng này sinh ra để sửa.
 *
 * Khai bằng một biến CSS đặt trên khung bao: `TableHeader` chỉ đọc biến, không cần biết mình đang
 * nằm trong loại khung nào. Chỗ gọi đặc biệt (hộp thoại có vùng cuộn riêng) ghi đè được bằng
 * `containerClassName="[--table-head-top:0px]"`.
 *
 * `z-10` cố ý THẤP HƠN `z-20` của thanh tiêu đề ứng dụng: tiêu đề cột không bao giờ được đè lên
 * thanh điều hướng, và cũng không đè lên dropdown/popover (chúng render ở portal, tầng cao hơn).
 */
function Table({ className, columnToggle = true, containerClassName, scrollable = false, ...props }: React.ComponentProps<"table"> & {
  /** Tắt nút ẩn/hiện cột cho bảng này */
  columnToggle?: boolean
  /** Lớp cho khung cuộn bao quanh bảng — nơi đặt trần chiều cao để tiêu đề cột dính lại khi cuộn. */
  containerClassName?: string
  /**
   * Bảng có KHUNG CUỘN DỌC của riêng nó (chỗ gọi đã đặt trần chiều cao trong `containerClassName`).
   * Khi đó tiêu đề dính vào mép khung (mốc 0) thay vì dính dưới thanh tiêu đề ứng dụng.
   */
  scrollable?: boolean
}) {
  const ref = React.useRef<HTMLTableElement>(null)
  return (
    <div className="relative w-full">
      {columnToggle ? <ColumnVisibility tableRef={ref} /> : null}
      <div
        data-slot="table-container"
        style={{ "--table-head-top": scrollable ? "0px" : APP_HEADER_OFFSET } as React.CSSProperties}
        className={cn("relative w-full overflow-x-auto", scrollable && "overflow-y-auto", containerClassName)}
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
