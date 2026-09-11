import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { cn } from "@/lib/utils";

/**
 * ═══════════ DẢI CHỈ SỐ PHỤ ═══════════
 *
 * Một màn hình chỉ chịu được vài con số DẪN DẮT. Phần còn lại vẫn cần có mặt nhưng không được
 * to ngang nhau — mười thẻ bằng nhau nghĩa là không thẻ nào quan trọng, và mắt không biết đọc
 * từ đâu. Dải này gom các chỉ số phụ vào MỘT khối, mỗi ô một dòng chữ và một con số, ngăn nhau
 * bằng đường kẻ mảnh thay vì mỗi ô một cái thẻ.
 *
 * Quy ước giống thẻ lớn: nhãn → số → bối cảnh, giải thích nằm trong ⓘ.
 */

const valueTones = {
  default: "text-foreground",
  green: "text-success",
  amber: "text-amber-600 dark:text-amber-400",
  rose: "text-destructive",
  muted: "text-muted-foreground",
};

export type StatTone = keyof typeof valueTones;

export type StatTileProps = {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatTone;
  href?: string;
};

export function StatStrip({ items, className, columns = 4 }: { items: StatTileProps[]; className?: string; columns?: 2 | 3 | 4 | 5 }) {
  const cols = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4", 5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" }[columns];
  /*
    ĐƯỜNG KẺ LÀ KHE HỞ 1px, KHÔNG PHẢI VIỀN CỦA TỪNG Ô.
    Lưới này đổi số cột theo bề rộng màn hình. Nếu mỗi ô tự vẽ viền trái thì ô đầu của hàng thứ
    hai cũng vẽ — thành một vạch lạc lõng giữa khối — còn giữa hai hàng lại chẳng có vạch nào.
    Để nền cả khối là màu viền rồi chừa khe 1px giữa các ô thì lưới gãy hàng kiểu gì đường kẻ
    cũng tự đúng: ngang có, dọc có, mép ngoài không thừa.
  */
  return (
    <div className={cn("grid gap-px overflow-hidden rounded-xl border bg-border shadow-[var(--shadow-card)]", cols, className)}>
      {items.map((item) => (
        <StatTile key={item.label} {...item} className="bg-card" />
      ))}
    </div>
  );
}

export function StatTile({ label, value, note, hint, icon: Icon, tone = "default", href, className }: StatTileProps & { className?: string }) {
  const body = (
    <>
      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
        {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden /> : null}
        <span className="truncate">{label}</span>
        {hint ? <InfoHint>{hint}</InfoHint> : null}
      </p>
      <p className={cn("numeric mt-1 text-[19px] font-bold leading-6 tracking-tight", valueTones[tone])}>{value}</p>
      {note ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{note}</p> : null}
    </>
  );
  const shell = cn("min-w-0 px-4 py-3", className);
  if (!href) return <div className={shell}>{body}</div>;
  return (
    <Link href={href} className={cn(shell, "block transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}>
      {body}
    </Link>
  );
}
