import Link from "next/link";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

/** Thanh tab của module Săn khách sỉ — chỉ hiện tab người xem có quyền mở. */
export function WholesaleNav({ user, active }: { user: SessionUser; active: "leads" | "outreach" | "hunter" | "dashboard" | "settings" }) {
  const tabs = [
    { key: "leads", href: "/wholesale/leads", label: "Khách sỉ tiềm năng", show: can(user, "wholesale:view") },
    { key: "outreach", href: "/wholesale/outreach", label: "Hàng đợi liên hệ", show: can(user, "wholesale:work") },
    { key: "hunter", href: "/wholesale/lead-hunter", label: "Săn khách (quét)", show: can(user, "wholesale:scan") },
    { key: "dashboard", href: "/wholesale/dashboard", label: "Hiệu quả", show: can(user, "wholesale:view") },
    { key: "settings", href: "/wholesale/settings", label: "Cấu hình & chi phí API", show: can(user, "wholesale:config") },
  ].filter((t) => t.show);
  return (
    <nav className="flex flex-wrap gap-1 border-b pb-px text-sm" aria-label="Săn khách sỉ">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={cn("-mb-px rounded-t-md border-b-2 px-3 py-1.5", t.key === active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Ghi công nguồn Google Maps — bắt buộc khi hiển thị dữ liệu Places ngoài bản đồ Google (chính sách hiển thị của Google). */
export function GoogleAttribution({ className }: { className?: string }) {
  return (
    <span className={cn("text-[11px] text-muted-foreground", className)} translate="no">
      Dữ liệu địa điểm: <span className="font-medium">Google Maps</span>
    </span>
  );
}
