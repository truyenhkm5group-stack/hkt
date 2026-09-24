import { ImageOff } from "lucide-react";
import { GENE_KEYS, GENE_LABEL, GENE_VALUE_LABEL, type GeneKey } from "@/lib/constants/creative-loop";
import { cn } from "@/lib/utils";

/**
 * Mảnh hiển thị dùng chung cho bốn tab của vòng mẫu (duyệt · đang chạy · thư viện · học). Không móc
 * trạng thái, không gọi action — dựng được ở cả Server Component lẫn Client Component.
 */

/** Ảnh của một mẫu. Điểm ảnh đã xoá (mẫu thua quá hạn giữ) nói ra điều đó, không để khung trống. */
export function VariantImage({ imageId, available, alt, className, iconClassName }: { imageId: string | null; available: boolean; alt: string; className?: string; iconClassName?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {imageId && available ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/creative/images/${imageId}`} alt={alt} className="size-full object-cover" loading="lazy" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 text-center text-[10.5px] text-muted-foreground">
          <ImageOff className={cn("size-6", iconClassName)} />
          {imageId ? "Điểm ảnh đã xoá" : "Chưa có ảnh"}
        </div>
      )}
    </div>
  );
}

/** Sáu gen bằng nhãn tiếng Việt. `mutated` = gen mà ô KHAI THÁC đã đổi so với mẫu cha — tô đậm. */
export function GeneChips({ genes, mutated, className }: { genes: Record<string, string>; mutated?: string; className?: string }) {
  const keys = GENE_KEYS.filter((k) => genes[k]);
  if (!keys.length) return <p className="text-[11.5px] italic text-muted-foreground">Không có gen</p>;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {keys.map((k) => (
        <span key={k} className={cn("rounded bg-muted px-1.5 py-0.5 text-[10.5px]", k === mutated && "bg-primary/10 font-semibold text-primary")} title={k === mutated ? "Gen được ĐỔI so với mẫu cha" : undefined}>
          <span className="text-muted-foreground">{GENE_LABEL[k as GeneKey]}:</span> {GENE_VALUE_LABEL[genes[k]] ?? genes[k]}
        </span>
      ))}
    </div>
  );
}

export const MODE_LABEL = { EXPLOIT: "Khai thác", EXPLORE: "Thăm dò" } as const;

/** Chế độ ô + câu "vì sao" máy chọn ô này (hover). */
export function ModeChip({ mode, why }: { mode: "EXPLOIT" | "EXPLORE"; why: string }) {
  return (
    <span className="rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-semibold" title={why || undefined}>
      {MODE_LABEL[mode]}
    </span>
  );
}
