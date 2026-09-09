import { ClipboardCheck, PackageX, Timer } from "lucide-react";
import Link from "next/link";
import { InspectionRow } from "@/app/(dashboard)/inventory/returns/inspection-row";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { inspectionSummary, listPendingInspections } from "@/lib/returns/inspection";
import { pendingReturnedForWarehouse } from "@/lib/returns/warehouse";

export const metadata = { title: "Kiểm đếm hàng hoàn" };

/**
 * MÀN HÌNH ĐẾM HÀNG HOÀN.
 *
 * Vì sao tách khỏi màn "xác nhận về kho": nhận hàng và đếm hàng là hai việc của hai lúc khác nhau.
 * Gộp lại thì người nhận hàng vô tình quyết định luôn số tồn — và ERP tin một con số chưa ai đếm.
 */
export default async function ReturnInspectionPage() {
  const user = await requirePermission("products:view");
  const canWrite = can(user, "inventory:write");
  const [summary, pending, notArrived] = await Promise.all([inspectionSummary(), listPendingInspections(200), pendingReturnedForWarehouse()]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Kiểm đếm hàng hoàn"
        description="Hàng hoàn CHỈ vào lại tồn khi có người đếm thực tế. Ghi nhận kiện đã về là một việc; đếm được bao nhiêu món còn bán được là việc khác."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Chờ đếm"
          value={formatNumber(summary.pending)}
          note={`${formatNumber(summary.pendingItems)} món đang không được tính vào tồn`}
          icon={ClipboardCheck}
          tone={summary.pending ? "amber" : "green"}
        />
        <MetricCard label="Chờ quá 3 ngày" value={formatNumber(summary.stale)} note="Hàng nằm trong kho mà sổ vẫn chưa biết" icon={Timer} tone={summary.stale ? "rose" : "green"} />
        <MetricCard label="Đã đếm" value={formatNumber(summary.inspected)} note={`${formatNumber(summary.restockedQty)} món đã vào lại tồn`} icon={ClipboardCheck} tone="green" />
        <MetricCard label="Không bán được" value={formatNumber(summary.unsellableQty)} note="Hàng về nhưng hỏng / thiếu — phần hao thật" icon={PackageX} tone={summary.unsellableQty ? "amber" : "slate"} />
      </div>

      {notArrived.count ? (
        <p className="text-sm text-muted-foreground">
          Còn {formatNumber(notArrived.count)} kiện Viettel Post đã trả về shop mà chưa ai ghi nhận đã nhận —{" "}
          <Link href="/data-quality?issue=return-not-received" className="font-medium text-primary hover:underline">
            ghi nhận đã về kho
          </Link>{" "}
          trước rồi mới đếm được.
        </p>
      ) : null}

      <SectionCard
        title="Kiện đã về, chờ đếm"
        description="Cũ nhất trước. Số ở ô “còn bán được” mặc định bằng số ERP đã xuất — sửa lại theo đúng số đếm được rồi bấm xác nhận."
        padded={false}
      >
        {!pending.length ? (
          <EmptyState title="Không còn kiện nào chờ đếm" description="Mọi kiện hàng hoàn đã ghi nhận đều đã được kiểm đếm." className="m-4" />
        ) : !canWrite ? (
          <EmptyState title={`${pending.length} kiện đang chờ đếm`} description="Bạn không có quyền cập nhật kho nên chỉ xem được danh sách." className="m-4" />
        ) : (
          <div>
            {pending.map((row) => (
              <InspectionRow
                key={row.shipmentId}
                shipmentId={row.shipmentId}
                code={row.code ?? row.shipmentId}
                expectedQty={row.expectedQty}
                ageDays={row.ageDays}
                receivedBy={row.receivedBy}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
