"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ChevronDown, LayoutGrid, Menu } from "lucide-react";
import type { Role } from "@/db/schema";
import { allowedNavItems, bellShowsSharedQueue, iconOf, menuActiveHref, visibleGroups, type NavZone } from "@/components/app-sidebar";
import { rememberVisit } from "@/components/nav-memory";
import { QuickCreate } from "@/components/quick-create";
import { PRIMARY_NAV_LABEL, primaryNavFor } from "@/lib/constants/command-catalog";
import { AiCopilot } from "@/components/ai-copilot";
import { BrandGlyph, BrandWordmark } from "@/components/brand";
import { GlobalSearch } from "@/components/global-search";
import { LinkPending, LinkProgressReporter } from "@/components/nav-progress";
import { NavUser } from "@/components/nav-user";
import { NotificationBell } from "@/components/notification-bell";
import { RealtimeIndicator } from "@/components/realtime-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { DynamicNavItem } from "@/lib/pages/nav";
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
const PILL_LABEL: Partial<Record<NavZone, string>> = {
  SALES: "Kinh doanh",
  MANAGEMENT: "Điều hành",
};

/**
 * `modules` = module đang bật của tổ chức — menu, ô lệnh ⌘K và chuông cùng lọc theo nó. `dynamicPages` = trang
 * tuỳ biến đã xuất bản (Phase 4 · G12), bố cục nạp ở máy chủ và đã lọc theo người xem.
 */
type TopNavUser = { name: string; email: string; role: Role; permissions: string[]; modules?: string[]; organization?: { isHome: boolean } | null; dynamicPages?: readonly DynamicNavItem[] };

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

/**
 * Thương hiệu của tổ chức KHÔNG phải nhà (Phase 10 · §4): tên + logo thay cho nhận diện của tổ chức nhà. `null` ⇒ tổ
 * chức nhà, giữ nguyên nhận diện hiện tại.
 */
export type TopNavBrand = { name: string; logoUrl: string | null } | null;

