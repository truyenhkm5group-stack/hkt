import type { SiteBrand } from "@/lib/platform/site-host";
import { cn } from "@/lib/utils";

/**
 * Nhận diện thương hiệu VNXcommerce.
 *
 * Vẽ thẳng bằng SVG inline (không dùng <img>) để logo ăn theo màu chữ của khối chứa nó và
 * hiển thị đúng ở cả giao diện sáng lẫn tối. Màu cam thương hiệu nằm ở biến `--brand`
 * trong `app/globals.css` — đổi ở đó, không hard-code mã màu tại từng chỗ dùng.
 */

/** Nét gấp khúc V–N rút gọn, dùng cho ô vuông (sidebar thu gọn, favicon, avatar). */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 77 46" className={cn("h-4 w-auto", className)} fill="none" stroke="currentColor" strokeWidth={11} strokeLinejoin="round" strokeLinecap="butt" aria-hidden>
      <path d="M7 6 30 40 53 6 70 40" />
    </svg>
  );
}

/** Trọn ký hiệu VNX (gấp khúc + chữ X) — dùng khi có đủ bề ngang. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 140 44" className={cn("h-4 w-auto", className)} fill="none" stroke="currentColor" strokeWidth={11} strokeLinejoin="round" strokeLinecap="butt" aria-hidden>
      <path d="M7 5 30 39 53 5 70 39 84 5" />
      <path d="M94 5 133 39" />
      <path d="M133 5 94 39" />
    </svg>
  );
}

/** Chữ "VNXcommerce" theo đúng cách viết liền của thương hiệu (VNX đậm, commerce nhạt hơn). */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    // role="img" + aria-label: trình đọc màn hình đọc trọn "VNXcommerce" thay vì "VNX" rồi "commerce",
    // đồng thời để lại chuỗi thương hiệu liền mạch trong HTML cho smoke test dò khung ứng dụng.
    <span role="img" aria-label="VNXcommerce" className={cn("truncate font-black tracking-[-0.02em]", className)}>
      <span>VNX</span>
      <span className="font-semibold lowercase">commerce</span>
    </span>
  );
}

/**
 * Ký hiệu «Chốt Đơn Tự Động»: bong bóng chat ĐẶC có dấu tích — cùng hình với bộ biểu tượng `public/brand/chotdon/`
 * (favicon, iOS, Android). Luôn đặt trên ô `bg-brand`: bong bóng lấy màu chữ, dấu tích lấy màu thương hiệu (khoét lỗ).
 */
export function ChotDonGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="10 12.5 44 40.5" className={cn("h-4 w-auto", className)} aria-hidden>
      <path d="M17 13h30a7 7 0 0 1 7 7v17a7 7 0 0 1-7 7H32.5L22 52.5V44h-5a7 7 0 0 1-7-7V20a7 7 0 0 1 7-7z" fill="currentColor" />
      <path d="m22 28.5 6.8 6.8L42.5 21.6" fill="none" stroke="var(--brand)" strokeWidth={5.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Chữ «Chốt Đơn Tự Động» — sản phẩm AI bán hàng của VNXcommerce ở `chotdontudong.com`. */
export function ChotDonWordmark({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="Chốt Đơn Tự Động" className={cn("truncate font-black tracking-[-0.02em]", className)}>
      Chốt Đơn <span className="font-semibold">Tự Động</span>
    </span>
  );
}

/**
 * Khối logo hoàn chỉnh: ô ký hiệu + chữ. `tone="brand"` cho chữ màu cam thương hiệu,
 * `tone="inherit"` cho chữ ăn theo màu chữ xung quanh (dùng trên nền tối của sidebar).
 */
export function BrandLockup({
  className,
  wordmarkClassName,
  tone = "brand",
  showWordmark = true,
  brand = "vnx",
}: {
  className?: string;
  wordmarkClassName?: string;
  tone?: "brand" | "inherit";
  showWordmark?: boolean;
  /** Thương hiệu của host (lib/platform/host-brand.ts). Mặc định `vnx` — mọi chỗ gọi cũ giữ nguyên. */
  brand?: SiteBrand;
}) {
  const chotdon = brand === "chotdon";
  const wordClass = cn("text-[15px]", tone === "brand" ? "text-brand" : "text-current", wordmarkClassName);
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-[0_8px_20px_-10px_var(--brand)]">
        {chotdon ? <ChotDonGlyph className="h-[15px]" /> : <BrandGlyph className="h-[13px]" />}
      </span>
      {showWordmark ? chotdon ? <ChotDonWordmark className={wordClass} /> : <BrandWordmark className={wordClass} /> : null}
    </span>
  );
}
