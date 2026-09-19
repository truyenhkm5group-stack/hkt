"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Thanh chuyển màn hình trong Phòng Tech AI.
 *
 * Năm màn hình nhưng CHỈ MỘT mục trên thanh điều hướng bên trái (`/tech`) — cùng cách `/payroll`
 * làm. Lý do: thanh bên trái là bản đồ của cả ERP, và nhét năm mục của một module vào đó làm loãng
 * bản đồ của mọi module khác.
 */
const TABS = [
  { href: "/tech", label: "Tổng quan" },
  { href: "/tech/tasks", label: "Hàng đợi việc" },
  { href: "/tech/cto", label: "AI CTO" },
  { href: "/tech/agents", label: "Sổ agent" },
  { href: "/tech/deployments", label: "Deploy" },
  { href: "/tech/incidents", label: "Sự cố" },
];

export function TechNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-1 rounded-xl border bg-card p-1 text-sm shadow-[var(--shadow-card)]">
      {TABS.map((tab) => {
        // `/tech` chỉ khớp chính xác; các tab khác khớp cả trang chi tiết bên dưới nó.
        const active = tab.href === "/tech" ? pathname === "/tech" : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 font-semibold transition-colors",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
