import { Suspense } from "react";
import { DataFreshnessStrip } from "@/app/(dashboard)/data-freshness";
import { CareReportSection } from "@/app/(dashboard)/shipments/care-report";
import { ShipmentsTable } from "@/app/(dashboard)/shipments/shipments-table";
import { CareWorkbenchView } from "@/app/(dashboard)/shipments/workbench";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { InfoHint } from "@/components/info-hint";
import { NavLink } from "@/components/nav-progress";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { Skeleton } from "@/components/ui/skeleton";
import { assignableUsers } from "@/lib/actions/alerts";
import { can, requirePermission } from "@/lib/auth/session";
import { CARE_VIEWS, CARE_VIEW_HINT, CARE_VIEW_LABEL, type CareView } from "@/lib/constants/care";
import { formatNumber, formatVND } from "@/lib/format";
import { getCareWorkbench } from "@/lib/queries/care-workbench";
import { listShipments, shipmentFacets, shipmentSummary, SHIPMENT_SORTABLE } from "@/lib/queries/shipments";
import { parseListParams, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Vận đơn & care" };

/**
 * ═══════════ VẬN ĐƠN & CARE = BÀN LÀM VIỆC, KHÔNG PHẢI TRANG LIỆT KÊ ═══════════
 *
 * Mặc định mở "Cần care": chỉ kiện đang cần người. Vận đơn bình thường tra ở "Tất cả vận đơn".
 * Năm tab một hàng, chữ giải thích nằm trong ⓘ.
 */
export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("shipments:view");
  const raw = await searchParams;
  const viewRaw = typeof raw.view === "string" ? raw.view : "care";
  const view: CareView | "report" = viewRaw === "report" ? "report" : (CARE_VIEWS as readonly string[]).includes(viewRaw) ? (viewRaw as CareView) : "care";

  const [wb, staff] = view === "all" || view === "report" ? [null, []] : await Promise.all([getCareWorkbench(), assignableUsers()]);
  const counts = wb?.counts ?? (view === "all" || view === "report" ? (await getCareWorkbench()).counts : { care: 0, waiting: 0, escalated: 0, done: 0 });

  const tab = (key: CareView | "report", label: string, count?: number) => (
    <NavLink
      href={key === "care" ? "/shipments" : `/shipments?view=${key}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
        view === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined ? <span className={cn("numeric rounded px-1 text-[10.5px]", view === key ? "bg-muted" : "bg-muted/60")}>{formatNumber(count)}</span> : null}
    </NavLink>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Giao vận"
        title="Vận đơn & care"
        hint="Chiều ĐVVC (Viettel Post báo gì) và chiều care (đội đã làm tới đâu) là hai cột riêng, không suy ra lẫn nhau. Kiện rời hàng đợi khi điều kiện cần care hết; lịch sử giữ nguyên trong ngăn kéo và nhật ký."
        description={wb ? `${formatNumber(wb.counts.care)} kiện cần care · COD treo ${formatVND(wb.moneyAtRisk, { compact: true })} · ${formatNumber(wb.overdue)} vỡ SLA · ${formatNumber(wb.unassigned)} chưa ai nhận` : undefined}
        actions={
          <>
            <SyncButton job="vtp-tracking" label="Cập nhật từ Viettel Post" />
            {view === "all" ? <SyncButton job="vtp-import" label="Nhập từ tài khoản VTP" params={{ days: "30" }} /> : null}
          </>
        }
      />
      <Suspense fallback={null}>
        <DataFreshnessStrip />
      </Suspense>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {tab("care", CARE_VIEW_LABEL.care, counts.care)}
          {tab("waiting", CARE_VIEW_LABEL.waiting, counts.waiting)}
          {tab("escalated", CARE_VIEW_LABEL.escalated, counts.escalated)}
          {tab("done", CARE_VIEW_LABEL.done, counts.done)}
          {tab("all", CARE_VIEW_LABEL.all)}
        </div>
        <InfoHint>{view === "report" ? "Báo cáo hiệu quả care theo kỳ: kết cục kiện, SLA, tiền cứu được, theo nhân viên." : CARE_VIEW_HINT[view]}</InfoHint>
        <span className="ml-auto">{tab("report", "Hiệu quả care")}</span>
      </div>

      {view === "report" ? (
        <>
          <DataTableToolbar period={{ defaultKey: "30d" }} resultLabel="Kết cục tính theo chứng từ Viettel Post; can thiệp tính theo hành động care của người." />
          <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
            <CareReportSection period={resolvePeriod(raw, "30d")} />
          </Suspense>
        </>
      ) : view === "all" ? (
        <AllShipments raw={raw} />
      ) : (
        <CareWorkbenchView initial={wb!} view={view} staff={staff} canManage={can(user, "shipments:manage")} />
      )}
    </div>
  );
}

async function AllShipments({ raw }: { raw: SearchParams }) {
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["stage", "carrier", "cod", "final", "linked"], sortable: SHIPMENT_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listShipments(params), shipmentFacets(params), shipmentSummary(params)]);
  return (
    <>
      <DataTableToolbar
        searchPlaceholder="Mã vận đơn, mã VTP, SĐT, tên người nhận, mã đơn…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "stage", label: "Trạng thái VTP", options: facets.stages },
          { key: "carrier", label: "ĐVVC", options: facets.carriers },
          { key: "cod", label: "COD", options: facets.codStatuses },
          { key: "final", label: "Theo dõi", options: facets.finals, single: true },
          { key: "linked", label: "Nguồn đơn", options: facets.linked, single: true },
        ]}
        resultLabel={`${formatNumber(total)} vận đơn phù hợp · ${formatNumber(summary.delivered)} giao thành công · ${formatNumber(summary.returning)} hoàn / không thu được tiền · COD chưa thu ${formatVND(summary.codPending, { compact: true })}`}
      />
      <ShipmentsTable rows={rows} pageCount={pageCount} total={total} />
    </>
  );
}
