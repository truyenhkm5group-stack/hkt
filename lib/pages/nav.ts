/**
 * ═══════════ MENU ĐỘNG (Phase 4 · G12) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Trang tuỳ biến đã xuất bản có `nav.enabled` thành MỤC MENU của tổ chức — nối vào CÙNG luật lọc của menu cũ
 * (`visibleGroups` / `allowedNavItems` / ô lệnh ⌘K ở `components/app-sidebar.tsx`), không viết lại menu nào.
 * Bố cục (`app/(dashboard)/layout.tsx`) nạp danh sách ở MÁY CHỦ (`lib/pages/nav-loader.ts`) rồi truyền xuống.
 *
 * Luật lọc theo NGƯỜI XEM — cùng thứ tự với trang `/p/[slug]` để menu không bao giờ dẫn vào một lối cụt:
 *  1. Module chủ của trang phải bật cho tổ chức (kể cả ADMIN — P8).
 *  2. Quyền xem (`requiredPermission`) — ADMIN vượt quyền, KHÔNG vượt module sở hữu quyền đó.
 * Ẩn menu KHÔNG phải bảo mật: trang tự kiểm lại ở máy chủ.
 */
import { hasPermission } from "@/lib/auth/permissions";
import type { ModuleZone } from "@/lib/constants/department-modules";
import { moduleOfPermission, type ModuleKey } from "@/lib/constants/platform-modules";
import type { PageDefinition } from "@/lib/pages/types";

/** Nhóm menu của trang không khai vùng (`nav.zone = null`). Không phải một phòng ban. */
export const DYNAMIC_PAGES_ZONE = "CUSTOM_PAGES" as const;
export const DYNAMIC_PAGES_LABEL = "Trang tuỳ biến";
export const DYNAMIC_PAGES_HINT = "Trang tổ chức tự dựng từ khối có sẵn — cấu hình ở Hệ thống";

/** Tiền tố đường dẫn của trang động (`app/(dashboard)/p/[slug]`). */
export const DYNAMIC_PAGE_PREFIX = "/p";

export function dynamicPageHref(slug: string): string {
  return `${DYNAMIC_PAGE_PREFIX}/${slug}`;
}

/** Một mục menu động — chỉ dữ liệu thuần, đi được qua ranh giới Server → Client. */
export type DynamicNavItem = { href: string; label: string; zone: ModuleZone | null; order: number };

export type DynamicNavViewer = { role: string; permissions: readonly string[]; modules?: readonly string[] };

/** Người xem có mở được trang này không (module chủ + quyền xem). Hàm THUẦN — dùng chung cho menu và bài kiểm. */
export function pageOpenableBy(page: Pick<PageDefinition, "moduleKey" | "requiredPermission">, viewer: DynamicNavViewer): boolean {
  if (viewer.modules && !viewer.modules.includes(page.moduleKey)) return false;
  if (!page.requiredPermission) return true;
  const owner: ModuleKey | null = moduleOfPermission(page.requiredPermission);
  if (owner && viewer.modules && !viewer.modules.includes(owner)) return false;
  return viewer.role === "ADMIN" || hasPermission(viewer.permissions, page.requiredPermission);
}

/** Trang đã xuất bản ⇒ mục menu của người xem (đã lọc, đã xếp theo `nav.order` rồi tên). */
export function dynamicNavFor(pages: readonly PageDefinition[], viewer: DynamicNavViewer): DynamicNavItem[] {
  return pages
    .filter((p) => p.status === "ACTIVE" && p.publishedVersion > 0 && p.nav.enabled && pageOpenableBy(p, viewer))
    .sort((a, b) => a.nav.order - b.nav.order || a.name.localeCompare(b.name, "vi"))
    .map((p) => ({ href: dynamicPageHref(p.slug), label: p.nav.label || p.name, zone: (p.nav.zone as ModuleZone | null) ?? null, order: p.nav.order }));
}
