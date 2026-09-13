import { SectionsPageSkeleton } from "@/components/skeletons";

/**
 * Trang này đọc ô tìm kiện từ URL, nên mỗi lần gõ tìm là một lượt dựng lại ở máy chủ. Không có
 * khung xương thì người kho nhìn thấy màn hình trắng đúng vào lúc họ đang cầm kiện hàng trên tay.
 */
export default function Loading() {
  return <SectionsPageSkeleton />;
}
