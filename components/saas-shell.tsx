"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Bot, CreditCard, LayoutDashboard, MessagesSquare, MoreHorizontal, Package, Plug, Settings, Users } from "lucide-react";
import type { Role } from "@/db/schema";
import { bellShowsSharedQueue } from "@/components/app-sidebar";
import type { TopNavBrand } from "@/components/app-topnav";
import { LinkPending, LinkProgressReporter } from "@/components/nav-progress";
import { NavUser } from "@/components/nav-user";
import { NotificationBell } from "@/components/notification-bell";
import { RealtimeIndicator } from "@/components/realtime-provider";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SALES_AGENT_MOBILE_PRIMARY, SHELL_BLOCKED_MESSAGE, SHELL_BLOCKED_PARAM, salesAgentActiveKey, salesAgentHomeFor, salesAgentNavFor, type SalesAgentNavItem, type SalesAgentNavKey } from "@/lib/constants/saas-nav";
import { cn } from "@/lib/utils";

/**
 * ═══════════ VỎ APP CỦA KHÁCH CHỐT ĐƠN TỰ ĐỘNG ═══════════
 *
 * Thay thanh menu viên thuốc của ERP cho workspace «Sales Agent» (`salesAgentShell`, lib/constants/saas-nav.ts). Danh sách mục
 * và luật lọc sống ở sổ khai đó; tệp này chỉ giữ BẢNG ICON và cách vẽ (cùng phân vai với app-sidebar / app-topnav — AGENTS
 * mục 69). `Record<SalesAgentNavKey, …>` nên thêm một mục mà quên icon là lỗi biên dịch.
 *
 * MOBILE-FIRST: dưới 1024px là thanh trên gọn (thương hiệu · chuông · tài khoản) + THANH DƯỚI bốn mục hay dùng và nút «Thêm» mở
 * ngăn kéo chứa bốn mục còn lại. Mọi ô bấm ≥ 44px. Từ 1024px là thanh bên trái tám mục.
 */
const ICON: Record<SalesAgentNavKey, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  inbox: MessagesSquare,
  ai: Bot,
  products: Package,
  channels: Plug,
  staff: Users,
  plan: CreditCard,
  settings: Settings,
};

export type SalesAgentShellUser = { name: string; email: string; role: Role; permissions: string[]; modules?: string[]; organization?: { isHome: boolean; brand?: "vnx" | "chotdon" | null } | null };

function Brand({ brand, home }: { brand: TopNavBrand; home: string }) {
  const name = brand?.name ?? "Chốt Đơn Tự Động";
  return (
    <Link href={home} aria-label={`${name} — về hộp thư`} className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl px-1" data-org-brand>
      {brand?.logoUrl ? (
        // Logo tải qua route có kiểm tổ chức (`/api/branding/logo`) — không qua bộ tối ưu ảnh của Next.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoUrl} alt="" className="size-9 shrink-0 rounded-xl object-contain" />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">{name.trim().charAt(0).toUpperCase() || "•"}</span>
      )}
      <span className="truncate text-[15px] font-bold text-foreground">{name}</span>
    </Link>
  );
}

/** Máy chủ vừa chuyển người dùng khỏi một trang ngoài vỏ (`?ngoai-goi=1`) ⇒ nói ra một câu, không im lặng. */
function BlockedNotice() {
  const params = useSearchParams();
  if (params?.get(SHELL_BLOCKED_PARAM) !== "1") return null;
  return (
    <p role="status" className="mx-3 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:mx-5 lg:mx-6 lg:mt-6 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="shell-blocked-notice">
      {SHELL_BLOCKED_MESSAGE}
    </p>
  );
}

function SideItem({ item, active, onNavigate }: { item: SalesAgentNavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = ICON[item.key];
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      data-nav-key={item.key}
      onClick={onNavigate}
      className={cn("flex min-h-11 items-center gap-3 rounded-xl px-3 text-[14px] transition-colors", active ? "bg-ink font-semibold text-ink-foreground" : "text-foreground/85 hover:bg-muted")}
    >
      <Icon className={cn("size-[18px] shrink-0", active ? "text-brand-bright" : "text-muted-foreground")} aria-hidden />
      <span className="truncate">{item.label}</span>
      <LinkPending />
      <LinkProgressReporter />
    </Link>
  );
}

