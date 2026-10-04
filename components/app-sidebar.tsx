import {
  Banknote,
  Bot,
  BarChart3,
  BellRing,
  Boxes,
  ClipboardCheck,
  Columns3,
  Database,
  Factory,
  FileDown,
  FileSpreadsheet,
  Gavel,
  GitBranch,
  KanbanSquare,
  HandCoins,
  Headset,
  HeartHandshake,
  Images,
  Clapperboard,
  Landmark,
  LayoutDashboard,
  LayoutTemplate,
  Flag,
  FormInput,
  Lightbulb,
  ListTodo,
  ListChecks,
  Megaphone,
  MessagesSquare,
  Network,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  PackageX,
  Plug,
  PlugZap,
  ReceiptText,
  RefreshCw,
  CalendarClock,
  BedDouble,
  Blocks,
  LibraryBig,
  WandSparkles,
  ServerCog,
  RotateCcw,
  Scissors,
  ScrollText,
  Send,
  ShieldCheck,
  Shirt,
  SlidersHorizontal,
  Stamp,
  Tags,
  ShoppingBag,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  Users,
  Wallet,
  Workflow,
  Rocket,
  Store,
  PhoneOutgoing,
  Radar,
} from "lucide-react";
import type { Role } from "@/db/schema";
import { hasPermission, homeOrgPermissionDenied } from "@/lib/auth/permissions";
import { hrefVisible, moduleOn, modulesOn } from "@/lib/platform-ui/module-visibility";
import { hubMembers, MODULE_GROUPS, MODULE_TITLES, resolveNavZone, ZONE_HINT, ZONE_LABEL, ZONE_ORDER, type ModuleHref, type ModuleSpec, type ModuleZone, type NavHubHref } from "@/lib/constants/department-modules";
import { DYNAMIC_PAGE_PREFIX, DYNAMIC_PAGES_HINT, DYNAMIC_PAGES_LABEL, DYNAMIC_PAGES_ZONE, type DynamicNavItem } from "@/lib/pages/nav";

/**
 * MENU XẾP THEO PHÒNG BAN — VÀ DANH SÁCH MODULE KHÔNG CÒN SỐNG Ở ĐÂY.
 *
 * Chủ shop chốt 23/09/2026: gom module theo phòng ban (đề xuất Đ1 của `docs/navigation-review.md`,
 * treo từ 12/09). Người làm kho mở menu thấy nhóm "Kho"; người chạy quảng cáo thấy nhóm "Marketing";
 * không ai phải đọc qua việc của ba phòng khác để tìm trang quen.
 *
 * Bản đồ module nay nằm ở `lib/constants/department-modules.ts` cùng với `why` của từng dòng — tệp
 * này chỉ còn BẢNG ICON và LUẬT LỌC THEO QUYỀN; cách VẼ nằm ở `components/app-topnav.tsx` (thanh
 * menu viên thuốc của giao diện Bento, thay thanh bên tối từ 24/09/2026). Lý do tách: trước đây bài kiểm phủ điều hướng, bài kiểm
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
  "/approvals": Stamp,
  "/cs": Headset,
  "/orders": ShoppingBag,
  "/landing": FileSpreadsheet,
  "/customers": Users,
  "/customers/receivables": HandCoins,
  "/customers/reorder": RefreshCw,
  "/appointments": CalendarClock,
  "/warranty": ShieldCheck,
  "/wholesale/leads": Store,
  "/wholesale/outreach": PhoneOutgoing,
  "/wholesale/lead-hunter": Radar,
  "/wholesale/dashboard": TrendingUp,
  "/stays": BedDouble,
  "/outreach": HeartHandshake,
  "/chatbot": Bot,
  "/ads": Megaphone,
  "/ideas": Lightbulb,
  "/marketing/creatives": Images,
  "/marketing/video-scale": Clapperboard,
  "/marketing/topics": Send,
  "/marketing/fanpages": Flag,
  "/shipments": Truck,
  "/returns": RotateCcw,
  "/reports/returns": Undo2,
  "/products": Shirt,
  "/products/price-lists": Tags,
  "/inventory/packing": PackageOpen,
  "/inventory/receipts": PackagePlus,
  "/inventory/returns": ClipboardCheck,
  "/inventory": Boxes,
  "/inventory/planning": Factory,
  "/inventory/workshop": Scissors,
  "/inventory/shortage": PackageX,
  "/inventory/decisions": Wallet,
  "/models": GitBranch,
  "/models?view=bang": KanbanSquare,
  "/production": MessagesSquare,
  "/products/performance": TrendingUp,
  "/finance": Wallet,
  "/cod": PackageCheck,
  "/bank": Landmark,
  "/finance-ops": ListChecks,
  "/expenses": ReceiptText,
  "/reports": BarChart3,
  "/reports/cashflow": Banknote,
  "/payroll": HandCoins,
  "/cockpit": Gavel,
  "/departments": Network,
  "/data-quality": ShieldCheck,
  "/tech": Bot,
  "/integrations": PlugZap,
  "/settings/users": UserCog,
  "/audit": ScrollText,
  "/settings/modules": Blocks,
  "/settings/advanced": SlidersHorizontal,
  "/settings/data-model": Database,
  "/settings/forms": FormInput,
  "/settings/lists": Columns3,
  "/settings/statuses": Tags,
  "/settings/workflows": Workflow,
  "/settings/pages": LayoutTemplate,
  "/settings/connections": Plug,
  "/settings/templates": LibraryBig,
  "/settings/export": FileDown,
  "/settings/data-export": FileDown,
  "/settings/objects": Boxes,
  "/settings/ai-builder": WandSparkles,
  "/settings/notifications": BellRing,
  "/setup": Rocket,
  "/ai/sales-chatbot": MessagesSquare,
  "/platform": ServerCog,
};

export function iconOf(href: string): typeof LayoutDashboard {
  if (href.startsWith(`${DYNAMIC_PAGE_PREFIX}/`)) return LayoutTemplate;
  // Đối tượng tuỳ biến (Phase 6) — mục menu động `/o/<khoá>`.
  if (href.startsWith("/o/")) return Boxes;
  return MODULE_ICON[href as ModuleHref] ?? LayoutDashboard;
}

/**
 * Người dùng tối thiểu để lọc menu — dùng chung cho thanh bên và ô lệnh ⌘K.
 *
 * `modules` = module ĐANG BẬT của tổ chức (đã phân giải, `SessionUser.modules`). Vắng mặt ⇒ không lọc
 * theo module (chỉ người dựng tay trong kiểm thử); `resolveCurrentUser()` luôn điền.
 */
