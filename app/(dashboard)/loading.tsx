import { ReportPageSkeleton } from "@/components/skeletons";

/**
 * Khung xương mặc định cho các trang chưa có `loading.tsx` riêng, và cho chính trang Tổng quan.
 * Chỉ hiện khi MỞ MỘT TRANG KHÁC — đổi kỳ trên cùng một trang thì số cũ vẫn hiện (mờ đi).
 */
export default function Loading() {
  return <ReportPageSkeleton />;
}
