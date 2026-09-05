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
import { OUTCOME_LABEL, OUTCOME_TONE, rateTone, RETURN_RULE } from "@/lib/constants/returns";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import {
  getReturnRateByVariant,
  getReturnRateSummary,
  listOrdersForVariant,
  RETURN_RATE_SORTABLE,
} from "@/lib/queries/return-rate";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Tỷ lệ hoàn theo mã hàng" };

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
  await requirePermission("reports:view");
  const raw = await searchParams;
  const params = parseListParams(raw, {
    defaultSort: "rate",
    defaultDir: "desc",
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
  const worst = all
    .filter((r) => r.rate !== null && r.shipped >= 5)
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title="Tỷ lệ hoàn theo mã hàng"
        description={`${params.period.label} · ${formatNumber(summary.shipped)} đơn đã gửi · ${formatNumber(summary.returned)} đơn hoàn · tính trên đơn lên trong kỳ`}
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
          value={formatNumber(summary.shipped)}
          note={`${formatNumber(summary.inTransit)} đang giao (trong đó ${formatNumber(summary.failed)} chờ phát lại) · ${formatNumber(summary.pending)} chờ xử lý chưa gửi · ${formatNumber(summary.cancelled)} huỷ (không tính)`}
          icon={Truck}
          tone="blue"
        />
        <MetricCard
          label="Giao thành công thật"
          value={formatNumber(summary.delivered)}
          note={`Cước ≥ ${formatVND(RETURN_RULE.maxFeeForFakeDelivery)} hoặc có COD`}
          icon={PackageCheck}
          tone="green"
        />
        <MetricCard
          label="Đơn hoàn"
          value={formatNumber(summary.returned)}
          note={`${formatNumber(summary.returnedByRule)} nhận diện theo quy tắc COD 0 & cước < ${formatVND(RETURN_RULE.maxFeeForFakeDelivery, { compact: true })} · mất ${formatVND(summary.lostRevenue, { compact: true })}`}
          icon={Undo2}
          tone="rose"
        />
        <MetricCard
          label="Tỷ lệ hoàn chung"
          value={
            <span className={rateTone(summary.rate)}>
              {summary.rate === null ? "—" : `${summary.rate.toFixed(1)}%`}
            </span>
          }
          note={`${summary.expectedRate !== null ? `Dự kiến ${summary.expectedRate.toFixed(1)}% khi ${formatNumber(summary.failed)} đơn chờ phát lại kết thúc (xác suất thành hoàn ${summary.failedToReturnPct}%${summary.failedSample >= 15 ? `, học từ ${formatNumber(summary.failedSample)} vận đơn` : ", mặc định"})` : "Hoàn / (giao thật + hoàn)"}${worst ? ` · cao nhất ${worst.sku || worst.productName} ${(worst.rate ?? 0).toFixed(1)}%` : ""}`}
          icon={Percent}
          tone={summary.rate !== null && summary.rate >= 20 ? "rose" : "slate"}
        />
      </section>

      <div className="flex items-start gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 p-3.5 text-[13px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <b>Cách tính.</b> Đơn <b>hoàn</b> = đơn Pancake ở trạng thái đang hoàn
          / đã hoàn, <b>hoặc</b> vận đơn &ldquo;giao thành công&rdquo; nhưng COD
          thu hộ = 0 và cước &lt; {formatVND(RETURN_RULE.maxFeeForFakeDelivery)}{" "}
          (khách không nhận, chỉ trả tiền ship), kể cả khi vận đơn hoàn PKE…P1
          nằm riêng trên Viettel Post. Đơn <b>giao thật</b> = giao thành công có
          cước ≥ {formatVND(RETURN_RULE.maxFeeForFakeDelivery)} hoặc có COD. Tỷ
          lệ hoàn = hoàn / (giao thật + hoàn), chỉ tính đơn <b>đã kết thúc</b>: đơn chờ xử lý (chưa gửi ĐVVC), đơn đang giao và đơn huỷ không nằm trong tử số lẫn mẫu số. Vì đơn <b>giao thất bại chờ phát lại</b> phần lớn sẽ thành hoàn, cột <b>Dự kiến</b> cộng thêm số đơn chờ phát lại nhân xác suất thành hoàn học từ lịch sử 180 ngày (hiện {summary.failedToReturnPct}%) vào cả tử số và mẫu số. Một đơn có nhiều mã hàng được tính cho từng mã.
        </div>
      </div>

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
                ? `${formatNumber(selected.returned)} hoàn · ${formatNumber(selected.delivered)} giao thật · ${formatNumber(selected.inTransit)} đang giao · ${params.period.label.toLowerCase()} (tối đa 300 đơn, đơn hoàn xếp trước)`
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
