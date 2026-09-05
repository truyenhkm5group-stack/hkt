import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderActions } from "@/app/(dashboard)/inventory/planning/orders/[id]/order-actions";
import { PageHeader } from "@/components/page-header";
import { ProductionSheet } from "@/components/production-sheet";
import { can, requirePermission } from "@/lib/auth/session";
import { PRODUCTION_STATUS_LABEL, PRODUCTION_STATUS_TONE } from "@/lib/constants/production";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getProductionOrder, matrixAsText } from "@/lib/queries/production";
import { cn } from "@/lib/utils";

export default async function ProductionOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("products:view");
  const { id } = await params;
  const o = await getProductionOrder(id);
  if (!o) notFound();
  const text = matrixAsText(o);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title={`${o.code} · ${o.productCode ? `${o.productCode} · ` : ""}${o.productName}`}
        description={`${formatNumber(o.totalQty)} sản phẩm${o.unitCost ? ` · ~${formatVND(o.totalQty * o.unitCost)}` : ""} · tạo ${formatDateTime(o.createdAt)} bởi ${o.createdBy}${o.sentAt ? ` · gửi xưởng ${formatDateTime(o.sentAt)}` : ""}`}
        actions={<div className="flex items-center gap-2"><span className={cn("rounded px-2 py-0.5 text-xs font-semibold", PRODUCTION_STATUS_TONE[o.status])}>{PRODUCTION_STATUS_LABEL[o.status]}</span><Link href="/inventory/planning/orders" className="text-sm text-primary hover:underline">Danh sách</Link></div>}
      />
      <OrderActions id={o.id} status={o.status} text={text} canWrite={can(user, "inventory:write")} />
      <div className="rounded-xl border bg-white p-6 text-zinc-900 shadow-xs">
        <ProductionSheet data={o} />
      </div>
    </div>
  );
}
