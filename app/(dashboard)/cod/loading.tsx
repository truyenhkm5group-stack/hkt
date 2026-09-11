import { ReportPageSkeleton } from "@/components/skeletons";

export default function Loading() {
  // Đối soát COD: tiêu đề · ba thẻ lớn · dải bốn chỉ số · dải tab · bảng.
  return <ReportPageSkeleton cards={0} lead={3} strip chart={false} />;
}
