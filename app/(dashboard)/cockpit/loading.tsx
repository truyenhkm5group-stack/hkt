import { SectionsPageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Buồng lái: tiêu đề · dải lọc loại · các nhóm đề xuất.
  return <SectionsPageSkeleton sections={3} />;
}
