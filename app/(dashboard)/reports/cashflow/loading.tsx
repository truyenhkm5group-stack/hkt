import { Skeleton } from "@/components/ui/skeleton";

/**
 * Trang Dòng tiền nay nhận `searchParams` (kỳ báo cáo + tab), nên nó là một tuyến NẶNG và bộ dò
 * của `tests/loading-ux-contract.test.ts` bắt buộc phải có khung xương — trước đây trang không đọc
 * tham số nào nên nằm ngoài phạm vi canh.
 *
 * Khung dựng theo hình của tab mặc định (Tiền thật đã vào ra): bốn thẻ số dư / vào / ra / cuối kỳ,
 * một dải phép kiểm, rồi các bảng theo khoang.
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-[150px]" />
      </div>

      {/* Thanh nhóm Tiền + dải tab */}
      <div className="flex gap-1">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-9 w-[380px] rounded-lg" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[124px] rounded-xl" />
        ))}
      </div>

      {/* Dải phép kiểm đẳng thức */}
      <Skeleton className="h-12 rounded-xl" />

      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      ))}
    </div>
  );
}
