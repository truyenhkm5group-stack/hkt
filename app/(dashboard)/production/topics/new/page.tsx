import { redirect } from "next/navigation";
import type { PageSearchParams } from "@/lib/search-params";

/**
 * Chủ shop 27/09/2026: MARKETING mở topic để trao đổi với sản xuất, nên biểu mẫu chuyển sang
 * `/marketing/topics/new`. Đường cũ còn được trang mẫu 360, bàn sản xuất, tab Thiết kế và cảnh báo thiếu
 * chứng cứ trỏ tới — giữ nó làm lối chuyển, mang nguyên `?model=`.
 */
export default async function LegacyNewTopicPage({ searchParams }: { searchParams: PageSearchParams }) {
  const raw = await searchParams;
  const model = typeof raw.model === "string" ? raw.model : "";
  redirect(model ? `/marketing/topics/new?model=${encodeURIComponent(model)}` : "/marketing/topics/new");
}