export function AppTopNav({ user, brand = null }: { user: TopNavUser; brand?: TopNavBrand }) {
  const pathname = usePathname();
  const activeHref = menuActiveHref(pathname, user);
  const groups = visibleGroups(user);
  const [sheetOpen, setSheetOpen] = useState(false);
  /*
    MỤC CHÍNH THEO VAI TRÒ (chủ shop 09/10/2026): ≤ 6 trang dùng hằng ngày đứng thẳng trên thanh — MỘT cú bấm, không
    thả xuống. Mọi trang khác vẫn ở "Tất cả chức năng" (hai cú bấm) và ô lệnh. Vai trò chỉ sắp xếp; danh sách đi qua
    đúng bộ lọc quyền của menu nên không ai thấy mục mình không vào được.
  */
  const navItems = useMemo(() => allowedNavItems(user), [user]);
  const labelOf = useMemo(() => new Map(navItems.map((i) => [i.href, i.label])), [navItems]);
  const primary = useMemo(() => primaryNavFor(user.role, new Set(labelOf.keys())).map((href) => ({ href, label: PRIMARY_NAV_LABEL[href] ?? labelOf.get(href) ?? href })), [user.role, labelOf]);
  const inPrimary = primary.some((p) => p.href === activeHref);
  // "Hệ thống" là cấu hình / quản trị, không phải việc hằng ngày — đứng riêng ở cuối bảng "Tất cả chức năng".
  const workGroups = groups.filter((g) => g.zone !== "SYSTEM");
  const adminGroups = groups.filter((g) => g.zone === "SYSTEM");
  // "Gần đây" của ô lệnh: chỉ ghi trang có trong menu (không ghi trang chi tiết, không ghi dữ liệu khách).
  useEffect(() => {
    if (activeHref) rememberVisit(activeHref);
  }, [activeHref]);

  return (
    <>
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
              {primary.length ? (
                <div>
                  <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-[0.12em] text-primary">Dùng hằng ngày</p>
                  <div className="space-y-0.5">
                    {primary.map((item) => (
                      <Link key={item.href} href={item.href} onClick={() => setSheetOpen(false)} aria-current={item.href === activeHref ? "page" : undefined} className={itemClass(item.href === activeHref)}>
                        <ItemInner href={item.href} label={item.label} active={item.href === activeHref} />
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
              {groups.map((group) => (
                <div key={group.zone}>
                  <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground" title={group.hint}>
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

        {brand ? (
          <Link href="/" aria-label={`${brand.name} — về trang chủ`} className="mr-2 flex min-w-0 shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-opacity hover:opacity-90" data-org-brand>
            {brand.logoUrl ? (
              // Logo tải qua route có kiểm tổ chức (`/api/branding/logo`) — không qua bộ tối ưu ảnh của Next.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logoUrl} alt="" className="size-9 shrink-0 rounded-xl object-contain" />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">{brand.name.trim().charAt(0).toUpperCase() || "•"}</span>
            )}
            <span className="hidden max-w-[180px] truncate text-[15px] font-bold text-foreground sm:inline xl:hidden 2xl:inline">{brand.name}</span>
          </Link>
        ) : (
          <Link href="/" aria-label="VNXcommerce — về trang tổng quan" className="mr-2 flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-opacity hover:opacity-90">
            <span className="flex size-9 items-center justify-center rounded-xl bg-brand text-white">
              <BrandGlyph className="h-[12px]" />
            </span>
            <BrandWordmark className="hidden text-[16px] text-foreground sm:inline xl:hidden 2xl:inline" />
          </Link>
        )}

        <nav aria-label="Điều hướng chính" className="hidden min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] xl:flex [&::-webkit-scrollbar]:hidden">
          {primary.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring 2xl:px-3.5",
                  active ? "bg-ink font-semibold text-ink-foreground" : "font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
                <LinkPending />
                <LinkProgressReporter />
              </Link>
            );
          })}
          <AllFeaturesMenu workGroups={workGroups} adminGroups={adminGroups} activeHref={activeHref} highlight={!inPrimary && Boolean(activeHref)} />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <GlobalSearch user={user} />
          <QuickCreate />
          <Suspense fallback={null}>
            <AiCopilot />
          </Suspense>
          <NotificationBell sharedQueue={bellShowsSharedQueue(user)} />
          <RealtimeIndicator />
          <NavUser user={user} />
        </div>
      </div>
    </header>
    {/*
      THANH DƯỚI TRÊN ĐIỆN THOẠI — không phải menu máy tính thu nhỏ. Bốn mục chính của vai trò + "Thêm" (mở cùng ngăn kéo
      menu), nằm trong vùng ngón cái. Đặt NGOÀI <header>: header có backdrop-blur, mà phần tử `fixed` bên trong một phần tử
      có bộ lọc sẽ bám theo phần tử đó thay vì theo màn hình.
    */}
    {primary.length ? (
      <nav aria-label="Điều hướng nhanh" className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden">
        <div className="grid grid-cols-5">
          {primary.slice(0, 4).map((item) => {
            const Icon = iconOf(item.href);
            const active = item.href === activeHref;
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11.5px]", active ? "font-semibold text-primary" : "text-muted-foreground")}>
                <Icon className="size-5" aria-hidden />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            );
          })}
          <button type="button" onClick={() => setSheetOpen(true)} className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11.5px]", !inPrimary && activeHref ? "font-semibold text-primary" : "text-muted-foreground")}>
            <LayoutGrid className="size-5" aria-hidden />
            Thêm
          </button>
        </div>
      </nav>
    ) : null}
    </>
  );
}

type MenuGroup = ReturnType<typeof visibleGroups>[number];

/**
 * TẤT CẢ CHỨC NĂNG — một bảng, mọi phòng ban cạnh nhau, hai cú bấm tới bất kỳ trang nào. Thay cho chín viên thả xuống
 * mà người dùng phải đoán đúng viên nào chứa trang mình cần. "Quản trị & cài đặt" tách riêng ở cuối.
 */
function AllFeaturesMenu({ workGroups, adminGroups, activeHref, highlight }: { workGroups: MenuGroup[]; adminGroups: MenuGroup[]; activeHref?: string; highlight: boolean }) {
  const column = (group: MenuGroup) => (
    <div key={group.zone} className="min-w-0">
      <p className="px-2.5 pb-1 text-xs font-bold" title={group.hint}>
        {PILL_LABEL[group.zone] ?? group.label}
      </p>
      <div className="space-y-0.5">
        {group.items.map((item) => (
          <DropdownMenuItem key={item.href} asChild className={cn(itemClass(item.href === activeHref), "py-1.5 text-[13.5px]")}>
            <Link href={item.href} aria-current={item.href === activeHref ? "page" : undefined}>
              <ItemInner href={item.href} label={item.label} active={item.href === activeHref} />
            </Link>
          </DropdownMenuItem>
        ))}
      </div>
    </div>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          highlight ? "bg-ink font-semibold text-ink-foreground" : "font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
        )}
      >
        <LayoutGrid className="size-4" aria-hidden />
        Tất cả
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={10} className="max-h-[min(80vh,720px)] w-[min(1040px,calc(100vw-3rem))] overflow-y-auto rounded-2xl p-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 lg:grid-cols-4">{workGroups.map(column)}</div>
        {adminGroups.length ? (
          <div className="mt-4 border-t pt-3">
            <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Quản trị & cài đặt</p>
            <div className="grid grid-cols-2 gap-x-3 lg:grid-cols-4">
              {adminGroups.flatMap((g) => g.items).map((item) => (
                <DropdownMenuItem key={item.href} asChild className={cn(itemClass(item.href === activeHref), "py-1.5 text-[13px]")}>
                  <Link href={item.href} aria-current={item.href === activeHref ? "page" : undefined}>
                    <ItemInner href={item.href} label={item.label} active={item.href === activeHref} />
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
