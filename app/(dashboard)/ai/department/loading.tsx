import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Phòng Sales AI: tiêu đề · thẻ tự chủ · bốn thẻ chi phí · bảng phễu 12 bậc + một dòng ngoài tầm.
  return <TablePageSkeleton cards={4} rows={13} />;
}
