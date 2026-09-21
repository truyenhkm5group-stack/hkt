import { AlertTriangle, Download, FlaskConical, PackageCheck, Percent, Truck, Undo2 } from "lucide-react";
import Link from "next/link";
import { ReturnRateTable } from "@/app/(dashboard)/reports/returns/return-rate-table";
import { ActionBoard } from "@/app/(dashboard)/reports/returns/action-board";
import { CarePerformance, ComparePeriod, CoverageStrip, IntelSection, MarketerQualityTable, ProductRiskTable, TrendSection } from "@/app/(dashboard)/reports/returns/intelligence-sections";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { OrderOutcomeBadge, OrderStageBadge } from "@/components/status-badge";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RETURN_RULE, SUCCESS_RATE_OK, successTone } from "@/lib/constants/returns";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getReturnRateBySource, getReturnRateByVariant, getReturnRateSummary, listOrdersForVariant, RETURN_RATE_SORTABLE } from "@/lib/queries/return-rate";
import { ORDER_SOURCE_HINT, ORDER_SOURCE_LABEL, ORDER_SOURCE_TONE } from "@/lib/queries/order-source";
import { logisticsPerformance, SUCCESS_RATE_TERMINAL_LABEL } from "@/lib/queries/logistics";
import { ProjectionConfidence } from "@/app/(dashboard)/reports/projection-confidence";
import { ReturnReasonSection } from "@/app/(dashboard)/reports/returns/reason-section";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { getReturnIntelligence, TREND_GRAINS, type TrendGrain } from "@/lib/queries/return-intelligence";
import { listAttributedMarketers } from "@/lib/queries/order-marketer";
import { listProductCodes } from "@/lib/queries/product-code";
import { MARKETER_UNRESOLVED, MARKETER_UNRESOLVED_LABEL } from "@/lib/constants/marketer-attribution";
import { RETURN_REASONS, RETURN_REASON_GROUPS, type ReturnReason, type ReturnReasonGroup } from "@/lib/constants/return-reason";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { TIME_BASES, TIME_BASIS_LABEL, TIME_BASIS_QUESTION, type TimeBasis } from "@/lib/constants/report-time-basis";
import { CONFIDENCE_LABEL, type ProbabilityConfidence } from "@/lib/constants/projected-delivery";
import { cn } from "@/lib/utils";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";

export const metadata = { title: "Tỷ lệ giao thành công theo mã hàng" };

const MIN_OPTIONS = [
  { value: "1", label: "≥ 1 đơn đã gửi" },
  { value: "5", label: "≥ 5 đơn" },
  { value: "10", label: "≥ 10 đơn" },
  { value: "30", label: "≥ 30 đơn" },
];

/**
 * ═══════════ THỨ TỰ KHỐI LÀ THỨ TỰ RA QUYẾT ĐỊNH ═══════════
 *
 * Chủ shop chốt 14/09/2026:
 *
 *   A. KPI tổng quan → B. GTC THEO MÃ HÀNG → C. GTC theo nguồn đơn → D. Hiệu suất giao vận
 *   → E. Phân tích lý do hoàn → F. Chăm sóc & cứu đơn → G. Cần chú ý
 *
 * Đây KHÔNG phải một lượt đổi DOM. Thứ tự cũ đặt "theo nguồn đơn" trước "theo mã hàng", tức bắt
 * người đọc quyết định về KÊNH trước khi biết SẢN PHẨM nào đang hỏng — trong khi mọi hành động
 * thật (đổi lô vải, sửa bảng size, dừng bán một mã) đều bắt đầu từ mã hàng. Trình tự mới đi đúng
 * đường một quyết định được hình thành: **sản phẩm → kênh → giao vận → nguyên nhân → người → việc**.
 *
 * Khối G đứng CUỐI theo đúng yêu cầu, và có một đường tắt ở đầu trang cho người chỉ cần nó.
 */
