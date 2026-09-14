import { ReportPageSkeleton } from "@/components/skeletons";

/** Bốn thẻ tổng rồi tới các khối — đúng hình dạng trang thật, không phải một vòng xoay giữa màn hình. */
export default function Loading() {
  return <ReportPageSkeleton cards={4} chart={false} />;
}
