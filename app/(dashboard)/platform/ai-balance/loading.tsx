import { SectionsPageSkeleton } from "@/components/skeletons";

/** Khung xương của /platform/ai-balance — trang đọc `?org=` (lọc khoản trừ theo tổ chức) nên là trang động: không để trắng màn hình lần mở đầu. */
export default function Loading() {
  return <SectionsPageSkeleton sections={5} />;
}
