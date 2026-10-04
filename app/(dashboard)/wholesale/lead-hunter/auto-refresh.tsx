"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Tự làm mới khi còn chiến dịch đang quét — chỉ khi tab đang được nhìn. Không quét thì không gọi máy chủ. */
export function AutoRefresh({ active, seconds = 10 }: { active: boolean; seconds?: number }) {
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
  if (!active) return <span className="text-[12px] text-muted-foreground">Không chiến dịch nào đang quét.</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
      Đang quét — tự làm mới mỗi {seconds} giây{at ? ` · lần cuối ${at.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
    </span>
  );
}
