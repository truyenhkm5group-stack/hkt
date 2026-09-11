import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Sản phẩm & tồn kho: tiêu đề · ba thẻ lớn · dải ba chỉ số · thanh lọc · bảng.
  return <TablePageSkeleton cards={0} lead={3} strip />;
}
