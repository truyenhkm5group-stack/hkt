"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import {
  Banknote,
  Bot,
  BarChart3,
  BellRing,
  Boxes,
  ChevronRight,
  ClipboardCheck,
  Factory,
  FileSpreadsheet,
  HandCoins,
  Headset,
  HeartHandshake,
  Images,
  Landmark,
  LayoutDashboard,
  Flag,
  Lightbulb,
  ListTodo,
  ListChecks,
  Megaphone,
  Network,
  PackageCheck,
  PackagePlus,
  PackageX,
  PlugZap,
  ReceiptText,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import type { Role } from "@/db/schema";
import { BrandGlyph, BrandWordmark } from "@/components/brand";
import { LinkPending, LinkProgressReporter } from "@/components/nav-progress";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { hasPermission } from "@/lib/auth/permissions";
import { MODULE_GROUPS, MODULE_TITLES, type ModuleHref, type ModuleSpec } from "@/lib/constants/department-modules";
import { cn } from "@/lib/utils";

/**
 * MENU XẾP THEO PHÒNG BAN — VÀ DANH SÁCH MODULE KHÔNG CÒN SỐNG Ở ĐÂY.
 *
 * Chủ shop chốt 23/09/2026: gom module theo phòng ban (đề xuất Đ1 của `docs/navigation-review.md`,
 * treo từ 12/09). Người làm kho mở menu thấy nhóm "Kho"; người chạy quảng cáo thấy nhóm "Marketing";
 * không ai phải đọc qua việc của ba phòng khác để tìm trang quen.
 *
 * Bản đồ module nay nằm ở `lib/constants/department-modules.ts` cùng với `why` của từng dòng — tệp
 * này chỉ còn hai việc: BẢNG ICON và cách VẼ. Lý do tách: trước đây bài kiểm phủ điều hướng, bài kiểm
 * phủ smoke và ô lệnh ⌘K đều phải đọc lại MÃ NGUỒN của tệp này bằng biểu thức chính quy để biết ERP
 * có những trang nào. Một sổ khai `import` được thì cả ba cùng nhìn một bảng.
 */

/**
 * Icon của từng module. `Record<ModuleHref, …>` nên thêm một module vào sổ khai mà quên icon là LỖI
 * BIÊN DỊCH, không phải một mục menu trống hình.
 */
const MODULE_ICON: Record<ModuleHref, typeof LayoutDashboard> = {
  "/": LayoutDashboard,
  "/alerts": BellRing,
  "/work": ListTodo,
  "/cs": Headset,
  "/orders": ShoppingBag,
  "/landing": FileSpreadsheet,
  "/customers": Users,
  "/outreach": HeartHandshake,
  "/chatbot": Bot,
  "/ads": Megaphone,
  "/ideas": Lightbulb,
  "/marketing/creatives": Images,
  "/marketing/fanpages": Flag,
  "/shipments": Truck,
  "/returns": RotateCcw,
  "/reports/returns": Undo2,
  "/products": Shirt,
  "/inventory/receipts": PackagePlus,
  "/inventory/returns": ClipboardCheck,
  "/inventory": Boxes,
  "/inventory/planning": Factory,
  "/inventory/shortage": PackageX,
  "/inventory/decisions": Wallet,
  "/products/performance": TrendingUp,
  "/finance": Wallet,
  "/cod": PackageCheck,
  "/bank": Landmark,
  "/finance-ops": ListChecks,
  "/expenses": ReceiptText,
  "/reports": BarChart3,
  "/reports/cashflow": Banknote,
  "/payroll": HandCoins,
  "/departments": Network,
  "/data-quality": ShieldCheck,
  "/tech": Bot,
  "/integrations": PlugZap,
  "/settings/users": UserCog,
  "/audit": ScrollText,
};

function iconOf(href: string): typeof LayoutDashboard {
  return MODULE_ICON[href as ModuleHref] ?? LayoutDashboard;
}

/** Người dùng tối thiểu để lọc menu theo quyền — dùng chung cho thanh bên và ô lệnh ⌘K. */
export type NavUserLike = { role: Role; permissions: string[] };

/** Một mục có hiện với người này không. ADMIN thấy hết; `anyOf` thì đủ MỘT quyền là hiện. */
function visible(item: ModuleSpec, user: NavUserLike): boolean {
  if (user.role === "ADMIN") return true;
  if (item.anyOf) return item.anyOf.some((p) => hasPermission(user.permissions, p));
  return !item.permission || hasPermission(user.permissions, item.permission);
}

/** Mọi trang người này được vào, theo đúng luật lọc của thanh bên (ADMIN thấy hết). */
export function allowedNavItems(user: NavUserLike): { href: string; label: string; group: string; icon: typeof LayoutDashboard }[] {
  return MODULE_GROUPS.flatMap((g) =>
    g.items.filter((item) => visible(item, user)).map((item) => ({ href: item.href, label: item.label, group: g.label, icon: iconOf(item.href) })),
  );
}

/**
 * NHÓM MENU GẬP ĐƯỢC — MẶC ĐỊNH MỞ HẾT.
 *
 * Ai gập nhóm nào thì máy nhớ nhóm đó cho lần sau. Mặc định vẫn MỞ HẾT — gập là lựa chọn của người
 * dùng, không phải thứ giấu sẵn bắt họ tốn thêm một cú bấm để tìm trang quen. Nhóm chứa trang đang
 * xem luôn mở, kể cả khi trước đó đã gập: không bao giờ có chuyện đang đứng ở một trang mà mục của
 * chính trang đó biến mất khỏi menu.
 */
