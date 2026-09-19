"use client";

import { Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Dấu ⓘ đứng cạnh một chỉ số: di chuột (máy tính) hoặc chạm (điện thoại) để xem ý nghĩa và cách
 * tính. Dùng thay cho các đoạn giải thích dài in thẳng ra màn hình — thông tin vẫn còn nguyên,
 * chỉ hiện khi người dùng cần, để màn hình còn lại là số liệu.
 *
 * Dùng Popover thay Tooltip vì Tooltip không mở được khi chạm trên điện thoại.
 *
 * ═══════════ BA LỖI ĐO ĐƯỢC NGÀY 19/09/2026, VÀ VÌ SAO MỖI CÁI CẦN MỘT VẾ RIÊNG ═══════════
 *
 * 1. **MỞ LÊN TRÊN LÀ ĐÈ LÊN HÀNG TAB.** `side="top"` cố định: ⓘ của dải tóm tắt nằm ngay dưới
 *    hàng tab, nên bảng giải thích trải lên che đúng các tab. Cú bấm tiếp theo của người dùng rơi
 *    vào bảng chứ không vào tab "Đã xử lý" — nhìn từ phía họ thì tab ấy "bấm không được". Nên mặc
 *    định mở XUỐNG, và để Radix tự lật khi hết chỗ (`avoidCollisions` + `collisionPadding`).
 *
 * 2. **CUỘN XONG BẢNG VẪN NẰM ĐÓ.** Cuộn không sinh `mouseleave` khi con trỏ đứng yên, mà bảng thì
 *    bám theo neo — người dùng cuộn tiếp và bảng đi theo, che nội dung. Nên nghe `scroll` ở pha
 *    BẮT (`capture: true`) để bắt được cả vùng cuộn bên trong, và đóng ngay.
 *
 * 3. **KHE HỞ GIỮA NÚT VÀ BẢNG LÀM BẢNG NHẤP NHÁY.** Bản cũ đóng ngay khi chuột rời nút; đi từ nút
 *    xuống bảng phải băng qua `sideOffset` px trống, và trong khoảnh khắc đó bảng biến mất. Nên
 *    đóng có ĐỘ TRỄ ngắn, và chuột vào bảng thì huỷ lệnh đóng.
 *
 * Escape và bấm ra ngoài đã do Radix lo; ở đây chỉ thêm những gì Radix không biết.
 */

/** Đủ để đi từ nút xuống bảng, chưa đủ để người dùng thấy nó "dính". */
const DELAY_DONG_MS = 120;

export function InfoHint({
  children,
  label = "Giải thích cách tính",
  className,
  align = "start",
  side = "bottom",
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
  align?: "start" | "center" | "end";
  /** Mặc định mở XUỐNG. Chỉ đổi khi ⓘ nằm sát đáy màn hình và không có gì quan trọng ở trên. */
  side?: "top" | "right" | "bottom" | "left";
}) {
  const [open, setOpen] = useState(false);
  const hen = useRef<ReturnType<typeof setTimeout> | null>(null);

  const huyHen = useCallback(() => {
    if (hen.current) {
      clearTimeout(hen.current);
      hen.current = null;
    }
  }, []);

  const moNgay = useCallback(() => {
    huyHen();
    setOpen(true);
  }, [huyHen]);

  const dongTre = useCallback(() => {
    huyHen();
    hen.current = setTimeout(() => setOpen(false), DELAY_DONG_MS);
  }, [huyHen]);

  // Dọn hẹn khi rời màn hình: một `setTimeout` gọi `setState` trên component đã gỡ là một cảnh báo
  // trong console mà không ai đi tìm nguyên nhân.
  useEffect(() => huyHen, [huyHen]);

  /*
    CUỘN LÀ ĐÓNG. `capture: true` vì sự kiện `scroll` KHÔNG nổi bọt lên `window` — bàn care cuộn ở
    một thẻ bên trong, nên nghe ở pha nổi bọt sẽ không bao giờ nhận được gì.
  */
  useEffect(() => {
    if (!open) return;
    const dong = () => {
      huyHen();
      setOpen(false);
    };
    window.addEventListener("scroll", dong, { capture: true, passive: true });
    window.addEventListener("resize", dong, { passive: true });
    return () => {
      window.removeEventListener("scroll", dong, { capture: true });
      window.removeEventListener("resize", dong);
    };
  }, [open, huyHen]);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        huyHen();
        setOpen(v);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onMouseEnter={moNgay}
          onMouseLeave={dongTre}
          onFocus={moNgay}
          onBlur={dongTre}
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
        side={side}
        sideOffset={6}
        avoidCollisions
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={moNgay}
        onMouseLeave={dongTre}
        className="w-[min(22rem,calc(100vw-2rem))] text-xs leading-5 [&_b]:font-semibold [&_strong]:font-semibold"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
