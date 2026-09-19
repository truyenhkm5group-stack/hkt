import { Skeleton } from "@/components/ui/skeleton";

/**
 * KHUNG XƯƠNG CỦA TRANG HIỆU QUẢ THEO NGÀY.
 *
 * Nó dựng đúng hình dạng sắp hiện ra: bộ lọc → dải KPI → biểu đồ → bảng. Một vòng xoay chung chung
 * ở giữa màn hình không nói được là trang sắp có gì, còn khung xương thì nói — và đó chính là điều
 * chủ shop phàn nàn khi bảo "không biết nó đang chạy hay đã treo".
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-12 w-72 rounded-lg" />
      <Skeleton className="h-20 rounded-xl" />
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
