import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Bản đồ quảng cáo: tiêu đề · ba thẻ (vì sao · chờ trỏ · đã trỏ) · danh sách quảng cáo.
  return <TablePageSkeleton cards={3} rows={6} />;
}
