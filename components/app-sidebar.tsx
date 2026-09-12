"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import {
  Banknote,
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
  Landmark,
  LayoutDashboard,
  Lightbulb,
  Megaphone,
  PackageCheck,
  PackagePlus,
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
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; permission?: Permission; /** đủ một trong các quyền này là hiện */ anyOf?: Permission[] };

/**
 * MENU XẾP THEO LUỒNG CÔNG VIỆC, KHÔNG THEO MÔ-ĐUN KỸ THUẬT.
 *
 * Luồng thật của shop: tin nhắn → chốt đơn → xác nhận → lên đơn → rủi ro → giao vận → giao thành
 * công / hoàn → COD / tiền → tồn kho → sản xuất. Người làm khâu nào nhìn thấy các trang của khâu đó
 * đứng cạnh nhau. Trang "báo cáo" không còn là một nhóm riêng: báo cáo GTC đứng ở Giao vận, báo cáo
 * lợi nhuận / dòng tiền đứng ở Tiền — vì người đọc chúng là người làm khâu đó.
 *
 * 33 → 27 mục: Điều hành theo khâu là tab của Cần xử lý; Phễu bán hàng và Mô phỏng kịch bản vào từ
 * Báo cáo lợi nhuận và ô lệnh ⌘K.
 */
const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Hôm nay",
    items: [
      { href: "/", label: "Tổng quan", icon: LayoutDashboard, permission: "dashboard:view" },
      { href: "/alerts", label: "Cần xử lý", icon: BellRing, permission: "alerts:view" },
    ],
  },
  {
    label: "Bán hàng · chốt đơn",
    items: [
      { href: "/cs", label: "CSKH & tin nhắn", icon: Headset, permission: "cs:view" },
      { href: "/orders", label: "Đơn hàng", icon: ShoppingBag, permission: "orders:read" },
      { href: "/landing", label: "Đơn landing page", icon: FileSpreadsheet, permission: "landing:view" },
      { href: "/customers", label: "Khách hàng", icon: Users, permission: "customers:view" },
      { href: "/outreach", label: "Chăm sóc & bán chéo", icon: HeartHandshake, permission: "outreach:view" },
      { href: "/ads", label: "Quảng cáo", icon: Megaphone, permission: "expenses:view" },
      { href: "/ideas", label: "Ý tưởng marketing", icon: Lightbulb, permission: "ideas:view" },
    ],
  },
  {
    label: "Giao vận · hoàn",
    items: [
      { href: "/shipments", label: "Vận đơn & care", icon: Truck, permission: "shipments:view" },
      { href: "/returns", label: "Đổi / trả hàng", icon: RotateCcw, permission: "returns:view" },
      { href: "/inventory/returns", label: "Kiểm đếm hàng hoàn", icon: ClipboardCheck, permission: "products:view" },
      { href: "/reports/returns", label: "Tỷ lệ giao thành công", icon: Undo2, permission: "reports:returns" },
    ],
  },
  {
    label: "Tiền",
    items: [
      // Đứng ĐẦU nhóm: đây là màn hình trả lời "còn bao nhiêu tiền, nằm ở đâu" — câu hỏi đầu tiên
      // của chủ shop mỗi sáng, và câu mà sáu trang còn lại của nhóm này cộng lại vẫn không trả lời.
      { href: "/finance", label: "Tổng quan tài chính", icon: Wallet, permission: "bank:view", anyOf: ["bank:view", "reports:cash", "cod:view"] },
      { href: "/cod", label: "Đối soát COD", icon: PackageCheck, permission: "cod:view" },
      { href: "/bank", label: "Sổ ngân hàng", icon: Landmark, permission: "bank:view" },
      { href: "/expenses", label: "Chi phí vận hành", icon: ReceiptText, permission: "expenses:view" },
      { href: "/reports", label: "Báo cáo lợi nhuận", icon: BarChart3, permission: "reports:delivered", anyOf: ["reports:delivered", "reports:cash", "reports:nominal"] },
      { href: "/reports/cashflow", label: "Dòng tiền", icon: Banknote, permission: "reports:cash" },
      { href: "/payroll", label: "Lương & hoa hồng", icon: HandCoins, permission: "payroll:view-own", anyOf: ["payroll:view-own", "payroll:view"] },
    ],
  },
  {
    label: "Kho · sản xuất",
    items: [
      { href: "/products", label: "Sản phẩm & tồn kho", icon: Shirt, permission: "products:view" },
      { href: "/inventory/receipts", label: "Nhập hàng & kiểm kê", icon: PackagePlus, permission: "products:view" },
      { href: "/inventory", label: "Nhật ký kho", icon: Boxes, permission: "products:view" },
      { href: "/products/performance", label: "Hiệu quả mẫu mã", icon: TrendingUp, permission: "reports:returns" },
      { href: "/inventory/planning", label: "Kế hoạch đặt hàng SX", icon: Factory, permission: "planning:view" },
      { href: "/inventory/decisions", label: "Quyết định vốn tồn kho", icon: Wallet, permission: "planning:view" },
    ],
  },
  {
    label: "Hệ thống",
    items: [
      { href: "/integrations", label: "Kết nối dữ liệu", icon: PlugZap, permission: "integrations:view" },
      { href: "/data-quality", label: "Chất lượng dữ liệu", icon: ShieldCheck, permission: "dashboard:view" },
      { href: "/settings/users", label: "Người dùng", icon: UserCog, permission: "users:manage" },
      { href: "/audit", label: "Nhật ký hệ thống", icon: ScrollText, permission: "audit:view" },
    ],
  },
];

