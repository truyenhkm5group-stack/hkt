import Link from "next/link";
import { Settings } from "lucide-react";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { wholesaleNavModel, type WholesaleTabKey } from "@/lib/constants/wholesale-nav";
import { cn } from "@/lib/utils";

/**
 * Thanh tab của module Săn khách sỉ — NĂM bước theo thứ tự công việc + bánh răng cấu hình (lib/constants/wholesale-nav.ts).
 * Chỉ hiện tab người xem có quyền mở; nhóm nhiều trang (Liên hệ · Hiệu quả) có hàng tab con.
 */
export function WholesaleNav({ user, active }: { user: SessionUser; active: WholesaleTabKey }) {
  const m = wholesaleNavModel((perm) => can(user, perm), active);
  return (
    <div className="space-y-1">
      <nav className="flex flex-wrap items-end gap-1 border-b pb-px text-sm" aria-label="Săn khách sỉ">
        {m.tabs.map((t, i) => (
          <Link key={t.key} href={t.href} aria-current={t.active ? "page" : undefined} className={cn("-mb-px rounded-t-md border-b-2 px-3 py-1.5", t.active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            <span className="mr-1 text-[11px] tabular-nums text-muted-foreground">{i + 1}.</span>
            {t.label}
          </Link>
        ))}
        {m.gear ? (
          <Link href={m.gear.href} title={m.gear.label} aria-label={m.gear.label} aria-current={m.gear.active ? "page" : undefined} className={cn("-mb-px ml-auto inline-flex items-center gap-1 rounded-t-md border-b-2 px-2.5 py-1.5", m.gear.active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            <Settings className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{m.gear.label}</span>
          </Link>
        ) : null}
      </nav>
      {m.subTabs.length ? (
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Tab con">
          {m.subTabs.map((t) => (
            <Link key={t.key} href={t.href} aria-current={t.active ? "page" : undefined} className={cn("rounded-full border px-2.5 py-1", t.active ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {t.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
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
