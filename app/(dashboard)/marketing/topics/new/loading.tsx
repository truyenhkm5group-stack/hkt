import { SectionsPageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Sản xuất: tiêu đề · các khối (yêu cầu / trao đổi / giá thành / mẫu / bản duyệt).
  return <SectionsPageSkeleton sections={3} />;
}
