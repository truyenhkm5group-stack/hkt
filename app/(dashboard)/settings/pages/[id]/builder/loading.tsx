import { SectionsPageSkeleton } from "@/components/skeletons";

/** Khung xương của trình kéo-thả: thanh công cụ + ba cột (thư viện · khung · thuộc tính). */
export default function Loading() {
  return <SectionsPageSkeleton sections={3} />;
}
