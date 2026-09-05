import { notFound } from "next/navigation";
import { PrintButton } from "@/app/print/production/[id]/print-button";
import { ProductionSheet } from "@/components/production-sheet";
import { requirePermission } from "@/lib/auth/session";
import { getProductionOrder } from "@/lib/queries/production";
import type { SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

export default async function PrintProductionOrder({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  await requirePermission("planning:view");
  const { id } = await params;
  const raw = await searchParams;
  const o = await getProductionOrder(id);
  if (!o) notFound();
  return (
    <main className="mx-auto max-w-[900px] bg-white p-6 text-zinc-900 print:p-0">
      <div className="mb-4 flex items-start justify-between gap-3 print:mb-3">
        <div>
          <h1 className="text-xl font-bold">Bảng chốt số lượng đặt hàng · {o.code}</h1>
          <p className="text-sm text-zinc-600">{o.productCode ? `${o.productCode} · ` : ""}{o.productName} · {new Date(o.createdAt).toLocaleDateString("vi-VN")}{o.supplier ? ` · Xưởng: ${o.supplier}` : ""}</p>
        </div>
        <PrintButton auto={raw.auto === "1"} />
      </div>
      <ProductionSheet data={o} />
    </main>
  );
}
