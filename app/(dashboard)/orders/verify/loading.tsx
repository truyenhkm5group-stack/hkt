import { ReportPageSkeleton } from "@/components/skeletons";

/** Trang không có biểu đồ nào — khung xương cũng không được vẽ chỗ cho biểu đồ. */
export default function Loading() {
  return <ReportPageSkeleton chart={false} />;
}