/** Người dùng tối thiểu để lọc menu theo quyền — dùng chung cho thanh bên và ô lệnh ⌘K. */
export type NavUserLike = { role: Role; permissions: string[] };

/** Mọi trang người này được vào, theo đúng luật lọc của thanh bên (ADMIN thấy hết). */
export function allowedNavItems(user: NavUserLike): { href: string; label: string; group: string; icon: NavItem["icon"] }[] {
  return groups.flatMap((g) =>
    g.items
      .filter((item) => user.role === "ADMIN" || (item.anyOf ? item.anyOf.some((p) => hasPermission(user.permissions, p)) : !item.permission || hasPermission(user.permissions, item.permission)))
      .map((item) => ({ href: item.href, label: item.label, group: g.label, icon: item.icon })),
  );
}

/**
 * NHÓM MENU GẬP ĐƯỢC — MẶC ĐỊNH MỞ HẾT.
 *
 * Sáu nhóm, hai bảy mục: người làm kho không bao giờ mở tới nhóm Tiền, người làm tiền không mở tới
 * nhóm Kho. Ai gập nhóm nào thì máy nhớ nhóm đó cho lần sau. Mặc định vẫn MỞ HẾT — gập là lựa chọn
 * của người dùng, không phải thứ giấu sẵn bắt họ tốn thêm một cú bấm để tìm trang quen. Nhóm chứa
 * trang đang xem luôn mở, kể cả khi trước đó đã gập: không bao giờ có chuyện đang đứng ở một trang
 * mà mục của chính trang đó biến mất khỏi menu.
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
  // cả /reports). Tính MỘT lần cho cả menu, thay vì lặp lại phép này bên trong từng mục như trước.
  const activeHref = groups
    .flatMap((g) => g.items)
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
        {groups.map((group) => {
          const items = group.items.filter((item) => user.role === "ADMIN" || (item.anyOf ? item.anyOf.some((p) => hasPermission(user.permissions, p)) : !item.permission || hasPermission(user.permissions, item.permission)));
          if (!items.length) return null;
          const holdsActive = items.some((i) => i.href === activeHref);
          const open = holdsActive || !collapsed.has(group.label);
          return (
            <SidebarGroup key={group.label} className="p-0 pt-1.5">
              {/* Nhãn nhóm KIÊM nút gập: không dựng thêm một nút nữa cho việc đã có sẵn chỗ bấm. */}
              <SidebarGroupLabel asChild className="px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/40">
                <button type="button" onClick={() => toggle(group.label)} aria-expanded={open} className="w-full justify-between rounded-md transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/70">
                  <span className="truncate">{group.label}</span>
                  <ChevronRight className={cn("size-3! shrink-0 transition-transform duration-150", open && "rotate-90")} aria-hidden />
                </button>
              </SidebarGroupLabel>
              {open ? (
                <SidebarGroupContent>
                  <SidebarMenu className="gap-px">
                    {items.map((item) => {
                      const active = activeHref === item.href;
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
  BẢY TRANG KHÔNG CÒN MỤC MENU RIÊNG — mỗi trang đã có lối vào ngay trên trang cha của nó:
  Giữ chân khách (từ Khách hàng), Mua hàng & xưởng (từ Kế hoạch SX), Bổ sung danh sách vận đơn (từ
  Đối soát COD), Điều hành theo khâu và Nút thắt trước khi rời kho (hai tab của Cần xử lý), Phễu bán
  hàng và Mô phỏng kịch bản (từ Báo cáo lợi nhuận). Mục nào có "nhà" thì về nhà. Vẫn tới được từ ô
  lệnh ⌘K (nhóm "Đi tới trang" đọc từ đây) nên giữ tiêu đề cho breadcrumb.
*/
export const NAV_TITLES: Record<string, string> = {
  ...Object.fromEntries(groups.flatMap((g) => g.items.map((i) => [i.href, i.label]))),
  "/settings/profile": "Tài khoản của tôi",
  "/customers/retention": "Giữ chân khách",
  "/inventory/purchasing": "Mua hàng & xưởng",
  "/import-vtp": "Bổ sung danh sách vận đơn",
  "/operations": "Điều hành theo khâu",
  "/operations/fulfillment": "Nút thắt trước khi rời kho",
  "/reports/funnel": "Phễu bán hàng",
  "/reports/scenario": "Mô phỏng kịch bản",
};
