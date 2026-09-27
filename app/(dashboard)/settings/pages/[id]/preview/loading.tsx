import { ReportPageSkeleton } from "@/components/skeletons";

/** Khung xương của trang tuỳ biến: hàng chỉ số + khối lớn — đúng hình dạng phổ biến nhất của một trang động. */
export default function Loading() {
  return <ReportPageSkeleton cards={4} />;
}
