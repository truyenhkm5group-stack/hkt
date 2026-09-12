"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * MỘT MỤC MENU, NĂM GÓC NHÌN.
 *
 * Yêu cầu: *"Không tạo sidebar quá dài."* Work OS chạm vào việc của mọi phòng, nên nếu mỗi góc
 * nhìn là một mục sidebar thì menu dài thêm sáu dòng và người dùng phải quyết định trước khi nhìn.
 * Ở đây chỉ có `/work` trên sidebar; năm tab bên trong.
 */
export function WorkTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex gap-0.5 overflow-x-auto border-b pb-px">
      {tabs.map((t) => {
        const active = t.href === "/work" ? pathname === "/work" : pathname.startsWith(t.href);
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
