import { Skeleton } from "@/components/ui/skeleton";

/**
 * KHUNG XƯƠNG THEO ĐÚNG HÌNH DẠNG TRANG.
 *
 * Dùng cho `loading.tsx` của từng nhóm route. Khung xương chỉ có ích khi nó GIỐNG trang thật: một
 * khung chung cho mọi trang khiến nội dung nhảy chỗ khi dữ liệu về, và người dùng đọc được "đang
 * tải" nhưng không đọc được "đang tải cái gì". Ba hình dạng dưới đây phủ hết các trang nặng.
 *
 * Khung xương chỉ hiện khi MỞ MỘT TRANG KHÁC. Đổi kỳ / bộ lọc trên cùng một trang thì số cũ vẫn
 * hiện (mờ đi) — xem `StaleWhileRefreshing` trong components/nav-progress.tsx.
 */

function HeaderSkeleton({ actions = 2 }: { actions?: number }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: actions }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-32" />
        ))}
      </div>
    </div>
  );
}

function ToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-8 w-[150px]" />
      <Skeleton className="h-8 w-28" />
      <Skeleton className="h-8 w-28" />
    </div>
  );
}

function TableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b bg-muted/40 px-4 py-2.5">
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 w-[18%]" />
            <Skeleton className="h-4 w-[26%]" />
            <Skeleton className="h-4 w-[14%]" />
            <Skeleton className="h-4 w-[12%]" />
            <Skeleton className="ml-auto h-4 w-[10%]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Hàng thẻ dẫn dắt (cỡ lớn) — khớp `<MetricCard size="lg">`. */
function LeadCardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-[132px] rounded-xl" />
      ))}
    </div>
  );
}

/** Dải chỉ số phụ — MỘT khối liền, khớp `<StatStrip>` (không phải nhiều thẻ rời). */
function StripSkeleton() {
  return <Skeleton className="h-[72px] rounded-xl" />;
}

/**
 * Trang danh sách: tiêu đề · thẻ tổng · thanh lọc · bảng.
 *
 * THỨ TỰ PHẢI KHỚP TRANG THẬT. Trước đây khung xương vẽ thanh lọc TRƯỚC thẻ tổng, trong khi mọi
 * trang danh sách đều xếp thẻ tổng ngay dưới tiêu đề rồi mới tới thanh lọc — nên khi dữ liệu về,
 * hai khối đổi chỗ cho nhau và cả trang giật một nhịp. Khung xương sai hình còn hại hơn không có.
 */
export function TablePageSkeleton({ cards = 4, lead = 0, strip = false, rows = 10 }: { cards?: number; /** số thẻ cỡ lớn ở hàng đầu */ lead?: number; /** có dải chỉ số phụ hay không */ strip?: boolean; rows?: number }) {
  return (
    <div className="space-y-5">
      <HeaderSkeleton />
      {lead > 0 ? <LeadCardsSkeleton count={lead} /> : null}
      {cards > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: cards }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : null}
      {strip ? <StripSkeleton /> : null}
      <ToolbarSkeleton />
      <TableSkeleton rows={rows} />
    </div>
  );
}

/** Trang Tổng quan: tiêu đề · ba thẻ lớn · bốn thẻ vừa · dải phụ · biểu đồ + danh sách việc. */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <HeaderSkeleton />
      <LeadCardsSkeleton />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[124px] rounded-xl" />
        ))}
      </div>
      <StripSkeleton />
      <Skeleton className="h-9 rounded-xl" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
        <Skeleton className="h-[320px] rounded-xl" />
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    </div>
  );
}

/** Trang báo cáo: tiêu đề · tab · thẻ KPI · biểu đồ · bảng. */
export function ReportPageSkeleton({ cards = 4, lead = 0, strip = false, chart = true }: { cards?: number; /** số thẻ cỡ lớn ở hàng đầu */ lead?: number; /** có dải chỉ số phụ hay không */ strip?: boolean; chart?: boolean }) {
  return (
    <div className="space-y-5">
      <HeaderSkeleton actions={1} />
      {lead > 0 ? <LeadCardsSkeleton count={lead} /> : null}
      {cards > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: cards }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : null}
      {strip ? <StripSkeleton /> : null}
      <Skeleton className="h-9 w-80 max-w-full rounded-lg" />
      {chart ? <Skeleton className="h-[280px] rounded-xl" /> : null}
      <TableSkeleton rows={7} />
    </div>
  );
}

/** Trang gồm nhiều khối thẻ xếp dọc (Cần xử lý, Chất lượng dữ liệu). */
export function SectionsPageSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="space-y-5">
      <HeaderSkeleton actions={1} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      {Array.from({ length: sections }).map((_, i) => (
        <Skeleton key={i} className="h-56 rounded-xl" />
      ))}
    </div>
  );
}
