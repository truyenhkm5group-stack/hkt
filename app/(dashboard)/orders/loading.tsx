import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Đơn hàng: tiêu đề · dải bốn chỉ số · thanh lọc · bảng.
  return <TablePageSkeleton cards={0} strip />;
}
