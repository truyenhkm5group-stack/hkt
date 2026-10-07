"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { shellFitHeight } from "@/lib/constants/saas-nav";

/** Thanh dưới của vỏ app (components/saas-shell.tsx) — khung đo đúng phần nó che. */
const BOTTOM_NAV_SELECTOR = '[data-testid="sales-agent-bottom-nav"]';

/**
 * KHUNG LẤP ĐẦY MÀN HÌNH TRONG VỎ APP CHỐT ĐƠN (hộp thư). Chiều cao canh sẵn cho thanh menu ERP (`100dvh - 13.5rem`) sai trong vỏ:
 * vỏ có thanh trên 56px và thanh dưới CỐ ĐỊNH (64px + vùng an toàn iPhone), nên ô soạn tin rơi xuống DƯỚI thanh dưới. Khung này
 * đo mép trên thật của nó và chiều cao thật của thanh dưới (đã gồm `env(safe-area-inset-bottom)`), theo dõi đổi cỡ màn và bàn
 * phím ảo (visualViewport), rồi đặt chiều cao bằng `shellFitHeight`. Trước khi đo (lần dựng đầu) dùng `fallbackClassName`.
 */
export function ShellViewportFit({ className, fallbackClassName, children, testId }: { className: string; fallbackClassName: string; children: React.ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const nav = document.querySelector(BOTTOM_NAV_SELECTOR);
      const bottomNav = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().height : 0;
      setHeight(shellFitHeight({ viewport: window.visualViewport?.height ?? window.innerHeight, top: el.getBoundingClientRect().top + window.scrollY, bottomNav }));
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div ref={ref} data-testid={testId} data-fit={height === null ? "pending" : "measured"} style={height === null ? undefined : { height }} className={height === null ? `${className} ${fallbackClassName}` : className}>
      {children}
    </div>
  );
}
