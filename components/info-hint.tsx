"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Dấu ⓘ đứng cạnh một chỉ số: di chuột (máy tính) hoặc chạm (điện thoại) để xem ý nghĩa và cách
 * tính. Dùng thay cho các đoạn giải thích dài in thẳng ra màn hình — thông tin vẫn còn nguyên,
 * chỉ hiện khi người dùng cần, để màn hình còn lại là số liệu.
 *
 * Dùng Popover thay Tooltip vì Tooltip không mở được khi chạm trên điện thoại.
 */
export function InfoHint({
  children,
  label = "Giải thích cách tính",
  className,
  align = "start",
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info className="size-[13px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="top"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-[min(22rem,calc(100vw-2rem))] text-xs leading-5 [&_b]:font-semibold [&_strong]:font-semibold"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
