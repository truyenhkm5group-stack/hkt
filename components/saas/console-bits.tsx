import Link from "next/link";
import { cn } from "@/lib/utils";

/** Thanh chuyển giữa các màn của SaaS Control Plane. */
export function SaasConsoleNav({ active }: { active: string }) {
  const items = [
    ["/platform/customers", "Khách hàng"],
    ["/platform/products", "Sản phẩm"],
    ["/platform/saas", "Kinh tế nền tảng"],
    ["/platform", "Vận hành"],
  ] as const;
  return (
    <nav className="flex flex-wrap gap-1 text-sm" aria-label="SaaS Control Plane">
      {items.map(([href, label]) => (
        <Link key={href} href={href} className={cn("rounded-md px-2 py-1 hover:bg-muted", active === href ? "bg-muted font-semibold" : "text-primary")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

const TONE = {
  good: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  bad: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  info: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  muted: "border-hairline bg-muted/40 text-muted-foreground",
} as const;

export function StatusPill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full border px-1.5 py-px text-[11px] font-medium", TONE[tone])}>{children}</span>;
}