export default async function ReturnRatePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { decision } = await requireResource("REPORTS", "reports:returns");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE") return <ScopeDenied title="Tỷ lệ giao thành công" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const params = parseListParams(raw, {
    defaultSort: "successRate",
    defaultDir: "asc",
    filterKeys: ["min", "product", "basis", "group", "reason", "marketer", "trend"],
    sortable: RETURN_RATE_SORTABLE,
    defaultPeriod: "90d",
    defaultPageSize: 50,
  });
  const minShipped = Math.max(1, Number(params.filters.min?.[0] ?? "1") || 1);
  const variantKey = param(raw, "variant");
  /*
    MỐC LỌC LÀ MỘT LỰA CHỌN CÓ TÊN, KHÔNG PHẢI MỘT GIẢ ĐỊNH NGẦM.

    Mặc định `SHIPPED` vì bảng này có cột "Đã gửi" — nó trả lời "lô hàng gửi trong khoảng này đi
    tới đâu rồi". Người muốn hỏi câu khác ("đơn chốt tuần này ra sao") đổi sang `ORDERED`, và màn
    hình nói rõ đang ở mốc nào.
  */
  const basis: TimeBasis = TIME_BASES.includes((params.filters.basis?.[0] ?? "") as TimeBasis) ? (params.filters.basis![0] as TimeBasis) : "SHIPPED";
  const codes = params.filters.product?.length ? params.filters.product : undefined;
  const marketerIds = params.filters.marketer?.length ? params.filters.marketer : undefined;
  const trendGrain: TrendGrain = TREND_GRAINS.includes((params.filters.trend?.[0] ?? "") as TrendGrain) ? (params.filters.trend![0] as TrendGrain) : "DAY";
  /*
    ═══ DRILLDOWN BA TẦNG SỐNG TRONG URL ═══

    `group` → `reason` → `pcode`. Ba tham số riêng, không phải một chuỗi ghép, để nút Lùi của
    trình duyệt đi ngược đúng từng tầng và người đọc dán được đường dẫn đúng chỗ mình đang nhìn.
    Giá trị lạ bị bỏ về `null` chứ không làm sập trang — URL là đầu vào của người ngoài.
  */
  const openReason = (RETURN_REASONS as readonly string[]).includes(params.filters.reason?.[0] ?? "") ? (params.filters.reason![0] as ReturnReason) : null;
  const openGroup = (RETURN_REASON_GROUPS as readonly string[]).includes(params.filters.group?.[0] ?? "") ? (params.filters.group![0] as ReturnReasonGroup) : null;
  const openProduct = (param(raw, "pcode") || "").trim() || null;

  /*
    ═══ KỲ TRƯỚC CÙNG ĐỘ DÀI — TÍNH MỘT LẦN, DÙNG CHO MỌI PHÉP SO ═══

    Chỉ có kỳ trước khi kỳ hiện tại CÓ CẢ HAI ĐẦU MỐC. Xem "tất cả" thì không có gì để so, và bịa
    ra một "kỳ trước" cho nó là bịa ra một mũi tên xu hướng.
  */
  const previous =
    params.period.from && params.period.to
      ? (() => {
          const doDai = params.period.to.getTime() - params.period.from.getTime();
          return { from: new Date(params.period.from.getTime() - doDai - 1), to: new Date(params.period.from.getTime() - 1) };
        })()
      : null;

  const reasonFilter = { period: params.period, basis, codes, marketerIds };

  const [{ rows, total, pageCount, all, productRows, projectionError: loiBang }, summary, variantOrders, theoNguon, reasonReport, danhMucMa, danhSachMarketer] = await Promise.all([
    getReturnRateByVariant({ period: params.period, basis, q: params.q, minShipped, sort: params.sort, dir: params.dir, page: params.page, pageSize: params.pageSize }),
    getReturnRateSummary(params.period, params.q, basis),
    variantKey ? listOrdersForVariant(variantKey, params.period) : Promise.resolve([]),
    getReturnRateBySource(params.period, params.q),
    getReturnReasonReport(reasonFilter),
    listProductCodes(),
    listAttributedMarketers(),
  ]);

  // Tầng quyết định dùng LẠI báo cáo lý do vừa dựng — không dựng lần thứ hai cho cùng một tập ca.
  const [logistics, intel] = await Promise.all([
    logisticsPerformance(params.period),
    getReturnIntelligence({ period: params.period, previous, basis, codes, marketerIds, trendGrain, reasonReport }),
  ]);

  const selected = variantKey ? all.find((r) => r.key === variantKey) : null;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "variant" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
  }
  const baseQuery = qs.toString();
  /** Giữ nguyên mọi bộ lọc đang bật, chỉ đổi những tham số truyền vào. `null` = xoá tham số đó. */
  const hrefWith = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams(qs.toString());
    p.delete("variant");
    for (const [k, v] of Object.entries(extra)) {
      p.delete(k);
      if (v !== null) p.set(k, v);
    }
    const s = p.toString();
    return `/reports/returns${s ? `?${s}` : ""}`;
  };
  const exportQuery = new URLSearchParams({
    period: params.period.key,
    q: params.q,
    min: String(minShipped),
    ...(params.period.key === "custom" ? { from: params.period.fromKey ?? "", to: params.period.toKey ?? "" } : {}),
  }).toString();

  const worst = all.filter((r) => r.successRate !== null && r.shipped >= 5).sort((a, b) => (a.successRate ?? 0) - (b.successRate ?? 0))[0];

  /*
    ═══ CHÚ THÍCH PHẢI MÔ TẢ ĐÚNG CÔNG THỨC ĐANG CHẠY ═══

    Chú thích cũ ở đây viết: "Dự kiến X% khi N đơn chờ phát lại kết thúc (xác suất thành hoàn P%)".
    Câu đó mô tả công thức CŨ — chỉ cân nhóm "chờ phát lại" bằng MỘT xác suất của cả shop, bỏ qua
    mọi đơn đang chạy khác. Con số nay đến từ `PROJECTED_GTC_V3`: MỌI đơn chưa có kết cục đều được
    cân theo xác suất CỦA CHÍNH trạng thái ĐVVC nó đang ở, điều kiện hoá theo mã hàng và tuổi kiện
    khi đủ mẫu. Giữ nguyên câu cũ thì màn hình đang khai sai nguồn của chính con số nó in ra.

    Và khi mô hình chưa dự báo được đơn nào thì in "chưa đo được", KHÔNG in 0%.
  */
  const pj = summary.projection;
  const loiUocTinh = summary.projectionError ?? loiBang;
  const duKienNote = loiUocTinh
    ? `Giao TC / (giao TC + không TC) · LỖI khi tính ước tính: ${loiUocTinh}`
    : summary.expectedSuccessRate === null || pj === null
      ? `Giao TC / (giao TC + không TC) · chưa đo được phần đang giao${pj ? ` (${formatNumber(pj.unmodelledActive)}/${formatNumber(pj.active)} đơn ở trạng thái chưa đủ mẫu — ngoài ước tính)` : ""}`
      : `Ước tính ${summary.expectedSuccessRate.toFixed(1)}% khi ${formatNumber(pj.active)} đơn đang giao kết thúc — mỗi đơn cân theo xác suất của chính trạng thái ĐVVC nó đang ở (${pj.version}, mốc ${TIME_BASIS_LABEL[basis].toLowerCase()}, học từ kiện gửi trước ≥ ${pj.maturityDays} ngày${pj.maturitySource === "MEASURED" ? " — đo từ đơn hoàn thật" : " — mặc định"})${pj.unmodelledActive ? ` · ${formatNumber(pj.unmodelledActive)} đơn ngoài ước tính` : ""}`;

  const probabilities = (pj?.byState ?? []).map((x) => ({ substate: x.substate, label: x.label, p: x.p, sample: x.sample, confidence: x.confidence }));

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Tài chính"
        title="Tỷ lệ giao thành công theo mã hàng"
        description={`${params.period.label} · ${formatNumber(summary.shipped)} đơn đã gửi · ${formatNumber(summary.delivered)} giao thành công (COD thực > ${formatVND(RETURN_RULE.maxCodForFakeDelivery, { compact: true })}) · ${formatNumber(summary.returned)} không thành công`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {intel.actions.length ? (
              <Button asChild variant="outline" size="sm">
                <Link href="#can-chu-y">
                  <AlertTriangle className="size-4" /> {intel.actions.length} việc cần chú ý
                </Link>
              </Button>
            ) : null}
            {/* Tỷ lệ giao thành công là đòn bẩy lợi nhuận mạnh nhất — mở thẳng sang chỗ tính thử */}
            <Button asChild variant="outline" size="sm">
              <Link href="/reports/scenario">
                <FlaskConical className="size-4" /> Mô phỏng kịch bản
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/return-rate?${exportQuery}`}>
                <Download className="size-4" /> Xuất CSV
              </a>
            </Button>
          </div>
        }
      />

      {/* ═════════ BỘ LỌC CHUNG — MỘT CHỖ, ÁP CHO MỌI KHỐI BÊN DƯỚI ═════════ */}
      <DataTableToolbar
        searchPlaceholder="SKU, tên sản phẩm, màu/size…"
        period={{ defaultKey: "90d" }}
        facets={[
          { key: "min", label: "Tối thiểu", options: MIN_OPTIONS, single: true },
          {
            // MỐC LỌC LÀ MỘT BỘ LỌC THẬT, không phải một dòng chữ chỉ để đọc: đổi được ngay tại chỗ.
            key: "basis",
            label: "Mốc thời gian",
            options: TIME_BASES.map((b) => ({ value: b, label: TIME_BASIS_LABEL[b] })),
            single: true,
          },
          { key: "product", label: "Mã hàng", options: danhMucMa.map((p) => ({ value: p.code, label: `${p.code} · ${p.name}` })) },
          {
            key: "marketer",
            label: "Marketer",
            // "Chưa xác định" là một lựa chọn HỢP LỆ và thường là nhóm cần đi lấp dữ liệu nhất.
            options: [...danhSachMarketer.map((m) => ({ value: m.id, label: m.label })), { value: MARKETER_UNRESOLVED, label: MARKETER_UNRESOLVED_LABEL }],
          },
          { key: "trend", label: "Xu hướng theo", options: [{ value: "DAY", label: "Ngày" }, { value: "WEEK", label: "Tuần" }], single: true },
        ]}
        resultLabel={`${formatNumber(total)} mã hàng · bấm vào một dòng để xem danh sách đơn`}
      />

      {/*
        ĐANG LỌC THEO MỐC NÀO — NÓI THẲNG, KHÔNG ĐỂ ĐOÁN.

        Đây là dòng sửa một cái bẫy có thật: bảng có cột "Đã gửi" nhưng trước bản 13/09 lọc theo
        NGÀY TẠO ĐƠN. Đo production: 73,6% vận đơn có hai mốc rơi vào hai ngày khác nhau, lệch
        trung bình 4,5 ngày. Người đọc thấy chữ "đã gửi" và tin rằng đang xem lô hàng gửi tuần này.
      */}
      <p className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">Đang tính theo: {TIME_BASIS_LABEL[basis]}</span>
        <span title={TIME_BASIS_QUESTION[basis]}>{TIME_BASIS_QUESTION[basis]}</span>
        {codes?.length ? <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">Mã hàng: {codes.join(", ")}</span> : null}
        {marketerIds?.length ? <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">Marketer: {marketerIds.length} người</span> : null}
      </p>

      {/* ═════════ A. KPI TỔNG QUAN ═════════ */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Đơn đã gửi"
          hint="Đơn lên trong kỳ đã bàn giao đơn vị vận chuyển. Đơn chờ xử lý chưa gửi và đơn huỷ không nằm trong tử số lẫn mẫu số của tỷ lệ giao thành công."
          value={formatNumber(summary.shipped)}
          note={`${formatNumber(summary.inTransit)} chưa kết thúc (trong đó ${formatNumber(summary.failed)} chờ phát lại) · ${formatNumber(summary.pending)} chờ xử lý chưa gửi · ${formatNumber(summary.cancelled)} huỷ (không tính)`}
          icon={Truck}
          tone="blue"
        />
        <MetricCard
          label="Giao thành công"
          hint={
            <>
              Lấy theo <b>trạng thái Viettel Post</b>, đúng bảng mã webhook chính thức. Sáu mã là trạng thái cuối:
              <b> 501</b> phát thành công (cờ IS_RETURNING = false) là giao thành công; <b>501</b> của chiều hoàn,
              <b> 504</b> chuyển trả người gửi, <b>503</b> tiêu huỷ là không thành công; <b>101/107/201</b> là huỷ. Chưa có mã cuối thì lấy trạng thái mới nhất theo mốc thời gian của Viettel Post. Đã giao mà
              Viettel Post tạo vận đơn chiều hoàn, hoặc doanh thu bị sửa sau khi giao, thì tính là hoàn. Khi đã biết chắc số tiền: dưới 50K là hoàn, 50K–100K là không thành công.
              <br />
              <b>Giao thành công là kết luận GIAO HÀNG, không phải kết luận tiền</b> — tiền chỉ ghi nhận khi có chứng từ ở Đối soát COD.
            </>
          }
          value={formatNumber(summary.delivered)}
          note={`Đơn có doanh thu COD thực > ${formatVND(RETURN_RULE.maxCodForFakeDelivery, { compact: true })} (tiền thực thu / đã về; hoặc đã chuyển khoản trước)`}
          icon={PackageCheck}
          tone="green"
        />
        <MetricCard
          label="Không thành công (hoàn)"
          value={formatNumber(summary.returned)}
          note={`${formatNumber(summary.returnedByRule)} vận đơn “giao thành công” nhưng COD ≤ ${formatVND(RETURN_RULE.maxCodForFakeDelivery, { compact: true })} (khách chỉ trả tiền ship) · mất ${formatVND(summary.lostRevenue, { compact: true })}`}
          icon={Undo2}
          tone="rose"
        />
        <MetricCard
          label="Tỷ lệ giao thành công"
          hint={`Thực tế = giao thành công ÷ (giao thành công + không thành công) theo ORDER_OUTCOME — đơn đang giao KHÔNG ở mẫu số. Ước tính (${pj?.version ?? "hợp đồng chung"}) = (đã giao thật + Σ đơn đang giao × xác suất giao được của trạng thái ĐVVC nó đang ở) ÷ (đã gửi − đơn ngoài ước tính). Cùng hợp đồng với thẻ cùng tên ở Báo cáo lợi nhuận; khác mốc thời gian thì khác cohort. Nhãn tin cậy đến từ thử ngược trên vận đơn đã kết thúc.`}
          value={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className={successTone(summary.successRate)}>{summary.successRate === null ? "—" : `${summary.successRate.toFixed(1)}%`}</span>
              {pj ? (
                <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground" title="Tỷ lệ giao thành công ƯỚC TÍNH khi đơn đang giao kết thúc">
                  → ước tính <span className={successTone(summary.expectedSuccessRate)}>{summary.expectedSuccessRate === null ? "—" : `${summary.expectedSuccessRate.toFixed(1)}%`}</span>
                  <ProjectionConfidence backtest={pj.backtest} error={pj.backtestError} />
                </span>
              ) : null}
            </span>
          }
          note={`${duKienNote}${worst ? ` · thấp nhất ${worst.sku || worst.productName} ${(worst.successRate ?? 0).toFixed(1)}%` : ""}`}
          icon={Percent}
          tone={summary.successRate !== null && summary.successRate < SUCCESS_RATE_OK ? "rose" : summary.successRate !== null ? "green" : "slate"}
        />
      </section>

      {/* ĐỘ PHỦ DỮ LIỆU ĐỨNG NGAY DƯỚI KPI: mọi con số bên dưới chỉ đúng bằng phần dữ liệu đã thu. */}
      <CoverageStrip coverage={intel.coverage} />

      {loiUocTinh ? (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-[13px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <b>Mô hình ước tính không chạy được</b> — đây là LỖI, không phải thiếu dữ liệu. Các ô ước tính trên trang đang trống vì thế. Chi tiết: <code className="text-xs">{loiUocTinh}</code>
          </span>
        </div>
      ) : null}

      {summary.finishedNoVtp > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            <b>{formatNumber(summary.finishedNoVtp)}</b> / {formatNumber(summary.delivered + summary.returned)} đơn giao / hoàn trong kỳ <b>chưa có trạng thái Viettel Post thật</b> (đang tính theo trạng
            thái Pancake vì tài khoản API Viettel Post không tra được vận đơn tạo qua Pancake). Đơn giao thành công đã được tính theo <b>COD thực thu &gt; 100K</b> nên không phụ thuộc trạng thái này.
          </span>
          <Button asChild size="sm" variant="outline" className="ml-auto">
            <Link href="/cod?import=orders">Nhập danh sách vận đơn VTP</Link>
          </Button>
        </div>
      ) : null}

      {/* ═════════ B. GTC THEO MÃ HÀNG ═════════ */}
      <ReturnRateTable rows={rows} productRows={productRows} pageCount={pageCount} total={total} baseQuery={baseQuery} probabilities={probabilities} />

      {variantKey ? (
        <div id="chi-tiet">
          <SectionCard
            title={selected ? `Đơn của ${selected.sku || selected.productName}${selected.variationDetail ? ` · ${selected.variationDetail}` : ""}` : "Đơn của mã hàng đã chọn"}
            description={
              selected
                ? `${formatNumber(selected.delivered)} giao thành công · ${formatNumber(selected.returned)} không thành công · ${formatNumber(selected.inTransit)} chưa kết thúc · ${params.period.label.toLowerCase()} (tối đa 300 đơn, đơn không thành công xếp trước)`
                : undefined
            }
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href={`/reports/returns${baseQuery ? `?${baseQuery}` : ""}`}>Đóng</Link>
              </Button>
            }
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Đơn</TableHead>
                    <TableHead>Khách</TableHead>
                    <TableHead>Trạng thái Pancake</TableHead>
                    <TableHead>Kết quả</TableHead>
                    <TableHead className="text-right">SL</TableHead>
                    <TableHead className="text-right">COD</TableHead>
                    <TableHead className="text-right">Cước</TableHead>
                    <TableHead>Vận đơn</TableHead>
                    <TableHead>Ngày lên</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variantOrders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                        Không có đơn nào trong kỳ.
                      </TableCell>
                    </TableRow>
                  ) : (
                    variantOrders.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link href={`/orders/${r.id}`} className="font-semibold hover:text-primary hover:underline">
                            #{r.systemId ?? r.id}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-[160px] truncate">{r.billFullName || "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.billPhone}
                            {r.shipProvince ? ` · ${r.shipProvince}` : ""}
                          </div>
                        </TableCell>
                        <TableCell>
                          <OrderStageBadge stage={r.stage} />
                        </TableCell>
                        <TableCell>
                          <OrderOutcomeBadge outcome={r.outcome} />
                          {r.returnedReason ? <div className="max-w-[200px] truncate text-[11px] text-muted-foreground">{r.returnedReason}</div> : null}
                        </TableCell>
                        <TableCell className="numeric text-right">{r.quantity}</TableCell>
                        <TableCell className="text-right">
                          <Money value={r.cod} className={r.cod ? "" : "text-muted-foreground"} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={r.fee} className={r.fee && r.fee < RETURN_RULE.maxFeeForFakeDelivery ? "font-semibold text-orange-600" : r.fee ? "" : "text-muted-foreground"} />
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.vtpOrderNumber ?? "—"}
                          {r.shipmentStage ? <div className="text-muted-foreground">{r.shipmentStage}</div> : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.insertedAt)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {/* RỦI RO THEO MÃ HÀNG — chấm bằng ĐÍCH trong metric_targets, không bằng một hằng số trong code. */}
      <IntelSection
        title="Rủi ro theo mã hàng"
        description="Mỗi mã một dòng: lô hàng đã gửi, tỷ lệ đã đo, tỷ lệ dự kiến, xu hướng so kỳ trước, và lớp vấn đề quyết định việc này đi tới phòng nào."
        hint="Nhãn đánh giá đọc ĐÍCH của chỉ số Tỷ lệ giao thành công trong sổ đích (metric_targets), không có ngưỡng nào ghi cứng trong mã. Chưa đặt đích ⇒ hiện thực tế và KHÔNG kết luận. Lớp vấn đề suy từ LÝ DO của từng ca, không suy từ con số — mã hoàn nhiều mà lý do toàn 'không liên lạc được' là vấn đề giao vận, không phải vấn đề sản phẩm."
      >
        <ProductRiskTable rows={intel.products} hasTarget={intel.hasTarget} />
      </IntelSection>

      {/* ═════════ C. GTC THEO NGUỒN ĐƠN ═════════ */}
      <SectionCard
        title="Tỷ lệ giao thành công theo nguồn đơn"
        description="Khách đến từ chat fanpage hay từ landing page thì giao thành công khác nhau thế nào."
        hint={
          <>
            Dùng nguyên công thức kết quả đơn của toàn ERP, chỉ thêm chiều phân tách là nguồn đơn — không có cách tính thứ hai cho &ldquo;giao thành công&rdquo; hay &ldquo;hoàn&rdquo;. Mỗi đơn thuộc
            đúng một nguồn nên cộng các dòng lại bằng tổng toàn shop. <b>Đơn có mặt ở cả hai kênh</b> (khách vừa chat vừa điền form) ghi cho nơi khách đặt TRƯỚC. Tỷ lệ tính trên đơn ĐÃ KẾT THÚC.
          </>
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Nguồn đơn</TableHead>
                <TableHead className="text-right">Đơn trong kỳ</TableHead>
                <TableHead className="text-right">Đã gửi ĐVVC</TableHead>
                <TableHead className="text-right">Giao thành công</TableHead>
                <TableHead className="text-right">Hoàn</TableHead>
                <TableHead className="text-right">Chưa kết thúc</TableHead>
                <TableHead className="text-right">Tỷ lệ GTC</TableHead>
                <TableHead className="text-right">Tỷ lệ hoàn</TableHead>
                <TableHead className="text-right">Doanh thu giao TC</TableHead>
                <TableHead className="text-right">Doanh thu mất do hoàn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {theoNguon.map((r) => (
                <TableRow key={r.source}>
                  <TableCell>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap", ORDER_SOURCE_TONE[r.source])}>{ORDER_SOURCE_LABEL[r.source]}</span>
                    <div className="mt-1 max-w-[240px] text-[11px] leading-4 text-muted-foreground">{ORDER_SOURCE_HINT[r.source]}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.orders)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.shipped)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{formatNumber(r.delivered)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.returned)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(r.inTransit)}</TableCell>
                  <TableCell className="text-right">
                    {r.successRate === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={cn("rounded px-1.5 py-0.5 text-sm font-bold tabular-nums", successTone(r.successRate))}>{r.successRate.toFixed(1)}%</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.returnRate === null ? <span className="text-muted-foreground">—</span> : `${r.returnRate.toFixed(1)}%`}</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.revenue} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.lostRevenue} className="text-rose-600 dark:text-rose-400" />
                  </TableCell>
                </TableRow>
              ))}
              {theoNguon.length
                ? (() => {
                    const sum = (f: (r: (typeof theoNguon)[number]) => number) => theoNguon.reduce((t, r) => t + f(r), 0);
                    const delivered = sum((r) => r.delivered);
                    const returned = sum((r) => r.returned);
                    const ketThuc = delivered + returned;
                    return (
                      <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                        <TableCell>Tổng — khớp với số toàn shop</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.orders))}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.shipped))}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(delivered)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(returned)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.inTransit))}</TableCell>
                        <TableCell className="text-right tabular-nums">{ketThuc ? `${((delivered / ketThuc) * 100).toFixed(1)}%` : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{ketThuc ? `${((returned / ketThuc) * 100).toFixed(1)}%` : "—"}</TableCell>
                        <TableCell className="text-right">
                          <Money value={sum((r) => r.revenue)} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={sum((r) => r.lostRevenue)} />
                        </TableCell>
                      </TableRow>
                    );
                  })()
                : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {/* CHẤT LƯỢNG ĐẦU VÀO THEO MARKETER — cùng tập ca với bảng lý do, nên tổng không đổi khi bật chiều này. */}
      <IntelSection
        title="Chất lượng đầu vào theo marketer"
        description="Không phải CPQC rẻ hay đắt — mà đơn người đó mang về có tới được tay khách hay không."
        hint="Quy kết đi bằng khoá chiến dịch (đơn → ad_id / post_id → chiến dịch → người phụ trách khai ở bảng chi tiêu), KHÔNG dò chữ trong tên chiến dịch. Cộng mọi dòng — kể cả nhóm 'Chưa xác định' — bằng đúng số đơn đã kết thúc khi không chia theo marketer."
      >
        <MarketerQualityTable rows={intel.marketers} coverage={intel.marketerCoverage} />
      </IntelSection>

      {/* ═════════ D. HIỆU SUẤT GIAO VẬN ═════════ */}
      <SectionCard
        title="Hiệu suất giao vận"
        description="Tính theo mốc thời gian của từng sự kiện Viettel Post — chỉ số GIAO VẬN, không phải kết quả đơn."
        hint="Tính từ mốc thời gian của từng sự kiện Viettel Post, không từ trạng thái hiện tại. Vận đơn chưa kết thúc KHÔNG bị tính là giao thất bại. Ô đầu tiên đếm SỰ KIỆN phát thành công của ĐVVC (kể cả 501 chiều hoàn, kể cả kiện thu 30.000đ) nên nó KHÔNG phải tỷ lệ giao thành công của ERP — con số đó ở thẻ đầu trang, theo ORDER_OUTCOME."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border p-3.5">
            <p className="text-[13px] font-medium text-muted-foreground" title="Đếm sự kiện phát thành công của Viettel Post trong hành trình — kể cả 501 chiều hoàn. Không phải kết quả đơn.">
              {SUCCESS_RATE_TERMINAL_LABEL}
            </p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.successRateTerminal === null ? "—" : `${logistics.successRateTerminal}%`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              trên {formatNumber(logistics.terminal)} vận đơn ĐÃ KẾT THÚC · {logistics.successRateAll === null ? "—" : `${logistics.successRateAll}%`} nếu tính trên cả {formatNumber(logistics.tracked)} vận
              đơn có hành trình ({formatNumber(logistics.inFlight)} còn đang đi)
            </p>
          </div>
          <div className="rounded-xl border p-3.5">
            <p className="text-[13px] font-medium text-muted-foreground">Phát thành công ngay lần đầu</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.firstAttemptRate === null ? "—" : `${logistics.firstAttemptRate}%`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              trên {formatNumber(logistics.firstAttemptSample)} vận đơn đã giao
              {logistics.failureEvidence < logistics.firstAttemptSample * 0.05 ? (
                <span className="block text-warning">
                  Chỉ {formatNumber(logistics.failureEvidence)} vận đơn có ghi nhận phát thất bại trong hành trình — tệp danh sách vận đơn chỉ mang trạng thái CUỐI nên con số này đang cao hơn thực tế.
                </span>
              ) : (
                <span> · {formatNumber(logistics.failureEvidence)} vận đơn có ghi nhận phát thất bại</span>
              )}
            </p>
          </div>
          <div className="rounded-xl border p-3.5">
            <p className="text-[13px] font-medium text-muted-foreground">Thời gian lấy hàng</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.pickupHours.p50 === null ? "—" : `${logistics.pickupHours.p50}h`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              trung vị · chậm nhất trong 10% xấu nhất {logistics.pickupHours.p90 === null ? "—" : `${logistics.pickupHours.p90}h`} · {formatNumber(logistics.pickupHours.sample)} vận đơn
            </p>
          </div>
          <div className="rounded-xl border p-3.5">
            <p className="text-[13px] font-medium text-muted-foreground">Thời gian giao</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.deliveryHours.p50 === null ? "—" : `${logistics.deliveryHours.p50}h`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              từ lúc lấy hàng · chậm nhất trong 10% xấu nhất {logistics.deliveryHours.p90 === null ? "—" : `${logistics.deliveryHours.p90}h`} · {formatNumber(logistics.deliveryHours.sample)} vận đơn
            </p>
          </div>
        </div>

        {/*
          ───────── "CHƯA KẾT THÚC" TÁCH RA THÌ MỚI ĐỌC ĐƯỢC ─────────

          Một con số "120 đơn chưa kết thúc" không nói gì cho người quyết định. "90 đang luân chuyển
          · 30 chờ phát lại" thì nói rất nhiều: hai nhóm đó có triển vọng khác hẳn nhau, và đó chính
          là lý do mô hình cân TỪNG đơn thay vì nhân tổng doanh số với một tỷ lệ.

          Khối này thuộc về GIAO VẬN chứ không phải KPI: nó mô tả kiện hàng đang nằm ở đâu.
        */}
        {pj && pj.byState.length ? (
          <div className="mt-3">
            <p className="mb-1.5 text-[12.5px] font-medium">
              Chưa kết thúc: {formatNumber(pj.active)} đơn, tách theo trạng thái Viettel Post
              <span className="ml-1 font-normal text-muted-foreground">— mỗi nhóm mang xác suất giao được của riêng nó, học từ vận đơn đã kết thúc</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {pj.byState.map((x) => (
                <div key={x.substate} className="rounded-lg border border-hairline px-2.5 py-1.5">
                  <div className="text-[12px] font-medium">{x.label}</div>
                  <div className="numeric text-base font-semibold">{formatNumber(x.orders)}</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    {x.p === null
                      ? `chưa đủ mẫu (${formatNumber(x.sample)} vận đơn) — ngoài phần ước tính`
                      : `${(x.p * 100).toFixed(1)}% giao được · học từ ${formatNumber(x.sample)} vận đơn · ${CONFIDENCE_LABEL[x.confidence as ProbabilityConfidence] ?? x.confidence}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {logistics.stuck24h > 0 ? (
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <b>Vận đơn kẹt</b> — chưa kết thúc và đã lâu không có tin mới từ Viettel Post: <b>{formatNumber(logistics.stuck24h)}</b> quá 24h · <b>{formatNumber(logistics.stuck48h)}</b> quá 48h ·{" "}
              <b>{formatNumber(logistics.stuck72h)}</b> quá 72h.
              <Link className="ml-2 text-primary underline underline-offset-2" href="/shipments?final=open">
                Xem vận đơn chưa kết thúc
              </Link>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {/* XU HƯỚNG + SO KỲ — một khối, hai câu hỏi: đang đi lên hay đi xuống, và so với kỳ trước thế nào. */}
      <IntelSection
        title="Xu hướng và so kỳ trước"
        description={intel.compare.label}
        hint="Rổ gần nhất luôn mỏng hơn vì kiện chưa kịp ngã ngũ — cột 'Đã kết thúc' in ra để không ai đọc nhầm một cohort chưa chín thành một cú lao dốc."
      >
        <div className="space-y-3">
          <ComparePeriod compare={intel.compare} />
          <TrendSection trend={intel.trend} />
        </div>
      </IntelSection>

      {summary.provisional ? (
        <div role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          {formatNumber(summary.provisional)} đơn đang được xếp loại bằng <strong>số tạm tính</strong> (Viettel Post báo đã giao nhưng chưa có chứng từ bảng kê). Tiền của các đơn này có thể về ở kỳ bảng
          kê sau; số sẽ tự chính xác khi anh nhập bảng kê ở{" "}
          <Link className="underline underline-offset-2" href="/import-vtp">
            Bổ sung danh sách vận đơn
          </Link>
          .
        </div>
      ) : null}

      {/* ═════════ E. PHÂN TÍCH LÝ DO HOÀN ═════════ */}
      <ReturnReasonSection report={reasonReport} filter={reasonFilter} hrefWith={hrefWith} openReason={openReason} openGroup={openGroup} openProduct={openProduct} />

      {/* ═════════ F. CHĂM SÓC & CỨU ĐƠN ═════════ */}
      <IntelSection
        title="Chăm sóc kiện và tỷ lệ cứu đơn"
        description="Kiện vào hàng đợi chăm sóc từ trạng thái nào, có ai cầm không, bao lâu mới có thao tác đầu tiên, và cuối cùng có cứu được không."
        hint="CHỈ ca đã ngã ngũ mới dùng để chấm người — ca còn treo đếm riêng vì kết cục của nó chưa tồn tại. Và kết quả giao hàng do ĐVVC đồng quyết định, nên đây là KẾT QUẢ CHUNG, đọc làm bối cảnh chứ không phải điểm cá nhân. Con số dự báo không bao giờ dùng để thưởng phạt."
      >
        <CarePerformance care={intel.care} />
      </IntelSection>

      {/* ═════════ G. CẦN CHÚ Ý ═════════ */}
      <div id="can-chu-y">
        <IntelSection
          title="Cần chú ý"
          description={`Tối đa ${intel.actions.length} việc — mỗi dòng mang con số và cỡ mẫu đã dựng nên nó, và một phòng ban nhận việc.`}
          hint="Cảnh báo chỉ xuất hiện khi ĐỦ MẪU: mã hàng cần ít nhất 20 đơn đã kết thúc, marketer cần 30. Đây là câu hỏi 'đã đủ quan sát để nói chưa', khác hẳn câu hỏi 'bao nhiêu thì gọi là kém' — cái sau nằm ở đích chỉ số. Nút tạo việc giao cho PHÒNG BAN, không gán cho một cá nhân: máy không biết hôm nay ai nghỉ."
        >
          <ActionBoard actions={intel.actions} periodLabel={params.period.label} />
        </IntelSection>
      </div>
    </div>
  );
}
