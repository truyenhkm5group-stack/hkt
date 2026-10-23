import Link from "next/link";
import { asOfCells, type AsOfInput } from "@/lib/constants/data-as-of";
import { cn } from "@/lib/utils";

/**
 * Một hàng «tính lúc · nguồn · trễ ĐVVC» (OD-UX-03). Chữ dựng ở `asOfCells` (hàm thuần dùng chung) — component này chỉ vẽ.
 * Không có màu xanh: «không có tin xấu» chưa phải là «khoẻ» (AGENTS 52); chỉ LAGGING / STALLED đổi sang hổ phách.
 */
export function DataAsOfLine({ input, className }: { input: AsOfInput; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground", className)}>
      {asOfCells(input).map((c) => (
        <span key={c.key} title={c.title} className={c.tone === "warn" ? "font-medium text-amber-700 dark:text-amber-300" : undefined}>
          {c.href ? (
            <Link href={c.href} className="underline-offset-2 hover:underline">
              {c.text}
            </Link>
          ) : (
            c.text
          )}
        </span>
      ))}
    </div>
  );
}
