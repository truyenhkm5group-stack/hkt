import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Bảng số đo: tiêu đề · hai thẻ bảng · bảng gán từng mã hàng.
  return <TablePageSkeleton cards={2} rows={8} />;
}