export type NavUserLike = {
  role: Role;
  permissions: string[];
  modules?: readonly string[];
  /**
   * Tổ chức của phiên — chỉ cần `isHome`: khoá chỉ-nhà (`platform:operate`) KHÔNG hiện mục ở tổ chức khác, kể cả
   * với ADMIN (cùng luật `homeOrgPermissionDenied` với `can()`). Vắng mặt ⇒ coi như KHÔNG phải nhà (hỏng về phía hẹp).
   */
  organization?: { isHome: boolean } | null;
  /**
   * Mục menu ĐỘNG (Phase 4 · G12): trang tuỳ biến đã xuất bản, bố cục nạp ở máy chủ và ĐÃ lọc theo người xem
   * (`lib/pages/nav.ts`). Vắng mặt ⇒ menu cũ nguyên vẹn. Vẫn qua `moduleAllows` ở đây như mọi mục khác.
   */
  dynamicPages?: readonly DynamicNavItem[];
};

/** Vùng menu: phòng ban / nhóm chéo của sổ khai, cộng nhóm "Trang tuỳ biến" cho trang động không khai vùng. */
export type NavZone = ModuleZone | typeof DYNAMIC_PAGES_ZONE;
export type NavGroupItem = { href: string; label: string };
export type NavGroup = { zone: NavZone; label: string; hint: string; items: NavGroupItem[] };

/** Nhóm thật của một vùng khai với người này: vùng mang tên một module TẮT dời sang nhóm dự phòng (`ZONE_MODULE`). */
function zoneFor(zone: ModuleZone, user: Pick<NavUserLike, "modules">): ModuleZone {
  return resolveNavZone(zone, (m) => moduleOn(user, m));
}

/** Mục động của người này theo vùng (đã qua cổng module như mục tĩnh; vùng mang tên module tắt cũng dời như mục tĩnh). */
function dynamicByZone(user: NavUserLike): Map<NavZone, NavGroupItem[]> {
  const out = new Map<NavZone, NavGroupItem[]>();
  for (const d of user.dynamicPages ?? []) {
    if (!moduleAllows(d.href, user)) continue;
    const zone: NavZone = d.zone && (ZONE_ORDER as readonly string[]).includes(d.zone) ? zoneFor(d.zone as ModuleZone, user) : DYNAMIC_PAGES_ZONE;
    out.set(zone, [...(out.get(zone) ?? []), { href: d.href, label: d.label }]);
  }
  return out;
}

/**
 * Mục có thuộc module đang bật không. Áp CẢ CHO ADMIN (target-architecture P8): quản trị vẫn vượt mọi
 * kiểm QUYỀN, nhưng không vượt cổng MODULE — trang của module tắt mở ra chỉ gặp `/module-disabled`.
 *
 * Ẩn menu KHÔNG phải bảo mật: cổng thật ở máy chủ (`resolveCurrentUser` theo đường dẫn). Đây chỉ là
 * để người dùng không bấm vào một lối cụt.
 */
