import { notFound } from "next/navigation";
import { ManualOrderForm } from "@/app/(dashboard)/orders/manual-order-form";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { manualOrderFormOptions, manualOrderGate } from "@/lib/records/order-create";

export const metadata = { title: "Tạo đơn hàng" };

/**
 * Tạo ĐƠN TAY (pilot P0 #3). Trang KHÔNG TỒN TẠI (404) khi tổ chức đang đồng bộ đơn từ Pancake hoặc người xem thiếu
 * `orders:write` — cùng một cổng với server action (`manualOrderGate`), để nút, trang và lượt ghi không nói ba điều khác nhau.
 */
export default async function NewManualOrderPage() {
  const user = await requirePermission("orders:read");
  const gate = await manualOrderGate(user);
  if (!gate.allowed) notFound();
  const options = await manualOrderFormOptions();
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader eyebrow="Đơn hàng" title="Tạo đơn hàng" description="Đơn tạo tay trên ERP — tổ chức này không đồng bộ đơn từ nguồn bán hàng nào." />
      <SectionCard>
        <ManualOrderForm mode="create" customers={options.customers} variants={options.variants} />
      </SectionCard>
    </div>
  );
}
