import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { getBrandCopy } from "@/lib/branding/service";

/**
 * Câu giải thích đi qua `lib/branding/copy.ts` (Phase 11 · H4): tổ chức nhà giữ NGUYÊN câu cũ ("chưa được đồng bộ về
 * ERP" — dữ liệu của nhà kéo từ Pancake), tổ chức khác không có bước đồng bộ nào nên nhận câu trung tính.
 */
export default async function NotFound() {
  const copy = await getBrandCopy(await getCurrentUser());
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="size-6" />
      </span>
      <div>
        <h2 className="text-lg font-bold">Không tìm thấy dữ liệu</h2>
        <p className="mt-1 text-sm text-muted-foreground">{copy.text("notFound.body")}</p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Về trang tổng quan</Link>
      </Button>
    </div>
  );
}
