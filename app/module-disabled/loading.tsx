import { SectionsPageSkeleton } from "@/components/skeletons";

/** Trang đứng ngoài bố cục `(dashboard)` (xem `page.tsx`) nên tự chừa lề như `<main>` của trang. */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-3xl px-3 py-6 sm:px-5 sm:py-10">
      <SectionsPageSkeleton sections={1} />
    </main>
  );
}
