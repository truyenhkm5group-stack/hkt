"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Câu chữ quảng cáo dài: ba dòng, bấm để mở hết. */
export function ExpandText({ text, lines = 3, className }: { text: string; lines?: 2 | 3 | 4; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return <p className={cn("text-[12px] italic text-muted-foreground", className)}>Chưa có câu chữ</p>;
  const clamp = { 2: "line-clamp-2", 3: "line-clamp-3", 4: "line-clamp-4" }[lines];
  const dai = text.length > 120 || text.includes("\n");
  return (
    <div className={className}>
      <p className={cn("whitespace-pre-line text-[12px] leading-snug", !open && clamp)}>{text}</p>
      {dai ? (
        <button type="button" className="mt-0.5 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? "Thu gọn" : "Xem hết"}
        </button>
      ) : null}
    </div>
  );
}

function conLai(ms: number): string {
  const phut = Math.floor(ms / 60_000);
  if (phut < 1) return "dưới 1 phút";
  const gio = Math.floor(phut / 60);
  const p = phut % 60;
  return gio > 0 ? `${gio} giờ ${p} phút` : `${p} phút`;
}

/**
 * Đếm ngược tới hạn duyệt. Lần dựng đầu dùng `serverNow` (cùng đồng hồ với máy chủ, không lệch khi
 * hydrate), sau đó tự nhích mỗi 30 giây. Quá hạn thì nói "đã quá hạn" — nút duyệt đã khoá phía máy chủ.
 */
export function Countdown({ deadline, serverNow, className }: { deadline: string; serverNow: string; className?: string }) {
  const [now, setNow] = useState(() => new Date(serverNow).getTime());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(deadline).getTime() - now;
  if (!Number.isFinite(ms)) return <span className={className}>—</span>;
  return <span className={cn(className, ms <= 0 && "text-destructive")}>{ms <= 0 ? "đã quá hạn" : `còn ${conLai(ms)}`}</span>;
}
