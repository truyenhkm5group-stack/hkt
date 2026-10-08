import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hostBrand } from "@/lib/platform/host-brand";

/**
 * TRANG 404 GỐC — cho đường dẫn KHÔNG nằm trong `app/(dashboard)` (vd `/automations`, `/abc`): trước đây Next in trang mặc định
 * «404 · This page could not be found.» bằng tiếng Anh, không vỏ, không lối về (kiểm vỏ khách 08/10/2026, F-11). Tiếng Việt, một
 * nút về trang nhà: `/` tự đưa người đã đăng nhập về đúng trang nhà của họ (hộp thư với khách Chốt Đơn, tổng quan với ERP), người
 * chưa đăng nhập về trang đăng nhập. Tên sản phẩm theo HOST đang mở — không in tên nhà lên host Chốt Đơn.
 */
export default async function RootNotFound() {
  const brand = await hostBrand();
  const product = brand === "chotdon" ? "Chốt Đơn Tự Động" : "VNXcommerce";
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="size-6" aria-hidden />
      </span>
      <div className="max-w-md space-y-1">
        <h1 className="text-lg font-bold">Không có trang này</h1>
        <p className="text-sm text-muted-foreground">Đường dẫn bạn mở không tồn tại trong {product}, hoặc đã được chuyển đi. Kiểm tra lại liên kết, hoặc về trang chính.</p>
      </div>
      <Button asChild>
        <Link href="/">Về trang chính</Link>
      </Button>
    </main>
  );
}
