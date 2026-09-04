"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  CircleDollarSign,
  LayoutDashboard,
  PackageCheck,
  PlugZap,
  ReceiptText,
  HandCoins,
  PackagePlus,
  RotateCcw,
  Undo2,
  ScrollText,
  Shirt,
  ShoppingBag,
  Truck,
  Users,
  UserCog,
} from "lucide-react";
import type { Role } from "@/db/schema";
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
import { hasPermission, type Permission } from "@/lib/auth/permissions";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; permission?: Permission };

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Vận hành",
    items: [
      { href: "/", label: "Tổng quan", icon: LayoutDashboard, permission: "dashboard:view" },
      { href: "/orders", label: "Đơn hàng", icon: ShoppingBag, permission: "orders:read" },
      { href: "/shipments", label: "Vận đơn", icon: Truck, permission: "shipments:view" },
      { href: "/returns", label: "Đổi / trả hàng", icon: RotateCcw, permission: "returns:view" },
      { href: "/customers", label: "Khách hàng", icon: Users, permission: "customers:view" },
    ],
  },
  {
    label: "Kho & tài chính",
    items: [
      { href: "/products", label: "Sản phẩm & tồn kho", icon: Shirt, permission: "products:view" },
      { href: "/inventory", label: "Nhật ký kho", icon: Boxes, permission: "products:view" },
      { href: "/inventory/receipts", label: "Nhập hàng & kiểm kê", icon: PackagePlus, permission: "products:view" },
      { href: "/cod", label: "Đối soát COD", icon: PackageCheck, permission: "cod:view" },
      { href: "/expenses", label: "Chi phí & quảng cáo", icon: ReceiptText, permission: "expenses:view" },
      { href: "/reports", label: "Báo cáo lợi nhuận", icon: BarChart3, permission: "reports:view" },
      { href: "/reports/returns", label: "Tỷ lệ hoàn theo mã hàng", icon: Undo2, permission: "reports:view" },
      { href: "/payroll", label: "Lương & hoa hồng", icon: HandCoins, permission: "payroll:view" },
    ],
  },
  {
    label: "Hệ thống",
    items: [
      { href: "/integrations", label: "Kết nối dữ liệu", icon: PlugZap, permission: "integrations:view" },
      { href: "/settings/users", label: "Người dùng", icon: UserCog, permission: "users:manage" },
      { href: "/audit", label: "Nhật ký hệ thống", icon: ScrollText, permission: "audit:view" },
    ],
  },
];

export function AppSidebar({ user }: { user: { name: string; email: string; role: Role; permissions: string[] } }) {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b border-sidebar-border/60 px-2 py-3">
        <Link href="/" className="flex items-center gap-3 rounded-lg px-1.5 py-1">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-black text-primary-foreground shadow-[0_8px_24px_-8px_var(--primary)]">SC</span>
          <span className="min-w-0 group-data-[collapsible=icon]:hidden">
            <strong className="block truncate text-[15px] font-bold tracking-tight">Shop Control</strong>
            <span className="block truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/50">Fashion ERP</span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-2 py-2">
        {groups.map((group) => {
          const items = group.items.filter((item) => !item.permission || user.role === "ADMIN" || hasPermission(user.permissions, item.permission));
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label} className="p-0 pt-2">
              <SidebarGroupLabel className="px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/45">{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {items.map((item) => {
                    const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
                    // mục có đường dẫn dài nhất khớp với trang hiện tại mới được tô sáng (/reports/returns không tô cả /reports)
                    const best = groups.flatMap((g) => g.items).filter((i) => matches(i.href)).sort((a, b) => b.href.length - a.href.length)[0];
                    const active = best?.href === item.href;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="h-9 rounded-lg text-[13.5px] text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground">
                          <Link href={item.href}>
                            <item.icon className={active ? "text-primary" : "text-sidebar-foreground/55"} />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
        <SidebarGroup className="mt-auto p-0 pt-4">
          <SidebarGroupContent>
            <div className="mx-1 rounded-xl border border-sidebar-border/60 bg-sidebar-accent/40 p-3 group-data-[collapsible=icon]:hidden">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <CircleDollarSign className="size-4 text-success" />
                Tiền thực về
              </div>
              <p className="mt-1.5 text-[11px] leading-5 text-sidebar-foreground/55">Lợi nhuận tính trên COD đã về tài khoản, trừ giá vốn, phí ship, phí hoàn, quảng cáo và chi phí.</p>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/60 p-2">
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export const NAV_TITLES: Record<string, string> = { ...Object.fromEntries(groups.flatMap((g) => g.items.map((i) => [i.href, i.label]))), "/settings/profile": "Tài khoản của tôi" };
