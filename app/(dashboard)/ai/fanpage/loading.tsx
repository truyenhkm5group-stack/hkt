import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Cấu hình fanpage: tiêu đề · bốn thẻ (chọn page · mẫu thắng · ngoại lệ · mẫu test) · danh sách nguồn.
  return <TablePageSkeleton cards={4} rows={6} />;
}
