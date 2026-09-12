import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <TablePageSkeleton cards={4} strip rows={8} />;
}
