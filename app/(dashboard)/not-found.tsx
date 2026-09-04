import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="size-6" />
      </span>
      <div>
        <h2 className="text-lg font-bold">Không tìm thấy dữ liệu</h2>
        <p className="mt-1 text-sm text-muted-foreground">Bản ghi không tồn tại hoặc chưa được đồng bộ về ERP.</p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Về trang tổng quan</Link>
      </Button>
    </div>
  );
}
