import { Suspense } from "react";
import { DataFreshnessStrip } from "@/app/(dashboard)/data-freshness";
import { CareReportSection } from "@/app/(dashboard)/shipments/care-report";
import { RescueReportSection } from "@/app/(dashboard)/shipments/rescue-report";
import { ShipmentsTable } from "@/app/(dashboard)/shipments/shipments-table";
import { CareWorkbenchView } from "@/app/(dashboard)/shipments/workbench";
import { ReconcilePanel } from "@/app/(dashboard)/shipments/reconcile-panel";
import { CaseOutcomeReport } from "@/app/(dashboard)/shipments/case-outcome-report";
import { PERIOD_BASES, PERIOD_BASIS_LABEL, type PeriodBasis } from "@/lib/constants/care-effect";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { InfoHint } from "@/components/info-hint";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavLink } from "@/components/nav-progress";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { Skeleton } from "@/components/ui/skeleton";
import { assignableUsers } from "@/lib/actions/alerts";
import { can, type SessionUser } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";
import { CARE_VIEWS, CARE_VIEW_HINT, CARE_VIEW_LABEL, type CareView } from "@/lib/constants/care";
import { RESOLUTION_NOTES_DEFAULT, type CareDecision } from "@/lib/constants/care-resolution";
import type { CareNotePreset } from "@/lib/constants/care";
import { formatNumber, formatVND } from "@/lib/format";
import { getCareNotePresets, getCareWorkbench, getResolutionNotePresets } from "@/lib/queries/care-workbench";
import { listShipments, shipmentFacets, shipmentSummary, SHIPMENT_SORTABLE } from "@/lib/queries/shipments";
import { productCodesOfShipments, variantIdsOfCodes } from "@/lib/queries/product-code";
import { getVtpReconcileQueue } from "@/lib/queries/vtp-reconcile-queue";
import { getFreshnessConfig } from "@/lib/queries/logistics-config";
import { effectiveThresholdFor, FRESHNESS_BY_STAGE } from "@/lib/constants/logistics-freshness";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import type { ShipmentStage } from "@/db/schema";
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
  const { user, decision } = await requireResource("SHIPMENTS", "shipments:view");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE") return <ScopeDenied title="Vận đơn" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const viewRaw = typeof raw.view === "string" ? raw.view : "care";
  const view: CareView | "report" | "reconcile" =
    viewRaw === "report" ? "report" : viewRaw === "reconcile" ? "reconcile" : (CARE_VIEWS as readonly string[]).includes(viewRaw) ? (viewRaw as CareView) : "care";
  const ngoaiCare = view === "all" || view === "report" || view === "reconcile";
  const basisRaw = typeof raw.basis === "string" ? raw.basis : "";
  const basis: PeriodBasis = (PERIOD_BASES as readonly string[]).includes(basisRaw) ? (basisRaw as PeriodBasis) : "CASE_OPENED_AT";

  const [wb, staff, presets, resolutionPresets]: [Awaited<ReturnType<typeof getCareWorkbench>> | null, { id: string; name: string }[], CareNotePreset[], Record<CareDecision, string[]>] = ngoaiCare
    ? [null, [], [], RESOLUTION_NOTES_DEFAULT]
    : await Promise.all([getCareWorkbench(), assignableUsers(), getCareNotePresets(), getResolutionNotePresets()]);
  const counts = wb?.counts ?? (ngoaiCare ? (await getCareWorkbench()).counts : { care: 0, waiting: 0, escalated: 0, done: 0 });

  const tab = (key: CareView | "report" | "reconcile", label: string, count?: number) => (
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
            {/*
              ĐƯỜNG CỨU PHẢI Ở NGAY CHỖ NGƯỜI TA PHÁT HIỆN RA VẤN ĐỀ.

              Tài khoản API Viettel Post không đọc được vận đơn do Pancake tạo, nên khi webhook rơi
              thì nhập tệp là cách duy nhất vá lại trạng thái. Trang nhập đã có sẵn (`/import-vtp`)
              nhưng chỉ vào được từ trang Đối soát COD — tức là từ chiều TIỀN, trong khi người phát
              hiện trạng thái sai đang đứng ở chiều GIAO HÀNG.
            */}
            <Button asChild variant="outline" size="sm">
              <NavLink href="/import-vtp">
                <FileUp className="size-4" /> Nhập trạng thái từ tệp VTP
              </NavLink>
            </Button>
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
        <InfoHint>
          {view === "report"
            ? "Báo cáo hiệu quả care theo kỳ: kết cục kiện, SLA, tiền cứu được, theo nhân viên."
            : view === "reconcile"
              ? "Kiện mà ERP đang có lý do để nghi ngờ chính mình: ĐVVC nói một câu chưa dịch được, webhook đã rơi, dữ liệu tự mâu thuẫn, hoặc im lặng quá ngưỡng của chặng. Câu hỏi ở đây là “ERP có đang tin một điều không còn đúng không”, khác hẳn câu hỏi của hàng đợi care."
              : CARE_VIEW_HINT[view]}
        </InfoHint>
        <span className="ml-auto flex items-center gap-1">
          {tab("reconcile", "VTP cần đối chiếu")}
          {tab("report", "Hiệu quả care")}
        </span>
      </div>

      {view === "report" ? (
        <>
          <DataTableToolbar period={{ defaultKey: "30d" }} resultLabel="Kết cục tính theo chứng từ Viettel Post; can thiệp tính theo hành động care của người. Tỷ lệ cứu đơn đọc theo NGÀY CHỐT kết quả, khối lượng việc đọc theo NGÀY MỞ ca." />
          {/*
            HAI KHỐI, HAI CÂU HỎI. Khối cứu đơn trả lời "đội có cứu được đơn không" theo CHỨNG TỪ
            ĐVVC; khối hiệu quả care cũ trả lời "đội đã chạm vào bao nhiêu kiện". Cái trên đứng
            trước vì nó là thứ ra quyết định được.
          */}
          {/*
            KỲ LỌC THEO MỐC NÀO là một lựa chọn, không phải một mặc định ẩn. "30 ngày gần đây" của
            ca MỞ RA và của ca CHỐT KẾT QUẢ là hai tập ca khác nhau — nút này để người đọc chọn, và
            màn hình in ra mốc đang dùng.
          */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">Kỳ lọc</span>
            {PERIOD_BASES.map((b) => (
              <NavLink
                key={b}
                href={`/shipments?view=report&basis=${b}`}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  basis === b ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {PERIOD_BASIS_LABEL[b]}
              </NavLink>
            ))}
          </div>
          <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
            <CaseOutcomeReport period={resolvePeriod(raw, "30d")} basis={basis} />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
            <RescueReportSection period={resolvePeriod(raw, "30d")} />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
            <CareReportSection period={resolvePeriod(raw, "30d")} />
          </Suspense>
        </>
      ) : view === "reconcile" ? (
        <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
          <ReconcileSection canAdmin={can(user, "work:admin")} />
        </Suspense>
      ) : view === "all" ? (
        <AllShipments raw={raw} user={user} />
      ) : (
        <CareWorkbenchView initial={wb!} view={view} staff={staff} presets={presets} resolutionPresets={resolutionPresets} canManage={can(user, "shipments:manage")} />
      )}
    </div>
  );
}

