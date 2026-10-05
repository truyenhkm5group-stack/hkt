import { ReportPageSkeleton } from "@/components/skeletons";

/** Trang cấu hình: không có biểu đồ — khung xương cũng không chừa chỗ cho biểu đồ. */
export default function Loading() {
  return <ReportPageSkeleton chart={false} />;
}
