"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { SOURCING_DATA_STATUS_LABEL, SOURCING_DATA_STALE_DAYS, staleness, type SourcingDataStatus } from "@/lib/constants/sourcing";
import { formatDate } from "@/lib/format";
import { formatCny, type PriceTier } from "@/lib/sourcing/price";
import { cn } from "@/lib/utils";

/**
 * Ảnh nguồn: CHỈ hiện từ link (không tải về, không proxy — SRC-7). `no-referrer` để trang nguồn không thấy ERP đang xem; ảnh
 * không tải được (chặn hotlink, link chết) thì nói ra, không giấu.
 */
export function OfferImage({ src, alt, size = 64 }: { src: string | null; alt: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };
  if (!src) return <div style={box} className="flex shrink-0 items-center justify-center rounded-md border border-dashed text-[10px] text-muted-foreground">chưa có ảnh</div>;
  if (broken)
    return (
      <div style={box} className="flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed px-1 text-center text-[10px] leading-tight text-muted-foreground">
        <ImageOff className="size-3.5" />
        ảnh không tải được
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- ảnh ngoài, không qua bộ tối ưu ảnh (không proxy, không tải về)
    <img src={src} alt={alt} style={box} className="shrink-0 rounded-md border object-cover" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
  );
}

/** Nguồn + tuổi của một con số: «Nhập tay · 23/10/2026», thêm «cũ» khi quá ngưỡng. Không có mốc ⇒ «chưa có mốc». */
export function DataAge({ source, asOf, now }: { source: SourcingDataStatus; asOf: Date | string | null; now: Date }) {
  const age = staleness(asOf, now);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      {SOURCING_DATA_STATUS_LABEL[source]} · {asOf ? formatDate(asOf) : "chưa có mốc"}
      {age?.stale ? (
        <span className="rounded bg-amber-100 px-1 font-medium text-amber-900 dark:bg-amber-950/50 dark:text-amber-200" title={`Quá ${SOURCING_DATA_STALE_DAYS} ngày — nên xem lại trên trang nguồn`}>
          cũ {age.days} ngày
        </span>
      ) : null}
    </span>
  );
}

/** «≥2: ¥12.30 · ≥50: ¥11.80». Bậc hỏng ⇒ nói ra. */
export function TiersText({ tiers, className }: { tiers: PriceTier[] | null; className?: string }) {
  if (!tiers) return <span className={cn("text-amber-700 dark:text-amber-300", className)}>bậc giá hỏng</span>;
  return <span className={cn("tabular-nums", className)}>{tiers.map((t) => `≥${t.fromQty}: ${formatCny(t.priceFen)}`).join(" · ")}</span>;
}