const COLLAPSED_KEY = "vnx.sidebar.collapsedGroups";

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  // Đọc ở lần vẽ thứ hai: máy chủ không thấy localStorage, đọc ngay lúc dựng thì HTML hai bên lệch nhau.
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* chế độ riêng tư chặn localStorage: cứ mở hết, đó không phải lỗi */
    }
  }, []);
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* không lưu được thì trong phiên này vẫn đúng */
      }
      return next;
    });
  return { collapsed, toggle };
}

export function AppSidebar({ user }: { user: { name: string; email: string; role: Role; permissions: string[] } }) {
  const pathname = usePathname();
  const { collapsed, toggle } = useCollapsedGroups();
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  // Mục có đường dẫn dài nhất khớp với trang hiện tại mới được tô sáng (/reports/returns không tô
  // cả /reports). Tính MỘT lần cho cả menu, thay vì lặp lại phép này bên trong từng mục.
  const activeHref = MODULE_GROUPS.flatMap((g) => g.items)
    .filter((i) => matches(i.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b border-sidebar-border/60 px-2 py-3">
        <Link href="/" aria-label="VNXcommerce — về trang tổng quan" className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-opacity hover:opacity-90">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-[0_10px_24px_-10px_var(--brand)]">
            <BrandGlyph className="h-[13px]" />
          </span>
          <BrandWordmark className="min-w-0 text-[16px] text-brand-bright group-data-[collapsible=icon]:hidden" />
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-2 py-1.5">
        {MODULE_GROUPS.map((group) => {
          const items = group.items.filter((item) => visible(item, user));
          if (!items.length) return null;
          const holdsActive = items.some((i) => i.href === activeHref);
          const open = holdsActive || !collapsed.has(group.label);
          return (
            <SidebarGroup key={group.zone} className="p-0 pt-1.5">
              {/* Nhãn nhóm KIÊM nút gập: không dựng thêm một nút nữa cho việc đã có sẵn chỗ bấm. */}
              <SidebarGroupLabel asChild className="px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/40">
                <button type="button" onClick={() => toggle(group.label)} aria-expanded={open} title={group.hint} className="w-full justify-between rounded-md transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/70">
                  <span className="truncate">{group.label}</span>
                  <ChevronRight className={cn("size-3! shrink-0 transition-transform duration-150", open && "rotate-90")} aria-hidden />
                </button>
              </SidebarGroupLabel>
              {open ? (
                <SidebarGroupContent>
                  <SidebarMenu className="gap-px">
                    {items.map((item) => {
                      const active = activeHref === item.href;
                      const Icon = iconOf(item.href);
                      return (
                        <SidebarMenuItem key={item.href}>
                          <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="relative h-8 rounded-lg text-[13px] text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:absolute data-[active=true]:before:left-0 data-[active=true]:before:top-1/2 data-[active=true]:before:h-4 data-[active=true]:before:w-[3px] data-[active=true]:before:-translate-y-1/2 data-[active=true]:before:rounded-r-full data-[active=true]:before:bg-brand-bright">
                            {/*
                              CỐ Ý DÙNG PREFETCH MẶC ĐỊNH, KHÔNG ÉP `prefetch`. Với route động,
                              `prefetch` ép Next tải TRƯỚC toàn bộ dữ liệu trang — 25 mục menu nhân
                              lên là 25 lần dựng báo cáo trên một VPS 2 nhân, ngay khi người dùng vừa
                              đăng nhập. Chế độ mặc định chỉ tải trước phần khung tới ranh giới
                              `loading.tsx`; nay mỗi trang nặng đã có `loading.tsx` riêng nên bấm vào
                              là thấy khung xương đúng hình dạng ngay lập tức, còn CSDL không bị gọi.
                            */}
                            <Link href={item.href}>
                              <Icon className={active ? "text-brand-bright" : "text-sidebar-foreground/50"} />
                              <span>{item.label}</span>
                              {/* Chấm chờ ngay trong mục vừa bấm + báo lên thanh tiến trình chung */}
                              <LinkPending />
                              <LinkProgressReporter />
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              ) : null}
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/60 p-2">
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/*
  BẢY TRANG KHÔNG CÓ MỤC MENU RIÊNG — mỗi trang đã có lối vào ngay trên trang cha của nó:
  Giữ chân khách (từ Khách hàng), Mua hàng & xưởng (từ Kế hoạch SX), Bổ sung danh sách vận đơn (từ
  Đối soát COD), Điều hành theo khâu và Nút thắt trước khi rời kho (hai tab của Cần xử lý), Phễu bán
  hàng và Mô phỏng kịch bản (từ Báo cáo lợi nhuận). Mục nào có "nhà" thì về nhà. Vẫn tới được từ ô
  lệnh ⌘K nên giữ tiêu đề cho breadcrumb.
*/
export const NAV_TITLES: Record<string, string> = {
  ...MODULE_TITLES,
  "/settings/profile": "Tài khoản của tôi",
  "/customers/retention": "Giữ chân khách",
  "/inventory/purchasing": "Mua hàng & xưởng",
  "/import-vtp": "Bổ sung danh sách vận đơn",
  "/operations": "Điều hành theo khâu",
  "/operations/preship": "Soát đơn trước khi gửi",
  "/operations/fulfillment": "Nút thắt trước khi rời kho",
  "/operations/dwell": "Vận đơn đứng yên quá lâu",
  "/reports/funnel": "Phễu bán hàng",
  "/reports/scenario": "Mô phỏng kịch bản",
};
