import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Đơn chờ xuất: tiêu đề · một bảng đơn.
  return <TablePageSkeleton cards={0} />;
}
