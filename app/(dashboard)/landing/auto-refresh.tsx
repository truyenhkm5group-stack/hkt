"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Tự làm mới trang landing để bám sát Google Sheet gần như tức thời (bỏ qua khi tab đang ẩn). */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, Math.max(10, seconds) * 1000);
    const onVisible = () => document.visibilityState === "visible" && router.refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, seconds]);
  return null;
}
