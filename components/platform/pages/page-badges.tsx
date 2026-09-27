import { PAGE_STATE_LABEL, PAGE_STATE_TONE, pageState } from "@/lib/platform-ui/page-admin-shared";
import type { PageStatus } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/** Trạng thái trang: Nháp chưa xuất bản · Đang xuất bản · Đã lưu trữ — dùng ở danh sách và trình soạn. */
export function PageStateBadge({ status, publishedVersion }: { status: PageStatus; publishedVersion: number }) {
  const s = pageState({ status, publishedVersion });
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", PAGE_STATE_TONE[s])}>{PAGE_STATE_LABEL[s]}</span>;
}
