import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderActions } from "@/app/(dashboard)/inventory/planning/orders/[id]/order-actions";
import { PageHeader } from "@/components/page-header";
import { ProductionSheet } from "@/components/production-sheet";
import { can, requirePermission } from "@/lib/auth/session";
import { PRODUCTION_STATUS_LABEL, PRODUCTION_STATUS_TONE } from "@/lib/constants/production";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getProductionOrder, matrixAsText } from "@/lib/queries/production";
import { designWarning, diffCells } from "@/lib/constants/production-os";
import { getDesignVersionBrief, requireApprovedDesignFlag } from "@/lib/queries/production-os";
import { cn } from "@/lib/utils";

export default async function ProductionOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("planning:view");
  const { id } = await params;
  const o = await getProductionOrder(id);
  if (!o) notFound();
  const text = matrixAsText(o);
  const [design, requireApprovedDesign] = await Promise.all([getDesignVersionBrief(o.designVersionId), requireApprovedDesignFlag()]);
  const lech = o.suggestedCells ? diffCells(o.suggestedCells.cells, o.cells) : [];
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title={`${o.code} · ${o.productCode ? `${o.productCode} · ` : ""}${o.productName}`}
        /*
          BA MỐC ĐỨNG CẠNH NHAU THÌ ĐỘ TRỄ ĐỌC ĐƯỢC BẰNG MẮT: gửi xưởng → hẹn → nhận thật.
          Lệnh đã nhận từ TRƯỚC bản 23/09/2026 không có mốc nhận, và câu chữ nói thẳng điều đó thay vì
          để trống — trống thì người đọc tưởng chưa nhận (AGENTS.md mục 42).
        */
        description={`${formatNumber(o.totalQty)} sản phẩm${o.unitCost ? ` · ~${formatVND(o.totalQty * o.unitCost)}` : ""} · tạo ${formatDateTime(o.createdAt)} bởi ${o.createdBy}${o.sentAt ? ` · gửi xưởng ${formatDateTime(o.sentAt)}` : ""}${o.dueDate ? ` · hẹn ${formatDateTime(o.dueDate)}` : ""}${o.receivedAt ? ` · KHO NHẬN ${formatDateTime(o.receivedAt)}${o.receivedBy ? ` (${o.receivedBy})` : ""}` : o.status === "RECEIVED" ? " · đã nhận, không có mốc (lệnh cũ)" : ""}`}
        actions={<div className="flex items-center gap-2"><span className={cn("rounded px-2 py-0.5 text-xs font-semibold", PRODUCTION_STATUS_TONE[o.status])}>{PRODUCTION_STATUS_LABEL[o.status]}</span><Link href="/inventory/planning/orders" className="text-sm text-primary hover:underline">Danh sách</Link></div>}
      />
      <OrderActions id={o.id} status={o.status} text={text} canWrite={can(user, "planning:write")} />
      {/* Company OS · Agent C — bản duyệt mà xưởng may theo + gợi ý máy vs số người chốt. */}
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-xl border bg-card p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bản thiết kế đã duyệt</div>
          {design ? (
            <Link href={`/production/models/${design.modelId}`} className="font-medium text-primary hover:underline">
              {design.modelCode} · bản duyệt V{design.version} ({design.approvedBy || "—"}, {formatDateTime(design.approvedAt)})
            </Link>
          ) : (
            <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">{designWarning(requireApprovedDesign)}</p>
          )}
        </div>
        <div className="rounded-xl border bg-card p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Gợi ý của máy vs số chốt</div>
          {o.suggestedCells ? (
            <>
              <p>
                Máy gợi ý {formatNumber(Object.values(o.suggestedCells.cells).reduce((a, b) => a + b, 0))} sp (tính {formatDateTime(o.suggestedCells.computedAt)}, đủ bán {o.suggestedCells.basis.coverDays} ngày) · chốt{" "}
                {formatNumber(o.totalQty)} sp · {lech.length ? `khác ở ${lech.length} ô` : "khớp từng ô"}
              </p>
              {o.overrideReason ? <p className="text-xs text-muted-foreground">Lý do: {o.overrideReason}</p> : null}
            </>
          ) : (
            <p className="text-muted-foreground">— (lệnh lập tay hoặc lập trước khi ERP lưu gợi ý)</p>
          )}
        </div>
      </div>
      <div className="rounded-xl border bg-white p-6 text-zinc-900 shadow-xs">
        <ProductionSheet data={o} />
      </div>
    </div>
  );
}
