import {
  AlertTriangle,
  Download,
  PackageCheck,
  Percent,
  Truck,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { ReturnRateTable } from "@/app/(dashboard)/reports/returns/return-rate-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { OrderStageBadge } from "@/components/status-badge";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OUTCOME_LABEL, OUTCOME_TONE, RETURN_RULE, SUCCESS_RATE_OK, successTone } from "@/lib/constants/returns";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import {
  getReturnRateByVariant,
  getReturnRateSummary,
  listOrdersForVariant,
  RETURN_RATE_SORTABLE,
} from "@/lib/queries/return-rate";
import { logisticsPerformance } from "@/lib/queries/logistics";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Tỷ lệ giao thành công theo mã hàng" };

const MIN_OPTIONS = [
  { value: "1", label: "≥ 1 đơn đã gửi" },
  { value: "5", label: "≥ 5 đơn" },
  { value: "10", label: "≥ 10 đơn" },
  { value: "30", label: "≥ 30 đơn" },
];

export default async function ReturnRatePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePermission("reports:returns");
  const raw = await searchParams;
  const params = parseListParams(raw, {
    defaultSort: "successRate",
    defaultDir: "asc",
    filterKeys: ["min"],
    sortable: RETURN_RATE_SORTABLE,
    defaultPeriod: "90d",
    defaultPageSize: 50,
  });
  const minShipped = Math.max(1, Number(params.filters.min?.[0] ?? "1") || 1);
  const variantKey = param(raw, "variant");

  const [{ rows, total, pageCount, all }, summary, variantOrders] =
    await Promise.all([
      getReturnRateByVariant({
        period: params.period,
        q: params.q,
        minShipped,
        sort: params.sort,
        dir: params.dir,
        page: params.page,
        pageSize: params.pageSize,
      }),
      getReturnRateSummary(params.period, params.q),
      variantKey
        ? listOrdersForVariant(variantKey, params.period)
        : Promise.resolve([]),
    ]);
  const selected = variantKey ? all.find((r) => r.key === variantKey) : null;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "variant" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
  }
  const baseQuery = qs.toString();
  const exportQuery = new URLSearchParams({
    period: params.period.key,
    q: params.q,
    min: String(minShipped),
    ...(params.period.key === "custom"
      ? { from: params.period.fromKey ?? "", to: params.period.toKey ?? "" }
      : {}),
  }).toString();
  const logistics = await logisticsPerformance(params.period);
  const worst = all
    .filter((r) => r.successRate !== null && r.shipped >= 5)
    .sort((a, b) => (a.successRate ?? 0) - (b.successRate ?? 0))[0];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Tỷ lệ giao thành công theo mã hàng"
        description={`${params.period.label} · ${formatNumber(summary.shipped)} đơn đã gửi · ${formatNumber(summary.delivered)} giao thành công (COD thực > ${formatVND(RETURN_RULE.maxCodForFakeDelivery, { compact: true })}) · ${formatNumber(summary.returned)} không thành công · tính trên đơn lên trong kỳ`}
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/api/export/return-rate?${exportQuery}`}>
              <Download className="size-4" /> Xuất CSV
            </a>
          </Button>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Đơn đã gửi"
          hint="Đơn lên trong kỳ đã bàn giao đơn vị vận chuyển. Đơn chờ xử lý chưa gửi và đơn huỷ không nằm trong tử số lẫn mẫu số của tỷ lệ giao thành công."
          value={formatNumber(summary.shipped)}
          note={`${formatNumber(summary.inTransit)} đang giao (trong đó ${formatNumber(summary.failed)} chờ phát lại) · ${formatNumber(summary.pending)} chờ xử lý chưa gửi · ${formatNumber(summary.cancelled)} huỷ (không tính)`}
          icon={Truck}
          tone="blue"
        />
        <MetricCard
          label="Giao thành công"
          hint={
            <>
              Lấy theo <b>trạng thái Viettel Post</b>, đúng bảng mã webhook chính thức. Sáu mã là trạng thái cuối:
              <b> 501</b> phát thành công (cờ IS_RETURNING = false) là giao thành công; <b>501</b> của chiều hoàn,
              <b> 504</b> chuyển trả người gửi, <b>503</b> tiêu huỷ là không thành công; <b>101/107/201</b> là huỷ.
              Chưa có mã cuối thì lấy trạng thái mới nhất theo mốc thời gian của Viettel Post.
              Đã giao mà Viettel Post tạo vận đơn chiều hoàn, hoặc doanh thu bị sửa sau khi giao, thì tính là hoàn.
              Khi đã biết chắc số tiền: dưới 50K là hoàn, 50K–100K là không thành công.
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
          value={
            <span className={successTone(summary.successRate)}>
              {summary.successRate === null ? "—" : `${summary.successRate.toFixed(1)}%`}
            </span>
          }
          note={`${summary.expectedSuccessRate !== null ? `Dự kiến ${summary.expectedSuccessRate.toFixed(1)}% khi ${formatNumber(summary.failed)} đơn chờ phát lại kết thúc (xác suất thành hoàn ${summary.failedToReturnPct}%${summary.failedSample >= 15 ? `, học từ ${formatNumber(summary.failedSample)} vận đơn` : ", mặc định"})` : "Giao TC / (giao TC + không TC)"}${worst ? ` · thấp nhất ${worst.sku || worst.productName} ${(worst.successRate ?? 0).toFixed(1)}%` : ""}`}
          icon={Percent}
          tone={summary.successRate !== null && summary.successRate < SUCCESS_RATE_OK ? "rose" : summary.successRate !== null ? "green" : "slate"}
        />
      </section>

      {/* ───────── Hiệu suất giao vận tính từ hành trình Viettel Post ───────── */}
      <SectionCard
        title="Hiệu suất giao vận"
        description="Tính từ mốc thời gian của từng sự kiện Viettel Post, không từ trạng thái hiện tại. Vận đơn chưa kết thúc KHÔNG bị tính là giao thất bại."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Tỷ lệ giao thành công</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.successRateTerminal === null ? "—" : `${logistics.successRateTerminal}%`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              trên {formatNumber(logistics.terminal)} vận đơn ĐÃ KẾT THÚC · {logistics.successRateAll === null ? "—" : `${logistics.successRateAll}%`} nếu tính trên cả{" "}
              {formatNumber(logistics.tracked)} vận đơn có hành trình ({formatNumber(logistics.inFlight)} còn đang đi)
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Phát thành công ngay lần đầu</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.firstAttemptRate === null ? "—" : `${logistics.firstAttemptRate}%`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              trên {formatNumber(logistics.firstAttemptSample)} vận đơn đã giao
              {logistics.failureEvidence < logistics.firstAttemptSample * 0.05 ? (
                <span className="block text-warning">
                  Chỉ {formatNumber(logistics.failureEvidence)} vận đơn có ghi nhận phát thất bại trong hành trình — tệp danh sách vận đơn chỉ mang trạng
                  thái CUỐI nên con số này đang cao hơn thực tế. Cần webhook phủ đủ kỳ mới tin được.
                </span>
              ) : (
                <span> · {formatNumber(logistics.failureEvidence)} vận đơn có ghi nhận phát thất bại</span>
              )}
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Thời gian lấy hàng</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.pickupHours.p50 === null ? "—" : `${logistics.pickupHours.p50}h`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              trung vị · chậm nhất trong 10% xấu nhất {logistics.pickupHours.p90 === null ? "—" : `${logistics.pickupHours.p90}h`} · {formatNumber(logistics.pickupHours.sample)} vận đơn
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Thời gian giao</p>
            <p className="numeric mt-1 text-2xl font-bold">{logistics.deliveryHours.p50 === null ? "—" : `${logistics.deliveryHours.p50}h`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              từ lúc lấy hàng · chậm nhất trong 10% xấu nhất {logistics.deliveryHours.p90 === null ? "—" : `${logistics.deliveryHours.p90}h`} · {formatNumber(logistics.deliveryHours.sample)} vận đơn
            </p>
          </div>
        </div>

        {logistics.stuck24h > 0 ? (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <b>Vận đơn kẹt</b> — chưa kết thúc và đã lâu không có tin mới từ Viettel Post:{" "}
              <b>{formatNumber(logistics.stuck24h)}</b> quá 24h · <b>{formatNumber(logistics.stuck48h)}</b> quá 48h · <b>{formatNumber(logistics.stuck72h)}</b> quá 72h.
              <Link className="ml-2 text-primary underline underline-offset-2" href="/shipments?final=open">Xem vận đơn chưa kết thúc</Link>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {summary.finishedNoVtp > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-[13px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            <b>{formatNumber(summary.finishedNoVtp)}</b> / {formatNumber(summary.delivered + summary.returned)} đơn giao / hoàn trong kỳ <b>chưa có trạng thái Viettel Post thật</b> (đang tính theo trạng thái Pancake vì tài khoản API Viettel Post không tra được vận đơn tạo qua Pancake). Đơn giao thành công đã được tính theo <b>COD thực thu &gt; 100K</b> nên không phụ thuộc trạng thái này; để phần <b>không thành công</b> cũng chính xác, nhập bảng kê COD hoặc danh sách vận đơn từ viettelpost.vn → Quản lý vận đơn → Xuất Excel.
          </span>
          <Button asChild size="sm" variant="outline" className="ml-auto">
            <Link href="/cod?import=orders">Nhập danh sách vận đơn VTP</Link>
          </Button>
        </div>
      ) : null}

      {summary.provisional ? (
        <div role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          {formatNumber(summary.provisional)} đơn đang được xếp loại bằng <strong>số tạm tính</strong> (Viettel Post báo đã giao nhưng chưa có
          chứng từ bảng kê). Tiền của các đơn này có thể về ở kỳ bảng kê sau; số sẽ tự chính xác khi anh nhập bảng kê ở{" "}
          <Link className="underline underline-offset-2" href="/import-vtp">Nhập dữ liệu Viettel Post</Link>.
        </div>
      ) : null}

      <DataTableToolbar
        searchPlaceholder="SKU, tên sản phẩm, màu/size…"
        period={{ defaultKey: "90d" }}
        facets={[
          {
            key: "min",
            label: "Tối thiểu",
            options: MIN_OPTIONS,
            single: true,
          },
        ]}
        resultLabel={`${formatNumber(total)} mã hàng · bấm vào một dòng để xem danh sách đơn`}
      />
      <ReturnRateTable
        rows={rows}
        pageCount={pageCount}
        total={total}
        baseQuery={baseQuery}
      />

      {variantKey ? (
        <div id="chi-tiet">
          <SectionCard
            title={
              selected
                ? `Đơn của ${selected.sku || selected.productName}${selected.variationDetail ? ` · ${selected.variationDetail}` : ""}`
                : "Đơn của mã hàng đã chọn"
            }
            description={
              selected
                ? `${formatNumber(selected.delivered)} giao thành công · ${formatNumber(selected.returned)} không thành công · ${formatNumber(selected.inTransit)} đang giao · ${params.period.label.toLowerCase()} (tối đa 300 đơn, đơn không thành công xếp trước)`
                : undefined
            }
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link
                  href={`/reports/returns${baseQuery ? `?${baseQuery}` : ""}`}
                >
                  Đóng
                </Link>
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
                      <TableCell
                        colSpan={9}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Không có đơn nào trong kỳ.
                      </TableCell>
                    </TableRow>
                  ) : (
                    variantOrders.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link
                            href={`/orders/${r.id}`}
                            className="font-semibold hover:text-primary hover:underline"
                          >
                            #{r.systemId ?? r.id}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-[160px] truncate">
                            {r.billFullName || "—"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {r.billPhone}
                            {r.shipProvince ? ` · ${r.shipProvince}` : ""}
                          </div>
                        </TableCell>
                        <TableCell>
                          <OrderStageBadge stage={r.stage} />
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold",
                              OUTCOME_TONE[r.outcome],
                            )}
                          >
                            {OUTCOME_LABEL[r.outcome]}
                          </span>
                          {r.returnedReason ? (
                            <div className="max-w-[200px] truncate text-[11px] text-muted-foreground">
                              {r.returnedReason}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="numeric text-right">
                          {r.quantity}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money
                            value={r.cod}
                            className={r.cod ? "" : "text-muted-foreground"}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money
                            value={r.fee}
                            className={
                              r.fee && r.fee < RETURN_RULE.maxFeeForFakeDelivery
                                ? "font-semibold text-orange-600"
                                : r.fee
                                  ? ""
                                  : "text-muted-foreground"
                            }
                          />
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.vtpOrderNumber ?? "—"}
                          {r.shipmentStage ? (
                            <div className="text-muted-foreground">
                              {r.shipmentStage}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDateTime(r.insertedAt)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
