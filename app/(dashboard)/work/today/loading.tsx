import { TablePageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <TablePageSkeleton cards={6} strip rows={8} />;
}
