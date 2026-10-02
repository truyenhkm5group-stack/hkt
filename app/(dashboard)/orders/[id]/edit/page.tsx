import { manualOrderPricing } from "@/lib/records/trade";
import { notFound } from "next/navigation";
import { ManualOrderForm } from "@/app/(dashboard)/orders/manual-order-form";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { manualOrderFormOptions, manualOrderFormValues, manualOrderGate } from "@/lib/records/order-create";

export const metadata = { title: "Sửa đơn hàng" };

/**
 * Sửa ĐƠN TAY. 404 khi: cổng tạo đơn tay đóng (tổ chức đồng bộ đơn / thiếu `orders:write`), đơn không phải đơn tay
 * (id không `erp-`), hoặc đơn đã huỷ — cùng các điều kiện mà `updateManualOrderCore` chặn.
 */
export default async function EditManualOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("orders:read");
  const gate = await manualOrderGate(user);
  if (!gate.allowed) notFound();
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const [values, options, pricing] = await Promise.all([manualOrderFormValues(id), manualOrderFormOptions(), manualOrderPricing()]);
  if (!values) notFound();
  const initial = {
    customerId: values.customerId,
    stage: values.stage,
    channel: values.channel,
    note: values.note,
    orderDiscount: values.orderDiscount ? String(values.orderDiscount) : "",
    shippingFee: values.shippingFee ? String(values.shippingFee) : "",
    lines: values.lines.map((l) => ({ variantId: l.variantId, quantity: String(l.quantity), unitPrice: String(l.unitPrice), discount: l.discount ? String(l.discount) : "" })),
    // Người nhận ĐANG LƯU trên đơn (0180) — sửa địa chỉ ở đây là sửa đơn này, không sửa hồ sơ khách.
    recipient: values.recipient,
  };
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader eyebrow="Đơn hàng" title={`Sửa đơn ${manualOrderShortCode(id)}`} description="Đơn tạo tay trên ERP. Dòng hàng được thay nguyên bộ khi lưu; mọi lượt lưu vào nhật ký kèm bản trước / sau." />
      <SectionCard>
        <ManualOrderForm mode="edit" orderId={id} initial={initial} customers={options.customers} variants={options.variants} pricing={pricing} />
      </SectionCard>
    </div>
  );
}
