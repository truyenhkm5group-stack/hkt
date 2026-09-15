"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * MỘT MỤC MENU, BỐN GÓC NHÌN — cùng lối với Work OS (`app/(dashboard)/work/tabs.tsx`).
 *
 * Lương chạm tới mọi phòng, nhưng ba màn hình khai báo (chính sách · phân công · điều chỉnh) là
 * việc của người quản lý lương, không phải thứ cả shop mở hằng ngày. Cho mỗi cái một dòng sidebar
 * là bắt mọi người đọc qua chúng mỗi lần tìm bảng lương.
 */
export function PayrollTabs({ canManage }: { canManage: boolean }) {
  const pathname = usePathname();
  const tabs = [
    { href: "/payroll", label: "Bảng lương" },
    ...(canManage
      ? [
          { href: "/payroll/policies", label: "Chính sách lương" },
          { href: "/payroll/assignments", label: "Phân công & gán chính sách" },
          { href: "/payroll/adjustments", label: "Đầu vào & điều chỉnh" },
          { href: "/payroll/migration", label: "Xem trước chuyển đổi" },
        ]
      : []),
  ];
  return (
    <nav className="-mx-1 flex gap-0.5 overflow-x-auto border-b pb-px">
      {tabs.map((t) => {
        const active = t.href === "/payroll" ? pathname === "/payroll" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "whitespace-nowrap rounded-t-md px-3 py-2 text-sm font-medium transition-colors",
              active ? "border-b-2 border-primary text-foreground" : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
