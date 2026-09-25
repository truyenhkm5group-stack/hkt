import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Vòng đời mẫu: tiêu đề · dải chỉ số · thanh lọc · bảng.
  return <TablePageSkeleton cards={0} strip />;
}
