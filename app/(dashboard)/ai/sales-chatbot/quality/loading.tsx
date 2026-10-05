import { SectionsPageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Trang Rà lỗi AI: tiêu đề · ba ô đếm · danh sách phát hiện.
  return <SectionsPageSkeleton sections={2} />;
}
