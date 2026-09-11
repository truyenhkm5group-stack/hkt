import { ReportPageSkeleton } from "@/components/skeletons";

/**
 * Trang phễu KHÔNG có biểu đồ nào. Khung xương mặc định vẽ một khối 280px cho biểu đồ, nên người mở
 * trang thấy một ô lớn hiện ra rồi biến mất — khung xương nói sai về trang nó đang chờ.
 */
export default function Loading() {
  return <ReportPageSkeleton chart={false} />;
}
