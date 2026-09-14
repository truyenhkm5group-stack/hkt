import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Soát nấc chạy ngầm: tiêu đề · ba thẻ (đã chấm · đúng · độ chính xác) · danh sách lượt ba cột.
  return <TablePageSkeleton cards={3} rows={8} />;
}