/**
 * Hàng đợi đối chiếu KHÔNG gọi Viettel Post một câu nào — nó dựng từ dữ liệu đã có. Đúng ra là
 * ngược lại: nó tồn tại chính vì tài khoản API không đọc được 2.138/2.151 vận đơn của shop.
 */
async function ReconcileSection({ canAdmin }: { canAdmin: boolean }) {
  const [queue, ghiDe] = await Promise.all([getVtpReconcileQueue(), getFreshnessConfig()]);
  // Ngưỡng ĐANG CHẠY dựng lại từ hằng số + ghi đè, không gõ lại con số nào: hai nơi nói hai số là
  // cách chắc chắn nhất để không ai tin con số nào (luật 22).
  const nguong = Object.keys(FRESHNESS_BY_STAGE).map((stage) => ({
    stage,
    label: SHIPMENT_STAGE_LABEL[stage as ShipmentStage] ?? stage,
    hieuLuc: effectiveThresholdFor(stage, ghiDe),
    macDinh: FRESHNESS_BY_STAGE[stage],
    daGhiDe: Boolean(ghiDe[stage]),
  }));
  return <ReconcilePanel queue={queue} nguong={nguong} canAdmin={canAdmin} />;
}

async function AllShipments({ raw, user }: { raw: SearchParams; user: SessionUser }) {
  /*
    MỌI bộ lọc nằm trong query param và được áp Ở MÁY CHỦ. Không tải cả kho về rồi lọc ở trình
    duyệt: tải lại trang là mất bộ lọc, sao chép đường dẫn cho người khác thì ra kết quả khác, và
    với vài nghìn vận đơn thì trình duyệt phải gánh thứ mà CSDL làm bằng một chỉ mục.
  */
  const params = parseListParams(raw, {
    defaultSort: "createdAt",
    filterKeys: ["product", "stage", "carrierState", "care", "carrier", "cod", "owner", "source", "final", "linked"],
    sortable: SHIPMENT_SORTABLE,
    defaultPeriod: "30d",
  });
  const [{ rows, total, pageCount }, facets, summary, staff] = await Promise.all([listShipments(params), shipmentFacets(params), shipmentSummary(params), assignableUsers()]);
  const productCodes = await productCodesOfShipments(rows.map((r) => r.id));
  const maKhongTonTai = params.filters.product?.length ? (await variantIdsOfCodes(params.filters.product)).unknown : [];

  return (
    <>
      <DataTableToolbar
        searchPlaceholder="Mã vận đơn, mã VTP, SĐT, tên người nhận, mã đơn…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "product", label: "Mã hàng", options: facets.products },
          { key: "stage", label: "Trạng thái VTP", options: facets.stages },
          /* Chiều ĐVVC ở mức CHI TIẾT: "chờ phát lại" và "tồn - khách nghỉ" là hai việc khác nhau
             nhưng `stage` gộp cả hai thành một nhãn. Cùng nguồn với module chăm sóc và báo cáo. */
          { key: "carrierState", label: "ĐVVC báo", options: facets.carrierStates },
          { key: "care", label: "Xử lý", options: facets.careStatuses },
          { key: "carrier", label: "ĐVVC", options: facets.carriers },
          { key: "cod", label: "COD", options: facets.codStatuses },
          { key: "owner", label: "Người xử lý", options: facets.owners },
          { key: "source", label: "Nguồn đơn", options: facets.sources },
          { key: "final", label: "Theo dõi", options: facets.finals, single: true },
          { key: "linked", label: "Kênh", options: facets.linked, single: true },
        ]}
        resultLabel={`${formatNumber(total)} vận đơn phù hợp · ${formatNumber(summary.delivered)} giao thành công · ${formatNumber(summary.returning)} hoàn / không thu được tiền · COD chưa thu ${formatVND(summary.codPending, { compact: true })}`}
      />
      {maKhongTonTai.length ? (
        // Mã không có trong danh mục ⇒ 0 dòng là ĐÚNG. Nói ra, thay vì để người dùng tưởng lọc hỏng.
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          Không có mã hàng {maKhongTonTai.join(", ")} trong danh mục sản phẩm — nên danh sách trống. Mã hàng lấy từ ô &ldquo;Mã hàng&rdquo;, không gõ vào ô tìm kiếm.
        </p>
      ) : null}
      <ShipmentsTable rows={rows} pageCount={pageCount} total={total} productCodes={Object.fromEntries(productCodes)} staff={staff} canManage={can(user, "shipments:manage")} />
    </>
  );
}
