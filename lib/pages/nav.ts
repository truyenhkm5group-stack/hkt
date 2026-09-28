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
import { NAV_MODULES, type ModuleZone } from "@/lib/constants/department-modules";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { moduleOfPath, moduleOfPermission, type ModuleKey } from "@/lib/constants/platform-modules";
import { customObjectHref } from "@/lib/metadata/custom-object-def";
import { objectAccess } from "@/lib/metadata/permissions";
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

// ═══════════ NGUỒN MỤC THỨ HAI: ĐỐI TƯỢNG TUỲ BIẾN (Phase 6 · mục 5) ═══════════

/** Thứ tự của mục đối tượng tuỳ biến trong nhóm — đứng SAU trang tuỳ biến cùng nhóm (trang có `nav.order` riêng). */
export const CUSTOM_OBJECT_NAV_ORDER = 10_000;

/** Vùng menu của một module: vùng của mục menu tĩnh ĐẦU TIÊN thuộc module đó; không có ⇒ nhóm "Trang tuỳ biến". */
export function zoneOfModule(module: string): ModuleZone | null {
  return NAV_MODULES.find((m) => moduleOfPath(m.href) === module)?.zone ?? null;
}

/**
 * Đối tượng tuỳ biến ACTIVE ⇒ mục menu của người xem (hàm THUẦN). Cùng luật lọc với trang `/o/<khoá>`:
 *  1. module `apps` VÀ nhóm menu của đối tượng phải bật cho tổ chức (kể cả ADMIN — P8);
 *  2. đủ khoá xem (`records:view` + khoá siết của đối tượng) — ADMIN vượt quyền, KHÔNG vượt module sở hữu khoá.
 * Ẩn menu KHÔNG phải bảo mật: trang tự kiểm lại ở máy chủ (`recordGate`).
 */
export function customObjectNavFor(objects: readonly AnyObjectDef[], viewer: DynamicNavViewer): DynamicNavItem[] {
  return objects
    .filter((o) => !o.system && o.custom?.status === "ACTIVE")
    .filter((o) => {
      const modules = [o.module as string, o.custom!.menuModule];
      if (viewer.modules && modules.some((m) => !viewer.modules!.includes(m))) return false;
      return objectAccess(o).view.every((p) => {
        const owner: ModuleKey | null = moduleOfPermission(p);
        if (owner && viewer.modules && !viewer.modules.includes(owner)) return false;
        return viewer.role === "ADMIN" || hasPermission(viewer.permissions, p);
      });
    })
    .sort((a, b) => a.labelPlural.localeCompare(b.labelPlural, "vi"))
    .map((o) => ({ href: customObjectHref(o.key), label: o.labelPlural, zone: zoneOfModule(o.custom!.menuModule), order: CUSTOM_OBJECT_NAV_ORDER }));
}
