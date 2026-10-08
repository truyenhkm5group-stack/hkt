import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hostProductName } from "@/lib/branding/copy";
import { hostBrand } from "@/lib/platform/host-brand";
import { hostOrganization } from "@/lib/platform/host-org";

/**
 * TRANG 404 GỐC — cho đường dẫn KHÔNG nằm trong `app/(dashboard)` (vd `/automations`, `/abc`): trước đây Next in trang mặc định
 * «404 · This page could not be found.» bằng tiếng Anh, không vỏ, không lối về (kiểm vỏ khách 08/10/2026, F-11). Tiếng Việt, một
 * nút về trang chính. Tên sản phẩm theo HOST đang mở, cùng thứ tự với tiêu đề tab của bố cục gốc (`hostProductName`): tên miền
 * con của khách in tên cửa hàng, không bao giờ «VNXcommerce»; host Chốt Đơn không in tên nhà.
 *
 * «Về trang chính» là `<a href="/">` — TẢI CẢ TRANG, cố ý không dùng `<Link>`. Trang này nằm NGOÀI nhóm `(dashboard)`, nên một
 * lượt điều hướng phía client tới `/` xin RSC dựng layout `(dashboard)` từ gốc; với người thuộc vỏ Chốt Đơn chính layout đó ném
 * `redirect(hộp thư)` và bộ định tuyến client lặp `replaceState` trên một nút layout hỏng — đúng vòng trang trắng của #671 (cơ
 * chế ở `lib/saas/shell-landing.ts`). Tải cả trang thì máy chủ trả chuyển hướng HTTP, trình duyệt đi thẳng tới trang nhà đúng
 * của từng người — khách vỏ ⇒ hộp thư, ERP ⇒ tổng quan, chưa đăng nhập ⇒ đăng nhập — bằng ĐÚNG luật đang chạy ở middleware và
 * cổng vỏ, không luật thứ hai. `tests/saas-shell.test.ts` quét mã: không `<Link href="/">` ở trang ngoài `(dashboard)` và ở
 * thành phần các trang ấy nạp.
 */
export default async function RootNotFound() {
  const [host, brand] = await Promise.all([hostOrganization(), hostBrand()]);
  const product = hostProductName(host, brand);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="size-6" aria-hidden />
      </span>
      <div className="max-w-md space-y-1">
        <h1 className="text-lg font-bold">Không có trang này</h1>
        <p className="text-sm text-muted-foreground">
          Đường dẫn bạn mở không tồn tại{product ? ` trong ${product}` : ""}, hoặc đã được chuyển đi. Kiểm tra lại liên kết, hoặc về trang chính.
        </p>
      </div>
      <Button asChild>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- cố ý tải cả trang (xem chú thích đầu tệp) */}
        <a href="/">Về trang chính</a>
      </Button>
    </main>
  );
}
