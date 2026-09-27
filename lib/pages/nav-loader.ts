import type { SessionUser } from "@/lib/auth/session";
import { dynamicNavFor, type DynamicNavItem } from "@/lib/pages/nav";
import { listNavPages } from "@/lib/pages/registry";

/**
 * Nạp mục menu động của NGƯỜI XEM — CHỈ MÁY CHỦ, gọi từ bố cục bảng điều khiển (G12).
 *
 * Menu không bao giờ được làm sập bố cục: đọc lỗi (CSDL tổ chức chưa áp migration `meta_pages`, mất kết nối)
 * ⇒ không có mục động nào, menu cũ vẫn nguyên. Lỗi vẫn vào nhật ký máy chủ — im lặng hoàn toàn là giấu nó.
 */
export async function loadDynamicNav(user: SessionUser): Promise<DynamicNavItem[]> {
  try {
    return dynamicNavFor(await listNavPages(), user);
  } catch (error) {
    console.error("[menu động] không nạp được trang tuỳ biến:", error instanceof Error ? error.message : error);
    return [];
  }
}
