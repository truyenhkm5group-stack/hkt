import { notFound } from "next/navigation";
import { ImportWizard } from "@/app/(dashboard)/products/import/import-wizard";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { productCreateGate } from "@/lib/records/product-create";

export const metadata = { title: "Nhập sản phẩm từ tệp" };

/**
 * Nhập sản phẩm hàng loạt từ tệp CSV / Excel. CÙNG cổng với `/products/new` (`productCreateGate`): tổ chức bật Pancake
 * hoặc người thiếu `products:write` ⇒ trang KHÔNG TỒN TẠI (404). Máy chủ kiểm lại mọi thứ ở từng lượt
 * (`lib/products/import.ts`); trang chỉ dẫn người dùng qua các bước.
 */
export default async function ProductImportPage() {
  const user = await requirePermission("products:view");
  const gate = await productCreateGate(user);
  if (!gate.allowed) notFound();
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        eyebrow="Kho · Sản phẩm"
        title="Nhập sản phẩm từ tệp"
        description="CSV hoặc Excel · tối đa 2 MB, 2.000 dòng mỗi lượt"
        hint={
          <>
            Tải tệp → ghép cột → <b>Kiểm tra</b> (chạy thử, chưa ghi gì) → <b>Nhập</b>. SKU để trống thì ERP tự sinh từ tên.
            Dòng có SKU đã tồn tại (cùng tên) được bỏ qua, nên bấm nhập hai lần không tạo bản thứ hai. Cột Tồn đầu tạo MỘT
            phiếu Nhập hàng cho cả lượt — tồn chỉ đổi qua phiếu kho.
          </>
        }
      />
      <ImportWizard canWriteStock={can(user, "inventory:write")} />
    </div>
  );
}
