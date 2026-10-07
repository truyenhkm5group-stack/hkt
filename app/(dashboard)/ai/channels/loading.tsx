import { SectionsPageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Kênh kết nối: tiêu đề · danh sách Page · ghi chú.
  return <SectionsPageSkeleton sections={2} />;
}
