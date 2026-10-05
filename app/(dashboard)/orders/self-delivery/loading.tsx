import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Danh sách tự giao: tiêu đề · dải bốn chỉ số · ba khối bảng (tự giao · đi hãng · giữ lại).
  return <TablePageSkeleton cards={0} strip />;
}