export function moduleAllows(href: string, user: Pick<NavUserLike, "modules">): boolean {
  // Cùng MỘT hàm với trang tổng hợp và công cụ AI (lib/platform-ui/module-visibility.ts). Mục không
  // thuộc module nào: bài kiểm sổ module đòi mọi href menu có chủ, nên nhánh ấy chỉ là lưới an toàn.
  return hrefVisible(user, href);
}

/**
 * Một mục có hiện với người này không. Module tắt ⇒ ẩn (kể cả ADMIN); khoá chỉ-nhà ở tổ chức khác ⇒ bỏ (kể cả ADMIN —
 * cùng cổng với `can()` và với trang, vd `/platform` gác bằng `platformOperatorDenial`); rồi ADMIN thấy hết; `anyOf`
 * thì đủ MỘT quyền còn hiệu lực là hiện.
 */
export function visible(item: ModuleSpec, user: NavUserLike): boolean {
  if (!moduleAllows(item.href, user)) return false;
  // Module NGUỒN SỐ LIỆU ngoài module sở hữu đường dẫn (vd `/cod` cần «Vận chuyển») — tắt ⇒ ẩn, kể cả ADMIN.
  if (item.requires && !modulesOn(user, item.requires)) return false;
  const keys = item.anyOf ?? (item.permission ? [item.permission] : []);
  const usable = keys.filter((p) => !homeOrgPermissionDenied(user, p));
  if (keys.length > 0 && usable.length === 0) return false;
  if (user.role === "ADMIN") return true;
  return keys.length === 0 || usable.some((p) => hasPermission(user.permissions, p));
}

/**
 * ═══ TRANG GOM Ở TỔ CHỨC KHÁCH ═══
 *
 * Chủ shop chốt 30/09/2026: tổ chức khách (không phải tổ chức nhà) thấy MỘT mục «Tuỳ biến nâng cao» thay cho mười công cụ
 * dựng cấu hình — menu Hệ thống của họ dài hơn cả phần nghiệp vụ. Tổ chức nhà giữ nguyên mười mục như trước.
 *
 * Đây là luật XẾP menu, không phải luật QUYỀN: `visible()` vẫn là máy tính duy nhất cho "người này dùng được mục này
 * không" (AGENTS.md mục 28). Trang gom hiện ⇔ người xem thấy được ít nhất một mục gom vào nó, và trang gom liệt kê
 * đúng những mục đó (`hubTools`). Phiên không mang tổ chức ⇒ coi như tổ chức khách, cùng hướng với `homeOrgPermissionDenied`.
 */
export function foldsHubs(user: Pick<NavUserLike, "organization">): boolean {
  return user.organization?.isHome !== true;
}

/** Công cụ của một trang gom mà người này dùng được — theo đúng `visible()`, giữ thứ tự khai. */
export function hubTools(hub: NavHubHref, user: NavUserLike): ModuleSpec[] {
  return hubMembers(hub).filter((item) => visible(item, user));
}

/** Mục có đứng trên MENU (và ⌘K) của người này không: `visible()` cộng luật gom của tổ chức khách. */
export function onMenu(item: ModuleSpec, user: NavUserLike): boolean {
  if (item.hub) return foldsHubs(user) && moduleAllows(item.href, user) && hubTools(item.href as NavHubHref, user).length > 0;
  if (item.foldInto && foldsHubs(user)) return false;
  if (item.tenantOnly && !foldsHubs(user)) return false;
  return visible(item, user);
}

/**
 * Chuông có hỏi HÀNG ĐỢI CHUNG (`/api/notifications`) không. Tuyến ấy thuộc lõi nhưng gác bằng
 * `alerts:view` — khoá của module «Cần xử lý». Tổ chức tắt module đó thì mọi lượt hỏi (30 giây/lần)
 * đều nhận 403: vừa phí, vừa rác nhật ký. Người không có `alerts:view` cũng vậy (403 từ trước nền tảng).
 *
 * Hộp thư CÁ NHÂN (phiếu lương, lời nhắc duyệt) KHÔNG phụ thuộc module này nên vẫn hỏi — tắt cả
 * chuông là làm mất tin "Gửi riêng bạn" của tổ chức dùng Lương mà không dùng Cần xử lý.
 */
export function bellShowsSharedQueue(user: NavUserLike): boolean {
  if (!moduleAllows("/alerts", user)) return false;
  return user.role === "ADMIN" || hasPermission(user.permissions, "alerts:view");
}

/** Mọi trang người này được vào, theo đúng luật lọc của thanh bên (ADMIN thấy hết) — gồm cả trang tuỳ biến. */
export function allowedNavItems(user: NavUserLike): { href: string; label: string; group: string; icon: typeof LayoutDashboard }[] {
  return visibleGroups(user).flatMap((g) => g.items.map((item) => ({ href: item.href, label: item.label, group: g.label, icon: iconOf(item.href) })));
}

