import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Nhân sự AI: tiêu đề · bốn thẻ (lượt chạy · chuyển người · token · chi phí) · bảng lượt chạy.
  return <TablePageSkeleton cards={4} rows={12} />;
}
