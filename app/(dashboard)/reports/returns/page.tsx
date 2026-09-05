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
          value={formatNumber(summary.shipped)}
          note={`${formatNumber(summary.inTransit)} đang giao (trong đó ${formatNumber(summary.failed)} chờ phát lại) · ${formatNumber(summary.pending)} chờ xử lý chưa gửi · ${formatNumber(summary.cancelled)} huỷ (không tính)`}
          icon={Truck}
          tone="blue"
        />
        <MetricCard
          label="Giao thành công"
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

      <div className="flex items-start gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 p-3.5 text-[13px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <b>Cách tính.</b> Chỉ số chính là <b>tỷ lệ giao thành công</b>. Đơn{" "}
          <b>giao thành công</b> = đơn có <b>doanh thu COD thực</b> &gt;{" "}
          {formatVND(RETURN_RULE.maxCodForFakeDelivery)} (tiền thu hộ thực thu theo webhook giao thành công / bảng kê / danh sách vận đơn; chưa có số thực thu thì lấy COD vận đơn khi Viettel Post báo giao thành công; đơn đã chuyển khoản trước &gt; {formatVND(RETURN_RULE.maxCodForFakeDelivery, { compact: true })} cũng tính). Đơn <b>không thành công</b> = vận đơn đang hoàn / đã hoàn, <b>hoặc</b> vận đơn “giao thành công” nhưng COD ≤ {formatVND(RETURN_RULE.maxCodForFakeDelivery)} (khách không nhận, chỉ trả tiền ship / phí xem hàng), kể cả khi vận đơn hoàn PKE…P1 nằm riêng; chưa có vận đơn thì theo trạng thái Pancake. Tỷ lệ giao thành công = giao TC / (giao TC + không TC), chỉ tính đơn <b>đã kết thúc</b>: đơn chờ xử lý, đang giao và huỷ không nằm trong tử số lẫn mẫu số. Vì đơn <b>giao thất bại chờ phát lại</b> phần lớn sẽ thành hoàn, cột <b>Dự kiến</b> cộng số đơn chờ phát lại × xác suất thành hoàn học từ lịch sử 180 ngày (hiện {summary.failedToReturnPct}%) vào mẫu số. Bảng gom mẫu mã theo mã hàng: bấm mũi tên ở dòng mã (vd Q003) để xổ từng SKU. Một đơn có nhiều mã hàng được tính cho từng mã.
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
