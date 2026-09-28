"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Tự làm mới trang khi còn việc đang chạy — chỉ khi tab đang được nhìn (tab ẩn không gọi máy chủ). Không có việc chạy thì
 * không làm gì: màn hình tĩnh không tốn một truy vấn nào.
 */
export function AutoRefresh({ active, seconds = 15 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setAt(new Date());
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  if (!active) return <span className="text-[12px] text-muted-foreground">Không còn việc nào đang chạy.</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
      Tự làm mới mỗi {seconds} giây{at ? ` · lần cuối ${at.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
    </span>
  );
}
