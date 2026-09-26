import type { ReactNode } from "react";
import { Globe, ImageOff, MessageCircle } from "lucide-react";
import { ExpandText } from "@/app/(dashboard)/marketing/creatives/creative-bits";
import { ZoomableImg } from "@/app/(dashboard)/marketing/creatives/image-zoom";
import { DESIGN_DNA_KEYS, DESIGN_DNA_LABEL, DESIGN_DNA_VALUE_LABEL, GENE_KEYS, GENE_LABEL, GENE_VALUE_LABEL, SLOT_MODE_LABEL, type DesignDnaKey, type GeneKey, type SlotMode } from "@/lib/constants/creative-loop";
import { cn } from "@/lib/utils";

/**
 * Mảnh hiển thị dùng chung cho bốn tab của vòng mẫu (duyệt · đang chạy · thư viện · học). Không móc
 * trạng thái, không gọi action — dựng được ở cả Server Component lẫn Client Component.
 */

/**
 * Ảnh của một mẫu. Điểm ảnh đã xoá (mẫu thua quá hạn giữ) nói ra điều đó, không để khung trống. `zoomable` ⇒ bấm ảnh để
 * phóng to (khung xem toàn ảnh + mở / tải ảnh gốc) — tắt ở chỗ cú bấm đã mang nghĩa khác (ô tích chọn mẫu cảm hứng).
 */
export function VariantImage({ imageId, available, alt, className, iconClassName, zoomable = false }: { imageId: string | null; available: boolean; alt: string; className?: string; iconClassName?: string; zoomable?: boolean }) {
  const src = imageId ? `/api/creative/images/${imageId}` : "";
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {imageId && available ? (
        zoomable ? (
          <ZoomableImg src={src} alt={alt} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt} className="size-full object-cover" loading="lazy" />
        )
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

/** DNA của một thiết kế / một mã bằng nhãn tiếng Việt (cổ / tay "không áp dụng" được ẩn). */
export function DnaChips({ dna, className }: { dna: Record<string, string>; className?: string }) {
  const keys = DESIGN_DNA_KEYS.filter((k) => dna[k] && !(dna[k] === "NONE" && (k === "neckline" || k === "sleeve")));
  if (!keys.length) return <p className="text-[11.5px] italic text-muted-foreground">Chưa có DNA</p>;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {keys.map((k) => (
        <span key={k} className="rounded bg-brand/10 px-1.5 py-0.5 text-[10.5px]">
          <span className="text-muted-foreground">{DESIGN_DNA_LABEL[k as DesignDnaKey]}:</span> {(DESIGN_DNA_VALUE_LABEL[k as DesignDnaKey] as Record<string, string>)[dna[k]] ?? dna[k]}
        </span>
      ))}
    </div>
  );
}

export const MODE_LABEL = SLOT_MODE_LABEL;

/** Chế độ ô + câu "vì sao" máy chọn ô này (hover). */
export function ModeChip({ mode, why }: { mode: SlotMode; why: string }) {
  return (
    <span className="rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-semibold" title={why || undefined}>
      {MODE_LABEL[mode]}
    </span>
  );
}

/**
 * XEM TRƯỚC BÀI QUẢNG CÁO như sẽ lên bảng tin Facebook: fanpage đứng tên · nội dung chính · ảnh ·
 * thanh tiêu đề + nút "Gửi tin nhắn". Người duyệt thấy đúng thứ sẽ được đăng, không phải ba ô chữ rời.
 *
 * Nút kêu gọi thật lấy từ MẨU QC MẪU (`story-spec.ts` chép nguyên) — chiến dịch test là chiến dịch tin
 * nhắn nên hiện "Gửi tin nhắn". Mẩu mẫu là bài ẢNH (`photo_data`) thì Facebook không có ô tiêu đề.
 */
export function AdPreview({
  pageName,
  primaryText,
  headline,
  imageId,
  imageAvailable,
  alt,
  imageOverlay,
  className,
}: {
  pageName: string | null;
  primaryText: string;
  headline: string;
  imageId: string | null;
  imageAvailable: boolean;
  alt: string;
  imageOverlay?: ReactNode;
  className?: string;
}) {
  const ten = pageName?.trim() || "";
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-background", className)}>
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[12px] font-bold text-primary">{(ten || "?").slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 leading-tight">
          <p className={cn("truncate text-[12.5px] font-semibold", !ten && "italic text-muted-foreground")} title={ten ? undefined : "Chưa khai fanpage trong cấu hình lô, hoặc sổ fanpage chưa biết page này"}>
            {ten || "Fanpage chưa rõ tên"}
          </p>
          <p className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
            Được tài trợ · <Globe className="size-2.5" />
          </p>
        </div>
      </div>
      <ExpandText text={primaryText} className="px-2.5 pb-2" />
      <div className="relative">
        <VariantImage imageId={imageId} available={imageAvailable} alt={alt} className="aspect-square w-full" zoomable />
        {imageOverlay}
      </div>
      <div className="flex items-center gap-2 border-t bg-muted/50 px-2.5 py-2">
        <p className={cn("line-clamp-2 min-w-0 flex-1 text-[12.5px] font-semibold leading-snug", !headline && "font-normal italic text-muted-foreground")}>{headline || "Chưa có tiêu đề"}</p>
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11.5px] font-semibold">
          <MessageCircle className="size-3.5" /> Gửi tin nhắn
        </span>
      </div>
    </div>
  );
}
