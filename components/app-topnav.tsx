"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";
import { ChevronDown, Menu } from "lucide-react";
import type { Role } from "@/db/schema";
import { activeHrefOf, iconOf, visibleGroups } from "@/components/app-sidebar";
import { AiCopilot } from "@/components/ai-copilot";
import { BrandGlyph, BrandWordmark } from "@/components/brand";
import { GlobalSearch } from "@/components/global-search";
import { LinkPending, LinkProgressReporter } from "@/components/nav-progress";
import { NavUser } from "@/components/nav-user";
import { NotificationBell } from "@/components/notification-bell";
import { RealtimeIndicator } from "@/components/realtime-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { ModuleZone } from "@/lib/constants/department-modules";
import { cn } from "@/lib/utils";

/**
 * ═══════════ THANH MENU VIÊN THUỐC (giao diện Bento) ═══════════
 *
 * Thay thanh bên tối từ 24/09/2026. Mỗi PHÒNG BAN là một viên thuốc; bấm vào thì thả xuống đúng các
 * trang của phòng đó — cùng sổ khai `MODULE_GROUPS`, cùng luật lọc quyền, nên thanh menu này không
 * có danh sách thứ hai nào để lệch khỏi ô lệnh ⌘K hay bản đồ phòng ban.
 *
 * Viên của phòng đang chứa trang hiện tại tô MỰC, để người đọc luôn biết mình đang ở phòng nào mà
 * không cần mở menu ra.
 *
 * Màn hẹp hơn 1280px không đủ chỗ cho chín viên: nút ☰ mở cùng danh sách ấy trong một ngăn kéo.
 * Từ 1280 tới 1535px ô tìm kiếm thu thành nút tròn (⌘K vẫn mở được) để chín viên vừa một hàng. Hàng
 * viên vẫn CUỘN NGANG được như lưới an toàn: một viên bị che mà không cuộn tới được là cả một phòng
 * ban biến khỏi menu — đúng lỗi đã thấy ở bản đầu, khi ô tìm kiếm rộng đẩy "Điều hành" và "Hệ thống"
 * ra ngoài khung mà không để lại dấu vết nào.
 */

/** Nhãn ngắn cho viên thuốc; nhãn đầy đủ vẫn hiện ở đầu menu thả xuống. */
const PILL_LABEL: Partial<Record<ModuleZone, string>> = {
  SALES: "Kinh doanh",
  MANAGEMENT: "Điều hành",
};

type TopNavUser = { name: string; email: string; role: Role; permissions: string[] };

function itemClass(active: boolean) {
  return cn(
    "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] outline-none transition-colors",
    active ? "bg-ink font-semibold text-ink-foreground focus:bg-ink focus:text-ink-foreground" : "text-foreground/85 hover:bg-muted focus:bg-muted focus-visible:bg-muted",
  );
}

/** Ruột một mục menu: icon + nhãn + chấm chờ. Chấm chờ phải nằm TRONG `<Link>` mới đọc được trạng thái của nó. */
function ItemInner({ href, label, active }: { href: string; label: string; active: boolean }) {
  const Icon = iconOf(href);
  return (
    <>
      <Icon className={cn("size-4 shrink-0", active ? "text-brand-bright" : "text-muted-foreground")} aria-hidden />
      <span className="truncate">{label}</span>
      <LinkPending />
      <LinkProgressReporter />
    </>
  );
}

export function AppTopNav({ user }: { user: TopNavUser }) {
  const pathname = usePathname();
  const activeHref = activeHrefOf(pathname);
  const groups = visibleGroups(user);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 bg-background/85 px-3 pb-2 pt-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:px-5 lg:px-6 2xl:px-8 print:hidden">
      <div className="flex h-14 items-center gap-1 rounded-full bg-card pl-2 pr-1.5 shadow-[var(--shadow-card)]">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <button type="button" aria-label="Mở menu" className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground xl:hidden">
              <Menu className="size-5" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[300px] gap-0 overflow-y-auto p-3">
            <SheetHeader className="px-2 pb-2">
              <SheetTitle>Menu</SheetTitle>
              <SheetDescription className="sr-only">Mọi trang bạn được vào, xếp theo phòng ban</SheetDescription>
            </SheetHeader>
            <nav aria-label="Điều hướng chính" className="space-y-4">
              {groups.map((group) => (
                <div key={group.zone}>
                  <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" title={group.hint}>
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      // CỐ Ý DÙNG PREFETCH MẶC ĐỊNH: ép `prefetch` là dựng trước dữ liệu của từng trang trong menu.
                      <Link key={item.href} href={item.href} onClick={() => setSheetOpen(false)} aria-current={item.href === activeHref ? "page" : undefined} className={itemClass(item.href === activeHref)}>
                        <ItemInner href={item.href} label={item.label} active={item.href === activeHref} />
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </SheetContent>
        </Sheet>

        <Link href="/" aria-label="VNXcommerce — về trang tổng quan" className="mr-2 flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-opacity hover:opacity-90">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand text-white">
            <BrandGlyph className="h-[12px]" />
          </span>
          <BrandWordmark className="hidden text-[16px] text-foreground sm:inline xl:hidden 2xl:inline" />
        </Link>

        <nav aria-label="Điều hướng chính" className="hidden min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] xl:flex [&::-webkit-scrollbar]:hidden">
          {groups.map((group) => {
            const holdsActive = group.items.some((i) => i.href === activeHref);
            const label = PILL_LABEL[group.zone] ?? group.label;
            const pill = cn(
              "flex h-10 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 text-[13.5px] 2xl:px-3.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              holdsActive ? "bg-ink font-semibold text-ink-foreground" : "font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
            );
            return (
              <DropdownMenu key={group.zone}>
                <DropdownMenuTrigger className={pill}>
                  {label}
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={10} className="w-72 rounded-2xl p-2">
                  <DropdownMenuLabel className="px-2.5 pb-1.5 pt-1">
                    <span className="block text-[13px] font-bold">{group.label}</span>
                    <span className="block text-[11.5px] font-normal leading-4 text-muted-foreground">{group.hint}</span>
                  </DropdownMenuLabel>
                  {group.items.map((item) => (
                    <DropdownMenuItem key={item.href} asChild className={itemClass(item.href === activeHref)}>
                      <Link href={item.href} aria-current={item.href === activeHref ? "page" : undefined}>
                        <ItemInner href={item.href} label={item.label} active={item.href === activeHref} />
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <GlobalSearch user={user} />
          <Suspense fallback={null}>
            <AiCopilot />
          </Suspense>
          <NotificationBell />
          <RealtimeIndicator />
          <NavUser user={user} />
        </div>
      </div>
    </header>
  );
}
