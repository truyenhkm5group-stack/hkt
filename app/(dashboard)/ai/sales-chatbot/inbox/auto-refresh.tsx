"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Hộp thư tự làm mới mỗi 8 giây khi tab đang mở (tin khách mới, bot vừa trả lời, đồng nghiệp vừa nhận hội thoại). */
export function InboxAutoRefresh({ everyMs = 8_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => window.clearInterval(id);
  }, [router, everyMs]);
  return null;
}
