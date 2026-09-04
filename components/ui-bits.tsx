import { cn } from "@/lib/utils";

/** Khối thông tin nhãn/giá trị dùng trong trang chi tiết */
export function DescriptionList({ items, className, columns = 2 }: { items: { label: string; value: React.ReactNode; span?: boolean }[]; className?: string; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm", columns === 1 ? "grid-cols-1" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className={cn("min-w-0", item.span && "sm:col-span-full")}>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 break-words font-medium">{item.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionCard({ title, description, actions, children, className, contentClassName, padded = true }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; contentClassName?: string; padded?: boolean }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs", className)}>
      {title ? (
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h2 className="text-sm font-bold">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(padded && "p-5", contentClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, description, action, className }: { title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center", className)}>
      <p className="text-sm font-semibold">{title}</p>
      {description ? <p className="max-w-md text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Money({ value, className, compact, sign }: { value: number | null | undefined; className?: string; compact?: boolean; sign?: boolean }) {
  const n = Number(value ?? 0);
  const formatted = compact
    ? (() => {
        const abs = Math.abs(n);
        const s = n < 0 ? "-" : sign && n > 0 ? "+" : "";
        if (abs >= 1_000_000_000) return `${s}${(abs / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")} tỷ`;
        if (abs >= 1_000_000) return `${s}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")} tr`;
        if (abs >= 1_000) return `${s}${Math.round(abs / 1_000)}k`;
        return `${s}${abs}`;
      })()
    : `${n < 0 ? "-" : sign && n > 0 ? "+" : ""}${new Intl.NumberFormat("vi-VN").format(Math.abs(n))} ₫`;
  return <span className={cn("numeric", className)}>{formatted}</span>;
}
