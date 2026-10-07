import { Skeleton } from "@/components/ui/skeleton";

/**
 * KHUNG XƯƠNG CỦA TỔNG QUAN (vỏ app Chốt Đơn) — đúng hình dạng sắp hiện ra: tiêu đề + chọn kỳ → tám ô (2 cột trên điện thoại,
 * 4 cột màn rộng) → khối «đơn AI chốt đã giao tới đâu».
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-12 w-full max-w-80 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-36 rounded-2xl" />
    </div>
  );
}