/**
 * Các nhóm menu người này thấy — nhóm không còn mục nào sau khi lọc quyền thì bỏ hẳn. Mục động (G12) nối vào
 * CUỐI nhóm vùng nó khai (kể cả vùng chưa có mục tĩnh nào); không khai vùng ⇒ nhóm "Trang tuỳ biến" ở cuối.
 */
export function visibleGroups(user: NavUserLike): NavGroup[] {
  const dyn = dynamicByZone(user);
  // Nhóm mang tên một module TẮT (`ZONE_MODULE`) không hiện; mục còn hiện được của nó DỜI sang nhóm dự phòng, đứng SAU
  // mục vốn có của nhóm ấy — không mất lối vào trang, chỉ mất cái nhãn sai.
  const native = new Map<ModuleZone, NavGroupItem[]>();
  const moved = new Map<ModuleZone, NavGroupItem[]>();
  for (const zone of ZONE_ORDER) {
    const items = (MODULE_GROUPS.find((g) => g.zone === zone)?.items ?? []).filter((item) => onMenu(item, user)).map((i) => ({ href: i.href, label: i.label }));
    if (items.length === 0) continue;
    const target = zoneFor(zone, user);
    const into = target === zone ? native : moved;
    into.set(target, [...(into.get(target) ?? []), ...items]);
  }
  const groups: NavGroup[] = ZONE_ORDER.map((zone) => {
    const base = MODULE_GROUPS.find((g) => g.zone === zone);
    const items: NavGroupItem[] = [...(native.get(zone) ?? []), ...(moved.get(zone) ?? []), ...(dyn.get(zone) ?? [])];
    return { zone, label: base?.label ?? ZONE_LABEL[zone], hint: base?.hint ?? ZONE_HINT[zone], items };
  });
  groups.push({ zone: DYNAMIC_PAGES_ZONE, label: DYNAMIC_PAGES_LABEL, hint: DYNAMIC_PAGES_HINT, items: dyn.get(DYNAMIC_PAGES_ZONE) ?? [] });
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Mục có đường dẫn dài nhất khớp với trang hiện tại mới được tô sáng (/reports/returns không tô
 * cả /reports). Tính MỘT lần cho cả menu, thay vì lặp lại phép này bên trong từng mục.
 */
export function activeHrefOf(pathname: string, extraHrefs: readonly string[] = []): string | undefined {
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return [...MODULE_GROUPS.flatMap((g) => g.items.map((i) => i.href)), ...extraHrefs].filter(matches).sort((a, b) => b.length - a.length)[0];
}

/**
 * Mục menu được tô sáng cho trang hiện tại, với ĐÚNG menu người này thấy: ở tổ chức khách, đang mở một công cụ đã gom
 * (vd `/settings/forms`) thì tô trang gom chứa nó — mục riêng của công cụ không có trên menu của họ.
 */
export function menuActiveHref(pathname: string, user: NavUserLike): string | undefined {
  const href = activeHrefOf(pathname, user.dynamicPages?.map((d) => d.href));
  const spec = href ? MODULE_GROUPS.flatMap((g) => g.items).find((i) => i.href === href) : undefined;
  return spec?.foldInto && foldsHubs(user) ? spec.foldInto : href;
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
  "/help": "Hướng dẫn sử dụng",
  "/module-disabled": "Module chưa bật",
  "/customers/retention": "Giữ chân khách",
  "/inventory/purchasing": "Mua hàng & xưởng",
  "/import-vtp": "Bổ sung danh sách vận đơn",
  "/operations": "Điều hành theo khâu",
  "/operations/preship": "Soát đơn trước khi gửi",
  "/operations/fulfillment": "Nút thắt trước khi rời kho",
  "/operations/dwell": "Vận đơn đứng yên quá lâu",
  "/reports/funnel": "Phễu bán hàng",
  "/reports/scenario": "Mô phỏng kịch bản",
  "/reports/target": "Kế hoạch mục tiêu lợi nhuận",
  "/shipments/stock-wait": "Chờ hàng & giao thành công",
  /*
    Trang tuỳ biến (Phase 4): MỘT khoá đếm cho mọi `/p/<slug>`. Bộ đếm lượt mở cố ý không nhận đường dẫn thô
    (lib/constants/page-usage.ts điều 2) — mỗi slug một khoá là để bảng phình theo cấu hình của từng tổ chức.
    Không có trang `/p` trần: `DetailCrumb` bỏ qua tiền tố này (trang động tự in tên của nó).
  */
  [DYNAMIC_PAGE_PREFIX]: "Trang tuỳ biến",
};
