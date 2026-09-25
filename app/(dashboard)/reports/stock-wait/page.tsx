import { redirect } from "next/navigation";
import { searchParamsQuery, type PageSearchParams } from "@/lib/search-params";

/**
 * Báo cáo "Chờ hàng & giao thành công" đã chuyển sang khu Vận đơn (chủ shop yêu cầu 25/09/2026):
 * `/shipments/stock-wait`. Trang này chỉ còn chuyển hướng, GIỮ NGUYÊN bộ lọc — link đã gửi đi (Lark,
 * tin nhắn) vẫn mở đúng chỗ, đúng kỳ, đúng mã hàng.
 */
export default async function StockWaitMoved({ searchParams }: { searchParams: PageSearchParams }) {
  redirect(`/shipments/stock-wait${searchParamsQuery(await searchParams)}`);
}
