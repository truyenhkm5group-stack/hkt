import { Skeleton } from "@/components/ui/skeleton";

/**
 * KHUNG XƯƠNG ĐÚNG HÌNH DẠNG TRANG, không phải một ô xám chung.
 *
 * Trang Tổng quan tài chính có hình dạng riêng: một dải việc cần làm, một thẻ lớn cạnh bảng tài
 * khoản, rồi ba khối thẻ chỉ số. Dựng khung theo đúng hình đó thì mắt người đọc đã ở sẵn chỗ con
 * số sắp hiện ra; dựng một khối xám chung thì nội dung nhảy một nhịp khi tải xong.
 *
 * `tests/loading-ux-contract.test.ts` bắt buộc mọi tuyến có kỳ báo cáo phải có tệp này.
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-8 w-[150px]" />
      </div>

      {/* Thanh điều hướng nhóm Tiền */}
      <div className="flex gap-1">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-lg" />
        ))}
      </div>

      {/* Việc cần làm */}
      <Skeleton className="h-14 rounded-xl" />

      {/* Tiền hiện có + bảng tài khoản */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Skeleton className="h-[168px] rounded-xl" />
        <Skeleton className="h-[168px] rounded-xl" />
      </div>

      {/* Ba khối thẻ chỉ số */}
      {Array.from({ length: 3 }).map((_, block) => (
        <div key={block} className="space-y-3 rounded-xl border bg-card p-5">
          <Skeleton className="h-4 w-48" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[124px] rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