export function SalesAgentShell({ user, brand, children }: { user: SalesAgentShellUser; brand: TopNavBrand; children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const items = salesAgentNavFor(user);
  const active = salesAgentActiveKey(pathname, items);
  const home = salesAgentHomeFor(user);
  const primary = SALES_AGENT_MOBILE_PRIMARY.map((k) => items.find((i) => i.key === k)).filter((i): i is SalesAgentNavItem => Boolean(i));
  const more = items.filter((i) => !SALES_AGENT_MOBILE_PRIMARY.includes(i.key));
  const moreActive = more.some((i) => i.key === active);
  const [moreOpen, setMoreOpen] = useState(false);
  const sharedQueue = bellShowsSharedQueue(user);

  return (
    <div className="flex min-h-screen" data-shell="sales-agent">
      {/* ── Màn rộng: thanh bên tám mục ── */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-3 border-r border-hairline bg-card px-3 py-4 lg:flex print:hidden" data-testid="sales-agent-sidebar">
        <Brand brand={brand} home={home} />
        <nav aria-label="Điều hướng chính" className="flex flex-col gap-0.5">
          {items.map((item) => (
            <SideItem key={item.key} item={item} active={item.key === active} />
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-1 border-t border-hairline pt-3">
          <NavUser user={user} hidePayslip />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{user.name}</span>
          <RealtimeIndicator />
          <NotificationBell sharedQueue={sharedQueue} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Màn hẹp: thanh trên gọn ── */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-hairline bg-background/90 px-3 backdrop-blur-md lg:hidden print:hidden">
          <div className="min-w-0 flex-1">
            <Brand brand={brand} home={home} />
          </div>
          <RealtimeIndicator />
          <NotificationBell sharedQueue={sharedQueue} />
          <NavUser user={user} hidePayslip />
        </header>

        <Suspense fallback={null}>
          <BlockedNotice />
        </Suspense>
        {children}

        {/* ── Màn hẹp: thanh dưới bốn mục + «Thêm» ── */}
        <nav aria-label="Điều hướng chính" className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-card pb-[env(safe-area-inset-bottom)] lg:hidden print:hidden" data-testid="sales-agent-bottom-nav">
          <ul className="grid" style={{ gridTemplateColumns: `repeat(${primary.length + (more.length ? 1 : 0)}, minmax(0, 1fr))` }}>
            {primary.map((item) => {
              const Icon = ICON[item.key];
              const on = item.key === active;
              return (
                <li key={item.key}>
                  <Link href={item.href} aria-current={on ? "page" : undefined} data-nav-key={item.key} className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px]", on ? "font-semibold text-foreground" : "text-muted-foreground")}>
                    <Icon className={cn("size-[22px]", on && "text-primary")} aria-hidden />
                    <span className="max-w-full truncate px-1">{item.short}</span>
                  </Link>
                </li>
              );
            })}
            {more.length ? (
              <li>
                <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
                  <SheetTrigger asChild>
                    <button type="button" aria-label="Thêm mục" className={cn("flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px]", moreActive ? "font-semibold text-foreground" : "text-muted-foreground")}>
                      <MoreHorizontal className={cn("size-[22px]", moreActive && "text-primary")} aria-hidden />
                      <span>Thêm</span>
                    </button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="gap-0 rounded-t-2xl p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
                    <SheetHeader className="px-2 pb-2">
                      <SheetTitle>Thêm</SheetTitle>
                      <SheetDescription className="sr-only">Các mục còn lại của ứng dụng</SheetDescription>
                    </SheetHeader>
                    <nav aria-label="Mục khác" className="flex flex-col gap-0.5">
                      {more.map((item) => (
                        <SideItem key={item.key} item={item} active={item.key === active} onNavigate={() => setMoreOpen(false)} />
                      ))}
                    </nav>
                  </SheetContent>
                </Sheet>
              </li>
            ) : null}
          </ul>
        </nav>
      </div>
    </div>
  );
}
