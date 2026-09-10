"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  BarChart3,
  BellRing,
  Boxes,
  CircleDollarSign,
  ClipboardCheck,
  Factory,
  FileSpreadsheet,
  FileUp,
  Filter,
  Gauge,
  HandCoins,
  Headset,
  HeartHandshake,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  Megaphone,
  PackageCheck,
  PackagePlus,
  PackageSearch,
  PlugZap,
  ReceiptText,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  Sliders,
  TrendingUp,
  Truck,
  Undo2,
  UserCheck,
  UserCog,
  Users,
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
import { hasPermission, type Permission } from "@/lib/auth/permissions";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; permission?: Permission; /** đủ một trong các quyền này là hiện */ anyOf?: Permission[] };

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Vận hành",
    items: [
      { href: "/", label: "Tổng quan", icon: LayoutDashboard, permission: "dashboard:view" },
      { href: "/orders", label: "Đơn hàng", icon: ShoppingBag, permission: "orders:read" },
      { href: "/shipments", label: "Vận đơn", icon: Truck, permission: "shipments:view" },
      { href: "/operations", label: "Điều hành hằng ngày", icon: Gauge, permission: "dashboard:view" },
      { href: "/alerts", label: "Cần xử lý", icon: BellRing, permission: "alerts:view" },
      { href: "/cs", label: "CSKH", icon: Headset, permission: "cs:view" },
      { href: "/outreach", label: "Chăm sóc & bán chéo", icon: HeartHandshake, permission: "outreach:view" },
      { href: "/landing", label: "Đơn landing page", icon: FileSpreadsheet, permission: "landing:view" },
      { href: "/returns", label: "Đổi / trả hàng", icon: RotateCcw, permission: "returns:view" },
      { href: "/customers", label: "Khách hàng", icon: Users, permission: "customers:view" },
      { href: "/customers/retention", label: "Giữ chân khách", icon: UserCheck, permission: "customers:view" },
      { href: "/ideas", label: "Ý tưởng marketing", icon: Lightbulb, permission: "ideas:view" },
    ],
  },
  {
    label: "Kho",
    items: [
      { href: "/products", label: "Sản phẩm & tồn kho", icon: Shirt, permission: "products:view" },
      { href: "/products/performance", label: "Hiệu quả mẫu mã", icon: TrendingUp, permission: "reports:returns" },
      { href: "/inventory", label: "Nhật ký kho", icon: Boxes, permission: "products:view" },
      { href: "/inventory/receipts", label: "Nhập hàng & kiểm kê", icon: PackagePlus, permission: "products:view" },
      { href: "/inventory/returns", label: "Kiểm đếm hàng hoàn", icon: ClipboardCheck, permission: "products:view" },
      { href: "/inventory/planning", label: "Kế hoạch đặt hàng SX", icon: Factory, permission: "planning:view" },
      { href: "/inventory/purchasing", label: "Mua hàng & xưởng", icon: PackageSearch, permission: "planning:view" },
    ],
  },
  {
    label: "Tài chính",
    items: [
      { href: "/import-vtp", label: "Bổ sung danh sách vận đơn", icon: FileUp, permission: "cod:write" },
      { href: "/cod", label: "Đối soát COD", icon: PackageCheck, permission: "cod:view" },
      { href: "/bank", label: "Sổ ngân hàng", icon: Landmark, permission: "bank:view" },
      { href: "/expenses", label: "Chi phí vận hành", icon: ReceiptText, permission: "expenses:view" },
      { href: "/ads", label: "Quảng cáo", icon: Megaphone, permission: "expenses:view" },
      { href: "/reports", label: "Báo cáo lợi nhuận", icon: BarChart3, permission: "reports:delivered", anyOf: ["reports:delivered", "reports:cash", "reports:nominal"] },
      { href: "/reports/returns", label: "Tỷ lệ giao thành công", icon: Undo2, permission: "reports:returns" },
      { href: "/reports/funnel", label: "Phễu bán hàng", icon: Filter, permission: "reports:returns" },
      { href: "/reports/cashflow", label: "Dòng tiền", icon: Banknote, permission: "reports:cash" },
      { href: "/reports/scenario", label: "Mô phỏng kịch bản", icon: Sliders, permission: "reports:nominal" },
      { href: "/data-quality", label: "Chất lượng dữ liệu", icon: ShieldCheck, permission: "dashboard:view" },
      { href: "/payroll", label: "Lương & hoa hồng", icon: HandCoins, permission: "payroll:view-own", anyOf: ["payroll:view-own", "payroll:view"] },
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
        <Link href="/" aria-label="VNXcommerce — về trang tổng quan" className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-opacity hover:opacity-90">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-[0_10px_24px_-10px_var(--brand)]">
            <BrandGlyph className="h-[13px]" />
          </span>
          <BrandWordmark className="min-w-0 text-[16px] text-brand-bright group-data-[collapsible=icon]:hidden" />
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-2 py-2">
        {groups.map((group) => {
          const items = group.items.filter((item) => user.role === "ADMIN" || (item.anyOf ? item.anyOf.some((p) => hasPermission(user.permissions, p)) : !item.permission || hasPermission(user.permissions, item.permission)));
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label} className="p-0 pt-2">
              <SidebarGroupLabel className="px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/40">{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {items.map((item) => {
                    const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
                    // mục có đường dẫn dài nhất khớp với trang hiện tại mới được tô sáng (/reports/returns không tô cả /reports)
                    const best = groups.flatMap((g) => g.items).filter((i) => matches(i.href)).sort((a, b) => b.href.length - a.href.length)[0];
                    const active = best?.href === item.href;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="relative h-9 rounded-lg text-[13.5px] text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:absolute data-[active=true]:before:left-0 data-[active=true]:before:top-1/2 data-[active=true]:before:h-4 data-[active=true]:before:w-[3px] data-[active=true]:before:-translate-y-1/2 data-[active=true]:before:rounded-r-full data-[active=true]:before:bg-brand-bright">
                          {/*
                            CỐ Ý DÙNG PREFETCH MẶC ĐỊNH, KHÔNG ÉP `prefetch`. Với route động,
                            `prefetch` ép Next tải TRƯỚC toàn bộ dữ liệu trang — 25 mục menu nhân
                            lên là 25 lần dựng báo cáo trên một VPS 2 nhân, ngay khi người dùng vừa
                            đăng nhập. Chế độ mặc định chỉ tải trước phần khung tới ranh giới
                            `loading.tsx`; nay mỗi trang nặng đã có `loading.tsx` riêng nên bấm vào
                            là thấy khung xương đúng hình dạng ngay lập tức, còn CSDL không bị gọi.
                          */}
                          <Link href={item.href}>
                            <item.icon className={active ? "text-brand-bright" : "text-sidebar-foreground/50"} />
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
