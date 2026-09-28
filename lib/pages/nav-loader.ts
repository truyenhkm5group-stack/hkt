import type { SessionUser } from "@/lib/auth/session";
import { listCustomObjectDefs } from "@/lib/metadata/object-resolver";
import { customObjectNavFor, dynamicNavFor, type DynamicNavItem } from "@/lib/pages/nav";
import { listNavPages } from "@/lib/pages/registry";

/**
 * Nạp mục menu động của NGƯỜI XEM — CHỈ MÁY CHỦ, gọi từ bố cục bảng điều khiển (G12).
 *
 * Menu không bao giờ được làm sập bố cục: đọc lỗi (CSDL tổ chức chưa áp migration `meta_pages`, mất kết nối)
 * ⇒ không có mục động nào, menu cũ vẫn nguyên. Lỗi vẫn vào nhật ký máy chủ — im lặng hoàn toàn là giấu nó.
 */
export async function loadDynamicNav(user: SessionUser): Promise<DynamicNavItem[]> {
  let pages: DynamicNavItem[] = [];
  try {
    pages = dynamicNavFor(await listNavPages(), user);
  } catch (error) {
    console.error("[menu động] không nạp được trang tuỳ biến:", error instanceof Error ? error.message : error);
  }
  // Nguồn thứ hai (Phase 6): đối tượng tuỳ biến ACTIVE. Hỏng riêng nguồn này không làm mất mục của nguồn kia.
  let objects: DynamicNavItem[] = [];
  try {
    objects = customObjectNavFor(await listCustomObjectDefs(), user);
  } catch (error) {
    console.error("[menu động] không nạp được đối tượng tuỳ biến:", error instanceof Error ? error.message : error);
  }
  return [...pages, ...objects];
}
