"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Báo +1 lượt mở trang mỗi lần ĐƯỜNG DẪN đổi (đổi bộ lọc / trang số trên cùng màn hình không tính).
 * Chỉ gửi đường dẫn — máy chủ quy nó về mục đã khai rồi bỏ đi (`lib/constants/page-usage.ts`).
 * `sendBeacon` không chặn điều hướng và không cần chờ phản hồi; trình duyệt thiếu nó thì dùng
 * `fetch` giữ-sống. Mọi lỗi bị nuốt: bộ đếm không bao giờ được làm hỏng một trang.
 */
export function PageVisitBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    try {
      const body = JSON.stringify({ path: pathname });
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/usage/visit", new Blob([body], { type: "application/json" }));
      } else {
        void fetch("/api/usage/visit", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => undefined);
      }
    } catch {
      // Bỏ qua — xem chú thích đầu tệp.
    }
  }, [pathname]);
  return null;
}
