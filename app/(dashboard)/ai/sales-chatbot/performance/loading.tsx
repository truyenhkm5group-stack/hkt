import { Skeleton } from "@/components/ui/skeleton";

/**
 * KHUNG XƯƠNG CỦA TRANG HIỆU QUẢ AI BÁN HÀNG — đúng hình dạng sắp hiện ra: tiêu đề + chọn kỳ → dải sáu chỉ số → phễu theo
 * hội thoại → hai khối (đơn bot chốt · chuyển người & mua thêm) → chi phí AI & ROI.
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-12 w-80 rounded-lg" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
